//! Local microphone console: live waveform, live spectrum, one record button.
//!
//! Capture uses the same cpal/WASAPI path as the body binary, so the level and
//! spectrum shown here describe the real input a production turn would get.
//! Any capture device can be selected at runtime, because a laptop with a dead
//! built-in array still has to work with whatever input is alive.
//!
//! Env:
//!   SOLVER_MONITOR_LISTEN  default 127.0.0.1:18899
//!   SOLVER_ASR_URL         default http://127.0.0.1:19881
//!   SOLVER_HUB_HTTP        default http://127.0.0.1:18100
//!   SOLVER_HUB_URL         default ws://127.0.0.1:18100/ws
//!   SOLVER_CAPTURE_DEVICE  `default` or a device index
//!   SOLVER_RECORD_DIR      default D:\11\Logs\asr

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Receiver as StdReceiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::response::{Html, IntoResponse, Json};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

const CHUNK_MS: usize = 100;
const SPEECH_FLOOR_DBFS: f64 = -40.0;

#[derive(Clone)]
struct DeviceInfo {
    index: String,
    name: String,
    rate: u32,
    channels: usize,
    format: String,
}

struct Record {
    id: String,
    seconds: u64,
    rate: u32,
    state: &'static str,
    transcript: Option<String>,
    error: Option<String>,
    wav: Option<String>,
    stats: Option<Stats>,
}

#[derive(Clone)]
struct Stats {
    samples: usize,
    duration_ms: u64,
    rms_dbfs: f64,
    peak_dbfs: f64,
    zero_pct: f64,
    blocks_over_floor: usize,
    blocks: usize,
    verdict: String,
}

struct Chunk {
    rate: u32,
    pcm: Vec<u8>,
}

struct Pending {
    id: String,
    capacity: usize,
    rate: u32,
}

enum CaptureCmd {
    Select(String),
}

struct AppState {
    device: Arc<Mutex<DeviceInfo>>,
    capture_cmd: std::sync::mpsc::Sender<CaptureCmd>,
    records: Mutex<HashMap<String, Arc<Mutex<Record>>>>,
    pending: Mutex<Option<Pending>>,
    frames: broadcast::Sender<Arc<Chunk>>,
    asr_url: String,
    hub_http: String,
    hub_ws: String,
    record_dir: PathBuf,
    body_exe: Option<PathBuf>,
    hub_turns: Mutex<u64>,
    hub_ok: Mutex<bool>,
    asr_ok: Mutex<bool>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listen =
        std::env::var("SOLVER_MONITOR_LISTEN").unwrap_or_else(|_| "127.0.0.1:18899".into());
    let asr_url =
        std::env::var("SOLVER_ASR_URL").unwrap_or_else(|_| "http://127.0.0.1:19881".into());
    let hub_http =
        std::env::var("SOLVER_HUB_HTTP").unwrap_or_else(|_| "http://127.0.0.1:18100".into());
    let hub_ws =
        std::env::var("SOLVER_HUB_URL").unwrap_or_else(|_| "ws://127.0.0.1:18100/ws".into());
    let device_selector =
        std::env::var("SOLVER_CAPTURE_DEVICE").unwrap_or_else(|_| "default".into());
    let record_dir = std::env::var("SOLVER_RECORD_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"D:\11\Logs\asr"));
    std::fs::create_dir_all(&record_dir)?;

    let body_exe = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|dir| dir.join("absolute-solver-body.exe"))
        })
        .filter(|path| path.exists());

    let (frames_tx, _) = broadcast::channel::<Arc<Chunk>>(64);
    let (capture_tx, capture_rx) = mpsc::unbounded_channel::<(u32, Vec<i16>)>();
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<CaptureCmd>();
    let device_slot = Arc::new(Mutex::new(DeviceInfo {
        index: "<init>".into(),
        name: "<init>".into(),
        rate: 16_000,
        channels: 1,
        format: "F32".into(),
    }));
    let device = spawn_capture(&device_selector, capture_tx, cmd_rx, device_slot.clone())?;
    println!(
        "capturing [{}] {} Hz {} ch {}",
        device.name, device.rate, device.channels, device.format
    );

    let state = Arc::new(AppState {
        device: device_slot,
        capture_cmd: cmd_tx,
        records: Mutex::new(HashMap::new()),
        pending: Mutex::new(None),
        frames: frames_tx,
        asr_url,
        hub_http,
        hub_ws,
        record_dir,
        body_exe,
        hub_turns: Mutex::new(0),
        hub_ok: Mutex::new(false),
        asr_ok: Mutex::new(false),
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let capture_state = state.clone();
        tokio::spawn(async move { capture_loop(capture_rx, capture_state).await });
        let probe_state = state.clone();
        tokio::spawn(async move { health_poller(probe_state).await });

        let app = Router::new()
            .route("/", get(page))
            .route("/ws", get(ws_handler))
            .route("/info", get(info))
            .route("/devices", get(devices))
            .route("/select", post(select_device))
            .route("/record", post(start_record))
            .route("/record/:id", get(record_status))
            .route("/hub-turn", post(hub_turn))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind(&listen).await?;
        println!("console: http://{listen}/");
        axum::serve(listener, app).await?;
        Ok::<(), std::io::Error>(())
    })?;
    Ok(())
}

