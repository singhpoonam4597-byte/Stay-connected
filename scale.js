/**
 * Lightweight in-memory helpers for concurrent chat load.
 * Works on a single Render instance (hundreds of simultaneous users).
 * For multi-instance scale, add Redis later.
 */

/** Sliding-window rate limiter: key → timestamps */
const buckets = new Map();

export function rateLimit(key, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) {
    arr = [];
    buckets.set(key, arr);
  }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) {
    return { ok: false, retryAfterMs: arr[0] + windowMs - now };
  }
  arr.push(now);
  return { ok: true };
}

/** Throttle expensive DB writes (presence) */
const lastWrite = new Map();

export function shouldWrite(key, minIntervalMs = 60_000) {
  const now = Date.now();
  const prev = lastWrite.get(key) || 0;
  if (now - prev < minIntervalMs) return false;
  lastWrite.set(key, now);
  return true;
}

/** Periodic cleanup so Maps don't grow forever */
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const filtered = arr.filter((t) => t > now - 120_000);
    if (filtered.length) buckets.set(k, filtered);
    else buckets.delete(k);
  }
  for (const [k, t] of lastWrite) {
    if (now - t > 600_000) lastWrite.delete(k);
  }
}, 120_000).unref?.();
