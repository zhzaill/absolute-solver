use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const MIN_ACCESS_TTL_MS: u64 = 1_000;
pub const MAX_ACCESS_TTL_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessService {
    Tts,
    Asr,
}

impl AccessService {
    pub fn operation(self) -> &'static str {
        match self {
            Self::Tts => "speech.synthesize",
            Self::Asr => "audio.transcribe",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessStatus {
    Pending,
    Granted,
    Denied,
    Consumed,
    Revoked,
    Expired,
    HostOffline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRequest {
    pub request_id: String,
    pub source_instance: String,
    pub target_host_id: String,
    pub target_service: AccessService,
    pub operation: String,
    pub purpose: String,
    pub environment_id: Option<String>,
    pub expires_at_ms: u64,
    pub grant_id: Option<String>,
    pub status: AccessStatus,
    pub result_status: Option<String>,
    pub elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessError {
    Duplicate,
    Unknown,
    NoMatchingGrant,
    AmbiguousGrant,
    /// The same source already holds a pending or granted request for this
    /// host and service. One outstanding permission at a time keeps a route
    /// claim unambiguous by construction, and keeps the target operator from
    /// having to answer stacked dialogs for one conversation.
    Busy,
    /// An explicit request id was supplied but it does not describe this route.
    RouteMismatch,
    WrongHost,
    Expired,
    NotPending,
    NotGranted,
    AlreadyConsumed,
}

#[derive(Debug, Default)]
pub struct AccessManager {
    requests: BTreeMap<String, AccessRequest>,
    sequence: u64,
}

impl AccessManager {
    pub fn issue(
        &mut self,
        mut request: AccessRequest,
        now_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        self.prune(now_ms);
        if self.requests.contains_key(&request.request_id) {
            return Err(AccessError::Duplicate);
        }
        // Single flight per (source, host, service): a route claim can only ever
        // see one outstanding permission, so "which approval authorised this
        // call" is answered by construction instead of by a similarity match.
        let outstanding = self.requests.values().any(|existing| {
            existing.source_instance == request.source_instance
                && existing.target_host_id == request.target_host_id
                && existing.target_service == request.target_service
                && matches!(
                    existing.status,
                    AccessStatus::Pending | AccessStatus::Granted
                )
        });
        if outstanding {
            return Err(AccessError::Busy);
        }
        request.status = AccessStatus::Pending;
        request.grant_id = None;
        self.requests
            .insert(request.request_id.clone(), request.clone());
        Ok(request)
    }

    pub fn decide(
        &mut self,
        host_id: &str,
        request_id: &str,
        allow: bool,
        now_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(AccessError::Unknown)?;
        if request.target_host_id != host_id {
            return Err(AccessError::WrongHost);
        }
        if request.expires_at_ms <= now_ms {
            request.status = AccessStatus::Expired;
            return Err(AccessError::Expired);
        }
        if request.status != AccessStatus::Pending {
            return Err(AccessError::NotPending);
        }
        request.status = if allow {
            AccessStatus::Granted
        } else {
            AccessStatus::Denied
        };
        if allow {
            self.sequence = self.sequence.wrapping_add(1);
            request.grant_id = Some(format!("grant-{now_ms}-{}", self.sequence));
        }
        Ok(request.clone())
    }

    pub fn consume(
        &mut self,
        request_id: &str,
        grant_id: &str,
        host_id: &str,
        now_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(AccessError::Unknown)?;
        if request.target_host_id != host_id {
            return Err(AccessError::WrongHost);
        }
        if request.grant_id.as_deref() != Some(grant_id) {
            return Err(AccessError::NotGranted);
        }
        if request.expires_at_ms <= now_ms {
            request.status = AccessStatus::Expired;
            return Err(AccessError::Expired);
        }
        match request.status {
            AccessStatus::Granted => request.status = AccessStatus::Consumed,
            AccessStatus::Consumed => return Err(AccessError::AlreadyConsumed),
            _ => return Err(AccessError::NotGranted),
        }
        Ok(request.clone())
    }

    /// Atomically claim the one approved request for a fixed adapter route.
    /// A missing or ambiguous match is rejected rather than guessing.
    ///
    /// `request_id` is the strong form: when the calling plugin can carry the
    /// approval it was given, the claim is an identity check. Without it we fall
    /// back to the single-flight tuple match, which is unambiguous by
    /// construction because `issue` refuses a second outstanding permission for
    /// the same source, host and service.
    pub fn claim(
        &mut self,
        source_instance: &str,
        host_id: &str,
        service: AccessService,
        operation: &str,
        request_id: Option<&str>,
        now_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        self.prune(now_ms);
        if let Some(request_id) = request_id {
            return self.claim_identified(
                request_id,
                source_instance,
                host_id,
                service,
                operation,
                now_ms,
            );
        }
        let mut matches = self
            .requests
            .values()
            .filter(|request| {
                request.source_instance == source_instance
                    && request.target_host_id == host_id
                    && request.target_service == service
                    && request.operation == operation
                    && request.status == AccessStatus::Granted
                    && request.expires_at_ms > now_ms
            })
            .map(|request| request.request_id.clone());
        let request_id = matches.next().ok_or(AccessError::NoMatchingGrant)?;
        if matches.next().is_some() {
            return Err(AccessError::AmbiguousGrant);
        }
        let request = self
            .requests
            .get_mut(&request_id)
            .ok_or(AccessError::Unknown)?;
        request.status = AccessStatus::Consumed;
        Ok(request.clone())
    }

    /// Claim exactly the named approval. Any mismatch is terminal: the caller
    /// must not silently widen to a tuple search after being told which
    /// request it was allowed to use.
    fn claim_identified(
        &mut self,
        request_id: &str,
        source_instance: &str,
        host_id: &str,
        service: AccessService,
        operation: &str,
        now_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(AccessError::Unknown)?;
        if request.source_instance != source_instance
            || request.target_host_id != host_id
            || request.target_service != service
            || request.operation != operation
        {
            return Err(AccessError::RouteMismatch);
        }
        if request.expires_at_ms <= now_ms {
            request.status = AccessStatus::Expired;
            request.grant_id = None;
            return Err(AccessError::Expired);
        }
        match request.status {
            AccessStatus::Granted => request.status = AccessStatus::Consumed,
            AccessStatus::Consumed => return Err(AccessError::AlreadyConsumed),
            _ => return Err(AccessError::NotGranted),
        }
        Ok(request.clone())
    }

    pub fn get(&mut self, request_id: &str, now_ms: u64) -> Result<AccessRequest, AccessError> {
        self.prune(now_ms);
        self.requests
            .get(request_id)
            .cloned()
            .ok_or(AccessError::Unknown)
    }

    pub fn revoke(&mut self, request_id: &str, now_ms: u64) -> Result<AccessRequest, AccessError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(AccessError::Unknown)?;
        if request.expires_at_ms <= now_ms {
            request.status = AccessStatus::Expired;
            return Err(AccessError::Expired);
        }
        if !matches!(
            request.status,
            AccessStatus::Pending | AccessStatus::Granted
        ) {
            return Err(AccessError::NotPending);
        }
        request.status = AccessStatus::Revoked;
        request.grant_id = None;
        Ok(request.clone())
    }

    pub fn host_disconnected(&mut self, host_id: &str) -> Vec<String> {
        let mut cancelled = Vec::new();
        for request in self.requests.values_mut().filter(|r| {
            r.target_host_id == host_id
                && matches!(r.status, AccessStatus::Pending | AccessStatus::Granted)
        }) {
            request.status = AccessStatus::HostOffline;
            request.grant_id = None;
            cancelled.push(request.request_id.clone());
        }
        cancelled
    }

    pub fn report_result(
        &mut self,
        request_id: &str,
        host_id: &str,
        http_status: u16,
        elapsed_ms: u64,
    ) -> Result<AccessRequest, AccessError> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or(AccessError::Unknown)?;
        if request.target_host_id != host_id {
            return Err(AccessError::WrongHost);
        }
        if request.status != AccessStatus::Consumed {
            return Err(AccessError::NotGranted);
        }
        if !(100..=599).contains(&http_status) {
            return Err(AccessError::NotGranted);
        }
        request.result_status = Some(format!("http_{http_status}"));
        request.elapsed_ms = Some(elapsed_ms.min(600_000));
        Ok(request.clone())
    }

    pub fn prune(&mut self, now_ms: u64) {
        for request in self.requests.values_mut().filter(|r| {
            r.expires_at_ms <= now_ms
                && matches!(r.status, AccessStatus::Pending | AccessStatus::Granted)
        }) {
            request.status = AccessStatus::Expired;
            request.grant_id = None;
        }
        self.requests
            .retain(|_, request| request.expires_at_ms.saturating_add(MAX_ACCESS_TTL_MS) > now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AccessRequest {
        AccessRequest {
            request_id: "r1".into(),
            source_instance: "coo".into(),
            target_host_id: "server".into(),
            target_service: AccessService::Tts,
            operation: "speech.synthesize".into(),
            purpose: "say greeting".into(),
            environment_id: None,
            expires_at_ms: 10_000,
            grant_id: None,
            status: AccessStatus::Pending,
            result_status: None,
            elapsed_ms: None,
        }
    }

    #[test]
    fn grant_is_host_bound_single_use_and_revokeable() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        assert_eq!(
            manager.decide("other", "r1", true, 1),
            Err(AccessError::WrongHost)
        );
        assert_eq!(
            manager.consume("r1", "x", "server", 1),
            Err(AccessError::NotGranted)
        );
        let grant = manager.decide("server", "r1", true, 1).unwrap();
        assert!(grant.grant_id.is_some());
        let grant_id = grant.grant_id.unwrap();
        assert_eq!(
            manager
                .consume("r1", &grant_id, "server", 2)
                .unwrap()
                .status,
            AccessStatus::Consumed
        );
        assert_eq!(
            manager.consume("r1", &grant_id, "server", 3),
            Err(AccessError::AlreadyConsumed)
        );
    }

    #[test]
    fn expiry_revoke_disconnect_and_duplicate_are_terminal() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        assert_eq!(manager.issue(request(), 0), Err(AccessError::Duplicate));
        manager.decide("server", "r1", true, 1).unwrap();
        assert_eq!(
            manager.revoke("r1", 2).unwrap().status,
            AccessStatus::Revoked
        );
        manager
            .issue(
                AccessRequest {
                    request_id: "r2".into(),
                    ..request()
                },
                0,
            )
            .unwrap();
        manager.host_disconnected("server");
        assert_eq!(
            manager.get("r2", 2).unwrap().status,
            AccessStatus::HostOffline
        );
        manager
            .issue(
                AccessRequest {
                    request_id: "r3".into(),
                    ..request()
                },
                0,
            )
            .unwrap();
        assert_eq!(
            manager.get("r3", 10_000).unwrap().status,
            AccessStatus::Expired
        );
    }

    #[test]
    fn result_is_recorded_only_after_consumption_and_without_payload() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        manager.decide("server", "r1", true, 1).unwrap();
        let grant = manager.get("r1", 1).unwrap().grant_id.unwrap();
        assert_eq!(
            manager.report_result("r1", "server", 200, 44),
            Err(AccessError::NotGranted)
        );
        manager.consume("r1", &grant, "server", 2).unwrap();
        let result = manager.report_result("r1", "server", 200, 44).unwrap();
        assert_eq!(result.result_status.as_deref(), Some("http_200"));
        assert_eq!(result.elapsed_ms, Some(44));
    }

    #[test]
    fn claim_matches_the_fixed_route_and_rejects_ambiguity() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        manager.decide("server", "r1", true, 1).unwrap();
        let claimed = manager
            .claim(
                "coo",
                "server",
                AccessService::Tts,
                "speech.synthesize",
                None,
                2,
            )
            .unwrap();
        assert_eq!(claimed.request_id, "r1");
        assert_eq!(claimed.status, AccessStatus::Consumed);
        assert_eq!(
            manager.claim(
                "coo",
                "server",
                AccessService::Tts,
                "speech.synthesize",
                None,
                3
            ),
            Err(AccessError::NoMatchingGrant)
        );

        let mut second = request();
        second.request_id = "r2".into();
        manager.issue(second, 0).unwrap();
        manager.decide("server", "r2", true, 1).unwrap();
        // Single flight: r3 cannot even be issued while r2 is outstanding, so the
        // tuple branch can never become ambiguous in the first place.
        let mut third = request();
        third.request_id = "r3".into();
        assert_eq!(manager.issue(third, 2), Err(AccessError::Busy));

        let mut other_service = request();
        other_service.request_id = "r4".into();
        other_service.target_service = AccessService::Asr;
        other_service.operation = "audio.transcribe".into();
        manager.issue(other_service, 2).unwrap();
        let mut other_source = request();
        other_source.request_id = "r5".into();
        other_source.source_instance = "other".into();
        manager.issue(other_source, 2).unwrap();
        assert_eq!(
            manager
                .claim(
                    "coo",
                    "server",
                    AccessService::Tts,
                    "speech.synthesize",
                    None,
                    3
                )
                .unwrap()
                .request_id,
            "r2"
        );
    }

