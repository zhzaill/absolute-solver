pub mod adapters;
pub mod cortico;
pub mod memory;
pub mod wire;

use std::{
    collections::BTreeMap,
    io,
    path::Path,
    sync::{Arc, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tokio::{fs::OpenOptions, io::AsyncWriteExt, sync::Mutex};

pub use wire::{HubState, Message, TraceEvent};

pub type SharedTrace = Arc<TraceWriter>;

pub struct TraceWriter {
    file: Mutex<tokio::fs::File>,
}

impl TraceWriter {
    pub async fn open(path: impl AsRef<Path>) -> io::Result<SharedTrace> {
        if let Some(parent) = path.as_ref().parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        Ok(Arc::new(Self {
            file: Mutex::new(file),
        }))
    }

    pub async fn write(&self, event: TraceEvent) -> io::Result<()> {
        let line = serde_json::to_vec(&event).map_err(io::Error::other)?;
        let mut file = self.file.lock().await;
        file.write_all(&line).await?;
        file.write_all(b"\n").await?;
        file.flush().await
    }
}

pub async fn load_trace(path: impl AsRef<Path>) -> io::Result<Vec<TraceEvent>> {
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    contents
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid trace JSON at line {}: {error}", index + 1),
                )
            })
        })
        .collect()
}

pub fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn mouth_from_pcm(pcm: &[u8]) -> Vec<f32> {
    if pcm.is_empty() {
        return Vec::new();
    }
    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    if samples.is_empty() {
        return Vec::new();
    }
    let windows = samples.chunks((samples.len() / 18).max(1));
    windows
        .map(|chunk| {
            let sum: f64 = chunk.iter().map(|sample| (*sample as f64).powi(2)).sum();
            ((sum / chunk.len() as f64).sqrt() / i16::MAX as f64).min(1.0) as f32
        })
        .collect()
}

pub fn trace_event(dir: &str, message: &Message, note: impl Into<String>) -> TraceEvent {
    trace_event_for_turn(dir, message, message.turn(), note)
}

pub fn trace_event_for_turn(
    dir: &str,
    message: &Message,
    turn: Option<u64>,
    note: impl Into<String>,
) -> TraceEvent {
    let (kind, seq) = match message {
        Message::Hello { .. } => ("hello", None),
        Message::AudioUp { seq, .. } => ("audio.up", Some(*seq)),
        Message::Say { seq, .. } => ("say", Some(*seq)),
        Message::SpeechStart { .. } => ("speech.start", None),
        Message::SpeechEnd { .. } => ("speech.end", None),
        Message::RenderCue { .. } => ("render.cue", None),
        Message::BodyHandoff { .. } => ("body.handoff", None),
        Message::TurnStarted { .. } => ("turn.started", None),
        Message::ProtocolError { .. } => ("protocol.error", None),
    };
    TraceEvent {
        ts: epoch_ms(),
        dir: dir.to_owned(),
        kind: kind.to_owned(),
        turn,
        seq,
        note: note.into(),
    }
}

pub fn state_payload(state: &HubState) -> BTreeMap<&'static str, serde_json::Value> {
    BTreeMap::from([
        ("state", serde_json::json!(state.state)),
        ("turn", serde_json::json!(state.turn)),
        ("since_ms", serde_json::json!(state.since_ms)),
        (
            "elapsed_ms",
            serde_json::json!(now_ms().saturating_sub(state.since_ms)),
        ),
        ("reason", serde_json::json!(state.reason)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouth_envelope_is_bounded() {
        let pcm = vec![0xff, 0x7f, 0x00, 0x00, 0x00, 0x80, 0x10, 0x00];
        let values = mouth_from_pcm(&pcm);
        assert!(!values.is_empty());
        assert!(values.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn trace_keeps_audio_payload_out_of_jsonl() {
        let message = Message::AudioUp {
            turn: 3,
            seq: 4,
            pcm_b64: "private-audio".into(),
            sr: 16_000,
        };
        let json = serde_json::to_value(trace_event("body->hub", &message, "640 bytes")).unwrap();
        assert_eq!(json["type"], "audio.up");
        assert_eq!(json["turn"], 3);
        assert_eq!(json["seq"], 4);
        assert!(json.get("pcm_b64").is_none());
    }

    #[tokio::test]
    async fn trace_load_survives_process_restart() {
        let path = std::env::temp_dir().join(format!("absolute-solver-trace-{}.jsonl", now_ms()));
        let message = Message::SpeechStart { at_ms: 10 };
        let event = trace_event_for_turn("body->hub", &message, Some(2), "interrupted");
        let writer = TraceWriter::open(&path).await.unwrap();
        writer.write(event.clone()).await.unwrap();
        drop(writer);
        let loaded = load_trace(&path).await.unwrap();
        let _ = tokio::fs::remove_file(path).await;
        assert_eq!(loaded, vec![event]);
    }
}
