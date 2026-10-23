import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { buildKnowledgeView } from "../apps/fnos-nas-agent/app/ui/knowledge-panel.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "../apps/fnos-nas-agent/app");

function read(relative) {
  return readFileSync(resolve(app, relative), "utf8");
}

const ACTIVE_ENTRY = {
  id: "kb-active",
  title: "存储池重建步骤",
  body: "先停文件监控，再卸载卷。",
  tags: ["存储"],
  source: { type: "manual", title: "运维手册", collectedAt: "2026-10-01T00:00:00.000Z" },
  credibility: { score: 80, label: "可信" },
  updatedAt: "2026-10-01T00:00:00.000Z"
};

const ARCHIVED_ENTRY = {
  ...ACTIVE_ENTRY,
  id: "kb-archived",
  title: "旧版网络配置",
  archived: true
};

test("buildKnowledgeView 保留归档标记，供渲染层区分", () => {
  const view = buildKnowledgeView([ACTIVE_ENTRY, ARCHIVED_ENTRY], { now: Date.parse("2026-10-20T00:00:00.000Z") });
  assert.equal(view.results.length, 2);
  const archived = view.results.find(item => item.id === "kb-archived");
  const active = view.results.find(item => item.id === "kb-active");
  assert.equal(archived.archived, true, "归档条目必须带 archived:true");
  assert.equal(active.archived, false, "在读条目必须带 archived:false");
});

test("面板对归档条目只给说明，不给维护动作", () => {
  const panel = read("ui/knowledge-panel.js");
  assert.ok(panel.includes("if (record.archived) {"), "渲染层必须按 archived 分支");
  assert.ok(panel.includes("已归档，不再参与检索。"), "归档条目要有明确说明");
  const start = panel.indexOf("if (record.archived) {");
  const branch = panel.slice(start, panel.indexOf("} else {", start));
  assert.ok(branch.includes("已归档"), "归档分支应只有说明文案");
  assert.ok(!branch.includes("dataset.knowledgeAction"), "归档条目不应画出条目级动作按钮");
});

test("知识库列表页把「显示已归档」开关接到查询参数", () => {
  const pages = read("ui/pages.js");
  assert.ok(pages.includes("archived:false"), "页面状态要有 archived 字段");
  assert.ok(pages.includes('if(knowledgePageState.archived)params.set("archived","1");'), "开关打开时要带 archived=1");
  assert.ok(pages.includes('const archivedToggle=document.querySelector("#knowledge-show-archived");'), "要绑定开关");
  assert.ok(pages.includes("含已归档"), "状态文案要说明当前包含归档条目");
});

test("知识库页有「显示已归档」复选框，服务端仍按参数过滤", () => {
  const html = read("ui/index.html");
  assert.ok(html.includes('id="knowledge-show-archived"'), "页面上要有复选框");
  assert.ok(html.includes("显示已归档"), "复选框要有可见文案");
  const server = read("server.mjs");
  assert.ok(server.includes('includeArchived: url.searchParams.get("archived") === "1"'), "服务端仍只按显式参数包含归档");
});
