use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

use absolute_solver::{
    adapters::decode_wav_pcm16,
    now_ms, trace_event,
    wire::{
        decode_wire_message, BinaryMediaFrame, BinaryMediaKind, Message, TraceEvent,
        WireDecodeError, WireEnvelope,
    },
    TraceWriter,
};
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{http::Uri, Message as WsMessage},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("SOLVER_HUB_URL").unwrap_or_else(|_| "ws://127.0.0.1:18100/ws".into());
    let device_id = std::env::var("SOLVER_DEVICE_ID").unwrap_or_else(|_| "body-windows".into());
    let trace_path = std::env::var("SOLVER_TRACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("trace/absolute-solver-body.jsonl"));
    let input_wav = std::env::var_os("SOLVER_INPUT_WAV").map(PathBuf::from);
    let output_wav = std::env::var_os("SOLVER_OUTPUT_WAV").map(PathBuf::from);
    let play_say = env_bool("SOLVER_PLAY_SAY");
    let listen_only = env_bool("SOLVER_BODY_LISTEN_ONLY");
    let mut capture_seconds = std::env::var("SOLVER_CAPTURE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(1, 30));
    if listen_only && capture_seconds.is_some() {
        return Err(
            "SOLVER_BODY_LISTEN_ONLY and SOLVER_CAPTURE_SECONDS cannot be used together".into(),
        );
    }
    let replay_mode = input_wav.is_some();
    let capture_mode = capture_seconds.is_some();
    let trace = TraceWriter::open(trace_path).await?;
    let mut simulated = false;
    let mut retry_seconds = 1u64;
    loop {
        match connect_async(&url).await {
            Ok((mut socket, _)) => {
                println!("connected to {url} as {device_id}");
                let connected_at = tokio::time::Instant::now();
                match run_connection(
                    &mut socket,
                    &url,
                    &device_id,
                    &trace,
                    &mut simulated,
                    input_wav.as_deref(),
                    output_wav.as_deref(),
                    play_say,
                    listen_only,
                    capture_seconds.take(),
                )
                .await
                {
                    Ok(()) if replay_mode || capture_mode => return Ok(()),
                    Err(error) if capture_mode => return Err(error),
                    Ok(()) => {}
                    Err(error) => eprintln!("hub connection ended: {error}"),
                }
                if connected_at.elapsed() >= Duration::from_secs(30) {
                    retry_seconds = 1;
                }
            }
            Err(error) => eprintln!("hub connection failed: {error}"),
        }
        eprintln!("retrying hub connection in {retry_seconds}s");
        tokio::time::sleep(Duration::from_secs(retry_seconds)).await;
        retry_seconds = (retry_seconds * 2).min(30);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_connection<S>(
    socket: &mut S,
    url: &str,
    device_id: &str,
    trace: &absolute_solver::SharedTrace,
    simulated: &mut bool,
    input_wav: Option<&Path>,
    output_wav: Option<&Path>,
    play_say: bool,
    listen_only: bool,
    capture_seconds: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Sink<WsMessage>
        + Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let hello = Message::Hello {
        device_id: device_id.to_owned(),
        caps: serde_json::json!({
            "mic": true,
            "speaker": true,
            "display": "subtitle",
            "codec": ["pcm16"],
            "media": ["pcm16-binary"]
        }),
    };
    send(socket, &hello, trace).await?;
    if listen_only {
        println!("listen-only body registered as {device_id}; waiting for say");
        return pump(socket, SayTarget::Forever, trace, output_wav, play_say).await;
    }
    if let Some(seconds) = capture_seconds {
        *simulated = true;
        let start = Message::SpeechStart { at_ms: now_ms() };
        send(socket, &start, trace).await?;
        let turn =
            tokio::time::timeout(Duration::from_secs(10), receive_turn_started(socket, trace))
                .await??;
        let capture = tokio::task::spawn_blocking(move || capture_microphone(seconds))
            .await
            .map_err(std::io::Error::other)?;
        let (sample_rate, pcm) = capture.map_err(std::io::Error::other)?;
        println!(
            "captured {seconds}s from default microphone: {} PCM bytes at {sample_rate} Hz",
            pcm.len()
        );
        let chunk_size = (sample_rate as usize * 2 / 10).max(2);
        for (seq, chunk) in pcm.chunks(chunk_size).enumerate() {
            let audio = Message::AudioUp {
                turn,
                seq: seq as u64,
                pcm_b64: base64::engine::general_purpose::STANDARD.encode(chunk),
                sr: sample_rate,
            };
            send(socket, &audio, trace).await?;
        }
        let end = Message::SpeechEnd {
            turn,
            at_ms: now_ms(),
        };
        send(socket, &end, trace).await?;
        tokio::time::timeout(
            Duration::from_secs(90),
            pump(socket, SayTarget::Turn(turn), trace, output_wav, play_say),
        )
        .await??;
        return Ok(());
    }
    if !*simulated {
        let mut turn = hub_turn(url).await? + 1;
        *simulated = true;
        if let Some(path) = input_wav {
            let wav = tokio::fs::read(path).await?;
            let (pcm, sample_rate) = decode_wav_pcm16(&wav)?;
            println!(
                "replaying {path:?} as microphone input: {} bytes at {sample_rate} Hz",
                pcm.len()
            );
            let chunk_size = (sample_rate as usize * 2 / 10).max(2);
            for (seq, chunk) in pcm.chunks(chunk_size).enumerate() {
                let audio = Message::AudioUp {
                    turn,
                    seq: seq as u64,
                    pcm_b64: base64::engine::general_purpose::STANDARD.encode(chunk),
                    sr: sample_rate,
                };
                send(socket, &audio, trace).await?;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        } else {
            println!("starting simulator turn {turn}");
            for seq in 0..3 {
                let pcm = fake_pcm(seq);
                let audio = Message::AudioUp {
                    turn,
                    seq,
                    pcm_b64: base64::engine::general_purpose::STANDARD.encode(&pcm),
                    sr: 16_000,
                };
                send(socket, &audio, trace).await?;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let end = Message::SpeechEnd {
            turn,
            at_ms: now_ms(),
        };
        send(socket, &end, trace).await?;
        tokio::time::timeout(
            Duration::from_secs(60),
            pump(socket, SayTarget::Turn(turn), trace, output_wav, play_say),
        )
        .await??;
        if input_wav.is_some() {
            return Ok(());
        }
        if input_wav.is_none() {
            let interrupt = Message::SpeechStart { at_ms: now_ms() };
            send(socket, &interrupt, trace).await?;
            println!("sent speech.start; local playback queue is muted");
            turn += 1;
            let audio = Message::AudioUp {
                turn,
                seq: 0,
                pcm_b64: base64::engine::general_purpose::STANDARD.encode(fake_pcm(7)),
                sr: 16_000,
            };
            send(socket, &audio, trace).await?;
            let end = Message::SpeechEnd {
                turn,
                at_ms: now_ms(),
            };
            send(socket, &end, trace).await?;
            tokio::time::timeout(
                Duration::from_secs(30),
                pump(socket, SayTarget::Turn(turn), trace, output_wav, play_say),
            )
            .await??;
        }
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut last_received = tokio::time::Instant::now();
    loop {
        tokio::select! {
            frame = socket.next() => match frame {
                Some(Ok(WsMessage::Text(text))) => {
                    last_received = tokio::time::Instant::now();
                    match decode_wire_message(&text) {
                        Ok(message) => trace.write(trace_event("hub->body", &message, "received while idle")).await?,
                        Err(WireDecodeError::UnknownType { kind }) => {
                            eprintln!("ignored unknown hub message type: {kind}");
                            trace.write(unknown_type_event("hub->body", &kind)).await?;
                        }
                        Err(error) => eprintln!("ignored invalid hub message: {error}"),
                    }
                }
                Some(Ok(WsMessage::Binary(bytes))) => {
                    last_received = tokio::time::Instant::now();
                    if BinaryMediaFrame::decode(&bytes).is_err() {
                        eprintln!("ignored invalid binary media frame while idle");
                    }
                }
                Some(Ok(WsMessage::Ping(payload))) => {
                    last_received = tokio::time::Instant::now();
                    socket.send(WsMessage::Pong(payload)).await?;
                }
                Some(Ok(WsMessage::Pong(_))) => last_received = tokio::time::Instant::now(),
                Some(Ok(WsMessage::Close(_))) | None => return Err("hub closed the websocket".into()),
                Some(Ok(_)) => last_received = tokio::time::Instant::now(),
                Some(Err(error)) => return Err(error.into()),
            },
            _ = heartbeat.tick() => {
                if last_received.elapsed() > Duration::from_secs(45) {
                    return Err("hub heartbeat timed out".into());
                }
                socket.send(WsMessage::Ping(Vec::new())).await?;
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum SayTarget {
    /// Return once a `say` for this turn or later has been handled.
    Turn(u64),
    /// Keep the connection open and play every `say` that arrives.
    Forever,
}

/// Metadata of a `say` whose PCM travels in the following binary frame.
struct PendingSay {
    turn: u64,
    seq: u64,
    sr: u32,
    text: String,
    mouth: usize,
}

/// Ordered segment queue for one connection.
///
/// A `say` is only played when its `seq` is the next expected one; later
/// segments wait in a bounded buffer, duplicates and stale turns are dropped.
#[derive(Default)]
struct SegmentQueue {
    turn: u64,
    next_seq: u64,
    pending: std::collections::BTreeMap<u64, PlayJob>,
    pending_bytes: usize,
    dropped: u64,
    played: u64,
}

const QUEUE_DEPTH_LIMIT: usize = 32;
const QUEUE_BYTE_LIMIT: usize = 8 * 1024 * 1024;

impl SegmentQueue {
    /// Returns the jobs that are now ready to play, in order.
    fn accept(&mut self, job: PlayJob) -> Vec<PlayJob> {
        if job.turn < self.turn || (job.turn == self.turn && job.seq < self.next_seq) {
            self.dropped += 1;
            println!(
                "dropped stale say turn={} seq={}; current turn={} next_seq={}",
                job.turn, job.seq, self.turn, self.next_seq
            );
            return Vec::new();
        }
        if job.turn > self.turn {
            let stale = self.pending.len() as u64;
            if stale > 0 {
                println!(
                    "turn changed {} -> {}; dropping {} queued segment(s)",
                    self.turn, job.turn, stale
                );
            }
            self.dropped += stale;
            self.pending.clear();
            self.pending_bytes = 0;
            self.turn = job.turn;
            // Start where the stream starts: after an active-body handoff the
            // first frame of a turn can be seq > 0, and waiting for seq 0 would
            // stall the rest of the turn forever.
            self.next_seq = job.seq;
        }
        if job.seq > self.next_seq {
            let bytes = job.pcm.len();
            if self.pending.len() >= QUEUE_DEPTH_LIMIT
                || self.pending_bytes.saturating_add(bytes) > QUEUE_BYTE_LIMIT
            {
                self.dropped += 1;
                println!(
                    "queue full ({} segments, {} bytes); dropped turn={} seq={}",
                    self.pending.len(),
                    self.pending_bytes,
                    job.turn,
                    job.seq
                );
                return Vec::new();
            }
            self.pending_bytes = self.pending_bytes.saturating_add(bytes);
            self.pending.insert(job.seq, job);
            return Vec::new();
        }
        let mut ready = vec![job];
        self.next_seq = self.next_seq.saturating_add(1);
        while let Some(next) = self.pending.remove(&self.next_seq) {
            self.pending_bytes = self.pending_bytes.saturating_sub(next.pcm.len());
            ready.push(next);
            self.next_seq = self.next_seq.saturating_add(1);
        }
        ready
    }

    fn depth(&self) -> usize {
        self.pending.len()
    }
}

#[derive(Debug)]
struct PlayJob {
    turn: u64,
    seq: u64,
    sr: u32,
    pcm: Vec<u8>,
    text: String,
    mouth: usize,
    transport: &'static str,
}

#[derive(Debug)]
struct PlayEvent {
    turn: u64,
    seq: u64,
    audible: bool,
    mouth: usize,
    pcm_bytes: usize,
    pcm_ms: u64,
    player_ms: u64,
    transport: &'static str,
    error: Option<String>,
    /// The chunk was queued for a turn that has since been superseded.
    superseded: bool,
}

/// Owns the blocking playback thread. The thread creates the audio stream (cpal
/// streams are not `Send` on Windows) and plays queued chunks back to back.
struct Player {
    jobs: Option<tokio::sync::mpsc::Sender<PlayJob>>,
    events: tokio::sync::mpsc::Receiver<PlayEvent>,
    /// Highest turn the body has been told about; older queued chunks are skipped.
    latest_turn: Arc<AtomicU64>,
}

impl Player {
    fn start(play: bool) -> Self {
        let (job_tx, mut job_rx) = tokio::sync::mpsc::channel::<PlayJob>(64);
        let (event_tx, event_rx) = tokio::sync::mpsc::channel::<PlayEvent>(64);
        let latest_turn = Arc::new(AtomicU64::new(0));
        let thread_turn = latest_turn.clone();
        let spawned = std::thread::Builder::new()
            .name("absolute-solver-speaker".into())
            .spawn(move || {
                let mut speaker = if play {
                    match Speaker::start() {
                        Ok(speaker) => Some(speaker),
                        Err(error) => {
                            eprintln!(
                                "speaker unavailable ({error}); falling back to WAV playback"
                            );
                            None
                        }
                    }
                } else {
                    None
                };
                while let Some(job) = job_rx.blocking_recv() {
                    let superseded = job.turn < thread_turn.load(Ordering::Relaxed);
                    let started = std::time::Instant::now();
                    let pcm_ms = pcm_duration_ms(job.pcm.len(), job.sr);
                    let error = if superseded || !play {
                        None
                    } else if let Some(speaker) = speaker.as_ref() {
                        speaker.play(&job.pcm, job.sr).err()
                    } else {
                        fallback_play(&job)
                    };
                    let event = PlayEvent {
                        turn: job.turn,
                        seq: job.seq,
                        audible: play && speaker.is_some() && !superseded,
                        mouth: job.mouth,
                        pcm_bytes: job.pcm.len(),
                        pcm_ms,
                        player_ms: started.elapsed().as_millis() as u64,
                        transport: job.transport,
                        error,
                        superseded,
                    };
                    if event_tx.blocking_send(event).is_err() {
                        break;
                    }
                }
                speaker.take();
            });
        if let Err(error) = spawned {
            eprintln!("failed to start speaker thread: {error}");
            return Self {
                jobs: None,
                events: event_rx,
                latest_turn,
            };
        }
        Self {
            jobs: Some(job_tx),
            events: event_rx,
            latest_turn,
        }
    }

    /// Marks every queued chunk of an older turn as superseded.
    fn interrupt(&self, turn: u64) {
        self.latest_turn.fetch_max(turn, Ordering::Relaxed);
    }

    async fn submit(&self, jobs: Vec<PlayJob>) {
        let Some(sender) = self.jobs.as_ref() else {
            return;
        };
        for job in jobs {
            println!(
                "queued say turn={} seq={} sr={} pcm={} bytes text={}",
                job.turn,
                job.seq,
                job.sr,
                job.pcm.len(),
                job.text
            );
            if sender.send(job).await.is_err() {
                eprintln!("speaker thread stopped; dropping queued segment");
            }
        }
    }
}

struct Speaker {
    shared: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<f32>>>,
    #[allow(dead_code)]
    stream: cpal::Stream,
    rate: u32,
}

impl Speaker {
    fn start() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "no default output device".to_owned())?;
        let supported = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let rate = supported.sample_rate().0;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        // A mono source has to be written once per interleaved frame, otherwise a
        // stereo device consumes the buffer twice as fast (audible 2x speed).
        let channels = usize::from(config.channels);
        println!(
            "speaker stream: {} Hz, {} channel(s), {:?}",
            rate, channels, format
        );
        let shared = std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::VecDeque::<f32>::new(),
        ));
        let stream = match format {
            cpal::SampleFormat::F32 => {
                let buffer = shared.clone();
                device
                    .build_output_stream(
                        &config,
                        move |data: &mut [f32], _| drain_into_f32(data, channels, &buffer),
                        |error| eprintln!("output stream error: {error}"),
                        None,
                    )
                    .map_err(|error| error.to_string())?
            }
            cpal::SampleFormat::I16 => {
                let buffer = shared.clone();
                device
                    .build_output_stream(
                        &config,
                        move |data: &mut [i16], _| drain_into_i16(data, channels, &buffer),
                        |error| eprintln!("output stream error: {error}"),
                        None,
                    )
                    .map_err(|error| error.to_string())?
            }
            other => return Err(format!("unsupported output sample format {other:?}")),
        };
        stream.play().map_err(|error| error.to_string())?;
        Ok(Self {
            shared,
            stream,
            rate,
        })
    }

    fn play(&self, pcm: &[u8], sample_rate: u32) -> Result<(), String> {
        let duration = pcm_duration_ms(pcm.len(), sample_rate);
        if !pcm.is_empty() && sample_rate > 0 {
            let samples: Vec<f32> = pcm
                .chunks_exact(2)
                .map(|frame| i16::from_le_bytes([frame[0], frame[1]]) as f32 / 32768.0)
                .collect();
            let resampled = resample_linear(&samples, sample_rate, self.rate);
            let mut buffer = self
                .shared
                .lock()
                .map_err(|_| "speaker buffer poisoned".to_owned())?;
            buffer.extend(resampled);
        }
        std::thread::sleep(std::time::Duration::from_millis(duration));
        Ok(())
    }
}

fn drain_into_f32(
    data: &mut [f32],
    channels: usize,
    buffer: &std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<f32>>>,
) {
    let mut queue = match buffer.lock() {
        Ok(queue) => queue,
        Err(_) => {
            data.fill(0.0);
            return;
        }
    };
    // One mono sample per interleaved frame, duplicated to every channel.
    for frame in data.chunks_mut(channels.max(1)) {
        let sample = queue.pop_front().unwrap_or(0.0);
        for slot in frame.iter_mut() {
            *slot = sample;
        }
    }
}

fn drain_into_i16(
    data: &mut [i16],
    channels: usize,
    buffer: &std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<f32>>>,
) {
    let mut queue = match buffer.lock() {
        Ok(queue) => queue,
        Err(_) => {
            data.fill(0);
            return;
        }
    };
    for frame in data.chunks_mut(channels.max(1)) {
        let sample = queue.pop_front().unwrap_or(0.0).clamp(-1.0, 1.0);
        let scaled = (sample * i16::MAX as f32) as i16;
        for slot in frame.iter_mut() {
            *slot = scaled;
        }
    }
}

fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if from_rate == to_rate || from_rate == 0 || to_rate == 0 {
        return samples.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let output_len = ((samples.len() as f64) * ratio).round() as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let position = index as f64 / ratio;
        let base = position.floor() as usize;
        let fraction = (position - base as f64) as f32;
        let first = samples.get(base).copied().unwrap_or(0.0);
        let second = samples.get(base + 1).copied().unwrap_or(first);
        output.push(first + (second - first) * fraction);
    }
    output
}

fn pcm_duration_ms(bytes: usize, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    (bytes as u64 * 1_000 / (u64::from(sample_rate) * 2)).max(1)
}

/// Consumes hub frames until the target turn is fulfilled or the socket closes.
async fn pump<S>(
    socket: &mut S,
    target: SayTarget,
    trace: &absolute_solver::SharedTrace,
    output_wav: Option<&Path>,
    play_say: bool,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut pending_meta: Option<PendingSay> = None;
    let mut queue = SegmentQueue::default();
    let mut player = Player::start(play_say);
    loop {
        tokio::select! {
            frame = socket.next() => {
                let Some(frame) = frame else {
                    return Err("hub closed before say".into());
                };
                match frame? {
                    WsMessage::Text(text) => {
                        let message = match decode_wire_message(&text) {
                            Ok(message) => message,
                            Err(WireDecodeError::UnknownType { kind }) => {
                                println!("ignored unknown hub message type: {kind}");
                                trace.write(unknown_type_event("hub->body", &kind)).await?;
                                continue;
                            }
                            Err(error) => {
                                println!("ignored invalid hub message: {error}");
                                continue;
                            }
                        };
                        let Message::Say {
                            turn,
                            seq,
                            pcm_b64,
                            sr,
                            mouth,
                            text,
                            media,
                            seg_total,
                            last: _last,
                        } = &message
                        else {
                            if let Message::RenderCue { turn, kind, .. } = &message {
                                if kind == "interrupt"
                                    && turn.is_none_or(|cue_turn| cue_turn >= queue.turn)
                                {
                                    let dropped = queue.depth();
                                    queue.pending.clear();
                                    queue.pending_bytes = 0;
                                    queue.dropped += dropped as u64;
                                    player.interrupt(turn.unwrap_or(queue.turn));
                                    println!(
                                        "interrupt cue: dropped {dropped} buffered segment(s); queued chunks are skipped"
                                    );
                                }
                            }
                            trace
                                .write(trace_event(
                                    "hub->body",
                                    &message,
                                    "received while waiting for say",
                                ))
                                .await?;
                            continue;
                        };
                        if media.as_deref() == Some("pcm16-binary") {
                            trace
                                .write(trace_event(
                                    "hub->body",
                                    &message,
                                    format!(
                                        "say metadata turn={turn} seq={seq} seg_total={seg_total:?}; awaiting binary frame"
                                    ),
                                ))
                                .await?;
                            pending_meta = Some(PendingSay {
                                turn: *turn,
                                seq: *seq,
                                sr: *sr,
                                text: text.clone(),
                                mouth: mouth.len(),
                            });
                            continue;
                        }
                        let pcm = base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            pcm_b64,
                        )?;
                        trace
                            .write(trace_event(
                                "hub->body",
                                &message,
                                format!("say turn={turn} seq={seq} seg_total={seg_total:?}; json-base64"),
                            ))
                            .await?;
                        let job = PlayJob {
                            turn: *turn,
                            seq: *seq,
                            sr: *sr,
                            pcm,
                            text: text.clone(),
                            mouth: mouth.len(),
                            transport: "json-base64",
                        };
                        if let Some(path) = output_wav {
                            save_diagnostic_wav(path, &job).await?;
                        }
                        player.submit(queue.accept(job)).await;
                    }
                    WsMessage::Binary(bytes) => {
                        let frame = match BinaryMediaFrame::decode(&bytes) {
                            Ok(frame) => frame,
                            Err(error) => {
                                println!("ignored invalid binary media frame: {error}");
                                continue;
                            }
                        };
                        if frame.kind != BinaryMediaKind::SayAudio {
                            println!("ignored binary media kind {:?}", frame.kind);
                            continue;
                        }
                        let Some(metadata) = pending_meta.take() else {
                            queue.dropped += 1;
                            println!(
                                "dropped say.audio turn={} seq={} without metadata",
                                frame.turn, frame.seq
                            );
                            continue;
                        };
                        if metadata.turn != frame.turn || metadata.seq != frame.seq {
                            queue.dropped += 1;
                            println!(
                                "dropped say.audio turn={} seq={}; metadata was turn={} seq={}",
                                frame.turn, frame.seq, metadata.turn, metadata.seq
                            );
                            continue;
                        }
                        let sr = if metadata.sr == frame.sample_rate {
                            frame.sample_rate
                        } else {
                            println!(
                                "say.audio sample rate mismatch: metadata={} frame={}",
                                metadata.sr, frame.sample_rate
                            );
                            frame.sample_rate
                        };
                        let job = PlayJob {
                            turn: frame.turn,
                            seq: frame.seq,
                            sr,
                            pcm: frame.pcm,
                            text: metadata.text,
                            mouth: metadata.mouth,
                            transport: "pcm16-binary",
                        };
                        if let Some(path) = output_wav {
                            save_diagnostic_wav(path, &job).await?;
                        }
                        println!("queue depth before turn={} seq={}: {}", job.turn, job.seq, queue.depth());
                        player.submit(queue.accept(job)).await;
                    }
                    WsMessage::Close(_) => return Err("hub closed the websocket".into()),
                    _ => {}
                }
            }
            Some(event) = player.events.recv() => {
                queue.played += 1;
                let playback = match (&event.error, event.audible, event.superseded) {
                    (Some(error), _, _) => format!("playback failed: {error}"),
                    (None, _, true) => "skipped (superseded by newer turn)".to_owned(),
                    (None, true, false) => format!(
                        "played; player_ms={}; pcm_ms={}",
                        event.player_ms, event.pcm_ms
                    ),
                    (None, false, false) => {
                        format!("skipped (no audio output); pcm_ms={}", event.pcm_ms)
                    }
                };
                println!(
                    "say turn={} seq={} pcm={} bytes mouth={} transport={} {playback}",
                    event.turn, event.seq, event.pcm_bytes, event.mouth, event.transport
                );
                trace
                    .write(TraceEvent {
                        ts: absolute_solver::epoch_ms(),
                        dir: "body".into(),
                        kind: "playback".into(),
                        turn: Some(event.turn),
                        seq: Some(event.seq),
                        note: format!(
                            "pcm={} bytes; mouth={}; pcm_ms={}; transport={}; {}; queue_depth={}; played={}; dropped={}",
                            event.pcm_bytes,
                            event.mouth,
                            event.pcm_ms,
                            event.transport,
                            playback,
                            queue.depth(),
                            queue.played,
                            queue.dropped
                        ),
                    })
                    .await?;
                if fulfilled(target, event.turn) && queue.depth() == 0 {
                    return Ok(());
                }
            }
        }
    }
}

fn fulfilled(target: SayTarget, turn: u64) -> bool {
    match target {
        SayTarget::Turn(expected) => turn >= expected,
        SayTarget::Forever => false,
    }
}

/// Writes one diagnostic WAV per segment when `SOLVER_OUTPUT_WAV` is set.
async fn save_diagnostic_wav(base: &Path, job: &PlayJob) -> Result<(), Box<dyn std::error::Error>> {
    let stem = base
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "segment".into());
    let extension = base
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .unwrap_or_else(|| "wav".into());
    let path = base.with_file_name(format!("{stem}-t{}-s{}.{}", job.turn, job.seq, extension));
    write_wav(&path, &job.pcm, job.sr).await?;
    println!("saved response audio to {path:?}");
    Ok(())
}

fn unknown_type_event(dir: &str, kind: &str) -> TraceEvent {
    TraceEvent {
        ts: absolute_solver::epoch_ms(),
        dir: dir.to_owned(),
        kind: "unknown.type".into(),
        turn: None,
        seq: None,
        note: format!("unknown_type={kind}"),
    }
}

async fn write_wav(
    path: &Path,
    pcm: &[u8],
    sample_rate: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, pcm16_wav(pcm, sample_rate.max(1))).await?;
    Ok(())
}

/// Transient playback file; removed after the speaker finishes.
/// Last-resort playback for machines without a usable cpal output device.
fn fallback_play(job: &PlayJob) -> Option<String> {
    let path = transient_wav_path(job.turn);
    if let Err(error) = std::fs::write(&path, pcm16_wav(&job.pcm, job.sr.max(1))) {
        return Some(format!("wav write failed: {error}"));
    }
    let outcome = play_wav(&path);
    let _ = std::fs::remove_file(&path);
    outcome.err().map(|error| error.to_string())
}

fn transient_wav_path(turn: u64) -> PathBuf {
    std::env::temp_dir().join(format!(
        "absolute-solver-say-{turn}-{}.wav",
        std::process::id()
    ))
}

async fn hub_turn(ws_url: &str) -> Result<u64, Box<dyn std::error::Error>> {
    let uri: Uri = ws_url.parse()?;
    if uri.scheme_str() != Some("ws") {
        return Err("D0 state bootstrap currently requires ws://".into());
    }
    let host = uri.host().ok_or("hub URL is missing a host")?;
    let port = uri.port_u16().unwrap_or(80);
    let mut stream = tokio::net::TcpStream::connect((host, port)).await?;
    let host_header = if port == 80 {
        host.to_owned()
    } else {
        format!("{host}:{port}")
    };
    stream
        .write_all(
            format!("GET /state HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("invalid /state HTTP response")?;
    let status = std::str::from_utf8(&response[..header_end])?;
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        return Err(format!(
            "hub /state request failed: {}",
            status.lines().next().unwrap_or("unknown status")
        )
        .into());
    }
    let state: serde_json::Value = serde_json::from_slice(&response[header_end + 4..])?;
    state["turn"]
        .as_u64()
        .ok_or_else(|| "hub /state response has no turn".into())
}

async fn send<S>(
    socket: &mut S,
    message: &Message,
    trace: &absolute_solver::SharedTrace,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Sink<WsMessage> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(&WireEnvelope::new(message.clone()))?;
    socket.send(WsMessage::Text(text)).await?;
    trace
        .write(trace_event("body->hub", message, "sent"))
        .await?;
    Ok(())
}

fn pcm16_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

fn play_wav(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        let escaped = path.to_string_lossy().replace('\'', "''");
        let status = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(New-Object System.Media.SoundPlayer '{escaped}').PlaySync()"),
            ])
            .status()?;
        if !status.success() {
            return Err(format!("speaker playback exited with {status}").into());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("speaker playback is currently implemented for Windows bodies only".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{drain_into_f32, resample_linear, send_input_samples};
    use std::collections::VecDeque;
    use std::sync::{mpsc, Arc, Mutex};

    #[test]
    fn microphone_samples_downmix_stereo_to_mono() {
        let (sender, receiver) = mpsc::sync_channel(1);
        send_input_samples(&[100i16, 300, -100, 100], 2, &sender);
        assert_eq!(receiver.recv().unwrap(), vec![200, 0]);
    }

    #[test]
    fn microphone_float_samples_convert_to_pcm16() {
        let (sender, receiver) = mpsc::sync_channel(1);
        send_input_samples(&[-1.0f32, 0.0, 1.0], 1, &sender);
        assert_eq!(receiver.recv().unwrap(), vec![i16::MIN, 0, i16::MAX]);
    }

    #[test]
    fn interleaved_frames_take_one_mono_sample_each() {
        // A stereo device must not consume the mono buffer twice as fast, which
        // is what made the first segmented run play at double speed.
        let buffer = Arc::new(Mutex::new(VecDeque::from(vec![0.25f32, 0.5, 0.75])));
        let mut data = [0f32; 6];
        drain_into_f32(&mut data, 2, &buffer);
        assert_eq!(data, [0.25, 0.25, 0.5, 0.5, 0.75, 0.75]);
        assert!(buffer.lock().unwrap().is_empty());
    }

    #[test]
    fn resampling_preserves_duration() {
        let one_second_at_32k = vec![0.0f32; 32_000];
        let upsampled = resample_linear(&one_second_at_32k, 32_000, 48_000);
        assert_eq!(upsampled.len(), 48_000);
        let back = resample_linear(&upsampled, 48_000, 32_000);
        assert_eq!(back.len(), 32_000);
        assert_eq!(resample_linear(&[0.1, 0.2], 32_000, 32_000), vec![0.1, 0.2]);
    }

    fn job(turn: u64, seq: u64) -> super::PlayJob {
        super::PlayJob {
            turn,
            seq,
            sr: 32_000,
            pcm: vec![0, 0],
            text: format!("seg-{seq}"),
            mouth: 1,
            transport: "pcm16-binary",
        }
    }

    #[test]
    fn queue_plays_in_order_and_buffers_early_segments() {
        let mut queue = super::SegmentQueue::default();
        let first = queue.accept(job(1, 0));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].seq, 0);
        // A segment that arrives before its predecessor waits in the buffer.
        assert!(queue.accept(job(1, 2)).is_empty());
        let drained = queue.accept(job(1, 1));
        assert_eq!(
            drained.iter().map(|job| job.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(queue.depth(), 0);
    }

    #[test]
    fn queue_drops_duplicate_and_stale_segments() {
        let mut queue = super::SegmentQueue::default();
        assert_eq!(queue.accept(job(2, 0)).len(), 1);
        assert!(queue.accept(job(2, 0)).is_empty());
        assert_eq!(queue.dropped, 1);
        assert!(queue.accept(job(1, 3)).is_empty());
        assert_eq!(queue.dropped, 2);
    }

    #[test]
    fn queue_resets_on_a_new_turn() {
        let mut queue = super::SegmentQueue::default();
        assert_eq!(queue.accept(job(3, 0)).len(), 1);
        assert!(queue.accept(job(3, 2)).is_empty());
        assert_eq!(queue.depth(), 1);
        assert_eq!(queue.accept(job(4, 0)).len(), 1);
        assert_eq!(queue.depth(), 0);
        assert_eq!(queue.dropped, 1);
    }

    #[test]
    fn queue_starts_mid_turn_after_a_handoff() {
        let mut queue = super::SegmentQueue::default();
        let ready = queue.accept(job(7, 3));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].seq, 3);
        let next = queue.accept(job(7, 4));
        assert_eq!(next.len(), 1);
        assert_eq!(queue.dropped, 0);
    }

    #[test]
    fn queue_is_bounded_by_bytes() {
        let mut queue = super::SegmentQueue::default();
        assert_eq!(queue.accept(job(9, 0)).len(), 1);
        let mut big = job(9, 2);
        big.pcm = vec![0u8; super::QUEUE_BYTE_LIMIT];
        assert!(queue.accept(big).is_empty());
        assert_eq!(queue.depth(), 1);
        let mut overflow = job(9, 3);
        overflow.pcm = vec![0u8; 1024];
        assert!(queue.accept(overflow).is_empty());
        assert_eq!(queue.dropped, 1);
    }

    #[test]
    fn queue_is_bounded() {
        let mut queue = super::SegmentQueue::default();
        assert_eq!(queue.accept(job(5, 0)).len(), 1);
        // Everything after the gap waits, so the buffer can fill up.
        for seq in 2..=(super::QUEUE_DEPTH_LIMIT as u64 + 1) {
            assert!(queue.accept(job(5, seq)).is_empty());
        }
        assert_eq!(queue.depth(), super::QUEUE_DEPTH_LIMIT);
        assert!(queue.accept(job(5, 999)).is_empty());
        assert_eq!(queue.depth(), super::QUEUE_DEPTH_LIMIT);
        assert_eq!(queue.dropped, 1);
    }
}

fn env_bool(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn fake_pcm(seq: u64) -> Vec<u8> {
    let mut pcm = Vec::with_capacity(640);
    for i in 0..320 {
        let value = (((i as f32 / 320.0) * std::f32::consts::TAU * (seq as f32 + 1.0)).sin()
            * 12_000.0) as i16;
        pcm.extend_from_slice(&value.to_le_bytes());
    }
    pcm
}

/// Captures one bounded utterance from the system default input device.
/// The PCM remains in memory and is discarded after the turn is sent.
fn capture_microphone(
    seconds: u64,
) -> Result<(u32, Vec<u8>), Box<dyn std::error::Error + Send + Sync>> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no default microphone input device")?;
    let config = device.default_input_config()?;
    let sample_rate = config.sample_rate().0;
    let channels = usize::from(config.channels().max(1));
    let (sender, receiver) = mpsc::sync_channel::<Vec<i16>>(32);
    let error_callback = |error| eprintln!("microphone stream error: {error}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.config(),
            move |data: &[i16], _| send_input_samples(data, channels, &sender),
            error_callback,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.config(),
            move |data: &[u16], _| {
                let converted: Vec<i16> = data
                    .iter()
                    .map(|sample| {
                        (*sample as i32 - 32_768).clamp(i16::MIN as i32, i16::MAX as i32) as i16
                    })
                    .collect();
                send_input_samples(&converted, channels, &sender);
            },
            error_callback,
            None,
        )?,
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.config(),
            move |data: &[f32], _| {
                let converted: Vec<i16> = data
                    .iter()
                    .map(|sample| (sample.clamp(-1.0, 1.0) * 32_767.0) as i16)
                    .collect();
                send_input_samples(&converted, channels, &sender);
            },
            error_callback,
            None,
        )?,
        format => return Err(format!("unsupported microphone sample format {format:?}").into()),
    };
    stream.play()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    let mut pcm = Vec::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = receiver.recv_timeout(Duration::from_millis(100)) {
            pcm.extend_from_slice(&chunk);
        }
    }
    drop(stream);
    while let Ok(chunk) = receiver.try_recv() {
        pcm.extend_from_slice(&chunk);
    }
    if pcm.is_empty() {
        return Err("microphone produced no PCM samples".into());
    }
    Ok((
        sample_rate,
        pcm.into_iter().flat_map(i16::to_le_bytes).collect(),
    ))
}

