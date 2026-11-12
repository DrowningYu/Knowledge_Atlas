#!/usr/bin/env python3
"""Mutate a disposable native demo through standard MCP; never logs the token."""
import json,urllib.request,sys
base=sys.argv[1].rstrip('/')
token=open(sys.argv[2]).read().strip()
session=None;rid=0
version='2025-03-26'
def rpc(method,params,notice=False):
 global session,rid,version
 rid+=1
 body={'jsonrpc':'2.0','method':method,'params':params}
 if not notice:body['id']=rid
 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
 if session:headers.update({'Mcp-Session-Id':session,'MCP-Protocol-Version':version})
 req=urllib.request.Request(base+'/mcp',data=json.dumps(body).encode(),headers=headers)
 with urllib.request.urlopen(req,timeout=15) as response:
  session=response.headers.get('Mcp-Session-Id',session)
  text=response.read().decode()
  if notice:return
  if response.headers.get('Content-Type','').startswith('text/event-stream'):
   items=[json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith('data:') and line[5:].strip()]
   result=next(i for i in items if i.get('id')==rid)
  else:result=json.loads(text)
  assert 'error' not in result,result
  return result['result']
def tool(name,args):
 result=rpc('tools/call',{'name':name,'arguments':args})
 assert not result.get('isError'),result
 return json.loads(next(c['text'] for c in result['content'] if c['type']=='text'))
result=rpc('initialize',{'protocolVersion':version,'capabilities':{},'clientInfo':{'name':'native-smoke','version':'1.0'}})
version=result['protocolVersion']
rpc('notifications/initialized',{},True)
g=tool('get_map',{'map_id':'pid-control'})
n=next(n for n in g['nodes'] if n['id']==g['root_id'])
n['title']='PID · Native MCP verified'
n['summary']='Updated through MCP; native UI receives the committed SQLite change.'
g2=tool('apply_graph_patch',{'map_id':g['id'],'expected_version':g['version'],'operations':[{'op':'upsert_node','node':n}]})
assert g2['version']==g['version']+1
print(json.dumps({'protocol':version,'map_id':g['id'],'version':g2['version'],'native_mcp_patch':'PASS'}))
