import test from "node:test";
import assert from "node:assert/strict";
import { createSerialWriteQueue } from "../apps/fnos-nas-agent/app/serial-write-queue.mjs";

test("a failed persistence write does not poison later queued writes", async () => {
  const enqueue = createSerialWriteQueue();
  const order = [];
  const failed = enqueue(async () => {
    order.push("failed:start");
    await Promise.resolve();
    order.push("failed:end");
    throw new Error("simulated disk failure");
  });
  const recovered = enqueue(async () => {
    order.push("recovered");
    return "saved";
  });

  await assert.rejects(failed, /simulated disk failure/);
  assert.equal(await recovered, "saved");
  assert.deepEqual(order, ["failed:start", "failed:end", "recovered"]);
});

test("queued writes remain serial and preserve each write result", async () => {
  const enqueue = createSerialWriteQueue();
  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = enqueue(async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
    return 1;
  });
  const second = enqueue(async () => {
    order.push("second");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("serial write queue rejects non-function work", () => {
  const enqueue = createSerialWriteQueue();
  assert.throws(() => enqueue(null), /work must be a function/);
});
