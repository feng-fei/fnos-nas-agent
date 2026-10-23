import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildKnowledgePayload, describePreview, normalizePreview } from "../apps/fnos-nas-agent/app/ui/knowledge-write.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps", "fnos-nas-agent", "app");

test("the payload keeps only the fields the server accepts", () => {
  const payload = buildKnowledgePayload({
    title: "  vol4 由两块 HGST 组 RAID0  ",
    summary: "USB 硬盘柜重新枚举会让成员节点消失",
    body: "第一段\n第二段",
    source: "field-observation",
    verification: "verified",
    tags: "vol4, mdadm，只读",
    id: "client-chosen-id",
    collectedAt: "2000-01-01T00:00:00.000Z"
  });
  assert.deepEqual(Object.keys(payload).sort(), ["body", "source", "summary", "tags", "title", "verification"]);
  assert.equal(payload.title, "vol4 由两块 HGST 组 RAID0");
  assert.deepEqual(payload.tags, ["vol4", "mdadm", "只读"]);
  assert.equal(payload.verification, "verified");
});

test("verification defaults to unverified and tags are bounded", () => {
  const payload = buildKnowledgePayload({ title: "t", source: "official-doc", tags: Array.from({ length: 30 }, (_, i) => "t" + i).join(",") });
  assert.equal(payload.verification, "unverified");
  assert.equal(payload.tags.length, 20);
  assert.equal(payload.body, "");
});

test("a preview without a previewId is treated as unusable", () => {
  assert.equal(normalizePreview(null), null);
  assert.equal(normalizePreview({ ok: false }), null);
  assert.equal(normalizePreview({ ok: true }), null);
  const preview = normalizePreview({
    ok: true,
    previewId: "preview-1",
    operation: "write",
    entry: { id: "kb-1", title: "t" },
    warnings: ["entry-replaced-with-force"],
    redactedFields: ["body"],
    requiresForce: true
  });
  assert.equal(preview.previewId, "preview-1");
  assert.deepEqual(preview.warnings, ["entry-replaced-with-force"]);
  assert.deepEqual(preview.redactedFields, ["body"]);
  assert.equal(preview.requiresForce, true);
});

test("the preview explains redaction, warnings and overwrite", () => {
  const lines = describePreview({
    previewId: "preview-1",
    entry: { id: "kb-1", title: "镜像校验", source: "official-doc", verification: "verified", collectedAt: "2026-10-22T00:00:00.000Z", summary: "s", tags: ["a"] },
    warnings: ["entry-will-be-archived"],
    redactedFields: ["body"],
    existing: { id: "kb-1" }
  });
  const joined = lines.join("\n");
  assert.match(joined, /镜像校验/);
  assert.match(joined, /脱敏/);
  assert.match(joined, /提醒/);
  assert.match(joined, /覆盖已有条目/);
});

test("describePreview tolerates a preview with nothing collected", () => {
  const joined = describePreview(normalizePreview({ ok: true, previewId: "p", entry: {} })).join("\n");
  assert.match(joined, /未采集/);
});

test("the write module is a module and only talks to preview/commit", async () => {
  const source = await fs.readFile(path.join(appDir, "ui", "knowledge-write.js"), "utf8");
  assert.match(source, /export function buildKnowledgePayload/);
  assert.match(source, /export function normalizePreview/);
  assert.match(source, /export function describePreview/);
  const posted = [...source.matchAll(/api\("(\/api\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(posted.sort(), ["/api/knowledge/commit", "/api/knowledge/preview"]);
  assert.equal(source.includes("/api/knowledge/preview") && source.includes("previewId"), true);
});

test("the commit is refused when the form changed after the preview", async () => {
  const source = await fs.readFile(path.join(appDir, "ui", "knowledge-write.js"), "utf8");
  assert.match(source, /JSON\.stringify\(readForm\(\)\) !== formSignature/, "提交前必须比对表单指纹");
  assert.match(source, /invalidatePreview\("表单已改动，请重新预览后再提交。"\)/, "改动后必须作废预览");
  assert.match(source, /commitButton\.disabled = true/, "作废预览时必须禁用提交");
});

test("the write card is loaded and wired on the knowledge page", async () => {
  const html = await fs.readFile(path.join(appDir, "ui", "index.html"), "utf8");
  const pages = await fs.readFile(path.join(appDir, "ui", "pages.js"), "utf8");
  assert.match(html, /<script type="module" src="\/ui\/knowledge-write\.js"><\/script>/);
  for (const id of ["knowledge-write", "knowledge-new-title", "knowledge-new-summary", "knowledge-new-body", "knowledge-new-source", "knowledge-new-verification", "knowledge-new-tags", "knowledge-preview", "knowledge-commit", "knowledge-write-status", "knowledge-write-result"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(html, /id="knowledge-commit"[^>]*disabled/, "未预览前提交按钮必须禁用");
  assert.match(pages, /window\.addEventListener\("knowledge-saved"/, "写入成功后页面必须刷新列表");
});

test("the knowledge source filter uses the sources the server actually accepts", async () => {
  const html = await fs.readFile(path.join(appDir, "ui", "index.html"), "utf8");
  const filterBlock = html.slice(html.indexOf('id="knowledge-source"'), html.indexOf("</select>", html.indexOf('id="knowledge-source"')));
  for (const value of ["official-doc", "field-observation", "manual-confirmation"]) {
    assert.ok(filterBlock.includes(`value="${value}"`), `来源筛选缺少 ${value}`);
  }
  for (const wrong of ["value=\"official\"", "value=\"vendor\"", "value=\"community\"", "value=\"memory\""]) {
    assert.equal(filterBlock.includes(wrong), false, `来源筛选不得使用服务端不认识的 ${wrong}`);
  }
});

test("the write panel never builds markup from strings", async () => {
  const source = await fs.readFile(path.join(appDir, "ui", "knowledge-write.js"), "utf8");
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(source), false);
});
