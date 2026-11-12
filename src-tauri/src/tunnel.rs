//! Owns exactly one bundled tunnel process. Credentials never cross the status API.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const KEY_SERVICE: &str = "app.knowledgeatlas.desktop.tunnel";
const KEY_USER: &str = "runtime";
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Settings {
    pub tunnel_id: String,
    pub auto_connect: bool,
    pub keep_in_tray: bool,
    pub remember_key: bool,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub settings: Settings,
    pub state: String,
    pub message: String,
    pub has_key: bool,
    pub runtime_available: bool,
}
struct Inner {
    settings: Settings,
    key: Option<String>,
    child: Option<Child>,
    wanted: bool,
    state: String,
    message: String,
    next_start: Instant,
    retries: u32,
    health_file: PathBuf,
}
pub struct Tunnel {
    inner: Mutex<Inner>,
    stop: AtomicBool,
    dir: PathBuf,
    binary: PathBuf,
    port: u16,
    token: String,
}
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|_| "无法打开系统凭据库".into())
}
pub fn validate(settings: &Settings, key: &str) -> Result<(), String> {
    let suffix = settings.tunnel_id.strip_prefix("tunnel_").unwrap_or("");
    let parts: Vec<_> = suffix.split('_').collect();
    let valid_part = |s: &str, len| {
        s.len() == len
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    if !matches!(parts.as_slice(), [id] if valid_part(id,32))
        && !matches!(parts.as_slice(), [ns,id] if valid_part(ns,4) && valid_part(id,32))
    {
        return Err("隧道 ID 格式不正确，请从 Platform 复制完整的 tunnel_ ID".into());
    }
    if key.len() < 16
        || key.len() > 4096
        || key
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return Err("请输入有效的隧道运行密钥".into());
    }
    if settings.auto_connect && !settings.remember_key {
        return Err("下次启动自动连接需要把密钥保存在系统凭据库".into());
    }
    Ok(())
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&temp).map_err(|_| "无法写入连接设置")?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| "无法保存连接设置")?;
    // Windows rename does not replace an existing destination.
    if path.exists() {
        fs::remove_file(path).map_err(|_| "无法更新连接设置")?;
    }
    fs::rename(temp, path).map_err(|_| "无法更新连接设置".into())
}
fn runtime_config(settings: &Settings, port: u16, health: &Path) -> Value {
    json!({
        "config_version": 1,
        "control_plane": {"base_url":"https://api.openai.com", "tunnel_id":settings.tunnel_id, "api_key":"env:ATLAS_TUNNEL_KEY"},
        "mcp": {"server_urls":[{"channel":"main", "url":format!("http://127.0.0.1:{port}/mcp")}],
            "extra_headers":{"Authorization":"env:ATLAS_MCP_AUTH"},
            "discovery_extra_headers":{"Authorization":"env:ATLAS_MCP_AUTH"}, "startup_wait_timeout":"15s"},
        "health":{"listen_addr":"127.0.0.1:0", "url_file":health},
        "admin_ui":{"open_browser":false}, "log":{"level":"error", "format":"json"}
    })
}
fn kill(child: &mut Option<Child>) {
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}
// Launch flags never contain the runtime key or local MCP bearer token.
fn runtime_command(binary: &Path, config: &Path, key: &str, token: &str) -> Command {
    let mut c = Command::new(binary);
    // Do not inherit unrelated tunnel profiles, credentials or MCP targets from the GUI's environment.
    for (name, _) in std::env::vars_os() {
        let s = name.to_string_lossy();
        if [
            "CONTROL_PLANE_",
            "TUNNEL_CLIENT_",
            "MCP_",
            "HEALTH_",
            "HARPOON_",
            "CLOUDFLARED_",
            "ADMIN_UI_",
            "LOG_",
            "TRACING_",
        ]
        .iter()
        .any(|p| s.starts_with(p))
            || s == "OPENAI_API_KEY"
            || s == "PID_FILE"
        {
            c.env_remove(name);
        }
    }
    c.args(["run", "--config"])
        .arg(config)
        .env("ATLAS_TUNNEL_KEY", key)
        .env("ATLAS_MCP_AUTH", format!("Bearer {token}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
// /readyz alone is not proof of a successful OpenAI poll.
fn health_state(value: &Value) -> (&'static str, &'static str) {
    let cp = &value["components"]["control-plane"];
    if value["ready"] == true
        && cp["status"] == "ok"
        && value["components"]["mcp"]["details"]["startup_probe"]["state"] == "succeeded"
    {
        ("connected", "隧道已就绪，可以到 ChatGPT 绑定并测试")
    } else if cp["status"] == "degraded" {
        (
            "reconnecting",
            "连接受阻，正在重试；请检查网络、运行密钥与隧道权限",
        )
    } else {
        ("connecting", "正在连接，等待云端确认")
    }
}
impl Tunnel {
    pub fn new(dir: PathBuf, binary: PathBuf, port: u16, token: String) -> Arc<Self> {
        let settings: Settings = fs::read(dir.join("tunnel-settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        // Read a saved credential only when previously requested, not on every status refresh.
        let key = if settings.remember_key {
            entry().ok().and_then(|e| e.get_password().ok())
        } else {
            None
        };
        let wanted =
            settings.auto_connect && key.as_ref().is_some_and(|k| validate(&settings, k).is_ok());
        let message = if settings.auto_connect && !wanted {
            "自动连接未启动，请解锁系统凭据库或重新输入密钥"
        } else {
            "尚未连接"
        };
        let state = Arc::new(Self {
            dir: dir.clone(),
            binary,
            port,
            token,
            stop: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                settings,
                key,
                child: None,
                wanted,
                state: "disconnected".into(),
                message: message.into(),
                next_start: Instant::now(),
                retries: 0,
                health_file: dir.join("tunnel-health.url"),
            }),
        });
        let weak = Arc::downgrade(&state);
        std::thread::spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(1))
                .build()
                .expect("local health client");
            loop {
                let Some(t) = weak.upgrade() else { break };
                if t.stop.load(Ordering::SeqCst) {
                    break;
                }
                t.tick(&client);
                drop(t);
                std::thread::sleep(Duration::from_secs(2));
            }
        });
        state
    }
    pub fn snapshot(&self) -> Snapshot {
        let i = self.inner.lock().unwrap();
        Snapshot {
            settings: i.settings.clone(),
            state: i.state.clone(),
            message: i.message.clone(),
            has_key: i.key.is_some(),
            runtime_available: self.binary.is_file(),
        }
    }
    pub fn keep_in_tray(&self) -> bool {
        self.inner.lock().unwrap().settings.keep_in_tray
    }
    pub fn connect(&self, settings: Settings, new_key: Option<String>) -> Result<Snapshot, String> {
        let mut i = self.inner.lock().unwrap();
        let key = new_key
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .or_else(|| i.key.clone())
            .ok_or("请先输入隧道运行密钥")?;
        validate(&settings, &key)?;
        if !self.binary.is_file() {
            return Err("缺少内置连接程序，请重新安装完整安装包".into());
        }
        if settings.remember_key {
            entry()?
                .set_password(&key)
                .map_err(|_| "系统凭据库保存失败；请解锁钥匙串，或取消记住密钥与自动连接后重试")?;
        } else if i.settings.remember_key {
            match entry()?.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err("无法删除旧的系统凭据，请解锁后重试".into()),
            }
        }
        private_write(
            &self.dir.join("tunnel-settings.json"),
            &serde_json::to_vec(&settings).unwrap(),
        )?;
        kill(&mut i.child);
        i.settings = settings;
        i.key = Some(key);
        i.wanted = true;
        i.retries = 0;
        i.next_start = Instant::now();
        i.state = "connecting".into();
        i.message = "正在启动后台连接".into();
        drop(i);
        Ok(self.snapshot())
    }
    pub fn disconnect(&self) -> Snapshot {
        let mut i = self.inner.lock().unwrap();
        i.wanted = false;
        kill(&mut i.child);
        i.state = "disconnected".into();
        i.message = "连接已停止".into();
        drop(i);
        self.snapshot()
    }
    pub fn forget(&self) -> Result<Snapshot, String> {
        self.disconnect();
        let mut i = self.inner.lock().unwrap();
        if i.settings.remember_key {
            match entry()?.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err("无法删除系统凭据，请解锁后重试".into()),
            }
        }
        let settings = Settings::default();
        private_write(
            &self.dir.join("tunnel-settings.json"),
            &serde_json::to_vec(&settings).unwrap(),
        )?;
        i.settings = settings;
        i.key = None;
        drop(i);
        Ok(self.snapshot())
    }
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.disconnect();
    }
    fn tick(&self, client: &reqwest::blocking::Client) {
        let mut i = self.inner.lock().unwrap();
        if !i.wanted {
            return;
        }
        if let Some(c) = i.child.as_mut() {
            if !matches!(c.try_wait(), Ok(None)) {
                kill(&mut i.child);
                i.retries = i.retries.saturating_add(1);
                i.next_start =
                    Instant::now() + Duration::from_secs((2_u64.pow(i.retries.min(5))).min(30));
                i.state = "reconnecting".into();
                i.message = "连接程序已退出，正在稍后重试；可点断开停止".into();
            }
        }
        if i.child.is_none() && Instant::now() >= i.next_start {
            let _ = fs::remove_file(&i.health_file);
            let config = self.dir.join("tunnel-runtime.json");
            let result = private_write(
                &config,
                &serde_json::to_vec(&runtime_config(&i.settings, self.port, &i.health_file))
                    .unwrap(),
            )
            .and_then(|_| {
                runtime_command(
                    &self.binary,
                    &config,
                    i.key.as_deref().unwrap_or(""),
                    &self.token,
                )
                .spawn()
                .map_err(|_| "内置连接程序无法启动，请重新安装应用".into())
            });
            match result {
                Ok(child) => {
                    i.child = Some(child);
                    i.state = "connecting".into();
                    i.message = "正在连接，等待云端确认".into();
                }
                Err(e) => {
                    i.wanted = false;
                    i.state = "error".into();
                    i.message = e;
                }
            }
        }
        if i.child.is_some() {
            if let Ok(url) = fs::read_to_string(&i.health_file) {
                if let Ok(mut url) = reqwest::Url::parse(url.trim()) {
                    if url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.username().is_empty()
                        && url.password().is_none()
                    {
                        url.set_path("/health");
                        url.set_query(Some("details=true"));
                        if let Ok(value) = client
                            .get(url)
                            .send()
                            .and_then(|r| r.error_for_status())
                            .and_then(|r| r.json::<Value>())
                        {
                            let (state, message) = health_state(&value);
                            i.state = state.into();
                            i.message = message.into();
                            if state == "connected" {
                                i.retries = 0;
                            }
                        } else {
                            i.state = "reconnecting".into();
                            i.message = "暂时无法确认连接状态，正在重试".into();
                        }
                    }
                }
            }
        }
    }
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_and_secret_boundaries() {
        let s = Settings {
            tunnel_id: "tunnel_0123456789abcdef0123456789abcdef".into(),
            auto_connect: true,
            remember_key: true,
            keep_in_tray: true,
        };
        assert!(validate(&s, "sk-test-abcdefghijklmnop").is_ok());
        let mut bad = s.clone();
        bad.tunnel_id = "tunnel_foo\nmalicious".into();
        assert!(validate(&bad, "sk-test-abcdefghijklmnop").is_err());
        bad = s.clone();
        bad.remember_key = false;
        assert!(validate(&bad, "sk-test-abcdefghijklmnop").is_err());
        let config = runtime_config(&s, 38474, Path::new("/test/health.url"));
        assert_eq!(
            config["mcp"]["server_urls"][0]["url"],
            "http://127.0.0.1:38474/mcp"
        );
        let cmd = runtime_command(
            Path::new("runtime"),
            Path::new("runtime.json"),
            "private-key-value",
            "private-token-value",
        );
        let args: Vec<_> = cmd.get_args().map(|s| s.to_string_lossy()).collect();
        assert!(!format!("{args:?}").contains("private"));
        assert!(!config.to_string().contains("private"));
        assert!(!serde_json::to_string(&s).unwrap().contains("sk-test"));
    }
    #[test]
    fn readiness_requires_cloud_evidence() {
        assert_eq!(health_state(&json!({"ready":true})).0, "connecting");
        assert_eq!(
            health_state(
                &json!({"ready":true,"components":{"control-plane":{"status":"degraded"}}})
            )
            .0,
            "reconnecting"
        );
        assert_eq!(
            health_state(&json!({"ready":true,"components":{"control-plane":{"status":"ok"}, "mcp":{"details":{"startup_probe":{"state":"succeeded"}}}}})).0,
            "connected"
        );
    }
    #[test]
    fn process_exit_restarts_and_disconnect_stops() {
        let dir = std::env::temp_dir().join(format!("atlas-tunnel-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // The test harness rejects runtime flags and exits. No real network or credential store.
        let t = Tunnel {
            dir: dir.clone(),
            binary: std::env::current_exe().unwrap(),
            port: 12345,
            token: "local-test-token".into(),
            stop: AtomicBool::new(false),
            inner: Mutex::new(Inner {
                settings: Settings::default(),
                key: None,
                child: None,
                wanted: false,
                state: "disconnected".into(),
                message: String::new(),
                next_start: Instant::now(),
                retries: 0,
                health_file: dir.join("health.url"),
            }),
        };
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let settings = Settings {
            tunnel_id: "tunnel_0123456789abcdef0123456789abcdef".into(),
            remember_key: false,
            auto_connect: false,
            keep_in_tray: true,
        };
        t.connect(settings.clone(), Some("test-secret-123456789".into()))
            .unwrap();
        t.tick(&client);
        let first = t.inner.lock().unwrap().child.as_ref().unwrap().id();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            std::thread::sleep(Duration::from_millis(50));
            t.tick(&client);
            if t.inner.lock().unwrap().child.is_none() {
                break;
            }
            assert!(Instant::now() < deadline, "test child did not exit");
        }
        assert_eq!(t.snapshot().state, "reconnecting");
        t.inner.lock().unwrap().next_start = Instant::now();
        t.tick(&client);
        assert_ne!(t.inner.lock().unwrap().child.as_ref().unwrap().id(), first);
        t.connect(settings, None).unwrap(); // reconnect kills the existing process before replacing it
        assert!(t.inner.lock().unwrap().child.is_none());
        t.disconnect();
        t.tick(&client);
        assert!(t.inner.lock().unwrap().child.is_none());
        assert_eq!(t.snapshot().state, "disconnected");
        assert!(!fs::read_to_string(dir.join("tunnel-settings.json"))
            .unwrap()
            .contains("test-secret"));
        t.forget().unwrap();
        assert!(!t.snapshot().has_key);
        t.shutdown();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn native_credential_roundtrip_on_disposable_runner() {
        if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") || cfg!(target_os = "linux") {
            return;
        }
        let e = keyring::Entry::new("app.knowledgeatlas.test", &uuid::Uuid::new_v4().to_string())
            .unwrap();
        e.set_password("test-only-runtime-key").unwrap();
        assert_eq!(e.get_password().unwrap(), "test-only-runtime-key");
        e.delete_credential().unwrap();
        assert!(matches!(e.get_password(), Err(keyring::Error::NoEntry)));
    }
}
