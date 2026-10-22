export function createFixedWindowLimiter({ limit = 10, windowMs = 60_000, maxKeys = 1000, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000 ||
      !Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError("Invalid rate limiter configuration");
  const buckets = new Map();
  // Keys that were evicted while they were already over the limit keep a
  // "blocked until" marker. Without it, filling the bucket map would reset the
  // counter of the evicted key and let an attacker bypass the limit.
  const blocked = new Map();

  function prune(time) {
    for (const [key, bucket] of buckets) if (time - bucket.startedAt >= windowMs) buckets.delete(key);
    for (const [key, expiresAt] of blocked) if (time >= expiresAt) blocked.delete(key);
  }

  function rememberBlocked(key, bucket) {
    if (bucket.count < limit) return;
    if (blocked.size >= maxKeys) {
      let oldestKey, oldestTime = Infinity;
      for (const [candidate, expiresAt] of blocked) if (expiresAt < oldestTime) { oldestKey = candidate; oldestTime = expiresAt; }
      if (oldestKey !== undefined) blocked.delete(oldestKey);
    }
    blocked.set(key, bucket.startedAt + windowMs);
  }

  return Object.freeze({
    allow(key) {
      if (typeof key !== "string" || !key || key.length > 256) return false;
      const time = now();
      prune(time);
      const blockedUntil = blocked.get(key);
      if (blockedUntil !== undefined && time < blockedUntil) return false;
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          let oldestKey, oldestTime = Infinity;
          for (const [candidate, value] of buckets) if (value.startedAt < oldestTime) { oldestKey = candidate; oldestTime = value.startedAt; }
          if (oldestKey !== undefined) {
            const evicted = buckets.get(oldestKey);
            buckets.delete(oldestKey);
            if (evicted) rememberBlocked(oldestKey, evicted);
          }
        }
        bucket = { startedAt: time, count: 0 };
        buckets.set(key, bucket);
      }
      if (bucket.count >= limit) return false;
      bucket.count++;
      return true;
    },
    reset(key) { blocked.delete(key); return buckets.delete(key); },
    snapshot() { prune(now()); return Object.freeze({ trackedKeys: buckets.size, blockedKeys: blocked.size, maxKeys }); }
  });
}
