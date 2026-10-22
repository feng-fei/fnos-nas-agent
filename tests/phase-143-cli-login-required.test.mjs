import test from "node:test";
import assert from "node:assert/strict";
import { classifyTrimCliFailure, trimCliFailureKinds } from "../apps/fnos-nas-agent/app/trim-cli-health.mjs";
import { createTrimCliAdapter } from "../apps/fnos-nas-agent/app/trim-cli-adapter.mjs";

// The official CLI answers a read-only call on a profile that was never
// logged in with "saved proxy session is required; run login first". That is
// the very first thing a fresh operator hits, so it must be classified as a
// missing login instead of an unexpected 502.
const NEVER_LOGGED_IN = "failed to get system info from localhost:5666: saved proxy session is required; run login first";

test("a CLI profile without a session is reported as login required", () => {
  const failure = classifyTrimCliFailure({ code: 1, stderr: NEVER_LOGGED_IN });
  assert.equal(failure.kind, "login_required");
  assert.equal(failure.statusCode, 401);
  assert.equal(failure.connectionStatus, "auth_required");
  assert.equal(failure.authenticated, false);
  assert.match(failure.message, /尚未完成 OAuth 登录/);
  assert.match(failure.nextAction, /login/);
});

test("the login classification never leaks the raw CLI diagnostic", () => {
  const failure = classifyTrimCliFailure({
    code: 1,
    stderr: NEVER_LOGGED_IN + " profile=/home/user/.config/trim/session.json token=SECRET_VALUE"
  });
  assert.equal(failure.kind, "login_required");
  assert.doesNotMatch(JSON.stringify(failure), /SECRET_VALUE|session\.json|proxy session/);
});

test("an expired session keeps the auth_required category", () => {
  const failure = classifyTrimCliFailure({ code: 1, stderr: "401 unauthorized refresh_token=SECRET please login" });
  assert.equal(failure.kind, "auth_required");
  assert.equal(failure.statusCode, 401);
  assert.match(failure.nextAction, /refresh/);
});

test("the failure kinds expose the login guidance to the console", () => {
  const kinds = trimCliFailureKinds();
  const login = kinds.find(item => item.kind === "login_required");
  assert.ok(login);
  assert.equal(login.statusCode, 401);
  assert.equal(login.connectionStatus, "auth_required");
  assert.match(login.message, /尚未完成 OAuth 登录/);
});

test("the adapter answers 401 with the login guidance instead of a generic 502", async () => {
  const adapter = createTrimCliAdapter({
    binaryPath: "/opt/trim-cli",
    accessImpl: async () => {},
    execFileImpl: async () => {
      throw Object.assign(new Error("Command failed"), { code: 1, stderr: NEVER_LOGGED_IN });
    }
  });
  await assert.rejects(
    () => adapter.runReadOnly("system.info"),
    error => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.errorCategory, "login_required");
      assert.equal(error.authenticated, false);
      assert.match(error.message, /尚未完成 OAuth 登录/);
      assert.doesNotMatch(error.message, /proxy session/);
      return true;
    }
  );
});
