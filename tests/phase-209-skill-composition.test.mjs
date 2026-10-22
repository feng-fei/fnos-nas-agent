import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MAX_COMPOSITION_STEPS,
  MAX_COMPOSITION_DEPTH,
  PERMISSION_LEVELS,
  normalizeComposition,
  validateComposition,
  topologicalOrder,
  planCompositionRun,
  mergeCompositionPermissions
} from "../apps/fnos-nas-agent/app/skill-composition.mjs";

const SKILL_SOURCE = new URL(
  "../apps/fnos-nas-agent/app/skill-composition.mjs",
  import.meta.url
);

function validCompositionInput() {
  return {
    id: "release-pipeline",
    name: "Release pipeline",
    description: "Build, test and ship",
    steps: [
      { id: "build", skillId: "builder", inputs: { target: "nas" } },
      {
        id: "test",
        skillId: "tester",
        dependsOn: ["build"],
        when: { field: "quality.score", equals: "high" }
      },
      { id: "ship", skillId: "shipper", dependsOn: ["test"] }
    ],
    permissions: ["write", "read-only", "write"]
  };
}

function numberedSteps(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    skillId: "skill-a"
  }));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

test("normalizeComposition builds a canonical composition", () => {
  const result = normalizeComposition(validCompositionInput());
  assert.equal(result.ok, true);
  const composition = result.composition;
  assert.equal(composition.id, "release-pipeline");
  assert.equal(composition.name, "Release pipeline");
  assert.equal(composition.description, "Build, test and ship");
  assert.deepEqual(composition.permissions, ["read-only", "write"]);
  assert.deepEqual(composition.steps.map((step) => step.id), ["build", "test", "ship"]);
  assert.deepEqual(composition.steps[1].dependsOn, ["build"]);
  assert.deepEqual(composition.steps[1].when, { field: "quality.score", equals: "high" });
  assert.deepEqual(composition.steps[0].inputs, { target: "nas" });
});