/// Opens one input device and starts its stream.
fn open_stream(
    selector: &str,
    tx: &mpsc::UnboundedSender<(u32, Vec<i16>)>,
) -> Result<(DeviceInfo, Stream), String> {
    let host = cpal::default_host();
    let (index, device) = match selector.trim() {
        "" | "default" => (
            "default".to_string(),
            host.default_input_device()
                .ok_or("no default microphone input device")?,
        ),
        index => {
            let position = index
                .parse::<usize>()
                .map_err(|_| format!("bad device selector {index:?}"))?;
            (
                index.to_string(),
                host.input_devices()
                    .map_err(|error| error.to_string())?
                    .nth(position)
                    .ok_or_else(|| format!("no input device at index {index}"))?,
            )
        }
    };
    let name = device.name().unwrap_or_else(|_| "<unknown>".into());
    let config = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let rate = config.sample_rate().0;
    let channels = usize::from(config.channels().max(1));
    let format = format!("{:?}", config.sample_format());
    let info = DeviceInfo {
        index,
        name,
        rate,
        channels,
        format,
    };
    let chunk_len = (rate as usize / (1000 / CHUNK_MS)).max(1);
    let sender = tx.clone();
    let stream = match config.sample_format() {
        SampleFormat::I16 => {
            build::<i16>(&device, &config.config(), channels, chunk_len, rate, sender)
        }
        SampleFormat::U16 => {
            build::<u16>(&device, &config.config(), channels, chunk_len, rate, sender)
        }
        SampleFormat::F32 => {
            build::<f32>(&device, &config.config(), channels, chunk_len, rate, sender)
        }
        SampleFormat::I32 => {
            build::<i32>(&device, &config.config(), channels, chunk_len, rate, sender)
        }
        SampleFormat::F64 => {
            build::<f64>(&device, &config.config(), channels, chunk_len, rate, sender)
        }
        other => Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|error| error.to_string())?;
    Ok((info, stream))
}

fn spawn_capture(
    initial: &str,
    tx: mpsc::UnboundedSender<(u32, Vec<i16>)>,
    cmd_rx: StdReceiver<CaptureCmd>,
    shared: Arc<Mutex<DeviceInfo>>,
) -> Result<DeviceInfo, Box<dyn std::error::Error>> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<DeviceInfo, String>>();
    let selector = initial.to_string();
    // The cpal stream is not `Send`, so every open happens on this thread and
    // the first result is reported back through `ready_tx`. Later opens publish
    // the new device through `shared` so the HTTP layer sees the switch.
    std::thread::spawn(move || {
        let mut selector = selector;
        let mut first = true;
        loop {
            match open_stream(&selector, &tx) {
                Ok((info, stream)) => {
                    if let Ok(mut guard) = shared.lock() {
                        *guard = info.clone();
                    }
                    if first {
                        let _ = ready_tx.send(Ok(info.clone()));
                        first = false;
                    } else {
                        println!(
                            "switched to [{}] {} Hz {} ch {}",
                            info.name, info.rate, info.channels, info.format
                        );
                    }
                    match cmd_rx.recv() {
                        Ok(CaptureCmd::Select(next)) => {
                            selector = next;
                            drop(stream);
                        }
                        Err(_) => return,
                    }
                }
                Err(error) => {
                    if first {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                    eprintln!("device switch failed: {error}");
                    match cmd_rx.recv() {
                        Ok(CaptureCmd::Select(next)) => selector = next,
                        Err(_) => return,
                    }
                }
            }
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(8))
        .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })
}

