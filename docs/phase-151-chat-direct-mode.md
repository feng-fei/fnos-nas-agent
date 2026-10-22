# Phase 151 — Marvis dual-mode chat window (task mode / direct chat)

## 1. The problem

Phase 149 turned the conversation page into a real chat window (bubbles,
multi-line input, tool cards, inline approvals, stop button, streaming
progress), but it could only talk to the *task* pipeline: every message became
a NAS tool task (`POST /api/agent/message`), went through the task queue, and
was answered with tool output.

That is the right shape for "list the shared folders" or "open that
directory", but it is the wrong shape for a plain question. Asking
"how does fnOS decide which storage pool to write to?" used to create a task,
poll it, and answer with whatever the tools happened to return — and the
tool cards, the approval cards and the task-queue card were always on screen
even though a direct answer needed none of them.

The backend now exposes a dedicated direct-chat channel:

* `GET /api/chat/status` → `{ "enabled": bool, "providerConfigured": bool, "model": string | null, … }`
* `POST /api/chat/message` with `{ "messages": [ { "role": "user" | "assistant" | "system", "content": "…" } ] }`
  answering with `text/event-stream`:
  * `event: delta` → `data {"text":"片段"}`
  * `event: done` → `data {"text":"完整回答"}`
  * `event: error` → `data {"code","message","statusCode"}`

## 2. What this phase adds

Front end only. `server.mjs` was **not** touched by this phase.

| # | Feature | Where |
|---|---------|-------|
| 1 | Mode switch | `index.html` `.chat__modes`, `pages.js` `chatApplyMode` |
| 2 | Direct chat stream | `pages.js` `chatSendDirect` / `chatReadSseStream` |
| 3 | Stop button (direct) | `pages.js` `chatSetStopDirect` + `AbortController` |
| 4 | Marvis styling | `styles.css` `.chat__modes` / `.chat__mode` / bubbles / composer |

### 2.1 Mode switch

The chat card now starts with a two-state segmented control:

```html
<div class="chat__modes" role="group" aria-label="对话模式">
  <button class="chat__mode" id="chat-mode-task" type="button" aria-pressed="true" data-chat-mode="task">任务模式</button>
  <button class="chat__mode" id="chat-mode-direct" type="button" aria-pressed="false" data-chat-mode="direct">对话模式</button>
</div>
```

`chatApplyMode(mode, persist)` is the single place that switches state:

* it sets `aria-pressed` on both buttons and `data-chat-mode` on the chat root
  (`#agent-chat`);
* it hides the "pending dangerous operations" card (`#agent-pending-card`) and
  the task-queue card (`#agent-task-queue-card`) in direct mode — a direct
  answer never needs an approval or a task;
* it rewrites the hint line (`#agent-mode-hint`) and the input placeholder;
* it stores the selection in `localStorage` under
  `fnos-nas-agent.chat-mode`, and `chatReadStoredMode()` restores it on load,
  so a reload keeps the operator's choice.

Inside the thread, task-only affordances are hidden in direct mode as well
(`.chat[data-chat-mode="direct"] .chat__tools`, `… .chat__approval`).

### 2.2 Direct chat stream

`POST /api/chat/message` cannot be consumed with `EventSource` — `EventSource`
is a GET-only API and the endpoint needs a JSON body. The client therefore
uses `fetch` and reads the response body as a stream:

```js
const response = await api("/api/chat/message", {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "text/event-stream" },
  body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
  signal: controller.signal,
});
await chatReadSseStream(response, (frame) => { … });
```

`chatReadSseStream` obtains the reader (`response.body.getReader()`), decodes
chunks with a `TextDecoder` in streaming mode and feeds the accumulated buffer
to `chatSplitSseFrames()`, which splits on `\r\n\r\n`, `\n\n` or `\r\r`.
`chatParseSseFrame()` then reads the `event:` line and joins the `data:` lines,
parsing the payload as JSON (a non-JSON payload is kept as `{ raw }`).

The three server events map to the UI as follows:

* `delta` → the fragment is appended to the assistant bubble with
  `document.createTextNode()` (never `innerHTML`);
* `done` → the bubble content is replaced by the final text;
* `error` → `data.message` is shown in `#agent-error` and in the status line,
  and the stream stops.

Before any request is sent the client asks `GET /api/chat/status`. When
`enabled` is not `true` the message **尚未配置可用的模型服务商** is shown and
**no** request is made, so an unconfigured installation never produces a
useless 4xx round trip.

The task pipeline is untouched: in task mode the form still posts to
`/api/agent/message`, polls `GET /api/tasks/{id}` and renders tool cards,
approvals and progress as before.

### 2.3 Stop button (direct)

The existing `#agent-stop` button is shared by both modes. In direct mode it
aborts the in-flight request through an `AbortController`:

```js
if (chatDirectController) {
  chatStopButton.disabled = true;
  try { chatDirectController.abort(); } catch {}
  chatSetStatus("已停止");
  return;
}
```

The `AbortError` is caught separately: the text that already arrived stays in
the bubble (`chatDirectStreamText`), the status becomes “已停止”, and the
button is hidden again.

### 2.4 Marvis styling

The visual language follows the Marvis reference, expressed with the existing
CSS custom properties so that the dark theme keeps working:

* user bubble — `background: linear-gradient(0deg, #7b483514 0%, var(--surface) 100%), var(--surface)`,
  `padding: 20px`, `border-radius: 20px`, `max-width: 600px`;
* agent bubble — no surface at all (`background: transparent`, `box-shadow: none`),
  pure text;
* composer — `min-height: 134px`, `max-height: 400px`, `border-radius: 20px`,
  `background: var(--surface-glass)` (a new token: `rgba(255,255,255,.8)` in
  light mode, `rgba(21,27,35,.8)` in dark mode).

The auto-growing input follows the new ceiling: `chatAutoGrowInput` now caps
the inline height at 400px.

## 3. Safety

* No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in
  `apps/fnos-nas-agent/app/ui/` — streamed fragments are appended as text
  nodes, the final answer replaces the bubble content with a text node.
* No dependency, no bundler, no external resource, no third-party Markdown
  or SSE library. The UI stays classic scripts in global scope; no `import` /
  `export` was introduced.
* Every new class name (`.chat__modes`, `.chat__mode`, `.chat__mode-hint`) is
  registered in the class-name vocabulary at the top of
  `apps/fnos-nas-agent/app/ui/styles.css`.

## 4. Files

* `apps/fnos-nas-agent/app/ui/index.html` — mode switch, chat root id, card ids.
* `apps/fnos-nas-agent/app/ui/pages.js` — direct chat mode block, mode
  routing in the submit handler, abort-aware stop button.
* `apps/fnos-nas-agent/app/ui/styles.css` — mode switch styles, Marvis bubble
  and composer tweaks, `--surface-glass` token, updated vocabulary.
* `tests/phase-151-chat-direct-mode.test.mjs` — source-level assertions.
* `tests/phase-149-chat-window.test.mjs` — one stale assertion updated: the
  composer max-height is 400px (Marvis) instead of 160px.

## 5. Known limitations

* The direct channel sends only the current user turn
  (`messages: [{ role: "user", content }]`). Multi-turn context is not yet
  carried over; the task pipeline keeps its own `conversationContext`.
* In direct mode the model is only reachable through the configured
  provider; when `GET /api/chat/status` reports `enabled: false` the request
  is not sent at all.
* Task-mode bubbles stay visible after switching to direct mode, and the
  direct-mode CSS hides the tool / approval blocks inside them.
* `docs/README.md` carries an index count; adding this phase document makes
  that count stale. The count is maintained by the integration pass.
