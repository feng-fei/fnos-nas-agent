import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const envExampleUrl = new URL(".env.example", root);
const securityUrl = new URL("docs/security.md", root);
const guideUrl = new URL("docs/phase-139-reverse-proxy-deployment.md", root);

// The variables the agent really reads, with the default that the source
// actually applies when the variable is unset.
const REAL_VARIABLES = [
  "HOST",
  "PORT",
  "TRIM_SERVICE_PORT",
  "AGENT_DATA_DIR",
  "AGENT_EXECUTION_MODE",
  "AGENT_TASK_TIMEOUT_MS",
  "AGENT_TRUST_PROXY",
  "TRIM_CLI_PATH",
  "TRIM_CLI_PROFILE"
];

// Variables that never existed. The old example file advertised them and the
// documentation must not bring them back.
const NONEXISTENT_VARIABLES = [
  "AGENT_ACCESS_TOKEN",
  "AGENT_API_KEY",
  "AGENT_SESSION_SECRET",
  "AGENT_ADMIN_TOKEN"
];

async function readText(url) {
  return readFile(fileURLToPath(url), "utf8");
}

function assignedVariables(text) {
  const names = new Set();
  const pattern = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm;
  let match = pattern.exec(text);
  while (match) {
    names.add(match[1]);
    match = pattern.exec(text);
  }
  return names;
}

test(".env.example documents every real environment variable with its real default", async () => {
  const text = await readText(envExampleUrl);
  const assigned = assignedVariables(text);

  const missing = REAL_VARIABLES.filter((name) => !assigned.has(name));
  assert.deepEqual(missing, [], `.env.example must document: ${missing.join(", ")}`);

  const unexpected = [...assigned].filter((name) => !REAL_VARIABLES.includes(name));
  assert.deepEqual(unexpected, [], `.env.example must not advertise unknown variables: ${unexpected.join(", ")}`);

  assert.match(text, /^HOST=0\.0\.0\.0$/m, "HOST must document the real default 0.0.0.0");
  assert.match(text, /^PORT=18787$/m, "PORT must document the real default 18787");
  assert.match(text, /^#\s*AGENT_EXECUTION_MODE=normal$/m, "AGENT_EXECUTION_MODE must document the default normal");
  assert.match(text, /^#\s*AGENT_TASK_TIMEOUT_MS=300000$/m, "AGENT_TASK_TIMEOUT_MS must document the default 300000");
  assert.match(text, /^#\s*AGENT_TRUST_PROXY=0$/m, "AGENT_TRUST_PROXY must document the default 0");
  assert.match(text, /^#\s*TRIM_CLI_PROFILE=home$/m, "TRIM_CLI_PROFILE must document the default home");
  assert.match(text, /^#\s*AGENT_DATA_DIR=/m, "AGENT_DATA_DIR must be documented");
  assert.match(text, /^#\s*TRIM_CLI_PATH=/m, "TRIM_CLI_PATH must be documented");
  assert.match(text, /^#\s*TRIM_SERVICE_PORT=18787$/m, "TRIM_SERVICE_PORT must be documented");

  assert.doesNotMatch(text, /^HOST=127\.0\.0\.1$/m, "127.0.0.1 is not the default listen address");
  assert.doesNotMatch(text, /PORT=8787/, "8787 is not the real listen port");
});

test(".env.example stays aligned with the variables the source reads", async () => {
  const source = [
    await readText(new URL("apps/fnos-nas-agent/app/server.mjs", root)),
    await readText(new URL("apps/fnos-nas-agent/app/execution-policy.mjs", root)),
    await readText(new URL("apps/fnos-nas-agent/app/trim-cli-adapter.mjs", root))
  ].join("\n");

  for (const name of REAL_VARIABLES) {
    assert.ok(source.includes(name), `the source must really use ${name}`);
  }
});

test(".env.example does not advertise variables that do not exist", async () => {
  const text = await readText(envExampleUrl);
  for (const name of NONEXISTENT_VARIABLES) {
    assert.ok(!text.includes(name), `${name} is not read by the server and must not be documented`);
  }
});

test(".env.example explains the default binding, the setup code and the proxy trust switch", async () => {
  const text = await readText(envExampleUrl);
  // The example file is a commented env file, so the comment markers are
  // removed before the prose is matched.
  const prose = text.replace(/^#\s?/gm, "").replace(/\s+/g, " ");

  assert.match(text, /0\.0\.0\.0/, "the default listen address must be stated");
  assert.match(prose, /every network interface|all network interfaces/i, "listening on every interface must be explained");
  assert.match(prose, /setup code/i, "the first-run setup code must be explained");
  assert.match(prose, /fnos-nas-agent first-run setup code/, "the setup code log line must be quoted");
  assert.match(text, /AGENT_TRUST_PROXY=1/, "the proxy opt-in must be explained");
  assert.match(text, /X-Forwarded-Proto/, "the trusted forwarding headers must be named");
});

test("docs/security.md documents reverse proxy and TLS termination", async () => {
  const text = await readText(securityUrl);

  assert.ok(text.includes("反向代理与 TLS 终止"), "the section title must be present");
  assert.match(text, /AGENT_TRUST_PROXY/, "the trust switch must be discussed");
  assert.match(text, /sameOrigin/, "the same-origin check must be discussed");
  assert.match(text, /Secure/, "the cookie Secure attribute must be discussed");
  assert.match(text, /X-Forwarded-Proto/, "the forwarded protocol header must be discussed");
  assert.match(text, /明文 HTTP/, "the plain HTTP risk must be discussed");
});

test("docs/phase-139-reverse-proxy-deployment.md exists with the deployment examples", async () => {
  const text = await readText(guideUrl);

  assert.match(text, /location \/ \{/, "an nginx location block must be shown");
  assert.match(text, /proxy_set_header X-Forwarded-Proto/, "X-Forwarded-Proto must be configured");
  assert.match(text, /proxy_set_header X-Forwarded-Host/, "X-Forwarded-Host must be configured");
  assert.match(text, /AGENT_TRUST_PROXY=1/, "the proxy opt-in must be shown");
  assert.match(text, /proxy_pass http:\/\/127\.0\.0\.1:18787/, "the upstream must be shown");
  assert.match(text, /WebSocket/i, "the WebSocket statement must be present");
  assert.match(text, /fnOS/, "the fnOS portal scenario must be covered");
});

test("the deployment guide contains the troubleshooting checklist", async () => {
  const text = await readText(guideUrl);

  assert.match(text, /403/, "the forbidden origin symptom must be listed");
  assert.match(text, /Forbidden origin/, "the forbidden origin error must be listed");
  assert.match(text, /Secure/, "the missing Secure cookie symptom must be listed");
  assert.match(text, /setup code/i, "the setup code symptom must be listed");
  assert.match(text, /AGENT_DATA_DIR/, "the data directory symptom must be listed");
});

test("the documentation files are UTF-8 without a byte order mark", async () => {
  for (const url of [envExampleUrl, securityUrl, guideUrl]) {
    const buffer = await readFile(fileURLToPath(url));
    assert.notEqual(buffer[0], 0xef, `${url.pathname} must not start with a UTF-8 BOM`);
    assert.ok(buffer.length > 0, `${url.pathname} must not be empty`);
    assert.doesNotMatch(buffer.toString("utf8"), /\uFFFD/, `${url.pathname} must not contain replacement characters`);
  }
});
