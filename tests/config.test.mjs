import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
test("defaults to loopback and a valid port", () => assert.deepEqual(loadConfig({}), { host: "127.0.0.1", port: 8787, accessToken: "" }));
test("rejects invalid ports", () => assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/));
test("requires a long token for non-loopback binding", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /AGENT_ACCESS_TOKEN/);
  assert.equal(loadConfig({ HOST: "0.0.0.0", AGENT_ACCESS_TOKEN: "x".repeat(32) }).host, "0.0.0.0");
});
