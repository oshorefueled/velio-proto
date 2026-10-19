import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import { consumeBookingQuota, consumeFixedWindowQuota, RateLimitError } from "../src/ratelimit.ts";
import { resetAndMigrate, urlFor } from "./support/db.mts";

describe("booking-path timeout split", () => {
  it("gives the pool its own statement timeout, not the readiness budget", () => {
    const pool = createPool("postgres://x:y@localhost:5432/x", { statement_timeout: 5000 });
    expect(pool.options.statement_timeout).toBe(5000);
    expect(String(pool.options.statement_timeout)).not.toBe("2000");
    void pool.end();
  });
});

interface QuotaLimits {
  perIdentity: number;
  perIp: number;
  windowSeconds: number;
}

const limits: QuotaLimits = { perIdentity: 2, perIp: 3, windowSeconds: 2 };
// The limit checks below assert refusal at the cap, not expiry, so they use
// a window no fast sequence can cross: a 2s window flipping between the last
// two consumes lands the refusal in a fresh window and flakes the gate.
const limitCheckWindow: QuotaLimits = { perIdentity: 2, perIp: 3, windowSeconds: 3600 };

let redis: Redis;

beforeAll(async () => {
  await resetAndMigrate(urlFor("MIGRATION_DATABASE_URL", "velio_test"));
  redis = new Redis(process.env.REDIS_URL as string);
  return () => redis.quit();
});

function identityKey(n: string): string {
  return `rl-test-${Date.now()}-${n}-${Math.random().toString(36).slice(2)}`;
}

describe("consumeBookingQuota", () => {
  it("allows up to the per-identity limit and then raises with a retry delay", async () => {
    const user = identityKey("user");
    // Run-unique IP: a hardcoded one persists in the hour-long Redis window
    // and leaks the cap into later runs (cross-run 429s).
    const ip = identityKey("ip");
    await consumeBookingQuota(redis, { userId: user, ip, limits: limitCheckWindow });
    await consumeBookingQuota(redis, { userId: user, ip, limits: limitCheckWindow });
    await expect(
      consumeBookingQuota(redis, { userId: user, ip, limits: limitCheckWindow }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("applies the per-IP limit across distinct identities", async () => {
    const ip = identityKey("ip");
    await consumeBookingQuota(redis, { userId: identityKey("u1"), ip, limits: limitCheckWindow });
    await consumeBookingQuota(redis, { userId: identityKey("u2"), ip, limits: limitCheckWindow });
    await consumeBookingQuota(redis, { userId: identityKey("u3"), ip, limits: limitCheckWindow });
    await expect(
      consumeBookingQuota(redis, { userId: identityKey("u4"), ip, limits: limitCheckWindow }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("resets after the window elapses", async () => {
    const user = identityKey("window");
    const tiny: QuotaLimits = { perIdentity: 1, perIp: 99, windowSeconds: 1 };
    await consumeBookingQuota(redis, { userId: user, ip: "10.9.9.9", limits: tiny });
    await expect(consumeBookingQuota(redis, { userId: user, ip: "10.9.9.9", limits: tiny })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(consumeBookingQuota(redis, { userId: user, ip: "10.9.9.9", limits: tiny })).resolves.toBeUndefined();
  });

  it("falls back to in-process counting when Redis is unreachable", async () => {
    const dead = new Redis("redis://localhost:1", { commandTimeout: 200, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => {});
    const user = identityKey("fallback");
    await consumeBookingQuota(dead, { userId: user, ip: "10.5.5.5", limits });
    await consumeBookingQuota(dead, { userId: user, ip: "10.5.5.5", limits });
    await expect(consumeBookingQuota(dead, { userId: user, ip: "10.5.5.5", limits })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    dead.disconnect();
  });

  it("preserves identity and IP caps when outage requests use different window lengths", async () => {
    const dead = new Redis("redis://localhost:1", { enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => {});
    const user = identityKey("mixed-window");
    const ip = identityKey("mixed-ip");
    const long = { perIdentity: 1, perIp: 1, windowSeconds: 3600 };
    try {
      await consumeBookingQuota(dead, { userId: user, ip, limits: long });
      await consumeFixedWindowQuota(dead, {
        scope: "invite-resolve", ip: identityKey("resolve"),
        limits: { perIdentity: 1, perIp: 10, windowSeconds: 1 },
      });
      await expect(consumeBookingQuota(dead, { userId: user, ip: identityKey("other"), limits: long }))
        .rejects.toBeInstanceOf(RateLimitError);
      await expect(consumeBookingQuota(dead, { userId: identityKey("other"), ip, limits: long }))
        .rejects.toBeInstanceOf(RateLimitError);
    } finally {
      dead.disconnect();
    }
  });

  it("exposes the seconds until the window resets", async () => {
    const user = identityKey("retry");
    const tiny: QuotaLimits = { perIdentity: 1, perIp: 99, windowSeconds: 30 };
    await consumeBookingQuota(redis, { userId: user, ip: "10.8.8.8", limits: tiny });
    const err = await consumeBookingQuota(redis, { userId: user, ip: "10.8.8.8", limits: tiny }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as RateLimitError).retryAfterSeconds).toBeLessThanOrEqual(30);
  });
});
