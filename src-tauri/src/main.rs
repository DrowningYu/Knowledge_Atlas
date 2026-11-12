#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod tunnel;
use atlas_core::Store;
use atlas_server::{ServerHandle, ServerOptions};
use serde_json::Value;
use std::{fs, sync::Arc};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

struct TunnelState(Arc<tunnel::Tunnel>);

#[tauri::command]
async fn tunnel_action(
    state: tauri::State<'_, TunnelState>,
    action: String,
    settings: Option<tunnel::Settings>,
    key: Option<String>,
) -> Result<tunnel::Snapshot, String> {
    let tunnel = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "status" => Ok(tunnel.snapshot()),
        "connect" => tunnel.connect(settings.ok_or("缺少连接设置")?, key),
        "disconnect" => Ok(tunnel.disconnect()),
        "forget" => tunnel.forget(),
        _ => Err("未知连接操作".into()),
    })
    .await
    .map_err(|_| "连接操作失败".to_string())?
}

struct AtlasState {
    store: Store,
    server: Arc<ServerHandle>,
}

#[tauri::command]
async fn api(
    state: tauri::State<'_, AtlasState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if method == "connection_info" {
        return Ok(state.server.info());
    }
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        atlas_server::dispatch(&store, &method, params).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn open_setup_url(destination: String) -> Result<(), String> {
    let url = match destination.as_str() {
        "platform" => "https://platform.openai.com/settings/organization/tunnels",
        "chatgpt" => "https://chatgpt.com/plugins",
        "docs" => "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
        _ => return Err("不支持的设置页面".into()),
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map_err(|_| "无法打开浏览器".to_string())?;
    Ok(())
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<bool, String> {
    if data.len() > 50 * 1024 * 1024 {
        return Err("导出文件超过 50 MB".into());
    }
    let name = std::path::Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("knowledge-atlas.json")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        match app.dialog().file().set_file_name(name).blocking_save_file() {
            Some(file) => {
                let path = file.into_path().map_err(|e| e.to_string())?;
                fs::write(path, data).map_err(|e| e.to_string())?;
                Ok(true)
            }
            None => Ok(false),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
            let db_path = dir.join("atlas.sqlite");
            let first_run = !db_path.exists();
            let store = Store::open(&db_path)?;
            if first_run {
                store.seed_demo()?;
            }
            let token_path = dir.join("mcp.token");
            let token = match fs::read_to_string(&token_path) {
                Ok(token) => token.trim().to_string(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    use std::io::Write;
                    let token = format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    );
                    let mut options = fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut file = options.open(&token_path)?;
                    file.write_all(token.as_bytes())?;
                    file.sync_all()?;
                    token
                }
                Err(e) => return Err(e.into()),
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
            }
            if token.len() < 32 {
                return Err(
                    "Invalid local MCP token; token must have at least 32 characters".into(),
                );
            }
            let server = tauri::async_runtime::block_on(atlas_server::start(
                store.clone(),
                ServerOptions {
                    port: 38473,
                    token: token.clone(),
                    allowed_origins: vec![
                        "tauri://localhost".into(),
                        "http://tauri.localhost".into(),
                        "https://tauri.localhost".into(),
                    ],
                },
            ))?;
            // Discover the actual loopback port even when the preferred port was occupied.
            // No credential is included; the token remains in its existing private file.
            fs::write(
                dir.join("mcp-endpoint.json"),
                serde_json::to_vec(
                    &serde_json::json!({"url": format!("http://127.0.0.1:{}/mcp", server.port)}),
                )?,
            )?;
            let server = Arc::new(server);
            let mut events = store.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(change) => {
                            let _ = handle.emit("atlas-changed", change);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ =
                                handle.emit("atlas-changed", serde_json::json!({"kind":"resync"}));
                        }
                        Err(_) => break,
                    }
                }
            });
            let binary = std::env::current_exe()?.with_file_name(if cfg!(windows) {
                "tunnel-client-runtime.exe"
            } else {
                "tunnel-client-runtime"
            });
            let tunnel = tunnel::Tunnel::new(dir, binary, server.port, token);
            app.manage(TunnelState(tunnel));
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };
            let show = MenuItem::with_id(app, "show", "打开 Knowledge Atlas", true, None::<&str>)?;
            let stop =
                MenuItem::with_id(app, "disconnect", "断开 ChatGPT 连接", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Knowledge Atlas", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
            let _tray = TrayIconBuilder::with_id("atlas")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Knowledge Atlas")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "disconnect" => {
                        let t = app.state::<TunnelState>().0.clone();
                        std::thread::spawn(move || {
                            t.disconnect();
                        });
                    }
                    "quit" => {
                        app.state::<TunnelState>().0.shutdown();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            app.manage(AtlasState { store, server });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<TunnelState>().0.keep_in_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api,
            save_export,
            copy_text,
            tunnel_action,
            open_setup_url
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Knowledge Atlas")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<TunnelState>() {
                    state.0.shutdown();
                }
                if let Some(state) = app.try_state::<AtlasState>() {
                    state.server.shutdown();
                }
            }
        });
}
