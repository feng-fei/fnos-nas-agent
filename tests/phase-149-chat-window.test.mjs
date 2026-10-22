import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readUiSource } from "./helpers/ui-source.mjs";

/**
 * Phase 149 — Marvis 风格对话窗口（聊天气泡 / 多行输入 / 工具卡片 / 停止按钮 /
 * 内联审批 / 流式进度 + 轮询回退 / 极简 Markdown）。
 *
 * 本文件只做源码断言：仓库没有 jsdom，也没有浏览器环境，
 * 因此与 tests/model-provider-ui.test.mjs 保持同一风格。
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

/* ------------------------------------------------------------------ A 气泡 -- */

test("对话区保留线程容器并提供状态位与停止按钮", () => {
  assert.match(html, /id="agent-history"/);
  assert.match(html, /class="chat__thread"/);
  assert.match(html, /id="agent-stream-status"/);
  assert.match(html, /id="agent-stop"/);
  assert.match(html, /class="btn[^"]*chat__stop"/);
});

test("renderAgentTurn 使用已有的聊天气泡类", () => {
  assert.match(pages, /chat__bubble--user/);
  assert.match(pages, /chat__bubble--agent/);
  assert.match(pages, /chat__time/);
  assert.match(pages, /function renderAgentTurn\(/);
  assert.match(pages, /bubble\.dataset\.taskId=/);
});

test("消息追加后自动滚动到底部", () => {
  assert.match(pages, /scrollTop\s*=\s*host\.scrollHeight/);
});

test("正文一律用 textContent / createTextNode 渲染，禁止 innerHTML", () => {
  for (const [name, text] of [["pages.js", pages], ["core.js", core], ["index.html", html]]) {
    assert.doesNotMatch(text, /innerHTML/, `${name} 不得出现 innerHTML`);
    assert.doesNotMatch(text, /outerHTML/, `${name} 不得出现 outerHTML`);
    assert.doesNotMatch(text, /insertAdjacentHTML/, `${name} 不得出现 insertAdjacentHTML`);
    assert.doesNotMatch(text, /document\.write\(/, `${name} 不得使用 document.write`);
  }
  assert.match(pages, /\.textContent=/);
  assert.match(pages, /createTextNode\(/);
  assert.match(pages, /createDocumentFragment\(/);
});

/* ------------------------------------------------------------------ B 输入 -- */

test("#agent-input 改为多行 textarea 且保留 2000 字上限", () => {
  assert.match(html, /<textarea[^>]*id="agent-input"/);
  assert.match(html, /<textarea[^>]*id="agent-input"[^>]*maxlength="2000"/);
  assert.doesNotMatch(html, /<input[^>]*id="agent-input"/);
});

test("Enter 发送、Shift+Enter 换行", () => {
  assert.match(pages, /event\.key!=="Enter"/);
  assert.match(pages, /event\.shiftKey\|\|event\.ctrlKey\|\|event\.metaKey\|\|event\.altKey/);
  assert.match(pages, /event\.isComposing/);
  assert.match(pages, /requestSubmit\(\)/);
  assert.match(pages, /event\.preventDefault\(\)/);
});

test("输入框随内容自增高", () => {
  assert.match(pages, /function chatAutoGrowInput\(/);
  assert.match(pages, /field\.style\.height=/);
  assert.match(css, /\.composer__input \{[^}]*resize:\s*none/);
  assert.match(css, /\.composer__input \{[^}]*max-height:\s*400px/);
});

/* ------------------------------------------------------------------ C 工具 -- */

test("工具结果渲染为可折叠 details 卡片", () => {
  assert.match(pages, /createElement\("details"\)/);
  assert.match(pages, /chat__tool/);
  assert.match(pages, /chat__tool__summary/);
  assert.match(pages, /chat__tool__body/);
  assert.match(pages, /function chatRenderToolCards\(/);
  assert.match(pages, /result\.results\|\|\[\]/);
});

test("旧的纯文本工具转储已移除", () => {
  assert.doesNotMatch(pages, /details\.push\("工具 "/);
  assert.doesNotMatch(pages, /"工具 "\+item\.tool\+"：\\n"\+formatOutputJson/);
});

/* ------------------------------------------------------------------ D 停止 -- */

test("停止按钮调用任务取消接口", () => {
  assert.match(pages, /api\("\/api\/tasks\/"\+encodeURIComponent\(taskId\)\+"\/cancel",\{method:"POST"\}\)/);
  assert.match(pages, /function chatSetStopVisible\(/);
  assert.match(pages, /button\.hidden=!taskId/);
  assert.match(pages, /button\.disabled=!taskId/);
  assert.match(css, /\.chat__stop\[hidden\]/);
});

/* ------------------------------------------------------------------ E 审批 -- */

test("待确认操作按 taskId 内联到对应气泡", () => {
  assert.match(pages, /chatFindTurn\(action\.taskId\)/);
  assert.match(pages, /chatApprovalNodes/);
  assert.match(pages, /chat__approval/);
});

test("确认 / 拒绝端点保持不变", () => {
  assert.match(pages, /api\("\/api\/actions\/"\+encodeURIComponent\(action\.id\)\+"\/confirm",\{method:"POST"/);
  assert.match(pages, /api\("\/api\/actions\/"\+encodeURIComponent\(action\.id\)\+"\/deny",\{method:"POST"/);
  assert.match(pages, /api\("\/api\/actions\/pending"\)/);
});

test("审批卡片、任务队列与上下文清空锚点未回归", () => {
  for (const id of [
    "#pending-actions",
    "#refresh-pending-actions",
    "#agent-recent-tasks",
    "#task-history-search",
    "#task-history-prev",
    "#task-history-next",
    "#agent-refresh-tasks",
    "#task-history-clear",
    "#agent-clear-context",
    "#agent-send",
    "#agent-error",
  ]) {
    assert.ok(html.includes(`id="${id.slice(1)}"`), `index.html 缺少 ${id}`);
  }
});

/* ------------------------------------------------------------------ F 流式 -- */

test("流式进度使用同源 EventSource，事件类型只认五种", () => {
  assert.match(pages, /new EventSource\("\/api\/tasks\/"\+encodeURIComponent\(taskId\)\+"\/events"\)/);
  assert.match(
    pages,
    /const CHAT_STREAM_EVENT_TYPES=\["progress","tool","approval","done","error"\]/,
  );
  assert.match(pages, /CHAT_STREAM_EVENT_TYPES\.includes\(type\)/);
});

test("流式不可用时回退到 750ms 轮询", () => {
  assert.match(pages, /typeof EventSource!=="function"/);
  assert.match(pages, /setTimeout\(resolve,750\)/);
  assert.match(pages, /api\("\/api\/tasks\/"\+encodeURIComponent\(taskId\)\)/);
  assert.match(pages, /state\.streamFailed=true/);
  assert.match(pages, /function chatAwaitTask\(/);
  assert.match(pages, /function chatFinalizeTask\(/);
});

test("审批中状态会触发待确认操作刷新", () => {
  assert.match(pages, /task\.status==="awaiting-approval"/);
});

/* ------------------------------------------------------------------ G 渲染 -- */

test("极简 Markdown 由自写渲染器处理，无第三方库", () => {
  assert.match(pages, /function chatRenderMarkdown\(/);
  assert.match(pages, /function chatCodeBlock\(/);
  assert.match(pages, /function chatRenderInline\(/);
  assert.match(pages, /`{3}/);
  assert.match(pages, /chat__code-inline/);
  assert.doesNotMatch(source, /marked|markdown-it|showdown|remark/i);
});

/* ------------------------------------------------------------------ 零依赖 -- */

test("零依赖：无外链资源、无 import/export", () => {
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/);
  assert.doesNotMatch(html, /cdn\./);
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /url\(https?:/);
  assert.doesNotMatch(pages, /(?:^|\n)\s*import\s/);
  assert.doesNotMatch(pages, /(?:^|\n)\s*export\s/);
  assert.doesNotMatch(core, /(?:^|\n)\s*import\s/);
  assert.doesNotMatch(core, /(?:^|\n)\s*export\s/);
});

/* ------------------------------------------------------------------ 词汇表 -- */

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

test("多行输入与对话区使用既有类名", () => {
  assert.match(html, /class="input composer__input"/);
  assert.match(html, /class="composer"/);
  assert.match(css, /\.composer__input \{/);
  assert.match(css, /\.composer__send \{/);
});

/* ------------------------------------------------------------------ 交付物 -- */

test("阶段文档存在", async () => {
  const doc = await readFile(
    new URL("../docs/phase-149-chat-window.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.length > 200, "阶段文档内容过短");
  for (const heading of [
    "Chat bubbles",
    "Multi-line input",
    "Tool call cards",
    "Stop button",
    "Inline approvals",
    "Streaming progress",
  ]) {
    assert.ok(doc.includes(heading), `阶段文档缺少「${heading}」章节`);
  }
});
