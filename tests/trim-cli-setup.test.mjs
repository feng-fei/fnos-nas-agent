import test from "node:test";
import assert from "node:assert/strict";
import { createTrimCliLoginCommand, validateTrimCliLoginInput } from "../apps/fnos-nas-agent/app/trim-cli-setup.mjs";

const base = {
  host: "192.168.1.20",
  port: 5667,
  scheme: "https",
  binaryPath: "/var/apps/fnos-nas-agent/skill-tools/fnos/trim-cli",
  dataDir: "/var/apps/fnos-nas-agent/data",
  profile: "home",
  serviceUser: "fnos-nas-agent"
};

test("builds a quoted interactive OAuth command using Agent-owned profile paths", () => {
  const command = createTrimCliLoginCommand(base);
  assert.match(command, /'sudo' '-u' 'fnos-nas-agent' '--' 'env'/);
  assert.match(command, /'HOME=\/var\/apps\/fnos-nas-agent\/data'/);
  assert.match(command, /'XDG_CONFIG_HOME=\/var\/apps\/fnos-nas-agent\/data\/.config'/);
  assert.match(command, /'\/var\/apps\/fnos-nas-agent\/skill-tools\/fnos\/trim-cli'/);
  assert.match(command, /'--host' '192\.168\.1\.20' '--port' '5667' '--scheme' 'https'/);
  assert.match(command, /'login' '--no-open'$/);
  assert.doesNotMatch(command, /authorization[_ -]?code|access[_ -]?token|refresh[_ -]?token/i);
});

test("supports explicit refresh, HTTP opt-in, and self-signed TLS settings", () => {
  const refreshed = createTrimCliLoginCommand({ ...base, flow: "refresh" });
  assert.match(refreshed, /'login' '--refresh' '--no-open'$/);
  const http = createTrimCliLoginCommand({ ...base, scheme: "http" });
  assert.match(http, /'--scheme' 'http' '--allow-insecure-http' 'login'/);
  const selfSigned = createTrimCliLoginCommand({ ...base, allowSelfSigned: true });
  assert.match(selfSigned, /'--scheme' 'https' '--tls-insecure' 'login'/);
  assert.doesNotMatch(selfSigned, /--allow-insecure-http/);
});

test("shell-quotes trusted filesystem paths instead of interpolating them", () => {
  const command = createTrimCliLoginCommand({
    ...base,
    binaryPath: "/var/apps/O'Brien/trim-cli",
    dataDir: "/var/apps/Agent Data"
  });
  assert.match(command, /'\/var\/apps\/O'\\''Brien\/trim-cli'/);
  assert.match(command, /'HOME=\/var\/apps\/Agent Data'/);
  assert.match(command, /'XDG_CONFIG_HOME=\/var\/apps\/Agent Data\/.config'/);
});

test("rejects malformed hosts, URLs, port injection, and unsupported option fields", () => {
  assert.throws(() => createTrimCliLoginCommand({ ...base, host: "https://nas.example.com" }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, host: "nas.example.com; reboot" }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, host: "-option" }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, port: 22.5 }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, scheme: "file" }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, scheme: "http", allowSelfSigned: true }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, binaryPath: "trim-cli" }), { statusCode: 400 });
  assert.throws(() => createTrimCliLoginCommand({ ...base, dataDir: "relative/path" }), { statusCode: 400 });
});

test("accepts valid hostname and IP literals only from the limited request schema", () => {
  assert.deepEqual(validateTrimCliLoginInput({
    host: "nas.example.com", port: 443, scheme: "https", flow: "login"
  }), {
    host: "nas.example.com", port: 443, scheme: "https", allowSelfSigned: false, flow: "login"
  });
  assert.equal(validateTrimCliLoginInput({ host: "2001:db8::1", port: 5667, scheme: "https" }).host, "2001:db8::1");
  assert.throws(() => validateTrimCliLoginInput({ host: "nas", port: 443, scheme: "https", shell: "echo pwned" }), { statusCode: 400 });
});
