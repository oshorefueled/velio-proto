import { cpus, platform, arch, release, totalmem } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { captureExpectedViewers } from "../src/live/presence.js";

/**
 * Rendered-availability run (SPEC 6, ticket 08) against a running API and
 * actual clients. It publishes one measured activity with a public link,
 * prints where to open it, waits until the declared number of visible,
 * measurement-registered viewers is present (server-owned presence in
 * PostgreSQL), then commits spaced bookings by distinct new accounts and
 * reads GET /metrics for exactly that window. Viewers are real browsers and
 * the Flutter app; this script never acknowledges anything itself.
 *
 * The result is the p95 across bookings of each booking's slowest expected
 * viewer (commit-to-acknowledgement on the database clock), with coverage
 * and missing/late/disconnected viewers. HTTP duration is never used as
 * rendered latency. The run's activity and accounts are labeled
 * dataset='demo' afterwards (operator role), so real cohort reports never
 * count them.
 *
 * Usage (API and web already running; DATABASE_URL from .env):
 *   npm run measure:rendered -- --viewers 3 [--bookings 30] [--spacing-ms 1500] \
 *     [--api http://localhost:3001] [--web http://127.0.0.1:5174] [--out rendered.json]
 */

interface Availability {
  coverage: { committedBookings: number; unrecordedBookings: number; captureFailures: number; bookingsWithoutViewers: number };
  measurements: { total: number; closedWithinDeadline: number; late: number; pendingUnderDeadline: number; missing: number; disconnected: number };
  bookingsMeasured: number;
  bookingsWithMissingViewer: number;
  p95IntervalMs: number | null;
  p95IsLowerBound: boolean;
  deadlineMs: number;
}

export interface RenderedVerdict {
  status: "meets" | "fails" | "incomplete";
  p95IntervalMs: number | null;
  deadlineMs: number;
  reasons: string[];
}

/**
 * meets: every expected viewer of every measured booking acknowledged and
 * p95 <= deadline. fails: p95 above the deadline (even if also incomplete,
 * a breach is a breach). incomplete: anything less is labeled with reasons.
 */
