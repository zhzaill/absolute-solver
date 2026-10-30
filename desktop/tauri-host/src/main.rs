#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_notification::NotificationExt;

const SHOW_SCOPE: &str = "presence:show";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    host_id: String,
    hub_ws_url: String,
    policy: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            host_id: format!("host-{}", uuid::Uuid::new_v4()),
            hub_ws_url: "ws://127.0.0.1:18100/ws".into(),
            policy: "notify".into(),
        }
    }
}

struct ActiveOverlay {
    intent_id: String,
}

struct HostState {
    config_path: PathBuf,
    event_log_path: PathBuf,
    config: Mutex<HostConfig>,
    active: Mutex<Option<ActiveOverlay>>,
}

impl HostState {
    fn load(config_path: PathBuf) -> Result<Self, String> {
        let config = if config_path.exists() {
            let text = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
            serde_json::from_str(&text).map_err(|error| error.to_string())?
        } else {
            let config = HostConfig::default();
            write_config(&config_path, &config)?;
            config
        };
        Ok(Self {
            event_log_path: config_path.with_file_name("host-events.jsonl"),
            config_path,
            config: Mutex::new(config),
            active: Mutex::new(None),
        })
    }
}

fn write_config(path: &PathBuf, config: &HostConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_host_config(state: State<'_, HostState>) -> Result<HostConfig, String> {
    state
        .config
        .lock()
        .map(|config| config.clone())
        .map_err(|_| "配置锁不可用".to_owned())
}

#[tauri::command]
fn show_host_window(window: WebviewWindow) -> Result<(), String> {
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_host_config(
    hub_ws_url: String,
    policy: String,
    state: State<'_, HostState>,
) -> Result<HostConfig, String> {
    if !matches!(policy.as_str(), "notify" | "appear" | "reject") {
        return Err("本机策略只能是 notify、appear 或 reject".into());
    }
    let parsed = url::Url::parse(&hub_ws_url).map_err(|_| "Hub 地址格式无效")?;
    if !matches!(parsed.scheme(), "ws" | "wss")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Hub 地址必须使用 ws:// 或 wss://".into());
    }
    let mut config = state.config.lock().map_err(|_| "配置锁不可用".to_owned())?;
    config.hub_ws_url = hub_ws_url;
    config.policy = policy;
    write_config(&state.config_path, &config)?;
    Ok(config.clone())
}

#[tauri::command]
fn record_host_event(
    event: String,
    intent_id: Option<String>,
    detail: String,
    state: State<'_, HostState>,
) -> Result<(), String> {
    let event = event.chars().take(64).collect::<String>();
    let intent_id = intent_id.map(|value| value.chars().take(96).collect::<String>());
    let detail = detail
        .replace(['\r', '\n'], " ")
        .chars()
        .take(512)
        .collect::<String>();
    let record = serde_json::json!({
        "at_ms": wall_ms(),
        "event": event,
        "intent_id": intent_id,
        "detail": detail,
    });
    let mut line = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.event_log_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&line).map_err(|error| error.to_string())
}

#[tauri::command]
fn show_presence_overlay(
    intent_id: String,
    host_id: String,
    scope: String,
    expires_at_ms: u64,
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<(), String> {
    let config = state.config.lock().map_err(|_| "配置锁不可用".to_owned())?;
    if config.policy != "appear" || host_id != config.host_id || scope != SHOW_SCOPE {
        return Err("本机策略或 presence grant 不允许显示".into());
    }
    if expires_at_ms <= wall_ms() {
        return Err("presence grant 已过期".into());
    }
    *state
        .active
        .lock()
        .map_err(|_| "覆盖层状态不可用".to_owned())? = Some(ActiveOverlay { intent_id });
    window
        .set_always_on_top(true)
        .and_then(|_| window.set_decorations(false))
        .and_then(|_| window.set_fullscreen(true))
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_presence_overlay(
    intent_id: String,
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<bool, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "覆盖层状态不可用".to_owned())?;
    if !active
        .as_ref()
        .is_some_and(|lease| lease.intent_id == intent_id)
    {
        return Ok(false);
    }
    *active = None;
    window
        .set_fullscreen(false)
        .and_then(|_| window.set_always_on_top(false))
        .and_then(|_| window.set_decorations(true))
        .and_then(|_| window.hide())
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn notify_presence(app: AppHandle, reason: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Absolute Solver 请求连接")
        .body(reason.chars().take(240).collect::<String>())
        .show()
        .map_err(|error| error.to_string())
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn tray_icon() -> Image<'static> {
    let mut rgba = vec![0u8; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let edge = x < 3 || y < 3 || x > 28 || y > 28;
            let mark = (x == 15 || x == 16) && (5..27).contains(&y)
                || (y == 15 || y == 16) && (5..27).contains(&x);
            let color = if edge {
                [31, 103, 160, 255]
            } else if mark {
                [111, 204, 255, 255]
            } else {
                [5, 12, 24, 255]
            };
            let offset = (y * 32 + x) * 4;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
    Image::new_owned(rgba, 32, 32)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_path = std::env::var_os("SOLVER_HOST_CONFIG_PATH")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_config_dir()?.join("host.json"));
            app.manage(HostState::load(config_path).map_err(std::io::Error::other)?);

            let open = MenuItem::with_id(app, "open", "打开设置面板", true, None::<&str>)?;
            let revoke = MenuItem::with_id(app, "revoke", "撤销显示并隐藏", true, None::<&str>)?;
            let exit =
                MenuItem::with_id(app, "exit", "退出 Absolute Solver Host", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &revoke, &exit])?;
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("Absolute Solver Host")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "revoke" => {
                        let _ = app.emit("host:revoke-request", ());
                    }
                    "exit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_host_config,
            show_host_window,
            save_host_config,
            record_host_event,
            show_presence_overlay,
            hide_presence_overlay,
            notify_presence
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Absolute Solver Host");
}
