use std::{env, sync::Arc, time::Instant};

use reqwest::{multipart, Client, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct AdapterConfig {
    pub asr_url: String,
    pub asr_timeout_seconds: u64,
    pub tts_url: String,
    pub llm_url: String,
    pub llm_model: String,
    pub llm_api_key: String,
    pub llm_disable_thinking: bool,
    pub llm_max_tokens: u32,
    pub llm_max_total_tokens: u64,
    pub llm_max_requests: u32,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_api_key: String,
    pub tts_timeout_seconds: u64,
}

impl Default for AdapterConfig {
    fn default() -> Self {
        let llm_api_key = env::var("SOLVER_LLM_API_KEY").unwrap_or_default();
        let has_remote_llm = !llm_api_key.trim().is_empty();
        Self {
            asr_url: env::var("SOLVER_ASR_URL").unwrap_or_else(|_| "http://127.0.0.1:9881".into()),
            asr_timeout_seconds: env::var("SOLVER_ASR_TIMEOUT_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(15)
                .clamp(5, 120),
            tts_url: env::var("SOLVER_TTS_URL").unwrap_or_else(|_| "http://127.0.0.1:18080".into()),
            llm_url: env::var("SOLVER_LLM_URL").unwrap_or_else(|_| {
                if has_remote_llm {
                    "https://api.deepseek.com".into()
                } else {
                    String::new()
                }
            }),
            llm_model: env::var("SOLVER_LLM_MODEL").unwrap_or_else(|_| {
                if has_remote_llm {
                    "deepseek-flash".into()
                } else {
                    "Qwen3-4B-Q4_K_M.gguf".into()
                }
            }),
            llm_api_key,
            llm_disable_thinking: env::var("SOLVER_LLM_DISABLE_THINKING")
                .ok()
                .map(|value| {
                    matches!(
                        value.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
                .unwrap_or(false),
            llm_max_tokens: env::var("SOLVER_LLM_MAX_TOKENS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(256)
                .clamp(1, 512),
            llm_max_total_tokens: env::var("SOLVER_LLM_MAX_TOTAL_TOKENS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(8_192)
                .max(1),
            llm_max_requests: env::var("SOLVER_LLM_MAX_REQUESTS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(32)
                .max(1),
            tts_model: env::var("SOLVER_TTS_MODEL").unwrap_or_else(|_| "tts-1".into()),
            tts_voice: env::var("SOLVER_TTS_VOICE").unwrap_or_else(|_| "xxx_trained".into()),
            tts_api_key: env::var("SOLVER_TTS_API_KEY").unwrap_or_default(),
            tts_timeout_seconds: env::var("SOLVER_TTS_TIMEOUT_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(45)
                .clamp(5, 300),
        }
    }
}

#[derive(Clone)]
pub struct ModelAdapters {
    config: AdapterConfig,
    client: Client,
    llm_budget: Arc<Mutex<LlmBudgetState>>,
}

#[derive(Debug, Default)]
struct LlmBudgetState {
    tokens: u64,
    requests: u32,
    blocked: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdapterStatus {
    pub name: &'static str,
    pub base_url: String,
    pub configured: bool,
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: Option<u128>,
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("{0} adapter is not configured")]
    NotConfigured(&'static str),
    #[error("llm budget exhausted: {0}")]
    BudgetExceeded(String),
    #[error("{0} request failed: {1}")]
    Request(&'static str, String),
    #[error("{0} returned HTTP {1}: {2}")]
    Http(&'static str, StatusCode, String),
    #[error("{0} returned invalid JSON: {1}")]
    Json(&'static str, String),
    #[error("{0} returned invalid audio: {1}")]
    Audio(&'static str, String),
}

#[derive(Debug, Deserialize)]
struct AsrResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct LlmCompletion {
    pub text: String,
    pub usage: Option<ChatUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: String,
}

impl ModelAdapters {
    pub fn new(config: AdapterConfig) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            config,
            client,
            llm_budget: Arc::new(Mutex::new(LlmBudgetState::default())),
        })
    }

    pub fn config(&self) -> &AdapterConfig {
        &self.config
    }

    pub async fn llm_budget_snapshot(&self) -> (u64, u64, u32, u32, u32) {
        let state = self.llm_budget.lock().await;
        (
            state.tokens,
            self.config.llm_max_total_tokens,
            state.requests,
            self.config.llm_max_requests,
            state.blocked,
        )
    }

    pub async fn statuses(&self) -> Vec<AdapterStatus> {
        let (asr, tts, llm) = tokio::join!(
            self.probe_any(
                "asr",
                &self.config.asr_url,
                &["/v1/models", "/v1/audio/transcriptions"],
            ),
            self.probe_any("tts", &self.config.tts_url, &["/healthz", "/v1/models"]),
            self.probe_any("llm", &self.config.llm_url, &["/health", "/v1/models"]),
        );
        vec![asr, tts, llm]
    }

    async fn probe_any(&self, name: &'static str, base_url: &str, paths: &[&str]) -> AdapterStatus {
        let base_url = base_url.trim_end_matches('/').to_owned();
        if base_url.is_empty() {
            return AdapterStatus {
                name,
                base_url,
                configured: false,
                ok: false,
                status: None,
                latency_ms: None,
                error: Some("empty base URL".into()),
            };
        }
        let started = Instant::now();
        let mut last_error = None;
        let mut last_status = None;
        for path in paths {
            match self
                .client
                .get(format!("{base_url}{path}"))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    last_status = Some(status.as_u16());
                    if status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED {
                        let body = response.bytes().await.ok();
                        let upstream_alive = body
                            .as_deref()
                            .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
                            .and_then(|body| {
                                body.get("upstream_alive").and_then(|value| value.as_bool())
                            });
                        let reports_unhealthy = body
                            .as_deref()
                            .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
                            .and_then(|body| body.get("ok").and_then(|value| value.as_bool()))
                            == Some(false);
                        if upstream_alive == Some(false) || reports_unhealthy {
                            return AdapterStatus {
                                name,
                                base_url,
                                configured: true,
                                ok: false,
                                status: Some(status.as_u16()),
                                latency_ms: Some(started.elapsed().as_millis()),
                                error: Some("gateway is up; TTS upstream is unavailable".into()),
                            };
                        }
                        return AdapterStatus {
                            name,
                            base_url,
                            configured: true,
                            ok: true,
                            status: Some(status.as_u16()),
                            latency_ms: Some(started.elapsed().as_millis()),
                            error: None,
                        };
                    }
                    last_error = Some(format!("HTTP {status} at {path}"));
                }
                Err(error) => last_error = Some(error.to_string()),
            }
        }
        AdapterStatus {
            name,
            base_url,
            configured: true,
            ok: false,
            status: last_status,
            latency_ms: Some(started.elapsed().as_millis()),
            error: last_error,
        }
    }

    pub async fn transcribe(&self, pcm: &[u8], sample_rate: u32) -> Result<String, AdapterError> {
        if self.config.asr_url.trim().is_empty() {
            return Err(AdapterError::NotConfigured("asr"));
        }
        let wav = pcm16_wav(pcm, sample_rate);
        let file = multipart::Part::bytes(wav)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|error| AdapterError::Request("asr", error.to_string()))?;
        let response = self
            .client
            .post(format!(
                "{}/v1/audio/transcriptions",
                self.config.asr_url.trim_end_matches('/')
            ))
            .multipart(
                multipart::Form::new()
                    .part("file", file)
                    .text("model", "whisper-1"),
            )
            .timeout(std::time::Duration::from_secs(
                self.config.asr_timeout_seconds,
            ))
            .send()
            .await
            .map_err(|error| AdapterError::Request("asr", error.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AdapterError::Request("asr", error.to_string()))?;
        if !status.is_success() {
            return Err(AdapterError::Http("asr", status, body));
        }
        serde_json::from_str::<AsrResponse>(&body)
            .map(|response| response.text)
            .map_err(|error| AdapterError::Json("asr", error.to_string()))
    }

    pub async fn complete(&self, prompt: &str) -> Result<LlmCompletion, AdapterError> {
        if self.config.llm_url.trim().is_empty() {
            return Err(AdapterError::NotConfigured("llm"));
        }
        let estimated_prompt_tokens = prompt.chars().count().div_ceil(2) as u64 + 16;
        let reserved = estimated_prompt_tokens + u64::from(self.config.llm_max_tokens);
        {
            let mut budget = self.llm_budget.lock().await;
            if budget.requests >= self.config.llm_max_requests {
                budget.blocked += 1;
                return Err(AdapterError::BudgetExceeded(format!(
                    "request limit reached ({})",
                    self.config.llm_max_requests
                )));
            }
            if budget.tokens.saturating_add(reserved) > self.config.llm_max_total_tokens {
                budget.blocked += 1;
                return Err(AdapterError::BudgetExceeded(format!(
                    "token limit reached ({})",
                    self.config.llm_max_total_tokens
                )));
            }
            budget.tokens += reserved;
            budget.requests += 1;
        }
        let mut body = serde_json::json!({
            "model": self.config.llm_model,
            "messages": [
                {"role":"system","content":"用简洁、自然的中文回答用户。"},
                {"role":"user","content":prompt}
            ],
            "max_tokens": self.config.llm_max_tokens,
            "stream": false
        });
        if self.config.llm_disable_thinking {
            body["chat_template_kwargs"] = serde_json::json!({"enable_thinking": false});
        }
        let mut request = self
            .client
            .post(format!(
                "{}/v1/chat/completions",
                self.config.llm_url.trim_end_matches('/')
            ))
            .json(&body)
            .timeout(std::time::Duration::from_secs(15));
        if !self.config.llm_api_key.trim().is_empty() {
            request = request.bearer_auth(self.config.llm_api_key.trim());
        }
        let response = request
            .send()
            .await
            .map_err(|error| AdapterError::Request("llm", error.to_string()));
        let result = async {
            let response = response?;
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|error| AdapterError::Request("llm", error.to_string()))?;
            if !status.is_success() {
                return Err(AdapterError::Http("llm", status, body));
            }
            let response = serde_json::from_str::<ChatResponse>(&body)
                .map_err(|error| AdapterError::Json("llm", error.to_string()))?;
            let text = response
                .choices
                .first()
                .map(|choice| choice.message.content.clone())
                .ok_or_else(|| AdapterError::Json("llm", "response has no choices".into()))?;
            Ok(LlmCompletion {
                text,
                usage: response.usage,
            })
        }
        .await;
        let actual = result
            .as_ref()
            .ok()
            .map(|completion| {
                completion
                    .usage
                    .as_ref()
                    .map(|usage| usage.total_tokens)
                    .unwrap_or_else(|| {
                        estimated_prompt_tokens + completion.text.chars().count().div_ceil(2) as u64
                    })
            })
            .unwrap_or(reserved);
        let mut budget = self.llm_budget.lock().await;
        budget.tokens = budget
            .tokens
            .saturating_sub(reserved)
            .saturating_add(actual);
        result
    }

    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, AdapterError> {
        if self.config.tts_url.trim().is_empty() {
            return Err(AdapterError::NotConfigured("tts"));
        }
        // 纯 OpenAI 形态：只发 model/input/voice/response_format。语言由 Provider 侧
        // 按文本推断（见 TTS_REQUIREMENTS §3），Hub 不再夹带 GPT-SoVITS 专有字段。
        let mut request = self
            .client
            .post(format!(
                "{}/v1/audio/speech",
                self.config.tts_url.trim_end_matches('/')
            ))
            .json(&serde_json::json!({
                "model": self.config.tts_model,
                "input": text,
                "voice": self.config.tts_voice,
                "response_format": "wav"
            }))
            .timeout(std::time::Duration::from_secs(
                self.config.tts_timeout_seconds,
            ));
        if !self.config.tts_api_key.trim().is_empty() {
            request = request.bearer_auth(self.config.tts_api_key.trim());
        }
        let response = request
            .send()
            .await
            .map_err(|error| AdapterError::Request("tts", error.to_string()))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| AdapterError::Request("tts", error.to_string()))?;
        if !status.is_success() {
            return Err(AdapterError::Http(
                "tts",
                status,
                String::from_utf8_lossy(&body).into_owned(),
            ));
        }
        Ok(body.to_vec())
    }
}

pub fn decode_wav_pcm16(wav: &[u8]) -> Result<(Vec<u8>, u32), AdapterError> {
    if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(AdapterError::Audio(
            "tts",
            "missing RIFF/WAVE header".into(),
        ));
    }
    let mut offset = 12usize;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut data = None;
    while offset + 8 <= wav.len() {
        let kind = &wav[offset..offset + 4];
        let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start.saturating_add(size);
        if end > wav.len() {
            return Err(AdapterError::Audio("tts", "truncated WAV chunk".into()));
        }
        match kind {
            b"fmt " if size >= 16 => {
                let format = u16::from_le_bytes(wav[start..start + 2].try_into().unwrap());
                channels = Some(u16::from_le_bytes(
                    wav[start + 2..start + 4].try_into().unwrap(),
                ));
                sample_rate = Some(u32::from_le_bytes(
                    wav[start + 4..start + 8].try_into().unwrap(),
                ));
                bits_per_sample = Some(u16::from_le_bytes(
                    wav[start + 14..start + 16].try_into().unwrap(),
                ));
                if format != 1 {
                    return Err(AdapterError::Audio(
                        "tts",
                        format!("unsupported WAV format {format}"),
                    ));
                }
            }
            b"data" => data = Some(&wav[start..end]),
            _ => {}
        }
        offset = end + (size & 1);
    }
    let channels =
        channels.ok_or_else(|| AdapterError::Audio("tts", "missing fmt chunk".into()))?;
    let sample_rate =
        sample_rate.ok_or_else(|| AdapterError::Audio("tts", "missing sample rate".into()))?;
    let bits_per_sample =
        bits_per_sample.ok_or_else(|| AdapterError::Audio("tts", "missing bit depth".into()))?;
    let data = data.ok_or_else(|| AdapterError::Audio("tts", "missing data chunk".into()))?;
    if bits_per_sample != 16
        || !(channels == 1 || channels == 2)
        || data.len() % (2 * channels as usize) != 0
    {
        return Err(AdapterError::Audio(
            "tts",
            format!("unsupported PCM layout: channels={channels}, bits={bits_per_sample}"),
        ));
    }
    if channels == 1 {
        return Ok((data.to_vec(), sample_rate));
    }
    let mut mono = Vec::with_capacity(data.len() / 2);
    for frame in data.chunks_exact(4) {
        let left = i16::from_le_bytes([frame[0], frame[1]]) as i32;
        let right = i16::from_le_bytes([frame[2], frame[3]]) as i32;
        mono.extend_from_slice(
            &((left + right) / 2)
                .clamp(i16::MIN as i32, i16::MAX as i32)
                .try_into()
                .unwrap_or(0i16)
                .to_le_bytes(),
        );
    }
    Ok((mono, sample_rate))
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, Bytes},
        extract::Json,
        http::Response,
        routing::{get, post},
        Router,
    };
    use serde_json::{json, Value};

    #[test]
    fn wav_header_wraps_pcm16() {
        let wav = pcm16_wav(&[1, 2, 3, 4], 16_000);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
    }

    #[test]
    fn wav_decoder_extracts_pcm_and_rate() {
        let wav = pcm16_wav(&[1, 2, 3, 4], 16_000);
        assert_eq!(decode_wav_pcm16(&wav).unwrap(), (vec![1, 2, 3, 4], 16_000));
    }

    async fn health_ok() -> Json<Value> {
        Json(json!({"ok":true,"upstream_alive":true}))
    }

    async fn health_upstream_down() -> Json<Value> {
        Json(json!({"ok":true,"upstream_alive":false}))
    }

    async fn mock_asr(body: Bytes) -> Json<Value> {
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("audio.wav"));
        assert!(body.contains("whisper-1"));
        Json(json!({"text":"测试输入"}))
    }

    async fn mock_llm(headers: axum::http::HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_eq!(body["messages"][1]["content"], "测试输入");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(
            headers[axum::http::header::AUTHORIZATION],
            "Bearer test-secret"
        );
        Json(
            json!({"choices":[{"message":{"content":"测试回答"}}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}),
        )
    }

    async fn mock_tts(headers: axum::http::HeaderMap, Json(body): Json<Value>) -> Response<Body> {
        assert_eq!(body["model"], "tts-1");
        assert_eq!(body["voice"], "xxx_trained");
        assert_eq!(body["response_format"], "wav");
        assert!(
            body.get("text_lang").is_none() && body.get("prompt_lang").is_none(),
            "hub must not send GPT-SoVITS specific language fields: {body}"
        );
        assert_eq!(
            headers[axum::http::header::AUTHORIZATION],
            "Bearer tts-test-secret"
        );
        Response::builder()
            .header("content-type", "audio/wav")
            .body(Body::from(pcm16_wav(&[1, 2, 3, 4], 32_000)))
            .unwrap()
    }

    async fn mock_server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn adapters_run_openai_compatible_pipeline_against_mock_services() {
        let router = Router::new()
            .route("/health", get(health_ok))
            .route("/healthz", get(health_ok))
            .route("/v1/audio/transcriptions", post(mock_asr))
            .route("/v1/chat/completions", post(mock_llm))
            .route("/v1/audio/speech", post(mock_tts));
        let (url, server) = mock_server(router).await;
        let adapters = ModelAdapters::new(AdapterConfig {
            asr_url: url.clone(),
            asr_timeout_seconds: 15,
            tts_url: url.clone(),
            llm_url: url,
            llm_model: "mock-model".into(),
            llm_api_key: "test-secret".into(),
            llm_disable_thinking: false,
            llm_max_tokens: 128,
            llm_max_total_tokens: 1024,
            llm_max_requests: 4,
            tts_model: "tts-1".into(),
            tts_voice: "xxx_trained".into(),
            tts_api_key: "tts-test-secret".into(),
            tts_timeout_seconds: 45,
        })
        .unwrap();

        let statuses = adapters.statuses().await;
        assert!(statuses.iter().all(|status| status.ok));
        assert_eq!(
            adapters.transcribe(&[0, 0, 1, 0], 16_000).await.unwrap(),
            "测试输入"
        );
        let answer = adapters.complete("测试输入").await.unwrap();
        assert_eq!(answer.text, "测试回答");
        assert_eq!(answer.usage.unwrap().total_tokens, 16);
        let wav = adapters.synthesize(&answer.text).await.unwrap();
        assert_eq!(decode_wav_pcm16(&wav).unwrap(), (vec![1, 2, 3, 4], 32_000));
        server.abort();
    }

    #[tokio::test]
    async fn tts_status_detects_dead_upstream_behind_live_gateway() {
        let router = Router::new()
            .route("/health", get(health_ok))
            .route("/healthz", get(health_upstream_down))
            .route("/v1/models", get(health_ok));
        let (url, server) = mock_server(router).await;
        let adapters = ModelAdapters::new(AdapterConfig {
            tts_url: url,
            ..AdapterConfig::default()
        })
        .unwrap();
        let statuses = adapters.statuses().await;
        let tts = statuses.iter().find(|status| status.name == "tts").unwrap();
        assert!(!tts.ok);
        assert_eq!(
            tts.error.as_deref(),
            Some("gateway is up; TTS upstream is unavailable")
        );
        server.abort();
    }
}
