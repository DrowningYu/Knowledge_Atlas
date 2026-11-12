import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Settings = { tunnel_id: string; auto_connect: boolean; keep_in_tray: boolean; remember_key: boolean };
type Snapshot = { settings: Settings; state: string; message: string; has_key: boolean; runtime_available: boolean };
const defaults: Settings = { tunnel_id: "", auto_connect: true, keep_in_tray: true, remember_key: true };
const labels: Record<string, string> = { disconnected: "未连接", connecting: "连接中", connected: "已就绪", reconnecting: "重连中", error: "连接失败" };
export function TunnelSettings() {
  const desktop = "__TAURI_INTERNALS__" in window;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState(defaults);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let first = true;
    const refresh = async () => {
      try {
        const s = await invoke<Snapshot>("tunnel_action", { action: "status" });
        if (cancelled) return;
        setSnapshot(s);
        if (first) { if (s.settings.tunnel_id) setSettings(s.settings); first = false; }
      } catch { if (!cancelled) setError("无法读取后台连接状态，请重新打开设置"); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [desktop]);
  const openLink = (e: React.MouseEvent<HTMLAnchorElement>, destination: string) => {
    if (!desktop) return;
    e.preventDefault();
    void invoke("open_setup_url", { destination }).catch(() => setError("无法打开浏览器，请手动打开链接"));
  };
  const action = async (action: string) => {
    setBusy(true); setError("");
    try {
      const s = await invoke<Snapshot>("tunnel_action", { action, ...(action === "connect" ? { settings, key: key || null } : {}) });
      setSnapshot(s); setKey("");
      if (action === "forget") setSettings(defaults);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="tunnel-settings" aria-label="ChatGPT 后台连接">
    <h3>ChatGPT 普通聊天</h3>
    <p className="muted small">让 ChatGPT 通过安全隧道访问本机地图，无需保持终端窗口。请求的地图内容会发送给 ChatGPT。</p>
    {!desktop ? <p className="muted">请在 Knowledge Atlas 桌面应用中设置后台连接</p> : <>
      <ol className="tunnel-guide">
        <li><a onClick={e => openLink(e, "platform")} href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noreferrer">在 Platform 创建隧道</a>，关联 ChatGPT 工作区，并创建有隧道 Read / Use 权限的运行密钥</li>
        <li>在下方填写隧道 ID 和运行密钥，点击连接</li>
        <li><a onClick={e => openLink(e, "chatgpt")} href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">打开 ChatGPT 插件</a>，添加自定义 MCP，选择 Tunnel 和自己的隧道；MCP 认证选 No authentication</li>
      </ol>
      <label className="field-label" htmlFor="tunnel-id">隧道 ID</label>
      <input id="tunnel-id" className="text-input" placeholder="tunnel_…" value={settings.tunnel_id} onChange={e => setSettings({ ...settings, tunnel_id: e.target.value.trim() })} disabled={busy} />
      <label className="field-label" htmlFor="tunnel-key">隧道运行密钥</label>
      <input id="tunnel-key" className="text-input" type="password" autoComplete="off" spellCheck={false} placeholder={snapshot?.has_key ? "已设置，留空继续使用；输入新密钥可替换" : "仅在本机输入运行密钥"} value={key} onChange={e => setKey(e.target.value)} disabled={busy} />
      <label className="tunnel-check"><input type="checkbox" checked={settings.remember_key} disabled={busy} onChange={e => setSettings({ ...settings, remember_key: e.target.checked, auto_connect: e.target.checked && settings.auto_connect })} />记住密钥（系统凭据库）</label>
      <label className="tunnel-check"><input type="checkbox" checked={settings.auto_connect} disabled={busy || !settings.remember_key} onChange={e => setSettings({ ...settings, auto_connect: e.target.checked })} />下次打开 Knowledge Atlas 时自动连接</label>
      <label className="tunnel-check"><input type="checkbox" checked={settings.keep_in_tray} disabled={busy} onChange={e => setSettings({ ...settings, keep_in_tray: e.target.checked })} />关闭窗口后留在菜单栏／托盘运行</label>
      <div className="connection-status" role="status"><span className={"tiny-dot " + (snapshot?.state === "connected" ? "" : "warning")} />{labels[snapshot?.state || "disconnected"]}<small>{snapshot?.message || "正在读取状态"}</small></div>
      {error && <p className="tunnel-error" role="alert">{error}</p>}
      {snapshot && !snapshot.runtime_available && <p className="tunnel-error">缺少内置连接程序，请重新安装完整安装包</p>}
      <div className="tunnel-actions">
        <button className="button primary" disabled={busy || !snapshot || !snapshot.runtime_available || !settings.tunnel_id || (!key && !snapshot.has_key)} onClick={() => void action("connect")}>{busy ? "处理中…" : "保存并连接"}</button>
        <button className="button" disabled={busy || !snapshot || snapshot.state === "disconnected"} onClick={() => void action("disconnect")}>断开</button>
        <button className="button subtle" disabled={busy || !snapshot} onClick={() => { if (window.confirm("断开连接并清除已保存的密钥和连接设置？")) void action("forget"); }}>清除连接设置</button>
      </div>
      <p className="muted small">连接就绪表示隧道可用，仍需在 ChatGPT 中完成绑定并实际试读一张地图。电脑休眠时连接会暂停；菜单栏中可重新打开、断开或完全退出应用。</p>
      <a className="small" onClick={e => openLink(e, "docs")} href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer">官方连接说明</a>
    </>}
  </section>;
}
