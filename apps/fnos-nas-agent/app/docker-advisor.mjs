/**
 * Read-only Docker and Compose analysis.
 *
 * Every function in this module is a pure function over data that was
 * collected elsewhere. The module never talks to a daemon, never runs a
 * command and never changes a container. It answers the questions the
 * operator asks before a change:
 *
 *   - which container eats the memory (APP02),
 *   - which logs carry a real error (APP03),
 *   - what a compose file depends on (APP04),
 *   - which resources are left behind (APP13),
 *   - which port would collide (APP14),
 *   - what a configuration change would really change (APP08).
 *
 * A measurement that was not taken stays `unknown`. The module never
 * substitutes a healthy looking number for a missing one.
 */

export const DOCKER_ADVISOR_SECTIONS = [
  "resources",
  "logs",
  "dependencies",
  "orphans",
  "ports",
  "diff",
];

export const MAX_LOG_LINES = 2000;
export const MAX_DIFF_LINES = 500;
export const DEFAULT_MEMORY_LIMIT_MB = 4096;
export const ORPHAN_REASON = {
  image: "image-not-used-by-any-container",
  volume: "volume-not-mounted-by-any-container",
  network: "network-not-attached-to-any-container",
};

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Rank the containers by the resource they consume.
 *
 * @param {object} input
 * @param {Array<object>} [input.containers] container records
 * @param {Array<object>} [input.stats] per container resource samples
 * @param {number} [input.memoryLimitMb] the memory budget of the machine
 * @returns {{status: "ok"|"unknown", items: Array<object>, summary: object, note?: string}}
 */
export function analyzeContainerResources(input = {}) {
  const containers = asList(input.containers);
  const stats = asList(input.stats);
  if (!stats.length) {
    return {
      status: "unknown",
      items: [],
      summary: { measured: 0, containers: containers.length, memoryLimitMb: null, totalMemoryMb: null, top: null },
      note: "no resource sample was collected",
    };
  }
  const limit = Number.isFinite(input.memoryLimitMb) ? input.memoryLimitMb : null;
  const byId = new Map(containers.map(item => [asText(item.id) || asText(item.name), item]));
  const items = stats.map(sample => {
    const key = asText(sample.id) || asText(sample.containerId) || asText(sample.name);
    const container = byId.get(key) || {};
    const memoryMb = Number.isFinite(sample.memoryMb) ? round(sample.memoryMb) : null;
    const cpuPercent = Number.isFinite(sample.cpuPercent) ? round(sample.cpuPercent) : null;
    return {
      container: asText(container.name) || key,
      image: asText(container.image),
      status: asText(container.status) || "unknown",
      memoryMb,
      cpuPercent,
      memoryShare: limit && memoryMb !== null ? round((memoryMb / limit) * 100) : null,
      pressure: memoryMb === null || limit === null ? "unknown" : memoryMb / limit >= 0.8 ? "high" : memoryMb / limit >= 0.5 ? "medium" : "low",
    };
  });
  const measured = items.filter(item => item.memoryMb !== null);
  const total = measured.length ? measured.reduce((sum, item) => sum + item.memoryMb, 0) : 0;
  items.sort((a, b) => (b.memoryMb ?? -1) - (a.memoryMb ?? -1) || String(a.container).localeCompare(String(b.container)));
  return {
    status: "ok",
    items,
    summary: {
      measured: measured.length,
      containers: containers.length,
      memoryLimitMb: limit,
      totalMemoryMb: measured.length ? round(total) : null,
      top: measured.length ? items[0].container : null,
    },
  };
}

/**
 * Classify container log lines.
 *
 * The classification is intentionally coarse: the module never guesses a root
 * cause, it only separates an error from a warning from an ordinary line.
 *
 * @param {object} input
 * @param {Array<string|object>} [input.logs] log lines or `{line, container}` records
 * @returns {{status: "ok"|"unknown", containers: Array<object>, summary: object}}
 */
export function analyzeContainerLogs(input = {}) {
  const raw = asList(input.logs);
  if (!raw.length) {
    return { status: "unknown", containers: [], summary: { lines: 0, errors: 0, warnings: 0 } };
  }
  const limit = Math.min(raw.length, MAX_LOG_LINES);
  const buckets = new Map();
  let errors = 0;
  let warnings = 0;
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const line = asText(typeof entry === "string" ? entry : entry?.line);
    const container = asText(typeof entry === "string" ? "" : entry?.container) || "unknown";
    if (!line) continue;
    const lower = line.toLowerCase();
    let severity = "info";
    if (/\b(error|fatal|panic|exception|traceback|failed|cannot|denied|refused)\b/.test(lower)) {
      severity = "error";
      errors += 1;
    } else if (/\b(warn|warning|deprecated|retry|timeout)\b/.test(lower)) {
      severity = "warning";
      warnings += 1;
    }
    if (!buckets.has(container)) buckets.set(container, { container, errors: 0, warnings: 0, samples: [] });
    const bucket = buckets.get(container);
    if (severity === "error") bucket.errors += 1;
    if (severity === "warning") bucket.warnings += 1;
    if (bucket.samples.length < 5 && severity !== "info") {
      bucket.samples.push({ severity, line: line.slice(0, 240) });
    }
  }
  const containers = [...buckets.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || a.container.localeCompare(b.container));
  return {
    status: "ok",
    containers,
    summary: {
      lines: limit,
      errors,
      warnings,
      truncated: raw.length > limit,
      worst: containers[0]?.container || null,
    },
  };
}

