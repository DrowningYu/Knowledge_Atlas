"""Run the pinned runtime with a LOCAL control-plane fixture and real Atlas MCP.
This verifies wiring/health/auth; it does not claim a real ChatGPT account is bound.
"""
import http.server,json,os,pathlib,subprocess,sys,tempfile,threading,time,urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
exe='.exe' if os.name=='nt' else ''
target=sys.argv[1]
runtime=root/'src-tauri/binaries'/('tunnel-client-runtime-'+target+exe)
seen=[]
class Control(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  seen.append(self.path)
  assert self.headers.get('Authorization')=='Bearer test-runtime-key-123456789'
  time.sleep(.1)
  self.send_response(204);self.end_headers()
 do_GET=do_POST
 def log_message(self,*a):pass
mock=http.server.ThreadingHTTPServer(('127.0.0.1',0),Control)
threading.Thread(target=mock.serve_forever,daemon=True).start()
processes=[]
temp=tempfile.TemporaryDirectory()
try:
 tmp=pathlib.Path(temp.name)
 core=subprocess.Popen([str(root/'target/debug'/('atlas-server'+exe)),'--db',str(tmp/'atlas.sqlite'),'--port','38479','--token-file',str(tmp/'mcp.token')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 processes.append(core)
 deadline=time.monotonic()+15
 while not (tmp/'mcp.token').exists():
  assert core.poll() is None and time.monotonic()<deadline
  time.sleep(.1)
 token=(tmp/'mcp.token').read_text().strip()
 config={'config_version':1,'control_plane':{'base_url':f'http://127.0.0.1:{mock.server_port}','tunnel_id':'tunnel_0123456789abcdef0123456789abcdef','api_key':'env:ATLAS_TUNNEL_KEY'},'mcp':{'server_urls':[{'channel':'main','url':'http://127.0.0.1:38479/mcp'}],'extra_headers':{'Authorization':'env:ATLAS_MCP_AUTH'},'discovery_extra_headers':{'Authorization':'env:ATLAS_MCP_AUTH'},'startup_wait_timeout':'15s'},'health':{'listen_addr':'127.0.0.1:0','url_file':str(tmp/'health.url')},'admin_ui':{'open_browser':False},'log':{'level':'error','format':'json'}}
 (tmp/'runtime.json').write_text(json.dumps(config),encoding='utf-8')
 env={**os.environ,'ATLAS_TUNNEL_KEY':'test-runtime-key-123456789','ATLAS_MCP_AUTH':'Bearer '+token}
 with (tmp/'runtime.log').open('w') as log:
  child=subprocess.Popen([str(runtime),'run','--config',str(tmp/'runtime.json')],env=env,stdout=log,stderr=log)
  processes.append(child)
  health=None
  deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   assert child.poll() is None, (tmp/'runtime.log').read_text()
   try:
    url=(tmp/'health.url').read_text().strip().rstrip('/')
    from urllib.parse import urlsplit
    parts=urlsplit(url);url=f'{parts.scheme}://{parts.netloc}/health?details=true'
    health=json.load(urllib.request.urlopen(url,timeout=2))
    if health['ready'] and health['components']['control-plane']['status']=='ok': break
   except (OSError,KeyError,ValueError):pass
   time.sleep(.25)
  assert health and health['ready'] and health['components']['control-plane']['status']=='ok',health
  assert seen,'No successful control-plane poll'
  assert health['components']['mcp']['details']['startup_probe']['state']=='succeeded',health['components']['mcp']
  # The discovery/probe reached the authenticated real local MCP using env-only credentials.
  assert 'test-runtime-key' not in (tmp/'runtime.json').read_text()
  print('PASS: bundled runtime, loopback health, successful polling, authenticated real MCP startup probe')
finally:
 for p in reversed(processes):
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
 mock.shutdown();mock.server_close()
 temp.cleanup()
