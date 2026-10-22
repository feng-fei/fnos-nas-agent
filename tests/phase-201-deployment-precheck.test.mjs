import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MAX_ENV_ENTRIES,
  MAX_PORTS,
  MAX_SERVICES,
  MAX_VOLUMES,
  PRECHECK_CODES,
  PRECHECK_SEVERITIES,
  PRECHECK_VERDICTS,
  findPortConflicts,
  precheckDeploymentPlan,
  validateEnvEntry,
  validatePortMapping,
  validateVolumeSpec
} from "../apps/fnos-nas-agent/app/deployment-precheck.mjs";

const MODULE_SOURCE = await readFile(
  new URL("../apps/fnos-nas-agent/app/deployment-precheck.mjs", import.meta.url),
  "utf8"
);

function service(overrides = {}) {
  return {
    name: "web",
    image: "nginx:1.27-alpine",
    user: "1000:1000",
    restart: "unless-stopped",
    ...overrides
  };
}

function planOf(...services) {
  return { services };
}

function codes(result) {
  return result.findings.map(finding => finding.code);
}

function finding(result, code) {
  return result.findings.find(entry => entry.code === code);
}

test("constants expose the documented frozen values", () => {
  assert.deepEqual(PRECHECK_SEVERITIES, { BLOCK: "block", REVIEW: "review", INFO: "info" });
  assert.deepEqual(PRECHECK_VERDICTS, {
    OK: "ok",
    NEEDS_REVIEW: "needs-review",
    BLOCKED: "blocked",
    UNKNOWN: "unknown"
  });
  assert.ok(Object.isFrozen(PRECHECK_SEVERITIES));
  assert.ok(Object.isFrozen(PRECHECK_VERDICTS));
  assert.deepEqual(
    [MAX_SERVICES, MAX_PORTS, MAX_VOLUMES, MAX_ENV_ENTRIES],
    [50, 100, 100, 200]
  );
  assert.equal(PRECHECK_CODES.INVALID_PLAN, "invalid-plan");
  assert.equal(PRECHECK_CODES.SECRET_IN_ENV, "secret-in-env");
  assert.ok(Object.isFrozen(PRECHECK_CODES));
});

test("validatePortMapping accepts the three documented forms", () => {
  assert.deepEqual(validatePortMapping("8080:80"), { host: 8080, container: 80, protocol: "tcp" });
  assert.deepEqual(validatePortMapping("127.0.0.1:8080:80/udp"), {
    host: 8080,
    container: 80,
    protocol: "udp"
  });
  assert.deepEqual(validatePortMapping("[::1]:8080:80"), { host: 8080, container: 80, protocol: "tcp" });
  assert.deepEqual(validatePortMapping("[::]:443:8443/udp"), {
    host: 443,
    container: 8443,
    protocol: "udp"
  });
  assert.deepEqual(validatePortMapping("0.0.0.0:1:65535"), {
    host: 1,
    container: 65535,
    protocol: "tcp"
  });
  assert.deepEqual(validatePortMapping("00080:0080"), { host: 80, container: 80, protocol: "tcp" });
});

