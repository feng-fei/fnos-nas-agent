import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
const taskManagerTests = await readFile(new URL("./phase-9-tasks.test.mjs", import.meta.url), "utf8");

test("task cancellation API distinguishes queued cancellation from running cancellation requests", () => {
  const start = server.indexOf("const cancelMatch = url.pathname.match");
  const end = server.indexOf("const taskMatch = url.pathname.match", start);
  assert.ok(start >= 0 && end > start, "task cancel route must be registered");
  const route = server.slice(start, end);
  assert.match(route, /taskManager\.cancel\(cancelMatch\[1\]\)/);
  assert.match(route, /if \(result\.cancelRequested\) return reply\(res, 202/);
  assert.match(route, /return reply\(res, 200, result\)/);
  assert.match(route, /return reply\(res, 409, \{ error: "Task is already terminal or cannot be cancelled\."/);
  assert.doesNotMatch(route, /Only queued tasks can be cancelled/);
});

test("running cancellation is explicitly cooperative and never claims to kill the current operation", () => {
  const start = server.indexOf("const cancelMatch = url.pathname.match");
  const end = server.indexOf("const taskMatch = url.pathname.match", start);
  const route = server.slice(start, end);
  assert.match(route, /The current tool will finish; no follow-up tool steps will be started/);
  assert.match(taskManagerTests, /running task cancellation waits for the active operation and stops cooperative follow-up work/);
  assert.match(taskManagerTests, /context\.shouldCancel\(\)/);
  assert.match(html, /已请求停止；当前工具会先完成，不会启动后续工具/);
  assert.match(html, /task\.cancelRequested\?"等待当前工具结束/);
});

test("queued cancellations remain immediate while missing IDs remain 404", () => {
  const start = server.indexOf("const cancelMatch = url.pathname.match");
  const end = server.indexOf("const taskMatch = url.pathname.match", start);
  const route = server.slice(start, end);
  assert.match(route, /if \(!result\) return reply\(res, 404, \{ error: "Task not found" \}\)/);
  assert.match(route, /if \(!result\.cancelled\) return reply\(res, 409/);
  assert.match(taskManagerTests, /queued tasks/);
});
