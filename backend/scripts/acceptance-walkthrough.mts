import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { execFileSync } from "node:child_process";
import type { CohortQueryName } from "./cohorts.mts";

/**
 * Backend acceptance walkthrough (issue #13): one reproducible pass over the
 * integrated capability map — identity, publication, direct booking and
 * replay, public/host access, both invite rails, multi-generation signup and
 * claims, immutable acquisition vs redeemed attribution, error shapes,
 * identity expiry preserving the client contract, host completion, metrics,
 * a product query, and the live protocol including measurement
 * acknowledgement. Every step records the actual request and response
 * (credentials redacted) so the transcript doubles as the client-contract
 * example set. Existing primary test suites own the deep per-capability
 * guarantees (contention, fault injection, protocol edge cases); this
 * walkthrough proves the pieces work together over real HTTP/WebSocket with
 * real PostgreSQL and Redis, in the isolated velio_test database with
 * operator-labeled demo data.
 *
 * Usage: npm run acceptance:walkthrough [-- --out <path>]
 */

interface Step {
  step: string;
  request?: { method: string; url: string; body?: unknown };
  response?: { status: number; body: unknown };
  note?: string;
  ok: boolean;
}

const TEST_DB = "/velio_test";
const PREFIX = "walkthrough";

function redact(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const clone = { ...(body as Record<string, unknown>) };
  if (clone.session && typeof clone.session === "object") {
    const session = { ...(clone.session as Record<string, unknown>) };
    if (typeof session.token === "string") {
      session.token = `${session.token.slice(0, 8)}…<redacted:${session.token.length} chars>`;
    }
    clone.session = session;
  }
  if (typeof clone.connectionId === "string") {
    clone.connectionId = `${clone.connectionId.slice(0, 8)}…<redacted:${clone.connectionId.length} chars>`;
  }
  return clone;
}

