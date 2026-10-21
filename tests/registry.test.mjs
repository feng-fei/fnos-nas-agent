import test from "node:test";
import assert from "node:assert/strict";
import { registerTool, listTools, runTool } from "../src/policy/registry.mjs";
test("starts with no tools", () => assert.deepEqual(listTools(), []));
test("rejects mutating tools", () => assert.throws(() => registerTool({ name: "restart-service", description: "Restart a service", risk: "mutation", run: async () => ({ ok: true }) }), /Only read-only tools/));
test("rejects unknown tools", async () => assert.rejects(() => runTool("unknown-tool"), /Unknown tool/));
