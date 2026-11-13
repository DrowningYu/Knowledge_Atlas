#!/usr/bin/env python3
"""Account gateway. Each account owns a separate loopback Atlas store and MCP session manager."""
import asyncio
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.parse import urlencode, urlsplit

from aiohttp import web, ClientSession, ClientTimeout
from multidict import CIMultiDict
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError

PREFIX = '/atlas'
SCOPE = 'atlas'
CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect'
PASSWORDS = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=1)

def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()

def random_token():
    return secrets.token_urlsafe(32)

def failure(message, status=400):
    return web.json_response({'error': message}, status=status)

class Cloud:
    def __init__(self, directory, binary, public_url, extra_redirects=()):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.binary = str(Path(binary).resolve())
        self.public = public_url.rstrip('/')
        self.resource = self.public + '/mcp'
        u = urlsplit(self.public)
        self.origin = f'{u.scheme}://{u.netloc}'
        self.redirects = {CHATGPT_CALLBACK, *extra_redirects}
        self.db = sqlite3.connect(self.directory / 'accounts.sqlite')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT);
        CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, user TEXT, kind TEXT, expires INTEGER, client TEXT, grant_id TEXT);
        CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, redirect TEXT);
        CREATE TABLE IF NOT EXISTS flows(hash TEXT PRIMARY KEY, params TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, user TEXT, params TEXT, expires INTEGER);
        ''')
        self.backends = {}
        self.backend_lock = asyncio.Lock()
        self.hash_limit = asyncio.Semaphore(2)
        self.buckets = {}
        self.client = None

    def limited(self, req, label, limit, seconds):
        # Only trust the local reverse proxy; it overwrites this header.
        peer = req.headers.get('X-Real-IP', req.remote or '') if req.remote in ('127.0.0.1', '::1') else req.remote
        key = (label, peer)
        now = time.time()
        if len(self.buckets) > 4096:
            self.buckets = {k:v for k,v in self.buckets.items() if v[1] > now}
            if len(self.buckets) > 4096:
                return True
        count, until = self.buckets.get(key, (0, now + seconds))
        if until <= now:
            count, until = 0, now + seconds
        self.buckets[key] = count + 1, until
        return count >= limit

    def issue(self, user, kind, lifetime, client='', grant=''):
        value = random_token()
        self.db.execute('INSERT INTO tokens VALUES(?,?,?,?,?,?)', (digest(value), user, kind, int(time.time())+lifetime, client, grant))
        return value

    def account(self, req, kinds=('app',)):
        value = req.headers.get('Authorization', '')
        if not value.startswith('Bearer '):
            return None
        row = self.db.execute('SELECT t.*,u.username FROM tokens t JOIN users u ON u.id=t.user WHERE hash=? AND expires>?', (digest(value[7:]), time.time())).fetchone()
        return row if row and row['kind'] in kinds else None

    async def credentials(self, username, password, register=False):
        if not isinstance(username, str) or not re.fullmatch(r'[a-zA-Z0-9_\-]{3,32}', username):
            raise ValueError('用户名须为 3–32 位字母、数字、下划线或短横线')
        if not isinstance(password, str) or not 10 <= len(password) <= 128:
            raise ValueError('密码须为 10–128 个字符')
        username = username.lower()
        if self.hash_limit.locked():
            raise ValueError('登录繁忙，请稍后重试')
        async with self.hash_limit:
            if register:
                if self.db.execute('SELECT count(*) FROM users').fetchone()[0] >= 100:
                    raise ValueError('注册名额已满，请联系管理员')
                encoded = await asyncio.to_thread(PASSWORDS.hash, password)
                user = secrets.token_hex(16)
                try:
                    self.db.execute('INSERT INTO users VALUES(?,?,?)', (user, username, encoded))
                    self.db.commit()
                except sqlite3.IntegrityError:
                    raise ValueError('用户名不可用') from None
                return user, username
            row = self.db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            # Use the same expensive verification for unknown accounts.
            encoded = row['password'] if row else self.dummy_hash
            try:
                await asyncio.to_thread(PASSWORDS.verify, encoded, password)
            except VerificationError:
                raise ValueError('用户名或密码错误') from None
            if not row:
                raise ValueError('用户名或密码错误')
            return row['id'], row['username']

    async def auth(self, req):
        register = req.path.endswith('/register')
        if self.limited(req, 'register' if register else 'login', 5 if register else 20, 3600 if register else 900):
            return failure('尝试过于频繁，请稍后重试', 429)
        p = await req.json()
        user, username = await self.credentials(p.get('username'), p.get('password'), register)
        token = self.issue(user, 'app', 7*86400)
        self.db.commit()
        return web.json_response({'token': token, 'username': username, 'user_id': user, 'expires_in': 7*86400})

    async def me(self, req):
        a = self.account(req)
        if not a:
            return failure('请重新登录', 401)
        return web.json_response({'username': a['username'], 'user_id': a['user']})

    async def logout(self, req):
        a = self.account(req)
        if a:
            self.db.execute('DELETE FROM tokens WHERE hash=?', (a['hash'],))
            self.db.commit()
        return web.json_response({'ok': True})

    async def revoke(self, req):
        a = self.account(req)
        if not a:
            return failure('请重新登录', 401)
        self.db.execute("DELETE FROM tokens WHERE user=? AND kind IN ('access','refresh')", (a['user'],))
        self.db.execute('DELETE FROM codes WHERE user=?', (a['user'],))
        self.db.commit()
        return web.json_response({'ok': True})

    async def metadata(self, req):
        if 'oauth-protected-resource' in req.path:
            return web.json_response({'resource': self.resource, 'authorization_servers': [self.public], 'scopes_supported': [SCOPE], 'bearer_methods_supported': ['header']})
        return web.json_response({'issuer': self.public, 'authorization_endpoint': self.public+'/oauth/authorize', 'token_endpoint': self.public+'/oauth/token', 'registration_endpoint': self.public+'/oauth/register', 'response_types_supported': ['code'], 'grant_types_supported': ['authorization_code','refresh_token'], 'token_endpoint_auth_methods_supported': ['none'], 'code_challenge_methods_supported': ['S256'], 'scopes_supported': [SCOPE], 'authorization_response_iss_parameter_supported': True})

    async def register_client(self, req):
        if self.limited(req, 'dcr', 20, 3600):
            return failure('too_many_requests', 429)
        p = await req.json()
        redirects = p.get('redirect_uris')
        if not isinstance(redirects, list) or len(redirects) != 1 or redirects[0] not in self.redirects:
            return failure('invalid_redirect_uri')
        if p.get('token_endpoint_auth_method', 'none') != 'none':
            return failure('invalid_client_metadata')
        # DCR requests for the same callback reuse a stable public client, bounded storage.
        row = self.db.execute('SELECT id FROM clients WHERE redirect=?', (redirects[0],)).fetchone()
        client = row['id'] if row else random_token()
        if not row:
            self.db.execute('INSERT INTO clients VALUES(?,?)', (client, redirects[0]))
            self.db.commit()
        return web.json_response({'client_id': client, 'redirect_uris': redirects, 'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code','refresh_token'], 'response_types': ['code']}, status=201)

    def valid_authorization(self, p):
        client = self.db.execute('SELECT redirect FROM clients WHERE id=?', (p.get('client_id',''),)).fetchone()
        if not client or p.get('redirect_uri') != client['redirect']:
            raise ValueError('无效的客户端或回调地址')
        if p.get('response_type') != 'code' or p.get('code_challenge_method') != 'S256' or not re.fullmatch(r'[A-Za-z0-9_-]{43}', p.get('code_challenge','')):
            raise ValueError('需要授权码和 S256 PKCE')
        if p.get('resource') != self.resource or p.get('scope', SCOPE) != SCOPE:
            raise ValueError('无效的授权资源或权限')
        if len(p.get('state','')) > 2048:
            raise ValueError('无效的 state')

    async def authorize(self, req):
        if self.limited(req, 'authorize', 30, 900):
            return failure('尝试过于频繁，请稍后重试', 429)
        if req.method == 'GET':
            p = dict(req.query)
            self.valid_authorization(p)
            nonce = random_token()
            self.db.execute('DELETE FROM flows WHERE expires<?', (time.time(),))
            self.db.execute('INSERT INTO flows VALUES(?,?,?)', (digest(nonce),json.dumps(p),int(time.time())+600))
            self.db.commit()
            page = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>授权知识地图</title>
            <style>body{font:16px system-ui;background:#f5f3ed;color:#253830;max-width:440px;margin:10vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0}button{background:#2a6650;color:white;border:0;border-radius:8px}p{line-height:1.7}</style>
            <h1>连接你的知识地图</h1><p>授权后，ChatGPT 可以读取、新建和修改你云端账号中的知识地图。不会访问其他用户或电脑本地的数据</p>
            <form method="post"><input type="hidden" name="flow" value="NONCE"><label>用户名<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="10" maxlength="128"></label><button name="decision" value="allow">登录并授权</button><button name="decision" value="deny" formnovalidate>取消</button></form><p>没有账号？先在 App 或 <a href="/atlas/" target="_blank" rel="noopener">云端页面</a>注册，再回来授权</p>'''.replace('NONCE',html.escape(nonce))
            r = web.Response(text=page, content_type='text/html')
            r.set_cookie('atlas_oauth_flow', nonce, httponly=True, secure=self.public.startswith('https:'), samesite='Lax', path=PREFIX+'/oauth/authorize', max_age=600)
            return r
        f = await req.post()
        nonce = f.get('flow','')
        if not nonce or not secrets.compare_digest(nonce, req.cookies.get('atlas_oauth_flow','')):
            return failure('授权页面已过期，请重新连接', 403)
        row = self.db.execute('SELECT params FROM flows WHERE hash=? AND expires>?', (digest(nonce), time.time())).fetchone()
        if not row:
            return failure('授权页面已过期，请重新连接', 403)
        p = json.loads(row['params'])
        self.valid_authorization(p)
        if f.get('decision') == 'deny':
            result = {'error':'access_denied'}
        else:
            user, _ = await self.credentials(f.get('username'),f.get('password'))
            # Recheck and consume after password hashing yields to other requests.
            changed = self.db.execute('DELETE FROM flows WHERE hash=? AND expires>?', (digest(nonce), time.time())).rowcount
            if changed != 1:
                return failure('授权页面已使用', 403)
            code = random_token()
            self.db.execute('INSERT INTO codes VALUES(?,?,?,?)',(digest(code),user,json.dumps(p),int(time.time())+120))
            result = {'code':code}
        self.db.execute('DELETE FROM flows WHERE hash=?',(digest(nonce),))
        self.db.commit()
        result.update({'state':p.get('state',''),'iss':self.public})
        r = web.HTTPFound(p['redirect_uri']+'?'+urlencode(result))
        r.del_cookie('atlas_oauth_flow',path=PREFIX+'/oauth/authorize')
        return r

    async def exchange(self, req):
        if self.limited(req, 'exchange', 120, 900):
            return failure('too_many_requests',429)
        p = await req.post()
        client = p.get('client_id','')
        if p.get('resource') != self.resource:
            return failure('invalid_target')
        if p.get('grant_type') == 'authorization_code':
            row = self.db.execute('SELECT * FROM codes WHERE hash=? AND expires>?',(digest(p.get('code','')),time.time())).fetchone()
            if not row:
                return failure('invalid_grant')
            original = json.loads(row['params'])
            verifier = p.get('code_verifier','')
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
            if not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}',verifier) or client != original['client_id'] or p.get('redirect_uri') != original['redirect_uri'] or not secrets.compare_digest(challenge,original['code_challenge']):
                return failure('invalid_grant')
            self.db.execute('DELETE FROM codes WHERE hash=?',(row['hash'],))
            user, grant = row['user'], random_token()
        elif p.get('grant_type') == 'refresh_token':
            row = self.db.execute("SELECT * FROM tokens WHERE hash=? AND kind='refresh' AND expires>?",(digest(p.get('refresh_token','')),time.time())).fetchone()
            if not row or client != row['client']:
                return failure('invalid_grant')
            user, grant = row['user'],row['grant_id']
            self.db.execute('DELETE FROM tokens WHERE grant_id=?',(grant,))
        else:
            return failure('unsupported_grant_type')
        access = self.issue(user,'access',3600,client,grant)
        refresh = self.issue(user,'refresh',30*86400,client,grant)
        self.db.commit()
        return web.json_response({'access_token':access,'refresh_token':refresh,'token_type':'Bearer','expires_in':3600,'scope':SCOPE})

    async def backend(self, user):
        async with self.backend_lock:
            item = self.backends.get(user)
            if item and item[0].returncode is None:
                return item
            path = self.directory / 'users' / user
            path.mkdir(parents=True,exist_ok=True,mode=0o700)
            proc = await asyncio.create_subprocess_exec(self.binary,'--db',str(path/'atlas.sqlite'),'--token-file',str(path/'atlas.token'),'--port','0','--no-demo',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
            try:
                line = await asyncio.wait_for(proc.stdout.readline(),15)
                url = line.decode().strip()
                if not re.fullmatch(r'http://127\.0\.0\.1:\d+',url):
                    raise RuntimeError('后台数据服务启动失败')
                token = (path/'atlas.token').read_text().strip()
            except BaseException:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
                raise
            item = proc,url,token
            self.backends[user] = item
            return item

    async def proxy(self, req):
        is_mcp = req.path == PREFIX+'/mcp'
        a = self.account(req, ('app','access') if is_mcp else ('app',))
        if not a:
            r = failure('请登录后访问',401)
            if is_mcp:
                r.headers['WWW-Authenticate'] = f'Bearer resource_metadata="{self.origin}/.well-known/oauth-protected-resource/atlas/mcp", scope="atlas"'
            return r
        if self.limited(req,'data',600,60):
            return failure('请求过于频繁',429)
        raw = await req.read()
        if not is_mcp:
            p = json.loads(raw)
            if p.get('method') == 'connection_info':
                return web.json_response({'url':self.resource,'running':True,'cloud':True})
        size = sum(p.stat().st_size for p in (self.directory/'users'/a['user']).glob('*.sqlite*'))
        # Cap writes but leave reads/exports available after quota exhaustion.
        body = json.loads(raw) if raw else {}
        method = body.get('params',{}).get('name') if is_mcp and body.get('method') == 'tools/call' else body.get('method')
        if size > 100*1024*1024 and method in ('create_map','apply_graph_patch','import_graph','undo','redo','restore_deleted_map'):
            return failure('云端存储已达限额，请导出数据并联系管理员',413)
        _,url,token = await self.backend(a['user'])
        headers = CIMultiDict({'Authorization':'Bearer '+token})
        forwarded = {'content-type','accept','mcp-session-id','mcp-protocol-version','mcp-method','mcp-name','last-event-id'}
        # Preserve duplicate values too, so backend header validation cannot be bypassed.
        for k, value in req.headers.items():
            if k.lower() in forwarded or k.lower().startswith('mcp-param-'):
                headers.add(k, value)
        async with self.client.request(req.method,url+('/mcp' if is_mcp else '/api'),headers=headers,data=raw,allow_redirects=False) as upstream:
            outgoing = {k:v for k,v in upstream.headers.items() if k.lower() in ('content-type','mcp-session-id','mcp-protocol-version')}
            response = web.StreamResponse(status=upstream.status,headers=outgoing)
            response.headers['Cache-Control']='no-store'
            await response.prepare(req)
            async for chunk in upstream.content.iter_any():
                await response.write(chunk)
            await response.write_eof()
            return response

    async def start(self, app):
        self.dummy_hash = await asyncio.to_thread(PASSWORDS.hash,random_token())
        self.client = ClientSession(timeout=ClientTimeout(total=None,connect=10,sock_read=75))
        self.db.execute('DELETE FROM tokens WHERE expires<?',(time.time(),))
        self.db.execute('DELETE FROM codes WHERE expires<?',(time.time(),))
        self.db.commit()

    async def stop(self, app):
        await self.client.close()
        for proc,_,_ in self.backends.values():
            if proc.returncode is None:
                proc.terminate()
        for proc,_,_ in self.backends.values():
            try:
                await asyncio.wait_for(proc.wait(),5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        self.db.close()

    def app(self, static=None):
        @web.middleware
        async def secure(req, handler):
            origin = req.headers.get('Origin')
            allowed = (self.origin,'tauri://localhost','http://tauri.localhost','https://tauri.localhost')
            if origin and origin not in allowed:
                return failure('Origin not allowed',403)
            if req.method == 'OPTIONS':
                r = web.Response(status=204)
            else:
                try:
                    r = await handler(req)
                except (ValueError, KeyError, TypeError):
                    r = failure('请求内容无效，请检查输入或重新登录')
                except web.HTTPException as e:
                    r = e
                except (ConnectionError, asyncio.TimeoutError):
                    r = failure('云端暂时无法连接，请稍后重试',503)
            if not r.prepared:
                r.headers['Cache-Control']='no-store'
                r.headers['X-Content-Type-Options']='nosniff'
                r.headers['Referrer-Policy']='same-origin' if req.path == PREFIX+'/oauth/authorize' else 'no-referrer'
                form_action = "'self'"
                if req.path == PREFIX+'/oauth/authorize':
                    form_action += ' '+CHATGPT_CALLBACK
                r.headers['Content-Security-Policy']="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action "+form_action
                if origin in allowed:
                    r.headers['Access-Control-Allow-Origin']=origin
                    r.headers['Vary']='Origin'
                    r.headers['Access-Control-Allow-Headers']='Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name'
                    param_headers = [h.strip() for h in req.headers.get('Access-Control-Request-Headers','').split(',')
                                     if re.fullmatch(r'mcp-param-[a-z0-9-]+',h.strip(),re.I)]
                    if param_headers:
                        r.headers['Access-Control-Allow-Headers'] += ', '+', '.join(param_headers)
                    r.headers['Access-Control-Allow-Methods']='GET, POST, DELETE, OPTIONS'
            return r
        app=web.Application(middlewares=[secure],client_max_size=2*1024*1024)
        async def prepare(req, response):
            origin=req.headers.get('Origin')
            if origin in (self.origin,'tauri://localhost','http://tauri.localhost','https://tauri.localhost'):
                response.headers['Access-Control-Allow-Origin']=origin
                response.headers['Vary']='Origin'
                response.headers['Access-Control-Expose-Headers']='MCP-Session-Id, MCP-Protocol-Version'
            response.headers['X-Content-Type-Options']='nosniff'
            response.headers['Referrer-Policy']='same-origin' if req.path == PREFIX+'/oauth/authorize' else 'no-referrer'
        app.on_response_prepare.append(prepare)
        app.on_startup.append(self.start)
        app.on_cleanup.append(self.stop)
        app.router.add_post(PREFIX+'/auth/register',self.auth)
        app.router.add_post(PREFIX+'/auth/login',self.auth)
        app.router.add_get(PREFIX+'/auth/me',self.me)
        app.router.add_post(PREFIX+'/auth/logout',self.logout)
        app.router.add_post(PREFIX+'/auth/revoke',self.revoke)
        app.router.add_post(PREFIX+'/oauth/register',self.register_client)
        app.router.add_route('*',PREFIX+'/oauth/authorize',self.authorize)
        app.router.add_post(PREFIX+'/oauth/token',self.exchange)
        for path in ('/.well-known/oauth-protected-resource/atlas/mcp','/.well-known/oauth-authorization-server/atlas',PREFIX+'/.well-known/oauth-authorization-server',PREFIX+'/.well-known/oauth-protected-resource'):
            app.router.add_get(path,self.metadata)
        app.router.add_post(PREFIX+'/api',self.proxy)
        for method in ('POST','GET','DELETE'):
            app.router.add_route(method,PREFIX+'/mcp',self.proxy)
        app.router.add_get(PREFIX+'/healthz',lambda r:web.json_response({'ok':True}))
        if static:
            async def index(req):
                return web.FileResponse(Path(static)/'index.html')
            app.router.add_get(PREFIX+'/',index)
            app.router.add_static(PREFIX+'/assets/',Path(static)/'assets')
        return app

if __name__ == '__main__':
    os.umask(0o077)
    root=Path(__file__).resolve().parent.parent
    service=Cloud(os.environ.get('ATLAS_CLOUD_DATA',str(root/'.local/cloud-data')),os.environ.get('ATLAS_SERVER_BIN',str(root/'target/release/atlas-server')),os.environ.get('ATLAS_PUBLIC_URL','https://littlefish.sarl/atlas'))
    web.run_app(service.app(root/'dist'),host='127.0.0.1',port=int(os.environ.get('ATLAS_CLOUD_PORT','18474')),access_log=None,print=None)
