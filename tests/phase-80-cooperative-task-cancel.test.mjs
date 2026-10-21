import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../apps/fnos-nas-agent/app/ui/index.html", import.meta.url), "utf8");
const server = await readFile(new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url), "utf8");

test("mobile task UI offers cooperative cancellation for running tasks", () => {
  assert.match(html, /task\.status==="queued"\|\|task\.status==="running"/);
  assert.match(html, /请求停止/);
  assert.match(html, /等待当前工具结束/);
  assert.match(html, /当前工具会先完成，不会启动后续工具/);
  assert.match(server, /execute: \(input, context\) => agentCore\.run\(input, context\)/);
  assert.match(server, /taskManager\.cancel\(cancelMatch\[1\]\)/);
});
