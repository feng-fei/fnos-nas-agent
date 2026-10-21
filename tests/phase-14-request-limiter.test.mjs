import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter } from "../apps/fnos-nas-agent/app/request-limiter.mjs";

test("fixed window limits attempts and resets after the window expires", () => {
  let time = 1000;
  const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 4, now: () => time });
  assert.equal(limiter.allow("client-a"), true);
  assert.equal(limiter.allow("client-a"), true);
  assert.equal(limiter.allow("client-a"), false);
  time = 2000;
  assert.equal(limiter.allow("client-a"), true);
});
test("successful authentication can reset a client's failure window", () => {
  const limiter = createFixedWindowLimiter({ limit: 1, now: () => 1000 });
  assert.equal(limiter.allow("client-a"), true);
  assert.equal(limiter.allow("client-a"), false);
  assert.equal(limiter.reset("client-a"), true);
  assert.equal(limiter.allow("client-a"), true);
});
test("tracking memory is bounded even when keys vary", () => {
  const limiter = createFixedWindowLimiter({ limit: 1, maxKeys: 2, now: () => 1000 });
  limiter.allow("a"); limiter.allow("b"); limiter.allow("c");
  assert.equal(limiter.snapshot().trackedKeys, 2);
  assert.equal(limiter.snapshot().maxKeys, 2);
});
test("invalid keys and invalid configuration fail closed", () => {
  const limiter = createFixedWindowLimiter();
  assert.equal(limiter.allow(""), false);
  assert.equal(limiter.allow("x".repeat(257)), false);
  assert.throws(() => createFixedWindowLimiter({ limit: 0 }), TypeError);
});
