/**
 * Phase 204 — Docker live resource sampling: parse and judge (pure functions).
 *
 * `docker stats --no-stream --format json` (or `--format '{{json .}}'`) emits
 * one JSON object per line. This layer turns those lines into numbers, ranks
 * the containers and flags the situations an operator should look at before
 * touching anything. It is the analysis half of APP02 (container resource
 * analysis); the collector that talks to Docker and the route that exposes the
 * result are deliberately absent from this module.
 *
 * Red lines:
 *   - zero dependencies, zero `import`, zero I/O, zero child process, zero
 *     Docker socket: every function is pure over data the caller collected;
 *   - a byte size without a unit is never accepted; `N/A` becomes `null` and
 *     an unparsable value becomes a parse error or `null`, never an invented
 *     number;
 *   - fields that the input does not carry stay unknown. `memPercent` is NOT
 *     derived from `memUsedBytes` / `memLimitBytes`, a missing restart count is
 *     NOT treated as zero, and a missing block-IO counter never becomes an
 *     io-stall. Unknown is reported as unknown, never as healthy;
 *   - an unknown measurement never produces an anomaly, but it also never
 *     clears one that was measured: the newest sample decides current
 *     CPU / memory pressure;
 *   - the output is bounded: only the newest MAX_SAMPLES samples are used,
 *     container names inside details are cut to MAX_NAME_LENGTH and details
 *     themselves are capped.
 */

/**
 * The columns `docker stats --format json` documents, in the order the
 * classic table prints them. `Container` is the id, `Name` is the name.
 */
export const STATS_COLUMNS = Object.freeze([
  "Container",
  "Name",
  "CPUPerc",
  "MemUsage",
  "MemPerc",
  "NetIO",
  "BlockIO",
  "PIDs",
]);

/** Newest N samples only; older samples are dropped instead of averaged. */
export const MAX_SAMPLES = 200;

/** Longest container name that may appear inside a detail / evidence string. */
export const MAX_NAME_LENGTH = 120;

/**
 * The only parse failure reasons. Callers may branch on these strings.
 */
export const STATS_PARSE_REASONS = Object.freeze({
  EMPTY_LINE: "empty-line",
  INVALID_JSON: "invalid-json",
  MISSING_NAME: "missing-name",
  INVALID_CPU: "invalid-cpu",
  INVALID_MEMORY: "invalid-memory",
});

/** The only anomaly kinds this layer can emit. */
export const STATS_ANOMALY_KINDS = Object.freeze({
  CPU_SATURATION: "cpu-saturation",
  MEMORY_PRESSURE: "memory-pressure",
  MEMORY_NEAR_LIMIT: "memory-near-limit",
  IO_STALL: "io-stall",
  RESTART_LOOP: "restart-loop",
});

/**
 * Default anomaly thresholds. Every value may be overridden per call with
 * `thresholds`; an override that is not a finite, non-negative number is
 * ignored and the default stays in force.
 *
 * - `cpuPercent`: newest sample at or above this is saturated;
 * - `memoryPercent`: newest sample at or above this is under pressure;
 * - `memoryNearLimitPercent`: newest sample at or above this is critical;
 *   this check wins over `memoryPercent`, an anomaly is reported once;
 * - `restartCount`: at or above this many restarts is a restart loop;
 * - `maxSampleAgeMs`: when `now` is supplied and a sample carries a parsable
 *   `sampledAt`, a newest sample older than this is not used for the
 *   current-state CPU / memory checks (io-stall and restart-loop still are).
 */
export const DEFAULT_STATS_THRESHOLDS = Object.freeze({
  cpuPercent: 90,
  memoryPercent: 90,
  memoryNearLimitPercent: 98,
  restartCount: 3,
  maxSampleAgeMs: 300000,
});

/** A container at or below this CPU share counts as idle, not as busy. */
const IDLE_CPU_PERCENT = 0.05;

/** Details are bounded so one hostile name or number cannot inflate output. */
const MAX_DETAIL_LENGTH = 240;
const ELLIPSIS = "...";

const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });

const CONFIDENCE_BY_SEVERITY = Object.freeze({
  critical: "high",
  warning: "medium",
  info: "low",
});

