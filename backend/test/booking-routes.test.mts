import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let app: Awaited<ReturnType<typeof buildApp>>;

// Quota override disclosed: these route tests exercise the 429 boundary with
// a tiny identity limit; the concurrency suite overrides limits upward.
const testConfig: Config = {
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
  bookingRateLimitPerIdentity: 2,
  bookingRateLimitPerIp: 10000,
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

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  app = buildApp(testConfig);
  return () => app.close();
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function establish(displayName: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (uniqueKey("bk4-route")) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  return response.json().session.token;
}

async function publish(token: string, capacity: number): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/activities",
    headers: { authorization: `Bearer ${token}` },
    payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: "Route Kayak",
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      country: "GB",
      priceMinorUnits: 2500,
      currency: "EUR",
      spots: capacity,
    },
  });
  if (response.statusCode !== 201) console.log("PUBLISH FAIL:", response.statusCode, response.body);
  expect(response.statusCode).toBe(201);
  return response.json().activity.id;
}

async function book(token: string, activityId: string, operationId: string = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/activities/${activityId}/bookings`,
    headers: { authorization: `Bearer ${token}` },
    payload: { operationId },
  });
}

describe("POST /activities/:id/bookings", () => {
  it("confirms a spot for the session person", async () => {
    const token = await establish("Route Booker");
    const activityId = await publish(token, 3);
    const response = await book(token, activityId);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.created).toBe(true);
    expect(body.availabilityVersion).toBe("2");
    expect(body.booking).toMatchObject({
      activityId,
      userId: expect.any(String),
      attribution: { rail: "direct", generation: 0 },
    });
    expect(body.booking.planId).toBeTruthy();
  });

  it("returns the same booking for a retried operation without a new seat", async () => {
    const token = await establish("Retry Booker");
    const activityId = await publish(token, 2);
    const operationId = randomUUID();
    const first = await book(token, activityId, operationId);
    const retry = await book(token, activityId, operationId);

    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().created).toBe(false);
    expect(retry.json().booking.id).toBe(first.json().booking.id);
  });

  it("rejects sold-out with a machine-readable conflict", async () => {
    const host = await establish("Sold-Out Host");
    const first = await establish("Sold-Out Taker");
    const second = await establish("Sold-Out Loser");
    const activityId = await publish(host, 1);

    await book(first, activityId);
    const response = await book(second, activityId);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("activity_sold_out");
  });

  it("refuses a new booking after the activity started", async () => {
    const host = await establish("Started Host");
    const late = await establish("Late Comer");
    const activityId = await publish(host, 3);
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [activityId]),
    );

    const response = await book(late, activityId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("activity_started");
  });

  it("requires a stable operation id", async () => {
    const token = await establish("Operation Host");
    const activityId = await publish(token, 2);
    const response = await book(token, activityId, "");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("requires a session", async () => {
    const host = await establish("No-Session Host");
    const activityId = await publish(host, 2);
    const response = await app.inject({
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      payload: { operationId: randomUUID() },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_required");
  });

  it("reports unknown and malformed activity ids as not found when booking", async () => {
    const token = await establish("Not Found Booker");
    for (const activityId of ["00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
      const response = await book(token, activityId);
      expect(response.statusCode, activityId).toBe(404);
      expect(response.json().error.code, activityId).toBe("activity_not_found");
    }
    const me = await app.inject({
      method: "GET",
      url: "/activities/not-a-uuid/bookings/me",
      headers: { authorization: `Bearer ${token}` },
    });
    // The booking lookup has nothing to find for an unknown activity.
    expect(me.statusCode).toBe(404);
    expect(me.json().error.code).toBe("booking_not_found");
  });

  it("applies the identity quota boundary: allowed, allowed, then 429 with Retry-After", async () => {
    const token = await establish("Quota Booker");
    const first = await establish("Quota Target Host");
    const second = await establish("Quota Second Host");

    const allowed1 = await book(token, await publish(first, 1));
    const allowed2 = await book(token, await publish(second, 1));
    expect(allowed1.statusCode).toBe(201);
    expect(allowed2.statusCode).toBe(201);

    const third = await book(token, await publish(first, 1));
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("request_limit");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("GET /activities/:id/bookings/me", () => {
  it("returns the session person's committed booking", async () => {
    const token = await establish("Lookup Booker");
    const activityId = await publish(token, 2);
    const booked = await book(token, activityId);

    const response = await app.inject({
      method: "GET",
      url: `/activities/${activityId}/bookings/me`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.id).toBe(booked.json().booking.id);
  });

  it("shows the owning host the real confirmed bookers with names, and keeps others out", async () => {
    const host = await establish("Participants Host");
    const booker = await establish("Visible Booker");
    const outsider = await establish("Participants Outsider");
    const activityId = await publish(host, 3);
    const booked = await book(booker, activityId);
    expect(booked.statusCode).toBe(201);
    const bookerUserId = booked.json().booking.userId;

    const ownerView = await app.inject({
      method: "GET",
      url: `/activities/${activityId}/participants`,
      headers: { authorization: `Bearer ${host}` },
    });
    expect(ownerView.statusCode).toBe(200);
    const body = ownerView.json();
    expect(body.confirmedCount).toBe(1);
    expect(body.participants).toEqual([
      {
        userId: bookerUserId,
        bookingId: booked.json().booking.id,
        displayName: "Visible Booker",
        maskedEmail: "b***@example.test",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("bk4-route");

    const foreign = await app.inject({
      method: "GET",
      url: `/activities/${activityId}/participants`,
      headers: { authorization: `Bearer ${outsider}` },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("forbidden");

    // Public payloads still never carry participant names.
    const detail = await app.inject({ method: "GET", url: `/activities/${activityId}` });
    expect(JSON.stringify(detail.json())).not.toContain("Visible Booker");
  });

  it("reports no booking as booking_not_found", async () => {
    const token = await establish("Empty Lookup");
    const host = await establish("Unrelated Host");
    const activityId = await publish(host, 2);

    const response = await app.inject({
      method: "GET",
      url: `/activities/${activityId}/bookings/me`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("booking_not_found");
  });
});