/**
 * Describe what a compose file depends on.
 *
 * The module reads the declared configuration only. It never resolves an
 * image and never contacts a registry.
 *
 * @param {object} input
 * @param {Array<object>} [input.services] compose service records
 * @returns {{status: "ok"|"unknown", services: Array<object>, summary: object}}
 */
export function analyzeComposeDependencies(input = {}) {
  const services = asList(input.services);
  if (!services.length) {
    return { status: "unknown", services: [], summary: { services: 0, volumes: 0, networks: 0 } };
  }
  const volumes = new Set();
  const networks = new Set();
  const ports = [];
  const items = services.map(service => {
    const name = asText(service.name) || "unknown";
    const serviceVolumes = asList(service.volumes).map(asText).filter(Boolean);
    const serviceNetworks = asList(service.networks).map(asText).filter(Boolean);
    const servicePorts = asList(service.ports).map(asText).filter(Boolean);
    serviceVolumes.forEach(volume => volumes.add(volume));
    serviceNetworks.forEach(network => networks.add(network));
    servicePorts.forEach(port => ports.push({ service: name, port }));
    return {
      service: name,
      image: asText(service.image),
      dependsOn: asList(service.dependsOn).map(asText).filter(Boolean),
      volumes: serviceVolumes,
      networks: serviceNetworks,
      ports: servicePorts,
      sharedVolumes: serviceVolumes.filter(volume => asList(service.volumes).filter(asText).filter(Boolean).length > 0 && volumes.size >= 1 && serviceVolumes.length > 0).length,
    };
  });
  const shared = new Set();
  const counts = new Map();
  for (const service of services) {
    for (const volume of asList(service.volumes).map(asText).filter(Boolean)) {
      counts.set(volume, (counts.get(volume) || 0) + 1);
    }
  }
  for (const [volume, count] of counts) {
    if (count > 1) shared.add(volume);
  }
  for (const item of items) {
    item.sharedVolumes = item.volumes.filter(volume => shared.has(volume)).length;
  }
  items.sort((a, b) => a.service.localeCompare(b.service));
  return {
    status: "ok",
    services: items,
    summary: {
      services: items.length,
      volumes: volumes.size,
      networks: networks.size,
      sharedVolumes: shared.size,
      ports: ports.length,
    },
  };
}

/**
 * Find the resources that no container uses any more.
 *
 * The module never removes anything. It only reports what would be unused.
 *
 * @param {object} input
 * @param {Array<object>} [input.containers] running and stopped containers
 * @param {Array<object>} [input.images] local images
 * @param {Array<object>} [input.volumes] local volumes
 * @param {Array<object>} [input.networks] local networks
 * @returns {{status: "ok"|"unknown", items: Array<object>, summary: object}}
 */
export function findOrphanResources(input = {}) {
  const containers = asList(input.containers);
  const images = asList(input.images);
  const volumes = asList(input.volumes);
  const networks = asList(input.networks);
  if (!containers.length && !images.length && !volumes.length && !networks.length) {
    return { status: "unknown", items: [], summary: { images: 0, volumes: 0, networks: 0 } };
  }
  const usedImages = new Set(containers.map(item => asText(item.image)).filter(Boolean));
  const usedVolumes = new Set();
  const usedNetworks = new Set();
  for (const container of containers) {
    for (const mount of asList(container.mounts)) {
      const name = asText(typeof mount === "string" ? mount : mount?.name || mount?.source);
      if (name) usedVolumes.add(name);
    }
    for (const network of asList(container.networks).map(asText).filter(Boolean)) {
      usedNetworks.add(network);
    }
  }
  const items = [];
  for (const image of images) {
    const id = asText(typeof image === "string" ? image : image?.id || image?.reference);
    if (!id || usedImages.has(id)) continue;
    items.push({ kind: "image", id, reason: ORPHAN_REASON.image });
  }
  for (const volume of volumes) {
    const name = asText(typeof volume === "string" ? volume : volume?.name);
    if (!name || usedVolumes.has(name)) continue;
    items.push({ kind: "volume", id: name, reason: ORPHAN_REASON.volume });
  }
  for (const network of networks) {
    const name = asText(typeof network === "string" ? network : network?.name);
    if (!name || usedNetworks.has(name)) continue;
    items.push({ kind: "network", id: name, reason: ORPHAN_REASON.network });
  }
  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return {
    status: "ok",
    items,
    summary: {
      images: items.filter(item => item.kind === "image").length,
      volumes: items.filter(item => item.kind === "volume").length,
      networks: items.filter(item => item.kind === "network").length,
    },
  };
}

