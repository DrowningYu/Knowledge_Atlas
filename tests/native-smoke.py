#!/usr/bin/env python3
"""Linux release smoke via WebKitWebDriver + genuine MCP. Use a disposable XDG_DATA_HOME.
Start WebKitWebDriver with TAURI_WEBVIEW_AUTOMATION=true, then:
  python3 tests/native-smoke.py http://127.0.0.1:4446 /absolute/path/knowledge-atlas
"""
import base64,ctypes as C,json,os,pathlib,sys,time,urllib.request
DRIVER=sys.argv[1].rstrip('/')
BINARY=str(pathlib.Path(sys.argv[2]).resolve())
OUT=pathlib.Path('artifacts/native-smoke');OUT.mkdir(parents=True,exist_ok=True)
def request(path,body=None,method=None):
 req=urllib.request.Request(DRIVER+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(req,timeout=30) as r:
  result=json.load(r)['value']
  assert not isinstance(result,dict) or 'error' not in result,result
  return result
sid=request('/session',{'capabilities':{'alwaysMatch':{'webkitgtk:browserOptions':{'binary':BINARY}}}})['sessionId']
def wd(path,body=None,method=None):return request('/session/'+sid+path,body,method)
def js(script,*args):return wd('/execute/sync',{'script':script,'args':list(args)})
def api(method,params={}):
 result=wd('/execute/async',{'script':"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('api',{method:arguments[0],params:arguments[1]}).then(value=>done({value})).catch(error=>done({error:String(error)}))",'args':[method,params]})
 assert 'error' not in result,result
 return result['value']
def until(fn,label):
 end=time.time()+20
 while time.time()<end:
  try:
   value=fn()
   if value:return value
  except Exception:pass
  time.sleep(.1)
 raise AssertionError(label)
def visible():return js("return [...document.querySelectorAll('.react-flow__node')].map(n=>({visible:getComputedStyle(n).visibility==='visible',height:n.getBoundingClientRect().height,pointer:getComputedStyle(n).pointerEvents,text:n.innerText}))")
def click(selector):
 element=wd('/element',{'using':'css selector','value':selector})['element-6066-11e4-a52e-4f735466cecf']
 return wd('/element/'+element+'/click',{})
def screenshot(name): (OUT/name).write_bytes(base64.b64decode(wd('/screenshot')))
try:
 until(lambda:js("return !!document.querySelector('.graph-panel')"),'root not loaded')
 g=api('get_map',{'map_id':'pid-control'})
 assert len(visible())==1 and all(n['visible'] and n['height']>100 and n['pointer']!='none' for n in visible())
 click('.concept-row .row-copy')
 until(lambda:len(visible())==2 and all(n['visible'] for n in visible()),'native root expansion')
 click('[data-testid="panel-1"] .concept-row .row-copy')
 until(lambda:len(visible())==3 and all(n['visible'] for n in visible()),'native nested expansion')
 screenshot('release-progressive.png')
 info=api('connection_info'); endpoint=info['url'];token=info['token'];session=None;rid=0;protocol='2025-03-26'
 def rpc(method,params,notice=False):
  global session,rid,protocol
  rid+=1;body={'jsonrpc':'2.0','method':method,'params':params}
  if not notice:body['id']=rid
  headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
  if session:headers.update({'Mcp-Session-Id':session,'MCP-Protocol-Version':protocol})
  with urllib.request.urlopen(urllib.request.Request(endpoint,data=json.dumps(body).encode(),headers=headers),timeout=20) as r:
   session=r.headers.get('Mcp-Session-Id',session);text=r.read().decode()
   if notice:return
   if r.headers.get('Content-Type','').startswith('text/event-stream'):
    replies=[json.loads(l[5:].strip()) for l in text.splitlines() if l.startswith('data:') and l[5:].strip()]
    response=next(i for i in replies if i.get('id')==rid)
   else:response=json.loads(text)
   assert 'error' not in response,response
   return response['result']
 protocol=rpc('initialize',{'protocolVersion':protocol,'capabilities':{},'clientInfo':{'name':'native-webdriver-test','version':'1.0'}})['protocolVersion']
 rpc('notifications/initialized',{},True)
 selected=js("return document.querySelector('.id-copy').innerText.trim()")
 g=api('get_map',{'map_id':'pid-control'});node=next(n for n in g['nodes'] if n['id']==selected)
 node['summary']='Native MCP → SQLite → Tauri event → visible panels verified'
 result=rpc('tools/call',{'name':'apply_graph_patch','arguments':{'map_id':g['id'],'expected_version':g['version'],'operations':[{'op':'upsert_node','node':node}]}})
 assert not result.get('isError'),result
 until(lambda:js("return document.querySelector('[aria-label=\"节点摘要\"]').value")==node['summary'],'native MCP inspector refresh')
 until(lambda:len(visible())==3 and all(n['visible'] and n['height']>100 for n in visible()),'native MCP panels remain visible')
 screenshot('release-mcp-updated.png')
 assert api('get_node',{'map_id':g['id'],'node_id':node['id']})['summary']==node['summary']
 # Native input via real WebDriver keystrokes must autosave through Tauri IPC.
 element=wd('/element',{'using':'css selector','value':'[aria-label="节点标题"]'})['element-6066-11e4-a52e-4f735466cecf']
 wd('/element/'+element+'/clear',{})
 wd('/element/'+element+'/value',{'text':'Native saved concept'})
 until(lambda:api('get_node',{'map_id':g['id'],'node_id':node['id']})['title']=='Native saved concept','native input autosave')
 until(lambda:all(n['visible'] for n in visible()),'native panels remain visible after edit')
 # Exercise the actual native clipboard and GTK save dialog on an isolated display.
 if os.environ.get('ATLAS_TEST_NATIVE_DIALOG')=='1':
  dest=(OUT/'native-save.json').resolve()
  candidates=[dest,pathlib.Path(str(dest)+'.json')]
  for candidate in candidates:
   if candidate.exists():candidate.unlink()
  saved=wd('/execute/async',{'script':"const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('copy_text',{text:arguments[0]}).then(()=>{window.__saveResult='pending';window.__TAURI_INTERNALS__.invoke('save_export',{name:'native-save',data:[123,125]}).then(v=>window.__saveResult=v).catch(e=>window.__saveResult=String(e));done(true)}).catch(e=>done(String(e)))",'args':[str(dest)]})
  assert saved is True,saved
  time.sleep(2)
  x=C.CDLL('libX11.so.6');t=C.CDLL('libXtst.so.6')
  x.XOpenDisplay.argtypes=[C.c_char_p];x.XOpenDisplay.restype=C.c_void_p
  d=x.XOpenDisplay(os.environ['DISPLAY'].encode())
  x.XKeysymToKeycode.argtypes=[C.c_void_p,C.c_ulong];x.XKeysymToKeycode.restype=C.c_uint
  x.XFlush.argtypes=[C.c_void_p];t.XTestFakeKeyEvent.argtypes=[C.c_void_p,C.c_uint,C.c_int,C.c_ulong]
  x.XDefaultRootWindow.argtypes=[C.c_void_p];x.XDefaultRootWindow.restype=C.c_ulong
  x.XQueryTree.argtypes=[C.c_void_p,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.POINTER(C.c_ulong)),C.POINTER(C.c_uint)]
  x.XFetchName.argtypes=[C.c_void_p,C.c_ulong,C.POINTER(C.c_char_p)]
  x.XRaiseWindow.argtypes=[C.c_void_p,C.c_ulong];x.XSetInputFocus.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_ulong]
  root=C.c_ulong();parent=C.c_ulong();children=C.POINTER(C.c_ulong)();count=C.c_uint()
  x.XQueryTree(d,x.XDefaultRootWindow(d),C.byref(root),C.byref(parent),C.byref(children),C.byref(count))
  for i in range(count.value):
   name=C.c_char_p();x.XFetchName(d,children[i],C.byref(name))
   if name.value and (b'Save' in name.value or '保存'.encode() in name.value):
    x.XRaiseWindow(d,children[i]);x.XSetInputFocus(d,children[i],2,0);x.XFlush(d)
  def key(sym,down):t.XTestFakeKeyEvent(d,x.XKeysymToKeycode(d,sym),down,0);x.XFlush(d)
  for letter in ['a','v']:
   key(0xffe3,1);key(ord(letter),1);key(ord(letter),0);key(0xffe3,0);time.sleep(.2)
  key(0xff0d,1);key(0xff0d,0)
  time.sleep(.5)
  saved_path=until(lambda:next((candidate for candidate in candidates if candidate.exists()),None),'native save dialog did not write file')
  assert saved_path.read_text()=='{}'
  until(lambda:js('return window.__saveResult') is True,'native save result')
 # Release restart retains saved nodes; persistent history still works.
 wd('',method='DELETE')
 sid=request('/session',{'capabilities':{'alwaysMatch':{'webkitgtk:browserOptions':{'binary':BINARY}}}})['sessionId']
 until(lambda:js("return !!document.querySelector('.graph-panel')"),'release restart')
 assert api('get_node',{'map_id':g['id'],'node_id':node['id']})['title']=='Native saved concept'
 api('undo',{'map_id':g['id']});api('redo',{'map_id':g['id']})
 assert api('get_node',{'map_id':g['id'],'node_id':node['id']})['title']=='Native saved concept'
 result={'release_startup':'PASS','native_click_expansion':'PASS','native_input_sqlite_autosave':'PASS','external_mcp_native_realtime':'PASS','restart_persistence_undo_redo':'PASS','native_save_clipboard':'PASS' if os.environ.get('ATLAS_TEST_NATIVE_DIALOG')=='1' else 'not run','expanded_panels_after_mcp':3,'visible_panels_after_restart':len(visible()),'protocol':protocol}
 (OUT/'native-result.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result))
finally:
 wd('',method='DELETE')
