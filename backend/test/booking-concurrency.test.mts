import "../src/config.ts"; // loads the repo-root .env into process.env
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createPool } from "../src/db/pool.ts";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

// Quota override disclosure: the concurrency workload releases 50+ identities
// from one loopback IP, so the app under test runs with quotas far above the
// documented defaults. This is deliberate: sold-out and concurrency outcomes
// must never be disguised as 429s. The dedicated quota boundary lives in
// booking-routes.test.mts with a tiny limit instead.
const testConfig: Config = {
  databaseUrl: urlFor("DATABASE_URL", "velio_test"),
  redisUrl: process.env.REDIS_URL as string,
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL as string,
  port: 0,
  readyCheckTimeoutMs: 2000,
  databaseStatementTimeoutMs: 5000,
  // Pool sizing disclosed: the pool is sized above the 50-way burst so every
  // checkout gets a client immediately (pg-pool's waiting queue starves under
  // lock-serialized bursts); recorded per PLANS.md 5.2.
  databasePoolMax: 64,
  databaseConnectTimeoutMs: 10000,
  bookingLockTimeoutMs: 2000,
  bookingStatementTimeoutMs: 5000,
  bookingRateLimitPerIdentity: 500,
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

const app = buildApp(testConfig);
const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");
let base = "";

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no listening address");
  base = `http://127.0.0.1:${address.port}`;
  // The pool must serve overlapping transactions: assert the factory default.
  expect(createPool(appUrl).options.max).toBeGreaterThanOrEqual(2);
  // Warm the pool to full size before the race: lazy connection creation
  // during a 50-request burst starves waiters, which would misreport
  // connection exhaustion as booking failures.
  await Promise.all(Array.from({ length: testConfig.databasePoolMax }, () => fetch(`${base}/readyz`)));
});

afterAll(async () => {
  await app.close();
});

interface Person {
  token: string;
  userId: string;
}

interface BookOutcome {
  status: number;
  code?: string;
  bookingId?: string;
  startedAt: number;
  endedAt: number;
}

async function httpEstablish(displayName: string): Promise<Person> {
  const response = await fetch(`${base}/demo/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `cc-${randomUUID()}@example.test`, displayName }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { session: { token: string }; user: { id: string } };
  return { token: body.session.token, userId: body.user.id };
}

async function httpPublish(token: string, capacity: number): Promise<string> {
  const response = await fetch(`${base}/activities`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: "Concurrency Kayak",
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      country: "GB",
      priceMinorUnits: 1000,
      currency: "EUR",
      spots: capacity,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { activity: { id: string } }).activity.id;
}

async function httpBook(token: string, activityId: string): Promise<BookOutcome> {
  const startedAt = performance.now();
  const response = await fetch(`${base}/activities/${activityId}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ operationId: randomUUID() }),
  });
  const endedAt = performance.now();
  const body = (await response.json()) as {
    created?: boolean;
    booking?: { id: string };
    error?: { code: string };
  };
  return {
    status: response.status,
    code: body.error?.code,
    bookingId: body.booking?.id,
    startedAt,
    endedAt,
  };
}

/** Maximum number of requests that were in flight at the same moment. */
function maxConcurrentInFlight(outcomes: BookOutcome[]): number {
  const events = outcomes
    .flatMap((o) => [
      { time: o.startedAt, delta: 1 },
      { time: o.endedAt, delta: -1 },
    ])
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  let inFlight = 0;
  let max = 0;
  for (const event of events) {
    inFlight += event.delta;
    max = Math.max(max, inFlight);
  }
  return max;
}

async function reconcile(activityId: string): Promise<Record<string, number>> {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `SELECT
           (SELECT booked_count FROM activities WHERE id = $1) AS booked_count,
           (SELECT availability_version FROM activities WHERE id = $1) AS availability_version,
           (SELECT count(*)::int FROM bookings WHERE activity_id = $1) AS booking_rows,
           (SELECT count(*)::int FROM bookings WHERE activity_id = $1 AND plan_id =
              (SELECT id FROM plans WHERE activity_id = $1)) AS plan_members,
           (SELECT count(*)::int FROM booking_attributions ba
              JOIN bookings b ON b.id = ba.booking_id
              WHERE b.activity_id = $1 AND ba.rail = 'direct' AND ba.generation = 0) AS direct_attributions,
           (SELECT count(*)::int FROM events
              WHERE event_name = 'booking_confirmed' AND activity_id = $1) AS confirmed_events`,
        [activityId],
      )
      .then((r) => r.rows[0] as Record<string, number>),
  );
}