test("validatePortMapping rejects malformed specs and out-of-range ports", () => {
  const invalid = [
    null,
    undefined,
    42,
    {},
    [],
    "",
    "8080",
    "8080:",
    ":80",
    "0:80",
    "65536:80",
    "8080:65536",
    "8080:0",
    "a:80",
    "8080:b",
    " 8080:80",
    "8080 :80",
    "8080:80 ",
    "localhost:8080:80",
    "999.0.0.1:8080:80",
    "127.0.0.1:8080",
    "127.0.0.1:8080:80:90",
    "[::1:8080:80",
    "[::1]8080:80",
    "8080:80/sctp",
    "8080:80/TCP",
    "8080:80/tcp/udp",
    "[nothex]:8080:80"
  ];
  for (const value of invalid) {
    assert.equal(validatePortMapping(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("findPortConflicts dedupes services, ignores the bind address and sorts", () => {
  const conflicts = findPortConflicts([
    {
      services: [
        { name: "web", ports: ["8080:80", "8080:80"] },
        { name: "api", ports: ["127.0.0.1:8080:80"] },
        { name: "cache", ports: ["9000:6379"] }
      ]
    },
    {
      services: {
        jobs: { ports: ["8080:80/udp"] },
        worker: { ports: ["8080:80/udp"] }
      }
    }
  ]);

  assert.deepEqual(conflicts, [
    { host: 8080, protocol: "tcp", services: ["api", "web"], severity: "block" },
    { host: 8080, protocol: "udp", services: ["jobs", "worker"], severity: "block" }
  ]);
});

test("findPortConflicts does not conflict with itself or across protocols", () => {
  assert.deepEqual(findPortConflicts({ services: [{ name: "solo", ports: ["8080:80", "8080:80"] }] }), []);
  assert.deepEqual(
    findPortConflicts({
      services: [
        { name: "a", ports: ["8080:80/tcp"] },
        { name: "b", ports: ["8080:80/udp"] }
      ]
    }),
    []
  );
  assert.deepEqual(
    findPortConflicts({
      services: [
        { name: "a", ports: ["bad"] },
        { name: "b", ports: ["bad"] }
      ]
    }),
    []
  );
});

test("findPortConflicts accepts a single plan and bare service records", () => {
  const singlePlan = findPortConflicts({
    services: [
      { name: "one", ports: ["7000:80"] },
      { name: "two", ports: ["7000:80"] }
    ]
  });
  assert.deepEqual(singlePlan.map(entry => entry.services), [["one", "two"]]);

  const bareServices = findPortConflicts([
    { name: "alpha", ports: ["6000:80"] },
    { name: "beta", ports: ["6000:80"] }
  ]);
  assert.deepEqual(bareServices.map(entry => entry.services), [["alpha", "beta"]]);
  assert.deepEqual(findPortConflicts([]), []);
});

test("validateVolumeSpec distinguishes named volumes and host paths", () => {
  assert.deepEqual(validateVolumeSpec("data:/data"), {
    hostPath: "data",
    containerPath: "/data",
    mode: "rw"
  });
  assert.deepEqual(validateVolumeSpec("/srv/app:/app:ro"), {
    hostPath: "/srv/app",
    containerPath: "/app",
    mode: "ro"
  });
  assert.deepEqual(validateVolumeSpec("./config:/config"), {
    hostPath: "./config",
    containerPath: "/config",
    mode: "rw"
  });
  assert.deepEqual(validateVolumeSpec("my.volume_1:/var/lib"), {
    hostPath: "my.volume_1",
    containerPath: "/var/lib",
    mode: "rw"
  });
});

test("validateVolumeSpec rejects traversal, bad modes and malformed paths", () => {
  const invalid = [
    null,
    42,
    {},
    "",
    "data",
    ":/data",
    "data:data",
    "data:/data:rw",
    "data:/data:z",
    "data:/data:RO",
    "../x:/y:ro",
    "/srv/../etc:/etc",
    "/srv/app:/app/../etc",
    "bad name:/data",
    "data:/da ta",
    "data:/data:ro:extra",
    "~:/data",
    "C:\\data:/data",
    "data:/data:"
  ];
  for (const value of invalid) {
    assert.equal(validateVolumeSpec(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("validateEnvEntry parses KEY=VALUE without trimming", () => {
  assert.deepEqual(validateEnvEntry("A=1"), { key: "A", value: "1" });
  assert.deepEqual(validateEnvEntry("A="), { key: "A", value: "" });
  assert.deepEqual(validateEnvEntry("A=b=c"), { key: "A", value: "b=c" });
  assert.deepEqual(validateEnvEntry("_X1=ok"), { key: "_X1", value: "ok" });
  assert.deepEqual(validateEnvEntry("A_B_2=  spaced  "), { key: "A_B_2", value: "  spaced  " });
});

test("validateEnvEntry rejects malformed keys and missing separators", () => {
  const invalid = [null, 42, "", "A", "=x", "1A=x", "A-B=x", "A B=x", " A=x", "A =x", "A\tB=x"];
  for (const value of invalid) {
    assert.equal(validateEnvEntry(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("an empty but well-formed plan is unknown, not blocked and not ok", () => {
  const emptyArray = precheckDeploymentPlan({ services: [] });
  assert.equal(emptyArray.verdict, PRECHECK_VERDICTS.UNKNOWN);
  assert.deepEqual(emptyArray.findings, []);
  assert.equal(emptyArray.serviceCount, 0);
  assert.deepEqual(emptyArray.notes, ["no-services"]);

  const emptyMap = precheckDeploymentPlan({ services: {} });
  assert.equal(emptyMap.verdict, PRECHECK_VERDICTS.UNKNOWN);
  assert.deepEqual(emptyMap.findings, []);
  assert.deepEqual(emptyMap.notes, ["no-services"]);
});

test("invalid plan structures are blocked with invalid-plan", () => {
  const invalidPlans = [null, undefined, "plan", 42, [], { services: null }, { services: "web" }, { services: 42 }];
  for (const value of invalidPlans) {
    const result = precheckDeploymentPlan(value);
    assert.equal(result.verdict, PRECHECK_VERDICTS.BLOCKED, JSON.stringify(value));
    assert.equal(result.serviceCount, 0);
    assert.deepEqual(codes(result), [PRECHECK_CODES.INVALID_PLAN]);
    assert.equal(result.findings[0].severity, PRECHECK_SEVERITIES.BLOCK);
    assert.equal(result.findings[0].service, null);
  }
});

test("non-object service entries are blocked but still counted", () => {
  const arrayPlan = precheckDeploymentPlan({ services: [null] });
  assert.equal(arrayPlan.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.equal(arrayPlan.serviceCount, 1);
  assert.deepEqual(codes(arrayPlan), [PRECHECK_CODES.INVALID_PLAN]);

  const mapPlan = precheckDeploymentPlan({ services: { web: null } });
  assert.equal(mapPlan.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.equal(mapPlan.serviceCount, 1);
  assert.deepEqual(codes(mapPlan), [PRECHECK_CODES.INVALID_PLAN]);
});

test("a missing, empty or non-string image is blocked", () => {
  for (const image of [undefined, "", "   ", null, 42]) {
    const record = { name: "web", user: "1000:1000", restart: "always" };
    if (image !== undefined) record.image = image;
    const result = precheckDeploymentPlan({ services: [record] });
    assert.equal(result.verdict, PRECHECK_VERDICTS.BLOCKED, JSON.stringify(image));
    assert.ok(codes(result).includes(PRECHECK_CODES.MISSING_IMAGE), JSON.stringify(image));
  }
});

test("privileged mode is blocked at service and plan level", () => {
  const serviceLevel = precheckDeploymentPlan({ services: [service({ privileged: true })] });
  assert.equal(serviceLevel.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(codes(serviceLevel).includes(PRECHECK_CODES.PRIVILEGED_MODE));
  assert.equal(finding(serviceLevel, PRECHECK_CODES.PRIVILEGED_MODE).severity, PRECHECK_SEVERITIES.BLOCK);

  const planLevel = precheckDeploymentPlan({ privileged: true, services: [service()] });
  assert.equal(planLevel.verdict, PRECHECK_VERDICTS.BLOCKED);
  const planFinding = finding(planLevel, PRECHECK_CODES.PRIVILEGED_MODE);
  assert.ok(planFinding);
  assert.equal(planFinding.service, null);
});

test("generate mode from the plan or options is blocked", () => {
  const generatedPlan = precheckDeploymentPlan({ services: [service()], generate: true });
  assert.equal(generatedPlan.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(codes(generatedPlan).includes(PRECHECK_CODES.GENERATE_MODE));

  const generatedOption = precheckDeploymentPlan(planOf(service()), { generate: true });
  assert.equal(generatedOption.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(codes(generatedOption).includes(PRECHECK_CODES.GENERATE_MODE));

  const explicitFalse = precheckDeploymentPlan(planOf(service()), { generate: false });
  assert.equal(explicitFalse.verdict, PRECHECK_VERDICTS.OK);
  assert.ok(!codes(explicitFalse).includes(PRECHECK_CODES.GENERATE_MODE));

  const nonObjectOptions = precheckDeploymentPlan(planOf(service()), null);
  assert.equal(nonObjectOptions.verdict, PRECHECK_VERDICTS.OK);

  const emptyButGenerated = precheckDeploymentPlan({ services: [], generate: true });
  assert.equal(emptyButGenerated.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(codes(emptyButGenerated).includes(PRECHECK_CODES.GENERATE_MODE));
  assert.deepEqual(emptyButGenerated.notes, ["no-services"]);
});

test("two services publishing the same host port are blocked", () => {
  const result = precheckDeploymentPlan({
    services: [
      { name: "web", image: "nginx", user: "1000", restart: "always", ports: ["8080:80"] },
      { name: "api", image: "node", user: "1000", restart: "always", ports: ["127.0.0.1:8080:80"] }
    ]
  });
  assert.equal(result.verdict, PRECHECK_VERDICTS.BLOCKED);
  const conflict = finding(result, PRECHECK_CODES.PORT_CONFLICT);
  assert.ok(conflict);
  assert.equal(conflict.severity, PRECHECK_SEVERITIES.BLOCK);
  assert.equal(conflict.service, null);
  assert.match(conflict.detail, /api, web/);
});

test("host ports below 1024 are reviewed, container ports are not", () => {
  const port80 = precheckDeploymentPlan({ services: [service({ ports: ["80:80"] })] });
  assert.equal(port80.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.equal(finding(port80, PRECHECK_CODES.PRIVILEGED_PORT).severity, PRECHECK_SEVERITIES.REVIEW);

  const port1023 = precheckDeploymentPlan({ services: [service({ ports: ["1023:80"] })] });
  assert.ok(finding(port1023, PRECHECK_CODES.PRIVILEGED_PORT));

  const port1024 = precheckDeploymentPlan({ services: [service({ ports: ["1024:80"] })] });
  assert.equal(port1024.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(port1024, PRECHECK_CODES.PRIVILEGED_PORT), undefined);

  const containerPort80 = precheckDeploymentPlan({ services: [service({ ports: ["8080:80"] })] });
  assert.equal(containerPort80.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(containerPort80, PRECHECK_CODES.PRIVILEGED_PORT), undefined);
});

test("malformed port declarations are reviewed, not blocked", () => {
  const badEntry = precheckDeploymentPlan({ services: [service({ ports: ["not-a-port"] })] });
  assert.equal(badEntry.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.equal(finding(badEntry, PRECHECK_CODES.INVALID_PORT).severity, PRECHECK_SEVERITIES.REVIEW);

  const nonArray = precheckDeploymentPlan({ services: [service({ ports: "8080:80" })] });
  assert.equal(nonArray.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.ok(finding(nonArray, PRECHECK_CODES.INVALID_PORT));
});

test("writable host-path volumes are reviewed, named and read-only volumes are not", () => {
  const writable = precheckDeploymentPlan({ services: [service({ volumes: ["/srv/app:/app"] })] });
  assert.equal(writable.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.equal(finding(writable, PRECHECK_CODES.WRITABLE_HOST_VOLUME).severity, PRECHECK_SEVERITIES.REVIEW);

  const named = precheckDeploymentPlan({ services: [service({ volumes: ["data:/data"] })] });
  assert.equal(named.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(named, PRECHECK_CODES.WRITABLE_HOST_VOLUME), undefined);

  const readOnly = precheckDeploymentPlan({ services: [service({ volumes: ["/srv/app:/app:ro"] })] });
  assert.equal(readOnly.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(readOnly, PRECHECK_CODES.WRITABLE_HOST_VOLUME), undefined);

  const malformed = precheckDeploymentPlan({ services: [service({ volumes: ["bad volume"] })] });
  assert.equal(malformed.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.ok(finding(malformed, PRECHECK_CODES.INVALID_VOLUME));

  const nonArray = precheckDeploymentPlan({ services: [service({ volumes: "/srv:/app" })] });
  assert.equal(nonArray.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.ok(finding(nonArray, PRECHECK_CODES.INVALID_VOLUME));
});

test("an absent or root user is reviewed; an explicit non-root user is info", () => {
  const missing = precheckDeploymentPlan({
    services: [{ name: "web", image: "nginx", restart: "always" }]
  });
  assert.equal(missing.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.equal(finding(missing, PRECHECK_CODES.ROOT_USER).severity, PRECHECK_SEVERITIES.REVIEW);

  for (const user of ["", "root", "root:root", "0:0", "00", 0]) {
    const result = precheckDeploymentPlan({ services: [service({ user })] });
    assert.equal(result.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW, JSON.stringify(user));
    assert.ok(finding(result, PRECHECK_CODES.ROOT_USER), JSON.stringify(user));
  }

  for (const user of ["1000:1000", "1000", "nonroot", 1000]) {
    const result = precheckDeploymentPlan({ services: [service({ user })] });
    assert.equal(result.verdict, PRECHECK_VERDICTS.OK, JSON.stringify(user));
    const info = finding(result, PRECHECK_CODES.NON_ROOT_USER);
    assert.ok(info, JSON.stringify(user));
    assert.equal(info.severity, PRECHECK_SEVERITIES.INFO);
    assert.equal(finding(result, PRECHECK_CODES.ROOT_USER), undefined);
  }
});

test("secret-looking env keys are reviewed without leaking the value", () => {
  const result = precheckDeploymentPlan({
    services: [service({ env: ["DB_PASSWORD=hunter2"] })]
  });
  assert.equal(result.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  const secret = finding(result, PRECHECK_CODES.SECRET_IN_ENV);
  assert.ok(secret);
  assert.equal(secret.severity, PRECHECK_SEVERITIES.REVIEW);
  assert.match(secret.detail, /DB_PASSWORD/);
  assert.ok(!secret.detail.includes("hunter2"));
  assert.ok(!JSON.stringify(result).includes("hunter2"));

  const objectForm = precheckDeploymentPlan({
    services: [service({ env: { API_TOKEN: "tok_live_123" } })]
  });
  assert.ok(finding(objectForm, PRECHECK_CODES.SECRET_IN_ENV));
  assert.ok(!JSON.stringify(objectForm).includes("tok_live_123"));

  for (const env of [["API_TOKEN="], ["API_TOKEN=   "], { API_TOKEN: "" }, ["TZ=Asia/Shanghai"], { TZ: "UTC" }]) {
    const quiet = precheckDeploymentPlan({ services: [service({ env })] });
    assert.equal(
      quiet.findings.some(entry => entry.code === PRECHECK_CODES.SECRET_IN_ENV),
      false,
      JSON.stringify(env)
    );
  }
});

test("invalid env entries are reviewed and never echo the raw entry", () => {
  const result = precheckDeploymentPlan({
    services: [service({ env: ["PASSWORD hunter2"] })]
  });
  assert.equal(result.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  const invalid = finding(result, PRECHECK_CODES.INVALID_ENV);
  assert.ok(invalid);
  assert.match(invalid.detail, /env\[1\]/);
  assert.ok(!JSON.stringify(result).includes("hunter2"));

  const numericValue = precheckDeploymentPlan({
    services: [service({ env: { DB_PASSWORD: 123456 } })]
  });
  assert.ok(finding(numericValue, PRECHECK_CODES.INVALID_ENV));
  assert.ok(!JSON.stringify(numericValue).includes("123456"));

  const notContainer = precheckDeploymentPlan({ services: [service({ env: "A=1" })] });
  assert.ok(finding(notContainer, PRECHECK_CODES.INVALID_ENV));
});

test("a missing restart policy is info and does not change an otherwise ok plan", () => {
  const missing = precheckDeploymentPlan({
    services: [{ name: "web", image: "nginx", user: "1000" }]
  });
  assert.equal(missing.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(missing, PRECHECK_CODES.NO_RESTART_POLICY).severity, PRECHECK_SEVERITIES.INFO);

  const empty = precheckDeploymentPlan({
    services: [{ name: "web", image: "nginx", user: "1000", restart: "" }]
  });
  assert.equal(empty.verdict, PRECHECK_VERDICTS.OK);
  assert.ok(finding(empty, PRECHECK_CODES.NO_RESTART_POLICY));

  const declared = precheckDeploymentPlan({ services: [service({ restart: "always" })] });
  assert.equal(finding(declared, PRECHECK_CODES.NO_RESTART_POLICY), undefined);
});

test("a fully compliant plan is ok and only emits the non-root info", () => {
  const result = precheckDeploymentPlan({
    services: [service({ name: "web" }), service({ name: "api" })]
  });
  assert.equal(result.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(result.serviceCount, 2);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(
    result.findings.map(entry => ({ code: entry.code, severity: entry.severity, service: entry.service })),
    [
      { code: PRECHECK_CODES.NON_ROOT_USER, severity: PRECHECK_SEVERITIES.INFO, service: "api" },
      { code: PRECHECK_CODES.NON_ROOT_USER, severity: PRECHECK_SEVERITIES.INFO, service: "web" }
    ]
  );
});

test("public exposure is reviewed only for wildcard ports with writable host or privileged", () => {
  const wildcardWritable = precheckDeploymentPlan({
    services: [service({ ports: ["8080:80"], volumes: ["/srv/app:/app"] })]
  });
  assert.equal(wildcardWritable.verdict, PRECHECK_VERDICTS.NEEDS_REVIEW);
  assert.ok(finding(wildcardWritable, PRECHECK_CODES.PUBLIC_EXPOSURE));
  assert.ok(finding(wildcardWritable, PRECHECK_CODES.WRITABLE_HOST_VOLUME));

  const loopbackWritable = precheckDeploymentPlan({
    services: [service({ ports: ["127.0.0.1:8080:80"], volumes: ["/srv/app:/app"] })]
  });
  assert.equal(finding(loopbackWritable, PRECHECK_CODES.PUBLIC_EXPOSURE), undefined);

  const wildcardNamed = precheckDeploymentPlan({
    services: [service({ ports: ["8080:80"], volumes: ["data:/data"] })]
  });
  assert.equal(wildcardNamed.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(wildcardNamed, PRECHECK_CODES.PUBLIC_EXPOSURE), undefined);

  const wildcardReadOnly = precheckDeploymentPlan({
    services: [service({ ports: ["8080:80"], volumes: ["/srv/app:/app:ro"] })]
  });
  assert.equal(wildcardReadOnly.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(finding(wildcardReadOnly, PRECHECK_CODES.PUBLIC_EXPOSURE), undefined);

  const ipv6Wildcard = precheckDeploymentPlan({
    services: [service({ ports: ["[::]:8080:80"], volumes: ["/srv/app:/app"] })]
  });
  assert.ok(finding(ipv6Wildcard, PRECHECK_CODES.PUBLIC_EXPOSURE));

  const privileged = precheckDeploymentPlan({
    services: [service({ privileged: true, ports: ["8080:80"] })]
  });
  assert.equal(privileged.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(finding(privileged, PRECHECK_CODES.PUBLIC_EXPOSURE));
});

test("object-map plans count services and use the map key as the label", () => {
  const result = precheckDeploymentPlan({
    services: { web: { image: "nginx", user: "1000", restart: "always" } }
  });
  assert.equal(result.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(result.serviceCount, 1);
  assert.equal(result.findings[0].service, "web");

  const named = precheckDeploymentPlan({
    services: { key: { name: "custom", image: "nginx", user: "1000", restart: "always" } }
  });
  assert.equal(named.findings[0].service, "custom");
});

test("MAX_SERVICES is allowed and one more service is blocked", () => {
  const atLimit = Array.from({ length: MAX_SERVICES }, (_, index) => ({
    name: `svc-${index}`,
    image: "nginx",
    user: "1000",
    restart: "always"
  }));
  const allowed = precheckDeploymentPlan({ services: atLimit });
  assert.equal(allowed.verdict, PRECHECK_VERDICTS.OK);
  assert.equal(allowed.serviceCount, MAX_SERVICES);
  assert.equal(allowed.findings.length, MAX_SERVICES);
  assert.ok(!codes(allowed).includes(PRECHECK_CODES.TOO_MANY_SERVICES));

  const over = precheckDeploymentPlan({
    services: [...atLimit, { name: "extra", image: "nginx", user: "1000", restart: "always" }]
  });
  assert.equal(over.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.equal(over.serviceCount, MAX_SERVICES + 1);
  assert.ok(finding(over, PRECHECK_CODES.TOO_MANY_SERVICES));
});

test("MAX_PORTS is allowed and one more port is blocked", () => {
  const portsAtLimit = Array.from({ length: MAX_PORTS }, (_, index) => `${20000 + index}:80`);
  const allowed = precheckDeploymentPlan({ services: [service({ ports: portsAtLimit })] });
  assert.equal(allowed.verdict, PRECHECK_VERDICTS.OK);
  assert.ok(!codes(allowed).includes(PRECHECK_CODES.TOO_MANY_PORTS));

  const over = precheckDeploymentPlan({
    services: [service({ ports: [...portsAtLimit, "30000:80"] })]
  });
  assert.equal(over.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(finding(over, PRECHECK_CODES.TOO_MANY_PORTS));
});

test("MAX_VOLUMES is allowed and one more volume is blocked", () => {
  const volumesAtLimit = Array.from({ length: MAX_VOLUMES }, (_, index) => `vol-${index}:/data-${index}`);
  const allowed = precheckDeploymentPlan({ services: [service({ volumes: volumesAtLimit })] });
  assert.equal(allowed.verdict, PRECHECK_VERDICTS.OK);
  assert.ok(!codes(allowed).includes(PRECHECK_CODES.TOO_MANY_VOLUMES));

  const over = precheckDeploymentPlan({
    services: [service({ volumes: [...volumesAtLimit, "extra-vol:/extra"] })]
  });
  assert.equal(over.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(finding(over, PRECHECK_CODES.TOO_MANY_VOLUMES));
});

test("MAX_ENV_ENTRIES is allowed and one more entry is blocked", () => {
  const envAtLimit = Array.from({ length: MAX_ENV_ENTRIES }, (_, index) => `VAR_${index}=value-${index}`);
  const allowed = precheckDeploymentPlan({ services: [service({ env: envAtLimit })] });
  assert.equal(allowed.verdict, PRECHECK_VERDICTS.OK);
  assert.ok(!codes(allowed).includes(PRECHECK_CODES.TOO_MANY_ENV_ENTRIES));

  const over = precheckDeploymentPlan({
    services: [service({ env: [...envAtLimit, "VAR_EXTRA=value"] })]
  });
  assert.equal(over.verdict, PRECHECK_VERDICTS.BLOCKED);
  assert.ok(finding(over, PRECHECK_CODES.TOO_MANY_ENV_ENTRIES));
});

test("findings are deduped and sorted stably by severity, service, code, detail", () => {
  const plan = {
    services: [
      { name: "zeta", image: "nginx", user: "1000", restart: "always", ports: ["80:80"] },
      { name: "alpha", user: "1000", restart: "always" },
      { name: "beta", image: "alpine", user: "1000", ports: ["1024:80"] }
    ]
  };
  const first = precheckDeploymentPlan(plan);
  assert.deepEqual(codes(first), [
    PRECHECK_CODES.MISSING_IMAGE,
    PRECHECK_CODES.PRIVILEGED_PORT,
    PRECHECK_CODES.NON_ROOT_USER,
    PRECHECK_CODES.NO_RESTART_POLICY,
    PRECHECK_CODES.NON_ROOT_USER,
    PRECHECK_CODES.NON_ROOT_USER
  ]);
  assert.deepEqual(
    first.findings.map(entry => entry.service),
    ["alpha", "zeta", "alpha", "beta", "beta", "zeta"]
  );

  const second = precheckDeploymentPlan(plan);
  assert.deepEqual(second, first);

  const keys = first.findings.map(
    entry => `${entry.severity}|${entry.code}|${entry.service}|${entry.detail}`
  );
  assert.equal(new Set(keys).size, keys.length);
});

test("duplicate equivalent findings are collapsed", () => {
  const result = precheckDeploymentPlan({
    services: [service({ env: ["DB_PASSWORD=hunter2", "DB_PASSWORD=hunter2"] })]
  });
  const secrets = result.findings.filter(entry => entry.code === PRECHECK_CODES.SECRET_IN_ENV);
  assert.equal(secrets.length, 1);
  const keys = result.findings.map(
    entry => `${entry.severity}|${entry.code}|${entry.service}|${entry.detail}`
  );
  assert.equal(new Set(keys).size, keys.length);
});

test("prechecking does not mutate the plan", () => {
  const plan = {
    services: [
      service({ ports: ["8080:80"], volumes: ["/srv/app:/app"], env: ["DB_PASSWORD=hunter2"] }),
      service({ name: "api", user: "root", ports: ["8080:80"] })
    ]
  };
  const snapshot = structuredClone(plan);
  const before = JSON.stringify(plan);

  precheckDeploymentPlan(plan, { generate: false });
  findPortConflicts([plan]);

  assert.deepEqual(plan, snapshot);
  assert.equal(JSON.stringify(plan), before);
});

test("module source stays free of imports, I/O and process access", () => {
  assert.doesNotMatch(MODULE_SOURCE, /^\s*import\s/m);
  assert.doesNotMatch(MODULE_SOURCE, /require\s*\(/);
  for (const needle of [
    "node:fs",
    "node:child_process",
    "node:http",
    "node:net",
    "node:dns",
    "node:os",
    "node:path",
    "child_process",
    "fetch(",
    "spawn",
    "exec(",
    "process.",
    "new Function"
  ]) {
    assert.equal(MODULE_SOURCE.includes(needle), false, `source must not contain ${needle}`);
  }
});
