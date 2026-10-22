import test from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_RENAME_MODES,
  planBatchRename,
  applyBatchRenamePlan,
} from "../apps/fnos-nas-agent/app/batch-rename.mjs";

function renamePlan() {
  return planBatchRename(
    [{ path: "a.txt" }, { path: "b.txt" }],
    { mode: "replace", find: "txt", replace: "md" },
  );
}

test("exports the four supported batch rename modes", () => {
  assert.deepEqual(BATCH_RENAME_MODES, ["replace", "prefix-suffix", "sequence", "normalize"]);
});

test("replace mode rewrites basename literally", () => {
  const result = planBatchRename(
    [{ path: "photo.jpg", name: "photo.jpg", kind: "file" }],
    { mode: "replace", find: "photo", replace: "image" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, [{ from: "photo.jpg", to: "image.jpg" }]);
  assert.deepEqual(result.summary, { total: 1, planned: 1, skipped: 0, conflicts: 0 });
});

test("replace mode is case sensitive by default and can be relaxed", () => {
  const strict = planBatchRename(
    [{ path: "IMG_001.JPG" }],
    { mode: "replace", find: "img", replace: "photo" },
  );
  assert.equal(strict.ok, true);
  assert.deepEqual(strict.plan, []);
  assert.deepEqual(strict.skipped, [{ path: "IMG_001.JPG", reason: "noop" }]);

  const relaxed = planBatchRename(
    [{ path: "IMG_001.JPG" }],
    { mode: "replace", find: "img", replace: "photo", caseSensitive: false },
  );
  assert.deepEqual(relaxed.plan, [{ from: "IMG_001.JPG", to: "photo_001.JPG" }]);
});

test("replace mode rejects an empty find string", () => {
  const result = planBatchRename([{ path: "a.txt" }], { mode: "replace", find: "", replace: "x" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.errors.map((error) => error.code), ["empty-find"]);
});

test("prefix-suffix mode wraps the whole basename with prefix and suffix", () => {
  const result = planBatchRename(
    [{ path: "photos/report.doc" }],
    { mode: "prefix-suffix", prefix: "2024-", suffix: "-final" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, [{ from: "photos/report.doc", to: "photos/2024-report.doc-final" }]);
});

test("prefix-suffix mode with empty prefix and suffix marks everything as noop", () => {
  const result = planBatchRename(
    [{ path: "a.txt" }, { path: "b.txt" }],
    { mode: "prefix-suffix" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.skipped, [
    { path: "a.txt", reason: "noop" },
    { path: "b.txt", reason: "noop" },
  ]);
  assert.deepEqual(result.summary, { total: 2, planned: 0, skipped: 2, conflicts: 0 });
});

test("sequence mode numbers entries in order and keeps the extension", () => {
  const result = planBatchRename(
    [{ path: "photos/photo.jpg" }, { path: "photos/notes.txt" }],
    { mode: "sequence" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, [
    { from: "photos/photo.jpg", to: "photos/photo-001.jpg" },
    { from: "photos/notes.txt", to: "photos/notes-002.txt" },
  ]);
});

test("sequence mode can drop extension preservation", () => {
  const result = planBatchRename(
    [{ path: "photo.jpg" }],
    { mode: "sequence", keepExtension: false },
  );
  assert.deepEqual(result.plan, [{ from: "photo.jpg", to: "photo.jpg-001" }]);
});

test("sequence mode honours start, step, width and separator", () => {
  const result = planBatchRename(
    [{ path: "a.txt" }, { path: "b.txt" }],
    { mode: "sequence", start: 7, step: 3, width: 2, separator: "_" },
  );
  assert.deepEqual(result.plan, [
    { from: "a.txt", to: "a_07.txt" },
    { from: "b.txt", to: "b_10.txt" },
  ]);
});

test("sequence mode treats directories as whole names without extension splitting", () => {
  const result = planBatchRename(
    [{ path: "photos.backup", kind: "dir" }],
    { mode: "sequence" },
  );
  assert.deepEqual(result.plan, [{ from: "photos.backup", to: "photos.backup-001" }]);
});

test("normalize mode trims, collapses whitespace and lowercases", () => {
  const result = planBatchRename(
    [{ path: "My Report  FINAL.txt" }],
    { mode: "normalize" },
  );
  assert.deepEqual(result.plan, [{ from: "My Report  FINAL.txt", to: "my-report-final.txt" }]);
});

test("normalize mode supports custom trim and replacement options", () => {
  const result = planBatchRename(
    [{ path: "  a  b  " }],
    { mode: "normalize", lowercase: false, spacesTo: "_", trim: false },
  );
  assert.deepEqual(result.plan, [{ from: "  a  b  ", to: "_a_b_" }]);
});

test("directory part is preserved byte for byte, including backslash paths", () => {
  const forward = planBatchRename(
    [{ path: "photos/2024/a.txt" }],
    { mode: "replace", find: "a", replace: "b" },
  );
  assert.deepEqual(forward.plan, [{ from: "photos/2024/a.txt", to: "photos/2024/b.txt" }]);

  const backslash = planBatchRename(
    [{ path: "photos\\2024\\a.txt" }],
    { mode: "replace", find: "a", replace: "b" },
  );
  assert.deepEqual(backslash.plan, [
    { from: "photos\\2024\\a.txt", to: "photos\\2024\\b.txt" },
  ]);
});

test("path separator in the resulting name is a conflict", () => {
  const result = planBatchRename(
    [{ path: "a" }],
    { mode: "replace", find: "a", replace: "/evil" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, []);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "path-separator");
  assert.equal(result.conflicts[0].path, "a");
});

test("dot or dot-dot as the resulting name is a conflict", () => {
  const dot = planBatchRename([{ path: "a" }], { mode: "replace", find: "a", replace: "." });
  assert.equal(dot.ok, false);
  assert.equal(dot.conflicts[0].kind, "dot-dot");

  const dotDot = planBatchRename([{ path: "a" }], { mode: "replace", find: "a", replace: ".." });
  assert.equal(dotDot.ok, false);
  assert.equal(dotDot.conflicts[0].kind, "dot-dot");
});

test("empty resulting name is a conflict", () => {
  const result = planBatchRename(
    [{ path: "a.txt" }],
    { mode: "replace", find: "a.txt", replace: "" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, []);
  assert.equal(result.conflicts[0].kind, "empty-name");
});

test("a target name already used in the same directory is a conflict", () => {
  const result = planBatchRename(
    [{ path: "a.txt" }, { path: "b.txt" }],
    { mode: "replace", find: "a", replace: "b" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), ["target-exists"]);
  assert.deepEqual(result.skipped, [{ path: "b.txt", reason: "noop" }]);
  assert.deepEqual(result.summary, { total: 2, planned: 0, skipped: 1, conflicts: 1 });
});

test("two planned entries resolving to one target is a conflict", () => {
  const result = planBatchRename(
    [{ path: "A.txt" }, { path: "a.TXT" }],
    { mode: "normalize" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, [{ from: "A.txt", to: "a.txt" }]);
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), ["duplicate-target"]);
  assert.equal(result.conflicts[0].path, "a.TXT");
  assert.deepEqual(result.summary, { total: 2, planned: 1, skipped: 0, conflicts: 1 });
});

test("source name equal to target name is skipped as noop", () => {
  const result = planBatchRename(
    [{ path: "a.txt" }],
    { mode: "replace", find: "a", replace: "a" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.skipped, [{ path: "a.txt", reason: "noop" }]);
});

test("too many entries is rejected without a partial plan", () => {
  const entries = [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }];
  const result = planBatchRename(entries, { mode: "replace", find: "txt", replace: "md" }, {
    maxEntries: 2,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errors.map((error) => error.code), ["too-many-entries"]);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.planned, 0);
});

test("default maxEntries is 200", () => {
  const makeEntries = (count) =>
    Array.from({ length: count }, (_, index) => ({ path: `f${index}.txt` }));
  const accepted = planBatchRename(makeEntries(200), { mode: "replace", find: "f", replace: "g" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.summary.planned, 200);

  const rejected = planBatchRename(makeEntries(201), { mode: "replace", find: "f", replace: "g" });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.errors.map((error) => error.code), ["too-many-entries"]);
});

test("malformed entries are skipped as invalid-entry without failing the plan", () => {
  const result = planBatchRename(
    [{ path: "dir/a.txt", name: "b.txt" }, null, { path: "c.txt", kind: "file" }],
    { mode: "replace", find: "c", replace: "d" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, [{ from: "c.txt", to: "d.txt" }]);
  assert.deepEqual(result.skipped, [
    { path: "dir/a.txt", reason: "invalid-entry" },
    { path: "", reason: "invalid-entry" },
  ]);
});

test("applyBatchRenamePlan applies every step in plan order", async () => {
  const calls = [];
  const result = await applyBatchRenamePlan(renamePlan(), {
    rename: async (from, to) => {
      calls.push(`${from}->${to}`);
    },
  });
  assert.deepEqual(calls, ["a.txt->a.md", "b.txt->b.md"]);
  assert.equal(result.applied, 2);
  assert.equal(result.failed, null);
  assert.equal(result.rolledBack, 0);
  assert.deepEqual(result.rollbackFailures, []);
});

test("a failing second step rolls back the first applied step", async () => {
  const calls = [];
  const result = await applyBatchRenamePlan(renamePlan(), {
    rename: async (from, to) => {
      calls.push(`${from}->${to}`);
      if (to === "b.md") throw new Error("disk full");
    },
  });
  assert.deepEqual(calls, ["a.txt->a.md", "b.txt->b.md", "a.md->a.txt"]);
  assert.equal(result.applied, 1);
  assert.deepEqual(result.failed, { from: "b.txt", to: "b.md", message: "disk full" });
  assert.equal(result.rolledBack, 1);
  assert.deepEqual(result.rollbackFailures, []);
});

test("a failing first step leaves nothing to roll back", async () => {
  const calls = [];
  const result = await applyBatchRenamePlan(renamePlan(), {
    rename: async (from, to) => {
      calls.push(`${from}->${to}`);
      throw new Error("permission denied");
    },
  });
  assert.deepEqual(calls, ["a.txt->a.md"]);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.failed, { from: "a.txt", to: "a.md", message: "permission denied" });
  assert.equal(result.rolledBack, 0);
  assert.deepEqual(result.rollbackFailures, []);
});

test("rollback failures are recorded instead of being swallowed", async () => {
  const result = await applyBatchRenamePlan(renamePlan(), {
    rename: async (from, to) => {
      if (to === "b.md") throw new Error("forward failed");
      if (from === "a.md") throw new Error("rollback failed");
    },
  });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.failed, { from: "b.txt", to: "b.md", message: "forward failed" });
  assert.equal(result.rolledBack, 0);
  assert.deepEqual(result.rollbackFailures, [
    {
      from: "a.md",
      to: "a.txt",
      source: { from: "a.txt", to: "a.md" },
      message: "rollback failed",
    },
  ]);
});

test("missing rename injection throws TypeError", async () => {
  await assert.rejects(
    applyBatchRenamePlan(renamePlan()),
    (error) => {
      assert.equal(error.name, "TypeError");
      return true;
    },
  );
});

test("non-function rename injection throws TypeError", async () => {
  await assert.rejects(
    applyBatchRenamePlan(renamePlan(), { rename: "not-a-function" }),
    (error) => {
      assert.equal(error.name, "TypeError");
      return true;
    },
  );
});

test("plan with ok=false is refused with plan-not-applicable", async () => {
  const rejected = planBatchRename([{ path: "a.txt" }], { mode: "replace", find: "" });
  await assert.rejects(
    applyBatchRenamePlan(rejected, { rename: async () => {} }),
    (error) => {
      assert.equal(error.code, "plan-not-applicable");
      return true;
    },
  );
});

test("malformed plan steps throw TypeError", async () => {
  await assert.rejects(
    applyBatchRenamePlan({ ok: true, plan: [{ from: 1, to: 2 }] }, { rename: async () => {} }),
    (error) => {
      assert.equal(error.name, "TypeError");
      return true;
    },
  );
});

test("planning is deterministic and keeps entries order", () => {
  const entries = [{ path: "z.txt" }, { path: "y.txt" }];
  const rule = { mode: "replace", find: "txt", replace: "md" };
  const first = planBatchRename(entries, rule);
  const second = planBatchRename(entries.map((entry) => ({ ...entry })), rule);
  assert.deepEqual(first, second);
  assert.deepEqual(first.plan.map((step) => step.from), ["z.txt", "y.txt"]);
});
