use std::{
    path::{Path, PathBuf},
    process::Command,
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
    let replay_mode = input_wav.is_some();
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
                )
                .await
                {
                    Ok(()) if replay_mode => return Ok(()),
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
    let mut pending: Option<PendingSay> = None;
    let mut last_turn = 0u64;
    let mut last_seq = 0u64;
    while let Some(frame) = socket.next().await {
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
                } = &message
                else {
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
                            format!("say metadata turn={turn} seq={seq}; awaiting binary frame"),
                        ))
                        .await?;
                    pending = Some(PendingSay {
                        turn: *turn,
                        seq: *seq,
                        sr: *sr,
                        text: text.clone(),
                        mouth: mouth.len(),
                    });
                    continue;
                }
                let pcm =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, pcm_b64)?;
                trace
                    .write(trace_event(
                        "hub->body",
                        &message,
                        format!("say turn={turn} seq={seq}; json-base64"),
                    ))
                    .await?;
                let handled = deliver(
                    trace,
                    SayAudio {
                        turn: *turn,
                        seq: *seq,
                        sr: *sr,
                        pcm,
                        text: text.clone(),
                        mouth: mouth.len(),
                        transport: "json-base64",
                    },
                    output_wav,
                    play_say,
                    &mut last_turn,
                    &mut last_seq,
                )
                .await?;
                if handled && fulfilled(target, *turn) {
                    return Ok(());
                }
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
                let Some(metadata) = pending.take() else {
                    println!(
                        "dropped say.audio turn={} seq={} without metadata",
                        frame.turn, frame.seq
                    );
                    continue;
                };
                if metadata.turn != frame.turn || metadata.seq != frame.seq {
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
                let handled = deliver(
                    trace,
                    SayAudio {
                        turn: frame.turn,
                        seq: frame.seq,
                        sr,
                        pcm: frame.pcm,
                        text: metadata.text,
                        mouth: metadata.mouth,
                        transport: "pcm16-binary",
                    },
                    output_wav,
                    play_say,
                    &mut last_turn,
                    &mut last_seq,
                )
                .await?;
                if handled && fulfilled(target, frame.turn) {
                    return Ok(());
                }
            }
            WsMessage::Close(_) => return Err("hub closed the websocket".into()),
            _ => {}
        }
    }
    Err("hub closed before say".into())
}

fn fulfilled(target: SayTarget, turn: u64) -> bool {
    match target {
        SayTarget::Turn(expected) => turn >= expected,
        SayTarget::Forever => false,
    }
}

struct SayAudio {
    turn: u64,
    seq: u64,
    sr: u32,
    pcm: Vec<u8>,
    text: String,
    mouth: usize,
    transport: &'static str,
}

/// Writes the diagnostic WAV when asked, plays the PCM, and records the result.
async fn deliver(
    trace: &absolute_solver::SharedTrace,
    audio: SayAudio,
    output_wav: Option<&Path>,
    play_say: bool,
    last_turn: &mut u64,
    last_seq: &mut u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    let bytes = audio.pcm.len();
    let duration_ms = if audio.sr == 0 {
        0
    } else {
        bytes as u64 * 1_000 / (u64::from(audio.sr) * 2)
    };
    if audio.turn < *last_turn || (audio.turn == *last_turn && audio.seq <= *last_seq) {
        println!(
            "dropped out-of-order say turn={} seq={}; last turn={} seq={}",
            audio.turn, audio.seq, *last_turn, *last_seq
        );
        return Ok(false);
    }
    *last_turn = audio.turn;
    *last_seq = audio.seq;
    let mut saved: Option<PathBuf> = None;
    if let Some(path) = output_wav {
        write_wav(path, &audio.pcm, audio.sr).await?;
        println!("saved response audio to {path:?}");
        saved = Some(path.to_path_buf());
    }
    let mut playback = "skipped".to_owned();
    if play_say && bytes > 0 {
        let transient = saved.is_none();
        let path = match saved.clone() {
            Some(path) => path,
            None => transient_wav_path(audio.turn),
        };
        if transient {
            write_wav(&path, &audio.pcm, audio.sr).await?;
        }
        let started = std::time::Instant::now();
        match play_wav(&path) {
            Ok(()) => {
                playback = format!(
                    "played; player_ms={}; pcm_ms={duration_ms}",
                    started.elapsed().as_millis()
                );
            }
            Err(error) => playback = format!("playback failed: {error}"),
        }
        if transient {
            let _ = tokio::fs::remove_file(&path).await;
        }
    } else if bytes == 0 {
        playback = "empty pcm; nothing to play".to_owned();
    }
    println!(
        "say turn={} seq={} sr={} pcm={bytes} bytes mouth={} transport={} {playback} text={}",
        audio.turn, audio.seq, audio.sr, audio.mouth, audio.transport, audio.text
    );
    trace
        .write(TraceEvent {
            ts: absolute_solver::epoch_ms(),
            dir: "body".into(),
            kind: "playback".into(),
            turn: Some(audio.turn),
            seq: Some(audio.seq),
            note: format!(
                "sr={}; pcm={bytes} bytes; pcm_ms={duration_ms}; transport={}; {}",
                audio.sr, audio.transport, playback
            ),
        })
        .await?;
    Ok(true)
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
