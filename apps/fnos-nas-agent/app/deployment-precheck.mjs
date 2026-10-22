/**
 * Phase 201 — deployment pre-check (pure functions).
 *
 * This layer answers one question only: given a deployment plan that the
 * caller already holds, is it safe to hand that plan to a deployment tool?
 * It never reads a file, never talks to Docker, never resolves an image and
 * never changes the system. Every check is a pure function over the plan
 * object; the caller decides where the plan came from and what to do next.
 *
 * Red lines:
 *   - zero dependencies, zero `import`, zero I/O;
 *   - an unknown is reported as unknown (or as a review), never as "ok";
 *   - a secret value found in `env` is never echoed in a finding;
 *   - every finding carries a stable code, a severity and the service it
 *     belongs to (or `null` when the finding is plan-wide);
 *   - bounds (MAX_*) turn over-large plans into a block instead of letting
 *     them silently pass.
 */

/** Finding severities. `block` prevents deployment, `review` asks a human. */
export const PRECHECK_SEVERITIES = Object.freeze({
  BLOCK: "block",
  REVIEW: "review",
  INFO: "info"
});

/** Overall verdicts. */
export const PRECHECK_VERDICTS = Object.freeze({
  OK: "ok",
  NEEDS_REVIEW: "needs-review",
  BLOCKED: "blocked",
  UNKNOWN: "unknown"
});

/** Upper bounds for one plan; exceeding one is itself a block finding. */
export const MAX_SERVICES = 50;
export const MAX_PORTS = 100;
export const MAX_VOLUMES = 100;
export const MAX_ENV_ENTRIES = 200;

/**
 * Stable finding codes. Callers may branch on these strings; tests pin them.
 */
export const PRECHECK_CODES = Object.freeze({
  INVALID_PLAN: "invalid-plan",
  MISSING_IMAGE: "missing-image",
  PORT_CONFLICT: "port-conflict",
  INVALID_PORT: "invalid-port",
  PRIVILEGED_PORT: "privileged-port",
  INVALID_VOLUME: "invalid-volume",
  WRITABLE_HOST_VOLUME: "writable-host-volume",
  INVALID_ENV: "invalid-env",
  SECRET_IN_ENV: "secret-in-env",
  ROOT_USER: "root-user",
  NON_ROOT_USER: "non-root-user",
  PUBLIC_EXPOSURE: "public-exposure",
  NO_RESTART_POLICY: "no-restart-policy",
  PRIVILEGED_MODE: "privileged-mode",
  GENERATE_MODE: "generate-mode",
  TOO_MANY_SERVICES: "too-many-services",
  TOO_MANY_PORTS: "too-many-ports",
  TOO_MANY_VOLUMES: "too-many-volumes",
  TOO_MANY_ENV_ENTRIES: "too-many-env-entries"
});

const SEVERITY_RANK = Object.freeze({
  [PRECHECK_SEVERITIES.BLOCK]: 0,
  [PRECHECK_SEVERITIES.REVIEW]: 1,
  [PRECHECK_SEVERITIES.INFO]: 2
});

/** `KEY` follows the shell variable shape; a value may contain `=`. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The contract's secret heuristic: any of these words inside the key. */
const SECRET_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|KEY/i;

/** Named-volume shape accepted by Docker; a host path is checked separately. */
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Whitespace and control characters are never legal inside a spec string. */
const CONTROL_OR_SPACE_PATTERN = /[\s\u0000-\u001f\u007f]/;

