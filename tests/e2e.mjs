import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd(),
  temp = await mkdtemp(path.join(tmpdir(), "atlas-e2e-"));
const out = path.join(root, "artifacts", "tests");
await mkdir(out, { recursive: true });
const apiPort = Number(process.env.ATLAS_TEST_API_PORT || 38474),
  vitePort = Number(process.env.ATLAS_TEST_VITE_PORT || 1422);
const origin = `http://127.0.0.1:${vitePort}`,
  base = `http://127.0.0.1:${apiPort}`;
const children = [];
let browser;
let token = "";
const errors = [];
function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (code && code !== 143) console.error("Fixture exited", command, code, signal);
  });
  child.stderr.on("data", (d) => {
    if (process.env.DEBUG_E2E) process.stderr.write(d);
  });
  return child;
}
async function poll(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Timed out: ${label} ${last || ""}`);
}
async function call(method, params = {}) {
  const r = await fetch(base + "/api", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
  const v = await r.json();
  assert.equal(r.ok, true, JSON.stringify(v));
  return v;
}
async function graph() {
  return call("get_map", { map_id: "pid-control" });
}
try {
  start(path.join(root, "target", "debug", "atlas-server"), [
    "--db",
    path.join(temp, "atlas.db"),
    "--port",
    String(apiPort),
    "--token-file",
    path.join(temp, "token"),
    "--allow-origin",
    origin,
  ]);
  await poll(async () => {
    token = (await readFile(path.join(temp, "token"), "utf8")).trim();
    return (await fetch(base + "/healthz")).ok;
  }, "Rust server startup");
  start(
    process.execPath,
    [
      path.join(root, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
    ],
    { VITE_ATLAS_API: base, CI: "true" },
  );
  await poll(async () => (await fetch(origin)).ok, "Vite startup");
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("PAGE ERROR", e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.error("BROWSER", m.text());
  });
  const remote = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:") &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      remote.push(r.url());
  });
  let g = await graph();
  const rootNode = g.nodes.find((n) => n.id === g.root_id);
  await page.goto(origin + "/#token=" + encodeURIComponent(token));
  await page.waitForTimeout(1000);
  await page.getByRole("heading", { name: g.title, exact: true }).waitFor();
  console.log("connected real SQLite backend");
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.locator(".graph-panel").count(),
    1,
    "initially only root",
  );
  assert.equal(await page.locator(".concept-row").count(), 1);
  assert.equal(new URL(page.url()).hash, "", "bootstrap token erased");
  await page.screenshot({ path: path.join(out, "01-root-light.png") });
  await page.locator(`[data-node-id="${g.root_id}"] .row-copy`).click();
  await poll(
    async () => (await page.locator(".graph-panel").count()) === 2,
    "root expands one panel",
  );
  const direct = g.edges
    .filter((e) => e.source === g.root_id)
    .map((e) => e.target);
  assert.equal(
    await page.getByTestId("panel-1").locator(".concept-row").count(),
    direct.length,
    "all direct prerequisites in one list",
  );
  const branches = direct.filter((id) => g.edges.some((e) => e.source === id));
  assert.ok(branches.length >= 2);
  await page
    .getByTestId("panel-1")
    .locator(`[data-node-id="${branches[0]}"] .row-copy`)
    .click();
  await poll(
    async () => (await page.locator(".graph-panel").count()) === 3,
    "branch expands",
  );
  // Repeated row click collapses only its descendants; arrow toggles too.
  const branchRow = page.getByTestId("panel-1").locator(`[data-node-id="${branches[0]}"]`);
  await branchRow.locator(".row-copy").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 2, "repeat click collapses branch");
  await poll(async () => (await graph()).nodes.find(n => n.id === branches[0]).collapsed, "collapsed flag persisted");
  await branchRow.locator(".row-expand").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 3, "arrow reopens branch");
  assert.equal(await branchRow.locator(".row-expand").getAttribute("aria-expanded"), "true");
  await branchRow.locator(".row-expand").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 2, "arrow closes branch");
  await branchRow.locator(".row-copy").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 3, "row reopens branch");
  const initialPosition = await page.getByTestId("panel-1").boundingBox();
  await page
    .getByTestId("panel-1")
    .locator(`[data-node-id="${branches[1]}"] .row-copy`)
    .click();
  await poll(
    async () =>
      (await page.getByTestId("panel-2").locator(".concept-row").count()) ===
      g.edges.filter((e) => e.source === branches[1]).length,
    "branch replacement",
  );
  assert.equal(await page.locator(".graph-panel").count(), 3);
  assert.equal(
    (await page.getByTestId("panel-1").boundingBox()).x,
    initialPosition.x,
    "stable panel position",
  );
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(out, "02-progressive-lists-light.png"),
  });
  // Inspector edits persist to SQLite and survive a page reload.
  const editedId = branches[1],
    editedTitle = "E2E: " + g.nodes.find((n) => n.id === editedId).title;
  await page
    .getByRole("textbox", { name: "节点标题", exact: true })
    .fill(editedTitle);
  await page
    .getByRole("textbox", { name: "节点摘要", exact: true })
    .fill("Persisted by the real Rust SQLite backend.");
  await poll(
    async () =>
      (await graph()).nodes.find((n) => n.id === editedId).title ===
      editedTitle,
    "debounced autosave",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await poll(
    async () =>
      (await graph()).nodes.find((n) => n.id === editedId).title !==
      editedTitle,
    "undo committed edit",
  );
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await poll(
    async () =>
      (await graph()).nodes.find((n) => n.id === editedId).title ===
      editedTitle,
    "redo committed edit",
  );
  await page.reload();
  await page.getByRole("heading", { name: g.title, exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "搜索知识点、摘要、笔记…" })
    .count()
    .catch(() => {});
  await page.locator("#global-search").fill(editedTitle);
  await page.locator(".search-results button").first().click();
  await page.getByRole("textbox", { name: "节点标题", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "节点标题", exact: true })
      .inputValue(),
    editedTitle,
  );
  // Compact row status menu, persisted collapse, and inspector visibility.
  await page
    .locator(`[data-node-id="${editedId}"]`)
    .first()
    .getByRole("button", { name: "状态 " + editedTitle, exact: true })
    .click();
  await page
    .locator(".row-status .status-menu")
    .getByRole("button", { name: "已掌握", exact: true })
    .click();
  await poll(
    async () =>
      (await graph()).nodes.find((n) => n.id === editedId).status ===
      "mastered",
    "row status saved",
  );
  await page.getByRole("button", { name: "收起详情面板", exact: true }).click();
  assert.equal(await page.locator(".inspector").isVisible(), false);
  await page.getByRole("button", { name: "显示详情面板", exact: true }).click();
  // Real MCP Streamable HTTP mutation, observed through SSE without reload.
  let session;
  let rpcId = 0;
  async function mcp(method, params, notification = false) {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++rpcId }),
        method,
        params,
      }),
    });
    if (r.headers.get("mcp-session-id"))
      session = r.headers.get("mcp-session-id");
    if (notification) return;
    const text = await r.text();
    if (!text.trim())
      throw new Error("Empty MCP response " + r.status + " " + method);

    const response = r.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? JSON.parse(
          text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .filter(Boolean)
            .join("\n"),
        )
      : JSON.parse(text);
    assert.equal(r.ok, true, text);
    assert.equal(response.error, undefined, text);
    return response.result;
  }
  await mcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "atlas-e2e", version: "1.0" },
  });
  await mcp("notifications/initialized", {}, true);
  g = await graph();
  const changed = {
    ...g.nodes.find((n) => n.id === editedId),
    summary: "Updated externally through official MCP",
  };
  const result = await mcp("tools/call", {
    name: "apply_graph_patch",
    arguments: {
      map_id: g.id,
      expected_version: g.version,
      operations: [{ op: "upsert_node", node: changed }],
    },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  await poll(
    async () =>
      (await page
        .getByRole("textbox", { name: "节点摘要", exact: true })
        .inputValue()) === changed.summary,
    "MCP to live UI via SSE",
  );
  g = await graph();
  const rootUpdate = {
    ...g.nodes.find((n) => n.id === g.root_id),
    title: "PID · live root update",
  };
  await mcp("tools/call", {
    name: "apply_graph_patch",
    arguments: {
      map_id: g.id,
      expected_version: g.version,
      operations: [{ op: "upsert_node", node: rootUpdate }],
    },
  });
  await poll(
    async () =>
      (await page
        .getByTestId("panel-0")
        .locator(".row-copy strong")
        .textContent()) === rootUpdate.title,
    "live root canvas title",
  );
  for (const panel of await page.locator(".graph-panel").all()) {
    assert.equal(
      await panel.isVisible(),
      true,
      "panels visible after external patch",
    );
    const box = await panel.boundingBox();
    assert.ok(
      box.width > 100 && box.height > 80,
      "panels retain dimensions after patch",
    );
  }
  // Exports: validate actual download bytes, including the complete explored layout.
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.waitForTimeout(350);
  console.log("MCP → SSE verified, exporting");
  for (const format of ["JSON", "MARKDOWN", "MERMAID", "SVG", "PNG"]) {
    await page.locator(".heading-actions .dropdown").first().hover();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: format, exact: true }).click();
    const download = await pending;
    console.log("download", format);
    const file = path.join(out, `export.${format.toLowerCase()}`);
    await download.saveAs(file);
    const bytes = await readFile(file);
    assert.ok(bytes.length > 50, format + " export content");
    if (format === "JSON")
      assert.equal(JSON.parse(bytes.toString()).id, "pid-control");
    if (format === "SVG") {
      assert.match(bytes.toString(), /<svg/);
      assert.doesNotMatch(bytes.toString(), /<foreignObject/);
      assert.match(bytes.toString(), /Simulation and validation/);
    }
    if (format === "PNG") {
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.ok(
        bytes.readUInt32BE(16) > 600 && bytes.readUInt32BE(20) > 300,
        "PNG includes complete panels, not clipped viewport",
      );
    }
  }
  const svgPreview=await browser.newPage({viewport:{width:900,height:750}});await svgPreview.goto('file://'+path.join(out,'export.svg'));await svgPreview.evaluate(()=>document.fonts.ready);await svgPreview.screenshot({path:path.join(out,'05-svg-offline-preview.png'),fullPage:false,timeout:60000});await svgPreview.close();
  await page.getByRole("button", { name: "深色主题", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({
    path: path.join(out, "03-progressive-lists-dark.png"),
    animations: "disabled",
  });
  // Exercise the real connection response arriving after the settings dialog renders.
  await page.route(base + "/api", async (route) => {
    const request = route.request();
    if (request.postDataJSON()?.method !== "connection_info") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "MCP 设置", exact: true }).click();
  await page.getByRole("heading", { name: "AI 连接设置" }).waitFor();
  await page.getByText("本地 MCP 客户端配置", { exact: true }).click();
  await poll(
    async () => /运行中/.test(await page.locator(".connection-status").textContent()),
    "settings receives the real MCP connection status",
  );
  await page.screenshot({ path: path.join(out, "04-mcp-settings.png") });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  // Delete and undo use actual persistent history.
  await page
    .getByRole("button", { name: "删除节点（可撤销）", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await poll(
    async () => !(await graph()).nodes.some((n) => n.id === editedId),
    "node delete",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await poll(
    async () => (await graph()).nodes.some((n) => n.id === editedId),
    "undo node delete",
  );
  // Import creates a separate validated map; node identities remain stable.
  g = await graph();
  const imported = { ...g, id: "e2e-imported", title: "Imported E2E Atlas" };
  await page.locator("input[type=file]").setInputFiles({
    name: "import.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page
    .getByRole("heading", { name: imported.title, exact: true })
    .waitFor();
  assert.equal(
    (await call("get_map", { map_id: imported.id })).nodes.length,
    g.nodes.length,
  );
  await page.getByRole("button", { name: "新建地图", exact: true }).click();
  await page.getByPlaceholder("例如：理解 PID 控制").fill("E2E new map");
  await page
    .getByPlaceholder("你想理解的概念（默认使用地图名称）")
    .fill("Real target");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("heading", { name: "E2E new map", exact: true })
    .waitFor();
  // Context operations must target the right-clicked map, including inactive maps.
  const newMapId = (await call("list_maps")).find(m => m.title === "E2E new map").id;
  const importedButton = page.locator(".map-item").filter({ hasText: imported.title });
  await importedButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名地图", exact: true }).click();
  await page.getByPlaceholder("例如：理解 PID 控制").fill("Renamed via context");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await poll(async () => (await call("get_map", { map_id: imported.id })).title === "Renamed via context", "context rename inactive map");
  assert.equal((await call("get_map", { map_id: newMapId })).title, "E2E new map");
  await page.locator(".map-item").filter({ hasText: "E2E new map" }).click();
  await page.locator(".map-item").filter({ hasText: "Renamed via context" }).click({ button: "right" });
  await page.screenshot({ path: path.join(out, "06-map-context-menu.png") });
  await page.getByRole("menuitem", { name: "删除地图", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).last().click();
  assert.ok((await call("list_maps")).some(m => m.id === imported.id), "cancel keeps map");
  await page.locator(".map-item").filter({ hasText: "Renamed via context" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除地图", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await poll(async () => !(await call("list_maps")).some(m => m.id === imported.id), "context deletes correct map");
  assert.ok((await call("list_maps")).some(m => m.id === newMapId));
  await page.getByRole("button", { name: "恢复最近删除地图", exact: true }).click();
  await poll(async () => (await call("list_maps")).some(m => m.id === imported.id), "context deletion recoverable");
  await page.getByTestId("panel-0").locator(".row-copy").click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "删除节点", exact: true }).isDisabled(), true, "root protected");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  await page.getByTestId("panel-0").locator(".row-copy").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 2, "root expands");
  await page.getByTestId("panel-0").locator(".row-copy").click();
  await poll(async () => (await page.locator(".graph-panel").count()) === 1, "root second click collapses all");
  assert.equal(await page.locator(".brand-mark").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(remote, [], "no external requests");
  console.log(
    "PASS: progressive exploration, branch replacement, autosave/reload, undo/redo, row status, inspector, MCP→SSE, five exports, theme, settings, node delete/undo, JSON import, new map.",
  );
} catch (error) {
  // Preserve actionable CI diagnostics without publishing the fixture credential.
  const detail = String(error?.stack || error);
  await writeFile(
    path.join(out, "failure.txt"),
    token ? detail.split(token).join("<redacted>") : detail,
  );
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
