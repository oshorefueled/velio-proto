import type { Redis } from "ioredis";

/**
 * Finite fixed-window booking quotas (PLANS.md 5.2): one counter per identity
 * and one per IP, held in Redis with an expiry at the window end. When Redis
 * is unreachable the counter falls back to this process's memory — a
 * per-instance cap, not a fleet-wide limit (PLANS 3.1, 3.6).
 */

export interface QuotaLimits {
  perIdentity: number;
  perIp: number;
  windowSeconds: number;
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Booking request limit reached; retry in ${retryAfterSeconds}s`);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface FallbackEntry {
  epoch: number;
  expiresAt: number;
  identityCount: number;
  ipCount: number;
}

const fallback = new Map<string, FallbackEntry>();

function windowEpochNow(windowSeconds: number): number {
  return Math.floor(Date.now() / (windowSeconds * 1000));
}

/**
 * The per-process fallback is a capped stand-in for Redis, not a fleet-wide
 * limit (PLANS 3.4/5.2). Its use is logged with the scope and window so
 * operators can see when the instance is counting alone, and stale windows
 * are pruned on every write so the map cannot grow without bound.
 */
let lastFallbackLog = 0;
function logFallbackUse(scope: string, windowSeconds: number): void {
  const now = Date.now();
  if (now - lastFallbackLog >= windowSeconds * 1000) {
    lastFallbackLog = now;
    console.warn(
      `rate limit fallback in use (per-instance, not fleet-wide): scope=${scope} windowSeconds=${windowSeconds}`,
    );
  }
}

function pruneStaleWindows(now: number): void {
  for (const [key, entry] of fallback) {
    if (entry.expiresAt <= now) {
      fallback.delete(key);
    }
  }
}

function retryAfterSeconds(windowSeconds: number): number {
  const elapsed = Math.floor(Date.now() / 1000) % windowSeconds;
  return windowSeconds - elapsed;
}

async function redisCount(
  redis: Redis,
  key: string,
  windowSeconds: number,
): Promise<number | null> {
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    return count;
  } catch {
    return null; // caller falls back to the in-process counter
  }
}

function fallbackCount(scope: string, windowSeconds: number, which: "identityCount" | "ipCount"): number {
  const epoch = windowEpochNow(windowSeconds);
  pruneStaleWindows(Date.now());
  logFallbackUse(scope, windowSeconds);
  const entry = fallback.get(scope);
  if (!entry || entry.epoch !== epoch) {
    // The current request consumes the first slot of the fresh window.
    fallback.set(scope, {
      epoch,
      expiresAt: (epoch + 1) * windowSeconds * 1000,
      identityCount: which === "identityCount" ? 1 : 0,
      ipCount: which === "ipCount" ? 1 : 0,
    });
    return 1;
  }
  entry[which] += 1;
  return entry[which];
}

/**
 * Consume one booking attempt for this identity and IP. Throws
 * RateLimitError once either counter exceeds its limit; resolves otherwise.
 */
export async function consumeBookingQuota(
  redis: Redis,
  input: { userId: string; ip: string; limits: QuotaLimits },
): Promise<void> {
  const { windowSeconds } = input.limits;
  const epoch = windowEpochNow(windowSeconds);
  const identityKey = `rl:booking:identity:${input.userId}:${epoch}`;
  const ipKey = `rl:booking:ip:${input.ip}:${epoch}`;

  let identityCount = await redisCount(redis, identityKey, windowSeconds);
  if (identityCount === null) {
    identityCount = fallbackCount(`identity:${input.userId}`, windowSeconds, "identityCount");
  }
  if (identityCount > input.limits.perIdentity) {
    throw new RateLimitError(retryAfterSeconds(windowSeconds));
  }

  let ipCount = await redisCount(redis, ipKey, windowSeconds);
  if (ipCount === null) {
    ipCount = fallbackCount(`ip:${input.ip}`, windowSeconds, "ipCount");
  }
  if (ipCount > input.limits.perIp) {
    throw new RateLimitError(retryAfterSeconds(windowSeconds));
  }
}

/**
 * Consume one attempt in a named fixed-window scope (e.g. invite creation or
 * code resolution) with the same Redis-then-fallback semantics as the
 * booking quota. The identity counter applies only when a userId is given;
 * anonymous scopes (code resolution) count per IP alone.
 */
export async function consumeFixedWindowQuota(
  redis: Redis,
  input: { scope: string; ip: string; userId?: string; limits: QuotaLimits },
): Promise<void> {
  const { windowSeconds } = input.limits;
  const epoch = windowEpochNow(windowSeconds);

  if (input.userId !== undefined) {
    const identityKey = `rl:${input.scope}:identity:${input.userId}:${epoch}`;
    let identityCount = await redisCount(redis, identityKey, windowSeconds);
    if (identityCount === null) {
      identityCount = fallbackCount(`${input.scope}:identity:${input.userId}`, windowSeconds, "identityCount");
    }
    if (identityCount > input.limits.perIdentity) {
      throw new RateLimitError(retryAfterSeconds(windowSeconds));
    }
  }

  const ipKey = `rl:${input.scope}:ip:${input.ip}:${epoch}`;
  let ipCount = await redisCount(redis, ipKey, windowSeconds);
  if (ipCount === null) {
    ipCount = fallbackCount(`${input.scope}:ip:${input.ip}`, windowSeconds, "ipCount");
  }
  if (ipCount > input.limits.perIp) {
    throw new RateLimitError(retryAfterSeconds(windowSeconds));
  }
}