test("normalizeComposition defaults the name to the id and trims description", () => {
  const result = normalizeComposition({
    id: "display-defaults",
    name: "   ",
    description: "  trimmed  ",
    steps: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.composition.name, "display-defaults");
  assert.equal(result.composition.description, "trimmed");
});

test("normalizeComposition rejects non-objects and missing steps", () => {
  for (const input of [null, undefined, "composition", 42, []]) {
    assert.deepEqual(normalizeComposition(input), { ok: false, reason: "invalid-composition" });
  }
  assert.deepEqual(normalizeComposition({ id: "no-steps" }), {
    ok: false,
    reason: "invalid-steps"
  });
  assert.deepEqual(normalizeComposition({ id: "bad-steps", steps: {} }), {
    ok: false,
    reason: "invalid-steps"
  });
});

test("normalizeComposition rejects invalid composition ids", () => {
  for (const id of ["Bad Id", "UPPER", "a".repeat(65), ""]) {
    assert.deepEqual(normalizeComposition({ id, steps: [] }), {
      ok: false,
      reason: "invalid-composition-id"
    });
  }
});

test("normalizeComposition rejects invalid step ids", () => {
  for (const id of ["bad id", "a".repeat(65), ""]) {
    assert.deepEqual(
      normalizeComposition({ id: "step-ids", steps: [{ id, skillId: "worker" }] }),
      { ok: false, reason: "invalid-step-id" }
    );
  }
});

test("normalizeComposition rejects invalid skill ids", () => {
  for (const skillId of ["Bad", "a".repeat(65), ""]) {
    assert.deepEqual(
      normalizeComposition({ id: "skill-ids", steps: [{ id: "s1", skillId }] }),
      { ok: false, reason: "invalid-skill-id" }
    );
  }
});

test("normalizeComposition rejects duplicate, self and unknown dependencies", () => {
  assert.deepEqual(
    normalizeComposition({
      id: "duplicate",
      steps: [
        { id: "s1", skillId: "worker" },
        { id: "s1", skillId: "worker" }
      ]
    }),
    { ok: false, reason: "duplicate-step" }
  );
  assert.deepEqual(
    normalizeComposition({ id: "self", steps: [{ id: "s1", skillId: "worker", dependsOn: ["s1"] }] }),
    { ok: false, reason: "self-dependency" }
  );
  assert.deepEqual(
    normalizeComposition({ id: "unknown", steps: [{ id: "s1", skillId: "worker", dependsOn: ["ghost"] }] }),
    { ok: false, reason: "unknown-dependency" }
  );
});

test("normalizeComposition rejects malformed inputs, conditions and permissions", () => {
  const cases = [
    [{ id: "inputs", steps: [{ id: "s1", skillId: "worker", inputs: [] }] }, "invalid-inputs"],
    [
      { id: "condition-field", steps: [{ id: "s1", skillId: "worker", when: { equals: true } }] },
      "invalid-condition"
    ],
    [
      { id: "condition-equals", steps: [{ id: "s1", skillId: "worker", when: { field: "a" } }] },
      "invalid-condition"
    ],
    [{ id: "permissions-type", steps: [], permissions: "read-only" }, "invalid-permissions"],
    [{ id: "permission-value", steps: [], permissions: ["root"] }, "unknown-permission"]
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(normalizeComposition(input), { ok: false, reason });
  }
});

test("normalizeComposition accepts exactly MAX_COMPOSITION_STEPS and rejects one more", () => {
  const accepted = normalizeComposition({
    id: "twenty-steps",
    steps: numberedSteps(MAX_COMPOSITION_STEPS)
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.composition.steps.length, MAX_COMPOSITION_STEPS);

  const rejected = normalizeComposition({
    id: "twenty-one-steps",
    steps: numberedSteps(MAX_COMPOSITION_STEPS + 1)
  });
  assert.deepEqual(rejected, { ok: false, reason: "too-many-steps" });
});

test("normalizeComposition deep-copies inputs and never mutates the input", () => {
  const input = validCompositionInput();
  input.steps[0].inputs = { target: "nas", options: { safe: true } };
  const snapshot = structuredClone(input);
  const result = normalizeComposition(input);
  assert.equal(result.ok, true);
  assert.deepEqual(input, snapshot);

  input.steps[0].inputs.options.safe = false;
  assert.equal(result.composition.steps[0].inputs.options.safe, true);

  result.composition.steps[1].when.equals = "low";
  assert.equal(input.steps[1].when.equals, "high");
});

test("validateComposition accepts a well-formed composition", () => {
  const composition = normalizeComposition(validCompositionInput()).composition;
  const result = validateComposition(composition, {
    skills: [
      { id: "builder", permission: "write" },
      { id: "tester", permission: "write" },
      { id: "shipper", permission: "write" }
    ]
  });
  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

test("validateComposition reports unknown-skill", () => {
  const result = validateComposition(
    { id: "unknown-skill", steps: [{ id: "s1", skillId: "ghost" }] },
    { skills: ["known"] }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["unknown-skill"]);
  assert.equal(result.errors[0].stepId, "s1");
});

test("validateComposition reports dependency-cycle", () => {
  const result = validateComposition(
    {
      id: "cycle",
      steps: [
        { id: "a", skillId: "worker", dependsOn: ["b"] },
        { id: "b", skillId: "worker", dependsOn: ["a"] }
      ]
    },
    { skills: ["worker"] }
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "dependency-cycle"));
});

test("validateComposition reports dependency-order", () => {
  const result = validateComposition(
    {
      id: "order",
      steps: [
        { id: "early", skillId: "worker", dependsOn: ["late"] },
        { id: "late", skillId: "worker" }
      ]
    },
    { skills: ["worker"] }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["dependency-order"]);
  assert.equal(result.errors[0].stepId, "early");
});

test("validateComposition reports missing-input for required inputs and references", () => {
  const result = validateComposition(
    {
      id: "inputs",
      steps: [
        { id: "publish", skillId: "publisher", inputs: {} },
        { id: "notify", skillId: "notifier", inputs: { message: "${ghost.value}" } }
      ]
    },
    {
      skills: [
        { id: "publisher", requiredInputs: ["target"] },
        { id: "notifier" }
      ]
    }
  );
  const missing = result.errors.filter((error) => error.code === "missing-input");
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((error) => error.stepId).sort(), ["notify", "publish"]);

  const invalidInputs = validateComposition(
    { id: "bad-inputs", steps: [{ id: "s1", skillId: "notifier", inputs: [] }] },
    { skills: [{ id: "notifier" }] }
  );
  assert.equal(invalidInputs.ok, false);
  assert.equal(invalidInputs.errors[0].code, "missing-input");
});

test("validateComposition reports permission-escalation", () => {
  const composition = {
    id: "escalation",
    permissions: ["read-only"],
    steps: [
      { id: "read", skillId: "reader" },
      { id: "clean", skillId: "cleaner" }
    ]
  };
  const skills = [
    { id: "reader", permission: "read-only" },
    { id: "cleaner", permission: "destructive" }
  ];
  const result = validateComposition(composition, { skills });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["permission-escalation"]);
  assert.equal(result.errors[0].stepId, "clean");

  const undeclared = validateComposition({ ...composition, permissions: [] }, { skills });
  assert.equal(undeclared.ok, true);
});

test("validateComposition reports duplicate-step", () => {
  const result = validateComposition(
    {
      id: "duplicate",
      steps: [
        { id: "a", skillId: "worker" },
        { id: "a", skillId: "worker" }
      ]
    },
    { skills: ["worker"] }
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "duplicate-step"));
});

