import "../src/config.ts"; // loads the repo-root .env into process.env
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { WebSocket } from "ws";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";
import { RedisStallProxy } from "./support/stall-proxy.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");
const childPort = 4319;
const proxyPort = 6390;
const baseUrl = `http://127.0.0.1:${childPort}`;

const tsxCli = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs");
const serverEntry = path.resolve(import.meta.dirname, "../src/server.ts");

let proxy: RedisStallProxy;
let child: ChildProcess;

async function startServer(timeoutMs = 500): Promise<ChildProcess> {
  const child = spawn(process.execPath, [tsxCli, serverEntry], {
    // tsx runs the server in a child process of its own: a new process group
    // lets the test take the whole tree down with one signal.
    detached: true,
    env: {
      ...process.env,
      // The child must read the same database the test asserts against, not
      // whatever the repo-root .env names, and needs quota headroom that
      // survives repeated runs from this file (fixed windows persist).
      DATABASE_URL: appUrl,
      MIGRATION_DATABASE_URL: migrationUrl,
      BOOKING_RATE_LIMIT_PER_IDENTITY: "1000",
      BOOKING_RATE_LIMIT_PER_IP: "100000",
      PORT: String(childPort),
      REDIS_URL: `redis://127.0.0.1:${proxyPort}`,
      // A long publication budget widens the commit-before-publish window so
      // the test can kill the process inside it. Environment configuration,
      // not a production fault hook.
      LIVE_PUBLISH_TIMEOUT_MS: String(timeoutMs),
      READY_CHECK_TIMEOUT_MS: String(timeoutMs),
      LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => console.log("[child]", String(chunk).slice(0, 400)));
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited early (code ${code})`)));
  });
  const ready = (async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await httpJson(`${baseUrl}/activities`);
        if (response.ok) {
          return;
        }
      } catch {
        // not accepting yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("server did not become ready");
  })();
  await Promise.race([ready, exited]);
  // Attach the exit watcher AFTER readiness so an intentional kill reports
  // through the normal exit event, not the early-exit rejection.
  return child;
}

function waitFor<T>(poll: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  return (async () => {
    for (let i = 0; i < timeoutMs / 200; i += 1) {
      const value = await poll();
      if (value !== null) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("condition not met within timeout");
  })();
}

/** Typed JSON fetch over the global (the test tsconfig has no DOM lib). */
const httpJson = globalThis.fetch as unknown as (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<Record<string, any>> }>;

interface WsFrame {
  type: string;
  [key: string]: unknown;
}

function collect(
  socket: WebSocket,
  timeoutMs: number,
  earlyResolve?: (frame: WsFrame) => boolean,
) {
  const frames: WsFrame[] = [];
  let closed = false;
  socket.on("close", () => (closed = true));
  const done = new Promise<WsFrame[]>((resolve) => {
    const timer = setTimeout(() => resolve(frames), timeoutMs);
    timer.unref();
    socket.on("message", (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as WsFrame;
      if (frame.type === "availability" || frame.type === "resnapshot") {
        frames.push(frame);
        if (earlyResolve?.(frame)) {
          clearTimeout(timer);
          resolve(frames);
        }
      }
    });
  });
  return { frames: done, isClosed: () => closed };
}

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  proxy = new RedisStallProxy(proxyPort, Number(new URL(process.env.REDIS_URL!).port || 6379));
  await proxy.listen();
}, 60000);

afterAll(async () => {
  await proxy.close();
});

describe("live availability across process faults", () => {
  it("recovers the committed booking, count and source after a kill between commit and publish", { timeout: 90000 }, async () => {
    proxy.forward();
    child = await startServer(20000);

    const hostSession = await httpJson(`${baseUrl}/demo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: (`t9-host-${Date.now()}`) + "@example.test", displayName: "Crash Host" }),
    });
    const hostToken = (await hostSession.json()).session.token as string;
    const published = await httpJson(`${baseUrl}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Crash Recovery",
        startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
        timezone: "UTC",
        priceMinorUnits: 1000,
        currency: "EUR",
        spots: 5,
      }),
    });
    expect(published.status).toBe(201);
    const body = (await published.json()) as {
      activity: { id: string };
      plan: { id: string };
    };
    const activityId = body.activity.id;
    const plan = body.plan;

    const guestSession = await httpJson(`${baseUrl}/demo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: (`t9-guest-${Date.now()}`) + "@example.test", displayName: "Crash Guest" }),
    });
    const guestBody = (await guestSession.json()) as { session: { token: string }; user: { id: string } };
    const guestToken = guestBody.session.token;
    const guestId = guestBody.user.id;
    const operationId = randomUUID();

    // Hold a real PUBLISH before forwarding it to Redis. Quota and
    // subscription commands still flow, so this isolates the crash window.
    const held = proxy.holdPublications();
    let responseReturned = false;
    const bookingResponse = httpJson(`${baseUrl}/activities/${activityId}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ operationId }),
    }).then(() => { responseReturned = true; }, () => {});
    await Promise.race([
      held,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no publication reached proxy")), 5000)),
    ]);
    expect(responseReturned).toBe(false);
    const bookingId = await waitFor(async () => {
      const rows = await withClient(migrationUrl, (client) =>
        client
          .query("SELECT id FROM bookings WHERE activity_id = $1 AND user_id = $2", [activityId, guestId])
          .then((r) => (r.rows[0] as { id: string } | undefined)?.id ?? null),
      );
      return rows ?? null;
    }, 10000);

    expect(responseReturned).toBe(false);
    // The saved row is visible and Redis has not received PUBLISH. Kill now,
    // before the HTTP result or either twenty-second timeout can complete.
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      setTimeout(() => reject(new Error("child did not exit after SIGKILL")), 5000);
    }).catch(() => process.kill(-child.pid!, "SIGKILL"));
    await bookingResponse;

    // Restart against real Redis and verify everything survived.
    proxy.forward();
    child = await startServer();

    const snapshot = await httpJson(`${baseUrl}/activities/${activityId}`);
    expect(snapshot.status).toBe(200);
    const snapshotBody = (await snapshot.json()).activity as {
      bookedCount: number;
      availabilityVersion: string;
      remainingSpots: number;
    };
    expect(snapshotBody).toMatchObject({ bookedCount: 1, availabilityVersion: "2", remainingSpots: 4 });

    const mine = await httpJson(`${baseUrl}/activities/${activityId}/bookings/me`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()).booking as { id: string; attribution: { rail: string } };
    expect(mineBody.id).toBe(bookingId);
    expect(mineBody.attribution.rail).toBe("direct");

    // Replay of the same operation after the crash: the original booking,
    // no second seat, no duplicated confirmation event, no publication.
    const replay = await httpJson(`${baseUrl}/activities/${activityId}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ operationId }),
    });
    const replayBody = await replay.json();
    expect([replay.status, replayBody]).toEqual([200, expect.objectContaining({ created: false })]);

    const events = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'booking_confirmed' AND plan_id = $1",
        [plan.id],
      ),
    );
    expect(events.rows[0].n).toBe(1);
    const seats = await withClient(migrationUrl, (client) =>
      client.query("SELECT booked_count FROM activities WHERE id = $1", [activityId]),
    );
    expect(seats.rows[0].booked_count).toBe(1);
  });

  it("keeps sockets open through a publication failure and asks them to resnapshot after Redis reconnects", { timeout: 90000 }, async () => {
    const hostSession = await httpJson(`${baseUrl}/demo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: (`t9-resnap-host-${Date.now()}`) + "@example.test", displayName: "Resnapshot Host" }),
    });
    const hostToken = (await hostSession.json()).session.token as string;
    const published = await httpJson(`${baseUrl}/activities`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ description: "A guided activity.", itinerary: "Meet, explore, return.",
        title: "Resnapshot",
        startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
        timezone: "UTC",
        priceMinorUnits: 1000,
        currency: "EUR",
        spots: 5,
      }),
    });
    const activityId = (await published.json()).activity.id as string;

    const ws = new WebSocket(`ws://127.0.0.1:${childPort}/live`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "subscribe", activityId }));
    // Give the subscription a moment to settle before the stall.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { frames, isClosed } = collect(ws, 15000, (f) => f.type === "resnapshot");

    // Stalled Redis: the publication fails within its budget while the
    // socket stays open and receives nothing.
    proxy.stall();
    const guestSession = await httpJson(`${baseUrl}/demo/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: (`t9-resnap-guest-${Date.now()}`) + "@example.test", displayName: "Resnapshot Guest" }),
    });
    const guestToken = (await guestSession.json()).session.token as string;
    const booked = await httpJson(`${baseUrl}/activities/${activityId}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ operationId: randomUUID() }),
    });
    expect(booked.status).toBe(201); // committed despite the stalled publication
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(isClosed()).toBe(false);

    // Redis connection reset: the gateway resubscribes and instructs every
    // connected viewer to resnapshot from saved state. Forwarding is
    // restored first, or the reconnect would land in the stall.
    proxy.forward();
    proxy.resetConnections();
    const seen = await frames;
    expect(seen.some((f) => f.type === "resnapshot")).toBe(true);

    // The viewer follows the instruction: the saved snapshot carries the
    // newest committed state the stalled publication never delivered.
    const snapshot = await httpJson(`${baseUrl}/activities/${activityId}`);
    expect((await snapshot.json()).activity).toMatchObject({ bookedCount: 1, availabilityVersion: "2" });
    ws.close();
  });
});


afterAll(async () => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});
