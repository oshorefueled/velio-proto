import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

function configWith(overrides: Partial<Config> = {}): Config {
  return {
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
    bookingRateLimitPerIp: 10000,
    bookingRateWindowSeconds: 3600,
    demoSessionTtlHours: 12,
    logLevel: "silent",
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
    ...overrides,
  };
}

// Three servers over one database, each with a forced allocation or switch
// state, so the HTTP contract is pinned for both arms and the kill switch
// without mocking randomness.
let treatmentApp: Awaited<ReturnType<typeof buildApp>>;
let controlApp: Awaited<ReturnType<typeof buildApp>>;
let switchedOffApp: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  treatmentApp = buildApp(configWith({ experimentTreatmentAllocationPercent: 100 }));
  controlApp = buildApp(configWith({ experimentTreatmentAllocationPercent: 0 }));
  switchedOffApp = buildApp(configWith({ experimentTreatmentAllocationPercent: 100, experimentInviteCreationEnabled: false }));
  return () =>
    Promise.all([treatmentApp.close(), controlApp.close(), switchedOffApp.close()]);
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function establish(app: App, displayName: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (uniqueKey("exp-route")) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  return response.json().session.token;
}

async function publish(app: App, token: string, title: string): Promise<{ id: string; experiment: unknown }> {
  const response = await app.inject({
    method: "POST",
    url: "/activities",
    headers: { authorization: `Bearer ${token}` },
    payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      country: "GB",
      priceMinorUnits: 2500,
      currency: "EUR",
      spots: 5,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { id: body.activity.id, experiment: body.experiment };
}

async function detail(app: App, activityId: string, token?: string): Promise<{ invites: unknown; activity: { id: string } }> {
  const response = await app.inject({
    method: "GET",
    url: `/activities/${activityId}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe("invite capability over HTTP", () => {
  it("reports the saved assignment at publish and shows every viewer the same stable capability", async () => {
    const host = await establish(treatmentApp, "Treatment Host");
    const published = await publish(treatmentApp, host, "Route Treatment");
    expect(published.experiment).toEqual({ arm: "treatment", experimentVersion: "test-rollout" });

    const anonymous = await detail(treatmentApp, published.id);
    expect(anonymous.invites).toEqual({
      eligible: true,
      canCreateInvites: true,
      creationEnabled: true,
      arm: "treatment",
      experimentVersion: "test-rollout",
    });

    // A different person's session sees the identical saved arm and version.
    const other = await establish(treatmentApp, "Other Viewer");
    const asOther = await detail(treatmentApp, published.id, other);
    expect(asOther.invites).toEqual(anonymous.invites);
  });

  it("keeps ordinary booking working in control", async () => {
    const host = await establish(controlApp, "Control Host");
    const published = await publish(controlApp, host, "Route Control");
    const viewer = await detail(controlApp, published.id);
    expect(viewer.invites).toMatchObject({ eligible: true, canCreateInvites: false, arm: "control" });

    const booked = await controlApp.inject({
      method: "POST",
      url: `/activities/${published.id}/bookings`,
      headers: { authorization: `Bearer ${host}` },
      payload: { operationId: randomUUID() },
    });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().created).toBe(true);
  });

  it("exposes the kill switch as no creation capability while keeping the saved arm", async () => {
    const host = await establish(switchedOffApp, "Switched Off Host");
    const published = await publish(switchedOffApp, host, "Route Switched Off");
    const viewer = await detail(switchedOffApp, published.id);
    expect(viewer.invites).toEqual({
      eligible: true,
      canCreateInvites: false,
      creationEnabled: false,
      arm: "treatment",
      experimentVersion: "test-rollout",
    });
  });
});
