> **0.2.0 云同步**：注册登录后，App 和插件按账号读写云端地图，个人电脑无需保持在线。浏览器入口：https://littlefish.sarl/atlas/ ，[账号与部署说明](cloud/README.md)。旧本地模式独立保留，可在设置中主动导入，不自动上传。以下本地 MCP / tunnel 说明仅适用于本地模式；云端请使用 OAuth 入口 `https://littlefish.sarl/atlas/mcp`。

## ChatGPT 后台连接（0.1.3）

打开右上角设置，在「ChatGPT 普通聊天」中按引导创建隧道并填写运行密钥，点击「保存并连接」。应用内置 OpenAI tunnel-client-runtime，无需另外装 Node 或保持终端窗口。

可以记住密钥、下次打开应用自动连接、关闭窗口后留在菜单栏／托盘运行。菜单中可重新打开应用、断开连接或完全退出。断开只停止当前连接；清除设置还会删除保存的凭据。电脑休眠／离线时连接会暂停。

密钥保存在 macOS Keychain、Windows Credential Manager 或 Linux Secret Service；凭据库不可用时可取消「记住密钥」，仅本次使用。不会退回明文保存。连接状态同时检查云端成功轮询和本地 MCP 启动探测；「已就绪」不代替 ChatGPT 账号首次绑定与实际工具调用验证。首次绑定见 [后台连接指南](docs/chatgpt-background.md)。

开发构建前运行 `python3 scripts/prepare-tunnel.py <Rust目标三元组>`，下载并核对固定版本的官方运行程序与许可证。发布流程自动完成此步骤。

# Knowledge Atlas

本地优先的知识探索桌面应用。把目标知识的前置概念逐层展开为横向列表，同级知识留在同一个面板中。编辑、历史记录和 AI 修改全部写入 SQLite。桌面运行不需要 Node.js、云数据库或联网账号。

## ChatGPT 云端插件分支

本分支与 0.2.0 App 一起使用。默认连接云端 OAuth MCP，登录同一账号即可同步，无需个人电脑或个人 tunnel 在线。

- [连接步骤、授权与本地模式说明](plugins/knowledge-atlas/README.md)
- [下载云端插件 ZIP](downloads/knowledge-atlas-cloud-0.2.0.zip)
- ChatGPT 自定义 MCP 地址：`https://littlefish.sarl/atlas/mcp`，OAuth + DCR
- 账号绑定包：`python3 scripts/package-plugin.py --app-id <实际已注册连接ID>`
- 旧本地包：`python3 scripts/package-plugin.py --local`
- 包结构测试：`python3 tests/plugin-package.py`
- 兼容本地转接器测试：`cargo build --locked -p atlas-server && node tests/plugin.mjs`


## 下载

