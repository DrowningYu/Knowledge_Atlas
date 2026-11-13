export const CLOUD_URL = 'https://littlefish.sarl/atlas';
export type Account = { token: string; username: string; user_id: string };
export const isDesktop = '__TAURI_INTERNALS__' in window;
const key = 'atlas-cloud-session';
export function account(): Account | null {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}
export async function cloudRequest<T>(path: string, body?: unknown, token = account()?.token): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(CLOUD_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(token ? {Authorization:'Bearer '+token} : {}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:controller.signal,
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401 && token === account()?.token) {
        sessionStorage.removeItem(key);
        window.dispatchEvent(new Event('atlas-account-expired'));
      }
      throw new Error(data.error || '云端请求失败');
    }
    return data as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('云端连接超时，写入结果需刷新确认，请勿重复提交');
    throw e;
  } finally { clearTimeout(timer); }
}
export async function login(username: string, password: string, register: boolean) {
  const result = await cloudRequest<Account>('/auth/'+(register?'register':'login'),{username,password},'');
  sessionStorage.setItem(key,JSON.stringify(result));
  sessionStorage.removeItem('atlas-local-mode');
  return result;
}
export async function logout() {
  try { await cloudRequest('/auth/logout',{}); } finally { sessionStorage.removeItem(key); location.reload(); }
}
export function localMode() { return sessionStorage.getItem('atlas-local-mode') === 'yes'; }
export function chooseLocal() { sessionStorage.setItem('atlas-local-mode','yes'); location.reload(); }
export function chooseCloud() { sessionStorage.removeItem('atlas-local-mode'); location.reload(); }
