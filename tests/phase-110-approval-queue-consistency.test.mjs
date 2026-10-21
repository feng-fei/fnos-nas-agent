import test from "node:test";
import assert from "node:assert/strict";
import { createActionApprovalService } from "../apps/fnos-nas-agent/app/action-approval-service.mjs";
import { createApprovalLedger } from "../apps/fnos-nas-agent/app/approval-ledger.mjs";

const tool = {
  id: "files.delete",
  title: "Delete file",
  description: "Delete one file after explicit confirmation",
  risk: "destructive",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 2048 } },
    required: ["path"],
    additionalProperties: false
  }
};

function fixture({ initialTime = 1_000 } = {}) {
  let time = initialTime;
  let nextId = 0;
  const invoked = [];
  const ledger = createApprovalLedger({ now: () => time, token: () => String(++nextId).padEnd(40, "t") });
  const service = createActionApprovalService({
    tools: { list: () => [tool], invoke: async (toolId, args) => { invoked.push({ toolId, args }); return { deleted: true }; } },
    ledger,
    now: () => time,
    id: () => "approval_" + String(++nextId).padStart(4, "0")
  });
  return { service, ledger, invoked, setTime: value => { time = value; } };
}

test("denying one approval removes every queued approval for that task", () => {
  const { service, ledger } = fixture();
  const first = service.request({ taskId: "task_12345678", toolId: tool.id, args: { path: "/volume/a.txt" } });
  const second = service.request({ taskId: "task_12345678", toolId: tool.id, args: { path: "/volume/b.txt" } });

  assert.equal(service.list().length, 2);
  assert.equal(service.deny(first.id), true);
  assert.deepEqual(service.list(), []);
  assert.equal(service.deny(second.id), false);
  assert.equal(ledger.snapshot().pending, 0);
});

test("expiration removes stale sibling queue entries when task-scoped grants are revoked", () => {
  const { service, ledger, setTime } = fixture();
  service.request({ taskId: "task_abcdefgh", toolId: tool.id, args: { path: "/volume/a.txt" } });
  service.request({ taskId: "task_abcdefgh", toolId: tool.id, args: { path: "/volume/b.txt" } });

  setTime(61_000);
  assert.deepEqual(service.list(), []);
  assert.equal(ledger.snapshot().pending, 0);
});

test("denying an approval does not affect a different task", () => {
  const { service } = fixture();
  const first = service.request({ taskId: "task_aaaaaaaa", toolId: tool.id, args: { path: "/volume/a.txt" } });
  const other = service.request({ taskId: "task_bbbbbbbb", toolId: tool.id, args: { path: "/volume/b.txt" } });

  assert.equal(service.deny(first.id), true);
  assert.deepEqual(service.list().map(item => item.id), [other.id]);
});

test("confirmation consumes the approval once and invokes only the bound registered tool", async () => {
  const { service, invoked } = fixture();
  const pending = service.request({ taskId: "task_87654321", toolId: tool.id, args: { path: "/volume/a.txt" } });

  const result = await service.confirm(pending.id);
  assert.deepEqual(result.result, { deleted: true });
  assert.deepEqual(invoked, [{ toolId: tool.id, args: { path: "/volume/a.txt" } }]);
  await assert.rejects(service.confirm(pending.id), { statusCode: 404 });
  assert.equal(invoked.length, 1);
});

test("unknown, non-destructive, and schema-invalid requests fail closed", () => {
  const { service } = fixture();
  assert.throws(() => service.request({ taskId: "task_12345678", toolId: "unknown.tool", args: {} }), { statusCode: 404 });
  assert.throws(() => service.request({ taskId: "task_12345678", toolId: "files.read", args: {} }), { statusCode: 404 });
  assert.throws(() => service.request({ taskId: "task_12345678", toolId: tool.id, args: { path: "" } }), { statusCode: 400 });
  assert.throws(() => service.request({ taskId: "task_12345678", toolId: tool.id, args: { path: "/volume/a", extra: true } }), { statusCode: 400 });
  assert.equal(service.snapshot().pending, 0);
});
