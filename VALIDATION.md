# 验证记录 — 0.1.0

验证日期：2026-11-12。当前执行环境为 Ubuntu 24.04 x86_64；Rust 1.99.1、Node.js 22.23.4。所有图数据测试使用独立的临时 SQLite，没有 Mock 图数据库。

| 检查 | 结果 |
| --- | --- |
| TypeScript + Vite production build | 通过 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --locked -p atlas-core -p atlas-server` | 10 项核心测试及 1 项官方 SDK 协议综合测试通过；doc tests 通过 |
| `npm run test:e2e` | 通过，真实 Rust HTTP/SSE + SQLite + Chromium |
| Tauri release + Debian amd64 bundle | 构建成功 |
| 从 Debian 包解包后的 release 可执行程序启动 | 通过；不使用 Vite、Node.js 或外部网页 |
| 原生 WebKit 窗口逐层展开、编辑自动保存 | WebKitWebDriver 真实点击及输入通过 |
| 外部 MCP → SQLite → Tauri 事件 → 原生界面 | 通过；检查详情更新且 3 个已展开面板继续可见 |
| 原生重启、撤销/重做恢复 | 通过 |
| 原生剪贴板和保存文件对话框 | 通过，实际写出文件并校验内容 |
| Windows x64 NSIS | GitHub Actions 的 Windows runner 构建成功，安装包已上传 |
| macOS Intel / Apple Silicon DMG | GitHub Actions 的两种 macOS runner 均构建成功，安装包已上传 |

核心测试覆盖：无效 ID/状态/引用、自引用、前置环、原子回滚、并发版本冲突、删除根节点的原子替换、删除不存在的节点/关系、撤销/重做单调版本、重启持久化、删除地图恢复、稳定 ID 文本导出、学习推荐。

协议测试使用官方 rmcp 客户端初始化、列举工具、调用六个工具，检查原子 patch、冲突、SSE 通知、撤销恢复，以及缺令牌、外站/null Origin、非本机 Host、超大请求拒绝。CLI 额外验证首次初始化及删除全部地图后重启保持空库。

浏览器 E2E 覆盖：初始仅目标、同级列表、分支切换和稳定位置、编辑/刷新恢复、撤销/重做、状态菜单、侧栏收起、真实 MCP 修改后 SSE 刷新、根节点更新后面板可见、五种文件导出、浅深主题、MCP 设置、节点删除/撤销、JSON 导入、新建地图。期间没有向外部服务器请求应用资源。

PNG 导出已检查完整 1320×1044 内容及中文文本；SVG 是包含本地字体的独立矢量文件，不使用 foreignObject，已在脱离应用的独立页面打开检查。嵌入完整 CJK 字体使 SVG 约 15 MB，是当前 MVP 的体积取舍。文本导出包含完整知识图，图片导出包含当前展开路径。

Linux 原生运行验证在 Xvfb 虚拟显示器中进行，使用软件渲染和隔离的 WebKit 系统库；未更改主机全局软件包或系统服务。验证的是包内 release 程序，不等同于所有 Linux 发行版和真实 GPU 驱动均已兼容。Windows/macOS 的安装、签名、公证和实机交互仍须在对应平台验收。

## 可重复命令

```sh
npm ci
npm run build
cargo fmt --all -- --check
cargo test --locked -p atlas-core -p atlas-server
cargo build --locked -p atlas-server
npx playwright install chromium
npm run test:e2e
npm run tauri -- build --bundles deb
```

Linux 原生自动化（需 WebKitWebDriver、可用显示器或 Xvfb；务必指定临时 XDG_DATA_HOME）：

```sh
export XDG_DATA_HOME="$(mktemp -d)"
export TAURI_WEBVIEW_AUTOMATION=true
WebKitWebDriver --host=127.0.0.1 --port=4446
# 另一终端；该测试会修改演示图
python3 tests/native-smoke.py http://127.0.0.1:4446 /absolute/path/knowledge-atlas
```

测试脚本在 `tests/` 和 `crates/atlas-server/tests/`；自动化截图和结果写入 `artifacts/`。发布源码附带 `docs/screenshots/` 的界面预览，不包含临时令牌或用户数据库。

原生测试方法参考 [Tauri WebDriver 手动配置](https://tauri.app/develop/tests/webdriver/manual-setup/)。

## GitHub Actions 回归修复

首次云端运行暴露出两处测试时序问题，均保留原有功能和安全断言后修复：

- 界面测试打开 MCP 设置后，原先立即断言异步连接状态。现在等待真实接口响应，并人为延迟该响应 500 ms 作为回归场景；不伪造响应数据。
- Windows 下，超大请求在上传期间被提前拒绝，客户端可能报告 socket abort 而读不到 413。协议测试改用真实 TCP / HTTP `Expect: 100-continue` 握手，在上传前验证 `/api` 和 `/mcp` 均明确返回 413。服务端的 2 MiB 限制保持原样。

修复后的 Linux 浏览器端到端测试和 Windows 核心／官方 SDK 协议测试均已在 [Actions 运行](https://github.com/DrowningYu/Knowledge_Atlas/actions/runs/43209742873) 中通过。各平台的编译与测试日志保存在 `diagnostics-*` artifacts，便于定位后续失败。

同一轮构建（源码提交 `d5b07fc`）已产出并上传以下安装包；已下载检查 artifact ZIP 完整性和安装包格式：

| Artifact | 文件 | 大小（字节） |
| --- | --- | ---: |
| Knowledge-Atlas-Windows-x64 | Knowledge Atlas_0.1.0_x64-setup.exe | 15,843,826 |
| Knowledge-Atlas-macOS-Intel | Knowledge Atlas_0.1.0_x64.dmg | 17,070,826 |
| Knowledge-Atlas-macOS-Apple-Silicon | Knowledge Atlas_0.1.0_aarch64.dmg | 16,886,595 |

上述 Windows/macOS 结果是对应平台的编译、协议测试和打包成功，不表示已在用户电脑上完成安装与 GUI 交互验收；签名和公证仍未配置。Linux 原生端到端验证范围保持上文记录。
