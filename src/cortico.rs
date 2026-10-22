use serde::{Deserialize, Serialize};

/// Vendor-neutral event envelope used at the Cortico/Hub boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorticoEvent {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub session_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub seq: u64,
    pub ts_mono_ms: u64,
    pub source: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

impl CorticoEvent {
    pub fn validate(&self) -> Result<(), String> {
        if self.v != 1 {
            return Err(format!("unsupported event version {}", self.v));
        }
        if self.kind.trim().is_empty() {
            return Err("event type is empty".into());
        }
        if self.session_id.trim().is_empty() {
            return Err("session_id is empty".into());
        }
        if self.source.trim().is_empty() {
            return Err("source is empty".into());
        }
        Ok(())
    }

    pub fn turn_number(&self) -> Option<u64> {
        self.turn_id.as_deref()?.parse().ok()
    }

    pub fn trace_note(&self) -> String {
        let payload_keys = self
            .payload
            .as_object()
            .map(|payload| payload.keys().cloned().collect::<Vec<_>>().join(","))
            .unwrap_or_default();
        format!(
            "type={}; session={}; source={}; seq={}; ts_mono_ms={}; payload_keys={}",
            self.kind, self.session_id, self.source, self.seq, self.ts_mono_ms, payload_keys
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_round_trip_keeps_vendor_neutral_envelope() {
        let event = CorticoEvent {
            v: 1,
            kind: "world.event".into(),
            session_id: "s-1".into(),
            turn_id: Some("42".into()),
            seq: 7,
            ts_mono_ms: 123,
            source: "cortico-world".into(),
            payload: serde_json::json!({"text":"hello","priority":"normal"}),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "world.event");
        assert_eq!(serde_json::from_value::<CorticoEvent>(json).unwrap(), event);
        assert_eq!(event.turn_number(), Some(42));
        assert!(event.trace_note().contains("payload_keys=priority,text"));
    }

    #[test]
    fn trace_note_never_copies_payload_text() {
        let event = CorticoEvent {
            v: 1,
            kind: "world.event".into(),
            session_id: "s-1".into(),
            turn_id: None,
            seq: 0,
            ts_mono_ms: 0,
            source: "cortico".into(),
            payload: serde_json::json!({"text":"private"}),
        };
        assert!(event.validate().is_ok());
        assert!(!event.trace_note().contains("private"));
    }
}
