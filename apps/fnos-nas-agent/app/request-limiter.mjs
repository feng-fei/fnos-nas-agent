export function createFixedWindowLimiter({ limit = 10, windowMs = 60_000, maxKeys = 1000, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000 ||
      !Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError("Invalid rate limiter configuration");
  const buckets = new Map();

  function prune(time) {
    for (const [key, bucket] of buckets) if (time - bucket.startedAt >= windowMs) buckets.delete(key);
  }

  return Object.freeze({
    allow(key) {
      if (typeof key !== "string" || !key || key.length > 256) return false;
      const time = now();
      prune(time);
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          let oldestKey, oldestTime = Infinity;
          for (const [candidate, value] of buckets) if (value.startedAt < oldestTime) { oldestKey = candidate; oldestTime = value.startedAt; }
          if (oldestKey !== undefined) buckets.delete(oldestKey);
        }
        bucket = { startedAt: time, count: 0 };
        buckets.set(key, bucket);
      }
      if (bucket.count >= limit) return false;
      bucket.count++;
      return true;
    },
    reset(key) { return buckets.delete(key); },
    snapshot() { prune(now()); return Object.freeze({ trackedKeys: buckets.size, maxKeys }); }
  });
}
