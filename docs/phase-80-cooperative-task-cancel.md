# Phase 80 — Cooperative running-task cancellation

The mobile task history can now request cancellation for a running Agent task, not just remove a queued task.

- Queued tasks are cancelled immediately.
- Running tasks receive a cooperative cancellation request.
- The current tool invocation is allowed to finish; the Agent checks the cancellation flag before starting each subsequent tool.
- If cancellation arrives too late (after the final tool has already completed), the task may complete normally.
- No shell process is killed, no current file operation is forcibly interrupted, and no automatic retry is performed.

The UI reports that cancellation is a request, not an instantaneous interrupt. Tests verify that a multi-tool plan stops before invoking the next tool and that private exception details remain hidden.