fn send_input_samples<T: cpal::SizedSample + Copy>(
    data: &[T],
    channels: usize,
    sender: &mpsc::SyncSender<Vec<i16>>,
) where
    i16: cpal::FromSample<T>,
{
    let mut mono = Vec::with_capacity(data.len() / channels.max(1));
    for frame in data.chunks(channels.max(1)) {
        let sum: i32 = frame
            .iter()
            .map(|sample| i32::from((*sample).to_sample::<i16>()))
            .sum();
        mono.push((sum / frame.len() as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16);
    }
    let _ = sender.try_send(mono);
}

async fn receive_turn_started<S>(
    socket: &mut S,
    trace: &absolute_solver::SharedTrace,
) -> Result<u64, Box<dyn std::error::Error>>
where
    S: Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(frame) = socket.next().await {
        let WsMessage::Text(text) = frame? else {
            continue;
        };
        match decode_wire_message(&text) {
            Ok(Message::TurnStarted { turn }) => {
                trace
                    .write(TraceEvent {
                        ts: now_ms(),
                        dir: "hub->body".into(),
                        kind: "turn.started".into(),
                        turn: Some(turn),
                        seq: None,
                        note: "microphone capture turn assigned".into(),
                    })
                    .await?;
                return Ok(turn);
            }
            Ok(message) => {
                trace
                    .write(trace_event(
                        "hub->body",
                        &message,
                        "received before microphone turn",
                    ))
                    .await?;
            }
            Err(error) => eprintln!("ignored hub message before turn assignment: {error}"),
        }
    }
    Err("hub closed before assigning microphone turn".into())
}
