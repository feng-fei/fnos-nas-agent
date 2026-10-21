import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("npm start launches the full Agent server, not the legacy skeleton", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(packageJson.scripts.start, "node apps/fnos-nas-agent/app/server.mjs");

  const fullServer = new URL("apps/fnos-nas-agent/app/server.mjs", root);
  await stat(fullServer);
  const source = await readFile(fullServer, "utf8");
  assert.match(source, /createAgentCore/);
  assert.match(source, /createModelProviderStore/);
  assert.match(source, /createFileManager/);
  assert.doesNotMatch(source, /mode:\s*"skeleton"/);
});
