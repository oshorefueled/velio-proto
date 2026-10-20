import "../src/config.ts"; // loads the repo-root .env into process.env
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { registerLiveRoutes } from "../src/live/gateway.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl = "";

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
    demoSessionTtlHours: 12,
    logLevel: "silent",
    experimentVersion: "test-rollout",
    experimentTreatmentAllocationPercent: 50,
    experimentInviteCreationEnabled: true,
    inviteExpiryHours: 336,
    liveLeaseSeconds: 30,
    livePublishTimeoutMs: 500,
    liveChannelPrefix: "test-live",
  };
  app = buildApp(config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return () => app.close();
});

afterAll(() => undefined);

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** Collect websocket frames until the predicate matches or the timeout fires. */
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
  return { frames: done };
}

async function establish(displayName: string): Promise<{ token: string; contactKey: string }> {
  const contactKey = uniqueKey("live-ws");
  const response = await app.inject({
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (contactKey) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  return { token: response.json().session.token, contactKey };
}

describe("live gateway", () => {
  it("delivers committed availability to subscribers and recovers via snapshot", async () => {
    const host = await establish("Ws Host");
    const published = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Ws Availability",
        startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
        country: "GB",
        priceMinorUnits: 1000,
        currency: "EUR",
        spots: 5,
      },
    });
    expect(published.statusCode).toBe(201);
    const activityId = published.json().activity.id;
    const planId = published.json().plan.id;

    // Subscribe before any fetch: the socket is live before the client looks
    // at saved state.
    const ws = new WebSocket(`${baseUrl}/live`);
    await new Promise((resolve) => ws.once("open", resolve));
    const subscribed = collect(ws, (f) => f.type === "subscribed", 1000);
    ws.send(JSON.stringify({ type: "subscribe", activityId: activityId.toUpperCase() }));
    expect(await subscribed.frames).toContainEqual({ type: "subscribed", activityId });
    const initialSnapshot = await app.inject({ method: "GET", url: `/activities/${activityId}` });
    expect(initialSnapshot.json().activity.bookedCount).toBe(0);

    const guest = await establish("Ws Guest");
    const { frames } = collect(ws, (f) => f.type === "availability", 5000);
    const booked = await app.inject({
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { operationId: randomUUID() },
    });
    expect(booked.statusCode).toBe(201);

    const seen = await frames;
    console.log("WS FRAMES:", JSON.stringify(seen));
    const update = seen.find((f) => f.type === "availability") as unknown as {
      activityId: string;
      version: string;
      remainingSpots: number;
      eventId: string;
    };
    expect(update).toMatchObject({ activityId, remainingSpots: 4 });
    expect(typeof update.version).toBe("string"); // safe bigint representation
    expect(update.version).toBe(booked.json().availabilityVersion);

    // The committed event id: real identity, matching the saved event row.
    const event = await withClient(migrationUrl, (client) =>
      client.query("SELECT event_id FROM events WHERE event_name = 'booking_confirmed' AND plan_id = $1", [planId]),
    );
    expect(update.eventId).toBe(event.rows[0].event_id);

    // Public payload privacy: availability only, no identity fields.
    const serialized = JSON.stringify(update);
    expect(serialized).not.toMatch(/guest|displayName|contactKey|target/i);

    // Subscribe-before-fetch recovery: the saved snapshot carries the newest
    // committed state and matches the live frame.
    const snapshot = await app.inject({ method: "GET", url: `/activities/${activityId}` });
    expect(snapshot.json().activity).toMatchObject({
      bookedCount: 1,
      remainingSpots: 4,
      availabilityVersion: update.version,
    });
    ws.close();
  });

  it("answers malformed frames with an error and keeps the socket usable", async () => {
    const ws = new WebSocket(`${baseUrl}/live`);
    await new Promise((resolve) => ws.once("open", resolve));
    for (const invalid of ["this is not json", "null", "[]", "42"]) {
      const { frames } = collect(ws, (f) => f.type === "error", 3000);
      ws.send(invalid);
      const seen = await frames;
      expect(seen[0]).toMatchObject({ type: "error", code: "invalid_message" });
    }

    // The socket stayed open: a valid subscribe still works (no error for it).
    const host = await establish("Ws Malformed Host");
    const published = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Ws Malformed",
        startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
        country: "GB",
        priceMinorUnits: 1000,
        currency: "EUR",
        spots: 3,
      },
    });
    const activityId = published.json().activity.id;
    const { frames: subFrames } = collect(ws, (f) => f.type === "availability", 5000);
    ws.send(JSON.stringify({ type: "subscribe", activityId }));
    const guest = await establish("Ws Malformed Guest");
    const booked = await app.inject({
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { operationId: randomUUID() },
    });
    expect(booked.statusCode).toBe(201);
    const subSeen = await subFrames;
    expect(subSeen.some((f) => f.type === "availability" && f.activityId === activityId)).toBe(true);
    ws.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const host = await establish("Ws Unsub Host");
    const published = await app.inject({
      method: "POST",
      url: "/activities",
      headers: { authorization: `Bearer ${host.token}` },
      payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Ws Unsub",
        startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
        country: "GB",
        priceMinorUnits: 1000,
        currency: "EUR",
        spots: 5,
      },
    });
    const activityId = published.json().activity.id;
    const ws = new WebSocket(`${baseUrl}/live`);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "subscribe", activityId }));
    ws.send(JSON.stringify({ type: "unsubscribe", activityId }));

    const { frames } = collect(ws, (f) => f.type === "availability", 800);
    const guest = await establish("Ws Unsub Guest");
    const booked = await app.inject({
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { operationId: randomUUID() },
    });
    expect(booked.statusCode).toBe(201);
    const unsubSeen = await frames;
    expect(unsubSeen.some((f) => f.type === "availability")).toBe(false);
    ws.close();
  });
});

it("waits for Redis subscription confirmation before instructing connected viewers to resnapshot", async () => {
  const subscriber = new EventEmitter() as EventEmitter & { subscribe: () => Promise<number>; disconnect: () => void };
  let confirm!: (count: number) => void;
  subscriber.subscribe = () => new Promise<number>((resolve) => { confirm = resolve; });
  subscriber.disconnect = () => {};
  const gateway = Fastify();
  gateway.register(websocketPlugin);
  gateway.register(registerLiveRoutes, {
    redis: { duplicate: () => subscriber } as unknown as Redis,
    channelPrefix: "ack-order",
    // No measurement frames run in this ordering test; the presence owner is
    // never reached.
    pool: { query: async () => ({ rows: [] }) } as unknown as Pool,
    instanceId: "ack-order-test",
    leaseSeconds: 30,
  });
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  const ws = new WebSocket(`ws://127.0.0.1:${(gateway.server.address() as { port: number }).port}/live`);
  await new Promise((resolve) => ws.once("open", resolve));
  try {
    const before = collect(ws, (f) => f.type === "resnapshot", 100);
    subscriber.emit("ready");
    expect(await before.frames).toEqual([]);
    const after = collect(ws, (f) => f.type === "resnapshot", 1000);
    confirm(1);
    expect(await after.frames).toContainEqual({ type: "resnapshot" });
  } finally {
    ws.close();
    await gateway.close();
  }
});