fn build<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    channels: usize,
    chunk_len: usize,
    rate: u32,
    tx: mpsc::UnboundedSender<(u32, Vec<i16>)>,
) -> Result<Stream, String>
where
    T: cpal::SizedSample + Copy + 'static,
    i16: cpal::FromSample<T>,
{
    let mut buffer: Vec<i16> = Vec::with_capacity(chunk_len);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                for frame in data.chunks(channels.max(1)) {
                    let sum: i32 = frame
                        .iter()
                        .map(|sample| i32::from(sample.to_sample::<i16>()))
                        .sum();
                    buffer.push(
                        (sum / frame.len() as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                    );
                }
                if buffer.len() >= chunk_len {
                    let chunk = std::mem::replace(&mut buffer, Vec::with_capacity(chunk_len * 2));
                    let _ = tx.send((rate, chunk));
                }
            },
            |error| eprintln!("microphone stream error: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

async fn capture_loop(mut frames: mpsc::UnboundedReceiver<(u32, Vec<i16>)>, state: Arc<AppState>) {
    let mut session: Option<(String, u32, Vec<i16>, usize)> = None;
    while let Some((rate, samples)) = frames.recv().await {
        let pcm: Vec<u8> = samples
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let _ = state.frames.send(Arc::new(Chunk { rate, pcm }));

        if session.is_none() {
            let pending = state.pending.lock().map(|mut guard| guard.take());
            if let Ok(Some(pending)) = pending {
                session = Some((pending.id, pending.rate, Vec::new(), pending.capacity));
            }
        }
        if let Some((id, rate, buffer, capacity)) = session.as_mut() {
            buffer.extend_from_slice(&samples);
            if buffer.len() >= *capacity {
                let id = id.clone();
                let rate = *rate;
                let captured = std::mem::take(buffer);
                session = None;
                let record = state
                    .records
                    .lock()
                    .ok()
                    .and_then(|guard| guard.get(&id).cloned());
                if let Some(record) = record {
                    tokio::spawn(finalize(state.clone(), record, captured, rate));
                }
            }
        }
    }
}

async fn health_poller(state: Arc<AppState>) {
    let client = reqwest::Client::new();
    let hub_url = format!("{}/state", state.hub_http.trim_end_matches('/'));
    let asr_url = format!("{}/healthz", state.asr_url.trim_end_matches('/'));
    loop {
        match client
            .get(&hub_url)
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(response) => {
                if let Ok(body) = response.json::<Value>().await {
                    if let Some(turn) = body.get("turn").and_then(Value::as_u64) {
                        if let Ok(mut guard) = state.hub_turns.lock() {
                            *guard = turn;
                        }
                    }
                    if let Ok(mut guard) = state.hub_ok.lock() {
                        *guard = true;
                    }
                }
            }
            Err(_) => {
                if let Ok(mut guard) = state.hub_ok.lock() {
                    *guard = false;
                }
            }
        }
        let asr_ok = matches!(
            client
                .get(&asr_url)
                .timeout(Duration::from_secs(3))
                .send()
                .await,
            Ok(response) if response.status().is_success()
        );
        if let Ok(mut guard) = state.asr_ok.lock() {
            *guard = asr_ok;
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
}

async fn finalize(state: Arc<AppState>, record: Arc<Mutex<Record>>, samples: Vec<i16>, rate: u32) {
    let stats = stats_of(&samples, rate);
    let wav = pcm16_wav(&to_pcm_bytes(&samples), rate);
    let path = state
        .record_dir
        .join(format!("record-{}.wav", timestamp_slug()));
    let wav_label = match std::fs::write(&path, &wav) {
        Ok(()) => Some(path.display().to_string()),
        Err(error) => {
            eprintln!("could not write {}: {error}", path.display());
            None
        }
    };
    if let Ok(mut guard) = record.lock() {
        guard.state = "transcribing";
        guard.stats = Some(stats);
        guard.wav = wav_label;
    }

    let client = reqwest::Client::new();
    let endpoint = format!(
        "{}/v1/audio/transcriptions",
        state.asr_url.trim_end_matches('/')
    );
    let part = match reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
    {
        Ok(part) => part,
        Err(error) => {
            if let Ok(mut guard) = record.lock() {
                guard.state = "failed";
                guard.error = Some(error.to_string());
            }
            return;
        }
    };
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-1");
    let result = client
        .post(&endpoint)
        .multipart(form)
        .timeout(Duration::from_secs(90))
        .send()
        .await;
    let outcome: Result<String, String> = match result {
        Ok(response) => {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("<body error: {error}>"));
            if status.is_success() {
                let text = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value.get("text").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_else(|| body.clone());
                Ok(text)
            } else {
                Err(format!("HTTP {status}: {body}"))
            }
        }
        Err(error) => Err(format!(
            "request failed: {error}（ASR 在服务器回环上，需要 SSH 隧道；服务器休眠时会失败）"
        )),
    };
    if let Ok(mut guard) = record.lock() {
        match outcome {
            Ok(text) => {
                guard.state = "done";
                guard.transcript = Some(text);
            }
            Err(error) => {
                guard.state = "failed";
                guard.error = Some(error);
            }
        }
    }
}

async fn page() -> Html<&'static str> {
    Html(PAGE)
}

async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let device = state.device.lock().map(|guard| guard.clone()).ok();
    Json(json!({
        "device": device.as_ref().map(|info| info.name.clone()),
        "index": device.as_ref().map(|info| info.index.clone()),
        "rate": device.as_ref().map(|info| info.rate),
        "channels": device.as_ref().map(|info| info.channels),
        "format": device.as_ref().map(|info| info.format.clone()),
        "asr_url": state.asr_url,
        "asr_ok": state.asr_ok.lock().map(|guard| *guard).unwrap_or(false),
        "record_dir": state.record_dir.display().to_string(),
        "body_exe": state.body_exe.as_ref().map(|path| path.display().to_string()),
        "hub_http": state.hub_http,
        "hub_ok": state.hub_ok.lock().map(|guard| *guard).unwrap_or(false),
        "hub_turn": state.hub_turns.lock().map(|guard| *guard).unwrap_or(0),
    }))
}