/** Findings are bounded so a hostile plan cannot inflate the result itself. */
const MAX_DETAIL_LENGTH = 200;
const MAX_SERVICE_LABEL_LENGTH = 120;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function truncate(value, limit = MAX_DETAIL_LENGTH) {
  const text = String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Join the result arrays of several plan shapes into one list of service
 * records. A plan may carry `services` as an array or as an object map;
 * a caller may also pass bare service records. This normalisation is
 * deliberately limited to shape detection, never to a verdict guess.
 *
 * @param {unknown} plans one plan, an array of plans, or bare services
 * @returns {Array<{ record: object, label: string }>}
 */
function normalizeServiceRecords(plans) {
  const records = [];
  const list = Array.isArray(plans) ? plans : [plans];
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;

    if (Array.isArray(entry.services)) {
      const limit = Math.min(entry.services.length, MAX_SERVICES);
      for (let index = 0; index < limit; index += 1) {
        const service = entry.services[index];
        if (!isPlainObject(service)) continue;
        records.push({
          record: service,
          label: serviceLabel(service, `service-${index + 1}`)
        });
      }
      continue;
    }

    if (isPlainObject(entry.services)) {
      const keys = Object.keys(entry.services);
      const limit = Math.min(keys.length, MAX_SERVICES);
      for (let index = 0; index < limit; index += 1) {
        const key = keys[index];
        const service = entry.services[key];
        if (!isPlainObject(service)) continue;
        records.push({
          record: service,
          label: serviceLabel(service, key)
        });
      }
      continue;
    }

    // A bare service record rather than a plan. This keeps the helper usable
    // for a single list of services while a real plan still wins on shape.
    if (Array.isArray(entry.ports) || typeof entry.image === "string" || typeof entry.name === "string") {
      records.push({
        record: entry,
        label: serviceLabel(entry, `service-${records.length + 1}`)
      });
    }
  }
  return records;
}

function serviceLabel(record, fallback) {
  const name = asNonEmptyText(record?.name);
  return truncate(name === null ? fallback : name, MAX_SERVICE_LABEL_LENGTH);
}

