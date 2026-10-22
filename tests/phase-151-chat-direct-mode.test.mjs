import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readUiSource } from "./helpers/ui-source.mjs";

/**
 * Phase 151 — Marvis 风格双模式对话窗口（任务模式 / 对话模式）。
 *
 * 对话模式走 lead 已落地的直聊 SSE 通道：
 *   POST /api/chat/message  → text/event-stream（delta / done / error）
 *   GET  /api/chat/status   → { enabled, providerConfigured, model }
 *
 * POST + body 无法使用 EventSource，因此必须用 fetch + ReadableStream 自解析 SSE。
 *
 * 仓库没有 jsdom 与浏览器环境，本文件与 tests/phase-149-chat-window.test.mjs、
 * tests/model-provider-ui.test.mjs 保持同一风格：只做源码断言。
 */

const uiDir = new URL("../apps/fnos-nas-agent/app/ui/", import.meta.url);
const read = (name) => readFile(new URL(name, uiDir), "utf8");

const html = await read("index.html");
const pages = await read("pages.js");
const core = await read("core.js");
const css = await read("styles.css");
const source = await readUiSource();

const CHAT_CLASS_PATTERN = /\.chat__[a-z0-9_-]+/g;
const collectChatClasses = (text) =>
  Array.from(new Set(Array.from(text.matchAll(CHAT_CLASS_PATTERN), (m) => m[0]))).sort();

/* ------------------------------------------------------------ 1 模式切换 -- */