async fn devices() -> Json<Value> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let mut list = Vec::new();
    if let Ok(iter) = host.input_devices() {
        for (index, device) in iter.enumerate() {
            let name = device.name().unwrap_or_else(|_| "<unknown>".into());
            let config = device
                .default_input_config()
                .map(|config| {
                    json!({
                        "rate": config.sample_rate().0,
                        "channels": config.channels(),
                        "format": format!("{:?}", config.sample_format()),
                    })
                })
                .unwrap_or(Value::Null);
            list.push(json!({
                "index": index.to_string(),
                "name": name,
                "default": default_name.as_deref() == Some(name.as_str()),
                "config": config,
            }));
        }
    }
    Json(json!({ "devices": list }))
}

async fn select_device(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let selector = params
        .get("device")
        .cloned()
        .unwrap_or_else(|| "default".into());
    if state
        .capture_cmd
        .send(CaptureCmd::Select(selector.clone()))
        .is_err()
    {
        return Json(json!({"ok": false, "error": "capture controller stopped"}));
    }
    // Give the controller a moment, then report what actually opened.
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(device) = state.device.lock() {
            let resolved = if selector == "default" {
                "default"
            } else {
                selector.as_str()
            };
            if device.index == resolved {
                return Json(json!({"ok": true, "device": device.name, "rate": device.rate}));
            }
        }
    }
    Json(json!({"ok": true, "pending": selector}))
}

async fn start_record(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let seconds = params
        .get("seconds")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(6)
        .clamp(1, 30);
    let rate = state
        .device
        .lock()
        .map(|guard| guard.rate)
        .unwrap_or(16_000);
    let id = format!("rec-{}", timestamp_slug());
    let record = Arc::new(Mutex::new(Record {
        id: id.clone(),
        seconds,
        rate,
        state: "recording",
        transcript: None,
        error: None,
        wav: None,
        stats: None,
    }));
    if let Ok(mut guard) = state.records.lock() {
        guard.insert(id.clone(), record);
    }
    let capacity = rate as usize * seconds as usize;
    match state.pending.lock() {
        Ok(mut guard) => {
            *guard = Some(Pending {
                id: id.clone(),
                capacity,
                rate,
            })
        }
        Err(_) => return Json(json!({"error": "state lock failed"})),
    }
    Json(json!({"id": id, "seconds": seconds, "rate": rate}))
}