function parsePortNumber(text) {
  if (typeof text !== "string" || !/^\d{1,5}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
  return value;
}

function isIPv4(text) {
  if (typeof text !== "string" || text === "") return false;
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * String-level IPv6 check only: brackets, colons and hex digits. It is not a
 * full RFC 5952 parser and is not advertised as one.
 */
function isIPv6(text) {
  if (typeof text !== "string" || text === "") return false;
  if (!text.includes(":")) return false;
  return /^[0-9A-Fa-f:]+$/.test(text);
}

function parsePortSpec(value) {
  if (typeof value !== "string" || value === "") return null;
  if (CONTROL_OR_SPACE_PATTERN.test(value)) return null;

  let core = value;
  let protocol = "tcp";
  const slashIndex = value.indexOf("/");
  if (slashIndex !== -1) {
    if (value.indexOf("/", slashIndex + 1) !== -1) return null;
    protocol = value.slice(slashIndex + 1);
    if (protocol !== "tcp" && protocol !== "udp") return null;
    core = value.slice(0, slashIndex);
    if (core === "") return null;
  }

  let bindHost = null;
  let hostText = "";
  let containerText = "";

  if (core.startsWith("[")) {
    const closeIndex = core.indexOf("]");
    if (closeIndex === -1) return null;
    const address = core.slice(1, closeIndex);
    if (!isIPv6(address)) return null;
    const afterBracket = core.slice(closeIndex + 1);
    if (!afterBracket.startsWith(":")) return null;
    const segments = afterBracket.slice(1).split(":");
    if (segments.length !== 2) return null;
    bindHost = address;
    hostText = segments[0];
    containerText = segments[1];
  } else {
    const segments = core.split(":");
    if (segments.length === 2) {
      hostText = segments[0];
      containerText = segments[1];
    } else if (segments.length === 3) {
      if (!isIPv4(segments[0])) return null;
      bindHost = segments[0];
      hostText = segments[1];
      containerText = segments[2];
    } else {
      return null;
    }
  }

  const host = parsePortNumber(hostText);
  const container = parsePortNumber(containerText);
  if (host === null || container === null) return null;

  return { host, container, protocol, bindHost };
}

function isWildcardBind(bindHost) {
  if (bindHost === null) return true;
  if (bindHost === "0.0.0.0" || bindHost === "::") return true;
  return /^0(:0){7}$/.test(bindHost);
}

/**
 * Validate one `host:container[/protocol]` port mapping.
 *
 * Accepted shapes:
 *   "8080:80"                host port 8080, container 80, tcp
 *   "127.0.0.1:8080:80/udp"  bound to one IPv4 address, udp
 *   "[::1]:8080:80"          bound to one IPv6 address, tcp
 *
 * The bind address is validated but not echoed by this function; the
 * pre-check uses it internally to detect a wildcard exposure. Ports are
 * numbers in 1..65535, protocols are exactly "tcp" or "udp" (default tcp).
 *
 * @param {unknown} value
 * @returns {{ host: number, container: number, protocol: string } | null}
 */
export function validatePortMapping(value) {
  const parsed = parsePortSpec(value);
  if (parsed === null) return null;
  return { host: parsed.host, container: parsed.container, protocol: parsed.protocol };
}

/**
 * Validate one volume mapping.
 *
 * A source starting with `/` or `.` is treated as a host path; any other
 * source is a named volume. Host paths must not contain whitespace or a
 * `..` segment. Container paths must be absolute. The only explicit mode
 * accepted is `:ro`; a writable mapping is the default and its mode is
 * reported as `"rw"`.
 *
 * @param {unknown} value
 * @returns {{ hostPath: string, containerPath: string, mode: string } | null}
 */
export function validateVolumeSpec(value) {
  if (typeof value !== "string" || value === "") return null;
  if (CONTROL_OR_SPACE_PATTERN.test(value)) return null;

  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const source = parts[0];
  const containerPath = parts[1];
  let mode = "rw";
  if (parts.length === 3) {
    if (parts[2] !== "ro") return null;
    mode = "ro";
  }

  if (source === "") return null;
  if (!containerPath.startsWith("/")) return null;
  if (hasTraversal(containerPath)) return null;

  if (isHostPathSource(source)) {
    if (hasTraversal(source)) return null;
  } else if (!VOLUME_NAME_PATTERN.test(source)) {
    return null;
  }

  return { hostPath: source, containerPath, mode };
}

function hasTraversal(text) {
  return text.split("/").some(segment => segment === "..");
}

function isHostPathSource(source) {
  return source.startsWith("/") || source.startsWith(".");
}

/**
 * Validate one `KEY=VALUE` environment entry. `KEY` must be a shell variable
 * name; the value may be empty and may contain further `=` characters.
 *
 * @param {unknown} value
 * @returns {{ key: string, value: string } | null}
 */
export function validateEnvEntry(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("=");
  if (separator <= 0) return null;
  const key = value.slice(0, separator);
  if (!ENV_KEY_PATTERN.test(key)) return null;
  return { key, value: value.slice(separator + 1) };
}

function collectPortClaims(records) {
  const claims = [];
  for (const { record, label } of records) {
    if (!Array.isArray(record.ports)) continue;
    const limit = Math.min(record.ports.length, MAX_PORTS);
    for (let index = 0; index < limit; index += 1) {
      const parsed = parsePortSpec(record.ports[index]);
      if (parsed === null) continue;
      claims.push({ host: parsed.host, protocol: parsed.protocol, service: label });
    }
  }
  return claims;
}

function groupPortClaims(claims) {
  const groups = new Map();
  for (const claim of claims) {
    const key = `${claim.host}|${claim.protocol}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { host: claim.host, protocol: claim.protocol, services: new Set() };
      groups.set(key, group);
    }
    group.services.add(claim.service);
  }

  const conflicts = [];
  for (const group of groups.values()) {
    // One service publishing a port twice does not collide with itself.
    if (group.services.size < 2) continue;
    conflicts.push({
      host: group.host,
      protocol: group.protocol,
      services: [...group.services].sort(compareText),
      severity: PRECHECK_SEVERITIES.BLOCK
    });
  }

  conflicts.sort((a, b) => {
    return a.host - b.host || compareText(a.protocol, b.protocol) || compareText(a.services.join(","), b.services.join(","));
  });
  return conflicts;
}

/**
 * Find published host ports claimed by two or more distinct services.
 *
 * The comparison is the pair `hostPort/protocol`; the bind address is
 * deliberately not compared, so `0.0.0.0:8080:80` and `127.0.0.1:8080:80`
 * collide (conservative). A port published twice by one service alone is
 * not a conflict. The input may be one plan, an array of plans, or a list
 * of bare service records; plan services may be an array or an object map.
 *
 * @param {unknown} plans
 * @returns {Array<{ host: number, protocol: string, services: string[], severity: string }>}
 */
export function findPortConflicts(plans) {
  return groupPortClaims(collectPortClaims(normalizeServiceRecords(plans)));
}

function addMissingImageFinding(record, label, add) {
  if (asNonEmptyText(record.image) === null) {
    add(
      PRECHECK_CODES.MISSING_IMAGE,
      PRECHECK_SEVERITIES.BLOCK,
      label,
      `service "${label}" does not declare an image`
    );
  }
}

function addPortFindings(record, label, add, claims) {
  let hasWildcardPort = false;
  if (record.ports === undefined || record.ports === null) return hasWildcardPort;
  if (!Array.isArray(record.ports)) {
    add(
      PRECHECK_CODES.INVALID_PORT,
      PRECHECK_SEVERITIES.REVIEW,
      label,
      'ports must be an array of "host:container[/protocol]" strings'
    );
    return hasWildcardPort;
  }

  if (record.ports.length > MAX_PORTS) {
    add(
      PRECHECK_CODES.TOO_MANY_PORTS,
      PRECHECK_SEVERITIES.BLOCK,
      label,
      `service declares ${record.ports.length} port mappings; the maximum is ${MAX_PORTS}`
    );
  }

  const limit = Math.min(record.ports.length, MAX_PORTS);
  for (let index = 0; index < limit; index += 1) {
    const parsed = parsePortSpec(record.ports[index]);
    if (parsed === null) {
      add(
        PRECHECK_CODES.INVALID_PORT,
        PRECHECK_SEVERITIES.REVIEW,
        label,
        `ports[${index + 1}] is not a valid "host:container[/protocol]" mapping`
      );
      continue;
    }
    claims.push({ host: parsed.host, protocol: parsed.protocol, service: label });
    if (isWildcardBind(parsed.bindHost)) hasWildcardPort = true;
    if (parsed.host < 1024) {
      add(
        PRECHECK_CODES.PRIVILEGED_PORT,
        PRECHECK_SEVERITIES.REVIEW,
        label,
        `host port ${parsed.host} is privileged (below 1024)`
      );
    }
  }
  return hasWildcardPort;
}

function addVolumeFindings(record, label, add) {
  const result = { writableHostVolume: false };
  if (record.volumes === undefined || record.volumes === null) return result;
  if (!Array.isArray(record.volumes)) {
    add(
      PRECHECK_CODES.INVALID_VOLUME,
      PRECHECK_SEVERITIES.REVIEW,
      label,
      'volumes must be an array of "source:containerPath[:ro]" strings'
    );
    return result;
  }

  if (record.volumes.length > MAX_VOLUMES) {
    add(
      PRECHECK_CODES.TOO_MANY_VOLUMES,
      PRECHECK_SEVERITIES.BLOCK,
      label,
      `service declares ${record.volumes.length} volume mappings; the maximum is ${MAX_VOLUMES}`
    );
  }

  const limit = Math.min(record.volumes.length, MAX_VOLUMES);
  for (let index = 0; index < limit; index += 1) {
    const volume = validateVolumeSpec(record.volumes[index]);
    if (volume === null) {
      add(
        PRECHECK_CODES.INVALID_VOLUME,
        PRECHECK_SEVERITIES.REVIEW,
        label,
        `volumes[${index + 1}] is not a valid "source:containerPath[:ro]" mapping`
      );
      continue;
    }
    if (isHostPathSource(volume.hostPath) && volume.mode !== "ro") {
      result.writableHostVolume = true;
      add(
        PRECHECK_CODES.WRITABLE_HOST_VOLUME,
        PRECHECK_SEVERITIES.REVIEW,
        label,
        `host path "${truncate(volume.hostPath, 80)}" is mounted read-write; add ":ro" or use a named volume`
      );
    }
  }
  return result;
}

function reportSecretKey(key, value, label, add) {
  if (!SECRET_KEY_PATTERN.test(key)) return;
  if (value.trim() === "") return;
  // The value is deliberately never interpolated into the finding.
  add(
    PRECHECK_CODES.SECRET_IN_ENV,
    PRECHECK_SEVERITIES.REVIEW,
    label,
    `environment variable "${truncate(key, 80)}" looks like a secret; the value is withheld`
  );
}

function addEnvFindings(record, label, add) {
  const env = record.env;
  if (env === undefined || env === null) return;

  if (Array.isArray(env)) {
    if (env.length > MAX_ENV_ENTRIES) {
      add(
        PRECHECK_CODES.TOO_MANY_ENV_ENTRIES,
        PRECHECK_SEVERITIES.BLOCK,
        label,
        `service declares ${env.length} environment entries; the maximum is ${MAX_ENV_ENTRIES}`
      );
    }
    const limit = Math.min(env.length, MAX_ENV_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      const entry = validateEnvEntry(env[index]);
      if (entry === null) {
        add(
          PRECHECK_CODES.INVALID_ENV,
          PRECHECK_SEVERITIES.REVIEW,
          label,
          `env[${index + 1}] is not a valid "KEY=VALUE" entry`
        );
        continue;
      }
      reportSecretKey(entry.key, entry.value, label, add);
    }
    return;
  }

  if (isPlainObject(env)) {
    const keys = Object.keys(env);
    if (keys.length > MAX_ENV_ENTRIES) {
      add(
        PRECHECK_CODES.TOO_MANY_ENV_ENTRIES,
        PRECHECK_SEVERITIES.BLOCK,
        label,
        `service declares ${keys.length} environment entries; the maximum is ${MAX_ENV_ENTRIES}`
      );
    }
    const limit = Math.min(keys.length, MAX_ENV_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index];
      const value = env[key];
      if (typeof value !== "string") {
        add(
          PRECHECK_CODES.INVALID_ENV,
          PRECHECK_SEVERITIES.REVIEW,
          label,
          `env.${truncate(key, 60)} must be a string value`
        );
        continue;
      }
      if (!ENV_KEY_PATTERN.test(key)) {
        add(
          PRECHECK_CODES.INVALID_ENV,
          PRECHECK_SEVERITIES.REVIEW,
          label,
          `env.${truncate(key, 60)} is not a valid variable name`
        );
        continue;
      }
      reportSecretKey(key, value, label, add);
    }
    return;
  }

  add(
    PRECHECK_CODES.INVALID_ENV,
    PRECHECK_SEVERITIES.REVIEW,
    label,
    'env must be an array of "KEY=VALUE" strings or an object'
  );
}

function addUserFindings(record, label, add) {
  const user = record.user;

  if (user === undefined || user === null) {
    add(
      PRECHECK_CODES.ROOT_USER,
      PRECHECK_SEVERITIES.REVIEW,
      label,
      "user is not declared; the container may run as root"
    );
    return;
  }

  if (typeof user === "number") {
    if (!Number.isInteger(user) || user < 0) {
      add(
        PRECHECK_CODES.ROOT_USER,
        PRECHECK_SEVERITIES.REVIEW,
        label,
        "user is not a valid user id; the container may run as root"
      );
      return;
    }
    if (user === 0) {
      add(PRECHECK_CODES.ROOT_USER, PRECHECK_SEVERITIES.REVIEW, label, "user is declared as 0 (root)");
    } else {
      add(PRECHECK_CODES.NON_ROOT_USER, PRECHECK_SEVERITIES.INFO, label, `user is declared as ${user} (non-root)`);
    }
    return;
  }

  if (typeof user !== "string") {
    add(
      PRECHECK_CODES.ROOT_USER,
      PRECHECK_SEVERITIES.REVIEW,
      label,
      "user must be a string or a non-negative integer"
    );
    return;
  }

  const text = user.trim();
  if (text === "") {
    add(
      PRECHECK_CODES.ROOT_USER,
      PRECHECK_SEVERITIES.REVIEW,
      label,
      "user is declared as an empty string; the container may run as root"
    );
    return;
  }

  const name = text.split(":")[0];
  const isRoot = name === "root" || (/^\d+$/.test(name) && Number(name) === 0);
  if (isRoot) {
    add(PRECHECK_CODES.ROOT_USER, PRECHECK_SEVERITIES.REVIEW, label, `user "${truncate(text, 80)}" runs as root`);
  } else {
    add(
      PRECHECK_CODES.NON_ROOT_USER,
      PRECHECK_SEVERITIES.INFO,
      label,
      `user "${truncate(text, 80)}" runs as a non-root user`
    );
  }
}

function addRestartFinding(record, label, add) {
  if (record.restart === undefined || record.restart === null) {
    add(PRECHECK_CODES.NO_RESTART_POLICY, PRECHECK_SEVERITIES.INFO, label, "no restart policy is declared");
    return;
  }
  if (typeof record.restart !== "string" || record.restart.trim() === "") {
    add(PRECHECK_CODES.NO_RESTART_POLICY, PRECHECK_SEVERITIES.INFO, label, "no usable restart policy is declared");
  }
}

function addPublicExposureFinding(hasWildcardPort, writableHostVolume, privileged, label, add) {
  if (!hasWildcardPort) return;
  if (!writableHostVolume && !privileged) return;
  const reasons = [];
  if (writableHostVolume) reasons.push("a host path is mounted read-write");
  if (privileged) reasons.push("the service is privileged");
  add(
    PRECHECK_CODES.PUBLIC_EXPOSURE,
    PRECHECK_SEVERITIES.REVIEW,
    label,
    `a published port uses a wildcard bind address while ${reasons.join(" and ")}`
  );
}

function validateServiceRecord(record, label, add, claims) {
  addMissingImageFinding(record, label, add);

  const privileged = record.privileged === true;
  if (privileged) {
    add(PRECHECK_CODES.PRIVILEGED_MODE, PRECHECK_SEVERITIES.BLOCK, label, "the service requests privileged mode");
  }

  const hasWildcardPort = addPortFindings(record, label, add, claims);

  const volumeResult = addVolumeFindings(record, label, add);
  addEnvFindings(record, label, add);
  addUserFindings(record, label, add);
  addRestartFinding(record, label, add);
  addPublicExposureFinding(hasWildcardPort, volumeResult.writableHostVolume, privileged, label, add);
}

function normalizePlanServices(plan, add) {
  const raw = plan.services;

  if (Array.isArray(raw)) {
    const services = [];
    const limit = Math.min(raw.length, MAX_SERVICES);
    for (let index = 0; index < limit; index += 1) {
      const entry = raw[index];
      if (!isPlainObject(entry)) {
        add(PRECHECK_CODES.INVALID_PLAN, PRECHECK_SEVERITIES.BLOCK, null, `services[${index + 1}] must be a service object`);
        continue;
      }
      services.push({ record: entry, label: serviceLabel(entry, `service-${index + 1}`) });
    }
    return { valid: true, services, count: raw.length };
  }

  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    const services = [];
    const limit = Math.min(keys.length, MAX_SERVICES);
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index];
      const entry = raw[key];
      if (!isPlainObject(entry)) {
        add(
          PRECHECK_CODES.INVALID_PLAN,
          PRECHECK_SEVERITIES.BLOCK,
          null,
          `services["${truncate(key, 60)}"] must be a service object`
        );
        continue;
      }
      services.push({ record: entry, label: serviceLabel(entry, key) });
    }
    return { valid: true, services, count: keys.length };
  }

  add(
    PRECHECK_CODES.INVALID_PLAN,
    PRECHECK_SEVERITIES.BLOCK,
    null,
    "plan.services must be an array or an object map of services"
  );
  return { valid: false, services: [], count: 0 };
}

function compareFindings(a, b) {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;

  if (a.service === null && b.service !== null) return -1;
  if (a.service !== null && b.service === null) return 1;
  if (a.service !== null && b.service !== null) {
    const byService = compareText(a.service, b.service);
    if (byService !== 0) return byService;
  }

  const byCode = compareText(a.code, b.code);
  if (byCode !== 0) return byCode;
  return compareText(a.detail, b.detail);
}

function dedupeFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const key = `${finding.severity}|${finding.code}|${finding.service === null ? "" : finding.service}|${finding.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

function buildResult(findings, serviceCount, notes) {
  const unique = dedupeFindings(findings).sort(compareFindings);

  let verdict = PRECHECK_VERDICTS.OK;
  if (unique.some(finding => finding.severity === PRECHECK_SEVERITIES.BLOCK)) {
    verdict = PRECHECK_VERDICTS.BLOCKED;
  } else if (serviceCount === 0) {
    // A well-formed plan with no services is not a finding: there is simply
    // nothing this layer can judge. It is reported as unknown, never as ok.
    verdict = PRECHECK_VERDICTS.UNKNOWN;
  } else if (unique.some(finding => finding.severity === PRECHECK_SEVERITIES.REVIEW)) {
    verdict = PRECHECK_VERDICTS.NEEDS_REVIEW;
  }

  return { verdict, findings: unique, serviceCount, notes: [...notes] };
}

/**
 * Pre-check one deployment plan.
 *
 * The plan is expected to look like `{ services, generate?, privileged? }`,
 * where `services` is either an array of service objects or an object map
 * (keyed by service name) of service objects. A service may declare
 * `name`, `image`, `ports`, `volumes`, `env` (array of `KEY=VALUE` strings
 * or a plain object), `user`, `restart` and `privileged`.
 *
 * Rules:
 *   - structurally invalid plan / service entry -> blocked, `invalid-plan`;
 *   - missing or empty image -> blocked, `missing-image`;
 *   - two distinct services publishing the same `hostPort/protocol` ->
 *     blocked, `port-conflict`;
 *   - `plan.privileged === true` or a privileged service -> blocked,
 *     `privileged-mode`;
 *   - `plan.generate === true` or `options.generate === true` -> blocked,
 *     `generate-mode`;
 *   - a malformed port mapping or a host port below 1024 -> review,
 *     `invalid-port` / `privileged-port`;
 *   - a host-path volume without `:ro` -> review,
 *     `writable-host-volume`;
 *   - a service without a declared non-root `user` -> review, `root-user`;
 *     an explicitly declared non-root user -> info, `non-root-user`;
 *   - a secret-looking `env` key with a non-empty value -> review,
 *     `secret-in-env`; the value is withheld;
 *   - a wildcard-published service that also mounts a host path writable
 *     or is privileged -> review, `public-exposure`;
 *   - no declared `restart` policy -> info, `no-restart-policy`;
 *   - exceeding a `MAX_*` bound -> blocked with the matching `too-many-*`.
 *
 * A plan whose `services` collection is empty and well-formed yields
 * `unknown` with the note `no-services`; it is not called blocked and not
 * called ok. Any block wins over review, review wins over ok.
 *
 * @param {unknown} plan
 * @param {{ generate?: boolean }} [options]
 * @returns {{ verdict: string, findings: Array<{ code: string, severity: string, service: string | null, detail: string }>, serviceCount: number, notes: string[] }}
 */
export function precheckDeploymentPlan(plan, options = {}) {
  const findings = [];
  const notes = [];
  const settings = isPlainObject(options) ? options : {};
  const add = (code, severity, service, detail) => {
    findings.push({ code, severity, service, detail: truncate(detail) });
  };

  if (!isPlainObject(plan)) {
    add(
      PRECHECK_CODES.INVALID_PLAN,
      PRECHECK_SEVERITIES.BLOCK,
      null,
      "plan must be a plain object with a services array or map"
    );
    return buildResult(findings, 0, notes);
  }

  if (plan.generate === true || settings.generate === true) {
    add(
      PRECHECK_CODES.GENERATE_MODE,
      PRECHECK_SEVERITIES.BLOCK,
      null,
      "the plan requests generate mode; a generated plan must be reviewed before deployment"
    );
  }
  if (plan.privileged === true) {
    add(
      PRECHECK_CODES.PRIVILEGED_MODE,
      PRECHECK_SEVERITIES.BLOCK,
      null,
      "the plan requests privileged mode at plan level"
    );
  }

  const normalized = normalizePlanServices(plan, add);
  if (!normalized.valid) {
    return buildResult(findings, normalized.count, notes);
  }

  if (normalized.count === 0) {
    notes.push("no-services");
    return buildResult(findings, 0, notes);
  }

  if (normalized.count > MAX_SERVICES) {
    add(
      PRECHECK_CODES.TOO_MANY_SERVICES,
      PRECHECK_SEVERITIES.BLOCK,
      null,
      `plan declares ${normalized.count} services; the maximum is ${MAX_SERVICES}`
    );
  }

  const claims = [];
  for (const { record, label } of normalized.services) {
    validateServiceRecord(record, label, add, claims);
  }

  for (const conflict of groupPortClaims(claims)) {
    add(
      PRECHECK_CODES.PORT_CONFLICT,
      PRECHECK_SEVERITIES.BLOCK,
      null,
      `host port ${conflict.host}/${conflict.protocol} is published by ${conflict.services.length} services: ${conflict.services.join(", ")}`
    );
  }

  return buildResult(findings, normalized.count, notes);
}
