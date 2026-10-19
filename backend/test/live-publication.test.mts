import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RedisStallProxy } from "./support/stall-proxy.mts";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { bookActivity, type BookingDeps } from "../src/booking/service.ts";
import { createLivePublication } from "../src/live/publication.js";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let redis: Redis;
let activities: ActivitiesDeps;
let host: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  activities = { pool, experiment: { allocationPercent: 50, experimentVersion: "t9" } };
  host = (
    await establishIdentity(
      { pool, sessionTtlHours: 12 },
      { contactKey: uniqueContact("live-host"), displayName: "Live Host" },
    )
  ).user;
  return () => {
    redis.quit();
    return pool.end();
  };
});

function uniqueContact(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueIp(): string {
  return `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${Math.floor(Math.random() * 250)}`;
}

function bookingDeps(live?: BookingDeps["live"]): BookingDeps {
  return {
    pool,
    redis,
    quota: { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 },
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    live,
  };
}

async function newPerson(displayName: string): Promise<UserSnapshot> {
  return (
    await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueContact("p"), displayName })
  ).user;
}

async function publishTreatment(title: string): Promise<string> {
  const published = await publishActivity(activities, host, { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title,
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    timezone: "UTC",
    priceMinorUnits: 1000,
    currency: "EUR",
    spots: 5,
  });
  return published.activity.id;
}

interface LiveMessage {
  payload: Record<string, unknown>;
}

async function waitForMessage(redisUrl: string, channel: string, timeoutMs: number): Promise<LiveMessage | null> {
  const listener = new Redis(redisUrl);
  listener.on("error", () => {});
  const done = new Promise<LiveMessage | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
    listener.on("message", (_channel, payload) => {
      clearTimeout(timer);
      resolve({ payload: JSON.parse(payload) });
    });
  });
  await listener.subscribe(channel);
  const result = await done;
  await listener.quit();
  return result;
}

describe("live availability publication", () => {
  it("publishes the committed version, remaining spots and event id after commit", async () => {
    const activityId = await publishTreatment("Live Success");
    const channel = `velio-local:availability`;
    const received = waitForMessage(process.env.REDIS_URL as string, channel, 5000);
    const publication = createLivePublication(redis, "velio-local", 500);
    const guest = await newPerson("Live Guest");

    const result = await bookActivity(bookingDeps({ publishAvailability: (u) => publication.publishAvailability(u) }), guest, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
    });
    expect(result.created).toBe(true);

    const message = await received;
    expect(message).not.toBeNull();
    expect(message!.payload).toMatchObject({
      activityId,
      version: result.availabilityVersion,
      remainingSpots: 4,
    });
    // The published event id is the committed event's id, not an invention.
    const committed = await withClient(migrationUrl, (client) =>
      client.query("SELECT event_id FROM events WHERE event_name = 'booking_confirmed' AND booking_id = $1", [
        result.booking.id,
      ]),
    );
    expect(message!.payload.eventId).toBe(committed.rows[0].event_id);
    expect(publication.stats).toMatchObject({ attempts: 1, published: 1, failures: 0 });
  });

  it("never publishes for a replay", async () => {
    const activityId = await publishTreatment("Live Replay");
    const publication = createLivePublication(redis, "velio-local", 500);
    const guest = await newPerson("Replay Live Guest");
    const operationId = randomUUID();
    const deps = bookingDeps({ publishAvailability: (u) => publication.publishAvailability(u) });
    const first = await bookActivity(deps, guest, activityId, { ip: uniqueIp(), operationId });
    expect(first.created).toBe(true);
    // Give any erroneous second publication a fair window, then count.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replay = await bookActivity(deps, guest, activityId, { ip: uniqueIp(), operationId });
    expect(replay.created).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(publication.stats.attempts).toBe(1);
  });

  it("keeps the committed booking when Redis refuses publication", async () => {
    // A connection pointed at a closed port: every publish errors fast.
    const deadRedis = new Redis({ host: "127.0.0.1", port: 1, commandTimeout: 200, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    deadRedis.on("error", () => {});
    const publication = createLivePublication(deadRedis, "velio-local", 300);
    const activityId = await publishTreatment("Live Refused");
    const guest = await newPerson("Refused Guest");
    const started = Date.now();
    const result = await bookActivity(bookingDeps({ publishAvailability: (u) => publication.publishAvailability(u) }), guest, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
    });
    expect(result.created).toBe(true); // booking_failed would be a defect
    expect(Date.now() - started).toBeLessThan(2000);
    expect(publication.stats).toMatchObject({ attempts: 1, failures: 1 });
    const state = await withClient(migrationUrl, (client) =>
      client.query("SELECT booked_count, availability_version FROM activities WHERE id = $1", [activityId]),
    );
    expect(state.rows[0]).toMatchObject({ booked_count: 1, availability_version: result.availabilityVersion });
    await deadRedis.disconnect();
  });

  it("resolves within the finite budget when Redis stalls", async () => {
    const proxy = new RedisStallProxy(6391, Number(new URL(process.env.REDIS_URL!).port || 6379));
    await proxy.listen();
    const stalledRedis = new Redis({ host: "127.0.0.1", port: 6391, commandTimeout: 2000, enableOfflineQueue: false });
    stalledRedis.on("error", () => {});
    await new Promise((resolve) => stalledRedis.once("ready", resolve));
    const held = proxy.holdPublications();
    const publication = createLivePublication(stalledRedis, "velio-local", 300);
    const activityId = await publishTreatment("Live Stalled");
    const guest = await newPerson("Stalled Guest");
    try {
      const started = Date.now();
      const booking = bookActivity(bookingDeps(publication), guest, activityId, {
        ip: uniqueIp(), operationId: randomUUID(),
      });
      await held; // a connected Redis command really is pending, not refused offline
      const result = await booking;
      expect(result.created).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(publication.stats).toMatchObject({ attempts: 1, failures: 1 });
      const failures = await withClient(migrationUrl, (client) => client.query(
        "SELECT count(*)::int AS n FROM events WHERE activity_id = $1 AND event_name = 'booking_failed'", [activityId],
      ));
      expect(failures.rows[0].n).toBe(0);
    } finally {
      stalledRedis.disconnect();
      await proxy.close();
    }
  });

  it("releases the booking transaction before publication runs", async () => {
    // A publication that stalls well past any lock wait: a second booking on
    // the same activity must complete while the first publication is pending,
    // proving the row lock was released before Redis was called.
    const activityId = await publishTreatment("Live Lock Release");
    const slow = createLivePublication(redis, "velio-local", 500);
    const slowDeps = bookingDeps({
      publishAvailability: (u) => new Promise<void>((resolve) => setTimeout(() => { void u; resolve(); }, 1500)),
    });
    const first = await newPerson("Slow Publish Guest");
    const second = await newPerson("Fast Guest");
    const firstBooking = bookActivity(slowDeps, first, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // first is inside its stalled publication
    const secondStarted = Date.now();
    const secondResult = await bookActivity(bookingDeps(), second, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
    });
    const secondElapsed = Date.now() - secondStarted;
    expect(secondResult.created).toBe(true);
    expect(secondElapsed).toBeLessThan(1500);
    const firstResult = await firstBooking;
    expect(firstResult.created).toBe(true);
    void slow;
  });
});
