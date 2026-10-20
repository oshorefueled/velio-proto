import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { registerMeasurementConnection, refreshInstanceLeases } from "../src/live/presence.js";
import { createLivePublication } from "../src/live/publication.js";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";
import type { InjectOptions, Response as LightInjectResponse } from "light-my-request";

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
    demoSessionTtlHours: 12,
    logLevel: "silent",
    experimentVersion: "test-rollout",
    experimentTreatmentAllocationPercent: 100,
    experimentInviteCreationEnabled: true,
    inviteExpiryHours: 336,
    liveLeaseSeconds: 30,
    livePublishTimeoutMs: 500,
    liveChannelPrefix: "test-live",
    ...overrides,
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl = "";

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  app = buildApp(configWith({}));
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return () => app.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

let callCounter = 0;

/** Fresh source IP per request. */
function nextInject(target: App, options: InjectOptions): Promise<LightInjectResponse> {
  callCounter += 1;
  return target.inject({
    remoteAddress: `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${callCounter % 250}`,
    ...options,
  });
}

async function establish(displayName: string): Promise<{ token: string; userId: string }> {
  const response = await nextInject(app, {
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (`metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return { token: body.session.token, userId: body.user.id };
}

async function publishActivity(token: string, title: string, spots = 5): Promise<string> {
  const response = await nextInject(app, {
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
      spots,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().activity.id;
}

async function book(token: string, activityId: string, overrides: object = {}): Promise<LightInjectResponse> {
  return nextInject(app, {
    method: "POST",
    url: `/activities/${activityId}/bookings`,
    headers: { authorization: `Bearer ${token}` },
    payload: { operationId: randomUUID(), ...overrides },
  });
}

/**
 * Measurement scenarios assert on global metric counts, so each starts from
 * an empty measurement domain (the migration role may erase this technical
 * evidence between scenarios; the application role never can).
 */
async function resetMeasurements(): Promise<void> {
  await withClient(migrationUrl, async (client) => {
    await client.query("DELETE FROM availability_measurements");
    await client.query("DELETE FROM live_presence");
    await client.query("DELETE FROM live_connections");
  });
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

function collect(socket: WebSocket, predicate: (frame: Frame) => boolean, timeoutMs: number) {
  const frames: Frame[] = [];
  let settled = false;
  const done = new Promise<Frame[]>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(frames);
      }
    }, timeoutMs);
    timer.unref();
    socket.on("message", (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as Frame;
      frames.push(frame);
      if (!settled && predicate(frame)) {
        settled = true;
        clearTimeout(timer);
        resolve(frames);
      }
    });
  });
  return { frames, done };
}

interface RegisteredViewer {
  socket: WebSocket;
  connectionId: string;
  activityId: string;
}

/** Real socket: subscribe, opt into measurement, await both server acks. */
async function registerViewer(activityId: string, visible = true, previousConnectionId?: string): Promise<RegisteredViewer> {
  const socket = new WebSocket(`${baseUrl}/live`);
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "subscribe", activityId }));
  const subscribed = collect(socket, (f) => f.type === "subscribed", 2000);
  socket.send(JSON.stringify({ type: "register_measurement", visible, ...(previousConnectionId ? { previousConnectionId } : {}) }));
  const registered = collect(socket, (f) => f.type === "measurement_registered", 2000);
  const [subscribedFrames] = await Promise.all([subscribed.done, registered.done]);
  expect(subscribedFrames.some((f) => f.type === "subscribed")).toBe(true);
  const frames = await registered.done;
  const connectionId = frames.find((f) => f.type === "measurement_registered")?.connectionId as string;
  expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
  return { socket, connectionId, activityId };
}

function ackPayload(viewer: RegisteredViewer, overrides: object = {}): object {
  return {
    connectionId: viewer.connectionId,
    activityId: viewer.activityId,
    source: "websocket",
    reason: "interval",
    ...overrides,
  };
}

async function ack(viewer: RegisteredViewer, overrides: object = {}): Promise<LightInjectResponse> {
  return nextInject(app, {
    method: "POST",
    url: "/availability-acks",
    payload: ackPayload(viewer, overrides),
  });
}

/** Read current measurement rows. */
async function measurementRows(clause: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return withClient(appUrl, async (client) => {
    const result = await client.query(`SELECT * FROM availability_measurements WHERE ${clause}`, params);
    return result.rows;
  });
}

/**
 * Simulate the two-second deadline passing: measured_at is captured evidence
 * (immutable for every role while the trigger is armed), so the migration
 * role uses its documented bounded-correction escape hatch — disable the
 * trigger, shift the clock, re-arm.
 */
async function simulateDeadlinePass(activityId: string): Promise<void> {
  await withClient(migrationUrl, async (client) => {
    await client.query("ALTER TABLE availability_measurements DISABLE TRIGGER measurement_close_once");
    try {
      await client.query(
        "UPDATE availability_measurements SET measured_at = measured_at - interval '3 seconds' WHERE activity_id = $1",
        [activityId],
      );
    } finally {
      await client.query("ALTER TABLE availability_measurements ENABLE TRIGGER measurement_close_once");
    }
  });
}

describe("booking health classification (issue #11 AC1)", () => {
  it("distinguishes raw attempts, logical operations and every outcome class", async () => {
    const host = await establish("Health Host");
    const bookerA = await establish("Health Booker A");
    const bookerB = await establish("Health Booker B");
    const bookerC = await establish("Health Booker C");
    const activityId = await publishActivity(host.token, "Health Activity", 3);

    // A retry shares the operation id: raw attempts (2) diverge from logical
    // operations (1) for this pair.
    const sharedOp = randomUUID();
    const created = await book(bookerA.token, activityId, { operationId: sharedOp });
    expect(created.statusCode).toBe(201);
    const replay = await book(bookerA.token, activityId, { operationId: sharedOp });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);

    // Unknown-classified failure, visibly engaged: the activity row lock is
    // held on its own connection, so the booking's FOR UPDATE waits and the
    // 1ms statement timeout fires (57014 before any commit attempt) — a real
    // classified failure, not a lifecycle rejection.
    const holder = new Client({ connectionString: appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM activities WHERE id = $1 FOR UPDATE", [activityId]);
      const failingApp = buildApp(configWith({ bookingStatementTimeoutMs: 1 }));
      try {
        const failure = await failingApp.inject({
          method: "POST",
          url: `/activities/${activityId}/bookings`,
          remoteAddress: "10.9.9.9",
          headers: { authorization: `Bearer ${bookerC.token}` },
          payload: { operationId: randomUUID() },
        });
        expect(failure.statusCode).toBe(500);
        expect(failure.json().error.code).toBe("server_error");
      } finally {
        await failingApp.close();
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }

    const bookerD = await establish("Health Booker D");
    expect((await book(bookerD.token, activityId)).statusCode).toBe(201);

    const second = await book(bookerB.token, activityId);
    expect(second.statusCode).toBe(201);
    const soldOut = await book(bookerC.token, activityId);
    expect(soldOut.statusCode).toBe(409);
    const notFound = await book(bookerC.token, randomUUID());
    expect(notFound.statusCode).toBe(404);

    // Lock timeout: the fault visibly engages — a held activity row lock
    // (kept open on its own connection) times the booking out.
    const lockHolder = new Client({ connectionString: appUrl });
    await lockHolder.connect();
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("SELECT 1 FROM activities WHERE id = $1 FOR UPDATE", [activityId]);
      const lockApp = buildApp(configWith({ bookingLockTimeoutMs: 1 }));
      try {
        const lockWaiter = await establish("Health Lock Waiter");
        const response = await lockApp.inject({
          method: "POST",
          url: `/activities/${activityId}/bookings`,
          remoteAddress: "10.9.9.11",
          headers: { authorization: `Bearer ${lockWaiter.token}` },
          payload: { operationId: randomUUID() },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe("lock_timeout");
      } finally {
        await lockApp.close();
      }
    } finally {
      await lockHolder.query("ROLLBACK").catch(() => undefined);
      await lockHolder.end();
    }

    const metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    const health = metrics.json().bookings;
    // created A + created B + created D, replay shares the op id.
    expect(health.outcomes.created).toBe(3);
    expect(health.outcomes.existing).toBe(1);
    expect(health.outcomes.sold_out).toBe(1);
    expect(health.outcomes.not_found).toBe(1);
    expect(health.outcomes.failed).toBe(1);
    expect(health.outcomes.lock_timeout).toBe(1);
    expect(health.rawAttempts).toBe(8);
    expect(health.logicalOperations).toBe(7);
    expect(health.rawAttempts).toBeGreaterThan(health.logicalOperations);
    // Eligible = created + lock_timeout + failed; replays, sell-outs,
    // and invalid input are excluded and shown separately.
    expect(health.reliability.eligibleAttempts).toBe(5);
    expect(health.reliability.successfulNewSpotAttempts).toBe(3);
    expect(health.reliability.ratio).toBeCloseTo(0.6);
    expect(health.reliability.excludedSeparately.confirmedResultReplays).toBe(1);
    expect(health.reliability.excludedSeparately.expectedSellOuts).toBe(1);
    expect(health.reliability.excludedSeparately.invalidOrUnauthorized).toBe(1);
  });

  it("exposes stored-count mismatches instead of hiding them and never reports oversell", async () => {
    const host = await establish("Consistency Host");
    const booker = await establish("Consistency Booker");
    const activityId = await publishActivity(host.token, "Consistency Activity", 1);
    await book(booker.token, activityId);
    // The injected fault: storage drifts from the truth (a phantom seat
    // disappears from the stored count) — the inspection must see it. A
    // stored oversell is structurally impossible (schema CHECK), and the
    // metrics must keep reporting zero against the PLANS target.
    await withClient(migrationUrl, async (client) => {
      await client.query("UPDATE activities SET booked_count = booked_count - 1 WHERE id = $1", [activityId]);
    });
    const metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().bookings.storedCountMismatches).toBe(1);
    expect(metrics.json().bookings.oversellActivities).toBe(0);
    await withClient(migrationUrl, async (client) => {
      await client.query("UPDATE activities SET booked_count = booked_count + 1 WHERE id = $1", [activityId]);
    });
  });

  it("separates publication failure from booking success", async () => {
    // The fault visibly engages: a dead Redis makes the publication fail
    // inside its budget while the committed booking stays confirmed.
    const dead = new Redis("redis://localhost:1", {
      commandTimeout: 200,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});
    const publisher = createLivePublication(dead, "dead-live", 200);
    const host = await establish("Publication Host");
    const booker = await establish("Publication Booker");
    const activityId = await publishActivity(host.token, "Publication Activity", 1);
    const booked = await book(booker.token, activityId);
    expect(booked.statusCode).toBe(201);
    await publisher.publishAvailability({
      activityId,
      version: "99",
      remainingSpots: 0,
      eventId: randomUUID(),
    });
    expect(publisher.stats.attempts).toBe(1);
    expect(publisher.stats.failures).toBe(1);
    expect(publisher.stats.published).toBe(0);

    const metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().publication.scope).toContain("process-local");
    // The main instance published every booking it committed so far.
    expect(metrics.json().publication.attempts).toBeGreaterThanOrEqual(1);
    expect(metrics.json().publication.failures).toBe(0);
    await dead.disconnect();
  });
});

describe("applied availability measurement (issue #11 AC2/AC3)", () => {
  it("captures registered viewers at booking start and closes on the first qualifying ack", async () => {
    await resetMeasurements();
    const host = await establish("Measure Host");
    const booker = await establish("Measure Booker");
    const activityId = await publishActivity(host.token, "Measure Activity", 5);
    const viewer = await registerViewer(activityId, true);

    const booked = await book(booker.token, activityId);
    expect(booked.statusCode).toBe(201);
    const version = booked.json().availabilityVersion;
    const rows = await measurementRows("activity_id = $1", [activityId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connection_id).toBe(viewer.connectionId);
    expect(rows[0]!.acked_at).toBeNull();
    expect(rows[0]!.version).toBe(String(version));
    const committedEventId = rows[0]!.event_id as string;

    const acked = await ack(viewer, { appliedVersion: String(version), appliedEventId: committedEventId });
    expect(acked.statusCode).toBe(200);
    expect(acked.json().ack.closed).toEqual([{ version: String(version), waitedMs: expect.any(Number) }]);
    expect(acked.json().ack.closed[0].waitedMs).toBeGreaterThanOrEqual(0);

    // Duplicate arrival: nothing left to close, nothing rewritten.
    const closedAt = (await measurementRows("activity_id = $1", [activityId]))[0]!.closed_at;
    const duplicate = await ack(viewer, { appliedVersion: String(version), appliedEventId: committedEventId });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().ack.closed).toHaveLength(0);
    const after = await measurementRows("activity_id = $1", [activityId]);
    expect(after).toHaveLength(1);
    expect(after[0]!.closed_at).toEqual(closedAt);

    const metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().availability.measurements.closedWithinDeadline).toBe(1);
    expect(metrics.json().availability.measurements.late).toBe(0);
    expect(metrics.json().availability.measurements.missing).toBe(0);
    expect(metrics.json().availability.bookingsMeasured).toBe(1);
    expect(metrics.json().availability.p95IntervalMs).toBeLessThanOrEqual(2000);
    expect(metrics.json().availability.bookingsWithMissingViewer).toBe(0);
    viewer.socket.close();
  });

  it("refuses fabricated, future, cross-activity and cross-viewer acknowledgements", async () => {
    await resetMeasurements();
    const host = await establish("Refusal Host");
    const booker = await establish("Refusal Booker");
    const otherActivity = await publishActivity(host.token, "Refusal Other", 5);
    const activityId = await publishActivity(host.token, "Refusal Activity", 5);
    const viewer = await registerViewer(activityId, true);
    await book(booker.token, activityId);
    const rows = await measurementRows("activity_id = $1", [activityId]);
    const version = rows[0]!.version as string;
    const committedEventId = rows[0]!.event_id as string;

    const unknownConnection = await ack(viewer, {
      connectionId: randomUUID(),
      appliedVersion: version,
      appliedEventId: committedEventId,
    });
    expect(unknownConnection.statusCode).toBe(400);
    expect(unknownConnection.json().error.code).toBe("ack_rejected");

    const crossActivity = await ack(viewer, { activityId: otherActivity, appliedVersion: "1" });
    expect(crossActivity.statusCode).toBe(400);
    expect(crossActivity.json().error.code).toBe("ack_rejected");

    const futureVersion = await ack(viewer, { appliedVersion: "999999" });
    expect(futureVersion.statusCode).toBe(400);
    expect(futureVersion.json().error.code).toBe("ack_rejected");

    const fabricatedEvent = await ack(viewer, { appliedVersion: version, appliedEventId: randomUUID() });
    expect(fabricatedEvent.statusCode).toBe(400);
    expect(fabricatedEvent.json().error.code).toBe("ack_rejected");

    const eventVersionMismatch = await ack(viewer, { appliedVersion: "1", appliedEventId: committedEventId });
    expect(eventVersionMismatch.statusCode).toBe(400);
    expect(eventVersionMismatch.json().error.code).toBe("ack_rejected");

    const schema = await nextInject(app, {
      method: "POST",
      url: "/availability-acks",
      payload: { ...ackPayload(viewer, { appliedVersion: version }), userId: "invented" },
    });
    expect(schema.statusCode).toBe(400);
    expect(schema.json().error.code).toBe("validation_error");

    // Nothing was closed by any of the refusals.
    expect(await measurementRows("activity_id = $1 AND acked_at IS NOT NULL", [activityId])).toHaveLength(0);
    viewer.socket.close();
  });

  it("excludes later subscribers and honors the visibility boundary", async () => {
    await resetMeasurements();
    const host = await establish("Boundary Host");
    const booker = await establish("Boundary Booker");
    const activityId = await publishActivity(host.token, "Boundary Activity", 5);

    // Registered but reported invisible: not an expected viewer.
    const invisible = await registerViewer(activityId, false);
    // Registered and visible: expected.
    const visible = await registerViewer(activityId, true);

    const booked = await book(booker.token, activityId);
    expect(booked.statusCode).toBe(201);
    const rows = await measurementRows("activity_id = $1", [activityId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.connection_id).toBe(visible.connectionId);
    expect(rows.map((row) => row.connection_id)).not.toContain(invisible.connectionId);

    // Turning visible after the captured booking does not inflate its set.
    invisible.socket.send(JSON.stringify({ type: "visibility", visible: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await measurementRows("activity_id = $1", [activityId])).toHaveLength(1);

    invisible.socket.close();
    visible.socket.close();
  });

  it("captures viewers registered on another instance through shared PostgreSQL", async () => {
    await resetMeasurements();
    const host = await establish("Fleet Host");
    const booker = await establish("Fleet Booker");
    const activityId = await publishActivity(host.token, "Fleet Activity", 5);
    // Instance B owns this connection; only PostgreSQL connects the instances.
    const foreign = await registerViaSecondInstance(activityId);
    // A crashed instance stops counting as present: expired leases are
    // excluded from capture.
    await withClient(migrationUrl, async (client) => {
      await client.query(
        "UPDATE live_connections SET lease_expires_at = now() - interval '1 second' WHERE connection_id = $1",
        [foreign],
      );
    });
    const first = await book(booker.token, activityId);
    expect(first.statusCode).toBe(201);
    expect(await measurementRows("activity_id = $1", [activityId])).toHaveLength(0);

    // Renewal through the real lease path restores capture.
    const fleetPool = new Pool({ connectionString: appUrl });
    try {
      await refreshInstanceLeases(fleetPool, "instance-b", 30, [foreign]);
    } finally {
      await fleetPool.end();
    }
    const booker2 = await establish("Fleet Booker 2");
    const second = await book(booker2.token, activityId);
    expect(second.statusCode).toBe(201);
    const rows = await measurementRows("activity_id = $1", [activityId]);
    expect(rows.map((row) => row.connection_id)).toContain(foreign);
  });

  it("keeps missing acknowledgements as permanent breaches and closes them late", async () => {
    await resetMeasurements();
    const host = await establish("Breach Host");
    const booker = await establish("Breach Booker");
    const activityId = await publishActivity(host.token, "Breach Activity", 5);
    const viewer = await registerViewer(activityId, true);
    const booked = await book(booker.token, activityId);
    expect(booked.statusCode).toBe(201);
    const version = (await measurementRows("activity_id = $1", [activityId]))[0]!.version as string;

    // Simulate the deadline passing while the viewer never acked.
    await simulateDeadlinePass(activityId);
    let metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().availability.measurements.missing).toBe(1);
    expect(metrics.json().availability.bookingsWithMissingViewer).toBe(1);
    expect(metrics.json().availability.p95IntervalMs).toBeGreaterThan(2000);
    expect(metrics.json().availability.p95IsLowerBound).toBe(true);
    const filtered = await nextInject(app, { method: "GET", url: "/metrics?from=2000-01-01T00:00:00Z" });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().availability.bookingsMeasured).toBe(1);

    // Late recovery closes the measurement; the breach stays permanent.
    const late = await ack(viewer, { appliedVersion: version, reason: "reconnect" });
    expect(late.statusCode).toBe(200);
    expect(late.json().ack.closed).toHaveLength(1);
    metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().availability.measurements.missing).toBe(0);
    expect(metrics.json().availability.measurements.late).toBe(1);
    expect(metrics.json().availability.p95IntervalMs).toBeGreaterThan(2000);
    expect(metrics.json().availability.bookingsWithMissingViewer).toBe(0);
    viewer.socket.close();
  });

  it("counts disconnected viewers after capture and closes older updates via newer applied version", async () => {
    await resetMeasurements();
    const host = await establish("Lifecycle Host");
    const booker = await establish("Lifecycle Booker");
    const booker2 = await establish("Lifecycle Booker 2");
    const activityId = await publishActivity(host.token, "Lifecycle Activity", 5);
    const stayer = await registerViewer(activityId, true);
    const leaver = await registerViewer(activityId, true);

    const first = await book(booker.token, activityId);
    expect(first.statusCode).toBe(201);

    // Disconnected after capture: the captured measurement survives, and the
    // viewer is reported disconnected once the deadline passes. A later
    // booking no longer captures the departed connection.
    leaver.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await book(booker2.token, activityId);
    expect(second.statusCode).toBe(201);
    await simulateDeadlinePass(activityId);
    let metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().availability.measurements.disconnected).toBe(1);

    // A newer snapshot acknowledgement (no event id: snapshot sources derive
    // from the committed availability version) closes the survivor's older
    // pending update; first arrival stamps the ack columns once.
    const current = await withClient(appUrl, async (client) => {
      const result = await client.query(
        "SELECT availability_version::text AS version FROM activities WHERE id = $1",
        [activityId],
      );
      return result.rows[0]!.version;
    });
    const snapshotAck = await ack(stayer, { appliedVersion: current, source: "snapshot", reason: "foreground" });
    expect(snapshotAck.statusCode).toBe(200);
    const stayerRows = await measurementRows(
      "activity_id = $1 AND connection_id = $2 ORDER BY version",
      [activityId, stayer.connectionId],
    );
    expect(stayerRows.length).toBeGreaterThanOrEqual(2);
    expect(stayerRows.every((row) => row.acked_at !== null)).toBe(true);
    expect(stayerRows.map((row) => row.ack_source)).toEqual(["snapshot", "snapshot"]);
    expect(stayerRows.map((row) => row.ack_reason)).toEqual(["foreground", "foreground"]);
    const closedAt = stayerRows[0]!.closed_at;
    expect(stayerRows[1]!.closed_at).toEqual(closedAt);

    // A closed row can never be rewritten — not even by the migration role.
    await withClient(migrationUrl, async (client) => {
      await expect(
        client.query("UPDATE availability_measurements SET acked_at = now() WHERE id = $1", [stayerRows[0]!.id]),
      ).rejects.toThrow(/never rewritten/);
    });
    metrics = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(metrics.json().availability.measurements.pendingUnderDeadline).toBe(0);
    expect(metrics.json().availability.appliedBySourceAndReason).toContainEqual({
      source: "snapshot", reason: "foreground", count: 2, withinDeadline: 0, late: 2,
    });
    stayer.socket.close();
  });

  it("closes a disconnected viewer's captured update when that viewer reconnects and renders a recovery snapshot", async () => {
    await resetMeasurements();
    const host = await establish("Recovery Host");
    const booker = await establish("Recovery Booker");
    const activityId = await publishActivity(host.token, "Recovery Activity", 5);
    const first = await registerViewer(activityId, true);
    const unrelated = await registerViewer(activityId, true);

    expect((await book(booker.token, activityId)).statusCode).toBe(201);
    first.socket.close(); // missed the frame before rendering it
    const version = await withClient(appUrl, async (client) =>
      (await client.query("SELECT availability_version::text AS v FROM activities WHERE id = $1", [activityId])).rows[0]!.v as string);

    // The same viewer returns on a new socket and presents its earlier capability.
    const returned = await registerViewer(activityId, true, first.connectionId);
    expect(returned.connectionId).not.toBe(first.connectionId);
    const recovered = await ack(returned, { appliedVersion: version, source: "snapshot", reason: "reconnect" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().ack.closed).toHaveLength(1);

    const [captured] = await measurementRows("activity_id = $1 AND connection_id = $2", [activityId, first.connectionId]);
    expect(captured).toMatchObject({ ack_source: "snapshot", ack_reason: "reconnect", ack_applied_version: version });
    expect(captured!.acked_at).not.toBeNull();
    // Another viewer's capability cannot close this viewer's evidence, nor the reverse.
    const [other] = await measurementRows("activity_id = $1 AND connection_id = $2", [activityId, unrelated.connectionId]);
    expect(other!.acked_at).toBeNull();
    returned.socket.close();
    unrelated.socket.close();
  });
});

/** Register a presence connection owned by a second instance id (cross-instance capture). */
async function registerViaSecondInstance(activityId: string): Promise<string> {
  const pool = new Pool({ connectionString: appUrl });
  try {
    return await registerMeasurementConnection(pool, {
      instanceId: "instance-b",
      leaseSeconds: 30,
      activities: [activityId],
      visible: true,
    });
  } finally {
    await pool.end();
  }
}

describe("measurement lifecycle boundaries", () => {
  it("books with a one-connection pool and retains its expected viewer", async () => {
    await resetMeasurements();
    const host = await establish("Pool Host");
    const guest = await establish("Pool Booker");
    const activityId = await publishActivity(host.token, "Pool Activity");
    const viewer = await registerViewer(activityId);
    const small = buildApp(configWith({ databasePoolMax: 1, databaseConnectTimeoutMs: 200 }));
    try {
      const booked = await nextInject(small, {
        method: "POST", url: `/activities/${activityId}/bookings`,
        headers: { authorization: `Bearer ${guest.token}` }, payload: { operationId: randomUUID() },
      });
      expect(booked.statusCode).toBe(201);
      expect(await measurementRows("activity_id = $1", [activityId])).toHaveLength(1);
    } finally {
      viewer.socket.close();
      await small.close();
    }
  });

  it("registers once for consecutive duplicate frames and applies visibility before the next subscription", async () => {
    await resetMeasurements();
    const host = await establish("Ordered Host");
    const guest = await establish("Ordered Booker");
    const activityId = await publishActivity(host.token, "Ordered Activity");
    const socket = new WebSocket(`${baseUrl}/live`);
    await new Promise((resolve) => socket.once("open", resolve));
    try {
      const frames = collect(socket, (f) => f.type === "subscribed", 2000);
      socket.send(JSON.stringify({ type: "register_measurement", visible: true }));
      socket.send(JSON.stringify({ type: "register_measurement", visible: true }));
      socket.send(JSON.stringify({ type: "visibility", visible: false }));
      socket.send(JSON.stringify({ type: "subscribe", activityId }));
      const seen = await frames.done;
      expect(seen.filter((f) => f.type === "error")).toEqual([]);
      const ids = seen.filter((f) => f.type === "measurement_registered").map((f) => f.connectionId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(1);
      const booked = await book(guest.token, activityId);
      expect(booked.statusCode).toBe(201);
      expect(await measurementRows("activity_id = $1", [activityId])).toHaveLength(0);
    } finally { socket.close(); }
  });
});

it("commits a booking when measurement storage rejects a write and reports the evidence gap", async () => {
  await resetMeasurements();
  const host = await establish("Gap Host");
  const guest = await establish("Gap Booker");
  const activityId = await publishActivity(host.token, "Gap Activity");
  const viewer = await registerViewer(activityId);
  await withClient(migrationUrl, async (client) => {
    await client.query("CREATE SEQUENCE measurement_fault_observed");
    await client.query("GRANT USAGE, SELECT ON SEQUENCE measurement_fault_observed TO velio_app");
    await client.query(`CREATE FUNCTION fail_measurement_fixture() RETURNS trigger AS $$
      BEGIN PERFORM nextval('measurement_fault_observed'); RAISE EXCEPTION 'measurement storage fixture'; END; $$ LANGUAGE plpgsql`);
    await client.query(`CREATE TRIGGER fail_measurement_fixture BEFORE INSERT ON availability_measurements
      FOR EACH ROW EXECUTE FUNCTION fail_measurement_fixture()`);
  });
  try {
    const result = await book(guest.token, activityId);
    expect(result.statusCode).toBe(201);
    const observed = await withClient(migrationUrl, (client) => client.query("SELECT is_called FROM measurement_fault_observed"));
    expect(observed.rows[0].is_called).toBe(true);
    expect(await measurementRows("activity_id = $1", [activityId])).toHaveLength(0);
    const health = await nextInject(app, { method: "GET", url: "/metrics" });
    expect(health.json().availability.coverage.unrecordedBookings).toBeGreaterThanOrEqual(1);
  } finally {
    await withClient(migrationUrl, async (client) => {
      await client.query("DROP TRIGGER fail_measurement_fixture ON availability_measurements");
      await client.query("DROP FUNCTION fail_measurement_fixture()");
      await client.query("DROP SEQUENCE measurement_fault_observed");
    });
    viewer.socket.close();
  }
});

it("counts unauthorized and invalid booking requests separately without inflating eligible attempts", async () => {
  const host = await establish("Rejected Host");
  const guest = await establish("Rejected Booker");
  const activityId = await publishActivity(host.token, "Rejected Activity");
  const before = (await nextInject(app, { method: "GET", url: "/metrics" })).json().bookings;
  const unauthorized = await nextInject(app, {
    method: "POST", url: `/activities/${activityId}/bookings`, payload: { operationId: randomUUID() },
  });
  expect(unauthorized.statusCode).toBe(401);
  const invalid = await nextInject(app, {
    method: "POST", url: `/activities/${activityId}/bookings`,
    headers: { authorization: `Bearer ${guest.token}` }, payload: { operationId: "" },
  });
  expect(invalid.statusCode).toBe(400);
  const after = (await nextInject(app, { method: "GET", url: "/metrics" })).json().bookings;
  expect(after.rawAttempts - before.rawAttempts).toBe(2);
  expect(after.reliability.eligibleAttempts).toBe(before.reliability.eligibleAttempts);
  expect(after.reliability.excludedSeparately.invalidOrUnauthorized - before.reliability.excludedSeparately.invalidOrUnauthorized).toBe(2);
});

it("retains the missing slowest viewer when another viewer acknowledged the booking", async () => {
  await resetMeasurements();
  const host = await establish("Slowest Host");
  const guest = await establish("Slowest Booker");
  const activityId = await publishActivity(host.token, "Slowest Activity");
  const fast = await registerViewer(activityId);
  const missing = await registerViewer(activityId);
  try {
    const booked = await book(guest.token, activityId);
    expect(booked.statusCode).toBe(201);
    await ack(fast, { appliedVersion: booked.json().availabilityVersion, source: "snapshot" });
    await withClient(migrationUrl, async (client) => {
      await client.query("ALTER TABLE availability_measurements DISABLE TRIGGER measurement_close_once");
      try {
        await client.query("UPDATE availability_measurements SET measured_at = measured_at - interval '3 seconds' WHERE activity_id = $1 AND connection_id = $2", [activityId, missing.connectionId]);
      } finally { await client.query("ALTER TABLE availability_measurements ENABLE TRIGGER measurement_close_once"); }
    });
    const response = await nextInject(app, { method: "GET", url: "/metrics" });
    const latency = response.json().availability;
    expect(latency.measurements.closedWithinDeadline).toBe(1);
    expect(latency.measurements.missing).toBe(1);
    expect(latency.bookingsMeasured).toBe(1);
    expect(latency.p95IntervalMs).toBeGreaterThan(2000);
    expect(latency.p95IsLowerBound).toBe(true);
  } finally { fast.socket.close(); missing.socket.close(); }
});
