use serde::Serialize;
use std::collections::BTreeMap;

pub const COO_PET_PROJECTION_ID: &str = "coo-pet";
pub const DISPLAY_ANCHOR_BOTTOM: &str = "bottom";
pub const AUDIO_MODE_REMOTE_ACTIVE: &str = "remote_active";
pub const MIN_VISIT_TTL_MS: u64 = 1_000;
pub const MAX_VISIT_TTL_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisitStatus {
    Requesting,
    Approved,
    Active,
    Returning,
    Returned,
    Rejected,
    Expired,
    Failed,
    Disconnected,
}

impl VisitStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requesting => "requesting",
            Self::Approved => "approved",
            Self::Active => "active",
            Self::Returning => "returning",
            Self::Returned => "returned",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::Failed => "failed",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "requesting" => Self::Requesting,
            "approved" => Self::Approved,
            "active" => Self::Active,
            "returning" => Self::Returning,
            "returned" => Self::Returned,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            "failed" => Self::Failed,
            "disconnected" => Self::Disconnected,
            _ => return None,
        })
    }

    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Returned | Self::Rejected | Self::Expired | Self::Failed | Self::Disconnected
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionVisit {
    pub visit_id: String,
    pub source_instance: String,
    pub purpose: String,
    pub target_host_id: String,
    pub projection_id: String,
    pub display_anchor: String,
    pub audio_mode: String,
    pub environment_id: Option<String>,
    pub expires_at_ms: u64,
    pub created_at_ms: u64,
    pub status: VisitStatus,
    pub last_transition: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    InvalidId,
    InvalidRoute,
    Duplicate,
    Busy,
    Unknown,
    WrongHost,
    Expired,
    InvalidTransition,
}

#[derive(Debug, Default)]
pub struct ProjectionManager {
    visits: BTreeMap<String, ProjectionVisit>,
}

impl ProjectionManager {
    pub fn issue(&mut self, visit: ProjectionVisit, now_ms: u64) -> Result<(), ProjectionError> {
        if !valid_id(&visit.visit_id) {
            return Err(ProjectionError::InvalidId);
        }
        if visit.source_instance.trim().is_empty()
            || visit.source_instance.chars().count() > 96
            || visit.target_host_id.trim().is_empty()
            || visit.target_host_id.chars().count() > 96
            || visit.projection_id != COO_PET_PROJECTION_ID
            || visit.display_anchor != DISPLAY_ANCHOR_BOTTOM
            || visit.audio_mode != AUDIO_MODE_REMOTE_ACTIVE
            || visit.expires_at_ms <= now_ms
            || visit.purpose.trim().is_empty()
            || visit.purpose.chars().count() > 240
        {
            return Err(ProjectionError::InvalidRoute);
        }
        if self.visits.contains_key(&visit.visit_id) {
            return Err(ProjectionError::Duplicate);
        }
        if self.visits.values().any(|current| {
            !current.status.terminal()
                && (current.source_instance == visit.source_instance
                    || current.target_host_id == visit.target_host_id)
        }) {
            return Err(ProjectionError::Busy);
        }
        let mut visit = visit;
        visit.created_at_ms = now_ms;
        self.visits.insert(visit.visit_id.clone(), visit);
        Ok(())
    }

    pub fn decide(
        &mut self,
        host_id: &str,
        visit_id: &str,
        allow: bool,
        now_ms: u64,
    ) -> Result<ProjectionVisit, ProjectionError> {
        let visit = self
            .visits
            .get_mut(visit_id)
            .ok_or(ProjectionError::Unknown)?;
        if visit.target_host_id != host_id {
            return Err(ProjectionError::WrongHost);
        }
        if visit.expires_at_ms <= now_ms {
            visit.status = VisitStatus::Expired;
            visit.last_transition = "ttl_expired".into();
            return Err(ProjectionError::Expired);
        }
        if visit.status != VisitStatus::Requesting {
            return Err(ProjectionError::InvalidTransition);
        }
        visit.status = if allow {
            VisitStatus::Approved
        } else {
            VisitStatus::Rejected
        };
        visit.last_transition = if allow {
            "host_allowed"
        } else {
            "host_rejected"
        }
        .into();
        Ok(visit.clone())
    }

