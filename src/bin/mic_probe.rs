//! Microphone diagnostic probe.
//!
//! Enumerates capture devices, measures per-window signal level, and can push
//! one capture straight to the ASR provider. Exists because the live-microphone
//! acceptance turn transcribed only "嗯" twice and the cause has never been
//! isolated to either the device path or the ASR path.
//!
//! Usage:
//!   absolute-solver-mic-probe list
//!   absolute-solver-mic-probe capture [--seconds N] [--device default|INDEX]
//!                                       [--asr URL] [--wav PATH]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

type Buffer = Arc<Mutex<Vec<i16>>>;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("list");
    match mode {
        "list" => list_devices(&cpal::default_host()),
        "capture" => capture(&args[1..]).await,
        other => Err(format!("unknown mode {other:?}; use list or capture").into()),
    }
}

fn list_devices(host: &cpal::Host) -> Result<(), Box<dyn std::error::Error>> {
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    println!("host: {:?}", host.id());
    println!("default input device: {default_name:?}");
    let devices: Vec<cpal::Device> = host.input_devices()?.collect();
    println!("input devices: {}", devices.len());
    for (index, device) in devices.iter().enumerate() {
        let name = device.name().unwrap_or_else(|error| format!("<{error}>"));
        let is_default = default_name.as_deref() == Some(name.as_str());
        println!(
            "[{index}]{marker} {name}",
            marker = if is_default { " (default)" } else { "" }
        );
        match device.default_input_config() {
            Ok(config) => println!(
                "      default config: {} Hz, {} ch, {:?}",
                config.sample_rate().0,
                config.channels(),
                config.sample_format()
            ),
            Err(error) => println!("      default config: ERROR {error}"),
        }
        match device.supported_input_configs() {
            Ok(ranges) => {
                let mut shown = 0;
                for range in ranges {
                    if shown >= 4 {
                        println!("      ...");
                        break;
                    }
                    println!(
                        "      supported: {:?} {:?}..={:?} Hz, {} ch",
                        range.sample_format(),
                        range.min_sample_rate().0,
                        range.max_sample_rate().0,
                        range.channels()
                    );
                    shown += 1;
                }
            }
            Err(error) => println!("      supported configs: ERROR {error}"),
        }
    }
    Ok(())
}

async fn capture(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let seconds = flag(args, "--seconds")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5);
    let device_arg = flag(args, "--device").unwrap_or_else(|| "default".into());
    let asr = flag(args, "--asr");
    let wav_path = flag(args, "--wav").map(PathBuf::from);

    let joined =
        tokio::task::spawn_blocking(move || record(&device_arg, seconds, &wav_path)).await?;
    let (sample_rate, pcm) = joined.map_err(|error| -> Box<dyn std::error::Error> { error })?;

    if let Some(url) = asr {
        submit_asr(&url, &pcm, sample_rate).await?;
    }
    Ok(())
}

fn record(
    device_arg: &str,
    seconds: u64,
    wav_path: &Option<PathBuf>,
) -> Result<(u32, Vec<u8>), Box<dyn std::error::Error + Send + Sync>> {
    let host = cpal::default_host();
    let device = match device_arg {
        "default" => host
            .default_input_device()
            .ok_or("no default microphone input device")?,
        index => host
            .input_devices()?
            .nth(
                index
                    .parse::<usize>()
                    .map_err(|_| format!("bad device {index:?}"))?,
            )
            .ok_or_else(|| format!("no input device at index {index}"))?,
    };
    let device_name = device.name().unwrap_or_else(|_| "<unknown>".into());
    let config = device.default_input_config()?;
    let sample_rate = config.sample_rate().0;
    let channels = usize::from(config.channels().max(1));
    let format = config.sample_format();
    println!("capturing {seconds}s from [{device_name}] {sample_rate} Hz {channels} ch {format:?}");

    let buffer: Buffer = Arc::new(Mutex::new(Vec::new()));
    let stream = build_stream(&device, &config.config(), channels, format, buffer.clone())?;
    stream.play()?;

    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream);
    std::thread::sleep(Duration::from_millis(120));

    let samples = buffer
        .lock()
        .map_err(|_| "capture buffer poisoned")?
        .clone();
    if samples.is_empty() {
        return Err("device delivered no samples (stream never called back)".into());
    }
    summarize(&samples, sample_rate, seconds);
    let pcm: Vec<u8> = samples
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();

    if let Some(path) = wav_path {
        std::fs::write(path, pcm16_wav(&pcm, sample_rate))?;
        println!("wrote {} bytes to {}", pcm.len() + 44, path.display());
    }
    Ok((sample_rate, pcm))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|position| args.get(position + 1))
        .cloned()
}

fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    format: SampleFormat,
    buffer: Buffer,
) -> Result<cpal::Stream, Box<dyn std::error::Error + Send + Sync>> {
    match format {
        SampleFormat::I16 => spawn::<i16>(device, config, channels, buffer),
        SampleFormat::U16 => spawn::<u16>(device, config, channels, buffer),
        SampleFormat::F32 => spawn::<f32>(device, config, channels, buffer),
        SampleFormat::I32 => spawn::<i32>(device, config, channels, buffer),
        SampleFormat::F64 => spawn::<f64>(device, config, channels, buffer),
        other => Err(format!("unsupported sample format {other:?}").into()),
    }
}

fn spawn<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    buffer: Buffer,
) -> Result<cpal::Stream, Box<dyn std::error::Error + Send + Sync>>
where
    T: cpal::SizedSample + Copy + 'static,
    i16: cpal::FromSample<T>,
{
    let rate = config.sample_rate.0 as usize;
    let window = (rate / 5).max(1);
    let mut window_samples: Vec<i16> = Vec::with_capacity(window);
    let mut elapsed = 0_usize;
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _| {
            let mut mono: Vec<i16> = Vec::with_capacity(data.len() / channels.max(1));
            for frame in data.chunks(channels.max(1)) {
                let sum: i32 = frame
                    .iter()
                    .map(|sample| i32::from(sample.to_sample::<i16>()))
                    .sum();
                mono.push(
                    (sum / frame.len() as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                );
            }
            if let Ok(mut guard) = buffer.lock() {
                guard.extend_from_slice(&mono);
            }
            window_samples.extend_from_slice(&mono);
            if window_samples.len() >= window {
                let rms = rms_dbfs(&window_samples);
                let peak = peak_dbfs(&window_samples);
                elapsed += window_samples.len();
                eprintln!(
                    "[{:>5.2}s] rms {:>7.1} dBFS  peak {:>7.1} dBFS  {}",
                    elapsed as f64 / rate as f64,
                    rms,
                    peak,
                    bar(rms)
                );
                window_samples.clear();
            }
        },
        |error| eprintln!("stream error: {error}"),
        None,
    )?;
    Ok(stream)
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

fn bar(dbfs: f64) -> String {
    if !dbfs.is_finite() {
        return "silence".into();
    }
    let filled = ((dbfs + 60.0) / 2.5).clamp(0.0, 24.0).round() as usize;
    format!("{}{}", "#".repeat(filled), "-".repeat(24 - filled))
}

fn summarize(samples: &[i16], sample_rate: u32, requested_seconds: u64) {
    let zeros = samples.iter().filter(|value| **value == 0).count();
    let nonzero = samples.len() - zeros;
    let duration = samples.len() as f64 / f64::from(sample_rate);
    let window = (sample_rate as usize / 5).max(1);
    let mut active = 0_usize;
    let mut windows = 0_usize;
    for chunk in samples.chunks(window) {
        windows += 1;
        if rms_dbfs(chunk) > -40.0 {
            active += 1;
        }
    }
    println!("--- summary ---");
    println!(
        "samples: {} mono, {:.2}s of requested {requested_seconds}s at {sample_rate} Hz",
        samples.len(),
        duration
    );
    println!(
        "nonzero: {nonzero} ({:.3}%)  exact-zero: {:.3}%",
        100.0 * nonzero as f64 / samples.len().max(1) as f64,
        100.0 * zeros as f64 / samples.len().max(1) as f64
    );
    println!(
        "rms: {:.1} dBFS  peak: {:.1} dBFS",
        rms_dbfs(samples),
        peak_dbfs(samples)
    );
    println!("windows above -40 dBFS: {active}/{windows}");
    if zeros == samples.len() {
        println!("VERDICT: digital silence — the device streams frames but every sample is 0");
    } else if peak_dbfs(samples) < -50.0 {
        println!("VERDICT: near silence — signal present but far too quiet for speech");
    } else if active > 0 {
        println!("VERDICT: signal present — device path can carry speech");
    } else {
        println!("VERDICT: only noise floor — no speech-shaped activity in this window");
    }
}

async fn submit_asr(
    url: &str,
    pcm: &[u8],
    sample_rate: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    use reqwest::multipart;
    let wav = pcm16_wav(pcm, sample_rate);
    let part = multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;
    let form = multipart::Form::new().part("file", part);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let endpoint = format!("{}/v1/audio/transcriptions", url.trim_end_matches('/'));
    println!("--- asr ---");
    println!("POST {endpoint}");
    let response = client.post(&endpoint).multipart(form).send().await?;
    let status = response.status();
    let body = response.text().await?;
    println!("status: {status}");
    println!("body: {body}");
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