async fn record_status(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Json<Value> {
    let record = state
        .records
        .lock()
        .ok()
        .and_then(|guard| guard.get(&id).cloned());
    let Some(record) = record else {
        return Json(json!({"error": "unknown record", "id": id}));
    };
    let guard = match record.lock() {
        Ok(guard) => guard,
        Err(_) => return Json(json!({"error": "record lock poisoned"})),
    };
    let stats = guard.stats.as_ref().map(|stats| {
        json!({
            "samples": stats.samples,
            "duration_ms": stats.duration_ms,
            "rms_dbfs": round1(stats.rms_dbfs),
            "peak_dbfs": round1(stats.peak_dbfs),
            "zero_pct": round1(stats.zero_pct),
            "blocks_over_floor": stats.blocks_over_floor,
            "blocks": stats.blocks,
            "verdict": stats.verdict,
        })
    });
    Json(json!({
        "id": guard.id,
        "seconds": guard.seconds,
        "rate": guard.rate,
        "state": guard.state,
        "transcript": guard.transcript,
        "error": guard.error,
        "wav": guard.wav,
        "stats": stats,
    }))
}

async fn hub_turn(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let Some(body_exe) = state.body_exe.clone() else {
        return Json(
            json!({"ok": false, "error": "absolute-solver-body.exe not found next to this binary"}),
        );
    };
    let seconds = params
        .get("seconds")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(6)
        .clamp(1, 30);
    let device = params
        .get("device")
        .cloned()
        .unwrap_or_else(|| "default".into());
    let trace_path = state
        .record_dir
        .join(format!("body-button-{}.jsonl", timestamp_slug()));
    let child = std::process::Command::new(&body_exe)
        .env("SOLVER_HUB_URL", &state.hub_ws)
        .env("SOLVER_DEVICE_ID", "body-mic-button")
        .env("SOLVER_CAPTURE_SECONDS", seconds.to_string())
        .env("SOLVER_CAPTURE_DEVICE", &device)
        .env("SOLVER_TRACE", &trace_path)
        .spawn();
    match child {
        Ok(child) => Json(json!({
            "ok": true,
            "pid": child.id(),
            "seconds": seconds,
            "device": device,
            "trace": trace_path.display().to_string(),
            "turn_before": state.hub_turns.lock().map(|guard| *guard).unwrap_or(0),
        })),
        Err(error) => Json(json!({"ok": false, "error": error.to_string()})),
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_loop(socket, state))
}

async fn ws_loop(mut socket: WebSocket, state: Arc<AppState>) {
    let mut receiver = state.frames.subscribe();
    let device = state.device.lock().map(|guard| guard.clone()).ok();
    let hello = json!({
        "type": "hello",
        "rate": device.as_ref().map(|info| info.rate).unwrap_or(16_000),
        "device": device.as_ref().map(|info| info.name.clone()).unwrap_or_default(),
    });
    if socket
        .send(WsMessage::Text(hello.to_string()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            chunk = receiver.recv() => match chunk {
                Ok(chunk) => {
                    let payload = json!({
                        "type": "pcm",
                        "rate": chunk.rate,
                        "pcm": base64::engine::general_purpose::STANDARD.encode(&chunk.pcm),
                    });
                    if socket.send(WsMessage::Text(payload.to_string())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            },
            inbound = socket.recv() => match inbound {
                Some(Ok(WsMessage::Close(_))) | None => return,
                Some(Ok(_)) => {}
                Some(Err(_)) => return,
            },
        }
    }
}

fn to_pcm_bytes(samples: &[i16]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn rms_dbfs(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return f64::NEG_INFINITY;
    }
    let sum: f64 = samples
        .iter()
        .map(|value| {
            let normalized = f64::from(*value) / 32_768.0;
            normalized * normalized
        })
        .sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

fn peak_dbfs(samples: &[i16]) -> f64 {
    let peak = samples
        .iter()
        .map(|value| i32::from(*value).unsigned_abs())
        .max()
        .unwrap_or(0);
    if peak == 0 {
        f64::NEG_INFINITY
    } else {
        20.0 * (f64::from(peak) / 32_768.0).log10()
    }
}

fn stats_of(samples: &[i16], rate: u32) -> Stats {
    let zeros = samples.iter().filter(|value| **value == 0).count();
    let peak = peak_dbfs(samples);
    let rms = rms_dbfs(samples);
    let window = (rate as usize / 10).max(1);
    let mut blocks = 0;
    let mut blocks_over = 0;
    for chunk in samples.chunks(window) {
        blocks += 1;
        if rms_dbfs(chunk) > SPEECH_FLOOR_DBFS {
            blocks_over += 1;
        }
    }
    let verdict = if zeros == samples.len() {
        "数字静音：设备在送帧，但每个采样都是 0（检查系统静音键、隐私开关或该虚拟设备本体）"
            .to_string()
    } else if blocks_over == 0 {
        format!("没有语音块：{blocks} 个 100 ms 块没有一块超过 -40 dBFS（ASR 只会瞎猜）")
    } else if peak < -30.0 {
        format!("偏小：峰值 {peak:.1} dBFS，只有 {blocks_over}/{blocks} 块过线")
    } else if peak > -1.0 {
        "过载：峰值接近满量程，可能削波".to_string()
    } else {
        format!("可用：峰值 {peak:.1} dBFS，{blocks_over}/{blocks} 块过线")
    };
    Stats {
        samples: samples.len(),
        duration_ms: samples.len() as u64 * 1_000 / u64::from(rate.max(1)),
        rms_dbfs: rms,
        peak_dbfs: peak,
        zero_pct: 100.0 * zeros as f64 / samples.len().max(1) as f64,
        blocks_over_floor: blocks_over,
        blocks,
        verdict,
    }
}

fn round1(value: f64) -> f64 {
    if value.is_finite() {
        (value * 10.0).round() / 10.0
    } else {
        -999.0
    }
}

fn timestamp_slug() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{millis}")
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

const PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Absolute Solver / 录音台</title>
<style>
:root{color-scheme:dark;--ink:#040812;--panel:#081326;--panel2:#0b1b30;--line:#17476f;--text:#dcecff;--muted:#7394b5;--ok:#55e0b0;--cyan:#5bc8ff;--warn:#f2c35b;--bad:#ff6c7d}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--text);font:13px/1.5 "Cascadia Mono","Consolas",monospace}
main{max-width:1080px;margin:0 auto;padding:18px}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid var(--line);padding-bottom:10px;margin-bottom:14px;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:22px;letter-spacing:2px;color:var(--cyan)}
.sub{color:var(--muted);font-size:12px;margin-top:4px}
.badge{border:1px solid var(--line);background:var(--panel2);padding:3px 8px;border-radius:3px;color:var(--muted)}
.badge.on{color:var(--ok);border-color:var(--ok)}
.badge.off{color:var(--bad);border-color:var(--bad)}
.panel{border:2px solid var(--line);background:var(--panel);padding:12px;margin-bottom:12px}
.panel h2{margin:0 0 8px;font-size:12px;letter-spacing:1px;color:var(--muted);font-weight:600}
canvas{display:block;width:100%;background:#02060f;border:1px solid var(--line)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{font:inherit;color:var(--text);background:var(--panel2);border:2px solid var(--line);border-radius:3px;padding:9px 14px;cursor:pointer}
button:hover{border-color:var(--cyan)}
button:disabled{opacity:.45;cursor:not-allowed}
#rec{background:#2a0d16;border-color:var(--bad);font-size:15px;padding:12px 22px}
#rec.live{background:var(--bad);color:#1a0308;animation:pulse 1s infinite}
@keyframes pulse{50%{filter:brightness(1.35)}}
select{font:inherit;color:var(--text);background:var(--panel2);border:2px solid var(--line);border-radius:3px;padding:8px;max-width:420px}
.meter{height:16px;background:#02060f;border:1px solid var(--line);position:relative;overflow:hidden}
.meter i{position:absolute;inset:0 100% 0 0;background:linear-gradient(90deg,var(--ok),var(--warn) 72%,var(--bad));transition:right .06s linear}
.meter b{position:absolute;left:66.7%;top:0;bottom:0;width:2px;background:var(--bad);opacity:.8}
.readout{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
.readout span b{color:var(--text);font-weight:600}
#transcript{min-height:52px;font-size:16px;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.good{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
</style></head>
<body><main>
<header>
  <div><h1>绝对解答 · 录音台</h1><div class="sub" id="dev">连接中…</div></div>
  <div class="row">
    <span class="badge" id="asr">ASR</span>
    <span class="badge" id="hub">Hub</span>
    <span class="badge" id="link">麦克风</span>
  </div>
</header>

<section class="panel">
  <div class="row">
    <span style="color:var(--muted)">输入设备</span>
    <select id="device"></select>
  </div>
</section>

<section class="panel">
  <h2>实时波形 / 2 秒窗口</h2>
  <canvas id="wave" width="1000" height="90"></canvas>
  <div class="meter" style="margin-top:10px"><i id="bar"></i><b title="-40 dBFS"></b></div>
  <div class="readout">
    <span>RMS <b id="rms">-</b></span>
    <span>峰值 <b id="peak">-</b></span>
    <span>红标 = -40 dBFS（语音下限参考）</span>
  </div>
</section>

<section class="panel">
  <h2>实时频谱 / 80 Hz – 8 kHz（红线 -40 dB）</h2>
  <canvas id="spec" width="1000" height="150"></canvas>
</section>

<section class="panel">
  <h2>录音</h2>
  <div class="row">
    <button id="rec">● 录音并识别</button>
    <select id="dur" style="max-width:120px">
      <option value="3">3 秒</option>
      <option value="6" selected>6 秒</option>
      <option value="10">10 秒</option>
      <option value="15">15 秒</option>
    </select>
    <button id="hubbtn">走完整链路 → Hub</button>
    <span id="status" class="badge">待命</span>
  </div>
  <div style="margin-top:14px"><h2>识别结果</h2><div id="transcript">—</div></div>
  <div class="readout" id="stats"></div>
</section>
</main>
<script>
const $ = id => document.getElementById(id);
const wave = $('wave').getContext('2d'), spec = $('spec').getContext('2d');
let rate = 16000, ring = new Float32Array(32000), ringLen = 0, ready = false;
const fftSize = 1024, hann = new Float32Array(fftSize);
for (let i = 0; i < fftSize; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));

function resetRate(newRate) {
  if (newRate === rate && ringLen === 0) return;
  rate = newRate; ring = new Float32Array(rate * 2); ringLen = 0;
}

function b64ToInt16(b64) {
  const bin = atob(b64), buf = new Int16Array(bin.length >> 1);
  for (let i = 0, j = 0; i < bin.length; i += 2, j++) {
    const v = (bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8)) & 0xffff;
    buf[j] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return buf;
}

function push(samples) {
  for (let i = 0; i < samples.length; i++) {
    ring[ringLen % ring.length] = samples[i] / 32768;
    ringLen++;
  }
}

function dbfs(v) { return v <= 0 ? -120 : 20 * Math.log10(v); }

function drawWave() {
  const w = wave.canvas.width, h = wave.canvas.height;
  wave.fillStyle = '#02060f'; wave.fillRect(0, 0, w, h);
  wave.strokeStyle = '#17476f'; wave.lineWidth = 1;
  wave.beginPath(); wave.moveTo(0, h / 2); wave.lineTo(w, h / 2); wave.stroke();
  const count = Math.min(ringLen, ring.length), start = ringLen - count;
  wave.strokeStyle = '#5bc8ff'; wave.lineWidth = 1.4; wave.beginPath();
  for (let x = 0; x < w; x++) {
    const from = start + Math.floor(count * x / w), to = start + Math.floor(count * (x + 1) / w);
    if (to <= from) continue;
    let lo = 1, hi = -1;
    for (let i = from; i < to; i++) { const v = ring[i % ring.length]; if (v < lo) lo = v; if (v > hi) hi = v; }
    wave.moveTo(x, h / 2 - hi * h * 0.46); wave.lineTo(x, h / 2 - lo * h * 0.46);
  }
  wave.stroke();
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const spectrum = new Float32Array(256);
let fmax = 8000;
function computeSpectrum() {
  if (ringLen < fftSize) return;
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  const start = ringLen - fftSize;
  for (let i = 0; i < fftSize; i++) re[i] = ring[(start + i) % ring.length] * hann[i];
  fft(re, im);
  const bins = fftSize / 2, nyquist = rate / 2, lo = 80;
  fmax = Math.min(8000, nyquist);
  for (let p = 0; p < spectrum.length; p++) {
    const f0 = lo * Math.pow(fmax / lo, p / spectrum.length);
    const f1 = lo * Math.pow(fmax / lo, (p + 1) / spectrum.length);
    const b0 = Math.max(0, Math.floor(f0 / nyquist * bins));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / nyquist * bins));
    let peak = 0;
    for (let b = b0; b < b1 && b < bins; b++) peak = Math.max(peak, Math.hypot(re[b], im[b]));
    spectrum[p] = 0.72 * spectrum[p] + 0.28 * peak / (fftSize / 4);
  }
}

function drawSpec() {
  const w = spec.canvas.width, h = spec.canvas.height;
  spec.fillStyle = '#02060f'; spec.fillRect(0, 0, w, h);
  const bars = spectrum.length, bw = w / bars;
  for (let p = 0; p < bars; p++) {
    const db = dbfs(spectrum[p]);
    const norm = Math.max(0, Math.min(1, (db + 95) / 85));
    const height = norm * h;
    spec.fillStyle = 'hsl(' + (180 - norm * 160) + ',85%,' + (32 + norm * 26) + '%)';
    spec.fillRect(p * bw, h - height, Math.max(1, bw - 1), height);
  }
  spec.strokeStyle = 'rgba(255,108,125,.7)'; spec.setLineDash([4, 4]);
  const y = h - Math.max(0, Math.min(1, (-40 + 95) / 85)) * h;
  spec.beginPath(); spec.moveTo(0, y); spec.lineTo(w, y); spec.stroke(); spec.setLineDash([]);
  spec.fillStyle = '#7394b5'; spec.font = '10px monospace';
  [100, 300, 1000, 3000, 8000].forEach(f => {
    if (f > fmax) return;
    const x = Math.log(f / 80) / Math.log(fmax / 80) * w;
    spec.fillText(f >= 1000 ? (f / 1000) + 'k' : f, Math.min(w - 22, x + 2), 12);
  });
}

let tick = 0;
function loop() {
  if (ready) {
    drawWave();
    if (++tick % 3 === 0) computeSpectrum();
    drawSpec();
    const count = Math.min(ringLen, Math.floor(rate * 0.2));
    let sum = 0, peak = 0;
    for (let i = 0; i < count; i++) {
      const v = ring[(ringLen - count + i) % ring.length];
      sum += v * v; const a = Math.abs(v); if (a > peak) peak = a;
    }
    const rms = count ? Math.sqrt(sum / count) : 0;
    $('rms').textContent = dbfs(rms) <= -120 ? '静音' : dbfs(rms).toFixed(1) + ' dBFS';
    const pd = dbfs(peak), pk = $('peak');
    pk.textContent = pd <= -120 ? '静音' : pd.toFixed(1) + ' dBFS';
    pk.className = pd > -30 ? 'good' : pd > -40 ? 'warn' : 'bad';
    $('bar').style.right = Math.max(0, 100 - Math.max(0, Math.min(100, (dbfs(rms) + 60) / 60 * 100))) + '%';
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

let ws = null;
function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => { $('link').textContent = '麦克风 在线'; $('link').className = 'badge on'; };
  ws.onclose = () => {
    $('link').textContent = '麦克风 断开'; $('link').className = 'badge off';
    ready = false; setTimeout(connect, 1500);
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') {
      resetRate(msg.rate);
      ready = true;
      $('dev').textContent = msg.device + ' · ' + msg.rate + ' Hz';
      return;
    }
    if (msg.type === 'pcm') {
      if (msg.rate !== rate) resetRate(msg.rate);
      push(b64ToInt16(msg.pcm));
    }
  };
}
connect();

async function loadDevices() {
  const data = await (await fetch('/devices')).json();
  const select = $('device');
  const info = await (await fetch('/info')).json();
  select.innerHTML = '';
  data.devices.forEach(d => {
    const option = document.createElement('option');
    option.value = d.index;
    option.textContent = (d.default ? '★ ' : '') + '[' + d.index + '] ' + d.name +
      (d.config ? ' · ' + d.config.rate + 'Hz ' + d.config.channels + 'ch' : '');
    if (String(d.index) === String(info.index) || (info.index === 'default' && d.default)) option.selected = true;
    select.appendChild(option);
  });
  select.onchange = async () => {
    $('status').textContent = '切换设备…';
    const result = await (await fetch('/select?device=' + encodeURIComponent(select.value), { method: 'POST' })).json();
    $('status').textContent = result.ok ? '设备已切换：' + (result.device || select.value) : '切换失败';
    setTimeout(connect, 300);
  };
}

async function refreshInfo() {
  try {
    const info = await (await fetch('/info')).json();
    const hub = $('hub'), asr = $('asr');
    hub.textContent = info.hub_ok ? 'Hub 在线 · turn ' + info.hub_turn : 'Hub 不可达';
    hub.className = 'badge ' + (info.hub_ok ? 'on' : 'off');
    asr.textContent = info.asr_ok ? 'ASR 在线' : 'ASR 不可达';
    asr.className = 'badge ' + (info.asr_ok ? 'on' : 'off');
  } catch (e) {}
}
loadDevices(); refreshInfo(); setInterval(refreshInfo, 4000);

let polling = null;
$('rec').onclick = async () => {
  const seconds = Number($('dur').value);
  const button = $('rec');
  button.disabled = true;
  $('transcript').textContent = '录音中…';
  $('stats').textContent = '';
  const { id } = await (await fetch('/record?seconds=' + seconds, { method: 'POST' })).json();
  let left = seconds;
  button.classList.add('live');
  $('status').textContent = '录音 ' + left + 's';
  const countdown = setInterval(() => {
    left--;
    $('status').textContent = left > 0 ? '录音 ' + left + 's' : '识别中…';
  }, 1000);
  clearInterval(polling);
  polling = setInterval(async () => {
    const r = await (await fetch('/record/' + id)).json();
    if (r.state === 'recording') return;
    clearInterval(countdown); clearInterval(polling);
    button.classList.remove('live'); button.disabled = false;
    $('status').textContent = r.state === 'done' ? '完成' : '失败';
    $('transcript').textContent = r.transcript || r.error || '（无结果）';
    if (r.stats) {
      const s = r.stats;
      const cls = s.blocks_over_floor === 0 ? 'bad' : s.peak_dbfs > -30 ? 'good' : 'warn';
      $('stats').innerHTML = '<span>RMS <b>' + s.rms_dbfs + ' dBFS</b></span><span>峰值 <b>' +
        s.peak_dbfs + ' dBFS</b></span><span>过线块 <b>' + s.blocks_over_floor + '/' + s.blocks +
        '</b></span><span>零采样 <b>' + s.zero_pct + '%</b></span><span class="' + cls + '">' +
        s.verdict + '</span><span>' + (r.wav || '') + '</span>';
    }
  }, 400);
};

$('hubbtn').onclick = async () => {
  const seconds = Number($('dur').value);
  const device = $('device').value;
  $('status').textContent = '完整链路启动中…';
  const r = await (await fetch('/hub-turn?seconds=' + seconds + '&device=' + encodeURIComponent(device), { method: 'POST' })).json();
  $('status').textContent = r.ok ? 'Body 已启动（pid ' + r.pid + '），说 ' + r.seconds + ' 秒' : ('失败：' + r.error);
};
</script></body></html>
"#;
