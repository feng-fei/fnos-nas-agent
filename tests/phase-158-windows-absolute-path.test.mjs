import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createSkillInstaller } from "../apps/fnos-nas-agent/app/skill-installer.mjs";

test("the skill installer accepts an absolute path on every platform", () => {
  // The guard used to compare the resolved path with a leading slash. That is
  // POSIX only, so on Windows every absolute path was rejected and the
  // service could not start with an app data directory.
  const absolute = path.resolve(path.sep === "\\" ? "C:\\fnos-agent-data" : "/tmp/fnos-agent-data");
  assert.doesNotThrow(() => createSkillInstaller({ dataDir: absolute }));
});

test("the skill installer still refuses a relative path", () => {
  assert.throws(() => createSkillInstaller({ dataDir: "relative/data" }), /absolute app data directory/);
  assert.throws(() => createSkillInstaller({ dataDir: "" }), /absolute app data directory/);
  assert.throws(() => createSkillInstaller({ dataDir: 42 }), /absolute app data directory/);
});
