use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const PROTOCOL_NAME: &str = "absolute-solver";
pub const PROTOCOL_VERSION: u16 = 1;
pub const BINARY_MEDIA_MAGIC: [u8; 4] = *b"ASV1";
pub const BINARY_MEDIA_VERSION: u8 = 1;
pub const BINARY_MEDIA_HEADER_LEN: usize = 28;

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
        #[serde(skip_serializing_if = "Option::is_none")]
        media: Option<String>,
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
    #[serde(rename = "turn.started")]
    TurnStarted { turn: u64 },
    #[serde(rename = "protocol.error")]
    ProtocolError {
        code: String,
        message: String,
        fatal: bool,
    },
}

impl Message {
    pub fn turn(&self) -> Option<u64> {
        match self {
            Self::AudioUp { turn, .. } | Self::Say { turn, .. } | Self::SpeechEnd { turn, .. } => {
                Some(*turn)
            }
            Self::RenderCue { turn, .. } => *turn,
            Self::TurnStarted { turn } => Some(*turn),
            Self::SpeechStart { .. }
            | Self::Hello { .. }
            | Self::BodyHandoff { .. }
            | Self::ProtocolError { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BinaryMediaKind {
    AudioUp = 1,
    SayAudio = 2,
}

impl BinaryMediaKind {
    fn from_u8(value: u8) -> Result<Self, BinaryMediaError> {
        match value {
            1 => Ok(Self::AudioUp),
            2 => Ok(Self::SayAudio),
            other => Err(BinaryMediaError::UnsupportedKind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryMediaFrame {
    pub kind: BinaryMediaKind,
    pub turn: u64,
    pub seq: u64,
    pub sample_rate: u32,
    pub pcm: Vec<u8>,
}

impl BinaryMediaFrame {
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(BINARY_MEDIA_HEADER_LEN + self.pcm.len());
        bytes.extend_from_slice(&BINARY_MEDIA_MAGIC);
        bytes.push(BINARY_MEDIA_VERSION);
        bytes.push(self.kind as u8);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&self.turn.to_le_bytes());
        bytes.extend_from_slice(&self.seq.to_le_bytes());
        bytes.extend_from_slice(&self.sample_rate.to_le_bytes());
        bytes.extend_from_slice(&self.pcm);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, BinaryMediaError> {
        if bytes.len() < BINARY_MEDIA_HEADER_LEN {
            return Err(BinaryMediaError::TooShort(bytes.len()));
        }
        if bytes[..4] != BINARY_MEDIA_MAGIC {
            return Err(BinaryMediaError::InvalidMagic);
        }
        if bytes[4] != BINARY_MEDIA_VERSION {
            return Err(BinaryMediaError::UnsupportedVersion(bytes[4]));
        }
        let kind = BinaryMediaKind::from_u8(bytes[5])?;
        let turn = u64::from_le_bytes(bytes[8..16].try_into().expect("fixed-width turn"));
        let seq = u64::from_le_bytes(bytes[16..24].try_into().expect("fixed-width seq"));
        let sample_rate =
            u32::from_le_bytes(bytes[24..28].try_into().expect("fixed-width sample rate"));
        if !(8_000..=96_000).contains(&sample_rate) {
            return Err(BinaryMediaError::InvalidSampleRate(sample_rate));
        }
        let pcm = bytes[BINARY_MEDIA_HEADER_LEN..].to_vec();
        if pcm.len() % 2 != 0 {
            return Err(BinaryMediaError::OddPcm16Length(pcm.len()));
        }
        Ok(Self {
            kind,
            turn,
            seq,
            sample_rate,
            pcm,
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BinaryMediaError {
    #[error("binary media frame too short: {0} bytes")]
    TooShort(usize),
    #[error("invalid binary media magic")]
    InvalidMagic,
    #[error("unsupported binary media version {0}")]
    UnsupportedVersion(u8),
    #[error("unsupported binary media kind {0}")]
    UnsupportedKind(u8),
    #[error("invalid audio sample rate {0}")]
    InvalidSampleRate(u32),
    #[error("PCM16 payload has odd byte count {0}")]
    OddPcm16Length(usize),
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

    #[test]
    fn binary_media_frame_round_trips() {
        let frame = BinaryMediaFrame {
            kind: BinaryMediaKind::AudioUp,
            turn: 12,
            seq: 3,
            sample_rate: 16_000,
            pcm: vec![1, 0, 2, 0],
        };
        assert_eq!(BinaryMediaFrame::decode(&frame.encode()).unwrap(), frame);
    }

    #[test]
    fn binary_media_rejects_invalid_header_and_odd_pcm() {
        assert_eq!(
            BinaryMediaFrame::decode(b"bad"),
            Err(BinaryMediaError::TooShort(3))
        );

        let mut frame = BinaryMediaFrame {
            kind: BinaryMediaKind::AudioUp,
            turn: 1,
            seq: 0,
            sample_rate: 16_000,
            pcm: vec![1, 0],
        }
        .encode();
        frame.push(2);
        assert_eq!(
            BinaryMediaFrame::decode(&frame),
            Err(BinaryMediaError::OddPcm16Length(3))
        );
    }
}
