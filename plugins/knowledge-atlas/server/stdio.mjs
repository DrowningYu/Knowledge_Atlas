#!/usr/bin/env node
// No external dependencies. Transports MCP only; never accesses the SQLite database.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function appDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'app.knowledgeatlas.desktop');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'app.knowledgeatlas.desktop');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'app.knowledgeatlas.desktop');
}

export function validateEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password)
    throw new Error('ATLAS_ENDPOINT_INVALID: Only a loopback HTTP /mcp address is allowed');
  return url.href;
}
async function connection() {
  const dir = process.env.ATLAS_DATA_DIR || appDataDir();
  let endpoint = process.env.ATLAS_MCP_URL;
  if (!endpoint) {
    try { endpoint = JSON.parse(await readFile(path.join(dir, 'mcp-endpoint.json'), 'utf8')).url; }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('ATLAS_ENDPOINT_INVALID: Check the app connection settings'); }
  }
  const url = validateEndpoint(endpoint || 'http://127.0.0.1:38473/mcp');
  let token;
  try { token = (await readFile(process.env.ATLAS_TOKEN_FILE || path.join(dir, 'mcp.token'), 'utf8')).trim(); }
  catch { throw new Error('ATLAS_TOKEN_MISSING: Open Knowledge Atlas first, or set ATLAS_TOKEN_FILE locally'); }
  if (token.length < 32 || /\s/.test(token)) throw new Error('ATLAS_TOKEN_INVALID: Check the local token file');
  return { url, token };
}

let session, protocol, endpoint;
async function rpc(message) {
  const current = await connection();
  if (endpoint && endpoint !== current.url && message.method !== 'initialize') {
    throw new Error('ATLAS_RECONNECT: App endpoint changed; reconnect the plugin');
  }
  endpoint = current.url;
  if (message.method === 'initialize') session = undefined;
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${current.token}`,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}) },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    // Do not return response bodies: they may contain request data or authentication details.
    await response.body?.cancel();
    if (response.status === 401) throw new Error('ATLAS_UNAUTHORIZED: Token does not match the running app');
    if (response.status === 404) throw new Error('ATLAS_RECONNECT: MCP session expired; reconnect the plugin');
    throw new Error(`ATLAS_HTTP_${response.status}: Local MCP request failed`);
  }
  if (response.headers.has('mcp-session-id')) session = response.headers.get('mcp-session-id');
  if (!Object.hasOwn(message, 'id')) { await response.body?.cancel(); return; }
  let result;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', bytes = 0;
    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Error('ATLAS_RESPONSE_TOO_LARGE');
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const packet = JSON.parse(data);
          if (packet.id === message.id) { result = packet; break outer; }
          if (packet.method && !Object.hasOwn(packet, 'id')) process.stdout.write(JSON.stringify(packet) + '\n');
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } else { result = await response.json(); }
  if (!result || result.id !== message.id) throw new Error('ATLAS_PROTOCOL_ERROR: Missing matching MCP reply');
  if (message.method === 'initialize') protocol = result.result?.protocolVersion;
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Preserve initialize -> initialized -> tool-call ordering, even when piped together.
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) + '\n'); continue; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid MCP request' } }) + '\n'); continue;
    }
    try { await rpc(message); }
    catch (e) {
      const reason = typeof e.message === 'string' && /^ATLAS_[A-Z_0-9]+(?::|$)/.test(e.message)
        ? e.message : 'ATLAS_UNAVAILABLE: Keep Knowledge Atlas running and reconnect; do not retry writes blindly';
      if (Object.hasOwn(message, 'id')) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: reason } }) + '\n');
      else process.stderr.write(reason + '\n');
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
