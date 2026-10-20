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

async function establishHost(displayName: string): Promise<{ token: string; userId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (uniqueKey("act3-host")) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return { token: body.session.token, userId: body.user.id };
}

interface PublishedActivity {
  activity: { id: string; hostId: string; [key: string]: unknown };
  plan: { id: string };
}

async function publish(
  token: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<PublishedActivity> {
  const response = await app.inject({
    method: "POST",
    url: "/activities",
    headers: { authorization: `Bearer ${token}` },
    payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: "Sunset Kayaking",
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      timezone: "Europe/Berlin",
      priceMinorUnits: 4500,
      currency: "EUR",
      spots: 6,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe("POST /activities", () => {
  it.each([
    ["spots at the PostgreSQL integer maximum", { spots: 2147483647 }, (activity: { capacity: unknown }) => expect(activity.capacity).toBe(2147483647)],
    ["price at the safe-integer maximum", { priceMinorUnits: Number.MAX_SAFE_INTEGER }, (activity: { priceMinorUnits: unknown }) => expect(activity.priceMinorUnits).toBe(Number.MAX_SAFE_INTEGER)],
    ["a positive UTC offset instant", { startsAt: "2030-05-01T09:30:00+05:30" }, (activity: { startsAt: string }) => expect(activity.startsAt).toBe("2030-05-01T04:00:00.000Z")],
    ["a real leap day", { startsAt: "2028-02-29T10:00:00Z" }, (activity: { startsAt: string }) => expect(activity.startsAt).toBe("2028-02-29T10:00:00.000Z")],
  ])("accepts %s at the boundary", async (_label, overrides, assertActivity) => {
    const host = await establishHost("Boundary Host");
    const response = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Boundary",
        startsAt: "2099-01-01T10:00:00Z",
        endsAt: "2099-01-01T12:00:00Z",
        timezone: "UTC",
        priceMinorUnits: 100,
        currency: "USD",
        spots: 2,
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    assertActivity(response.json().activity);
  });

  it.each([
    ["spots", 2147483648],
    ["priceMinorUnits", 1e30],
    ["priceMinorUnits", Number.MAX_SAFE_INTEGER + 1],
    ["currency", "ZZZ"],
    ["startsAt", "2099-01-01T10:00:00"],
    ["startsAt", "2099-02-30T10:00:00Z"],
    ["startsAt", "2099-01-01"],
    ["endsAt", "2099-01-01T10:00:00Z"],
    ["endsAt", "2099-01-01T09:00:00Z"],
    ["endsAt", "2099-01-01"],
    ["country", "US"],
  ])("when %s is %s, returns a field error without publishing", async (field, value) => {
    const host = await establishHost("Validation Host");
    const before = await app.inject({ method: "GET", url: "/activities" }).then((r) => r.json().activities.length);
    const response = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Validation",
        startsAt: "2099-01-01T10:00:00Z",
        endsAt: "2099-01-01T12:00:00Z",
        timezone: "UTC",
        priceMinorUnits: 100,
        currency: "USD",
        spots: 2,
        [field as string]: value,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    expect(response.json().error.fields).toHaveProperty(field as string);
    const after = await app.inject({ method: "GET", url: "/activities" }).then((r) => r.json().activities.length);
    expect(after).toBe(before);
  });

  it("publishes from the session host and returns the activity with its unique plan", async () => {
    const host = await establishHost("Publisher Ada");
    const result = await publish(host.token);

    expect(result.activity).toMatchObject({
      hostId: host.userId,
      title: "Sunset Kayaking",
      timezone: "Europe/Berlin",
      priceMinorUnits: 4500,
      currency: "EUR",
      capacity: 6,
      bookedCount: 0,
      remainingSpots: 6,
      availabilityVersion: "1",
    });
    expect(result.plan.id).toBeTruthy();
  });

  it("requires a session to publish", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/activities",
      payload: { title: "Anonymous" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_required");
  });

  it("keeps other client faults their own status inside the error envelope", async () => {
    const host = await establishHost("Content Type Host");
    // text/plain is parsed by default (leading to domain validation); an
    // unparsed content type is Fastify's own 415 client fault.
    const response = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/octet-stream" },
      payload: "raw bytes",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("returns field-specific reasons without publishing", async () => {
    const host = await establishHost("Failing Publisher");
    const before = await app.inject({ method: "GET", url: "/activities" }).then((r) => r.json().activities.length);

    const response = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "",
        startsAt: "not-a-date",
        endsAt: "not-a-date",
        timezone: "Mars/Olympus",
        priceMinorUnits: -5,
        currency: "eur",
        spots: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("validation_error");
    expect(Object.keys(body.error.fields).sort()).toEqual([
      "currency",
      "endsAt",
      "priceMinorUnits",
      "spots",
      "startsAt",
      "timezone",
      "title",
    ]);

    const after = await app.inject({ method: "GET", url: "/activities" }).then((r) => r.json().activities.length);
    expect(after).toBe(before);
  });
});

describe("public browse and detail", () => {
  it("lets anyone browse and inspect without an identity, with no participant names", async () => {
    const host = await establishHost("Public Host");
    const published = await publish(host.token, { title: "Browseable" });

    const list = await app.inject({ method: "GET", url: "/activities" });
    expect(list.statusCode).toBe(200);
    const view = list.json().activities.find((a: { id: string }) => a.id === published.activity.id);
    expect(view).toMatchObject({
      title: "Browseable",
      hostDisplayName: "Public Host",
      remainingSpots: 6,
      availabilityVersion: "1",
      started: false,
    });
    expect(JSON.stringify(view)).not.toContain("participant");

    const detail = await app.inject({ method: "GET", url: `/activities/${published.activity.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().activity).toMatchObject({ planId: published.plan.id, started: false, hostId: host.userId });
    expect(JSON.stringify(detail.json())).not.toContain("participant");
  });

  it("reports unknown activities as activity_not_found", async () => {
    const response = await app.inject({ method: "GET", url: "/activities/00000000-0000-0000-0000-000000000000" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("activity_not_found");
  });

  it("reports malformed activity ids as not found, not as server errors", async () => {
    const detail = await app.inject({ method: "GET", url: "/activities/not-a-uuid" });
    expect(detail.statusCode).toBe(404);
    expect(detail.json().error.code).toBe("activity_not_found");
  });
});

describe("host workspace", () => {
  it("lists only the session host's own activities", async () => {
    const owner = await establishHost("Workspace Owner");
    const outsider = await establishHost("Workspace Outsider");
    const mine = await publish(owner.token, { title: "Mine Only" });

    const own = await app.inject({
      method: "GET",
      url: "/my/activities",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().activities.find((a: { id: string }) => a.id === mine.activity.id)).toMatchObject({
      title: "Mine Only",
      confirmedCount: 0,
      hostId: owner.userId,
    });

    const foreign = await app.inject({
      method: "GET",
      url: "/my/activities",
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().activities.find((a: { id: string }) => a.id === mine.activity.id)).toBeUndefined();
  });

  it("requires a session for the host workspace listing", async () => {
    const response = await app.inject({ method: "GET", url: "/my/activities" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_required");
  });
});

describe("participant inspection", () => {
  it("lets the owning host inspect their plan with zero confirmed participants so far", async () => {
    const owner = await establishHost("Inspecting Owner");
    const published = await publish(owner.token);

    const response = await app.inject({
      method: "GET",
      url: `/activities/${published.activity.id}/participants`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activityId: published.activity.id,
      planId: published.plan.id,
      confirmedCount: 0,
      participants: [],
    });
  });

  it("refuses a non-owning host with forbidden", async () => {
    const owner = await establishHost("Real Owner");
    const stranger = await establishHost("Stranger Host");
    const published = await publish(owner.token);

    const response = await app.inject({
      method: "GET",
      url: `/activities/${published.activity.id}/participants`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  it("requires a session for participant inspection", async () => {
    const owner = await establishHost("Session Check Owner");
    const published = await publish(owner.token);

    const response = await app.inject({
      method: "GET",
      url: `/activities/${published.activity.id}/participants`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("session_required");
  });
});

describe("scope boundaries", () => {
  it("offers no editing or cancellation routes", async () => {
    const owner = await establishHost("Boundary Owner");
    const published = await publish(owner.token);

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/activities/${published.activity.id}`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { title: "Edited" },
      });
      expect(response.statusCode, `${method} /activities/:id`).toBe(404);
    }
  });
});
