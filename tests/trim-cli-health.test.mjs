import test from "node:test";
import assert from "node:assert/strict";
import { classifyTrimCliFailure, createTrimCliConnectionHealth } from "../apps/fnos-nas-agent/app/trim-cli-health.mjs";

test("classifies expired OAuth sessions without leaking CLI diagnostics", () => {
  const failure = classifyTrimCliFailure({
    code: 1,
    message: "CLI error",
    stderr: "401 unauthorized refresh_token=SUPER_SECRET_TOKEN please login"
  });
  assert.equal(failure.kind, "auth_required");
  assert.equal(failure.statusCode, 401);
  assert.equal(failure.authenticated, false);
  assert.match(failure.nextAction, /refresh/);
  assert.doesNotMatch(JSON.stringify(failure), /SUPER_SECRET_TOKEN|refresh_token=/);
});

test("classifies missing scopes separately from invalid authentication", () => {
  const failure = classifyTrimCliFailure({
    code: 1,
    stderr: "insufficient scope trim.photos.read; token=SECRET"
  });
  assert.equal(failure.kind, "scope_missing");
  assert.equal(failure.statusCode, 403);
  assert.equal(failure.authenticated, null);
  assert.match(failure.nextAction, /无法增加 scope|增加 scope/);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/);
});

test("classifies network, timeout, TLS, file permission, profile and rate-limit errors", () => {
  assert.equal(classifyTrimCliFailure({ code: "ECONNREFUSED" }).kind, "network_error");
  assert.equal(classifyTrimCliFailure({ code: "ETIMEDOUT" }).kind, "timeout");
  assert.equal(classifyTrimCliFailure({ code: "SELF_SIGNED_CERT_IN_CHAIN" }).kind, "tls_error");
  assert.equal(classifyTrimCliFailure({ code: "EACCES" }).kind, "permission_denied");
  assert.equal(classifyTrimCliFailure({ stderr: "profile file is invalid" }).kind, "profile_unavailable");
  assert.equal(classifyTrimCliFailure({ stderr: "HTTP 429 too many requests" }).kind, "rate_limited");
  assert.equal(classifyTrimCliFailure({ code: "TRIM_CLI_UNAVAILABLE" }).kind, "executable_missing");
  assert.equal(classifyTrimCliFailure({ stderr: "maxBuffer length exceeded" }).kind, "output_too_large");
});

test("unknown CLI errors expose only fixed guidance and never raw stderr", () => {
  const failure = classifyTrimCliFailure({
    code: 1,
    message: "private-session-file=/home/user/token.json",
    stderr: "refresh_token=NEVER_SHOW_THIS"
  });
  assert.equal(failure.kind, "unexpected");
  assert.doesNotMatch(JSON.stringify(failure), /private-session-file|token\.json|NEVER_SHOW_THIS/);
});

test("connection health reports fresh success, actionable failures and staleness", () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const health = createTrimCliConnectionHealth({ now: () => clock, ttlMs: 60_000 });
  assert.equal(health.snapshot().connectionStatus, "not_tested");
  const ok = health.success("system.info");
  assert.equal(ok.connectionStatus, "connected");
  assert.equal(ok.authenticated, true);
  assert.equal(ok.command, "system.info");
  clock += 30_000;
  const failed = health.failure(classifyTrimCliFailure({ code: "ECONNREFUSED" }));
  assert.equal(failed.connectionStatus, "network_error");
  assert.equal(failed.authenticated, null);
  assert.match(failed.nextAction, /地址|端口|网络/);
  clock += 61_000;
  const stale = health.snapshot();
  assert.equal(stale.connectionStatus, "stale");
  assert.equal(stale.authenticated, null);
});

test("missing CLI is not reported as authenticated or connected", () => {
  const health = createTrimCliConnectionHealth();
  const snapshot = health.snapshot(false);
  assert.equal(snapshot.connectionStatus, "not_ready");
  assert.equal(snapshot.authenticated, null);
});
