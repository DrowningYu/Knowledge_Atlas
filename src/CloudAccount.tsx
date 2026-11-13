import React, {useEffect, useState} from 'react';
import {account, login, logout, cloudRequest, CLOUD_URL, isDesktop, localMode, chooseLocal, chooseCloud, type Account} from './cloud';
import type {Graph, MapSummary} from './api';

export function AccountGate({children}:{children:React.ReactNode}) {
  const [user,setUser]=useState<Account|null>(account());
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [register,setRegister]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  // Browser development keeps the existing local API flow. Production and desktop show login.
  const local = localMode() || (!isDesktop && !location.pathname.startsWith('/atlas'));
  useEffect(()=>{
    const expired=()=>{setUser(null);setError('登录已过期，请重新登录');};
    window.addEventListener('atlas-account-expired',expired);
    return ()=>window.removeEventListener('atlas-account-expired',expired);
  },[]);
  if (user || local) return <React.Fragment key={user?.user_id || 'local'}>{children}</React.Fragment>;
  return <main className="account-page"><form className="account-card" onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError('');
    try {const next=await login(username,password,register);setPassword('');setUser(next);} catch(e){setError(String(e));} finally{setBusy(false);}
  }}><span className="eyebrow">KNOWLEDGE ATLAS</span><h1>{register?'创建云端账号':'登录知识地图'}</h1>
  <p className="muted">插件更新云端地图，登录后在这里自动同步</p>
  <label className="field-label">用户名<input className="text-input" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} pattern="[a-zA-Z0-9_\-]{3,32}" title="3–32 位字母、数字、下划线或短横线" required /></label>
  <label className="field-label">密码<input className="text-input" type="password" autoComplete={register?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} minLength={10} maxLength={128} required /></label>
  {register && <p className="muted small">请保存好密码，目前不提供自助找回；云端数据按账号隔离，本地地图不会自动上传</p>}
  {error && <p role="alert" className="account-error">{error}</p>}
  <button className="button primary wide" disabled={busy}>{busy?'连接中…':register?'注册并登录':'登录'}</button>
  <button className="button subtle wide" type="button" disabled={busy} onClick={()=>{setRegister(!register);setError('');}}>{register?'已有账号，去登录':'没有账号，去注册'}</button>
  {isDesktop && <button className="button subtle wide" type="button" onClick={chooseLocal}>暂时使用本地地图</button>}
  <p className="muted small">登录仅保留在当前应用会话，退出应用后重新登录</p></form></main>;
}
export function CloudAccount() {
  const user=account();
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [confirmImport,setConfirmImport]=useState(false);
  const [confirmRevoke,setConfirmRevoke]=useState(false);
  if (!user) return <section className="cloud-account"><h3>云端账号</h3><p>登录后，插件和其他设备可以更新同一份云端地图</p><button className="button primary" onClick={chooseCloud}>登录 / 注册</button></section>;
  const migrate=async()=>{
    setBusy(true);setMessage('');
    try {
      const {invoke}=await import('@tauri-apps/api/core');
      const maps=await invoke<MapSummary[]>('api',{method:'list_maps',params:{}});
      let count=0,skipped=0;
      const cloudMaps=await cloudRequest<MapSummary[]>('/api',{method:'list_maps',params:{}});
      const existing=new Set(cloudMaps.map(m=>m.id));
      for(const map of maps){
        if(existing.has(map.id)){skipped++;continue;}
        const graph=await invoke<Graph>('api',{method:'get_map',params:{map_id:map.id}});
        await cloudRequest('/api',{method:'import_graph',params:{graph}});count++;
      }
      setMessage(`已导入 ${count} 张地图，跳过 ${skipped} 张同 ID 地图；原本地数据保留`);
    } catch(e){setMessage('导入中断，已成功上传的地图会保留，再次导入会跳过同 ID：'+String(e));}
    finally{setBusy(false);setConfirmImport(false);}
  };
  return <section className="cloud-account"><h3>云端账号 · {user.username}</h3><p className="muted">每 5 秒检查更新，修改确认保存到云端后生效</p>
    <label className="field-label">ChatGPT 插件地址</label><div className="code-box">{CLOUD_URL}/mcp</div>
    <p className="muted small">在 ChatGPT 添加远程 MCP，认证选择 OAuth，使用这里的账号登录授权。电脑关闭后仍可更新，重新打开 App 会读取最新数据</p>
    {isDesktop && <><button className="button" disabled={busy} onClick={()=>setConfirmImport(!confirmImport)}>导入本机地图到当前账号</button>{confirmImport && <div><p>将本机所有地图上传至 {user.username}，同 ID 地图跳过，原文件保留；历史撤销记录不迁移</p><button className="button primary" disabled={busy} onClick={()=>void migrate()}>{busy?'导入中…':'确认导入'}</button></div>}</>}
    <button className="button subtle" disabled={busy} onClick={()=>setConfirmRevoke(!confirmRevoke)}>撤销插件授权</button>
    {confirmRevoke && <div><p>所有已连接的插件都需要重新授权</p><button className="button" onClick={()=>void cloudRequest('/auth/revoke',{}).then(()=>{setConfirmRevoke(false);setMessage('插件授权已撤销');}).catch(e=>setMessage(String(e)))}>确认撤销</button></div>}
    <button className="button subtle" disabled={busy} onClick={()=>void logout()}>退出账号</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