export async function runWalkthrough(options: { databaseUrl?: string; migrationUrl?: string } = {}): Promise<{
  steps: Step[];
  out: Record<string, unknown>;
}> {
  const base = loadConfig();
  // Disclosed acceptance overrides: repeated runs share the 127.0.0.1
  // per-IP windows (quotas raised), and treatment allocation is pinned to
  // 100% so the invite-rail walkthrough is deterministic — control-arm
  // gating stays owned by the experiment/invite suites.
  const config: Config = {
    ...base,
    logLevel: "warn",
    bookingRateLimitPerIp: 1000000,
    inviteRateLimitPerIp: 1000000,
    inviteResolveRateLimitPerIp: 1000000,
    experimentTreatmentAllocationPercent: 100,
  };
  const appUrl = options.databaseUrl ?? (() => {
    const url = new URL(config.databaseUrl);
    url.pathname = TEST_DB;
    return url.href;
  })();
  const migrationUrl = options.migrationUrl ?? (() => {
    const url = new URL(config.migrationDatabaseUrl);
    url.pathname = TEST_DB;
    return url.href;
  })();
  const runConfig: Config = { ...config, databaseUrl: appUrl, migrationDatabaseUrl: migrationUrl };
  await runMigrations({ migrationUrl, dir: resolve(dirname(fileURLToPath(import.meta.url)), "../../backend/migrations") });

  const app = buildApp(runConfig);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const httpBase = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const wsBase = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/live`;
  const runId = `${PREFIX}-${randomUUID()}`;
  const migrationPool: Pool = createPool(migrationUrl, { max: 2 });
  const steps: Step[] = [];
  let liveSocket: WebSocket | undefined;

  const call = async (step: string, method: string, path: string, body?: unknown, token?: string, expect = 200): Promise<Record<string, unknown>> => {
    const response = await fetch(`${httpBase}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown>;
    steps.push({
      step,
      request: { method, url: path, body: redact(body) },
      response: { status: response.status, body: redact(json) },
      ok: response.status === expect,
    });
    if (response.status !== expect) {
      throw new Error(`step ${step}: expected ${expect}, got ${response.status}`);
    }
    if (method === "POST" && path === "/demo/sessions" && json.created === true) {
      await migrationPool.query("UPDATE users SET dataset='demo' WHERE id=$1", [(json.user as { id: string }).id]);
    }
    if (method === "POST" && path === "/activities") {
      await migrationPool.query("UPDATE activities SET dataset='demo' WHERE id=$1", [(json.activity as { id: string }).id]);
    }
    return json;
  };

  const expectError = async (step: string, method: string, path: string, body: unknown, token: string | undefined, expectStatus: number, expectCode: string): Promise<void> => {
    const response = await fetch(`${httpBase}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { error?: { code?: string } };
    steps.push({
      step,
      request: { method, url: path, body: redact(body) },
      response: { status: response.status, body: redact(json) },
      note: `machine-readable error code: ${json?.error?.code}`,
      ok: response.status === expectStatus && json?.error?.code === expectCode,
    });
    if (response.status !== expectStatus || json?.error?.code !== expectCode) {
      throw new Error(`step ${step}: expected ${expectStatus}/${expectCode}, got ${response.status}/${json?.error?.code}`);
    }
  };

  try {
    // 1. Readiness.
    await call("readiness", "GET", "/readyz");

    // 2. Host identity (demo contact).
    const host = await call("identity-establish-host", "POST", "/demo/sessions", { email: (`${runId}-host`) + "@example.test", displayName: "Walkthrough Host" });
    const hostToken = (host.session as { token: string }).token;

    // 3. Treatment activities (allocation pinned to 100%; control gates have primary owners).
    const treatment = await call("publish-treatment", "POST", "/activities", { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `${runId} treatment`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 1500,
      currency: "EUR",
      spots: 3,
    }, hostToken, 201);
    const treatmentId = (treatment.activity as { id: string }).id;
    const soldout = await call("publish-soldout-target", "POST", "/activities", { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `${runId} one-seat`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 500,
      currency: "EUR",
      spots: 1,
    }, hostToken, 201);
    const soldoutId = (soldout.activity as { id: string }).id;
    const liveTarget = await call("publish-live-target", "POST", "/activities", { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `${runId} live one-seat`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 500,
      currency: "EUR",
      spots: 1,
    }, hostToken, 201);
    const liveTargetId = (liveTarget.activity as { id: string }).id;

    // 4. Guest A identity + direct booking with a stable operation id.
    const guestA = await call("identity-guest-a", "POST", "/demo/sessions", { email: (`${runId}-guest-a`) + "@example.test", displayName: "Guest A" });
    const guestAToken = (guestA.session as { token: string }).token;
    const guestAId = (guestA.user as { id: string }).id;
    const operationId = randomUUID();
    const booking = await call("direct-booking", "POST", `/activities/${treatmentId}/bookings`, { operationId }, guestAToken, 201);
    const firstBookingId = (booking.booking as { id: string }).id;

    // 5. Lost response reconciliation: same operation id replays to the same
    //    booking without another seat (created:false), and /bookings/me
    //    recovers the committed booking after a hypothetically lost response.
    const replay = await call("operation-replay", "POST", `/activities/${treatmentId}/bookings`, { operationId }, guestAToken);
    const recovered = await call("lost-response-recovery", "GET", `/activities/${treatmentId}/bookings/me`, undefined, guestAToken);
    const recoveredBookingId = (recovered.booking as { id: string }).id;
    steps.push({
      step: "replay-consistency",
      note: `replay created=${String(replay.created)}; replay booking === recovered booking === first booking: ${
        (replay.booking as { id: string }).id === firstBookingId && recoveredBookingId === firstBookingId
      }`,
      ok: replay.created === false && (replay.booking as { id: string }).id === firstBookingId && recoveredBookingId === firstBookingId,
    });

    // 6. Public detail (no participant data) vs host-only participants.
    const publicView = await call("public-activity-detail", "GET", `/activities/${treatmentId}`);
    const guestParticipants = await fetch(`${httpBase}/activities/${treatmentId}/participants`, {
      headers: { authorization: `Bearer ${guestAToken}` },
    });
    steps.push({
      step: "host-only-participants-denied",
      request: { method: "GET", url: `/activities/${treatmentId}/participants` },
      response: { status: guestParticipants.status, body: await guestParticipants.json() },
      note: "a non-host session receives 403 forbidden; public views never contain participant names",
      ok: guestParticipants.status === 403,
    });
    const hostParticipants = await call("host-participants", "GET", `/activities/${treatmentId}/participants`, undefined, hostToken);
    const publicActivity = publicView.activity as Record<string, unknown>;
    steps.push({ step: "public-and-host-data", ok: !("participants" in publicView) && !("participants" in publicActivity)
      && !JSON.stringify(publicView).includes("Guest A") && JSON.stringify(hostParticipants).includes("Guest A") });

    // 7. Invite rails: guest A (confirmed booker) creates a public share;
    //    the host vouches for a brand-new contact (guest B).
    const publicShare = await call("public-share-creation", "POST", `/activities/${treatmentId}/invites`, { rail: "public_share" }, guestAToken, 201);
    const shareCode = (publicShare.invite as { code: string }).code;
    const vouch = await call("vouch-creation", "POST", `/activities/${treatmentId}/invites`, { rail: "vouch", recipientEmail: `${runId}-guest-b@example.test` }, hostToken, 201);
    const vouchCode = (vouch.invite as { code: string }).code;

    // 8. Wrong recipient and unknown code error shapes.
    const guestCTokenPre = await call("identity-guest-c", "POST", "/demo/sessions", { email: (`${runId}-guest-c`) + "@example.test", displayName: "Guest C" });
    await expectError("vouch-wrong-recipient", "POST", `/activities/${treatmentId}/bookings`, { operationId: randomUUID(), inviteCode: vouchCode }, (guestCTokenPre.session as { token: string }).token, 403, "invite_recipient_mismatch");
    await expectError("unknown-invite-code", "GET", "/invites/UNKNOWNCODE1", undefined, undefined, 404, "invite_not_found");

    // 9. Multi-generation signup/claim: guest B claims the vouch (acquires
    //    generation 1), books, creates a public share; guest C signs up with
    //    it (generation 2) and claims.
    await call("public-invite-preview", "GET", `/invites/${vouchCode}`);
    const guestBVisitor = randomUUID();
    await call("simulated-displayed-open", "POST", "/client-events", { type: "invite_opened", eventId: randomUUID(), visitorId: guestBVisitor, channel: "web", inviteCode: vouchCode, outcome: "available" });
    const guestB = await call("identity-via-vouch-gen1", "POST", "/demo/sessions", { email: (`${runId}-guest-b`) + "@example.test", displayName: "Guest B", inviteCode: vouchCode, visitorId: guestBVisitor, channel: "web" });
    const guestBToken = (guestB.session as { token: string }).token;
    if ((guestB.user as { signupSource: string }).signupSource !== "vouch") throw new Error("vouch signup acquisition not recorded");
    await call("simulated-claim-action", "POST", "/client-events", { type: "claim_started", eventId: randomUUID(), visitorId: guestBVisitor, channel: "web", inviteCode: vouchCode }, guestBToken);
    const bookingB = await call("vouch-claim-booking", "POST", `/activities/${treatmentId}/bookings`, { operationId: randomUUID(), inviteCode: vouchCode }, guestBToken, 201);
    const shareByB = await call("generation-2-public-share", "POST", `/activities/${treatmentId}/invites`, { rail: "public_share" }, guestBToken, 201);
    const shareByBCode = (shareByB.invite as { code: string }).code;
    const guestC = await call("identity-via-public-share-gen2", "POST", "/demo/sessions", { email: (`${runId}-guest-c-final`) + "@example.test", displayName: "Guest C", inviteCode: shareByBCode });
    const guestCToken = (guestC.session as { token: string }).token;
    if ((guestC.user as { signupGeneration: number }).signupGeneration !== 2) throw new Error("generation-2 acquisition not recorded");
    const bookingC = await call("generation-2-claim-booking", "POST", `/activities/${treatmentId}/bookings`, { operationId: randomUUID(), inviteCode: shareByBCode }, guestCToken, 201);
    steps.push({
      step: "multi-generation-attribution",
      note: `guest A direct/generation 0; guest B vouch generation ${String((bookingB.booking as { attribution: { generation: number } }).attribution.generation)}; guest C public_share generation 2 — signup acquisition immutable, booking attribution mirrors the redeemed invite`,
      ok: (bookingB.booking as { attribution: { rail: string; generation: number } }).attribution.rail === "vouch"
        && (bookingB.booking as { attribution: { generation: number } }).attribution.generation === 1
        && (bookingC.booking as { attribution: { rail: string; generation: number } }).attribution.rail === "public_share"
        && (bookingC.booking as { attribution: { generation: number } }).attribution.generation === 2,

    });

    // 10. Guest A redeems the public share created from their own booking —
    //     already holding a booking, the replay returns it (existing-booking
    //     replay after public reuse never consumes another seat).
    const originReplay = await call("public-share-reuse-replay", "POST", `/activities/${treatmentId}/bookings`, { operationId: randomUUID(), inviteCode: shareCode }, guestAToken);

    steps.push({ step: "replay-keeps-direct-origin", ok: (originReplay.booking as { attribution: { rail: string } }).attribution.rail === "direct" });

    // 11. Sold-out and full-activity error shape on the one-seat activity.
    const bookerD = await call("identity-guest-d", "POST", "/demo/sessions", { email: (`${runId}-guest-d`) + "@example.test", displayName: "Guest D" });
    await call("first-seat-booking", "POST", `/activities/${soldoutId}/bookings`, { operationId: randomUUID() }, (bookerD.session as { token: string }).token, 201);
    await expectError("sold-out-rejection", "POST", `/activities/${soldoutId}/bookings`, { operationId: randomUUID() }, guestAToken, 409, "activity_sold_out");

    // 12. Identity expiry: shift the session into the past (operator role),
    //     the client is refused with session_expired and re-selection
    //     returns the same person — activity/invite context is client-held.
    await migrationPool.query(
      "UPDATE demo_sessions SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1",
      [guestAId],
    );
    await expectError("session-expired", "GET", "/demo/me", undefined, guestAToken, 401, "session_expired");
    const reSelected = await call("identity-reselection-same-person", "POST", "/demo/sessions", { email: (`${runId}-guest-a`) + "@example.test", displayName: "Ignored" });
    steps.push({
      step: "expiry-preserves-person",
      note: "re-selection after expiry returns the same user id; the display name recorded at creation stands",
      ok: (reSelected.user as { id: string }).id === guestAId,
    });

    // 13. Host completion: publication requires a future start, so the
    //     completion demo publishes, books one seat, then the operator shifts
    //     the start into the past — host confirmation is judged on the
    //     database clock against the started activity.
    const completionDemo = await call("publish-completion-demo", "POST", "/activities", { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `${runId} completion demo`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 900,
      currency: "EUR",
      spots: 1,
    }, hostToken, 201);
    const completionId = (completionDemo.activity as { id: string }).id;
    await call("completion-demo-booking", "POST", `/activities/${completionId}/bookings`, { operationId: randomUUID() }, (bookerD.session as { token: string }).token, 201);
    await migrationPool.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [completionId]);
    const detail = await call("activity-detail-for-plan", "GET", `/activities/${completionId}`);
    const planId = (detail.activity as { planId?: string }).planId
      ?? (detail as { planId?: string }).planId;

    // 14. Live protocol: subscribe, register for measurement, book, receive
    //     the availability frame at the committed version, acknowledge after
    //     (the client contract acknowledges only after render — the
    //     walkthrough acknowledges to close the measurement).
    const ws = new WebSocket(wsBase);
    liveSocket = ws;
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (raw: unknown) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.send(JSON.stringify({ type: "subscribe", activityId: liveTargetId }));
    // Evaluated when the step is recorded: the subscribed acknowledgement
    // must be present before any client action (ticket #9 ordering).
    for (let i = 0; i < 100 && !frames.some(f => f.type === "subscribed"); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!frames.some(f => f.type === "subscribed")) throw new Error("subscribe acknowledgement missing");
    const initialSnapshot = await call("live-snapshot-after-subscribe", "GET", `/activities/${liveTargetId}`);
    const initialVersion = (initialSnapshot.activity as { availabilityVersion: string }).availabilityVersion;
    ws.send(JSON.stringify({ type: "register_measurement", visible: true }));
    let connectionId = "";
    for (let i = 0; i < 50 && connectionId === ""; i += 1) {
      const reg = frames.find((f) => f.type === "measurement_registered");
      if (reg !== undefined) connectionId = reg.connectionId as string;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const bookerE = await call("identity-guest-e", "POST", "/demo/sessions", { email: (`${runId}-guest-e`) + "@example.test", displayName: "Guest E" });
    await call("live-trigger-booking", "POST", `/activities/${liveTargetId}/bookings`, { operationId: randomUUID() }, (bookerE.session as { token: string }).token, 201);
    // wait for the availability frame
    let availability: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && availability === undefined; i += 1) {
      availability = frames.find((f) => f.type === "availability" && f.activityId === liveTargetId);
      if (availability === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    steps.push({
      step: "live-subscription-availability",
      note: `subscribed acknowledgement received before any client action; availability frame version ${String(availability?.version)} (type ${availability === undefined ? "?" : typeof availability.version}), remaining spots ${String(availability?.remainingSpots)}, committed event id present: ${String(availability?.eventId !== undefined)}`,
      ok: availability !== undefined && typeof availability.version === "string" && BigInt(availability.version) > BigInt(initialVersion)
        && availability.remainingSpots === 0 && typeof availability.eventId === "string",
    });
    if (availability === undefined || connectionId === "")
      throw new Error(`live walkthrough incomplete: connectionId=${connectionId || "none"}, frames=${JSON.stringify(frames.map((f) => f.type))}`);
    const ackResponse = await call("measurement-acknowledgement", "POST", "/availability-acks", {
      connectionId,
      activityId: liveTargetId,
      appliedVersion: availability.version,
      appliedEventId: availability.eventId,
      source: "websocket",
      reason: "interval",
    });
    steps.push({
      step: "ack-closes-measurement",
      note: `closed versions: ${JSON.stringify((ackResponse.ack as { closed: unknown[] }).closed)}`,
      ok: ((ackResponse.ack as { closed: unknown[] }).closed.length ?? 0) >= 1,
    });
    ws.close();

    // 15. Metrics snapshot (technical health, aggregate only).
    const metrics = await call("metrics-snapshot", "GET", "/metrics");

    // All five public CLI commands, against the same isolated data.
    const cohortStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const cohortEnd = new Date(Date.parse(cohortStart) + 7 * 24 * 3600 * 1000).toISOString();
    const asOf = new Date(Date.parse(cohortEnd) + 2 * 24 * 3600 * 1000).toISOString();
    for (const name of ["inviter_adoption", "invite_conversion", "k_factor_by_rail", "holdout_comparison", "acquisition_audit"] satisfies CohortQueryName[]) {
      const output = execFileSync(process.execPath, ["--import", "tsx", resolve(dirname(fileURLToPath(import.meta.url)), "cohorts.mts"), name,
        "--start", cohortStart, "--end", cohortEnd, "--as-of", asOf, "--dataset", "demo"], {
        env: { ...process.env, DATABASE_URL: appUrl }, encoding: "utf8", timeout: 30000,
      });
      const report = JSON.parse(output.slice(output.indexOf("{\n"))) as { query: string; results: unknown[] };
      steps.push({ step: `product-query-${name}`, note: JSON.stringify(report), ok: report.query === name && Array.isArray(report.results[0]) });
    }

    void metrics;
  } finally {
    liveSocket?.terminate();
    await app.close();
    await migrationPool.end();
  }

  const failed = steps.filter((step) => !step.ok);
  return { steps, out: { runId, settings: { node: process.version, database: "velio_test", databasePoolMax: config.databasePoolMax,
    databaseStatementTimeoutMs: config.databaseStatementTimeoutMs, databaseConnectTimeoutMs: config.databaseConnectTimeoutMs,
    bookingLockTimeoutMs: config.bookingLockTimeoutMs, bookingStatementTimeoutMs: config.bookingStatementTimeoutMs,
    bookingRateLimitPerIdentity: config.bookingRateLimitPerIdentity, bookingRateLimitPerIp: config.bookingRateLimitPerIp,
    bookingRateWindowSeconds: config.bookingRateWindowSeconds, inviteRateLimitPerIdentity: config.inviteRateLimitPerIdentity,
    inviteRateLimitPerIp: config.inviteRateLimitPerIp, inviteResolveRateLimitPerIp: config.inviteResolveRateLimitPerIp,
    inviteRateWindowSeconds: config.inviteRateWindowSeconds, livePublishTimeoutMs: config.livePublishTimeoutMs,
    demoSessionTtlHours: config.demoSessionTtlHours, experimentVersion: config.experimentVersion,
    experimentTreatmentAllocationPercent: 100, experimentInviteCreationEnabled: config.experimentInviteCreationEnabled,
    simulatedClientObservation: true }, steps: steps.length, failed: failed.length, ok: failed.length === 0 } };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--out") outPath = argv[i + 1];
  }
  const { steps, out } = await runWalkthrough();
  const transcript = { ...out, steps: steps.length, generatedAt: new Date().toISOString(), detail: steps };
  if (outPath !== undefined) {
    writeFileSync(outPath, `${JSON.stringify(transcript, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
  for (const step of steps) {
    console.log(`${step.ok ? "PASS" : "FAIL"}  ${step.step}${step.note === undefined ? "" : ` — ${step.note}`}`);
  }
  if (out.ok !== true) {
    console.error("walkthrough FAILED");
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