export function assessRendered(
  availability: Availability,
  declared: { bookings: number; viewers: number; failedBookings?: number; unrelatedBookingsInWindow?: number },
): RenderedVerdict {
  const reasons: string[] = [];
  if ((declared.failedBookings ?? 0) > 0) reasons.push("booking_failures");
  // /metrics is window-scoped, not activity-scoped: other bookings would mix in.
  if ((declared.unrelatedBookingsInWindow ?? 0) > 0) reasons.push("unrelated_bookings_in_window");
  const { coverage, measurements } = availability;
  if (availability.bookingsMeasured === 0 || availability.p95IntervalMs === null) reasons.push("empty_sample");
  if (availability.bookingsMeasured < declared.bookings) reasons.push("fewer_bookings_measured_than_committed");
  if (measurements.total < declared.bookings * declared.viewers) reasons.push("fewer_viewers_captured_than_declared");
  if (coverage.unrecordedBookings > 0) reasons.push("unrecorded_captures");
  if (coverage.captureFailures > 0) reasons.push("capture_failures");
  if (coverage.bookingsWithoutViewers > 0) reasons.push("bookings_without_viewers");
  if (availability.p95IsLowerBound) reasons.push("p95_lower_bound");
  if (measurements.missing > 0 || availability.bookingsWithMissingViewer > 0) reasons.push("missing_acknowledgements");
  if (measurements.disconnected > 0) reasons.push("disconnected_viewers");
  if (measurements.pendingUnderDeadline > 0) reasons.push("acknowledgements_still_pending");
  const p95 = availability.p95IntervalMs;
  const status = p95 !== null && p95 > availability.deadlineMs ? "fails" : reasons.length > 0 ? "incomplete" : "meets";
  return { status, p95IntervalMs: p95, deadlineMs: availability.deadlineMs, reasons };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const viewers = Number(flag(argv, "viewers"));
  const bookings = Number(flag(argv, "bookings") ?? 30);
  const spacingMs = Number(flag(argv, "spacing-ms") ?? 1500);
  if (!Number.isInteger(viewers) || viewers <= 0 || !Number.isInteger(bookings) || bookings <= 0 || !(spacingMs >= 0)) {
    console.error("usage: npm run measure:rendered -- --viewers <n> [--bookings 30] [--spacing-ms 1500] [--api <url>] [--web <url>] [--out <path>]");
    process.exit(2);
  }
  const config = loadConfig();
  const api = flag(argv, "api") ?? `http://localhost:${config.port}`;
  const web = flag(argv, "web") ?? "http://127.0.0.1:5174";
  const out = flag(argv, "out") ?? resolve(process.cwd(), `rendered-${Date.now()}.json`);

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, any> };
  };
  const session = async (email: string, displayName: string) => {
    const response = await call("POST", "/demo/sessions", { email, displayName });
    if (response.status !== 200) throw new Error(`account entry for ${email} failed: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json.session.token as string;
  };

  const host = await session("host@velio.test", "Ada");
  const published = await call("POST", "/activities", {
    title: "Rendered availability check",
    description: "Measured activity for the rendered-availability run.",
    itinerary: "Meet, walk, return.",
    startsAt: new Date(Date.now() + 4 * 86400000).toISOString(),
    endsAt: new Date(Date.now() + 4 * 86400000 + 2 * 3600 * 1000).toISOString(),
    timezone: "Africa/Lagos", priceMinorUnits: 500000, currency: "NGN", spots: bookings + 10,
  }, host);
  if (published.status !== 201) throw new Error(`publication failed: ${published.status}`);
  const activityId = published.json.activity.id as string;
  const invite = await call("POST", `/activities/${activityId}/invites`, { rail: "public_share" }, host);
  const code = invite.status < 300 ? (invite.json?.invite?.code as string) : undefined;
  if (code === undefined) {
    console.log(`  (no invitation code: ${invite.status} ${invite.json?.error?.code ?? ""}. The activity is probably in the control arm;`);
    console.log(`   run the API with EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=100 to include a Flutter viewer.)`);
  }
  console.log(`Open ${viewers} viewer(s) on activity ${activityId}:`);
  console.log(`  web:     ${web}/?activity=${activityId}`);
  if (code !== undefined) {
    console.log(`  flutter: velio://invite/${code}  (or integration_test/live_viewer_hold_test.dart --dart-define=VELIO_INVITE_CODE=${code})`);
  }

  // Every viewer on one machine acknowledges from one IP; the API refuses
  // acknowledgements beyond its per-IP quota, which would read as missing.
  const ackQuota = config.availabilityAckRateLimitPerIp;
  if (bookings * viewers > ackQuota) {
    console.log(`  warning: ${bookings * viewers} acknowledgements exceed AVAILABILITY_ACK_RATE_LIMIT_PER_IP=${ackQuota} per window;`);
    console.log("  viewers sharing one IP will be refused. Start the API with a raised limit and disclose it.");
  }

  const pool: Pool = createPool(config.databaseUrl, { max: 2 });
  const operator: Pool = createPool(config.migrationDatabaseUrl, { max: 1 });
  // The window uses the database clock, the same clock that stamps bookings.
  const dbNow = async () => (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
  try {
    // The same presence read the server uses to capture expected viewers.
    const present = async () => (await captureExpectedViewers(pool, activityId)).length;
    const waitUntil = Date.now() + 10 * 60 * 1000;
    let registered = await present();
    while (registered < viewers && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 1000));
      registered = await present();
    }
    if (registered < viewers) throw new Error(`only ${registered} of ${viewers} viewers registered within 10 minutes`);
    console.log(`${registered} visible viewer(s) registered; committing ${bookings} bookings ${spacingMs} ms apart`);
    await new Promise((r) => setTimeout(r, 2000));

    const from = await dbNow();
    const attempts: Array<{ index: number; status: number; version: string | null }> = [];
    for (let index = 0; index < bookings; index++) {
      const guest = await session(`rendered-${Date.now()}-${index}@example.test`, `Rendered ${index}`);
      const booked = await call("POST", `/activities/${activityId}/bookings`, { operationId: randomUUID() }, guest);
      attempts.push({ index, status: booked.status, version: (booked.json?.availabilityVersion as string) ?? null });
      await new Promise((r) => setTimeout(r, spacingMs));
    }
    await new Promise((r) => setTimeout(r, 5000));
    const to = await dbNow();
    const metrics = (await call("GET", `/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json;
    const availability = metrics.availability as Availability;
    const unrelated = Number((await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM bookings WHERE activity_id <> $1 AND created_at >= $2 AND created_at <= $3",
      [activityId, from, to])).rows[0]!.n);
    const failedBookings = attempts.filter((attempt) => attempt.status !== 201).length;
    const verdict = assessRendered(availability, { bookings, viewers, failedBookings, unrelatedBookingsInWindow: unrelated });

    // Synthetic run data stays out of real cohort reports.
    await operator.query(
      `UPDATE users SET dataset = 'demo' WHERE dataset <> 'demo'
         AND id IN (SELECT user_id FROM bookings WHERE activity_id = $1)`, [activityId]);
    await operator.query("UPDATE activities SET dataset = 'demo' WHERE id = $1 AND dataset <> 'demo'", [activityId]);
    const result = {
      settings: {
        api, viewersDeclared: viewers, viewersRegisteredAtStart: registered, bookings, spacingMs, activityId,
        window: { from, to, clock: "database" },
        failedBookings, unrelatedBookingsInWindow: unrelated,
        ackQuotaPerIpInScriptEnv: ackQuota,
        hardware: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
        node: process.version,
        note: "Viewers were actual clients; acknowledgements are post-render. Measured on one machine; not a production capacity claim.",
      },
      attempts,
      availability,
      verdict,
    };
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${out}`);
    console.log(JSON.stringify({ verdict, coverage: availability.coverage, measurements: availability.measurements }, null, 2));
  } finally {
    await pool.end();
    await operator.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
