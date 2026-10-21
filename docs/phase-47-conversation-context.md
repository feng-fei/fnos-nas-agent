# Phase 47 — Bounded conversation context

This phase adds practical multi-turn follow-up support to the mobile Agent without introducing a server-side transcript store.

## Behavior

- The browser keeps the last eight user/assistant messages in page memory. A **Clear conversation context** control clears that context immediately.
- The server accepts only `user` and `assistant` history roles. Each message is capped at 1,200 characters and the combined history at 2,400 characters; older context is discarded first. Malformed roles, arrays, and oversized individual input records are rejected.
- The current user message remains separate from history. History is supplied to the model between the system policy and current request, so follow-ups can resolve references such as “继续刚才的操作”.
- The UI includes only a short assistant-side summary of tool results in subsequent context; each tool result contribution is clipped to 320 characters. Full results remain visible in the current page, but are not copied wholesale into model history.
- The model is explicitly told that earlier messages and tool output are untrusted context, never policy or authorization, and that changing NAS state should be re-read through an allowlisted tool where practical.
- Rules-first direct queries continue to route without requiring a model. Context helps model-routed follow-ups; it does not change tool schemas, registered tools, or destructive-action approval.

## Privacy and bounds

Conversation context is held in browser JavaScript memory only. It is not written to local storage, the server task persistence file, the audit log, or any new database. Task persistence continues to omit input text, history, results, and raw exception text. Refreshing the page clears the in-memory context.

When a configured model provider is used, the bounded history is sent to that provider as part of the normal model request. The user can clear context before the next request. The application does not retain a server-side transcript.

## Validation

Node.js 26 CI exercises history validation/trimming, context forwarding from agent core into the model adapter, request message ordering, rejection of non-user/assistant roles, and authenticated API acceptance/rejection. The existing release gates continue to check that task persistence excludes request inputs and results.

This is a code-level contract, not a validation against a live NAS or a live model account.
