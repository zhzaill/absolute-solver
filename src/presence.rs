use std::collections::BTreeMap;

use crate::wire::PresenceDecisionKind;

pub const PRESENCE_NOTIFY_SCOPE: &str = "presence:notify";
pub const PRESENCE_SHOW_SCOPE: &str = "presence:show";
pub const MIN_PRESENCE_TTL_MS: u64 = 1_000;
pub const MAX_PRESENCE_TTL_MS: u64 = 120_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPresence {
    pub host_id: String,
    pub scopes: Vec<String>,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivePresence {
    pub intent_id: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresenceError {
    UnknownIntent,
    WrongHost,
    Expired,
    ScopeNotRequested,
    AlreadyPresent,
}

#[derive(Debug, Default)]
pub struct PresenceManager {
    pending: BTreeMap<String, PendingPresence>,
    active: BTreeMap<String, ActivePresence>,
}

impl PresenceManager {
    pub fn issue(&mut self, id: String, intent: PendingPresence, now_ms: u64) {
        self.prune(now_ms);
        self.pending.insert(id, intent);
    }

    pub fn decide(
        &mut self,
        host_id: &str,
        intent_id: &str,
        decision: PresenceDecisionKind,
        now_ms: u64,
    ) -> Result<Option<ActivePresence>, PresenceError> {
        let intent = self
            .pending
            .get(intent_id)
            .ok_or(PresenceError::UnknownIntent)?;
        if intent.host_id != host_id {
            return Err(PresenceError::WrongHost);
        }
        if intent.expires_at_ms <= now_ms {
            self.pending.remove(intent_id);
            return Err(PresenceError::Expired);
        }
        if decision == PresenceDecisionKind::Appear {
            if !intent
                .scopes
                .iter()
                .any(|scope| scope == PRESENCE_SHOW_SCOPE)
            {
                return Err(PresenceError::ScopeNotRequested);
            }
            if self.active.contains_key(host_id) {
                return Err(PresenceError::AlreadyPresent);
            }
        }
        let intent = self.pending.remove(intent_id).expect("intent was checked");
        if decision != PresenceDecisionKind::Appear {
            return Ok(None);
        }
        let active = ActivePresence {
            intent_id: intent_id.to_owned(),
            expires_at_ms: intent.expires_at_ms,
        };
        self.active.insert(host_id.to_owned(), active.clone());
        Ok(Some(active))
    }

    pub fn revoke(&mut self, host_id: &str, intent_id: &str) -> bool {
        if self
            .active
            .get(host_id)
            .is_some_and(|active| active.intent_id == intent_id)
        {
            self.active.remove(host_id);
            true
        } else if self
            .pending
            .get(intent_id)
            .is_some_and(|pending| pending.host_id == host_id)
        {
            self.pending.remove(intent_id);
            true
        } else {
            false
        }
    }

    pub fn prune(&mut self, now_ms: u64) -> Vec<(String, ActivePresence)> {
        self.pending
            .retain(|_, intent| intent.expires_at_ms > now_ms);
        let expired_hosts: Vec<_> = self
            .active
            .iter()
            .filter(|(_, active)| active.expires_at_ms <= now_ms)
            .map(|(host_id, _)| host_id.clone())
            .collect();
        expired_hosts
            .into_iter()
            .filter_map(|host_id| self.active.remove(&host_id).map(|active| (host_id, active)))
            .collect()
    }

    pub fn active(&self, host_id: &str, now_ms: u64) -> Option<&ActivePresence> {
        self.active
            .get(host_id)
            .filter(|active| active.expires_at_ms > now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(scopes: &[&str], expiry: u64) -> PendingPresence {
        PendingPresence {
            host_id: "host-a".into(),
            scopes: scopes.iter().map(|scope| (*scope).into()).collect(),
            expires_at_ms: expiry,
        }
    }

    #[test]
    fn one_time_appear_is_scoped_and_expires() {
        let mut manager = PresenceManager::default();
        manager.issue(
            "i1".into(),
            request(&[PRESENCE_NOTIFY_SCOPE, PRESENCE_SHOW_SCOPE], 5000),
            0,
        );
        let active = manager
            .decide("host-a", "i1", PresenceDecisionKind::Appear, 1)
            .unwrap()
            .unwrap();
        assert_eq!(active.expires_at_ms, 5000);
        assert_eq!(
            manager.decide("host-a", "i1", PresenceDecisionKind::Appear, 2),
            Err(PresenceError::UnknownIntent)
        );
        assert!(manager.active("host-a", 4999).is_some());
        let expired = manager.prune(5000);
        assert_eq!(expired.len(), 1);
        assert!(manager.active("host-a", 5000).is_none());
    }

    #[test]
    fn notify_and_reject_never_create_an_overlay_lease() {
        for decision in [PresenceDecisionKind::Notify, PresenceDecisionKind::Reject] {
            let mut manager = PresenceManager::default();
            manager.issue("i1".into(), request(&[PRESENCE_NOTIFY_SCOPE], 5000), 0);
            assert_eq!(manager.decide("host-a", "i1", decision, 1), Ok(None));
            assert!(manager.active("host-a", 1).is_none());
        }
    }

    #[test]
    fn wrong_host_and_missing_show_scope_cannot_consume_into_presence() {
        let mut manager = PresenceManager::default();
        manager.issue("i1".into(), request(&[PRESENCE_NOTIFY_SCOPE], 5000), 0);
        assert_eq!(
            manager.decide("host-b", "i1", PresenceDecisionKind::Appear, 1),
            Err(PresenceError::WrongHost)
        );
        assert_eq!(
            manager.decide("host-a", "i1", PresenceDecisionKind::Appear, 1),
            Err(PresenceError::ScopeNotRequested)
        );
        assert_eq!(
            manager.decide("host-a", "i1", PresenceDecisionKind::Notify, 1),
            Ok(None)
        );
    }

    #[test]
    fn revoke_is_bound_to_host_and_intent() {
        let mut manager = PresenceManager::default();
        manager.issue("i1".into(), request(&[PRESENCE_SHOW_SCOPE], 5000), 0);
        manager
            .decide("host-a", "i1", PresenceDecisionKind::Appear, 1)
            .unwrap();
        assert!(!manager.revoke("host-b", "i1"));
        assert!(!manager.revoke("host-a", "other"));
        assert!(manager.revoke("host-a", "i1"));
    }
}
