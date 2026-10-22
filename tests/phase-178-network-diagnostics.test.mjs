import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORK_DIAGNOSTIC_CHECKS,
  CONFIDENCE_LEVELS,
  CERT_EXPIRY_WARNING_DAYS,
  READ_ONLY_SUGGESTIONS,
  diagnoseDns,
  detectGateway,
  checkServiceConnectivity,
  analyzeThroughput,
  locateConnectionFailure,
  checkCertificate,
  inspectReverseProxy,
  checkUpgrade,
  runConnectivityPatrol
} from "../apps/fnos-nas-agent/app/network-diagnostics.mjs";

const NOW = "2026-10-22T12:00:00.000Z";

test("dns diagnosis stays unknown without results", () => {
  const result = diagnoseDns({ name: "nas.local" });
  assert.equal(result.status, "unknown");
  assert.equal(result.stage, "unknown");
  assert.deepEqual(result.causes, []);
});

test("dns servfail is a confirmed resolver failure", () => {
  const result = diagnoseDns({ name: "nas.local", results: [{ status: "SERVFAIL", resolver: "10.0.0.1" }] });
  assert.equal(result.stage, "resolve");
  assert.equal(result.causes[0].code, "dns-server-failure");
  assert.equal(result.causes[0].confidence, "confirmed");
  assert.ok(result.suggestions.length > 0);
});

test("dns timeout across every resolver adds a suspected egress cause", () => {
  const result = diagnoseDns({
    name: "nas.local",
    results: [
      { status: "timeout", resolver: "10.0.0.1" },
      { status: "timeout", resolver: "10.0.0.2" }
    ]
  });
  const codes = result.causes.map(item => item.code);
  assert.ok(codes.includes("dns-timeout"));
  assert.ok(codes.includes("dns-egress-blocked"));
  assert.equal(result.summary.allFailed, true);
});

test("dns nxdomain names the record that is missing", () => {
  const result = diagnoseDns({ name: "nope.local", results: [{ status: "NXDOMAIN" }] });
  assert.equal(result.causes[0].code, "dns-name-not-found");
  assert.equal(result.causes[0].confidence, "confirmed");
});

test("gateway detection stays unknown without a default route", () => {
  const result = detectGateway({ routes: [{ destination: "10.0.0.0/24", gateway: "10.0.0.1" }] });
  assert.equal(result.status, "unknown");
  assert.equal(result.gateway, null);
});

test("gateway detection reports an unreachable default gateway", () => {
  const result = detectGateway({
    routes: [{ destination: "default", gateway: "192.168.1.1", iface: "eth0", metric: 100 }],
    probes: [{ target: "192.168.1.1", reachable: false }]
  });
  assert.equal(result.status, "ok");
  assert.equal(result.gateway, "192.168.1.1");
  assert.equal(result.reachable, false);
  assert.equal(result.causes[0].code, "gateway-unreachable");
});

test("gateway detection flags multiple default routes and a link-local gateway", () => {
  const result = detectGateway({
    routes: [
      { destination: "default", gateway: "192.168.1.1", metric: 100 },
      { destination: "0.0.0.0/0", gateway: "10.0.0.1", metric: 200 }
    ],
    probes: []
  });
  const codes = result.causes.map(item => item.code);
  assert.ok(codes.includes("gateway-multiple-defaults"));
  assert.equal(result.candidates.length, 2);
  const linkLocal = detectGateway({ routes: [{ destination: "default", gateway: "169.254.10.1" }] });
  assert.ok(linkLocal.causes.some(item => item.code === "gateway-link-local"));
});

