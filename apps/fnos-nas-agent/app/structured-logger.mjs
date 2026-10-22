// A structured logger writes one JSON object per line. The contract is narrow on
// purpose: only scalar values survive, a field name that looks like a secret
// carrier is dropped, and a long value is truncated. A log line must never be a
// place where a prompt, a path, a token or a provider answer ends up.
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_LEVEL = "info";
const MAX_VALUE_LENGTH = 256;
const MAX_EVENT_LENGTH = 120;

// Any field name that mentions one of these words is treated as a secret
// carrier and is dropped without looking at its value.
const SENSITIVE_KEY_PATTERN = /(key|token|secret|password|passwd|pwd|authorization|auth|cookie|credential|private|bearer|sessionid|apikey)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLevel(level) {
  const text = typeof level === "string" ? level.trim().toLowerCase() : "";
  return Object.hasOwn(LEVELS, text) ? text : DEFAULT_LEVEL;
}

function truncate(text) {
  if (text.length <= MAX_VALUE_LENGTH) return text;
  return text.slice(0, MAX_VALUE_LENGTH);
}

function scalarValue(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return truncate(value);
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "boolean") return value;
  return undefined;
}

// Only string / number / boolean / null survive. An object or an array is
// dropped: a nested structure is the usual way a prompt or a payload sneaks
// into a log line.
function normalizeFields(fields) {
  const normalized = {};
  if (!isPlainObject(fields)) return normalized;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof key !== "string" || !key) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const scalar = scalarValue(value);
    if (scalar === undefined) continue;
    normalized[key] = scalar;
  }
  return normalized;
}

export function createStructuredLogger({ stream = process.stdout, level = DEFAULT_LEVEL, now = () => new Date().toISOString(), allowedFields = null } = {}) {
  if (!stream || typeof stream.write !== "function") throw new TypeError("stream must be writable");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const threshold = LEVELS[normalizeLevel(level)];
  const allow = Array.isArray(allowedFields) && allowedFields.length
    ? new Set(allowedFields.filter(name => typeof name === "string" && name))
    : null;

  function write(line) {
    try {
      stream.write(line + "\n");
    } catch {
      // A broken log stream must never break the caller.
    }
  }

  function makeLogger(defaultEvent = "", context = {}) {
    function log(logLevel, event, fields) {
      const resolvedLevel = normalizeLevel(logLevel);
      if (LEVELS[resolvedLevel] < threshold) return;
      const eventName = truncate(String(event ?? defaultEvent ?? "").slice(0, MAX_EVENT_LENGTH));
      const merged = { ...context, ...(isPlainObject(fields) ? fields : {}) };
      let safe = normalizeFields(merged);
      // The envelope owns ts / level / event: a field must never overwrite them.
      delete safe.ts;
      delete safe.level;
      delete safe.event;
      if (allow) {
        for (const key of Object.keys(safe)) if (!allow.has(key)) delete safe[key];
      }
      const record = { ts: now(), level: resolvedLevel, event: eventName, ...safe };
      let line;
      try {
        line = JSON.stringify(record);
      } catch {
        return;
      }
      write(line);
    }
    return Object.freeze({
      log,
      debug(event, fields) { log("debug", event, fields); },
      info(event, fields) { log("info", event, fields); },
      warn(event, fields) { log("warn", event, fields); },
      error(event, fields) { log("error", event, fields); },
      child(contextFields = {}) {
        const safeContext = normalizeFields(contextFields);
        // child({ event }) names the event of every later line; any other field
        // becomes a context value that the child adds to each line.
        const childEvent = typeof contextFields?.event === "string" ? contextFields.event : defaultEvent;
        delete safeContext.event;
        return makeLogger(childEvent, { ...context, ...safeContext });
      }
    });
  }

  return makeLogger();
}
