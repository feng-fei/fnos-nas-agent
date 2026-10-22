# Phase 149 — Marvis-style chat window

## 1. The problem

The conversation page was a *form plus a text dump*. Every turn was rendered by
`renderAgentTurn(label, body)` in `apps/fnos-nas-agent/app/ui/pages.js`, which
built a `div.card` with a `strong` title and a single `pre` block. The agent's
answer, the task metadata and the output of every tool call were concatenated
into one `pre` element:

```js
details.push("工具 " + item.tool + "：\n" + formatOutputJson(item.result));
```

Consequences:

* the user could not tell their own message from the agent's answer, and
  could not see when a turn had started or finished;
* tool output — often large, machine-formatted JSON — was dumped into the
  middle of the prose, so a useful sentence was buried in noise;
* the input was a single-line `<input>`, so a long question could not be
  written naturally, and pressing Enter always submitted;
* there was no way to stop a running task from the conversation itself, only
  from the separate task-queue card;
* approval requests were rendered in a static "pending operations" card far
  away from the message that triggered them, so the operator had to correlate
  two regions of the page by hand;
* the client polled `GET /api/tasks/{id}` in a blind loop and had no notion of
  incremental progress.

## 2. What this phase adds

The UI layer only. No server module was touched by this phase; the streaming
endpoint is provided by the integration pass (`GET /api/tasks/{id}/events`),
and the front end degrades gracefully when it is absent.

| # | Feature | Where |
|---|---------|-------|
| A | Chat bubbles | `pages.js` `renderAgentTurn` |
| B | Multi-line input | `index.html` `#agent-input`, `pages.js` keydown handler |
| C | Tool call cards | `pages.js` `chatToolCard` / `chatRenderToolCards` |
| D | Stop button | `index.html` `#agent-stop`, `pages.js` `chatSetStopVisible` |
| E | Inline approvals | `pages.js` `refreshPendingActions` + `chatFindTurn` |
| F | Streaming progress | `pages.js` `chatOpenStream` / `chatAwaitTask` |
| G | Minimal Markdown | `pages.js` `chatRenderMarkdown` |

### 2.1 Chat bubbles

`renderAgentTurn(role, body, meta)` now builds a bubble instead of a card:

```html
<div class="chat__bubble chat__bubble--agent" data-task-id="…">
  <div class="chat__time">2026-10-22 18:05</div>
  <div class="chat__content">…</div>
  <div class="chat__tools">…</div>
  <div class="chat__approval">…</div>
</div>
```

The pre-existing design-system classes are reused as-is
(`.chat__bubble--user`, `.chat__bubble--agent`, `.chat__time`); the bubble
carries `data-task-id` so that later stages (approvals, tool cards) can find
the turn they belong to. Every append scrolls the thread to the bottom
(`host.scrollTop = host.scrollHeight`).

### 2.2 Multi-line input

`#agent-input` is a `<textarea maxlength="2000" rows="1">` now. Enter
submits, Shift+Enter (and Ctrl/Cmd/Alt+Enter) inserts a newline, and IME
composition is not interrupted (`event.isComposing` guard). The field grows
with its content up to 400px (Marvis ceiling, see phase 151) and scrolls beyond
that.

### 2.3 Tool call cards

`result.results[]` is no longer flattened into the prose. Each entry
(`{tool, result}`) becomes a collapsible card:

```html
<details class="chat__tool">
  <summary class="chat__tool__summary">工具 1 · list_directory</summary>
  <pre class="chat__tool__body">{ … formatted json … }</pre>
</details>
```

The body is rendered with the existing `formatOutputJson()` helper and is
truncated at 8000 characters with an explicit marker.

### 2.4 Stop button

`#agent-stop` lives next to the thread. While a task is running it is
visible and enabled; it posts `POST /api/tasks/{taskId}/cancel` — the same
endpoint the task-queue card already used. It is hidden and disabled again
when the turn ends. The server answers with `cancelRequested`, and the status
line explains that the current tool finishes first.

### 2.5 Inline approvals

`GET /api/actions/pending` already returns `taskId` for every pending action.
`refreshPendingActions()` now locates the bubble with that `taskId` and
renders the approval card inside it, under the agent turn that asked for it.
If no matching turn exists (for example an action raised by another session)
the card falls back to the old `#pending-actions` region, so nothing is ever
lost. The confirm / deny endpoints are unchanged:
`POST /api/actions/{id}/confirm` and `POST /api/actions/{id}/deny`.

### 2.6 Streaming progress

After the message is accepted, the client opens an `EventSource` on
`/api/tasks/{taskId}/events` and listens for exactly five event types:

```js
const CHAT_STREAM_EVENT_TYPES = ["progress", "tool", "approval", "done", "error"];
```

The payload shape is `{type, at, data}`; `data` carries the event-specific
body (`progress` → `{progress, stage}`, `tool` → `{tool, result}`,
`approval` → approval hint, `done` → the final task, `error` → `{message}`).

The polling loop is kept in parallel as the fallback path: the client polls
`GET /api/tasks/{taskId}` every 750ms until the task reaches a terminal state
(`completed` / `failed` / `cancelled`). If `EventSource` is unavailable, the
request fails, or the stream errors out, the polling loop alone still drives
the turn to completion — the two paths are not exclusive, so a stream that
dies halfway through does not strand the turn.

### 2.7 Minimal Markdown

A tiny renderer handles fenced code blocks and inline code. There is no
third-party Markdown library and no CDN. Everything is built with
`createElement` / `createTextNode`; no HTML string is ever parsed.

## 3. Safety

* No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in
  `apps/fnos-nas-agent/app/ui/` — user content and agent output always go
  through `textContent` or `createTextNode`.
* No dependency, no bundler, no external resource. The UI stays a set of
  classic scripts in global scope (`pages.js` / `core.js`); no `import` /
  `export` was introduced.
* Every new class name is registered in the class-name vocabulary at the top
  of `apps/fnos-nas-agent/app/ui/styles.css`, as the design system requires.

## 4. Files

* `apps/fnos-nas-agent/app/ui/index.html` — textarea, toolbar, stop button.
* `apps/fnos-nas-agent/app/ui/pages.js` — bubble renderer, tool cards, stream
  client, polling fallback, inline approvals, input handling.
* `apps/fnos-nas-agent/app/ui/styles.css` — new `.chat__*` rules and the
  updated vocabulary.
* `tests/phase-149-chat-window.test.mjs` — source-level assertions.

## 5. Known limitations

* The Markdown subset is deliberately small: fenced code blocks, inline code
  and paragraphs. Lists, tables, headings and links are not rendered.
* Streaming progress is best-effort. The percentage bar is only meaningful
  when the server sends a `progress` value; the label falls back to the stage
  or status text.
* Approvals that belong to a task whose turn is not on screen (page reload,
  another session) still appear in the `#pending-actions` card.
* `docs/README.md` carries an index count; adding this phase document makes
  that count stale. The count is maintained by the integration pass.
