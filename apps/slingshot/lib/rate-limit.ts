// A sliding-window rate limiter held in memory, so each server instance
// counts on its own.

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const CLEANUP_INTERVAL = 60000; // ms
const MAX_REQUESTS = 5;
const WINDOW_MS = 1000;

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      entry.timestamps = entry.timestamps.filter(
        (ts) => now - ts < WINDOW_MS * 2,
      );
      if (entry.timestamps.length === 0) {
        rateLimitStore.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export function checkRateLimit(identifier: string): RateLimitResult {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier) || { timestamps: [] };

  entry.timestamps = entry.timestamps.filter((ts) => now - ts < WINDOW_MS);

  if (entry.timestamps.length >= MAX_REQUESTS) {
    const oldestTimestamp = entry.timestamps[0];
    const reset = oldestTimestamp + WINDOW_MS;
    rateLimitStore.set(identifier, entry);
    return {
      success: false,
      limit: MAX_REQUESTS,
      remaining: 0,
      reset,
    };
  }

  entry.timestamps.push(now);
  rateLimitStore.set(identifier, entry);

  return {
    success: true,
    limit: MAX_REQUESTS,
    remaining: MAX_REQUESTS - entry.timestamps.length,
    reset: now + WINDOW_MS,
  };
}
