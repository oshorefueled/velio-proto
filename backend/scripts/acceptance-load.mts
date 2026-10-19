import { cpus, platform, arch, release, totalmem } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Backend acceptance load gate (PLANS 5.2, issue #13): 1,000 real HTTP
 * booking operations with at most 20 in flight against the real API,
 * PostgreSQL and Redis — no mocks. The benchmark runs in the isolated
 * velio_test database with operator-labeled synthetic (demo) data, so the
 * default real-cohort reports stay free of acceptance traffic. Benchmark
 * quota overrides are disclosed in the result JSON.
 *
 * This is a synthetic-hardware workload result, not a production capacity
 * claim and not the rendered 20-browser/Flutter SLO (ticket 21).
 *
 * Usage:
 *   npm run acceptance:load -- [--operations 1000] [--in-flight 20] [--out <path>]
 */

export interface LoadOptions {
  operations?: number;
  inFlight?: number;
  databaseUrl?: string;
  migrationUrl?: string;
}

export interface LoadResult {
  settings: Record<string, unknown>;
  workload: { operations: number; inFlightMax: number; startedAt: string; finishedAt: string; durationMs: number };
  identitySetupMs: number;
  bookingPhaseMs: number;
  attempts: Array<{ index: number; operationId: string; status: number; created: boolean; durationMs: number }>;
  verification: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

const TEST_DB = "/velio_test";
const LABEL_PREFIX = "acceptance";

function labeledUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = TEST_DB;
  return url.href;
}

export async function runAcceptanceLoad(options: LoadOptions = {}): Promise<LoadResult> {
  const operations = options.operations ?? 1000;
  const inFlight = options.inFlight ?? 20;
  if (!Number.isInteger(operations) || operations <= 0 || !Number.isInteger(inFlight) || inFlight <= 0) {
    throw new Error("operations and inFlight must be positive integers");
  }
  if (inFlight > operations) {
    throw new Error("inFlight cannot exceed operations");
  }

  const base = loadConfig();
  // Benchmark-specific override, disclosed: the shared per-IP booking quota
  // would reject a same-source synthetic burst long before 1,000 operations.
  // Per-identity quotas stay at their configured values (one booking per
  // identity here).
  const config: Config = {
    ...base,
    bookingRateLimitPerIp: 1000000,
    // Disclosed benchmark override: a 20-deep queue on one activity row can
    // legitimately wait longer than the interactive 5s statement timeout;
    // leaving it would misclassify queued waits as server failures. The
    // lock timeout stays at its configured 2000ms, so genuine lock
    // starvation still surfaces as lock_timeout failures.
    bookingStatementTimeoutMs: 30000,
    logLevel: "warn",
  };
  const appUrl = options.databaseUrl ?? labeledUrl(config.databaseUrl);
  const migrationUrl = options.migrationUrl ?? labeledUrl(config.migrationDatabaseUrl);
  const runConfig: Config = { ...config, databaseUrl: appUrl, migrationDatabaseUrl: migrationUrl };

  // Fresh environments are made ready; applied migrations are skipped.
  await runMigrations({ migrationUrl, dir: resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/migrations") });

  const app = buildApp(runConfig);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const migrationPool: Pool = createPool(migrationUrl, { max: 2 });
  const runId = `${LABEL_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    return { status: response.status, json: json as Record<string, unknown> };
  };

  const startedAt = new Date().toISOString();
  try {
    // Host identity and the benchmark activity, labeled demo by the
    // operator role (the application role cannot write the label).
    const host = await request("POST", "/demo/sessions", {
      email: (`${runId}-host`) + "@example.test",
      displayName: "Acceptance Host",
    });
    if (host.status !== 200) throw new Error(`host identity failed: ${host.status}`);
    await migrationPool.query("UPDATE users SET dataset='demo' WHERE id=$1", [(host.json.user as { id: string }).id]);
    const hostToken = (host.json as { session: { token: string } }).session.token;

    const published = await request("POST", "/activities", { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `${LABEL_PREFIX} load activity`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 1000,
      currency: "EUR",
      spots: operations,
    }, hostToken);
    if (published.status !== 201) throw new Error(`activity publication failed: ${published.status}`);
    const activityId = (published.json as { activity: { id: string } }).activity.id;
    await migrationPool.query("UPDATE activities SET dataset = 'demo' WHERE id = $1", [activityId]);

    // Distinct identities: one booking operation each, so configured
    // per-identity quotas stay meaningful while the shared per-IP window
    // carries the synthetic burst.
    const identitySetupStarted = Date.now();
    const tokens: string[] = new Array(operations);
    let identityCursor = 0;
    const identityWorkers = Array.from({ length: Math.min(inFlight, operations) }, async () => {
      for (;;) {
        const index = identityCursor;
        if (index >= operations) return;
        identityCursor += 1;
        const established = await request("POST", "/demo/sessions", {
          email: (`${runId}-booker-${index}`) + "@example.test",
          displayName: `Booker ${index}`,
        });
        if (established.status !== 200) throw new Error(`identity ${index} failed: ${established.status}`);
        await migrationPool.query("UPDATE users SET dataset='demo' WHERE id=$1", [(established.json.user as { id: string }).id]);
        tokens[index] = (established.json as { session: { token: string } }).session.token;
      }
    });
    await Promise.all(identityWorkers);
    const identitySetupMs = Date.now() - identitySetupStarted;

    // The load phase: at most `inFlight` real HTTP booking operations in
    // flight at any moment; the gauge is incremented before dispatch and
    // decremented after the response, and its high-water mark is recorded.
    let inFlightNow = 0;
    let inFlightMax = 0;
    const attempts: LoadResult["attempts"] = new Array(operations);
    let bookingCursor = 0;
    const bookingStarted = Date.now();
    const bookingWorkers = Array.from({ length: inFlight }, async () => {
      for (;;) {
        const index = bookingCursor;
        if (index >= operations) return;
        bookingCursor += 1;
        const operationId = randomUUID();
        const dispatchAt = Date.now();
        inFlightNow += 1;
        if (inFlightNow > inFlightMax) inFlightMax = inFlightNow;
        let status = 0;
        let created = false;
        try {
          const response = await request("POST", `/activities/${activityId}/bookings`, { operationId }, tokens[index]);
          status = response.status;
          created = response.json?.created === true;
        } catch (err) {
          status = -1;
          void err;
        }
        inFlightNow -= 1;
        attempts[index] = { index, operationId, status, created, durationMs: Date.now() - dispatchAt };
      }
    });
    await Promise.all(bookingWorkers);
    const bookingPhaseMs = Date.now() - bookingStarted;

    // Consistency verification straight from PostgreSQL.
    const verificationPool: Pool = createPool(appUrl, { max: 2 });
    let verification: Record<string, unknown>;
    try {
      const counts = await verificationPool.query<{
        bookings: string;
        booked_count: string;
        attributions: string;
        oversold: string;
        attempted: string;
        created_attempts: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM bookings WHERE activity_id = $1) AS bookings,
           (SELECT booked_count FROM activities WHERE id = $1) AS booked_count,
           (SELECT COUNT(*) FROM booking_attributions ba JOIN bookings b ON b.id = ba.booking_id WHERE b.activity_id = $1) AS attributions,
           (SELECT COUNT(*) FROM activities WHERE id = $1 AND booked_count > capacity) AS oversold,
           (SELECT COUNT(*) FROM events e WHERE e.event_name = 'booking_attempted' AND e.activity_id = $1) AS attempted,
           (SELECT COUNT(*) FROM events e WHERE e.event_name = 'booking_attempted' AND e.activity_id = $1 AND e.details->>'outcome' = 'created') AS created_attempts`,
        [activityId],
      );
      const row = counts.rows[0]!;
      const createdBookings = Number(row.bookings);
      verification = {
        activityId,
        bookings: createdBookings,
        storedBookedCount: Number(row.booked_count),
        attributionRows: Number(row.attributions),
        oversoldActivities: Number(row.oversold),
        rawAttempts: Number(row.attempted),
        createdAttempts: Number(row.created_attempts),
        consistent:
          createdBookings === operations &&
          Number(row.booked_count) === operations &&
          Number(row.attributions) === operations &&
          Number(row.oversold) === 0 &&
          Number(row.attempted) === operations &&
          Number(row.created_attempts) === operations,
      };
    } finally {
      await verificationPool.end();
    }

    const metricsResponse = await request("GET", "/metrics");
    const metrics = (metricsResponse.json as { bookings?: Record<string, unknown> })?.bookings ?? {};

    return {
      settings: {
        hardware: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
        node: process.version,
        database: "postgresql (velio_test, isolated)",
        redis: "configured REDIS_URL",
        databasePoolMax: runConfig.databasePoolMax,
        databaseStatementTimeoutMs: runConfig.databaseStatementTimeoutMs,
        databaseConnectTimeoutMs: runConfig.databaseConnectTimeoutMs,
        bookingLockTimeoutMs: runConfig.bookingLockTimeoutMs,
        bookingStatementTimeoutMs: runConfig.bookingStatementTimeoutMs,
        statementTimeoutOverrideDisclosure: "raised to 30000ms for the queued single-row burst; lock timeout unchanged at 2000ms",
        bookingRateLimitPerIdentity: runConfig.bookingRateLimitPerIdentity,
        bookingRateLimitPerIp: runConfig.bookingRateLimitPerIp,
        bookingRateWindowSeconds: runConfig.bookingRateWindowSeconds,
        livePublishTimeoutMs: runConfig.livePublishTimeoutMs,
        quotaOverrideDisclosure: "bookingRateLimitPerIp raised to 1000000 for the same-source synthetic burst; per-identity quota untouched (one operation per identity)",
        dataset: "demo (operator-labeled synthetic, excluded from default real reports)",
      },
      workload: { operations, inFlightMax, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt) },
      identitySetupMs,
      bookingPhaseMs,
      attempts,
      verification,
      metrics,
    };
  } finally {
    await app.close();
    await migrationPool.end();
  }
}

export function writeLoadResult(result: LoadResult, outPath: string): void {
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let operations = 1000;
  let inFlight = 20;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--operations") operations = Number(argv[i + 1]);
    else if (argv[i] === "--in-flight") inFlight = Number(argv[i + 1]);
    else if (argv[i] === "--out") outPath = argv[i + 1];
  }
  const result = await runAcceptanceLoad({ operations, inFlight });
  if (outPath !== undefined) {
    writeLoadResult(result, outPath);
    console.log(`wrote ${outPath}`);
  }
  const v = result.verification as Record<string, unknown>;
  console.log(
    JSON.stringify(
      {
        operations: result.workload.operations,
        inFlightMax: result.workload.inFlightMax,
        bookingPhaseMs: result.bookingPhaseMs,
        identitySetupMs: result.identitySetupMs,
        consistent: v.consistent,
        oversoldActivities: v.oversoldActivities,
        rawAttempts: v.rawAttempts,
        createdAttempts: v.createdAttempts,
      },
      null,
      2,
    ),
  );
  if (v.consistent !== true || result.attempts.some(attempt => attempt.status !== 201 || !attempt.created)) {
    console.error("load verification FAILED");
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}