test("顶部提供任务模式 / 对话模式两态切换", () => {
  assert.match(html, /class="chat__modes"/);
  assert.match(html, /role="group"/);
  assert.match(html, /id="chat-mode-task"[^>]*aria-pressed="true"/);
  assert.match(html, /id="chat-mode-direct"[^>]*aria-pressed="false"/);
  assert.match(html, /id="agent-chat"[^>]*data-chat-mode="task"/);
  assert.match(html, /id="agent-mode-hint"/);
  assert.match(pages, /function chatApplyMode\(/);
  assert.match(pages, /chatModeTaskButton\.addEventListener/);
  assert.match(pages, /chatModeDirectButton\.addEventListener/);
});

test("选中态写入 localStorage 并在初始化时恢复", () => {
  assert.match(pages, /const CHAT_MODE_KEY="fnos-nas-agent\.chat-mode"/);
  assert.match(pages, /localStorage\.setItem\(CHAT_MODE_KEY,next\)/);
  assert.match(pages, /localStorage\.getItem\(CHAT_MODE_KEY\)/);
  assert.match(pages, /function chatReadStoredMode\(/);
  assert.match(pages, /chatApplyMode\(chatReadStoredMode\(\),false\)/);
  assert.match(pages, /setAttribute\("aria-pressed"/);
  assert.match(pages, /root\.dataset\.chatMode=next/);
});

test("对话模式隐藏工具卡片与审批界面", () => {
  assert.match(html, /id="agent-pending-card"/);
  assert.match(html, /id="agent-task-queue-card"/);
  assert.match(pages, /pendingCard\.hidden=next==="direct"/);
  assert.match(pages, /queueCard\.hidden=next==="direct"/);
  assert.match(css, /\.chat\[data-chat-mode="direct"\] \.chat__tools/);
  assert.match(css, /\.chat\[data-chat-mode="direct"\] \.chat__approval/);
});

test("提交按当前模式路由", () => {
  assert.match(pages, /if\(chatMode==="direct"\)\{await chatSendDirect\(text\);return;\}/);
  assert.match(pages, /async function chatSendDirect\(/);
});

/* -------------------------------------------------------------- 2 直聊流 -- */

test("提交前先读取直聊状态，服务商不可用时不发请求", () => {
  assert.match(pages, /api\("\/api\/chat\/status"\)/);
  assert.match(pages, /status\.enabled!==true/);
  assert.match(pages, /尚未配置可用的模型服务商/);
});

test("直聊请求使用 POST /api/chat/message 并声明 SSE", () => {
  assert.match(pages, /api\("\/api\/chat\/message",\{method:"POST"/);
  assert.match(pages, /"accept":"text\/event-stream"/);
  assert.match(pages, /messages:\[/);
  assert.match(pages, /role:"user"/);
});

test("用 fetch + ReadableStream 自行解析 SSE 帧", () => {
  assert.match(pages, /function chatParseSseFrame\(/);
  assert.match(pages, /function chatSplitSseFrames\(/);
  assert.match(pages, /async function chatReadSseStream\(/);
  assert.match(pages, /response\.body\.getReader\(\)/);
  assert.match(pages, /new TextDecoder\(\)/);
  assert.match(pages, /line\.startsWith\("event:"\)/);
  assert.match(pages, /line\.startsWith\("data:"\)/);
  assert.match(pages, /JSON\.parse\(raw\)/);
  assert.match(pages, /\\r\\n\\r\\n\|\\n\\n\|\\r\\r/);
});

test("直聊通道不使用 EventSource（只有任务模式使用）", () => {
  const matches = pages.match(/new EventSource\(/g) || [];
  assert.equal(matches.length, 1);
  assert.match(pages, /new EventSource\("\/api\/tasks\/"\+encodeURIComponent\(taskId\)\+"\/events"\)/);
});

test("delta 实时追加、done 定稿、error 显示服务端消息", () => {
  assert.match(pages, /frame\.event==="delta"/);
  assert.match(pages, /frame\.event==="done"/);
  assert.match(pages, /frame\.event==="error"/);
  assert.match(pages, /frame\.data\.message/);
  assert.match(pages, /function chatDirectAppend\(/);
  assert.match(pages, /function chatDirectFinalize\(/);
  assert.match(pages, /document\.createTextNode\(text\)/);
  assert.match(pages, /content\.replaceChildren\(\)/);
});

/* -------------------------------------------------------------- 3 停止键 -- */

test("对话模式停止按钮用 AbortController 中断请求并保留已收文本", () => {
  assert.match(pages, /new AbortController\(\)/);
  assert.match(pages, /signal:controller\.signal/);
  assert.match(pages, /chatDirectController\.abort\(\)/);
  assert.match(pages, /error\.name==="AbortError"/);
  assert.match(pages, /chatDirectStreamText/);
  assert.match(pages, /function chatSetStopDirect\(/);
  assert.match(pages, /chatDirectController=controller/);
});

/* -------------------------------------------------------------- 4 安全性 -- */

test("全目录禁止 innerHTML / outerHTML / insertAdjacentHTML / document.write", () => {
  for (const [name, text] of [
    ["pages.js", pages],
    ["core.js", core],
    ["index.html", html],
  ]) {
    assert.doesNotMatch(text, /innerHTML/, `${name} 不得出现 innerHTML`);
    assert.doesNotMatch(text, /outerHTML/, `${name} 不得出现 outerHTML`);
    assert.doesNotMatch(text, /insertAdjacentHTML/, `${name} 不得出现 insertAdjacentHTML`);
    assert.doesNotMatch(text, /document\.write\(/, `${name} 不得使用 document.write`);
  }
});

test("零依赖：无外链资源、无 import/export、无第三方 Markdown 库", () => {
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/);
  assert.doesNotMatch(html, /cdn\./);
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(https?:/);
  assert.doesNotMatch(pages, /(?:^|\n)\s*import\s/);
  assert.doesNotMatch(pages, /(?:^|\n)\s*export\s/);
  assert.doesNotMatch(core, /(?:^|\n)\s*import\s/);
  assert.doesNotMatch(core, /(?:^|\n)\s*export\s/);
  assert.doesNotMatch(source, /marked|markdown-it|showdown|remark/i);
});

/* -------------------------------------------------------------- 5 样式 -- */

test("用户气泡遵循 Marvis 规格", () => {
  assert.match(css, /\.chat__bubble--user \{[^}]*max-width:\s*600px/);
  assert.match(css, /\.chat__bubble--user \{[^}]*padding:\s*20px/);
  assert.match(css, /\.chat__bubble--user \{[^}]*border-radius:\s*20px/);
  assert.match(css, /\.chat__bubble--user \{[^}]*linear-gradient\(0deg,\s*#7b483514 0%/);
});

test("助手气泡为无底色纯文本", () => {
  assert.match(css, /\.chat__bubble--agent \{[^}]*background:\s*transparent/);
  assert.match(css, /\.chat__bubble--agent \{[^}]*box-shadow:\s*none/);
});

test("输入框遵循 Marvis 规格", () => {
  assert.match(css, /\.composer__input \{[^}]*min-height:\s*134px/);
  assert.match(css, /\.composer__input \{[^}]*max-height:\s*400px/);
  assert.match(css, /\.composer__input \{[^}]*border-radius:\s*20px/);
  assert.match(css, /\.composer__input \{[^}]*background:\s*var\(--surface-glass\)/);
  assert.match(css, /--surface-glass:/);
  assert.match(pages, /Math\.min\(full,400\)/);
});

test("模式切换按钮样式已定义", () => {
  assert.match(css, /\.chat__modes \{/);
  assert.match(css, /\.chat__mode \{/);
  assert.match(css, /\.chat__mode\[aria-pressed="true"\] \{/);
  assert.match(css, /\.chat__mode-hint \{/);
});

/* ------------------------------------------------------------ 6 词汇表 -- */

test("styles.css 中出现的 chat__ 类名都登记在类名词汇表内", () => {
  const vocabulary = css.slice(0, css.indexOf(":root {"));
  assert.ok(vocabulary.length > 0, "未找到 styles.css 顶部词汇表");
  for (const cls of collectChatClasses(css)) {
    assert.ok(
      vocabulary.includes(cls),
      `类名 ${cls} 未登记进 styles.css 顶部词汇表`,
    );
  }
});

test("index.html 与 pages.js 用到的 chat__ 类名都在 styles.css 中定义", () => {
  const defined = new Set(collectChatClasses(css));
  for (const cls of collectChatClasses(html + "\n" + pages)) {
    assert.ok(defined.has(cls), `缺少 ${cls} 的样式定义`);
  }
});

/* ------------------------------------------------------------ 7 无回归 -- */

test("任务模式既有能力未回归", () => {
  assert.match(pages, /api\("\/api\/agent\/message"/);
  assert.match(pages, /api\("\/api\/tasks\/"\+encodeURIComponent\(taskId\)\+"\/cancel"/);
  assert.match(pages, /api\("\/api\/actions\/"\+encodeURIComponent\(action\.id\)\+"\/confirm"/);
  assert.match(pages, /api\("\/api\/actions\/"\+encodeURIComponent\(action\.id\)\+"\/deny"/);
  for (const id of [
    "agent-history",
    "agent-input",
    "agent-send",
    "agent-stop",
    "agent-stream-status",
    "pending-actions",
    "refresh-pending-actions",
    "agent-recent-tasks",
    "task-history-search",
    "task-history-prev",
    "task-history-next",
    "agent-refresh-tasks",
    "task-history-clear",
    "agent-clear-context",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 id="${id}"`);
  }
  assert.match(html, /<textarea[^>]*id="agent-input"[^>]*maxlength="2000"/);
});

/* ------------------------------------------------------------ 8 交付物 -- */

test("阶段文档存在", async () => {
  const doc = await readFile(
    new URL("../docs/phase-151-chat-direct-mode.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.length > 200, "阶段文档内容过短");
  for (const heading of [
    "Mode switch",
    "Direct chat stream",
    "Stop button",
    "Marvis styling",
    "Known limitations",
  ]) {
    assert.ok(doc.includes(heading), `阶段文档缺少「${heading}」章节`);
  }
});