describe("booking under concurrent demand over real HTTP", () => {
  let host: Person;
  const people: Person[] = [];

  beforeAll(async () => {
    host = await httpEstablish("Concurrency Host");
    // Release 50 distinct identities through real sockets.
    people.push(...(await Promise.all(Array.from({ length: 50 }, (_, i) => httpEstablish(`Racer ${i}`)))));
  });

  it("gives one spot to exactly one of 50 simultaneous bookers and sells out the rest", async () => {
    const activityId = await httpPublish(host.token, 1);

    const outcomes = await Promise.all(people.map((person) => httpBook(person.token, activityId)));

    const byStatus: Record<string, number> = {};
    for (const o of outcomes) {
      const key = `${o.status}:${o.code ?? "created"}`;
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    console.log("STATUS DISTR:", JSON.stringify(byStatus));
    const created = outcomes.filter((o) => o.status === 201);
    const soldOut = outcomes.filter((o) => o.status === 409 && o.code === "activity_sold_out");
    expect(created).toHaveLength(1);
    expect(soldOut).toHaveLength(49);
    expect(new Set(created.map((o) => o.bookingId)).size).toBe(1);

    // Overlap evidence: the requests genuinely raced (not a serial mock).
    const overlap = maxConcurrentInFlight(outcomes);
    expect(overlap).toBeGreaterThanOrEqual(2);

    // Server-side transaction lifetime spans (PLANS 5.2): occurred_at is the
    // transaction start clock; recordedAt is clock_timestamp() at the attempt
    // record. Overlapping lifetimes prove genuinely concurrent booking
    // transactions — a serial implementation cannot produce overlap.
    const spans = await withClient(migrationUrl, (client) =>
      client
        .query(
          `SELECT occurred_at, details ->> 'recordedAt' AS recorded_at
           FROM events
           WHERE event_name = 'booking_attempted' AND activity_id = $1
             AND details ->> 'outcome' IN ('created', 'sold_out')`,
          [activityId],
        )
        .then((r) =>
          r.rows
            .map((row) => ({
              startedAt: new Date(row.occurred_at).getTime(),
              endedAt: row.recorded_at ? new Date(row.recorded_at).getTime() : Number.NaN,
            }))
            .filter((span) => Number.isFinite(span.startedAt) && Number.isFinite(span.endedAt)),
        ),
    );
    // Every decided transaction was recorded, and each record moment follows
    // its transaction start (no inverted or fabricated spans).
    expect(spans.length).toBeGreaterThanOrEqual(50);
    for (const span of spans) {
      expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt);
    }
    const serverOverlap = maxConcurrentInFlight(spans as unknown as BookOutcome[]);
    expect(serverOverlap).toBeGreaterThanOrEqual(2);

    const state = await reconcile(activityId);
    expect(state).toMatchObject({
      booked_count: 1,
      booking_rows: 1,
      plan_members: 1,
      direct_attributions: 1,
      confirmed_events: 1,
    });

    writeFileSync(
      "/tmp/velio-ticket-4-concurrency.json",
      JSON.stringify(
        {
          scenario: "50 identities, 1 remaining spot, real sockets",
          poolMax: testConfig.databasePoolMax,
          quotaOverride: { perIdentity: 500, perIp: 10000, windowSeconds: 3600 },
          created: created.length,
          soldOut: soldOut.length,
          maxConcurrentInFlight: overlap,
          maxConcurrentServerTransactionLifetimes: serverOverlap,
          requests: people.map((person, i) => ({
            identity: person.userId,
            status: outcomes[i]?.status ?? 0,
            code: outcomes[i]?.code ?? "missing",
            startedAt: outcomes[i]?.startedAt ?? 0,
            endedAt: outcomes[i]?.endedAt ?? 0,
          })),
        },
        null,
        2,
      ),
    );
  }, 60_000);

  it("splits five spots cleanly among 50 simultaneous bookers", async () => {
    const activityId = await httpPublish(host.token, 5);

    const outcomes = await Promise.all(people.map((person) => httpBook(person.token, activityId)));

    const created = outcomes.filter((o) => o.status === 201);
    const soldOut = outcomes.filter((o) => o.status === 409);
    expect(created).toHaveLength(5);
    expect(soldOut).toHaveLength(45);
    expect(new Set(created.map((o) => o.bookingId)).size).toBe(5);

    const state = await reconcile(activityId);
    expect(state).toMatchObject({
      booked_count: 5,
      booking_rows: 5,
      plan_members: 5,
      direct_attributions: 5,
      confirmed_events: 5,
    });
    expect(state.availability_version).toBe("6");
  }, 60_000);

  it("collapses a same-identity race onto one booking", async () => {
    const racer = await httpEstablish("Impatient Racer");
    const activityId = await httpPublish(host.token, 5);
    const operationId = randomUUID();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => httpBook(racer.token, activityId)),
    );
    const created = outcomes.filter((o) => o.status === 201);
    const replays = outcomes.filter((o) => o.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(7);
    const bookingIds = new Set(outcomes.map((o) => o.bookingId));
    expect(bookingIds.size).toBe(1);

    const state = await reconcile(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, confirmed_events: 1 });
  }, 60_000);
});