    #[test]
    fn an_outstanding_permission_blocks_a_second_one_for_the_same_route() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        let mut again = request();
        again.request_id = "r2".into();
        assert_eq!(manager.issue(again, 0), Err(AccessError::Busy));

        manager.decide("server", "r1", true, 1).unwrap();
        let mut while_granted = request();
        while_granted.request_id = "r3".into();
        assert_eq!(manager.issue(while_granted, 2), Err(AccessError::Busy));

        // Consumption frees the route, so a fresh request may be issued.
        let grant = manager.get("r1", 1).unwrap().grant_id.unwrap();
        manager.consume("r1", &grant, "server", 3).unwrap();
        let mut next = request();
        next.request_id = "r-next".into();
        manager.issue(next, 4).unwrap();
        // A revoked pending request frees the route too.
        manager.revoke("r-next", 5).unwrap();
        let mut after_revoke = request();
        after_revoke.request_id = "r-after".into();
        manager.issue(after_revoke, 6).unwrap();
    }

    #[test]
    fn an_identified_claim_is_an_identity_check_not_a_search() {
        let mut manager = AccessManager::default();
        manager.issue(request(), 0).unwrap();
        manager.decide("server", "r1", true, 1).unwrap();

        // Wrong host is rejected without consuming anything.
        assert_eq!(
            manager.claim(
                "coo",
                "elsewhere",
                AccessService::Tts,
                "speech.synthesize",
                Some("r1"),
                2
            ),
            Err(AccessError::RouteMismatch)
        );
        assert_eq!(
            manager.claim(
                "other",
                "server",
                AccessService::Tts,
                "speech.synthesize",
                Some("r1"),
                2
            ),
            Err(AccessError::RouteMismatch)
        );
        assert_eq!(
            manager.claim(
                "coo",
                "server",
                AccessService::Asr,
                "audio.transcribe",
                Some("r1"),
                2
            ),
            Err(AccessError::RouteMismatch)
        );
        // A named request that does not exist is a hard error, never a fallback
        // to "the only other pending request".
        assert_eq!(
            manager.claim(
                "coo",
                "server",
                AccessService::Tts,
                "speech.synthesize",
                Some("r-does-not-exist"),
                2
            ),
            Err(AccessError::Unknown)
        );
        assert_eq!(
            manager
                .claim(
                    "coo",
                    "server",
                    AccessService::Tts,
                    "speech.synthesize",
                    Some("r1"),
                    2
                )
                .unwrap()
                .status,
            AccessStatus::Consumed
        );
        assert_eq!(
            manager.claim(
                "coo",
                "server",
                AccessService::Tts,
                "speech.synthesize",
                Some("r1"),
                3
            ),
            Err(AccessError::AlreadyConsumed)
        );
    }
}
