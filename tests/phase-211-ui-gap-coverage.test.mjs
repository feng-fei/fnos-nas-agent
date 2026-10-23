import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "fnos-nas-agent", "app");

async function readUi() {
  const [html, pages, core] = await Promise.all([
    fs.readFile(path.join(appDir, "ui", "index.html"), "utf8"),
    fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8"),
    fs.readFile(path.join(appDir, "ui", "core.js"), "utf8")
  ]);
  return { html, pages, core };
}

// 前端缺口审查（Phase 211）：这些路由曾经只在服务端存在，界面上没有任何入口。
// 本用例把「必须能在界面上找到入口」的路由固定下来，避免以后又悄悄退回 API-only。
const WIRED_ROUTES = [
  "/api/network/diagnostics",
  "/api/network/policy",
  "/api/network/check",
  "/api/deploy/precheck",
  "/api/compositions/validate",
  "/api/diagnostics/report",
  "/api/diagnoses",
  "/api/write-actions",
  "/api/docker/stats",
  "/api/network/interfaces",
  "/api/diagnostics/log-evidence",
  "/api/compositions",
  "/api/workflows/triggers/evaluate",
  "/api/mcp/status",
  "/api/runbooks",
  "/api/runbooks/stats",
  "/api/workflows",
  "/api/system/device-profiles",
  "/api/health-checks",
  "/api/agent/trace",
  "/api/security/inspection",
  "/api/web/fetch",
  "/api/knowledge/stats",
  "/api/knowledge/conflicts",
  "/api/files/operations/batch"
];

// 有意不提供界面入口的路由：只给智能体、或是一次性危险写操作的中间步骤。
const INTENTIONALLY_API_ONLY = [
  "/api/tools/:id/run",
  "/api/knowledge/preview",
  "/api/knowledge/commit"
];

test("every audited route has a front-end caller", async () => {
  const { pages, core } = await readUi();
  const uiText = pages + core;
  const missing = WIRED_ROUTES.filter((route) => !uiText.includes(route));
  assert.deepEqual(missing, [], `这些路由在前端仍没有入口：${missing.join(", ")}`);
});

test("the ops page handles every route it claims", async () => {
  const { pages } = await readUi();
  assert.match(pages, /async function refreshOpsNetwork\(/, "网络体检渲染必须存在");
  assert.match(pages, /async function checkOpsPlan\(/, "部署校验必须存在");
  assert.match(pages, /async function checkOpsComposition\(/, "组合校验必须存在");
  assert.match(pages, /async function runOpsDiagnosis\(/, "诊断报告必须存在");
  assert.match(pages, /async function refreshOpsHistory\(/, "诊断历史必须存在");
  assert.match(pages, /async function refreshOpsLogEvidence\(/, "日志证据必须存在");
  assert.match(pages, /async function refreshOpsWorkflows\(/, "工作流必须存在");
  assert.match(pages, /async function refreshOpsMcp\(/, "MCP 状态必须存在");
  assert.match(pages, /async function refreshOpsRunbooks\(/, "运行手册必须存在");
  assert.match(pages, /async function refreshOpsRunbookStats\(/, "运行手册统计必须存在");
  assert.match(pages, /async function fetchOpsWebEvidence\(/, "网页取证必须存在");
  assert.match(pages, /async function refreshKnowledgeFacts\(/, "知识库统计与冲突必须存在");
});

test("the new front-end entry points are wired to real controls", async () => {
  const { html, pages, core } = await readUi();
  for (const id of ["ops-fetch-url", "ops-fetch-run", "ops-fetch-result", "knowledge-stats", "knowledge-conflicts", "ops-runbooks-stats"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(pages, /guard\("#ops-fetch-run",/, "#ops-fetch-run 必须绑定点击事件");
  assert.match(core, /ops-card/, "工作台必须把 ops-card 列为页面");
});

test("the intentionally API-only routes are not silently exposed", async () => {
  const { html, pages, core } = await readUi();
  const uiText = pages + core + html;
  for (const route of INTENTIONALLY_API_ONLY) {
    assert.equal(uiText.includes(route), false, `${route} 不应出现在前端（${route.includes("batch") || route.includes("commit") ? "批量/两步写" : "智能体专用"}）`);
  }
});

test("new knowledge and fetch rendering never builds markup from strings", async () => {
  const { pages } = await readUi();
  const start = pages.indexOf("async function refreshKnowledgeFacts(");
  const end = pages.indexOf("async function refreshAppInventory(");
  assert.ok(start > 0 && end > start, "refreshKnowledgeFacts 必须是独立函数");
  const snippet = pages.slice(start, end);
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(snippet), false, "知识库统计/冲突必须用 textContent 渲染");
});

test("the ops page is reachable from the navigation", async () => {
  const { core } = await readUi();
  assert.match(core, /诊断与运维|ops-card/, "导航必须包含诊断与运维");
});

test("every route the UI calls actually exists on the server", async () => {
  const source = await fs.readFile(path.join(appDir, "server.mjs"), "utf8");
  const declared = new Set();
  for (const match of source.matchAll(/url\.pathname === "(\/api\/[^"]+)"/g)) declared.add(match[1]);
  for (const match of source.matchAll(/match\("\/api\/([^"]+)"\)/g)) declared.add(`/api/${match[1]}`);
  const { pages, core } = await readUi();
  const called = new Set();
  for (const match of (pages + core).matchAll(/"(\/api\/[A-Za-z0-9\/_-]+)"/g)) called.add(match[1]);
  const list = [...declared];
  // 服务端有一批带参数的动态路由（正则匹配），界面按前缀拼接调用，这里按前缀放行。
  const DYNAMIC = ["/api/tools/", "/api/models/", "/api/tasks/", "/api/actions/", "/api/skills/", "/api/workflows/", "/api/runbooks/", "/api/diagnoses/", "/api/knowledge/", "/api/health-checks/", "/api/system/device-profiles/"];
  const dangling = [...called].filter((route) => !list.some((item) => item === route || item.startsWith(route)) && !DYNAMIC.some((prefix) => route.startsWith(prefix)));
  assert.deepEqual(dangling, [], `前端调用了服务端不存在的路由：${dangling.join(", ")}`);
});