    pub fn report(
        &mut self,
        host_id: &str,
        visit_id: &str,
        status: VisitStatus,
        now_ms: u64,
    ) -> Result<ProjectionVisit, ProjectionError> {
        let visit = self
            .visits
            .get_mut(visit_id)
            .ok_or(ProjectionError::Unknown)?;
        if visit.target_host_id != host_id {
            return Err(ProjectionError::WrongHost);
        }
        if visit.expires_at_ms <= now_ms && !visit.status.terminal() {
            visit.status = VisitStatus::Expired;
            visit.last_transition = "ttl_expired".into();
            return Err(ProjectionError::Expired);
        }
        if visit.status.terminal()
            || !matches!(
                status,
                VisitStatus::Active | VisitStatus::Failed | VisitStatus::Returned
            )
        {
            return Err(ProjectionError::InvalidTransition);
        }
        if status == VisitStatus::Active && visit.status != VisitStatus::Approved {
            return Err(ProjectionError::InvalidTransition);
        }
        if status == VisitStatus::Returned && visit.status != VisitStatus::Returning {
            return Err(ProjectionError::InvalidTransition);
        }
        if status == VisitStatus::Failed
            && !matches!(
                visit.status,
                VisitStatus::Approved | VisitStatus::Active | VisitStatus::Returning
            )
        {
            return Err(ProjectionError::InvalidTransition);
        }
        visit.status = status;
        visit.last_transition = status.as_str().into();
        Ok(visit.clone())
    }

    pub fn begin_return(
        &mut self,
        visit_id: &str,
        now_ms: u64,
    ) -> Result<ProjectionVisit, ProjectionError> {
        let visit = self
            .visits
            .get_mut(visit_id)
            .ok_or(ProjectionError::Unknown)?;
        if visit.expires_at_ms <= now_ms {
            visit.status = VisitStatus::Expired;
            visit.last_transition = "ttl_expired".into();
            return Err(ProjectionError::Expired);
        }
        if !matches!(visit.status, VisitStatus::Approved | VisitStatus::Active) {
            return Err(ProjectionError::InvalidTransition);
        }
        visit.status = VisitStatus::Returning;
        visit.last_transition = "return_requested".into();
        Ok(visit.clone())
    }

    pub fn revoke(
        &mut self,
        visit_id: &str,
        reason: &str,
    ) -> Result<ProjectionVisit, ProjectionError> {
        let visit = self
            .visits
            .get_mut(visit_id)
            .ok_or(ProjectionError::Unknown)?;
        if visit.status.terminal() {
            return Err(ProjectionError::InvalidTransition);
        }
        visit.status = VisitStatus::Returning;
        visit.last_transition = bounded_reason(reason);
        Ok(visit.clone())
    }

    pub fn host_disconnected(&mut self, host_id: &str) -> Vec<ProjectionVisit> {
        let mut disconnected = Vec::new();
        for visit in self
            .visits
            .values_mut()
            .filter(|visit| visit.target_host_id == host_id && !visit.status.terminal())
        {
            visit.status = VisitStatus::Disconnected;
            visit.last_transition = "host_disconnected".into();
            disconnected.push(visit.clone());
        }
        disconnected
    }

    pub fn prune(&mut self, now_ms: u64) -> Vec<ProjectionVisit> {
        let mut expired = Vec::new();
        for visit in self
            .visits
            .values_mut()
            .filter(|visit| visit.expires_at_ms <= now_ms && !visit.status.terminal())
        {
            visit.status = VisitStatus::Expired;
            visit.last_transition = "ttl_expired".into();
            expired.push(visit.clone());
        }
        expired
    }