test("validateComposition reports condition-unreachable", () => {
  const result = validateComposition(
    {
      id: "conditions",
      steps: [
        { id: "s1", skillId: "worker" },
        {
          id: "s2",
          skillId: "worker",
          dependsOn: ["s1"],
          when: { field: "${s1.status}", equals: "ok" }
        },
        {
          id: "s3",
          skillId: "worker",
          dependsOn: ["s1"],
          when: { field: "${s2.status}" }
        },
        { id: "s4", skillId: "worker", when: { field: "${ghost.status}", equals: 1 } }
      ]
    },
    { skills: ["worker"] }
  );
  assert.equal(result.ok, false);
  const conditionErrors = result.errors.filter((error) => error.code === "condition-unreachable");
  assert.equal(conditionErrors.length, 2);
  assert.deepEqual(conditionErrors.map((error) => error.stepId).sort(), ["s3", "s4"]);
});

test("validateComposition warns when the dependency chain is deeper than MAX_COMPOSITION_DEPTH", () => {
  const steps = [];
  for (let index = 0; index < MAX_COMPOSITION_DEPTH + 2; index++) {
    steps.push({
      id: `s${index}`,
      skillId: "worker",
      dependsOn: index === 0 ? [] : [`s${index - 1}`]
    });
  }
  const result = validateComposition(
    { id: "deep", steps, permissions: [] },
    { skills: [{ id: "worker", permission: "read-only" }] }
  );
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "dependency-depth-exceeded");
});

test("topologicalOrder keeps a stable declaration order", () => {
  const result = topologicalOrder({
    steps: [
      { id: "build", dependsOn: [] },
      { id: "lint", dependsOn: ["build"] },
      { id: "test", dependsOn: ["build"] },
      { id: "ship", dependsOn: ["lint", "test"] }
    ]
  });
  assert.deepEqual(result, { order: ["build", "lint", "test", "ship"], cycle: null });

  const independent = topologicalOrder({
    steps: [{ id: "c" }, { id: "a" }, { id: "b" }]
  });
  assert.deepEqual(independent, { order: ["c", "a", "b"], cycle: null });
});