test("service connectivity distinguishes refused from unlistened", () => {
  const result = checkServiceConnectivity({
    targets: [
      { host: "10.0.0.5", port: 8080, result: "refused", listening: true },
      { host: "10.0.0.5", port: 9090, result: "refused", listening: false },
      { host: "10.0.0.5", port: 443, result: "reachable" },
      { host: "10.0.0.9", port: 22, result: "timeout" }
    ]
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.refused, 1);
  assert.equal(result.summary.unlistened, 1);
  assert.equal(result.summary.timeout, 1);
  assert.equal(result.targets[1].result, "unlistened");
});

test("service connectivity turns an unknown result into unknown, not healthy", () => {
  const result = checkServiceConnectivity({ targets: [{ host: "10.0.0.5", port: 80, result: "weird" }] });
  assert.equal(result.targets[0].result, "unknown");
  assert.equal(result.summary.unknown, 1);
});

test("service connectivity is bounded", () => {
  const targets = Array.from({ length: 150 }, (_, index) => ({ host: `10.0.0.${index % 250}`, port: 80, result: "reachable" }));
  const result = checkServiceConnectivity({ targets });
  assert.equal(result.targets.length, 100);
});

test("throughput analysis reports average, peak and jitter", () => {
  const result = analyzeThroughput({ samples: [100, 100, 100, 100] });
  assert.equal(result.status, "ok");
  assert.equal(result.average, 100);
  assert.equal(result.peak, 100);
  assert.equal(result.jitter, 0);
  assert.equal(result.idle, false);
});

test("throughput analysis flags an unstable link and a fully idle one", () => {
  const unstable = analyzeThroughput({ samples: [1000, 10, 900, 5] });
  assert.ok(unstable.causes.some(item => item.code === "throughput-unstable"));
  const idle = analyzeThroughput({ samples: [0, 0, 0] });
  assert.equal(idle.idle, true);
  assert.ok(idle.causes.some(item => item.code === "throughput-idle"));
});

test("throughput analysis stays unknown without samples", () => {
  assert.equal(analyzeThroughput({}).status, "unknown");
});

test("connection failure is located at the first failing stage", () => {
  const result = locateConnectionFailure({
    stages: {
      resolve: { ok: true },
      route: { ok: true },
      tcp: { ok: false, result: "refused" },
      tls: { ok: false },
      application: { ok: false }
    }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.stage, "tcp");
  assert.equal(result.causes[0].confidence, "confirmed");
});

test("connection failure with a healthy chain reports an application layer suspicion", () => {
  const result = locateConnectionFailure({
    stages: {
      resolve: { ok: true },
      route: { ok: true },
      tcp: { ok: true },
      tls: { ok: true },
      application: { ok: false }
    }
  });
  assert.equal(result.stage, "application");
  assert.equal(result.causes[0].confidence, "likely");
});

test("connection failure stays unknown without stage data", () => {
  assert.equal(locateConnectionFailure({}).status, "unknown");
});

test("certificate check reports the remaining days and the warning window", () => {
  const result = checkCertificate({
    host: "nas.local",
    now: NOW,
    certificate: { subjectCN: "nas.local", sanList: ["nas.local"], notAfter: "2026-10-30T00:00:00.000Z" }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.expiresInDays, 7);
  assert.equal(result.expiringSoon, true);
  assert.equal(result.hostnameMatches, true);
  assert.equal(result.summary.warningDays, CERT_EXPIRY_WARNING_DAYS);
});

test("certificate check flags an expired and mismatched certificate", () => {
  const result = checkCertificate({
    host: "nas.local",
    now: NOW,
    certificate: { subjectCN: "other.local", notAfter: "2026-10-01T00:00:00.000Z", issuer: "other.local" }
  });
  const codes = result.causes.map(item => item.code);
  assert.ok(codes.includes("certificate-expired"));
  assert.ok(codes.includes("certificate-hostname-mismatch"));
  assert.equal(result.selfSigned, true);
});

test("certificate check stays unknown without a certificate", () => {
  const result = checkCertificate({ host: "nas.local" });
  assert.equal(result.status, "unknown");
  assert.equal(result.expiresInDays, null);
});

test("reverse proxy inspection detects markers and missing forwarded headers", () => {
  const result = inspectReverseProxy({ headers: { "X-Forwarded-For": "10.0.0.9", Server: "nginx" } });
  assert.equal(result.detected, true);
  assert.ok(result.missing.includes("x-forwarded-proto"));
  assert.equal(result.causes[0].code, "proxy-headers-incomplete");
});

test("reverse proxy inspection reports a directly exposed service as suspected", () => {
  const result = inspectReverseProxy({ headers: { "Content-Type": "text/html" } });
  assert.equal(result.detected, false);
  assert.equal(result.causes[0].code, "proxy-not-detected");
  assert.equal(result.causes[0].confidence, "suspected");
});

test("upgrade check reports an available minor update as compatible", () => {
  const result = checkUpgrade({ currentVersion: "1.2.3", availableVersion: "1.3.0" });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.skips, []);
});

test("upgrade check refuses to call a major jump compatible", () => {
  const result = checkUpgrade({ currentVersion: "1.2.3", availableVersion: "2.0.0" });
  assert.equal(result.compatible, false);
  assert.ok(result.skips.includes("major-version-differs"));
  assert.equal(result.causes[0].code, "upgrade-incompatible");
});

test("upgrade check stays unknown without both versions", () => {
  assert.equal(checkUpgrade({ currentVersion: "1.2.3" }).status, "unknown");
});

test("patrol marks every unmeasured check as unknown and never healthy", () => {
  const result = runConnectivityPatrol({ dns: { results: [{ status: "ok" }] } });
  assert.equal(result.status, "partial");
  const dns = result.checks.find(check => check.id === "dns");
  const patrol = result.checks.find(check => check.id === "service");
  assert.equal(dns.status, "ok");
  assert.equal(patrol.status, "unknown");
  assert.ok(result.summary.unknownChecks.includes("service"));
});

test("patrol is unknown when nothing was measured", () => {
  const result = runConnectivityPatrol({});
  assert.equal(result.status, "unknown");
  assert.equal(result.summary.measured, 0);
});

test("every check id is declared", () => {
  const result = runConnectivityPatrol({});
  for (const check of result.checks) {
    assert.ok(NETWORK_DIAGNOSTIC_CHECKS.includes(check.id), `undeclared check ${check.id}`);
  }
});

test("every suggestion is a read-only command", () => {
  const forbidden = /\b(restart|reboot|reload|systemctl\s+(start|stop|restart|enable|disable)|iptables\s+-[AID]|nft\s+add|ufw\s+(allow|deny|enable)|rm\s|mkfs|dd\s+of=)/i;
  for (const [checkId, list] of Object.entries(READ_ONLY_SUGGESTIONS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${checkId} has no suggestion`);
    for (const command of list) {
      assert.equal(forbidden.test(command), false, `${checkId} suggests a mutating command: ${command}`);
    }
  }
});

test("the module never imports a network or process primitive", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../apps/fnos-nas-agent/app/network-diagnostics.mjs", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:http", "node:https", "node:net", "node:dns", "node:fs", "execSync", "fetch("]) {
    assert.equal(source.includes(forbidden), false, `module must not use ${forbidden}`);
  }
  for (const level of CONFIDENCE_LEVELS) {
    assert.ok(source.includes(level), `missing confidence level ${level}`);
  }
});
