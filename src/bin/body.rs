use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use absolute_solver::{
    adapters::decode_wav_pcm16,
    now_ms, trace_event,
    wire::{Message, WireEnvelope},
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

async fn run_connection<S>(
    socket: &mut S,
    url: &str,
    device_id: &str,
    trace: &absolute_solver::SharedTrace,
    simulated: &mut bool,
    input_wav: Option<&Path>,
    output_wav: Option<&Path>,
    play_say: bool,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Sink<WsMessage>
        + Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let hello = Message::Hello {
        device_id: device_id.to_owned(),
        caps: serde_json::json!({"mic":true,"speaker":true,"display":"subtitle","codec":["pcm16"]}),
    };
    send(socket, &hello, trace).await?;
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
            receive_say(socket, turn, trace, output_wav, play_say),
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
                receive_say(socket, turn, trace, output_wav, play_say),
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
                    match serde_json::from_str::<Message>(&text) {
                        Ok(message) => trace.write(trace_event("hub->body", &message, "received while idle")).await?,
                        Err(error) => eprintln!("ignored invalid hub message: {error}"),
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

async fn receive_say<S>(
    socket: &mut S,
    expected_turn: u64,
    trace: &absolute_solver::SharedTrace,
    output_wav: Option<&Path>,
    play_say: bool,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(frame) = socket.next().await {
        let WsMessage::Text(text) = frame? else {
            continue;
        };
        let message: Message = serde_json::from_str(&text)?;
        if let Message::Say {
            turn,
            seq,
            pcm_b64,
            sr,
            mouth,
            text,
        } = &message
        {
            trace
                .write(trace_event(
                    "hub->body",
                    &message,
                    format!("received turn={turn} seq={seq}"),
                ))
                .await?;
            if *turn >= expected_turn {
                let pcm =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, pcm_b64)?;
                if let Some(path) = output_wav {
                    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty())
                    {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    tokio::fs::write(path, pcm16_wav(&pcm, *sr)).await?;
                    println!("saved response audio to {path:?}");
                }
                if play_say && !pcm.is_empty() {
                    if let Some(path) = output_wav {
                        play_wav(path)?;
                    }
                }
                println!(
                    "say turn={turn} seq={seq} sr={sr} pcm={} bytes mouth={} text={text}",
                    pcm.len(),
                    mouth.len(),
                );
                return Ok(());
            }
        }
    }
    Err("hub closed before say".into())
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
