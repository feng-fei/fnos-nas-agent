import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("FPK workflow smoke-tests the staged bundled Node runtime before packaging", async () => {
  const workflow = await readFile(".github/workflows/build-fpk.yml", "utf8");
  const stageAt = workflow.indexOf("- name: Stage native FPK");
  const smokeAt = workflow.indexOf("- name: Smoke test bundled runtime and FPK lifecycle");
  const packerAt = workflow.indexOf("- name: Install verified fnpack");
  assert.ok(stageAt >= 0 && smokeAt > stageAt && packerAt > smokeAt,
    "the staged application must pass its lifecycle smoke test before fnpack packaging");
  const smoke = workflow.slice(smokeAt, packerAt);
  assert.match(smoke, /TRIM_APPDEST="\$stage\/app"/);
  assert.match(smoke, /TRIM_PKGVAR="\$data"/);
  assert.match(smoke, /TRIM_SERVICE_PORT=0/);
  assert.match(smoke, /bash "\$stage\/cmd\/main" "\$1"/);
  assert.match(smoke, /run_lifecycle start/);
  assert.match(smoke, /run_lifecycle status/);
  assert.match(smoke, /run_lifecycle stop/);
  assert.match(smoke, /start must be idempotent|agent\.pid/);
  assert.match(smoke, /test "\$status" -eq 3/);
});
