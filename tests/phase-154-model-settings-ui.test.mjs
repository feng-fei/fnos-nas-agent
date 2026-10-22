import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  fingerprintSecret,
  validateProviderForm,
  locateProviderError,
  buildProviderWizardSteps,
  summarizeWizard,
  describeCredentialState,
  renderProviderCard
} from "../apps/fnos-nas-agent/app/ui/model-settings.js";

const VALID_FORM = Object.freeze({
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "sk-test-secret-value",
  modelId: "gpt-4.1-mini"
});

test("fingerprintSecret returns a sha256 prefixed 8 hex digit fingerprint", async () => {
  const fingerprint = await fingerprintSecret("sk-test-secret-value");
  assert.match(fingerprint, /^sha256:[0-9a-f]{8}$/);
  assert.equal(fingerprint.length, "sha256:".length + 8);
});

test("fingerprintSecret is stable for the same secret and differs for another", async () => {
  const first = await fingerprintSecret("sk-test-secret-value");
  const second = await fingerprintSecret("sk-test-secret-value");
  const other = await fingerprintSecret("sk-another-secret");
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("fingerprintSecret returns null for empty, blank and non string secrets", async () => {
  assert.equal(await fingerprintSecret(""), null);
  assert.equal(await fingerprintSecret("   "), null);
  assert.equal(await fingerprintSecret(null), null);
  assert.equal(await fingerprintSecret(undefined), null);
  assert.equal(await fingerprintSecret(12345), null);
});

test("fingerprintSecret never contains the plaintext secret", async () => {
  const fingerprint = await fingerprintSecret("sk-super-secret-plaintext");
  assert.ok(!fingerprint.includes("sk-super-secret-plaintext"));
  assert.ok(!fingerprint.includes("super"));
});

test("validateProviderForm accepts a complete form", () => {
  const result = validateProviderForm(VALID_FORM);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
});

test("validateProviderForm reports a missing name on the name field", () => {
  const result = validateProviderForm({ ...VALID_FORM, name: "" });
  assert.equal(result.valid, false);
  assert.equal(result.errors.name, "请填写服务商名称");
  assert.equal(result.errors.baseUrl, undefined);
});

test("validateProviderForm reports a missing API key on the apiKey field", () => {
  const result = validateProviderForm({ ...VALID_FORM, apiKey: "" });
  assert.equal(result.valid, false);
  assert.equal(result.errors.apiKey, "请填写 API Key");
});

test("validateProviderForm reports a missing model id on the modelId field", () => {
  const result = validateProviderForm({ ...VALID_FORM, modelId: "  " });
  assert.equal(result.valid, false);
  assert.equal(result.errors.modelId, "请填写模型 ID");
});

test("validateProviderForm rejects a non http(s) endpoint protocol", () => {
  for (const bad of ["ftp://example.com/v1/chat/completions", "file:///etc/passwd", "javascript:alert(1)"]) {
    const result = validateProviderForm({ ...VALID_FORM, baseUrl: bad });
    assert.equal(result.valid, false, bad);
    assert.equal(result.errors.baseUrl, "接口地址必须以 http:// 或 https:// 开头", bad);
  }
});

test("validateProviderForm accepts plain http endpoints and rejects malformed ones", () => {
  const http = validateProviderForm({ ...VALID_FORM, baseUrl: "http://127.0.0.1:11434/v1/chat/completions" });
  assert.equal(http.valid, true);
  const broken = validateProviderForm({ ...VALID_FORM, baseUrl: "not a url" });
  assert.equal(broken.valid, false);
  assert.equal(broken.errors.baseUrl, "请填写正确的接口地址");
});

test("validateProviderForm accepts the endpoint and model aliases used by the existing form", () => {
  const result = validateProviderForm({
    name: "Moonshot",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    apiKey: "sk-moonshot",
    model: "kimi-k2-0905-preview"
  });
  assert.equal(result.valid, true);
});

test("validateProviderForm allows an empty API key only when editing with a stored key", () => {
  const editing = validateProviderForm({ ...VALID_FORM, apiKey: "" }, { requireApiKey: false, hasStoredKey: true });
  assert.equal(editing.valid, true);
  const editingWithoutStored = validateProviderForm({ ...VALID_FORM, apiKey: "" }, { requireApiKey: false });
  assert.equal(editingWithoutStored.valid, false);
  assert.equal(editingWithoutStored.errors.apiKey, "请填写 API Key");
});

test("validateProviderForm returns every failing field at once", () => {
  const result = validateProviderForm({ name: "", baseUrl: "", apiKey: "", modelId: "" });
  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.errors).sort(), ["apiKey", "baseUrl", "modelId", "name"]);
});

test("locateProviderError maps a backend code onto the offending field", () => {
  const map = { MODEL_INVALID_ENDPOINT: "baseUrl", MODEL_KEY_REQUIRED: "apiKey", MODEL_INVALID_FIELD: "modelId" };
  const endpointError = locateProviderError({ code: "MODEL_INVALID_ENDPOINT", error: "bad endpoint" }, map);
  assert.equal(endpointError.field, "baseUrl");
  assert.equal(endpointError.message, "bad endpoint");
  const unknown = locateProviderError({ code: "SOMETHING_ELSE", error: "boom" }, map);
  assert.equal(unknown.field, "");
  assert.equal(unknown.message, "boom");
});