    pub fn get(&self, visit_id: &str) -> Option<&ProjectionVisit> {
        self.visits.get(visit_id)
    }

    pub fn active_for_host(&self, host_id: &str, now_ms: u64) -> Option<&ProjectionVisit> {
        self.visits.values().find(|visit| {
            visit.target_host_id == host_id
                && visit.status == VisitStatus::Active
                && visit.expires_at_ms > now_ms
        })
    }

    pub fn current_for_source(
        &self,
        source_instance: &str,
        now_ms: u64,
    ) -> Option<&ProjectionVisit> {
        self.visits
            .values()
            .filter(|visit| {
                visit.source_instance == source_instance && visit.expires_at_ms > now_ms
            })
            .max_by_key(|visit| visit.created_at_ms)
    }

    pub fn current_for_host(&self, host_id: &str, now_ms: u64) -> Option<&ProjectionVisit> {
        self.visits
            .values()
            .filter(|visit| visit.target_host_id == host_id && visit.expires_at_ms > now_ms)
            .max_by_key(|visit| visit.created_at_ms)
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn bounded_reason(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(id: &str, expiry: u64) -> ProjectionVisit {
        ProjectionVisit {
            visit_id: id.into(),
            source_instance: "coo-local".into(),
            purpose: "test visit".into(),
            target_host_id: "solver-server".into(),
            projection_id: COO_PET_PROJECTION_ID.into(),
            display_anchor: DISPLAY_ANCHOR_BOTTOM.into(),
            audio_mode: AUDIO_MODE_REMOTE_ACTIVE.into(),
            environment_id: Some("env-1".into()),
            expires_at_ms: expiry,
            created_at_ms: 1,
            status: VisitStatus::Requesting,
            last_transition: "requesting".into(),
        }
    }

    #[test]
    fn visit_requires_fixed_projection_shape_and_single_flight() {
        let mut manager = ProjectionManager::default();
        let mut invalid = visit("v1", 5000);
        invalid.projection_id = "http://arbitrary/".into();
        assert_eq!(
            manager.issue(invalid, 1),
            Err(ProjectionError::InvalidRoute)
        );
        manager.issue(visit("v1", 5000), 1).unwrap();
        assert_eq!(
            manager.issue(visit("v2", 5000), 1),
            Err(ProjectionError::Busy)
        );
    }

    #[test]
    fn only_target_host_can_allow_and_active_visit_can_return() {
        let mut manager = ProjectionManager::default();
        manager.issue(visit("v1", 5000), 1).unwrap();
        assert_eq!(
            manager.decide("other-host", "v1", true, 2),
            Err(ProjectionError::WrongHost)
        );
        let active = manager.decide("solver-server", "v1", true, 2).unwrap();
        assert_eq!(active.status, VisitStatus::Approved);
        let active = manager
            .report("solver-server", "v1", VisitStatus::Active, 3)
            .unwrap();
        assert_eq!(active.status, VisitStatus::Active);
        let returning = manager.begin_return("v1", 4).unwrap();
        assert_eq!(returning.status, VisitStatus::Returning);
        let returned = manager
            .report("solver-server", "v1", VisitStatus::Returned, 5)
            .unwrap();
        assert_eq!(returned.status, VisitStatus::Returned);
    }

    #[test]
    fn expiry_and_disconnect_are_terminal_facts() {
        let mut manager = ProjectionManager::default();
        manager.issue(visit("v1", 5000), 1).unwrap();
        manager.decide("solver-server", "v1", true, 2).unwrap();
        assert_eq!(manager.prune(5000)[0].status, VisitStatus::Expired);
        manager.issue(visit("v2", 9000), 6000).unwrap();
        assert_eq!(
            manager.host_disconnected("solver-server")[0].status,
            VisitStatus::Disconnected
        );
    }
}
