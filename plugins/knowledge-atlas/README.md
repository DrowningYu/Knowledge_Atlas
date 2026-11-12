# Knowledge Atlas ChatGPT 插件

这份插件让 AI 通过 Knowledge Atlas 已有 MCP 工具管理地图。支持读取、创建地图、更新知识点/关系/学习状态及导出；所有写入经过应用的版本检查，随后同步到应用窗口。

## 选择安装方式

| 使用位置 | 需要的包与连接 |
| --- | --- |
| ChatGPT 普通云端聊天（含网页） | 先建个人安全隧道 MCP 连接，再生成绑定该连接的 ChatGPT ZIP |
| 支持本地执行的 ChatGPT 桌面会话 / Codex | `knowledge-atlas-desktop-0.1.0.zip`，或从仓库 marketplace 安装 |

**普通云端聊天不能直接访问你电脑的 `127.0.0.1`。** 每个人需要绑定自己的本地应用，不能共用开发者的连接 ID。桌面 ZIP 不会把云端聊天自动变成本地会话；也不承诺你的账号开放所有插件上传入口。

插件按 OpenAI 文档手工制作，没有调用尚未连接的 Plugin Creator。GitHub 分支分发不等于已通过 OpenAI 公共插件目录审核。

## A. 普通 ChatGPT 聊天

1. 在自己的电脑安装并启动 Knowledge Atlas（推荐 0.1.2），安装 Node.js 22。下载 `chatgpt-plugin` 分支并放在固定目录。
2. 按 [Secure MCP Tunnel 官方说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，在 Platform 创建隧道，关联你使用的 ChatGPT 工作区和 Platform 组织；准备具有隧道使用权限的运行密钥，安装官方 `tunnel-client`。密钥仅在本机设置为 `CONTROL_PLANE_API_KEY`，不要写进聊天、仓库或 ZIP。
3. 使用本包的 stdio 转接器作为隧道后端。先运行 `tunnel-client help quickstart` 检查当前 CLI，再用你的实际值执行：

   ```sh
   tunnel-client init --sample sample_mcp_stdio_local --profile knowledge-atlas \
     --tunnel-id YOUR_TUNNEL_ID \
     --mcp-command 'node /absolute/path/Knowledge_Atlas/plugins/knowledge-atlas/server/stdio.mjs'
   tunnel-client doctor --profile knowledge-atlas --explain
   tunnel-client run --profile knowledge-atlas
   ```

   替换隧道 ID 和绝对路径；Windows 使用已安装的 `node.exe` 和实际路径，路径有空格时按 CLI 帮助加引号。保持 Knowledge Atlas 与 tunnel-client 运行。转接器自动读取本机应用令牌，因此隧道连接的 MCP 认证选择 **No authentication**；这不关闭应用 HTTP Bearer 认证，也不公开端口，访问由安全隧道的账户权限约束。
4. 在 [ChatGPT Plugins](https://chatgpt.com/plugins) 的 `+ → Add custom MCP server` 中选择 `Connection: Tunnel`，选中这个隧道，完成 `Create as a plugin` 并安装连接。此时即可在普通聊天中选用它，先让它列出知识地图。
5. 如需附带本插件的操作指引，复制刚注册连接页面 URL 中以 `plugin_asdk_app_` 开头的技术 ID。在**仓库根目录**运行（不是把真实 token 填在这里）：

   ```sh
   python3 scripts/package-plugin.py --app-id YOUR_PLUGIN_ASDK_APP_ID
   ```

   Windows 可用 `py -3` 替代 `python3`。生成的 `artifacts/plugins/knowledge-atlas-chatgpt-0.1.0.zip` 在根层包含 `plugin.json`、`.app.json`、`skills/`，已绑定自己的连接。通过账号可用的插件上传 ZIP 入口安装，开新聊天选择 Knowledge Atlas。这个绑定包供你自己的账号/工作区使用，不适合把带有个人连接 ID 的包当成所有人的通用成品。

首次验收：先列地图，再读选定地图；让 AI 在一张测试地图的笔记里写一行，确认应用同步显示，最后用应用撤销。云端工具调用成功后才算整条连接验收完成。

## B. 本地桌面会话

安装 Node.js 22，并保持 Knowledge Atlas 打开。支持本地 MCP ZIP 导入的客户端可以上传 `downloads/knowledge-atlas-desktop-0.1.0.zip`。若没有本地 ZIP 入口，在克隆仓库后运行：

```sh
codex plugin marketplace add ./
```

然后按客户端提供的本地插件来源完成安装并重启桌面客户端。此分支的 `.agents/plugins/marketplace.json` 已指向 `plugins/knowledge-atlas`。这条方式仅用于支持本地执行的会话，不作为普通云端聊天的替代说明。

## 本机发现与故障处理

- macOS：`~/Library/Application Support/app.knowledgeatlas.desktop/`
- Windows：`%APPDATA%/app.knowledgeatlas.desktop/`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/app.knowledgeatlas.desktop/`

转接器只读取目录下的 `mcp.token` 和 0.1.2 起提供的 `mcp-endpoint.json`；不直接打开数据库。旧版默认地址为 `http://127.0.0.1:38473/mcp`。需要时在本机进程环境设置 `ATLAS_DATA_DIR`，或 `ATLAS_TOKEN_FILE` 与 `ATLAS_MCP_URL`。URL 仅允许 loopback HTTP `/mcp`；重定向拒绝跟随，凭据不会被转发到互联网。

- `ATLAS_TOKEN_MISSING`：先启动应用，检查本机数据目录或令牌文件位置。
- `ATLAS_UNAUTHORIZED`：核对应用设置中的端口和本地令牌文件是否属于同一实例。
- `ATLAS_RECONNECT`：应用重启或端口变动，重新连接插件。不要盲目重发写入，先读取地图检查是否已生效。
- 找不到隧道或上传入口：检查当前账户/工作区功能和权限；只有本地转接器测试通过不能证明 ChatGPT 账号已连接。

## 数据边界

SQLite 保存在电脑上。通过 ChatGPT 读取的地图和笔记会作为工具结果发送给 ChatGPT；这不是“内容完全不出本机”。打包器不读取应用数据、令牌、数据库或环境密钥。仓库 ZIP 没有任何个人 token。

## 已验证与待验证

自动测试已覆盖 stdio → Streamable HTTP → SQLite 的握手、会话、六个工具发现、创建/读取/写入/导出、旧版本拒绝、错误凭据和地址限制。ZIP 生成测试覆盖两种包的文件结构和账号绑定。

尚未在用户的 ChatGPT 账号中实际导入 ZIP、注册隧道或从普通聊天发起调用；这些需要该账号的权限和本机环境。不要把本地协议验证视为 ChatGPT 端验收。

参考：[官方插件打包格式](https://developers.openai.com/plugins/build/plugins)、[自定义 MCP 接入](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[桌面插件限制](https://developers.openai.com/plugins/deploy/desktop-only)