const NOT_AVAILABLE = /^n\/a$/i;
const PERCENT_VALUE = /^([0-9]+(?:\.[0-9]+)?)%$/;
const BYTE_VALUE = /^([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB|TiB|kB|MB|GB)$/;

/**
 * Byte units accepted by `docker stats`. The binary family is 1024-based and
 * the decimal family is 1000-based, exactly as Docker prints them: memory uses
 * `MiB` / `GiB`, network I/O uses `kB` / `MB` / `GB`. A unit outside this table
 * (for example `TB`, `kb` or `M`) is not guessed.
 */
const BYTE_UNITS = Object.freeze({
  B: 1,
  kB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
});

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return String(round(value, 2));
}

/** Keep at most MAX_NAME_LENGTH code units, marking a cut with "...". */
function truncateName(name) {
  const text = asText(name);
  if (text.length <= MAX_NAME_LENGTH) return text;
  return `${text.slice(0, MAX_NAME_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

function boundDetail(detail) {
  const text = String(detail);
  if (text.length <= MAX_DETAIL_LENGTH) return text;
  return `${text.slice(0, MAX_DETAIL_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

function isNotAvailable(text) {
  return NOT_AVAILABLE.test(text);
}

function numberOrNull(value, { nonNegative = true } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (nonNegative && value < 0) return null;
  return value;
}

function countOrNull(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Parse a percentage such as `1.5%`, `0.00%` or `100.00%`.
 * `N/A` is a known-but-unknown value and becomes `null`; anything else that
 * does not match the pattern (including a unitless number) is invalid.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function percentValue(raw) {
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim();
  if (!text) return { ok: false };
  if (isNotAvailable(text)) return { ok: true, value: null };
  const match = PERCENT_VALUE.exec(text);
  if (!match) return { ok: false };
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * Parse one byte size such as `0B`, `1.2kB` or `12.34MiB`.
 * The unit is mandatory; a bare number is rejected instead of being assumed
 * to be bytes.
 *
 * @param {unknown} raw
 * @returns {number|null} bytes, or null when the text is not a byte size
 */
function parseByteSize(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const match = BYTE_VALUE.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const bytes = Math.round(amount * BYTE_UNITS[match[2]]);
  return Number.isFinite(bytes) ? bytes : null;
}

function splitPair(raw) {
  if (typeof raw !== "string") return null;
  // Prefer the " / " separator: each part may itself be "N/A", which contains
  // a slash and would otherwise turn "N/A / 1GiB" into three parts.
  let parts = raw.split(" / ");
  if (parts.length !== 2) parts = raw.split("/");
  if (parts.length !== 2) return null;
  const left = parts[0].trim();
  const right = parts[1].trim();
  if (!left || !right) return null;
  return [left, right];
}

/**
 * `MemUsage` is `used / limit`. Both parts are mandatory for a parse success;
 * a whole-value `N/A` is a valid but unknown pair (`null` / `null`). A single
 * `N/A` part keeps that part unknown while the other one is still parsed.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, used: number|null, limit: number|null } | { ok: false }}
 */
function parseMemoryUsage(raw) {
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim();
  if (!text) return { ok: false };
  if (isNotAvailable(text)) return { ok: true, used: null, limit: null };
  const parts = splitPair(text);
  if (!parts) return { ok: false };
  const used = isNotAvailable(parts[0]) ? null : parseByteSize(parts[0]);
  const limit = isNotAvailable(parts[1]) ? null : parseByteSize(parts[1]);
  if (!isNotAvailable(parts[0]) && used === null) return { ok: false };
  if (!isNotAvailable(parts[1]) && limit === null) return { ok: false };
  return { ok: true, used, limit };
}

/**
 * `NetIO` and `BlockIO` are `in / out`. They are optional for this contract:
 * a missing or malformed pair becomes two unknowns and never fails the line,
 * because the closed reason list does not carry an I/O reason. The downside is
 * deliberate: a typo in this column is reported as unknown, not as an error.
 *
 * @param {unknown} raw
 * @returns {{ rx: number|null, tx: number|null }}
 */
function parseIoPair(raw) {
  if (typeof raw !== "string") return { rx: null, tx: null };
  const text = raw.trim();
  if (!text || isNotAvailable(text)) return { rx: null, tx: null };
  const parts = splitPair(text);
  if (!parts) return { rx: null, tx: null };
  return {
    rx: isNotAvailable(parts[0]) ? null : parseByteSize(parts[0]),
    tx: isNotAvailable(parts[1]) ? null : parseByteSize(parts[1]),
  };
}

/** `PIDs` is a non-negative integer; anything unparsable is unknown. */
function parsePids(raw) {
  if (typeof raw === "number") return countOrNull(raw);
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || isNotAvailable(text) || text === "--") return null;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  return text.startsWith("/") ? text.slice(1).trim() : text;
}

/**
 * `MemPerc` is optional: an absent key is unknown rather than invalid, because
 * a caller may build a line from a reduced column set. A present but unparsable
 * value is still invalid-memory.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: number|null } | { ok: false }}
 */
function parseMemoryPercent(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  return percentValue(raw);
}

/**
 * Turn a keyed row (from JSON or from a tabular line) into the container
 * record. The order of the checks defines the reported reason.
 *
 * @param {Record<string, unknown>} row
 * @returns {{ ok: true, container: object } | { ok: false, reason: string }}
 */
function normalizeRow(row) {
  const name = normalizeName(row.Name);
  if (!name) return { ok: false, reason: STATS_PARSE_REASONS.MISSING_NAME };

  const cpu = percentValue(row.CPUPerc);
  if (!cpu.ok) return { ok: false, reason: STATS_PARSE_REASONS.INVALID_CPU };

  const memory = parseMemoryUsage(row.MemUsage);
  if (!memory.ok) return { ok: false, reason: STATS_PARSE_REASONS.INVALID_MEMORY };

  const memoryPercent = parseMemoryPercent(row.MemPerc);
  if (!memoryPercent.ok) return { ok: false, reason: STATS_PARSE_REASONS.INVALID_MEMORY };

  const net = parseIoPair(row.NetIO);
  const block = parseIoPair(row.BlockIO);

  return {
    ok: true,
    container: {
      id: asText(row.Container) || asText(row.ID) || asText(row.ContainerID),
      name,
      cpuPercent: cpu.value,
      memUsedBytes: memory.used,
      memLimitBytes: memory.limit,
      memPercent: memoryPercent.value,
      netRxBytes: net.rx,
      netTxBytes: net.tx,
      blockReadBytes: block.rx,
      blockWriteBytes: block.tx,
      pids: parsePids(row.PIDs),
    },
  };
}

/**
 * Build the object for one tabular line. Docker pads table columns with at
 * least two spaces, while every value that contains a space (`12.3MiB / 1GiB`)
 * uses exactly one, so a two-or-more-space split is unambiguous. The line is
 * only accepted when it yields exactly one cell per expected column.
 *
 * @param {string} text
 * @param {unknown} columns
 * @returns {Record<string, unknown> | null}
 */
function parseDelimitedRow(text, columns) {
  const names =
    Array.isArray(columns) && columns.length && columns.every(name => typeof name === "string")
      ? columns
      : STATS_COLUMNS;
  if (!/\t/.test(text) && !/\s{2,}/.test(text)) return null;
  const cells = text.split(/\t+|\s{2,}/).map(cell => cell.trim());
  if (cells.length !== names.length) return null;
  if (cells.some(cell => !cell)) return null;
  const row = {};
  for (let index = 0; index < names.length; index += 1) {
    row[names[index]] = cells[index];
  }
  return row;
}

/**
 * Parse one line of `docker stats --no-stream --format json` (the same JSON is
 * produced by `--format '{{json .}}'`). A classic tabular row is also accepted
 * when it carries exactly one cell per expected column; anything else is
 * reported as invalid-json instead of being guessed.
 *
 * @param {unknown} line one line of output
 * @param {object} [options]
 * @param {string[]} [options.columns] column layout for a tabular line
 * @returns {{ ok: true, container: {
 *   id: string,
 *   name: string,
 *   cpuPercent: number|null,
 *   memUsedBytes: number|null,
 *   memLimitBytes: number|null,
 *   memPercent: number|null,
 *   netRxBytes: number|null,
 *   netTxBytes: number|null,
 *   blockReadBytes: number|null,
 *   blockWriteBytes: number|null,
 *   pids: number|null
 * }} | { ok: false, reason: string }}
 */
export function parseStatsLine(line, options = {}) {
  if (typeof line !== "string") {
    const empty = line === null || line === undefined;
    return { ok: false, reason: empty ? STATS_PARSE_REASONS.EMPTY_LINE : STATS_PARSE_REASONS.INVALID_JSON };
  }
  const text = line.trim();
  if (!text) return { ok: false, reason: STATS_PARSE_REASONS.EMPTY_LINE };

  let data;
  let parsed = true;
  try {
    data = JSON.parse(text);
  } catch {
    parsed = false;
  }
  if (parsed) {
    if (!isPlainObject(data)) return { ok: false, reason: STATS_PARSE_REASONS.INVALID_JSON };
    return normalizeRow(data);
  }

  const settings = isPlainObject(options) ? options : {};
  const row = parseDelimitedRow(text, settings.columns);
  if (!row) return { ok: false, reason: STATS_PARSE_REASONS.INVALID_JSON };
  return normalizeRow(row);
}

/**
 * Normalise one caller-supplied sample. A sample may be the container object
 * itself or a `{ container }` wrapper (the shape `parseStatsLine` returns),
 * which keeps the wiring free of unwrapping code.
 *
 * Every numeric field that is absent, non-finite or negative becomes `null`
 * (unknown). Nothing is derived from another field.
 *
 * @param {unknown} entry
 * @returns {object|null}
 */
function toContainerSample(entry) {
  if (!isPlainObject(entry)) return null;
  const source = isPlainObject(entry.container) ? entry.container : entry;
  const name = asText(source.name).trim();
  if (!name) return null;
  return {
    id: asText(source.id),
    name,
    cpuPercent: numberOrNull(source.cpuPercent),
    memUsedBytes: numberOrNull(source.memUsedBytes),
    memLimitBytes: numberOrNull(source.memLimitBytes),
    memPercent: numberOrNull(source.memPercent),
    netRxBytes: numberOrNull(source.netRxBytes),
    netTxBytes: numberOrNull(source.netTxBytes),
    blockReadBytes: numberOrNull(source.blockReadBytes),
    blockWriteBytes: numberOrNull(source.blockWriteBytes),
    pids: countOrNull(source.pids),
    sampledAt: source.sampledAt,
  };
}

function topBound(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 5;
  return Math.min(MAX_SAMPLES, Math.floor(value));
}

/**
 * Summarise a sample window. Samples are a time series, so the same container
 * may appear more than once and each appearance is counted.
 *
 * - only the newest MAX_SAMPLES samples are looked at;
 * - `unknownCount` counts samples whose CPU share is unknown, not samples with
 *   an unknown memory field: CPU is the signal that decides idle vs busy;
 * - `idleCount` counts samples whose CPU share is known and <= 0.05;
 * - `totalCpuPercent` / `totalMemUsedBytes` sum the known values only. Zero
 *   therefore means "nothing known was added up", cross-check `unknownCount`;
 * - the top lists only contain known values; ties are ordered by name.
 *
 * @param {unknown} samples sample records (`parseStatsLine(...).container` or `{ container }`)
 * @param {object} [options]
 * @param {number} [options.top] how many entries each top list keeps (default 5)
 * @returns {{
 *   count: number,
 *   totalCpuPercent: number,
 *   totalMemUsedBytes: number,
 *   topCpu: Array<{ name: string, cpuPercent: number }>,
 *   topMemory: Array<{ name: string, memUsedBytes: number }>,
 *   unknownCount: number,
 *   idleCount: number
 * }}
 */
export function summarizeStats(samples, options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const keep = topBound(settings.top);
  const items = asList(samples)
    .slice(-MAX_SAMPLES)
    .map(toContainerSample)
    .filter(Boolean);

  let totalCpuPercent = 0;
  let totalMemUsedBytes = 0;
  let unknownCount = 0;
  let idleCount = 0;
  for (const item of items) {
    if (item.cpuPercent === null) {
      unknownCount += 1;
    } else {
      totalCpuPercent += item.cpuPercent;
      if (item.cpuPercent <= IDLE_CPU_PERCENT) idleCount += 1;
    }
    if (item.memUsedBytes !== null) totalMemUsedBytes += item.memUsedBytes;
  }

  const topCpu = items
    .filter(item => item.cpuPercent !== null)
    .sort((left, right) => right.cpuPercent - left.cpuPercent || compareText(left.name, right.name))
    .slice(0, keep)
    .map(item => ({ name: item.name, cpuPercent: item.cpuPercent }));

  const topMemory = items
    .filter(item => item.memUsedBytes !== null)
    .sort((left, right) => right.memUsedBytes - left.memUsedBytes || compareText(left.name, right.name))
    .slice(0, keep)
    .map(item => ({ name: item.name, memUsedBytes: item.memUsedBytes }));

  return {
    count: items.length,
    totalCpuPercent: round(totalCpuPercent, 2),
    totalMemUsedBytes,
    topCpu,
    topMemory,
    unknownCount,
    idleCount,
  };
}

function resolveThresholds(overrides) {
  const resolved = { ...DEFAULT_STATS_THRESHOLDS };
  if (!isPlainObject(overrides)) return resolved;
  for (const key of Object.keys(resolved)) {
    const value = Number(overrides[key]);
    if (Number.isFinite(value) && value >= 0) resolved[key] = value;
  }
  return resolved;
}

function restartCountOf(restarts, name, id) {
  if (!isPlainObject(restarts)) return null;
  for (const key of [name, id]) {
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(restarts, key)) continue;
    const value = Number(restarts[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function toMillis(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

/**
 * A sample is stale only when both `now` and the sample's `sampledAt` are
 * parsable. A missing timestamp is never assumed to be stale: this layer does
 * not invent a freshness it cannot prove.
 */
function isStale(sample, nowMs, maxSampleAgeMs) {
  if (nowMs === null) return false;
  const sampled = toMillis(sample?.sampledAt);
  if (sampled === null) return false;
  return nowMs - sampled > maxSampleAgeMs;
}

/**
 * io-stall: the newest interval of block I/O did not grow while the PID count
 * stayed the same. Both endpoints must carry read, write and pids; otherwise
 * the interval is unknown and no finding is produced.
 *
 * @returns {{ delta: number, pids: number } | null}
 */
function detectIoStall(group) {
  if (group.length < 2) return null;
  const latest = group[group.length - 1];
  const previous = group[group.length - 2];
  const required = [
    latest.blockReadBytes,
    latest.blockWriteBytes,
    previous.blockReadBytes,
    previous.blockWriteBytes,
    latest.pids,
    previous.pids,
  ];
  if (required.some(value => value === null)) return null;
  if (latest.pids !== previous.pids) return null;
  const delta =
    latest.blockReadBytes + latest.blockWriteBytes - (previous.blockReadBytes + previous.blockWriteBytes);
  if (delta > 0) return null;
  return { delta, pids: latest.pids };
}

/**
 * Detect the five anomaly kinds on a sample window.
 *
 * The newest sample decides current CPU / memory pressure; a missing value is
 * unknown and does not inherit an older reading. `io-stall` compares the newest
 * interval, `restart-loop` reads the caller-supplied restart counts. A container
 * that only appears in `restarts` is still checked (it may be crash-looping
 * without producing a stats row).
 *
 * Fields absent from the input stay unknown and never cause a finding: in
 * particular `memPercent` is not derived from bytes, a missing restart count is
 * not treated as zero, and a missing block-IO counter is not treated as zero
 * growth.
 *
 * @param {unknown} samples time-ordered sample records
 * @param {object} [options]
 * @param {string|number|Date} [options.now] evaluation time, used only to
 *   recognise a provably stale newest sample (a pure layer reads no clock)
 * @param {Record<string, number>} [options.restarts] restart count per
 *   container name (fallback: container id)
 * @param {object} [options.thresholds] overrides for DEFAULT_STATS_THRESHOLDS
 * @returns {Array<{ kind: string, severity: "info"|"warning"|"critical", container: string, detail: string }>}
 */
export function detectStatsAnomalies(samples, options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const limits = resolveThresholds(settings.thresholds);
  const nowMs = toMillis(settings.now);
  const restarts = settings.restarts;
  const items = asList(samples)
    .slice(-MAX_SAMPLES)
    .map(toContainerSample)
    .filter(Boolean);

  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.name)) groups.set(item.name, []);
    groups.get(item.name).push(item);
  }
  if (isPlainObject(restarts)) {
    for (const key of Object.keys(restarts)) {
      if (!key || groups.has(key)) continue;
      groups.set(key, []);
    }
  }

  const findings = [];
  for (const [name, group] of groups) {
    const latest = group.length ? group[group.length - 1] : null;
    const id = latest?.id || group[0]?.id || "";

    if (latest && !isStale(latest, nowMs, limits.maxSampleAgeMs)) {
      const cpuPercent = latest.cpuPercent;
      if (cpuPercent !== null && cpuPercent >= limits.cpuPercent) {
        findings.push({
          kind: STATS_ANOMALY_KINDS.CPU_SATURATION,
          severity: "warning",
          container: name,
          detail: boundDetail(
            `cpu ${formatNumber(cpuPercent)}% >= ${formatNumber(limits.cpuPercent)}% on the newest sample (${group.length} sample${group.length === 1 ? "" : "s"})`
          ),
        });
      }

      const memPercent = latest.memPercent;
      if (memPercent !== null && memPercent >= limits.memoryNearLimitPercent) {
        findings.push({
          kind: STATS_ANOMALY_KINDS.MEMORY_NEAR_LIMIT,
          severity: "critical",
          container: name,
          detail: boundDetail(
            `mem ${formatNumber(memPercent)}% >= ${formatNumber(limits.memoryNearLimitPercent)}% (close to the container limit)`
          ),
        });
      } else if (memPercent !== null && memPercent >= limits.memoryPercent) {
        findings.push({
          kind: STATS_ANOMALY_KINDS.MEMORY_PRESSURE,
          severity: "warning",
          container: name,
          detail: boundDetail(
            `mem ${formatNumber(memPercent)}% >= ${formatNumber(limits.memoryPercent)}% (memory pressure)`
          ),
        });
      }
    }

    const stall = detectIoStall(group);
    if (stall) {
      findings.push({
        kind: STATS_ANOMALY_KINDS.IO_STALL,
        severity: "warning",
        container: name,
        detail: boundDetail(
          `block IO read+write delta ${formatNumber(stall.delta)}B <= 0 with pids steady at ${formatNumber(stall.pids)}`
        ),
      });
    }

    const restartCount = restartCountOf(restarts, name, id);
    if (restartCount !== null && restartCount >= limits.restartCount) {
      findings.push({
        kind: STATS_ANOMALY_KINDS.RESTART_LOOP,
        severity: "critical",
        container: name,
        detail: boundDetail(
          `restarts ${formatNumber(restartCount)} >= ${formatNumber(limits.restartCount)}`
        ),
      });
    }
  }

  findings.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      compareText(left.kind, right.kind) ||
      compareText(left.container, right.container)
  );
  return findings;
}

/**
 * Build the evidence bundle for a report.
 *
 * `summary` is a `summarizeStats` result over the whole window; `findings` is
 * the anomaly list, cut to `limit`; `evidence` holds one citable entry per
 * reported finding, with the container name cut to MAX_NAME_LENGTH. When no
 * sample was supplied at all, evidence carries a single low-confidence entry
 * saying that nothing was measured, so an empty list cannot be mistaken for
 * "measured and healthy".
 *
 * @param {unknown} samples
 * @param {object} [options]
 * @param {number} [options.limit] maximum number of findings / evidence entries
 * @returns {{
 *   summary: object,
 *   findings: Array<object>,
 *   evidence: Array<{ source: "docker-stats", detail: string, confidence: string }>
 * }}
 */
export function buildStatsEvidence(samples, options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const limit =
    typeof settings.limit === "number" && Number.isFinite(settings.limit) && settings.limit >= 0
      ? Math.min(MAX_SAMPLES, Math.floor(settings.limit))
      : 10;

  const summary = summarizeStats(samples);
  const findings = detectStatsAnomalies(samples).slice(0, limit);
  const evidence = findings.map(finding => ({
    source: "docker-stats",
    detail: boundDetail(`${truncateName(finding.container)}: ${finding.detail}`),
    confidence: CONFIDENCE_BY_SEVERITY[finding.severity] || "low",
  }));

  if (!evidence.length && summary.count === 0 && limit > 0) {
    evidence.push({
      source: "docker-stats",
      detail: "no docker-stats sample was supplied; resource usage is unknown",
      confidence: "low",
    });
  }

  return { summary, findings, evidence };
}
