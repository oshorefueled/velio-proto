import "../src/config.ts"; // loads the repo-root .env into process.env
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { checkPostgres } from "../src/routes/readyz.ts";

// Port 1 refuses connections immediately, so dead-dependency tests stay fast.
const DEAD_HOST = "localhost:1";
const live = {
  databaseUrl: process.env.DATABASE_URL as string,
  redisUrl: process.env.REDIS_URL as string,
};

function configWith(overrides: { databaseUrl?: string; redisUrl?: string }): Config {
  return {
    databaseUrl: process.env.DATABASE_URL as string,
    redisUrl: process.env.REDIS_URL as string,
    migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL as string,
    port: 0,
    readyCheckTimeoutMs: 500,
    databasePoolMax: 10,
    databaseConnectTimeoutMs: 5000,
    databaseStatementTimeoutMs: 5000,
    bookingLockTimeoutMs: 2000,
    bookingStatementTimeoutMs: 5000,
    bookingRateLimitPerIdentity: 30,
    bookingRateLimitPerIp: 120,
    bookingRateWindowSeconds: 3600,
    demoSessionTtlHours: 12,
    experimentVersion: "test-rollout",
    experimentTreatmentAllocationPercent: 50,
    experimentInviteCreationEnabled: true,
    inviteExpiryHours: 336,
    inviteRateLimitPerIdentity: 10,
    inviteRateLimitPerIp: 60,
    inviteResolveRateLimitPerIp: 120,
    inviteRateWindowSeconds: 3600,
    clientEventRateLimitPerIp: 240,
    clientEventRateWindowSeconds: 3600,
    liveLeaseSeconds: 30,
    availabilityAckRateLimitPerIp: 240,
    availabilityAckRateWindowSeconds: 3600,
    livePublishTimeoutMs: 500,
    liveChannelPrefix: "test-live",
    logLevel: "silent",
    ...overrides,
  };
}

describe("GET /readyz", () => {
  it("reports ok when PostgreSQL and Redis both answer", async () => {
    const app = buildApp(configWith({}));
    const response = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: { postgres: { status: "ok" }, redis: { status: "ok" } },
    });
  });

  it("reports unavailable when Redis is unreachable, without hiding PostgreSQL health", async () => {
    const app = buildApp(configWith({ redisUrl: `redis://${DEAD_HOST}` }));
    const response = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.checks.redis.status).toBe("error");
    expect(body.checks.postgres.status).toBe("ok");
  });

  it("reports unavailable when PostgreSQL is unreachable, without hiding Redis health", async () => {
    const app = buildApp(configWith({ databaseUrl: `postgres://velio_app:pw@${DEAD_HOST}/velio` }));
    const response = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.checks.postgres.status).toBe("error");
    expect(body.checks.redis.status).toBe("ok");
  });

  it("never reports overall ok when any check failed", async () => {
    const app = buildApp(
      configWith({
        databaseUrl: `postgres://velio_app:pw@${DEAD_HOST}/velio`,
        redisUrl: `redis://${DEAD_HOST}`,
      }),
    );
    const response = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.checks.postgres.status).toBe("error");
    expect(body.checks.redis.status).toBe("error");
  });

  it("uses the live development stack from the environment", async () => {
    const app = buildApp(configWith(live));
    const response = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });
});

describe("checkPostgres deadline", () => {
  it("reports an error within the budget when a pooled query never answers", async () => {
    // A silently frozen connection (paused container, lost partition) never
    // resolves and never errors; the client-side deadline must bound it.
    const hangingPool = { query: () => new Promise<never>(() => {}) } as unknown as Pool;
    const startedAt = Date.now();

    const result = await checkPostgres(hangingPool, 200);

    expect(result).toEqual({
      status: "error",
      error: "PostgreSQL did not answer within 200ms",
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
