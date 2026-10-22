/**
 * Phase 179 — the knowledge panel, the application inventory and the
 * notification centre. The two ES modules are loaded through dynamic import
 * with a cache-busting query so the module body really runs once per case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL_URL = new URL("../apps/fnos-nas-agent/app/ui/knowledge-panel.js", import.meta.url);
const NOTIFY_URL = new URL("../apps/fnos-nas-agent/app/ui/notifications.js", import.meta.url);
const CSS_URL = new URL("../apps/fnos-nas-agent/app/ui/knowledge-panel.css", import.meta.url);

let counter = 0;
async function loadPanel() {
  counter += 1;
  return import(`${PANEL_URL.href}?case=${counter}`);
}
async function loadNotifications() {
  counter += 1;
  return import(`${NOTIFY_URL.href}?case=${counter}`);
}

test("hashText is deterministic and bounded", async () => {
  const { hashText } = await loadPanel();
  assert.equal(hashText("nas"), hashText("nas"));
  assert.notEqual(hashText("nas"), hashText("nas2"));
  assert.match(hashText(""), /^[0-9a-f]{8}$/);
});

test("hashEvidence prefers the excerpt and falls back to the title", async () => {
  const { hashEvidence } = await loadPanel();
  const first = hashEvidence({ excerpt: "body", title: "title" });
  const second = hashEvidence({ title: "title" });
  assert.match(first, /^[0-9a-f]{8}$/);
  assert.match(second, /^[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

test("orderSources puts the official source first", async () => {
  const { orderSources, classifySource } = await loadPanel();
  const ordered = orderSources([
    { kind: "community", url: "https://bbs.example/x" },
    { kind: "official", url: "https://docs.example/y" },
    { kind: "unknown", url: "https://a.example" }
  ]);
  assert.equal(ordered[0].kind, "official");
  assert.equal(ordered[0].isOfficial, true);
  assert.equal(classifySource("https://bare.example").kind, "unknown");
});

test("orderSources keeps the original order between equal weights", async () => {
  const { orderSources } = await loadPanel();
  const ordered = orderSources([
    { kind: "vendor", title: "first" },
    { kind: "vendor", title: "second" }
  ]);
  assert.deepEqual(ordered.map(item => item.title), ["first", "second"]);
});

test("credibility marks a missing collection time and a missing link", async () => {
  const { evaluateCredibility } = await loadPanel();
  const bare = evaluateCredibility({ title: "t" });
  assert.ok(bare.reasons.includes("缺少采集时间"));
  assert.ok(bare.reasons.includes("缺少可追溯链接"));
  const sourced = evaluateCredibility({
    title: "t",
    source: { kind: "official", url: "https://docs.example/x", collectedAt: new Date().toISOString() }
  });
  assert.ok(sourced.score > bare.score);
  assert.equal(sourced.level, "high");
});

test("credibility honours an explicit score", async () => {
  const { evaluateCredibility } = await loadPanel();
  const result = evaluateCredibility({ credibility: 40 });
  assert.equal(result.score, 40);
  assert.equal(result.level, "low");
  assert.ok(result.reasons.includes("使用条目显式可信度"));
});

test("freshness separates fresh, stale and expired", async () => {
  const { evaluateFreshness, DEFAULT_KNOWLEDGE_TTL_MS } = await loadPanel();
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const ttl = DEFAULT_KNOWLEDGE_TTL_MS;
  const fresh = evaluateFreshness({ updatedAt: new Date(now - ttl * 0.1).toISOString() }, { now, ttlMs: ttl });
  const stale = evaluateFreshness({ updatedAt: new Date(now - ttl * 0.9).toISOString() }, { now, ttlMs: ttl });
  const expired = evaluateFreshness({ updatedAt: new Date(now - ttl * 2).toISOString() }, { now, ttlMs: ttl });
  assert.equal(fresh.state, "fresh");
  assert.equal(stale.state, "stale");
  assert.equal(stale.stale, true);
  assert.equal(expired.state, "expired");
  assert.equal(expired.expired, true);
});

test("freshness stays unknown without any timestamp", async () => {
  const { evaluateFreshness } = await loadPanel();
  const result = evaluateFreshness({ title: "no clock" }, { now: Date.now() });
  assert.equal(result.state, "unknown");
  assert.equal(result.stale, false);
  assert.equal(result.expired, false);
});

test("detectConflicts reports a conflict and never picks a winner", async () => {
  const { detectConflicts } = await loadPanel();
  const map = detectConflicts([
    { id: "a", title: "磁盘健康", excerpt: "SMART 正常" },
    { id: "b", title: "磁盘健康", excerpt: "SMART 失败" }
  ]);
  assert.equal(map.a.conflict, true);
  assert.equal(map.b.conflict, true);
  assert.deepEqual(map.a.with.sort(), ["b"]);
  assert.match(map.a.label, /冲突/);
  assert.equal(typeof map.a.resolution, "undefined");
});

test("detectConflicts treats identical bodies as duplicates, not conflicts", async () => {
  const { detectConflicts } = await loadPanel();
  const map = detectConflicts([
    { id: "a", title: "磁盘健康", excerpt: "SMART 正常" },
    { id: "b", title: "磁盘健康", excerpt: "SMART 正常" }
  ]);
  assert.equal(map.a.conflict, false);
});

test("a long-term memory entry is not treated as a live reading", async () => {
  const { isRealtimeEvidence, describeMemoryBoundary } = await loadPanel();
  const memory = { id: "m1", title: "上次使用的镜像", kind: "memory" };
  assert.equal(isRealtimeEvidence(memory), false);
  const boundary = describeMemoryBoundary(memory);
  assert.equal(boundary.realtime, false);
  assert.match(boundary.note, /不代表当前实时状态/);
  const live = describeMemoryBoundary({ id: "l1", title: "当前镜像" });
  assert.equal(live.realtime, true);
});

test("the knowledge view sorts official sources first and counts the risk states", async () => {
  const { buildKnowledgeView } = await loadPanel();
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const view = buildKnowledgeView([
    { id: "a", title: "社区说法", excerpt: "x", source: { kind: "community", url: "https://bbs.example/a" } },
    { id: "b", title: "官方文档", excerpt: "y", source: { kind: "official", url: "https://docs.example/b", collectedAt: new Date(now).toISOString() } }
  ], { now });
  assert.equal(view.results[0].id, "b");
  assert.equal(view.summary.official, 1);
  assert.equal(view.summary.total, 2);
});

test("the knowledge view filters by the query", async () => {
  const { buildKnowledgeView } = await loadPanel();
  const view = buildKnowledgeView([
    { id: "a", title: "磁盘健康", excerpt: "SMART" },
    { id: "b", title: "网络诊断", excerpt: "DNS" }
  ], { query: "磁盘" });
  assert.equal(view.matched, 1);
  assert.equal(view.results[0].id, "a");
});

test("a citation always carries the source and the collection time", async () => {
  const { buildCitation } = await loadPanel();
  const citation = buildCitation({
    title: "磁盘健康",
    source: { kind: "official", title: "官方文档", url: "https://docs.example/x", collectedAt: "2026-10-01T00:00:00.000Z" }
  });
  assert.match(citation.citation, /官方文档/);
  assert.match(citation.citation, /2026-10-01/);
  assert.equal(citation.isOfficial, true);
  const missing = buildCitation({ title: "无来源" });
  assert.match(missing.citation, /未知采集时间/);
});

test("the version view marks the current and the latest release", async () => {
  const { buildVersionView } = await loadPanel();
  const view = buildVersionView([
    { version: "1.2.0", releasedAt: "2026-09-01" },
    { version: "1.3.0", releasedAt: "2026-10-01" }
  ], { current: "1.2.0" });
  assert.equal(view.versions[0].version, "1.3.0");
  assert.equal(view.versions[0].isLatest, true);
  assert.equal(view.versions[1].isCurrent, true);
  assert.match(view.summary, /1\.3\.0/);
});

test("compareVersions reports a change and a no-op", async () => {
  const { compareVersions } = await loadPanel();
  assert.equal(compareVersions("1.2.0", "1.3.0").changed, true);
  assert.match(compareVersions("1.2.0", "1.3.0").summary, /1\.3\.0/);
  assert.equal(compareVersions("1.3.0", "1.3.0").changed, false);
});

test("compareEvidenceSnapshots notices a page change without fetching", async () => {
  const { compareEvidenceSnapshots } = await loadPanel();
  const changed = compareEvidenceSnapshots(
    { url: "https://docs.example/x", excerpt: "old body", fetchedAt: "2026-10-01T00:00:00.000Z" },
    { url: "https://docs.example/x", excerpt: "new body", fetchedAt: "2026-10-22T00:00:00.000Z" }
  );
  assert.equal(changed.changed, true);
  assert.match(changed.summary, /已变化/);
  const same = compareEvidenceSnapshots({ excerpt: "same" }, { excerpt: "same" });
  assert.equal(same.changed, false);
});

test("describeCollectionState turns a missing value into 未采集", async () => {
  const { describeCollectionState } = await loadPanel();
  assert.deepEqual(describeCollectionState(null), { collected: false, label: "未采集" });
  assert.deepEqual(describeCollectionState(""), { collected: false, label: "未采集" });
  assert.deepEqual(describeCollectionState([]), { collected: false, label: "未采集" });
  assert.deepEqual(describeCollectionState(0), { collected: true, label: "0" });
  assert.deepEqual(describeCollectionState(["a", "b"]), { collected: true, label: "2 项" });
});

test("the application inventory marks an unmeasured group as unknown", async () => {
  const { buildAppInventoryView } = await loadPanel();
  const view = buildAppInventoryView({
    generatedAt: "2026-10-22T12:00:00.000Z",
    sections: [
      { id: "docker", title: "容器", status: "unknown", values: {} },
      { id: "services", title: "服务", status: "ok", values: { total: 3, failed: 1 } }
    ]
  });
  const unknown = view.sections.find(section => section.id === "docker");
  const measured = view.sections.find(section => section.id === "services");
  assert.equal(unknown.collected, false);
  assert.equal(measured.collected, true);
  assert.ok(view.summary.missingSections >= 1);
});

test("the application inventory reports an available update", async () => {
  const { buildAppInventoryView } = await loadPanel();
  const view = buildAppInventoryView({
    containers: [{ name: "navidrome", image: "deluan/navidrome", status: "running", version: "0.52.0", latest: "0.53.0" }]
  });
  const group = view.groups.find(item => item.id === "containers");
  assert.equal(group.items[0].update, "available");
  assert.match(group.items[0].updateLabel, /0\.53\.0/);
});

test("notifications classify the three kinds and ignore the rest", async () => {
  const { classifyNotification } = await loadNotifications();
  assert.equal(classifyNotification({ type: "exception" }), "exception");
  assert.equal(classifyNotification({ approvalId: "a1" }), "approval");
  assert.equal(classifyNotification({ status: "completed", taskId: "t1" }), "task");
  assert.equal(classifyNotification({ nothing: true }), "");
});

test("a notification scrubs credentials from its text", async () => {
  const { normalizeNotification } = await loadNotifications();
  const item = normalizeNotification({
    type: "exception",
    title: "auth failed with sk-ABCDEFGHIJK",
    detail: "token: abcdef123456"
  });
  assert.equal(item.title.includes("sk-ABCDEFGHIJK"), false);
  assert.match(item.title, /已隐藏/);
  assert.equal(item.redacted, true);
});

test("credential fields are dropped before rendering", async () => {
  const { stripCredentialFields } = await loadNotifications();
  const stripped = stripCredentialFields({ title: "x", apiKey: "secret", nested: { password: "p", keep: "ok" } });
  assert.equal("apiKey" in stripped, false);
  assert.equal("password" in stripped.nested, false);
  assert.equal(stripped.nested.keep, "ok");
});

test("collectNotifications sorts newest first and drops duplicates", async () => {
  const { collectNotifications } = await loadNotifications();
  const result = collectNotifications({
    exceptions: [{ id: "e1", type: "exception", title: "old", at: "2026-10-01T00:00:00.000Z" }],
    tasks: [
      { id: "t1", type: "task", title: "new", at: "2026-10-20T00:00:00.000Z" },
      { id: "t1", type: "task", title: "duplicate", at: "2026-10-20T00:00:00.000Z" }
    ]
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, "t1");
});

test("summarize and filter agree on the unread count", async () => {
  const { summarizeNotifications, filterNotifications } = await loadNotifications();
  const items = [
    { id: "a", type: "exception", read: false },
    { id: "b", type: "approval", read: true },
    { id: "c", type: "task", read: false }
  ];
  const summary = summarizeNotifications(items);
  assert.equal(summary.total, 3);
  assert.equal(summary.unread, 2);
  assert.equal(summary.byType.exception.total, 1);
  assert.equal(filterNotifications(items, { unreadOnly: true }).length, 2);
  assert.equal(filterNotifications(items, { type: "task" }).length, 1);
});

test("read helpers return new arrays and never mutate the input", async () => {
  const { markNotificationsRead, toggleNotificationRead, clearReadNotifications } = await loadNotifications();
  const input = [
    { id: "a", type: "exception", read: false },
    { id: "b", type: "approval", read: true }
  ];
  const frozen = JSON.stringify(input);
  const marked = markNotificationsRead(input, ["a"]);
  assert.equal(marked[0].read, true);
  assert.equal(input[0].read, false);
  const toggled = toggleNotificationRead(input, "b");
  assert.equal(toggled[1].read, false);
  const cleared = clearReadNotifications(input);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].id, "a");
  assert.equal(JSON.stringify(input), frozen);
});

test("marking everything read keeps the same ids", async () => {
  const { markNotificationsRead } = await loadNotifications();
  const input = [{ id: "a", type: "task", read: false }, { id: "b", type: "task", read: false }];
  const marked = markNotificationsRead(input);
  assert.deepEqual(marked.map(item => item.read), [true, true]);
  assert.deepEqual(marked.map(item => item.id), ["a", "b"]);
});

test("both modules render without innerHTML and mount on window", async () => {
  // The headers deliberately spell out the banned APIs in prose, so the check
  // looks at code with comments removed rather than at the raw file.
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const panel = stripComments(readFileSync(PANEL_URL, "utf8"));
  const notify = stripComments(readFileSync(NOTIFY_URL, "utf8"));
  for (const source of [panel, notify]) {
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "fetch("]) {
      assert.equal(source.includes(forbidden), false, `module must not use ${forbidden}`);
    }
  }
  assert.match(panel, /window\.KnowledgePanel/);
  assert.match(notify, /window\.Notifications/);
});

test("the stylesheet covers the classes the modules create", async () => {
  const css = readFileSync(CSS_URL, "utf8");
  for (const className of [
    ".knowledge-panel",
    ".knowledge-panel__item",
    ".knowledge-panel__badge",
    ".app-inventory",
    ".notification-center",
    ".notification-center__item",
    ".notifications__summary"
  ]) {
    assert.ok(css.includes(className), `stylesheet is missing ${className}`);
  }
});

/* ------------------------------------------------------------------
 * 页面层接线（pages.js + index.html）
 * ------------------------------------------------------------------ */
