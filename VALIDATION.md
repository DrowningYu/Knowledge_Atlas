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
| Windows x64 NSIS | 已配置 GitHub Actions，当前环境未执行 |
| macOS Intel / Apple Silicon DMG | 已配置 GitHub Actions，当前环境未执行 |

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
