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
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;

const SHOW_SCOPE: &str = "presence:show";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    host_id: String,
    hub_ws_url: String,
    projection_url: String,
    policy: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            host_id: format!("host-{}", uuid::Uuid::new_v4()),
            hub_ws_url: "ws://127.0.0.1:18100/ws".into(),
            projection_url: String::new(),
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
    active_visit: Mutex<Option<String>>,
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
            active_visit: Mutex::new(None),
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
    projection_url: String,
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
    validate_projection_url(&projection_url)?;
    let mut config = state.config.lock().map_err(|_| "配置锁不可用".to_owned())?;
    config.hub_ws_url = hub_ws_url;
    config.projection_url = projection_url;
    config.policy = policy;
    write_config(&state.config_path, &config)?;
    Ok(config.clone())
}

fn validate_projection_url(value: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(value.trim()).map_err(|_| "投影地址格式无效")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("投影地址必须是固定的 http(s) 根地址，不能带账号、参数或路径".into());
    }
    Ok(parsed)
}

#[tauri::command]
fn open_projection_window(
    app: AppHandle,
    visit_id: String,
    projection_id: String,
    expires_at_ms: u64,
    state: State<'_, HostState>,
) -> Result<(), String> {
    if projection_id != "coo-pet" || visit_id.is_empty() || visit_id.len() > 96 {
        return Err("投影租约字段无效".into());
    }
    if expires_at_ms <= wall_ms() {
        return Err("投影租约已过期".into());
    }
    let config = state.config.lock().map_err(|_| "配置锁不可用".to_owned())?.clone();
    let url = validate_projection_url(&config.projection_url)?;
    if let Some(existing) = app.get_webview_window("coo-visit") {
        existing.close().map_err(|error| error.to_string())?;
    }
    let monitor = app.primary_monitor().map_err(|error| error.to_string())?.ok_or("没有可用显示器")?;
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let width = 520.0;
    let height = 360.0;
    let x = position.x as f64 / scale + size.width as f64 / scale - width;
    let y = position.y as f64 / scale + size.height as f64 / scale - height;
    *state.active_visit.lock().map_err(|_| "投影状态锁不可用".to_owned())? = Some(visit_id.clone());
    let result = WebviewWindowBuilder::new(&app, "coo-visit", WebviewUrl::External(url))
        .title("Coo · 串门中")
        .inner_size(width, height)
        .position(x.max(position.x as f64 / scale), y.max(position.y as f64 / scale))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .build();
    if let Ok(window) = &result {
        let app_for_event = app.clone();
        let visit_for_event = visit_id.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = app_for_event.emit("coo-projection-closed", visit_for_event.clone());
            }
        });
    }
    if let Err(error) = result {
        *state.active_visit.lock().map_err(|_| "投影状态锁不可用".to_owned())? = None;
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
fn close_projection_window(
    app: AppHandle,
    visit_id: String,
    state: State<'_, HostState>,
) -> Result<bool, String> {
    let mut active = state.active_visit.lock().map_err(|_| "投影状态锁不可用".to_owned())?;
    if active.as_deref() != Some(visit_id.as_str()) {
        return Ok(false);
    }
    *active = None;
    if let Some(window) = app.get_webview_window("coo-visit") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(true)
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
            let return_visit = MenuItem::with_id(app, "return-visit", "结束 Coo 串门", true, None::<&str>)?;
            let exit =
                MenuItem::with_id(app, "exit", "退出 Absolute Solver Host", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &revoke, &return_visit, &exit])?;
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
                    "return-visit" => { let _ = app.emit("host:visit-return-request", ()); }
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
            ,open_projection_window,
            close_projection_window
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Absolute Solver Host");
}
