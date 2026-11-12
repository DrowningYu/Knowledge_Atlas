import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appDataDir, validateEndpoint } from '../plugins/knowledge-atlas/server/stdio.mjs';

for (const bad of ['https://example.com/mcp', 'http://127.0.0.1/api', 'http://127.0.0.1@evil.com/mcp', 'http://localhost/mcp?token=x']) assert.throws(() => validateEndpoint(bad));
assert.equal(validateEndpoint('http://127.0.0.1:38473/mcp'), 'http://127.0.0.1:38473/mcp');
assert.ok(appDataDir('darwin', {}, '/Users/test').endsWith('Library/Application Support/app.knowledgeatlas.desktop'));
assert.ok(appDataDir('win32', { APPDATA: '/test/Roaming' }, '/test').includes('Roaming'));
assert.ok(appDataDir('linux', { XDG_DATA_HOME: '/test/data' }, '/test').includes('/test/data/'));
const temp = await mkdtemp(path.join(tmpdir(), 'atlas-plugin-'));
const tokenFile = path.join(temp, 'mcp.token');
const port = Number(process.env.ATLAS_PLUGIN_TEST_PORT || 38475);
const url = `http://127.0.0.1:${port}/mcp`;
let service, adapter, token;
let seq = 0;
const pending = new Map();
let stderr = '';
function startAdapter(env = {}) {
  const child = spawn(process.execPath, ['plugins/knowledge-atlas/server/stdio.mjs'], {
    env: { ...process.env, ATLAS_DATA_DIR: temp, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line);
    const waiter = pending.get(reply.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(reply.id); waiter.resolve(reply); }
  });
  return child;
}
async function call(method, params = {}, notification = false) {
  const id = ++seq;
  const message = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, params };
  const result = notification ? undefined : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Timed out: ' + method)); }, 30000);
    pending.set(id, { resolve, timer });
  });
  adapter.stdin.write(JSON.stringify(message) + '\n');
  return result;
}
async function tool(name, args = {}) {
  const reply = await call('tools/call', { name, arguments: args });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
  return JSON.parse(reply.result.content.find(x => x.type === 'text').text);
}
try {
  const binary = path.resolve('target/debug/atlas-server' + (process.platform === 'win32' ? '.exe' : ''));
  service = spawn(binary, ['--db', path.join(temp, 'atlas.sqlite'), '--port', String(port), '--token-file', tokenFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  service.stderr.on('data', () => {});
  for (let i = 0; i < 150; i++) {
    try { token = (await readFile(tokenFile, 'utf8')).trim(); if ((await fetch(url.replace('/mcp', '/healthz'))).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(token);
  await writeFile(path.join(temp, 'mcp-endpoint.json'), JSON.stringify({ url }));
  adapter = startAdapter();
  const initialized = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'atlas-plugin-test', version: '1' } });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  await call('notifications/initialized', {}, true);
  const discovered = await call('tools/list');
  assert.equal(discovered.result.tools.length, 6);
  assert.equal(discovered.result.tools.find(t => t.name === 'get_map').annotations.readOnlyHint, true);
  const maps = await tool('list_maps');
  assert.ok(maps.some(m => m.id === 'pid-control'));
  let graph = await tool('create_map', { title: 'Plugin roundtrip', target: 'A local concept' });
  graph = await tool('get_map', { map_id: graph.id });
  const node = { ...graph.nodes[0], notes: 'Saved through packaged stdio → HTTP MCP adapter', status: 'learning' };
  const updated = await tool('apply_graph_patch', { map_id: graph.id, expected_version: graph.version, operations: [{ op: 'upsert_node', node }] });
  assert.ok(updated.version > graph.version);
  const reread = await tool('get_node', { map_id: graph.id, node_id: node.id });
  assert.equal(reread.notes, node.notes);
  const stale = await call('tools/call', { name: 'apply_graph_patch', arguments: { map_id: graph.id, expected_version: graph.version, operations: [{ op: 'rename_map', title: 'Must not apply' }] } });
  assert.equal(stale.result.isError, true);
  assert.equal((await tool('get_map', { map_id: graph.id })).title, 'Plugin roundtrip');
  const exported = await tool('export_outline', { map_id: graph.id, format: 'markdown' });
  assert.ok(JSON.stringify(exported).includes('Plugin roundtrip'));
  // Restart adapter: missing/wrong credentials return actionable errors without leaking secrets.
  adapter.kill();
  adapter = startAdapter({ ATLAS_TOKEN_FILE: path.join(temp, 'missing') });
  const missing = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(missing.error.message, /ATLAS_TOKEN_MISSING/);
  adapter.kill();
  const wrongFile = path.join(temp, 'wrong');
  await writeFile(wrongFile, 'x'.repeat(64));
  adapter = startAdapter({ ATLAS_TOKEN_FILE: wrongFile });
  const denied = await call('tools/list');
  assert.match(denied.error.message, /ATLAS_UNAUTHORIZED/);
  assert.ok(!JSON.stringify({ missing, denied, stderr }).includes(token));
  console.log('PASS: six MCP tools, initialize/session/SSE, create/read/write/export, stale-version refusal, discovery, credential failures, loopback validation');
} finally {
  adapter?.kill(); service?.kill();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  await new Promise(r => setTimeout(r, 300));
  await rm(temp, { recursive: true, force: true });
}
