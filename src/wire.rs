use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_NAME: &str = "absolute-solver";
pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    Hello {
        device_id: String,
        caps: serde_json::Value,
    },
    #[serde(rename = "audio.up")]
    AudioUp {
        turn: u64,
        seq: u64,
        pcm_b64: String,
        sr: u32,
    },
    Say {
        turn: u64,
        seq: u64,
        pcm_b64: String,
        sr: u32,
        mouth: Vec<f32>,
        text: String,
    },
    #[serde(rename = "speech.start")]
    SpeechStart { at_ms: u64 },
    #[serde(rename = "speech.end")]
    SpeechEnd { turn: u64, at_ms: u64 },
    #[serde(rename = "render.cue")]
    RenderCue {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<u64>,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expression: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        motion: Option<String>,
    },
    #[serde(rename = "body.handoff")]
    BodyHandoff {
        #[serde(skip_serializing_if = "Option::is_none")]
        active_body: Option<String>,
        reason: String,
    },
}

impl Message {
    pub fn turn(&self) -> Option<u64> {
        match self {
            Self::AudioUp { turn, .. } | Self::Say { turn, .. } | Self::SpeechEnd { turn, .. } => {
                Some(*turn)
            }
            Self::RenderCue { turn, .. } => *turn,
            Self::SpeechStart { .. } | Self::Hello { .. } | Self::BodyHandoff { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct WireEnvelope {
    #[serde(default = "default_protocol_version")]
    pub v: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(flatten)]
    pub message: Message,
}

impl WireEnvelope {
    pub fn new(message: Message) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            message_id: None,
            message,
        }
    }
}

#[derive(Debug, Error)]
pub enum WireDecodeError {
    #[error("invalid wire JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported protocol version {actual}; supported version is {supported}")]
    UnsupportedVersion { actual: u16, supported: u16 },
}

pub fn decode_client_message(text: &str) -> Result<Message, WireDecodeError> {
    let envelope: WireEnvelope = serde_json::from_str(text)?;
    if envelope.v != PROTOCOL_VERSION {
        return Err(WireDecodeError::UnsupportedVersion {
            actual: envelope.v,
            supported: PROTOCOL_VERSION,
        });
    }
    Ok(envelope.message)
}

fn default_protocol_version() -> u16 {
    PROTOCOL_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct TraceEvent {
    pub ts: u64,
    pub dir: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HubState {
    pub state: StateName,
    pub turn: u64,
    pub since_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StateName {
    Idle,
    Listening,
    Thinking,
    Speaking,
    Degraded,
}

impl Default for HubState {
    fn default() -> Self {
        Self {
            state: StateName::Idle,
            turn: 0,
            since_ms: crate::now_ms(),
            reason: "startup".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotted_wire_names_round_trip() {
        let message = Message::SpeechStart { at_ms: 42 };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "speech.start");
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);
    }

    #[test]
    fn speech_end_carries_its_turn() {
        let message = Message::SpeechEnd { turn: 9, at_ms: 42 };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "speech.end");
        assert_eq!(json["turn"], 9);
        assert_eq!(message.turn(), Some(9));
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);
    }

    #[test]
    fn render_cue_round_trips() {
        let message = Message::RenderCue {
            turn: Some(12),
            kind: "cue".into(),
            text: Some("看向镜头".into()),
            expression: Some("F01".into()),
            motion: Some("Tap".into()),
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "render.cue");
        assert_eq!(json["turn"], 12);
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);
    }

    #[test]
    fn body_handoff_round_trips() {
        let message = Message::BodyHandoff {
            active_body: Some("host-panel-a".into()),
            reason: "first_body".into(),
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "body.handoff");
        assert_eq!(json["active_body"], "host-panel-a");
        assert_eq!(json["reason"], "first_body");
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);
    }

    #[test]
    fn versioned_envelope_serializes_flat_wire_fields() {
        let envelope = WireEnvelope::new(Message::SpeechStart { at_ms: 42 });
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["v"], PROTOCOL_VERSION);
        assert_eq!(json["type"], "speech.start");
        assert_eq!(json["at_ms"], 42);
        assert_eq!(
            decode_client_message(&serde_json::to_string(&envelope).unwrap()).unwrap(),
            Message::SpeechStart { at_ms: 42 }
        );
    }

    #[test]
    fn legacy_unversioned_messages_are_accepted_as_v1() {
        let message = decode_client_message(r#"{"type":"speech.start","at_ms":9}"#).unwrap();
        assert_eq!(message, Message::SpeechStart { at_ms: 9 });
    }

    #[test]
    fn unsupported_protocol_versions_are_rejected() {
        let error =
            decode_client_message(r#"{"v":2,"type":"speech.start","at_ms":9}"#).unwrap_err();
        assert!(error.to_string().contains("unsupported protocol version 2"));
    }
}