test("buildProviderWizardSteps returns at least three ordered steps with fields", () => {
  const steps = buildProviderWizardSteps({});
  assert.ok(steps.length >= 3);
  assert.deepEqual(steps.map(step => step.key), ["provider", "credentials", "model", "confirm"]);
  assert.deepEqual(steps[0].fields, ["presetId", "name"]);
  assert.deepEqual(steps[1].fields, ["baseUrl", "apiKey"]);
  assert.deepEqual(steps[2].fields, ["modelId"]);
  for (const step of steps) {
    assert.equal(typeof step.title, "string");
    assert.ok(step.title.length > 0);
    assert.equal(typeof step.valid, "boolean");
  }
});

test("buildProviderWizardSteps marks each step valid only when its own fields are filled", () => {
  const empty = buildProviderWizardSteps({});
  assert.equal(empty[0].valid, false);
  assert.equal(empty[1].valid, false);
  assert.equal(empty[2].valid, false);
  assert.equal(empty[3].valid, false);

  const partial = buildProviderWizardSteps({ presetId: "openai", name: "OpenAI", baseUrl: VALID_FORM.baseUrl, apiKey: VALID_FORM.apiKey });
  assert.equal(partial[0].valid, true);
  assert.equal(partial[1].valid, true);
  assert.equal(partial[2].valid, false);
  assert.equal(partial[3].valid, false);

  const complete = buildProviderWizardSteps({ presetId: "openai", name: "OpenAI", baseUrl: VALID_FORM.baseUrl, apiKey: VALID_FORM.apiKey, modelId: VALID_FORM.modelId });
  assert.ok(complete.every(step => step.valid));
  const summary = summarizeWizard(complete);
  assert.equal(summary.canSubmit, true);
  assert.equal(summary.isComplete, true);
});

test("summarizeWizard reports the first incomplete step", () => {
  const summary = summarizeWizard(buildProviderWizardSteps({ presetId: "openai", name: "OpenAI" }));
  assert.equal(summary.canSubmit, false);
  assert.equal(summary.stepKey, "credentials");
});

test("describeCredentialState never leaks a plaintext secret even when the record carries one", () => {
  const state = describeCredentialState({
    hasKey: true,
    keyFingerprint: "sha256:1a2b3c4d",
    lastTestAt: "2026-10-22T10:00:00.000Z",
    lastTestOk: true,
    apiKey: "sk-plaintext-must-not-appear"
  });
  assert.equal(state.key, "configured");
  assert.equal(state.keyTone, "ok");
  assert.equal(state.test, "passed");
  assert.equal(state.testTone, "ok");
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("sk-plaintext-must-not-appear"));
  assert.ok(serialized.includes("sha256:1a2b3c4d"));
});

test("describeCredentialState distinguishes missing key and failed test", () => {
  const missing = describeCredentialState({ hasKey: false });
  assert.equal(missing.key, "missing");
  assert.equal(missing.keyTone, "muted");
  assert.equal(missing.test, "untested");

  const failed = describeCredentialState({ hasKey: true, keyFingerprint: "sha256:deadbeef", lastTestAt: "2026-10-22T10:00:00.000Z", lastTestOk: false });
  assert.equal(failed.test, "failed");
  assert.equal(failed.testTone, "danger");
});

test("renderProviderCard escapes user supplied values so markup cannot be injected", () => {
  const html = renderProviderCard({
    id: "abc",
    name: "<img src=x onerror=\"alert('x')\">",
    endpoint: "https://evil.example.com\"><script>alert(1)</script>",
    model: "<b>model</b>",
    enabled: true,
    isDefault: false,
    hasApiKey: true
  }, { keyFingerprint: "sha256:abcdef12" });

  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>model</b>"));
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("model-settings__card"));
  assert.ok(html.includes("sha256:abcdef12"));
});

test("renderProviderCard shows the default badge and the unavailable hint", () => {
  const html = renderProviderCard({
    id: "p1",
    name: "Moonshot",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "kimi-k2-0905-preview",
    enabled: true,
    isDefault: true,
    fallback: false,
    hasApiKey: true,
    lastTest: { ok: false, at: "2026-10-22T10:00:00.000Z" }
  }, { keyFingerprint: "sha256:12345678" });

  assert.ok(html.includes("当前默认"));
  assert.ok(html.includes("最近连接测试失败"));
  assert.ok(html.includes("上次调用失败"));
});

test("renderProviderCard escapes attribute values as well", () => {
  const html = renderProviderCard({
    id: '"><script>alert(1)</script>',
    name: "safe",
    endpoint: "https://example.com/v1/chat/completions",
    model: "m"
  });
  const attribute = html.slice(html.indexOf("data-provider-id="), html.indexOf("data-provider-id=") + 80);
  assert.ok(!attribute.includes("<script>"));
  assert.ok(attribute.includes("&quot;"));
});

test("escapeHtml neutralises the five dangerous characters", () => {
  assert.equal(escapeHtml("<a href=\"x\">&'</a>"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});
