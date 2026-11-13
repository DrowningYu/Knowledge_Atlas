# 云端账号与数据网关

服务页面：`https://littlefish.sarl/atlas/`。桌面安装包内置同一服务地址。

注册用户名（3–32 位字母、数字、下划线、短横线，不区分大小写）和密码（10–128 字符），插件与 App 使用同一账号。不是邮箱注册，不发送验证码，也没有自助密码找回。密码使用 Argon2id 哈希；登录会话仅保存在应用当前 sessionStorage，重开应用重新登录。账号总量上限 100，单账号数据约 100 MiB 后禁止继续增加数据；管理员需监控存储，不提供无限量公共托管。

## 数据与授权

每个用户有独立的 SQLite 数据库、随机本地令牌和 loopback Rust MCP 进程。外部请求只能按当前认证用户路由，不能指定用户目录。MCP 会话也按用户独立，服务重启后 MCP 客户端需要重新初始化；地图数据、账号与 OAuth 授权保留。

App 通过 HTTPS API 读写云端，每 5 秒检查地图版本，有变化才读取当前地图。离线时不会自动写回本地或排队覆盖云端；超时的写入需刷新确认。原本地模式独立保留，上传迁移必须用户主动确认；同 ID 地图（包括远端已删除的同 ID）不会覆盖，迁移中断可再次执行，导入不含撤销历史。

ChatGPT 添加远程 MCP：`https://littlefish.sarl/atlas/mcp`，选择 OAuth 与 DCR。用户在独立页面登录并明确授权，权限为读取、新建及修改本账号地图。支持一次性授权码、S256 PKCE、issuer/resource 绑定、刷新令牌轮换、账号内撤销全部插件授权。仅允许精确的 `https://chatgpt.com/connector_platform_oauth_redirect` 回调地址；如果管理页显示不同回调，维护者先核验后将该精确地址加入 `Cloud` 的回调配置，不允许任意回调或通配。

云端直接提供 HTTPS MCP，不需要另一个 tunnel 密钥或把用户 OpenAI 密钥交给服务器。这取代旧版个人电脑上的 tunnel；用户需在 ChatGPT 停用旧连接并授权新云端连接，旧连接不会自动迁移。依据 [OpenAI 官方认证说明](https://developers.openai.com/plugins/build/auth)。

## 运行

需要 Python 3.12+、Rust 编译出的 `atlas-server` 和前端 `dist/`。只绑定 loopback，通过 TLS 反向代理提供访问。

```sh
python3 -m venv .local/cloud-venv
.local/cloud-venv/bin/pip install -r cloud/requirements.txt
cargo build --release -p atlas-server
npm ci && npm run build
ATLAS_PUBLIC_URL=https://littlefish.sarl/atlas \
ATLAS_CLOUD_DATA=/var/lib/knowledge-atlas-cloud \
ATLAS_SERVER_BIN=/opt/knowledge-atlas-cloud/atlas-server \
.local/cloud-venv/bin/python cloud/server.py
```

环境变量还支持 `ATLAS_CLOUD_PORT`（默认 18474）。部署目录结构需包含 `cloud/server.py` 与 `dist/`；服务数据不应放在公开静态目录。参考 `knowledge-atlas-cloud.service`。生产使用 systemd DynamicUser 和专用 StateDirectory，不能对公网暴露各用户 loopback 端口。仅将 `/atlas/` 和两条 RFC 元数据路径反代到网关，保留既有站点。

注册及登录限速按可信本机反代覆盖的 X-Real-IP 计算，不要让公网客户端控制该头。网关不记录请求正文、Authorization 或 OAuth 查询串，反代亦关闭这些路由的访问日志。前端静态资源可用缓存/压缩；认证和 API 响应禁止缓存。

备份：停止云端服务后，复制整个 StateDirectory（accounts.sqlite、WAL/SHM 与 users 子目录），加密保存在独立存储，恢复时保持目录权限。数据库未做应用层加密。systemd 服务重启会回收所有子进程，账号数据保留。

## 验证

```sh
cargo build -p atlas-server
.local/cloud-venv/bin/python -m unittest discover -s cloud -p 'test_*.py' -v
node cloud/test_ui.mjs
```

协议测试覆盖跨账号读写/会话隔离、版本冲突、错误 Origin/回调/资源/PKCE、授权码重放、刷新轮换、撤销、登录限流及后端重启持久化；浏览器测试覆盖注册、远端新增/修改自动出现、退出与换账号隔离。ChatGPT 真实账号端授权仍需由用户操作验收。