/**
 * Find the ports that would collide.
 *
 * @param {object} input
 * @param {Array<object>} [input.containers] containers with their published ports
 * @param {Array<object>} [input.listeners] host listeners (`port`, `process`)
 * @param {Array<object>} [input.planned] ports a plan wants to publish
 * @returns {{status: "ok"|"unknown", conflicts: Array<object>, summary: object}}
 */
export function diagnosePortConflicts(input = {}) {
  const containers = asList(input.containers);
  const listeners = asList(input.listeners);
  const planned = asList(input.planned);
  if (!containers.length && !listeners.length && !planned.length) {
    return { status: "unknown", conflicts: [], summary: { conflicts: 0 } };
  }
  const claims = [];
  for (const container of containers) {
    for (const port of asList(container.ports)) {
      const value = asText(typeof port === "string" ? port : port?.published || port?.hostPort);
      if (!value) continue;
      claims.push({ port: value, owner: asText(container.name) || "unknown", kind: "container" });
    }
  }
  for (const listener of listeners) {
    const value = asText(typeof listener === "string" ? listener : listener?.port);
    if (!value) continue;
    claims.push({ port: value, owner: asText(listener.process) || "host process", kind: "host" });
  }
  const conflicts = [];
  for (const entry of planned) {
    const value = asText(typeof entry === "string" ? entry : entry?.port);
    if (!value) continue;
    const owner = asText(typeof entry === "string" ? "" : entry?.owner) || "planned change";
    for (const claim of claims) {
      if (claim.port !== value) continue;
      conflicts.push({ port: value, owner, conflictsWith: claim.owner, kind: claim.kind });
    }
  }
  const seen = new Set();
  const unique = conflicts.filter(conflict => {
    const key = `${conflict.port}|${conflict.owner}|${conflict.conflictsWith}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    status: "ok",
    conflicts: unique,
    summary: { conflicts: unique.length, ports: claims.length },
  };
}

/**
 * Compare the current configuration with the desired one.
 *
 * @param {object} input
 * @param {object} [input.current] the configuration that is running
 * @param {object} [input.desired] the configuration that is planned
 * @returns {{status: "ok"|"unknown", changes: Array<object>, summary: object}}
 */
export function diffConfiguration(input = {}) {
  const current = input.current && typeof input.current === "object" ? input.current : null;
  const desired = input.desired && typeof input.desired === "object" ? input.desired : null;
  if (!current || !desired) {
    return { status: "unknown", changes: [], summary: { added: 0, removed: 0, changed: 0 } };
  }
  const keys = new Set([...Object.keys(current), ...Object.keys(desired)]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const before = current[key];
    const after = desired[key];
    if (before === undefined) {
      changes.push({ key, kind: "added", before: null, after });
      continue;
    }
    if (after === undefined) {
      changes.push({ key, kind: "removed", before, after: null });
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ key, kind: "changed", before, after });
    }
  }
  const limited = changes.slice(0, MAX_DIFF_LINES);
  return {
    status: "ok",
    changes: limited,
    summary: {
      added: changes.filter(change => change.kind === "added").length,
      removed: changes.filter(change => change.kind === "removed").length,
      changed: changes.filter(change => change.kind === "changed").length,
      truncated: changes.length > limited.length,
    },
  };
}

/**
 * Aggregate the read-only Docker checks into one report.
 *
 * @param {object} input the same inputs as the single checks
 * @returns {{status: "ok"|"unknown"|"partial", sections: object, summary: object}}
 */
export function buildDockerReport(input = {}) {
  const resources = analyzeContainerResources(input);
  const logs = analyzeContainerLogs(input);
  const dependencies = analyzeComposeDependencies(input);
  const orphans = findOrphanResources(input);
  const ports = diagnosePortConflicts(input);
  const diff = diffConfiguration(input);
  const sections = { resources, logs, dependencies, orphans, ports, diff };
  const states = Object.values(sections).map(section => section.status);
  const status = states.every(state => state === "unknown") ? "unknown" : states.some(state => state === "unknown") ? "partial" : "ok";
  return {
    status,
    sections,
    summary: {
      measuredSections: states.filter(state => state === "ok").length,
      unknownSections: states.filter(state => state === "unknown").length,
      orphanResources: orphans.summary,
      portConflicts: ports.summary.conflicts,
      logErrors: logs.summary.errors,
    },
  };
}

/**
 * The read-only Docker checks the agent may suggest.
 *
 * The list is deliberately a list of checks, not of actions: nothing in this
 * module changes a container, a volume or a network.
 */
export const DOCKER_READ_ONLY_CHECKS = [
  { id: "docker.resources", title: "容器资源占用", section: "resources" },
  { id: "docker.logs", title: "容器日志错误", section: "logs" },
  { id: "docker.dependencies", title: "编排依赖关系", section: "dependencies" },
  { id: "docker.orphans", title: "闲置资源", section: "orphans" },
  { id: "docker.ports", title: "端口占用", section: "ports" },
  { id: "docker.config-diff", title: "配置差异", section: "diff" },
];

export { clamp };
