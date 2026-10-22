import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCKER_ADVISOR_SECTIONS,
  DOCKER_READ_ONLY_CHECKS,
  analyzeContainerResources,
  analyzeContainerLogs,
  analyzeComposeDependencies,
  findOrphanResources,
  diagnosePortConflicts,
  diffConfiguration,
  buildDockerReport,
} from "../apps/fnos-nas-agent/app/docker-advisor.mjs";

test("resource analysis ranks the containers by memory and marks pressure", () => {
  const result = analyzeContainerResources({
    containers: [
      { id: "a", name: "alpha", image: "img:a", status: "running" },
      { id: "b", name: "beta", image: "img:b", status: "running" },
    ],
    stats: [
      { id: "a", memoryMb: 512, cpuPercent: 3 },
      { id: "b", memoryMb: 3600, cpuPercent: 81 },
    ],
    memoryLimitMb: 4096,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.items[0].container, "beta");
  assert.equal(result.items[0].pressure, "high");
  assert.equal(result.items[1].pressure, "low");
  assert.equal(result.summary.totalMemoryMb, 4112);
  assert.equal(result.summary.top, "beta");
});

test("resource analysis stays unknown when no sample was collected", () => {
  const result = analyzeContainerResources({ containers: [{ id: "a", name: "alpha" }] });
  assert.equal(result.status, "unknown");
  assert.equal(result.items.length, 0);
  assert.equal(result.summary.totalMemoryMb, null);
  assert.match(result.note, /no resource sample/);
});

test("resource share is null when the machine budget is unknown", () => {
  const result = analyzeContainerResources({ stats: [{ id: "a", memoryMb: 100 }] });
  assert.equal(result.items[0].memoryShare, null);
  assert.equal(result.items[0].pressure, "unknown");
});

test("log analysis separates errors from warnings", () => {
  const result = analyzeContainerLogs({
    logs: [
      { container: "alpha", line: "ERROR cannot open socket" },
      { container: "alpha", line: "retry scheduled" },
      { container: "beta", line: "started" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.containers[0].container, "alpha");
  assert.equal(result.containers[0].errors, 1);
});

test("log analysis stays unknown without lines", () => {
  const result = analyzeContainerLogs({});
  assert.equal(result.status, "unknown");
  assert.equal(result.summary.lines, 0);
});

test("log samples are bounded and truncated", () => {
  const logs = Array.from({ length: 2100 }, (_, index) => ({ container: "alpha", line: `error ${index}` }));
  const result = analyzeContainerLogs({ logs });
  assert.equal(result.summary.lines, 2000);
  assert.equal(result.summary.truncated, true);
  assert.ok(result.containers[0].samples.length <= 5);
});

test("compose dependency analysis reports shared volumes", () => {
  const result = analyzeComposeDependencies({
    services: [
      { name: "web", image: "img:web", volumes: ["data", "logs"], networks: ["front"], dependsOn: ["db"] },
      { name: "db", image: "img:db", volumes: ["data"], networks: ["back"], dependsOn: [] },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.services, 2);
  assert.equal(result.summary.sharedVolumes, 1);
  const web = result.services.find(service => service.service === "web");
  assert.equal(web.sharedVolumes, 1);
  assert.deepEqual(web.dependsOn, ["db"]);
});

test("compose dependency analysis stays unknown without services", () => {
  const result = analyzeComposeDependencies({});
  assert.equal(result.status, "unknown");
  assert.equal(result.summary.services, 0);
});

test("orphan detection reports unused images, volumes and networks", () => {
  const result = findOrphanResources({
    containers: [{ name: "alpha", image: "img:a", mounts: [{ name: "data" }], networks: ["front"] }],
    images: [{ id: "img:a" }, { id: "img:old" }],
    volumes: [{ name: "data" }, { name: "stale" }],
    networks: [{ name: "front" }, { name: "orphan-net" }],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.images, 1);
  assert.equal(result.summary.volumes, 1);
  assert.equal(result.summary.networks, 1);
  const kinds = result.items.map(item => item.kind).sort();
  assert.deepEqual(kinds, ["image", "network", "volume"]);
});

test("orphan detection stays unknown when nothing was collected", () => {
  const result = findOrphanResources({});
  assert.equal(result.status, "unknown");
});

test("port conflict detection compares planned ports with the running ones", () => {
  const result = diagnosePortConflicts({
    containers: [{ name: "alpha", ports: ["8080"] }],
    listeners: [{ port: "9090", process: "nginx" }],
    planned: [{ port: "8080", owner: "new stack" }, { port: "9090", owner: "new stack" }],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.conflicts, 2);
  assert.equal(result.conflicts[0].conflictsWith, "alpha");
});

test("port conflict detection stays unknown without any input", () => {
  const result = diagnosePortConflicts({});
  assert.equal(result.status, "unknown");
  assert.equal(result.summary.conflicts, 0);
});

test("configuration diff reports added, removed and changed keys", () => {
  const result = diffConfiguration({
    current: { image: "img:a", replicas: 1, port: "80" },
    desired: { image: "img:b", replicas: 2, env: { TZ: "UTC" } },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.changed, 2);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.removed, 1);
  const kinds = result.changes.map(change => change.kind).sort();
  assert.deepEqual(kinds, ["added", "changed", "changed", "removed"]);
});

test("configuration diff stays unknown when one side is missing", () => {
  assert.equal(diffConfiguration({ current: {} }).status, "unknown");
  assert.equal(diffConfiguration({ desired: {} }).status, "unknown");
});

test("the docker report aggregates every section", () => {
  const report = buildDockerReport({
    containers: [{ id: "a", name: "alpha", image: "img:a", status: "running", mounts: [{ name: "data" }], networks: ["front"], ports: ["8080"] }],
    images: [{ id: "img:a" }],
    volumes: [{ name: "data" }],
    networks: [{ name: "front" }],
    stats: [{ id: "a", memoryMb: 100 }],
    logs: [{ container: "alpha", line: "ok" }],
    services: [{ name: "alpha", image: "img:a" }],
    current: { a: 1 },
    desired: { a: 2 },
  });
  assert.equal(report.status, "ok");
  for (const section of DOCKER_ADVISOR_SECTIONS) {
    assert.ok(report.sections[section], `missing section ${section}`);
  }
  assert.equal(report.summary.portConflicts, 0);
});

test("the docker report is partial when only some sections were measured", () => {
  const report = buildDockerReport({ stats: [{ id: "a", memoryMb: 100 }] });
  assert.equal(report.status, "partial");
  assert.ok(report.summary.unknownSections > 0);
});

test("the read-only check list never offers a mutating action", () => {
  for (const check of DOCKER_READ_ONLY_CHECKS) {
    assert.match(check.id, /^docker\./);
    assert.ok(DOCKER_ADVISOR_SECTIONS.includes(check.section));
  }
});