const PAGES_URL = new URL("../apps/fnos-nas-agent/app/ui/pages.js", import.meta.url);
const INDEX_URL = new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url);

test("pages.js routes the knowledge page and binds its controls", () => {
  const source = readFileSync(PAGES_URL, "utf8");
  assert.match(source, /if\(id==="knowledge-card"\)await refreshKnowledgePage\(\)/);
  assert.match(source, /async function refreshKnowledgePage\(\)/);
  assert.match(source, /async function refreshKnowledgePanel\(\)/);
  assert.match(source, /async function refreshAppInventory\(\)/);
  assert.match(source, /async function refreshNotifications\(\)/);
  assert.match(source, /function bindKnowledgeControls\(\)/);
  for (const selector of [
    "#knowledge-search",
    "#knowledge-refresh",
    "#knowledge-query",
    "#knowledge-source",
    "#notify-filter-exception",
    "#notify-mark-all",
    "#notify-clear-read"
  ]) {
    assert.ok(source.includes(`"${selector}"`), `pages.js must wire ${selector}`);
  }
  assert.match(source, /window\.addEventListener\("knowledge-panel-ready"/);
  assert.match(source, /window\.addEventListener\("notifications-ready"/);
});

test("pages.js keeps the knowledge wiring free of raw HTML and unsafe sinks", () => {
  const source = readFileSync(PAGES_URL, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const start = source.indexOf("const knowledgePageState=");
  assert.ok(start >= 0, "the knowledge state must be present");
  const section = source.slice(start);
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
    assert.equal(section.includes(forbidden), false, `knowledge wiring must not use ${forbidden}`);
  }
  // 读接口用 GET；本区块不接受任意 URL。
  assert.equal(/method\s*:\s*"POST"/.test(section), false);
});

test("pages.js treats every notification source failure as local", () => {
  const source = readFileSync(PAGES_URL, "utf8");
  assert.match(source, /Promise\.allSettled\(/);
  for (const endpoint of ["/api/audit?outcome=error", "/api/actions/pending", "/api/tasks?limit=20"]) {
    assert.ok(source.includes(endpoint), `notifications must read ${endpoint}`);
  }
});

test("index.html loads both modules and provides the containers", () => {
  const html = readFileSync(INDEX_URL, "utf8");
  assert.match(html, /<script type="module" src="\/ui\/knowledge-panel\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/ui\/notifications\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/ui\/knowledge-panel\.css">/);
  for (const id of [
    "knowledge-card",
    "knowledge-panel",
    "app-inventory",
    "notification-center",
    "knowledge-status",
    "notify-status",
    "knowledge-query",
    "knowledge-source"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html must define #${id}`);
  }
  assert.match(html, /href="#knowledge-card"/);
});

