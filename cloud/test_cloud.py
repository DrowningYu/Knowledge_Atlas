import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from aiohttp.test_utils import TestClient, TestServer
sys.path.insert(0,str(Path(__file__).parent))
from server import Cloud, digest

BINARY=os.environ.get('ATLAS_SERVER_BIN',str(Path(__file__).resolve().parents[1]/'target/debug/atlas-server'))
PASSWORD='test-password-only-123'
CALLBACK='https://client.example/callback'

class CloudTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.cloud=Cloud(self.tmp.name,BINARY,'https://cloud.example/atlas',[CALLBACK])
        self.client=TestClient(TestServer(self.cloud.app()))
        await self.client.start_server()
        self.a=await self.register('alice')
        self.b=await self.register('bravo')
    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()
    async def register(self, username):
        r=await self.client.post('/atlas/auth/register',json={'username':username,'password':PASSWORD})
        self.assertEqual(r.status,200,await r.text())
        return await r.json()
    def headers(self,a):
        return {'Authorization':'Bearer '+a['token']}
    async def api(self,a,method,params=None):
        return await self.client.post('/atlas/api',headers=self.headers(a),json={'method':method,'params':params or {}})
    async def grant(self,a):
        r=await self.client.post('/atlas/oauth/register',json={'redirect_uris':[CALLBACK],'token_endpoint_auth_method':'none'})
        client=(await r.json())['client_id']
        verifier='a'*64
        challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        p={'client_id':client,'redirect_uri':CALLBACK,'response_type':'code','scope':'atlas','resource':self.cloud.resource,'code_challenge':challenge,'code_challenge_method':'S256','state':'state-123'}
        r=await self.client.get('/atlas/oauth/authorize',params=p)
        self.assertEqual(r.status,200,await r.text())
        nonce=r.cookies['atlas_oauth_flow'].value
        r=await self.client.post('/atlas/oauth/authorize',data={'flow':nonce,'username':a['username'],'password':PASSWORD,'decision':'allow'},headers={'Cookie':'atlas_oauth_flow='+nonce,'Origin':self.cloud.origin},allow_redirects=False)
        self.assertEqual(r.status,302,await r.text())
        redirect=parse_qs(urlsplit(r.headers['Location']).query)
        self.assertEqual(redirect['state'],['state-123'])
        self.assertEqual(redirect['iss'],[self.cloud.public])
        return {'grant_type':'authorization_code','client_id':client,'redirect_uri':CALLBACK,'code':redirect['code'][0],'code_verifier':verifier,'resource':self.cloud.resource}
    async def token(self,p):
        return await self.client.post('/atlas/oauth/token',data=p)
    async def mcp(self,a,method,params,session=None):
        h={**self.headers(a),'Accept':'application/json, text/event-stream','Content-Type':'application/json'}
        if session:h['MCP-Session-Id']=session
        r=await self.client.post('/atlas/mcp',headers=h,json={'jsonrpc':'2.0','id':1,'method':method,'params':params})
        text=await r.text()
        if text.startswith('event:') or text.startswith('data:'):
            lines=[l[5:].strip() for l in text.splitlines() if l.startswith('data:')]
            value=json.loads(lines[-1])
        else:
            try:value=json.loads(text)
            except ValueError:value=text
        return r,value
    async def initialize(self,a):
        r,v=await self.mcp(a,'initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'cloud-test','version':'1'}})
        self.assertEqual(r.status,200,v)
        return r.headers.get('Mcp-Session-Id')
    async def test_accounts_isolation_conflicts_and_logout(self):
        r=await self.api(self.a,'create_map',{'title':'Private A','target':'Topic'})
        graph=await r.json();self.assertEqual(r.status,200,graph)
        r=await self.api(self.b,'list_maps');self.assertEqual(await r.json(),[])
        r=await self.api(self.b,'get_map',{'map_id':graph['id']});self.assertNotEqual(r.status,200)
        r=await self.api(self.b,'delete_map',{'map_id':graph['id'],'expected_version':graph['version']});self.assertNotEqual(r.status,200)
        patch={'map_id':graph['id'],'expected_version':graph['version'],'operations':[{'op':'rename_map','title':'Cloud changed'}]}
        r=await self.api(self.a,'apply_graph_patch',patch);self.assertEqual(r.status,200,await r.text())
        r=await self.api(self.a,'apply_graph_patch',patch);self.assertEqual(r.status,409)
        r=await self.api(self.a,'get_map',{'map_id':graph['id']});self.assertEqual((await r.json())['title'],'Cloud changed')
        await self.client.post('/atlas/auth/logout',headers=self.headers(self.a),json={})
        r=await self.api(self.a,'list_maps');self.assertEqual(r.status,401)
        r=await self.client.post('/atlas/auth/login',json={'username':'alice','password':PASSWORD})
        a2=await r.json()
        r=await self.api(a2,'list_maps');self.assertEqual(len(await r.json()),1)
        # Credentials stored only as hashes.
        row=self.cloud.db.execute('SELECT password FROM users WHERE username=?',('alice',)).fetchone()
        self.assertTrue(row['password'].startswith('$argon2id$'))
        self.assertFalse(self.cloud.db.execute('SELECT 1 FROM tokens WHERE hash=?',(a2['token'],)).fetchone())
    async def test_oauth_pkce_single_use_refresh_scope_and_revoke(self):
        p=await self.grant(self.a)
        r=await self.token({**p,'code_verifier':'b'*64});self.assertEqual(r.status,400)
        r=await self.token({**p,'resource':'https://evil.example/mcp'});self.assertEqual(r.status,400)
        r=await self.token(p);self.assertEqual(r.status,200,await r.text());t=await r.json()
        r=await self.token(p);self.assertEqual(r.status,400)
        oauth={'token':t['access_token']}
        sid=await self.initialize(oauth)
        r,result=await self.mcp(oauth,'tools/call',{'name':'create_map','arguments':{'title':'From plugin','target':'Topic'}},sid)
        self.assertEqual(r.status,200,result);self.assertFalse(result['result'].get('isError',False),result)
        r=await self.api(self.a,'list_maps');self.assertEqual((await r.json())[0]['title'],'From plugin')
        r=await self.api(self.b,'list_maps');self.assertEqual(await r.json(),[])
        # Session IDs from A cannot be used against B's MCP session manager.
        r,result=await self.mcp(self.b,'tools/list',{},sid);self.assertNotEqual(r.status,200,result)
        refresh={'grant_type':'refresh_token','refresh_token':t['refresh_token'],'client_id':p['client_id'],'resource':self.cloud.resource}
        r=await self.token({**refresh,'client_id':'wrong'});self.assertEqual(r.status,400)
        r=await self.token(refresh);self.assertEqual(r.status,200);new=await r.json()
        r=await self.token(refresh);self.assertEqual(r.status,400)
        r,_=await self.mcp(oauth,'tools/list',{},sid);self.assertEqual(r.status,401)
        await self.client.post('/atlas/auth/revoke',json={},headers=self.headers(self.a))
        r=await self.token({**refresh,'refresh_token':new['refresh_token']});self.assertEqual(r.status,400)
        r,_=await self.mcp({'token':new['access_token']},'tools/list',{},sid);self.assertEqual(r.status,401)
    async def test_discovery_origin_redirect_csrf_and_limits(self):
        r=await self.client.get('/atlas/mcp');self.assertEqual(r.status,401);self.assertIn('resource_metadata',r.headers['WWW-Authenticate'])
        r=await self.client.get('/.well-known/oauth-authorization-server/atlas');self.assertEqual((await r.json())['issuer'],self.cloud.public)
        r=await self.client.post('/atlas/oauth/register',json={'redirect_uris':['https://evil.example/callback']});self.assertEqual(r.status,400)
        r=await self.client.post('/atlas/auth/login',json={},headers={'Origin':'https://evil.example'});self.assertEqual(r.status,403)
        r=await self.client.post('/atlas/oauth/authorize',data={'flow':'forged','username':'alice','password':PASSWORD});self.assertEqual(r.status,403)
        r=await self.client.post('/atlas/api',json={'method':'list_maps'},headers={**self.headers(self.a),'Origin':'tauri://localhost'})
        self.assertEqual(r.status,200);self.assertEqual(r.headers['Access-Control-Allow-Origin'],'tauri://localhost')
        r=await self.client.post('/atlas/api',data='x'*(2*1024*1024+1),headers=self.headers(self.a));self.assertEqual(r.status,413)
        for _ in range(21):
            r=await self.client.post('/atlas/auth/login',json={})
        self.assertEqual(r.status,429)
    async def test_backend_restart_persists_data(self):
        r=await self.api(self.a,'create_map',{'title':'Persisted','target':'Root'});self.assertEqual(r.status,200)
        proc,_,_=self.cloud.backends[self.a['user_id']]
        proc.kill();await proc.wait()
        r=await self.api(self.a,'list_maps');self.assertEqual((await r.json())[0]['title'],'Persisted')

if __name__=='__main__':unittest.main(verbosity=2)