test("topologicalOrder returns a cycle instead of throwing", () => {
  const result = topologicalOrder({
    steps: [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] }
    ]
  });
  assert.deepEqual(result.order, []);
  assert.ok(Array.isArray(result.cycle));
  assert.deepEqual(result.cycle.map((entry) => entry.stepId).sort(), ["a", "b"]);
});

test("planCompositionRun plans a runnable composition in dependency order", () => {
  const composition = normalizeComposition(validCompositionInput()).composition;
  const skills = {
    builder: { permission: "write" },
    tester: { permission: "read-only" },
    shipper: { permission: "write" }
  };
  const plan = planCompositionRun(composition, {
    resolveSkill: (skillId) => skills[skillId] ?? null,
    facts: { quality: { score: "high" } }
  });
  assert.equal(plan.runnable, true);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.steps.map((step) => step.stepId), ["build", "test", "ship"]);
  assert.deepEqual(plan.steps.map((step) => step.permission), ["write", "read-only", "write"]);
  assert.deepEqual(plan.steps[2].dependsOn, ["test"]);
  assert.equal(plan.effectivePermissions, "write");
});

test("planCompositionRun skips unmet conditions and their dependents", () => {
  const composition = normalizeComposition(validCompositionInput()).composition;
  const plan = planCompositionRun(composition, {
    resolveSkill: () => ({ permission: "write" }),
    facts: { quality: { score: "low" } }
  });
  assert.equal(plan.runnable, true);
  assert.deepEqual(plan.steps.map((step) => step.stepId), ["build"]);
  assert.deepEqual(plan.skipped, [
    { stepId: "test", reason: "condition-not-met" },
    { stepId: "ship", reason: "dependency-skipped" }
  ]);
});

test("planCompositionRun skips a step whose skill cannot be resolved", () => {
  const composition = normalizeComposition({
    id: "missing-skill",
    steps: [{ id: "s1", skillId: "ghost" }]
  }).composition;
  const plan = planCompositionRun(composition, { resolveSkill: () => null });
  assert.deepEqual(plan, {
    runnable: false,
    skipped: [{ stepId: "s1", reason: "unknown-skill" }],
    steps: [],
    effectivePermissions: "read-only"
  });
});

test("planCompositionRun skips a step with an unknown dependency", () => {
  const plan = planCompositionRun(
    { id: "unknown-dependency", steps: [{ id: "solo", skillId: "writer", dependsOn: ["ghost"] }] },
    { resolveSkill: () => ({ permission: "write" }) }
  );
  assert.equal(plan.runnable, false);
  assert.deepEqual(plan.skipped, [{ stepId: "solo", reason: "unknown-dependency" }]);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.effectivePermissions, "write");
});

test("planCompositionRun refuses every step when the graph has a cycle", () => {
  const plan = planCompositionRun(
    {
      id: "cycle-plan",
      steps: [
        { id: "a", skillId: "worker", dependsOn: ["b"] },
        { id: "b", skillId: "worker", dependsOn: ["a"] }
      ]
    },
    { resolveSkill: () => ({ permission: "write" }) }
  );
  assert.equal(plan.runnable, false);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped, [
    { stepId: "a", reason: "dependency-cycle" },
    { stepId: "b", reason: "dependency-cycle" }
  ]);
});

test("planCompositionRun treats a throwing resolver as unknown-skill", () => {
  const plan = planCompositionRun(
    { id: "throwing-resolver", steps: [{ id: "s1", skillId: "worker" }] },
    {
      resolveSkill: () => {
        throw new Error("boom");
      }
    }
  );
  assert.deepEqual(plan.skipped, [{ stepId: "s1", reason: "unknown-skill" }]);
});