在 [Releases 页面](https://github.com/DrowningYu/Knowledge_Atlas/releases/tag/v0.1.3) 的 **Assets** 中下载对应系统的安装包：

| 系统 | 文件 |
| --- | --- |
| Windows x64 | `Knowledge-Atlas-0.1.2-Windows-x64.exe` |
| Mac Intel | `Knowledge-Atlas-0.1.2-macOS-Intel.dmg` |
| Mac Apple Silicon（M 系列） | `Knowledge-Atlas-0.1.2-macOS-Apple-Silicon.dmg` |
| Linux amd64（Ubuntu 24.04） | `Knowledge-Atlas-0.1.2-Linux-amd64.deb` |

`SHA256SUMS.txt` 可用于校验下载完整性。Source code 是源码；普通用户选择上面的安装包即可。Windows 安装包尚未代码签名；Mac 使用 ad-hoc 签名，尚未完成 Developer ID 签名和公证。Mac 首次打开请参阅 [安装说明](docs/releases/v0.1.3.md#mac-首次打开)。

## 快速上手

1. 启动应用，首次创建包含 21 个知识点、34 条关系的 PID 控制演示地图；也附有 `examples/pid-control.json`。
2. 点击目标知识，右侧展开直接前置知识列表；继续点击列表项逐层探索，再次点击同一行或箭头即可收起其后续分支。右键地图、节点或画布可打开快捷操作菜单。上方面包屑可以返回，画布支持平移、缩放和适应内容。
3. 在详情栏编辑标题、摘要、Markdown、笔记和学习状态；更改自动保存。依赖页可以新建知识点或引用已有知识点。
4. 撤销/重做使用工具栏或 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（文本框保留系统文本撤销）。删除地图后可从左侧恢复最近删除项。历史跨重启保留。
5. 「MCP 设置」复制当前服务地址和客户端配置，在支持 Streamable HTTP 的 AI 客户端中连接。应用必须保持运行。

默认浅色，中性色界面，右上角切换深色。搜索支持标题、摘要和笔记，点击结果定位知识路径；未连接到目标的节点仍可查看编辑。探索深度限制阻止无限展开，相关关系形成循环时也不会无限遍历。

## 开发与构建

构建需要 Git、Node.js 22（含 npm）、Rust stable 和对应平台的 Tauri 2 系统依赖。**安装版的用户不需要 Node.js 或 Rust。** 首次构建需要联网下载依赖；应用安装后可以离线管理知识图。

### 获取源码

```sh
git clone https://github.com/DrowningYu/Knowledge_Atlas.git
cd Knowledge_Atlas
```

也可以下载仓库的 Source ZIP 并解压。以下命令均在含 `package.json` 和 `Cargo.toml` 的项目根目录运行，保留两个 lock 文件，以 `npm ci` 安装前端依赖。

### Windows x64：生成 NSIS .exe

在 Windows 本机准备：

1. 安装 [Node.js 22](https://nodejs.org/en/download) 和 [Git for Windows](https://git-scm.com/downloads/win)。
2. 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，选择「使用 C++ 的桌面开发」，包含 MSVC x64/x86 编译工具和 Windows SDK。
3. 通过 [rustup](https://rustup.rs/) 安装 Rust，选择 MSVC 工具链。
4. 确认已安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。桌面开发需要它；当前 NSIS 配置会在安装时处理缺失的 WebView2，首次安装可能需要网络。

安装完成后重开 PowerShell，进入项目根目录：

```powershell
node --version
npm.cmd --version
rustup default stable-x86_64-pc-windows-msvc
rustup target add x86_64-pc-windows-msvc
npm.cmd ci
npm.cmd run build
cargo test --locked -p atlas-core -p atlas-server
npm.cmd run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis
```

使用 `npm.cmd` 可避免 PowerShell 将 npm 解析为受执行策略限制的脚本。开发时运行 `npm.cmd run tauri:dev`。生产构建会自动重新构建前端并嵌入程序，无需另开 Vite 服务。

安装器位置：`target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`。若提示找不到 `link.exe`，检查 C++ 工作负载，并在 Visual Studio 的 x64 Native Tools 终端中重试。当前未配置 Windows 代码签名。

### macOS：生成 Intel / Apple Silicon .dmg

在 Mac 本机安装 [Node.js 22](https://nodejs.org/en/download)、[Rust stable](https://rustup.rs/) 和 Xcode Command Line Tools：

```sh
xcode-select --install
```

完成系统弹窗中的安装后，重开终端，在项目根目录执行：

```sh
node --version
npm --version
rustc --version
xcode-select -p
uname -m
npm ci
npm run build
cargo test --locked -p atlas-core -p atlas-server
```

`uname -m` 为 `arm64` 时，在 Apple Silicon Mac 的原生终端构建：

```sh
rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin --bundles dmg
```

产物：`target/aarch64-apple-darwin/release/bundle/dmg/*.dmg`。

`uname -m` 为 `x86_64` 时，在 Intel Mac 上构建：

```sh
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin --bundles dmg
```

产物：`target/x86_64-apple-darwin/release/bundle/dmg/*.dmg`。Apple Silicon 上请避免通过 Rosetta 终端误选 Intel 架构。这里分别生成两种架构的安装包，不是 Universal 包。开发时运行 `npm run tauri:dev`；桌面使用系统 WKWebView。

DMG 构建须在 macOS 上运行。配置中的 `signingIdentity: "-"` 使用 ad-hoc 签名，并不提供 Apple 身份认证。CI 使用 `TAURI_BUNDLER_DMG_IGNORE_CI=true` 保留 Finder 安装布局。当前未配置 Developer ID 签名与公证；面向其他用户正式分发前，按 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/) 配置自己的证书与公证凭据，凭据通过 CI Secrets 提供，不要提交到仓库。

### Linux：已验证的构建平台

Ubuntu 24.04 需要 `build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf`，运行时使用系统 WebKitGTK。

```sh
npm ci
cargo test --locked -p atlas-core -p atlas-server
npm run tauri -- build --bundles deb
```

产物：`target/release/bundle/deb/*.deb`。其他当前平台的默认包可用 `npm run tauri:build` 构建。

### GitHub Actions 构建安装包

仓库的 [Actions](https://github.com/DrowningYu/Knowledge_Atlas/actions) 中选择 **Verify and build desktop installers**。推送 `main` / `master` 或 `v*` 标签会触发，也可以点击 **Run workflow** 手动运行。

工作流先执行核心、MCP 协议和浏览器测试，再分别在 Windows、Intel Mac、Apple Silicon Mac 和 Linux 上编译。Mac 还会挂载最终 DMG，检查背景和图标位置、验证应用签名，再复制出应用测试原生启动。成功后，在该次运行页面的 **Artifacts** 下载：

| Artifact | 安装包 |
| --- | --- |
| `Knowledge-Atlas-Windows-x64` | NSIS `.exe` |
| `Knowledge-Atlas-macOS-Intel` | Intel `.dmg` |
| `Knowledge-Atlas-macOS-Apple-Silicon` | Apple Silicon `.dmg` |
| `Knowledge-Atlas-Linux-amd64` | Linux `.deb` |

Artifact 保留 14 天，日常构建不会自动发布版本。v0.1.3 安装包在全部测试和打包通过后保存到 [Releases](https://github.com/DrowningYu/Knowledge_Atlas/releases/tag/v0.1.3)，可以直接下载。构建通过不代表桌面实机验收；验证范围记录在 [VALIDATION.md](VALIDATION.md)。

平台依赖与打包参考：[Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)、[Windows 安装器](https://v2.tauri.app/distribute/windows-installer/)、[macOS DMG](https://v2.tauri.app/distribute/dmg/)。

## 浏览器开发与测试

浏览器模式用于开发和自动化验证，连接同一套真实 Rust/SQLite 后端，没有内存 Mock 或 localStorage 图数据库。

```sh
cargo build --locked -p atlas-server
./target/debug/atlas-server --db ./dev-data/atlas.sqlite \
  --token-file ./dev-data/atlas.token --port 38473 \
  --allow-origin http://127.0.0.1:1420
# 另一个终端
npm run dev
```

打开 `http://127.0.0.1:1420`，在 MCP 设置中输入生成的本地 token 文件内容。也支持 `#token=...`，页面读取后立即清除片段，仅在当前浏览器会话保存令牌。不要把令牌写进源码、截图或公开链接。

```sh
npx playwright install chromium
npm run test:e2e
```

E2E 使用独立临时 SQLite/令牌，启动真实 Rust 服务与 Vite，证据写入 `artifacts/tests/`。无 GUI 的 Linux 如缺浏览器依赖，可在开发机器/CI 使用 `npx playwright install --with-deps chromium`。

## 数据模型与一致性

每张地图具有稳定 `id`、`root_id`、单调递增 `version`、节点及关系。关系方向为 **source（当前概念）→ target（前置概念）**。同一节点可被多条关系引用；面板重复引用不复制底层数据。

- 节点：`id/title/summary/explanation/status/notes/collapsed`
- 状态：`not_understood / learning / mastered / skipped`
- 关系：`id/source/target/kind/reason`
- 类型：`required / recommended / related`
- ID：1–128 位 ASCII 字母、数字、下划线或连字符

必要和建议前置共同保持 DAG；相关关系可成环，视图使用路径防重和深度限制。拒绝重复 ID、悬空引用、自引用、无效状态和依赖环。一次 patch 按最终状态验证，允许同一事务创建节点再添加引用，也允许删除根节点同时设置新根。

SQLite 迁移源文件在 `crates/atlas-core/migrations/001_initial.sql`。数据库使用 WAL，迁移通过 `PRAGMA user_version` 管理。每次修改在一个事务中写入图和历史快照。`expected_version` 必须等于当前版本；发生冲突时整体回滚。撤销/重做恢复内容，但版本继续递增，避免旧客户端绕过并发检查。删除地图保留恢复记录，重启不会重新生成已删除的演示图。

自动保存有短暂防抖；遇到外部更新与未保存草稿冲突，界面保留草稿并要求选择重新应用或放弃。重新应用会以草稿覆盖当前节点字段，请先确认外部修改内容。学习建议选择尚未掌握且必要/建议前置均已掌握或跳过的节点。

本地数据位于系统应用数据目录的 `app.knowledgeatlas.desktop` 中：`atlas.sqlite`、SQLite WAL/SHM 和 `mcp.token`。备份时先关闭应用，复制整个应用数据目录；也可以用 JSON 导出单张地图。SQLite 未做磁盘加密，使用操作系统账户和磁盘保护本机数据。

## MCP：真实 Streamable HTTP

使用官方 Rust `rmcp` SDK，监听 `127.0.0.1`，默认端口 38473，端口被占用时选择可用端口。**以应用设置显示的地址为准。**令牌首次生成并持久保存；Unix 下文件权限为 0600，目录为 0700。

客户端配置示例（实际地址和令牌从应用复制）：

```json
{
  "mcpServers": {
    "knowledge-atlas": {
      "url": "http://127.0.0.1:38473/mcp",
      "headers": { "Authorization": "Bearer <your-local-token>" }
    }
  }
}
```

客户端字段可能不同，选择 Streamable HTTP transport 并配置 Authorization 请求头即可。MVP 直接提供 HTTP，不需要 stdio 桥接；只支持 stdio 的客户端需要自行使用兼容 HTTP 桥接器。

所有 MCP/API/SSE 请求要求 Bearer token；检查 loopback Host，Origin 只接受明确允许的本地开发或 Tauri 来源。无 Origin 的原生 MCP 客户端可用，`null`、通配或外站 Origin 被拒绝。限制请求体 2 MiB。桌面不开放公网端口。持有令牌的客户端可读写全部地图，凭证只交给信任的客户端。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_maps` | `{}` | 地图摘要数组 |
| `create_map` | `{title,target}` | 新图，目标节点自动生成 |
| `get_map` | `{map_id}` | 完整图，包含当前版本 |
| `get_node` | `{map_id,node_id}` | 单个节点 |
| `apply_graph_patch` | `{map_id,expected_version,operations}` | 原子提交后的完整图 |
| `export_outline` | `{map_id,format}` | `{text}`；format 为 json/markdown/mermaid |

Patch 操作使用 `op` 标签：`upsert_node {node}`、`delete_node {node_id}`、`upsert_edge {edge}`、`delete_edge {edge_id}`、`rename_map {title}`、`set_root {node_id}`。Upsert 需要完整节点/关系对象；先 get_map，再保留现有字段并修改所需字段。

```json
{
  "map_id": "pid-control",
  "expected_version": 1,
  "operations": [{ "op": "rename_map", "title": "我的 PID 学习地图" }]
}
```

示例中的版本仅为说明，必须替换为实时 `get_map` 结果。工具验证失败返回 MCP `isError`，不会部分写入。提交后广播变更：桌面使用 Tauri 事件，浏览器开发模式使用经过鉴权的 SSE。连接设置反映本地服务及 MCP 最近活动，关闭应用会停止服务。

## 导入导出

- **JSON**：完整图，保留稳定 ID。导入先验证，以新地图建立；已有（包括已删除待恢复）地图 ID 不覆盖。需要另存副本时改变顶层地图 ID。
- **Markdown**：每个节点只输出一次，依赖通过稳定 ID 链接引用。
- **Mermaid**：节点标识使用稳定 ID，表达所有关系，不重复遍历共享节点。
- **PNG / SVG**：导出当前已展开的探索视图；先展开想展示的路径。文本格式始终导出完整图。

## 项目结构

```text
crates/atlas-core/       SQLite、迁移、图校验、历史、演示数据、文本导出
crates/atlas-server/     rmcp、HTTP、鉴权、SSE、官方 SDK 协议测试
src-tauri/              桌面启动、原生文件保存/剪贴板、事件转发
src/                    React Flow 渐进列表、详情编辑、地图管理
tests/                  浏览器及原生端到端验证
.github/workflows/      多平台构建与测试
```

SQLite 历史使用完整快照，适合个人知识地图的 MVP，暂未做历史压缩或超大图虚拟化。应用没有内置 AI 模型；AI 由用户选择的 MCP 客户端提供，本地查看编辑不受 AI 可用性影响。

参考：[Tauri 构建文档](https://v2.tauri.app/distribute/)、[官方 Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)、[React Flow](https://reactflow.dev/)。MIT License。
