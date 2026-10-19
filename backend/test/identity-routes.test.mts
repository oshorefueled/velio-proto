import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  const config: Config = {
    databaseUrl: appUrl,
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
  };
  app = buildApp(config);
  return () => app.close();
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function establish(contactKey: string, displayName?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/demo/sessions",
    payload: displayName === undefined ? { email: (contactKey) + "@example.test" } : { email: (contactKey) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("POST /demo/sessions", () => {
  it("establishes a new person with direct acquisition", async () => {
    const key = uniqueKey("routes-create");
    const response = await app.inject({
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (key) + "@example.test", displayName: "New Person" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toBe(true);
    expect(body.user).toMatchObject({
      email: key + "@example.test",
      displayName: "New Person",
      signupSource: "direct",
      signupGeneration: 0,
    });
    expect(body.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof body.session.expiresAt).toBe("string");
  });

  it("resumes the same person for an existing contact key", async () => {
    const key = uniqueKey("routes-resume");
    const first = await establish(key, "First");
    const second = await establish(key, "Ignored");

    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe("First");
    expect(second.session.token).not.toBe(first.session.token);
  });

  it("returns 400 validation_error for invalid establishment input", async () => {
    const missingKey = await app.inject({ method: "POST", url: "/demo/sessions", payload: {} });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("validation_error");


  });
});

describe("GET /demo/me", () => {
  it("round-trips a session token to the established person", async () => {
    const key = uniqueKey("routes-me");
    const established = await establish(key, "Me Trip");
    const response = await app.inject({
      method: "GET",
      url: "/demo/me",
      headers: { authorization: `Bearer ${established.session.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(established.user.id);
  });

  it("derives the actor from the session, never from a supplied user id", async () => {
    const keyA = uniqueKey("routes-actor-a");
    const keyB = uniqueKey("routes-actor-b");
    const personA = await establish(keyA, "Person A");
    const personB = await establish(keyB, "Person B");

    const response = await app.inject({
      method: "GET",
      url: `/demo/me?userId=${personB.user.id}`,
      headers: { authorization: `Bearer ${personA.session.token}` },
      payload: { userId: personB.user.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(personA.user.id);
    expect(response.json().user.id).not.toBe(personB.user.id);
  });

  it("reports infrastructure failure through the machine-readable envelope", async () => {
    const brokenApp = buildApp({
      databaseUrl: urlFor("DATABASE_URL", "does_not_exist"),
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
    });
    const response = await brokenApp.inject({
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (uniqueKey("routes-server-error")) + "@example.test", displayName: "X" },
    });
    await brokenApp.close();

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("server_error");
  });

  it("keeps malformed request bodies a client error, not a server failure", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/demo/sessions",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("distinguishes missing, invalid, and expired sessions", async () => {
    const noHeader = await app.inject({ method: "GET", url: "/demo/me" });
    expect(noHeader.statusCode).toBe(401);
    expect(noHeader.json().error.code).toBe("session_required");

    const wrongScheme = await app.inject({
      method: "GET",
      url: "/demo/me",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(wrongScheme.statusCode).toBe(401);
    expect(wrongScheme.json().error.code).toBe("session_required");

    const unknown = await app.inject({
      method: "GET",
      url: "/demo/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe("session_invalid");

    const key = uniqueKey("routes-expired");
    const established = await establish(key, "Expiring");
    await withClient(migrationUrl, async (client) => {
      // Shift the whole session into the past, preserving the born-valid CHECK.
      await client.query(
        "UPDATE demo_sessions SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1",
        [established.user.id],
      );
    });
    const expired = await app.inject({
      method: "GET",
      url: "/demo/me",
      headers: { authorization: `Bearer ${established.session.token}` },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("session_expired");

    // Re-establishing after expiry resolves the same person, never a silent replacement.
    const again = await establish(key);
    expect(again.user.id).toBe(established.user.id);
  });
});
