# Phase 151 — Direct chat channel over HTTP

## 1. The problem

Marvis is a chat application first: the user talks to a model and the model
answers. The fnOS Agent only had the **planner** channel
(`POST /api/agent/message`), which answers with a JSON *plan* and runs the
tools of the catalogue. That channel is deliberately strict — every tool call
has to pass the registered input schema, a destructive action has to be
confirmed — and it is the wrong shape for a plain conversation.

The model adapter of the repository could already talk to an OpenAI
compatible provider, but only in the plan shape. There was no route that
streams a plain answer to the browser.

## 2. What this phase adds

* `apps/fnos-nas-agent/app/model-chat-adapter.mjs` — the transport of the
  chat channel: it streams the answer of the provider token by token.
* `POST /api/chat/message` — the route. It answers with
  `text/event-stream`.
* `GET /api/chat/status` — whether the channel can serve a turn at all.

## 3. The route contract

```http
POST /api/chat/message
Content-Type: application/json
Cookie: <session>

{ "messages": [ { "role": "user", "content": "你好" } ] }
```

The response is an event stream:

| Event | Payload | Meaning |
| --- | --- | --- |
| `delta` | `{ "text": "片段" }` | One increment of the answer. |
| `done` | `{ "text": "完整回答" }` | The answer is complete. |
| `error` | `{ "code", "message", "statusCode" }` | The turn failed. |

The HTTP status of a started stream is always `200`; a failure of the
provider is reported *inside* the stream, because the headers are already on
the wire when the provider is called.

Rejections before the stream starts:

| Condition | Status |
| --- | --- |
| No session | `401` |
| Foreign origin | `403` |
| Body is not JSON | `415` |
| `messages` is not an array | `400` |
| Rate limit | `429` |

## 4. Why the chat channel is separate from the planner

The two channels share the transport rules and nothing else:

* the **endpoint whitelist** is the one of the whole product: HTTPS only,
  plain HTTP only on loopback, no userinfo, no fragment, and the path has to
  end with `/chat/completions`. A chat request to an address outside that
  list never leaves the process;
* the **key** is the stored provider key, it is never echoed back;
* the **answer is bounded** (64 KiB) and the **conversation is bounded** (32
  messages, 2000 characters per message);
* a chat turn is plain text. It can never reach the tool contract by
  accident, and it cannot weaken it either: the chat adapter does not know
  the tool registry at all.

## 5. Cancellation

The route binds the abort signal of the request to the provider request. When
the client closes the connection — the browser button "stop" — the upstream
call is aborted and the partial answer that was already received stays in the
bubble of the client.

## 6. Files

| File | Role |
| --- | --- |
| `apps/fnos-nas-agent/app/model-chat-adapter.mjs` | The transport of the chat channel. |
| `apps/fnos-nas-agent/app/server.mjs` | The two routes. |
| `tests/phase-150-model-chat-adapter.test.mjs` | The adapter in isolation. |
| `tests/phase-151-chat-http.test.mjs` | The routes over authenticated HTTP. |
| `docs/phase-150-model-chat-adapter.md` | The adapter and its error vocabulary. |
