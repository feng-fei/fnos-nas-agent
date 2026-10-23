import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEntryActionInput, describeEntryAction } from "../apps/fnos-nas-agent/app/ui/knowledge-write.js";
import { createKnowledgeBase } from "../apps/fnos-nas-agent/app/knowledge-base.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "fnos-nas-agent", "app");

test("核验动作只带服务端认识的核验状态", () => {
  assert.deepEqual(buildEntryActionInput("verify", "kb-1"), {
    operation: "verify",
    input: { id: "kb-1", verification: "verified" },
    label: "标记为已核验",
    irreversible: false
  });
  assert.deepEqual(buildEntryActionInput("stale", "kb-2").input, { id: "kb-2", verification: "stale" });
});

test("归档动作不携带核验状态，且被标记为不可逆", () => {
  const plan = buildEntryActionInput("archive", "kb-3");
  assert.equal(plan.operation, "archive");
  assert.deepEqual(plan.input, { id: "kb-3" });
  assert.equal(plan.irreversible, true);
});

test("未知动作或空 id 一律拒绝", () => {
  assert.equal(buildEntryActionInput("delete", "kb-1"), null);
  assert.equal(buildEntryActionInput("verify", ""), null);
  assert.equal(buildEntryActionInput("verify", "   "), null);
});

test("确认文案说清后果：归档不可恢复，核验立即生效", () => {
  const archive = describeEntryAction("archive", "USB 硬盘柜重新枚举");
  assert.match(archive, /USB 硬盘柜重新枚举/);
  assert.match(archive, /不能从界面上恢复/);
  const verify = describeEntryAction("verify", "vol4 由两块 HGST 组 RAID0");
  assert.match(verify, /verified/);
  assert.match(verify, /立即生效/);
  assert.equal(describeEntryAction("nope", "x"), "");
});

test("取消预览后提交会被拒绝（服务端不留悬空预览）", () => {
  const kb = createKnowledgeBase({ now: () => "2026-10-23T00:00:00.000Z" });
  const missing = kb.preview("archive", { id: "kb-1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "knowledge-not-found");
  const write = kb.preview("write", { title: "t", source: "field-observation", summary: "s", body: "b" });
  assert.equal(write.ok, true);
  const stored = kb.commit(write.previewId);
  assert.equal(stored.ok, true);
  const archive = kb.preview("archive", { id: stored.entry.id });
  assert.equal(archive.ok, true);
  assert.equal(kb.cancel(archive.previewId).cancelled, true);
  const committed = kb.commit(archive.previewId);
  assert.equal(committed.ok, false);
  assert.equal(committed.code, "knowledge-preview-not-found");
});

test("面板为带 id 的条目渲染动作，归档条目只显示说明", async () => {
  const source = await fs.readFile(path.join(appDir, "ui", "knowledge-panel.js"), "utf8");
  assert.match(source, /const ENTRY_ACTIONS = Object\.freeze\(\[/);
  for (const action of ['id: "verify"', 'id: "stale"', 'id: "archive"']) {
    assert.ok(source.includes(action), `缺少动作 ${action}`);
  }
  assert.match(source, /button\.dataset\.knowledgeAction = action\.id/);
  assert.match(source, /button\.dataset\.knowledgeId = String\(record\.id\)/);
  assert.match(source, /if \(record\.id\) \{/);
  assert.match(source, /if \(record\.archived\) \{/);
  assert.match(source, /已归档，不再参与检索/);
  assert.equal(/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(source), false, "面板不得拼 HTML");
});

test("写入模块承接条目动作，并且只碰 preview / commit / cancel", async () => {
  const source = await fs.readFile(path.join(appDir, "ui", "knowledge-write.js"), "utf8");
  assert.match(source, /export function buildEntryActionInput/);
  assert.match(source, /export function describeEntryAction/);
  const posted = [...source.matchAll(/postJson\("(\/api\/[^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(posted, ["/api/knowledge/cancel", "/api/knowledge/commit", "/api/knowledge/preview"]);
  assert.match(source, /closest\("\[data-knowledge-action\]"\)/);
  assert.match(source, /entryActionStrip\(/);
  assert.match(source, /确认执行/);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), false);
});

test("服务端提供取消路由，并在审计里留名", async () => {
  const source = await fs.readFile(path.join(appDir, "server.mjs"), "utf8");
  assert.match(source, /url\.pathname === "\/api\/knowledge\/cancel"/);
  assert.match(source, /knowledgeBase\.cancel\(previewId\)/);
  assert.match(source, /"\/api\/knowledge\/cancel"\) return "knowledge\.cancel"/);
  const start = source.indexOf('url.pathname === "/api/knowledge/cancel"');
  const end = source.indexOf('if (url.pathname === "/api/knowledge") {', start);
  assert.ok(start > 0 && end > start, "取消路由必须位于知识库读取分支之前");
  const cancelBlock = source.slice(start, end);
  assert.match(cancelBlock, /reply\(res, 401/);
  assert.match(cancelBlock, /reply\(res, 403/);
  assert.match(cancelBlock, /A previewId is required/);
  assert.doesNotMatch(cancelBlock, /knowledgeBase\.commit/, "取消路由不得偷偷提交");
});

test("样式里给动作与确认条留了位置", async () => {
  const css = await fs.readFile(path.join(appDir, "ui", "knowledge-panel.css"), "utf8");
  for (const selector of [".knowledge-panel__actions", ".knowledge-panel__confirm", ".knowledge-panel__confirm-actions"]) {
    assert.ok(css.includes(selector), `样式缺少 ${selector}`);
  }
});