test("mergeCompositionPermissions covers all three levels", () => {
  const composition = {
    steps: [
      { id: "s1", skillId: "a" },
      { id: "s2", skillId: "b" },
      { id: "s3", skillId: "c" }
    ]
  };
  assert.equal(
    mergeCompositionPermissions(composition, { a: "read-only", b: "read-only", c: "read-only" }),
    "read-only"
  );
  assert.equal(
    mergeCompositionPermissions(composition, { a: "read-only", b: "write", c: "read-only" }),
    "write"
  );
  assert.equal(
    mergeCompositionPermissions(composition, { a: "read-only", b: "write", c: "destructive" }),
    "destructive"
  );
  assert.equal(
    mergeCompositionPermissions(
      composition,
      new Map([
        ["a", "read-only"],
        ["b", "read-only"],
        ["c", "destructive"]
      ])
    ),
    "destructive"
  );
  assert.equal(
    mergeCompositionPermissions(composition, [
      { id: "a" },
      { id: "b", permission: "write" },
      { id: "c" }
    ]),
    "write"
  );
});

test("mergeCompositionPermissions never lets a composition understate a destructive step", () => {
  const composition = {
    id: "safe-wrapper",
    permissions: ["read-only"],
    steps: [
      { id: "inspect", skillId: "reader" },
      { id: "clean", skillId: "cleaner" }
    ]
  };
  assert.equal(
    mergeCompositionPermissions(composition, { reader: "read-only", cleaner: "destructive" }),
    "destructive"
  );
});

test("mergeCompositionPermissions returns read-only for an empty composition", () => {
  assert.equal(
    mergeCompositionPermissions({ id: "empty", steps: [], permissions: ["destructive"] }, {}),
    "read-only"
  );
  assert.equal(mergeCompositionPermissions({ id: "empty-2", steps: [] }, null), "read-only");
});

test("an empty composition is valid everywhere and never throws", () => {
  const normalized = normalizeComposition({ id: "empty", steps: [] });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.composition.permissions, []);
  assert.deepEqual(topologicalOrder(normalized.composition), { order: [], cycle: null });
  assert.deepEqual(validateComposition(normalized.composition), {
    ok: true,
    errors: [],
    warnings: []
  });
  assert.deepEqual(planCompositionRun(normalized.composition), {
    runnable: false,
    skipped: [],
    steps: [],
    effectivePermissions: "read-only"
  });
  assert.equal(mergeCompositionPermissions(normalized.composition, {}), "read-only");
});

test("a deeply frozen input is accepted without being modified", () => {
  const input = deepFreeze(validCompositionInput());
  const normalized = normalizeComposition(input);
  assert.equal(normalized.ok, true);

  const composition = deepFreeze(normalized.composition);
  const skills = deepFreeze([
    { id: "builder", permission: "write", requiredInputs: ["target"] },
    { id: "tester", permission: "write" },
    { id: "shipper", permission: "write" }
  ]);
  const facts = deepFreeze({ quality: { score: "high" } });

  assert.doesNotThrow(() => validateComposition(composition, { skills }));
  assert.doesNotThrow(() =>
    planCompositionRun(composition, {
      resolveSkill: () => ({ permission: "write" }),
      facts
    })
  );
  assert.doesNotThrow(() =>
    mergeCompositionPermissions(composition, { builder: "write", tester: "write", shipper: "write" })
  );
});

test("the module is pure: no imports, no I/O, no shell, no process access", async () => {
  const source = await readFile(SKILL_SOURCE, "utf8");
  assert.ok(source.length > 1000);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bfrom\s+["']node:/);
  assert.doesNotMatch(source, /\bchild_process\b/);
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.doesNotMatch(source, /\bspawnSync\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bconsole\./);
  assert.doesNotMatch(source, /\bprocess\./);
});

test("the exported limits are frozen and match the documented values", () => {
  assert.equal(MAX_COMPOSITION_STEPS, 20);
  assert.equal(MAX_COMPOSITION_DEPTH, 3);
  assert.deepEqual(PERMISSION_LEVELS, ["read-only", "write", "destructive"]);
  assert.equal(Object.isFrozen(PERMISSION_LEVELS), true);
});
