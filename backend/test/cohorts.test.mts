import "../src/config.ts"; // loads the repo-root .env into process.env
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../src/db/pool.ts";
import { poissonInterval, runCohortQuery, validateCohortInputs, type CohortInputs } from "../scripts/cohorts.mts";
import { clearIdentityData, resetAndMigrate, urlFor } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let reportingPool: Pool;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(migrationUrl, { max: 5 });
  reportingPool = createPool(appUrl, { max: 2 });
  return async () => { await pool.end(); await reportingPool.end(); };
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, events RESTART IDENTITY CASCADE");
});

const T = (iso: string): string => new Date(iso).toISOString();

async function exec(client: Pool, sql: string, params: unknown[] = []): Promise<void> {
  await client.query(sql, params);
}

/** Operator fixtures write historical facts; reports read them as velio_app. */
async function insertUser(
  client: Pool,
  input: {
    key: string;
    name: string;
    createdAt: string;
    dataset?: string;
    signupSource?: string;
    generation?: number;
    signupInviteId?: string | null;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (contact_key, display_name, created_at, dataset, signup_source, signup_generation, signup_invite_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.key,
      input.name,
      input.createdAt,
      input.dataset ?? "real",
      input.signupSource ?? "direct",
      input.generation ?? 0,
      input.signupInviteId ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function insertActivity(
  client: Pool,
  input: {
    hostId: string;
    title: string;
    startsAt: string;
    dataset?: string;
    capacity?: number;
    arm?: "treatment" | "control";
    experimentVersion?: string;
    createdAt?: string;
  },
): Promise<{ activityId: string; planId: string }> {
  const createdAt = input.createdAt ?? (await client.query<{ created_at: Date }>(
    "SELECT created_at FROM users WHERE id=$1", [input.hostId],
  )).rows[0]!.created_at.toISOString();
  const activity = await client.query<{ id: string }>(
    `INSERT INTO activities (host_id, title, starts_at, ends_at, display_timezone, price_minor_units, currency, capacity, dataset, created_at)
     VALUES ($1, $2, $3, $3::timestamptz + interval '2 hours', 'UTC', 1000, 'EUR', $4, $5, $6)
     RETURNING id`,
    [input.hostId, input.title, input.startsAt, input.capacity ?? 5, input.dataset ?? "real", createdAt],
  );
  const activityId = activity.rows[0]!.id;
  const plan = await client.query<{ id: string }>(
    "INSERT INTO plans (activity_id) VALUES ($1) RETURNING id",
    [activityId],
  );
  if (input.arm !== undefined) {
    await exec(client, "INSERT INTO activity_experiments (activity_id, arm, experiment_version, assigned_at) VALUES ($1, $2, $3, $4)", [
      activityId,
      input.arm,
      input.experimentVersion ?? "v-fix",
      createdAt,
    ]);
  }
  return { activityId, planId: plan.rows[0]!.id };
}

async function insertBooking(
  client: Pool,
  input: { activityId: string; planId: string; userId: string; createdAt: string },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO bookings (activity_id, plan_id, user_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
    [input.activityId, input.planId, input.userId, input.createdAt],
  );
  return result.rows[0]!.id;
}

async function attributeClaim(bookingId: string, inviteId: string, claimedAt: string): Promise<void> {
  await pool.query(`INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code, claimed_at)
    SELECT $1, rail, generation, creator_id, id, code, $3 FROM invites WHERE id = $2`,
    [bookingId, inviteId, claimedAt]);
}

async function insertInvite(
  client: Pool,
  input: {
    code: string;
    rail: string;
    creatorId: string;
    activityId: string;
    planId: string;
    createdAt: string;
    expiresAt: string;
    targetContactKey?: string;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at, created_at, target_contact_key)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
     RETURNING id`,
    [input.code, input.rail, input.creatorId, input.activityId, input.planId, input.expiresAt, input.createdAt, input.targetContactKey ?? null],
  );
  return result.rows[0]!.id;
}

async function insertEvent(
  client: Pool,
  input: {
    name: string;
    dedupKey?: string;
    userId?: string | null;
    visitorId?: string | null;
    activityId?: string | null;
    inviteId?: string | null;
    bookingId?: string | null;
    channel?: string | null;
    outcome?: string | null;
    occurredAt: string;
    details?: object;
  },
): Promise<void> {
  await exec(
    client,
    `INSERT INTO events (event_name, dedup_key, user_id, visitor_id, activity_id, invite_id, booking_id, channel, outcome, occurred_at, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.name,
      input.dedupKey ?? null,
      input.userId ?? null,
      input.visitorId ?? null,
      input.activityId ?? null,
      input.inviteId ?? null,
      input.bookingId ?? null,
      input.channel ?? null,
      input.outcome ?? null,
      input.occurredAt,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

function run(name: Parameters<typeof runCohortQuery>[1], inputs: CohortInputs) {
  return runCohortQuery(reportingPool, name, inputs);
}

describe("cohort input validation", () => {
  it("rejects malformed, reversed and non-seven-day intervals and unknown datasets", () => {
    expect(() => validateCohortInputs({ start: "not-a-date", end: T("2026-01-08T00:00:00Z") })).toThrow(/start/);
    expect(() =>
      validateCohortInputs({ start: T("2026-01-08T00:00:00Z"), end: T("2026-01-01T00:00:00Z") }),
    ).toThrow(/seven days/);
    expect(() =>
      validateCohortInputs({ start: T("2026-01-01T00:00:00Z"), end: T("2026-01-09T00:00:00Z") }),
    ).toThrow(/seven days/);
    expect(() =>
      validateCohortInputs({ start: T("2026-01-01T00:00:00Z"), end: T("2026-01-08T00:00:00Z"), asOf: "yesterday" }),
    ).toThrow(/as-of/);
    expect(() =>
      validateCohortInputs({ start: T("2026-01-01T00:00:00Z"), end: T("2026-01-08T00:00:00Z"), dataset: "live" }),
    ).toThrow(/dataset/);
    expect(() => validateCohortInputs({ start: "2026-02-30T00:00:00Z", end: "2026-03-09T00:00:00Z" })).toThrow(/start/);
    expect(() => validateCohortInputs({ start: "2026-01-01", end: "2026-01-08" })).toThrow(/start/);
    const ok = validateCohortInputs({ start: T("2026-01-01T00:00:00Z"), end: T("2026-01-08T00:00:00Z") });
    expect(ok).toMatchObject({ start: T("2026-01-01T00:00:00Z"), end: T("2026-01-08T00:00:00Z"), dataset: "real" });
  });
});

describe("inviter adoption", () => {
  const start = T("2026-01-05T00:00:00Z");
  const end = T("2026-01-12T00:00:00Z");
  const asOf = T("2026-02-01T00:00:00Z");

  it("counts one entry per person, the entry-activity window, and reports host-only inviters separately", async () => {
    const client = pool;
    const h1 = await insertUser(client, { key: "adopt-h1", name: "Host", createdAt: T("2025-12-01T00:00:00Z") });
    const u1 = await insertUser(client, { key: "adopt-u1", name: "U1", createdAt: T("2025-12-01T00:00:00Z") });
    const u2 = await insertUser(client, { key: "adopt-u2", name: "U2", createdAt: T("2025-12-01T00:00:00Z") });
    const u3 = await insertUser(client, { key: "adopt-u3", name: "U3", createdAt: T("2025-12-01T00:00:00Z") });
    const u4 = await insertUser(client, { key: "adopt-u4", name: "U4", createdAt: T("2025-12-01T00:00:00Z") });
    const u5 = await insertUser(client, { key: "adopt-u5", name: "U5", createdAt: T("2025-12-01T00:00:00Z") });

    const act1 = await insertActivity(client, {
      hostId: h1,
      title: "Adopt Treatment One",
      startsAt: T("2026-01-20T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "adopt-v1",
    });
    const act2 = await insertActivity(client, {
      hostId: h1,
      title: "Adopt Treatment Two",
      startsAt: T("2026-02-20T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "adopt-v1",
    });
    const act3 = await insertActivity(client, {
      hostId: h1,
      title: "Adopt Final Spot",
      startsAt: T("2026-01-25T00:00:00Z"),
      capacity: 1,
      arm: "treatment",
      experimentVersion: "adopt-v1",
    });
    const actControl = await insertActivity(client, {
      hostId: h1,
      title: "Adopt Control",
      startsAt: T("2026-01-25T00:00:00Z"),
      arm: "control",
      experimentVersion: "adopt-v1",
    });

    await insertBooking(client, { activityId: act1.activityId, planId: act1.planId, userId: u1, createdAt: T("2026-01-06T10:00:00Z") });
    await insertInvite(client, { code: "TXDPT1AAAAAA", rail: "public_share", creatorId: u1, activityId: act1.activityId, planId: act1.planId, createdAt: T("2026-01-06T11:00:00Z"), expiresAt: T("2026-02-19T00:00:00Z") });
    await insertBooking(client, { activityId: act1.activityId, planId: act1.planId, userId: u2, createdAt: T("2026-01-07T10:00:00Z") });
    // u3's entry is the Jan 8 booking; the later act2 booking cannot create a
    // second entry, and both invites fall outside the entry window.
    await insertBooking(client, { activityId: act1.activityId, planId: act1.planId, userId: u3, createdAt: T("2026-01-08T10:00:00Z") });
    await insertInvite(client, { code: "TXDPT2AAAAAA", rail: "public_share", creatorId: u3, activityId: act1.activityId, planId: act1.planId, createdAt: T("2026-01-09T16:00:00Z"), expiresAt: T("2026-02-19T00:00:00Z") });
    await insertBooking(client, { activityId: act2.activityId, planId: act2.planId, userId: u3, createdAt: T("2026-01-10T10:00:00Z") });
    await insertInvite(client, { code: "TXDPT3AAAAAA", rail: "public_share", creatorId: u3, activityId: act2.activityId, planId: act2.planId, createdAt: T("2026-01-10T12:00:00Z"), expiresAt: T("2026-02-19T00:00:00Z") });
    // Final-spot booker on a full activity stays in the denominator.
    const finalBooking = await insertBooking(client, { activityId: act3.activityId, planId: act3.planId, userId: u4, createdAt: T("2026-01-09T10:00:00Z") });
    await insertEvent(pool, { name: "booking_confirmed", bookingId: finalBooking, userId: u4, activityId: act3.activityId, occurredAt: T("2026-01-09T10:00:00Z"), details: { remainingSpots: 0 } });
    await insertInvite(client, { code: "TXDPT4AAAAAA", rail: "vouch", creatorId: u4, activityId: act3.activityId, planId: act3.planId, createdAt: T("2026-01-09T11:00:00Z"), expiresAt: T("2026-01-24T00:00:00Z"), targetContactKey: "vouch-target-adopt" });
    await insertInvite(client, { code: "TXDPT6AAAAAA", rail: "vouch", creatorId: u1, activityId: act1.activityId, planId: act1.planId, createdAt: T("2026-01-06T12:00:00Z"), expiresAt: T("2026-01-19T00:00:00Z"), targetContactKey: "adopt-both" });
    // Control booking is not an entry.
    await insertBooking(client, { activityId: actControl.activityId, planId: actControl.planId, userId: u5, createdAt: T("2026-01-06T12:00:00Z") });
    // Host-only invitation: the host invites without ever being an entrant.
    await insertInvite(client, { code: "TXDPT5AAAAAA", rail: "public_share", creatorId: h1, activityId: act1.activityId, planId: act1.planId, createdAt: T("2026-01-06T12:00:00Z"), expiresAt: T("2026-02-19T00:00:00Z") });

    const report = await run("inviter_adoption", { start, end, asOf });
    expect(report.mature).toBe(true);
    const row = report.results[0]![0]!;
    expect(Number(row.bookers)).toBe(4);
    expect(Number(row.inviters)).toBe(2);
    expect(Number(row.adoption_rate)).toBeCloseTo(0.5);
    expect(Number(row.inviters_public_share)).toBe(1);
    expect(Number(row.inviters_vouch)).toBe(2);
    expect(Number(row.host_only_inviters)).toBe(1);
    expect(Number(row.final_spot_bookers)).toBe(1);
    expect(Number(row.final_spot_inviters)).toBe(1);
    expect(Number(row.bookers_without_availability_evidence)).toBe(3);
    expect(Number(row.target)).toBeCloseTo(0.3);

    // Same cohort plus explicitly labeled synthetic facts.
    const demoUser = await insertUser(pool, {
      key: "adopt-demo",
      name: "Demo",
      createdAt: T("2025-12-01T00:00:00Z"),
      dataset: "demo",
    });
    const demoActivity = await insertActivity(pool, {
      hostId: demoUser,
      title: "Adopt Demo",
      startsAt: T("2026-01-20T00:00:00Z"),
      dataset: "demo",
      arm: "treatment",
      experimentVersion: "demo-v1",
    });
    await insertBooking(pool, { activityId: demoActivity.activityId, planId: demoActivity.planId, userId: demoUser, createdAt: T("2026-01-06T10:00:00Z") });
    await insertInvite(pool, { code: "TXDPTDEM0AAA", rail: "public_share", creatorId: demoUser, activityId: demoActivity.activityId, planId: demoActivity.planId, createdAt: T("2026-01-06T11:00:00Z"), expiresAt: T("2026-02-19T00:00:00Z") });

    const real = await run("inviter_adoption", { start: T("2026-01-05T00:00:00Z"), end: T("2026-01-12T00:00:00Z"), asOf: T("2026-02-01T00:00:00Z") });
    expect(Number(real.results[0]![0]!.bookers)).toBe(4);
    expect(Number(real.results[0]![0]!.inviters)).toBe(2);

    const demo = await run("inviter_adoption", {
      start: T("2026-01-05T00:00:00Z"),
      end: T("2026-01-12T00:00:00Z"),
      asOf: T("2026-02-01T00:00:00Z"),
      dataset: "demo",
    });
    expect(Number(demo.results[0]![0]!.bookers)).toBe(1);
    expect(Number(demo.results[0]![0]!.inviters)).toBe(1);
    expect(demo.results[0]![0]!.dataset).toBe("demo");
  });
});

describe("open-to-claim conversion", () => {
  const start = T("2026-01-19T00:00:00Z");
  const end = T("2026-01-26T00:00:00Z");
  const asOf = T("2026-02-10T00:00:00Z");

  it("counts stitched opportunities once, ignores replays and other invites, and keeps closed landings as denominators", async () => {
    const h2 = await insertUser(pool, { key: "conv-h2", name: "Conv Host", createdAt: T("2025-12-01T00:00:00Z") });
    const g1 = await insertUser(pool, { key: "conv-g1", name: "Guest 1", createdAt: T("2026-01-21T00:00:00Z") });
    const g2 = await insertUser(pool, { key: "conv-g2", name: "Guest 2", createdAt: T("2026-01-24T00:00:00Z") });
    const act4 = await insertActivity(pool, {
      hostId: h2,
      title: "Conversion Activity",
      startsAt: T("2026-02-20T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "conv-v1",
    });
    const iv1 = await insertInvite(pool, { code: "TXCNV1AAAAAA", rail: "public_share", creatorId: h2, activityId: act4.activityId, planId: act4.planId, createdAt: T("2026-01-18T00:00:00Z"), expiresAt: T("2026-03-01T00:00:00Z") });
    const otherActivity = await insertActivity(pool, {
      hostId: h2,
      title: "Conversion Other Activity",
      startsAt: T("2026-02-25T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "conv-v1",
    });
    const iv2 = await insertInvite(pool, { code: "TXCNV2AAAAAA", rail: "public_share", creatorId: h2, activityId: otherActivity.activityId, planId: otherActivity.planId, createdAt: T("2026-01-18T00:00:00Z"), expiresAt: T("2026-03-01T00:00:00Z") });
    const ivf = await insertInvite(pool, { code: "TXCNVFAAAAAA", rail: "public_share", creatorId: g1, activityId: act4.activityId, planId: act4.planId, createdAt: T("2026-01-18T00:00:00Z"), expiresAt: T("2026-03-01T00:00:00Z") });
    const ive = await insertInvite(pool, { code: "TXCNVEAAAAAA", rail: "public_share", creatorId: g2, activityId: act4.activityId, planId: act4.planId, createdAt: T("2026-01-10T00:00:00Z"), expiresAt: T("2026-01-20T12:00:00Z") });

    const v1 = randomVisitor();
    // Returning guest: two displayed opens before identity completion.
    await insertEvent(pool, { name: "invite_opened", visitorId: v1, inviteId: iv1, channel: "web", outcome: "available", occurredAt: T("2026-01-20T08:00:00Z") });
    // Account entry on the same device links the earlier anonymous open (C6).
    await insertEvent(pool, { name: "account_entry_completed", userId: g1, visitorId: v1, occurredAt: T("2026-01-21T05:00:00Z") });
    await insertEvent(pool, { name: "invite_opened", userId: g1, visitorId: v1, inviteId: iv1, channel: "web", outcome: "available", occurredAt: T("2026-01-21T09:00:00Z") });
    const b1 = await insertBooking(pool, { activityId: act4.activityId, planId: act4.planId, userId: g1, createdAt: T("2026-01-21T06:00:00Z") });
    await attributeClaim(b1, iv1, T("2026-01-21T06:00:00Z"));
    // The redeemed invite converts once; a replayed claim event adds nothing.
    await insertEvent(pool, { name: "spot_claimed", userId: g1, inviteId: iv1, bookingId: b1, occurredAt: T("2026-01-21T06:30:00Z") });
    await insertEvent(pool, { name: "spot_claimed", userId: g1, inviteId: iv1, bookingId: b1, occurredAt: T("2026-01-21T07:00:00Z") });

    // Anonymous, never-linked visitor: a separate opportunity, no conversion.
    const v2 = randomVisitor();
    await insertEvent(pool, { name: "invite_opened", visitorId: v2, inviteId: iv1, channel: "flutter", outcome: "available", occurredAt: T("2026-01-22T08:00:00Z") });

    // Full landing stays a denominator with no conversion.
    const v3 = randomVisitor();
    await insertEvent(pool, { name: "invite_opened", visitorId: v3, inviteId: ivf, channel: "web", outcome: "full", occurredAt: T("2026-01-22T09:00:00Z") });

    // Expired landing: the observation window is already closed at open time.
    const v4 = randomVisitor();
    await insertEvent(pool, { name: "invite_opened", visitorId: v4, inviteId: ive, channel: "web", outcome: "expired", occurredAt: T("2026-01-21T09:00:00Z") });

    // A different invite redeemed by the same person is its own opportunity.
    await insertEvent(pool, { name: "invite_opened", userId: g1, visitorId: v1, inviteId: iv2, channel: "web", outcome: "available", occurredAt: T("2026-01-23T08:00:00Z") });
    const b2 = await insertBooking(pool, { activityId: otherActivity.activityId, planId: otherActivity.planId, userId: g1, createdAt: T("2026-01-23T15:00:00Z") });
    await attributeClaim(b2, iv2, T("2026-01-23T15:00:00Z"));
    await insertEvent(pool, { name: "spot_claimed", userId: g1, inviteId: iv2, bookingId: b2, occurredAt: T("2026-01-23T15:30:00Z") });

    // Identity-to-claim drop-off: explicit claim action, no committed claim.
    const v5 = randomVisitor();
    await insertEvent(pool, { name: "invite_opened", visitorId: v5, inviteId: iv2, channel: "web", outcome: "available", occurredAt: T("2026-01-24T08:00:00Z") });
    await insertEvent(pool, { name: "claim_started", visitorId: v5, inviteId: iv2, occurredAt: T("2026-01-24T10:00:00Z") });
    await insertEvent(pool, { name: "account_entry_completed", userId: g2, visitorId: v5, occurredAt: T("2026-01-24T10:01:00Z") });
    await insertEvent(pool, { name: "booking_attempted", userId: g2, activityId: otherActivity.activityId, occurredAt: T("2026-01-24T10:02:00Z"), details: { source: "public_share", outcome: "failed" } });

    const report = await run("invite_conversion", { start, end, asOf });
    expect(report.mature).toBe(true);
    const rows = report.results[0]!;
    const total = rows.find((r) => r.segment === "total")!;
    expect(Number(total.opportunities)).toBe(6);
    expect(Number(total.converted_opportunities)).toBe(2);
    expect(Number(total.conversion_rate)).toBeCloseTo(2 / 6);
    expect(Number(total.closed_landings)).toBe(1);
    expect(Number(total.identity_to_claim_dropoffs)).toBe(1);
    // g1 and g2 each completed account entry inside their opportunity window.
    expect(Number(total.identity_completed_people_in_window)).toBe(2);
    expect(Number(total.activity_scoped_claim_error_opportunities)).toBe(1);
    expect(Number(total.target)).toBeCloseTo(0.25);

    const breakdown = rows.filter((r) => r.segment === "by_rail_channel_landing");
    const availableRow = breakdown.find((r) => r.channel === "web" && r.landing_state === "available")!;
    expect(Number(availableRow.opportunities)).toBe(3);
    expect(Number(availableRow.converted_opportunities)).toBe(2);
    const fullRow = breakdown.find((r) => r.landing_state === "full")!;
    expect(Number(fullRow.opportunities)).toBe(1);
    expect(Number(fullRow.converted_opportunities)).toBe(0);
    const expiredRow = breakdown.find((r) => r.landing_state === "expired")!;
    expect(Number(expiredRow.opportunities)).toBe(1);
  });
});

describe("k factor by rail", () => {
  const start = T("2025-12-05T00:00:00Z");
  const end = T("2025-12-12T00:00:00Z");
  const asOf = T("2025-12-20T00:00:00Z");

  it("fixes the pre-cohort inviter denominator for both rails and excludes second generation", async () => {
    // k3 hosts the treatment base, so the fixed cohort inviters are exactly
    // k1 and k2 (pre-cohort treatment bookers) plus k3 (a pre-cohort host):
    // three people, including two who never invite anyone.
    const k3 = await insertUser(pool, { key: "k-k3", name: "K3", createdAt: T("2025-11-01T00:00:00Z") });
    const act5 = await insertActivity(pool, {
      hostId: k3,
      title: "K Treatment Base",
      startsAt: T("2026-01-10T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "k-v1",
    });
    const k1 = await insertUser(pool, { key: "k-k1", name: "K1", createdAt: T("2025-11-01T00:00:00Z") });
    const k2 = await insertUser(pool, { key: "k-k2", name: "K2", createdAt: T("2025-11-01T00:00:00Z") });
    // k1 and k2 held treatment bookings before the cohort.
    await insertBooking(pool, { activityId: act5.activityId, planId: act5.planId, userId: k1, createdAt: T("2025-11-15T00:00:00Z") });
    await insertBooking(pool, { activityId: act5.activityId, planId: act5.planId, userId: k2, createdAt: T("2025-11-16T00:00:00Z") });

    const beforeInvites = await run("k_factor_by_rail", { start, end, asOf });
    expect(beforeInvites.results[0]).toHaveLength(2);
    for (const row of beforeInvites.results[0]!) {
      expect(Number(row.cohort_inviters)).toBe(3);
      expect(Number(row.acquired_users)).toBe(0);
      expect(Number(row.k_factor)).toBe(0);
    }
    const ik1 = await insertInvite(pool, { code: "TXKF1AAAAAAA", rail: "public_share", creatorId: k1, activityId: act5.activityId, planId: act5.planId, createdAt: T("2025-12-06T00:00:00Z"), expiresAt: T("2026-01-31T00:00:00Z") });
    const ik2 = await insertInvite(pool, { code: "TXKF2AAAAAAA", rail: "vouch", creatorId: k1, activityId: act5.activityId, planId: act5.planId, createdAt: T("2025-12-07T01:00:00Z"), expiresAt: T("2026-01-31T00:00:00Z"), targetContactKey: "vouch-target-k" });
    // A different experiment version must not pool with k-v1.
    const act6 = await insertActivity(pool, {
      hostId: k3,
      title: "K Treatment New Version",
      startsAt: T("2026-02-20T00:00:00Z"),
      arm: "treatment",
      experimentVersion: "k-v2",
    });
    const ik4 = await insertInvite(pool, { code: "TXKF4AAAAAAA", rail: "public_share", creatorId: k1, activityId: act6.activityId, planId: act6.planId, createdAt: T("2025-12-09T00:00:00Z"), expiresAt: T("2026-01-31T00:00:00Z") });

    // Direct acquisitions of the fixed cohort inviters.
    const n1 = await insertUser(pool, { key: "k-n1", name: "N1", createdAt: T("2025-12-06T10:00:00Z"), signupSource: "public_share", generation: 1, signupInviteId: ik1 });
    await insertUser(pool, { key: "k-n2", name: "N2", createdAt: T("2025-12-07T10:00:00Z"), signupSource: "vouch", generation: 1, signupInviteId: ik2 });
    // Second generation: invited by a user acquired during the cohort.
    const n1Invite = await insertInvite(pool, { code: "TXKF5AAAAAAA", rail: "public_share", creatorId: n1, activityId: act5.activityId, planId: act5.planId, createdAt: T("2025-12-10T00:00:00Z"), expiresAt: T("2026-01-31T00:00:00Z") });
    await insertUser(pool, { key: "k-n3", name: "N3", createdAt: T("2025-12-10T10:00:00Z"), signupSource: "public_share", generation: 2, signupInviteId: n1Invite });
    // New version acquisition.
    await insertUser(pool, { key: "k-n5", name: "N5", createdAt: T("2025-12-09T10:00:00Z"), signupSource: "public_share", generation: 1, signupInviteId: ik4 });


    // The acquired subset that books.
    await insertBooking(pool, { activityId: act5.activityId, planId: act5.planId, userId: n1, createdAt: T("2025-12-15T00:00:00Z") });

    const report = await run("k_factor_by_rail", { start, end, asOf });
    expect(report.mature).toBe(true);
    const rows = report.results[0]!;
    const publicShare = rows.find((r) => r.rail === "public_share" && r.experiment_version === "k-v1")!;
    const vouch = rows.find((r) => r.rail === "vouch")!;
    // One fixed denominator for both rails: k1, k2 (bookers) and k3 (host).
    expect(Number(publicShare.cohort_inviters)).toBe(3);
    expect(Number(vouch.cohort_inviters)).toBe(3);
    expect(Number(publicShare.acquired_users)).toBe(1);
    expect(Number(publicShare.acquired_users_who_booked)).toBe(1);
    expect(Number(publicShare.k_factor)).toBeCloseTo(1 / 3);
    expect(Number(vouch.acquired_users)).toBe(1);
    expect(Number(vouch.acquired_users_who_booked)).toBe(0);
    expect(Number(vouch.k_factor)).toBeCloseTo(1 / 3);

    const versions = rows;
    expect(Number(versions.find((r) => r.experiment_version === "k-v1" && r.rail === "public_share")!.acquired_users)).toBe(1);
    expect(Number(versions.find((r) => r.experiment_version === "k-v1" && r.rail === "vouch")!.acquired_users)).toBe(1);
    expect(Number(versions.find((r) => r.experiment_version === "k-v2" && r.rail === "public_share")!.acquired_users)).toBe(1);
  });
});

describe("holdout comparison", () => {
  const start = T("2026-03-02T00:00:00Z");
  const end = T("2026-03-09T00:00:00Z");
  const asOf = T("2026-03-20T00:00:00Z");

  it("compares booked participants per assigned activity by arm within a version, including activities with no inviter", async () => {
    const host = await insertUser(pool, { key: "hold-host", name: "Hold Host", createdAt: T("2025-12-01T00:00:00Z") });
    const person = (k: string) => insertUser(pool, { key: `hold-${k}`, name: k, createdAt: T("2025-12-01T00:00:00Z") });
    const u6 = await person("u6");
    const u7 = await person("u7");
    const u8 = await person("u8");
    const u9 = await person("u9");

    const t1 = await insertActivity(pool, { hostId: host, title: "Hold Treatment", startsAt: T("2026-03-03T00:00:00Z"), arm: "treatment", experimentVersion: "h-v1" });
    const t2 = await insertActivity(pool, { hostId: host, title: "Hold Treatment 2", startsAt: T("2026-03-05T00:00:00Z"), arm: "treatment", experimentVersion: "h-v1" });
    const c1 = await insertActivity(pool, { hostId: host, title: "Hold Control", startsAt: T("2026-03-04T00:00:00Z"), arm: "control", experimentVersion: "h-v1" });
    await insertActivity(pool, { hostId: host, title: "Hold Empty Control", startsAt: T("2026-03-06T00:00:00Z"), arm: "control", experimentVersion: "h-v1" });
    // No saved assignment: excluded from the arm comparison entirely.
    await insertActivity(pool, { hostId: host, title: "Hold Unassigned", startsAt: T("2026-03-07T00:00:00Z") });
    const next = await insertActivity(pool, { hostId: host, title: "Hold New Version", startsAt: T("2026-03-07T00:00:00Z"), arm: "treatment", experimentVersion: "h-v2" });

    await insertBooking(pool, { ...t1, userId: u6, createdAt: T("2026-03-02T10:00:00Z") });
    await insertBooking(pool, { ...t1, userId: u7, createdAt: T("2026-03-02T11:00:00Z") });
    await insertBooking(pool, { ...t2, userId: u9, createdAt: T("2026-03-04T01:00:00Z") });
    await insertBooking(pool, { ...c1, userId: u6, createdAt: T("2026-03-03T10:00:00Z") });
    await insertBooking(pool, { ...next, userId: u8, createdAt: T("2026-03-02T10:00:00Z") });
    // A booking after as-of is not yet a fact.
    await insertBooking(pool, { ...t2, userId: u8, createdAt: T("2026-03-25T00:00:00Z") });
    // Only t1 has a booker who invited.
    await insertInvite(pool, { ...t1, code: "H0DT1AAAAAAA", rail: "public_share", creatorId: u6, createdAt: T("2026-03-02T12:00:00Z"), expiresAt: T("2026-03-03T00:00:00Z") });

    // u7 saw the control arm anonymously, signed in, then saw treatment:
    // one person with mixed exposure.
    const device = randomVisitor();
    await insertEvent(pool, { name: "activity_viewed", visitorId: device, activityId: c1.activityId, occurredAt: T("2026-03-02T08:00:00Z") });
    await insertEvent(pool, { name: "account_entry_completed", userId: u7, visitorId: device, occurredAt: T("2026-03-02T08:30:00Z") });
    await insertEvent(pool, { name: "activity_viewed", userId: u7, visitorId: device, activityId: t1.activityId, occurredAt: T("2026-03-02T09:00:00Z") });
    // An exposure with neither account nor device stays visible as unknown.
    await insertEvent(pool, { name: "activity_viewed", activityId: t2.activityId, occurredAt: T("2026-03-02T09:30:00Z") });

    const report = await run("holdout_comparison", { start, end, asOf });
    expect(report.mature).toBe(true);
    const rows = report.results[0]!;
    const treatment = rows.find((r) => r.experiment_version === "h-v1" && r.arm === "treatment")!;
    const control = rows.find((r) => r.experiment_version === "h-v1" && r.arm === "control")!;
    expect(Number(treatment.activities)).toBe(2);
    expect(Number(treatment.booked_participants)).toBe(3);
    expect(Number(treatment.booked_participants_per_activity)).toBeCloseTo(1.5);
    expect(Number(treatment.activities_without_inviter)).toBe(1);
    expect(Number(control.activities)).toBe(2);
    expect(Number(control.booked_participants_per_activity)).toBeCloseTo(0.5);
    expect(Number(control.activities_without_inviter)).toBe(2);
    expect(Number(treatment.difference_vs_control)).toBeCloseTo(1);
    expect(treatment.difference_ci_low).not.toBeNull();
    expect(Number(treatment.difference_ci_low)).toBeLessThan(1);
    expect(Number(treatment.difference_ci_high)).toBeGreaterThan(1);
    expect(Number(treatment.mixed_arm_exposed_people)).toBe(1);
    expect(Number(treatment.unknown_identity_exposures)).toBe(1);
    expect(Number(control.recorded_exposed_people)).toBe(1);
    expect(treatment.actual_occurrence).toBe("unmeasured");
    const v2 = rows.find((r) => r.experiment_version === "h-v2")!;
    expect(Number(v2.activities)).toBe(1);
    expect(v2.difference_vs_control).toBeNull(); // no control arm in that version
    expect(v2.booked_participants_ci_low).toBeNull(); // one activity: no spread

    // Before the cohort's activities have all started, bookings are still open.
    const immature = await run("holdout_comparison", { start, end, asOf: T("2026-03-08T12:00:00Z") });
    expect(immature.mature).toBe(false);
    expect(immature.remainingObservationHours).toBeCloseTo(12);
  });
});

describe("empty and immature cohorts", () => {
  it("reports an empty cohort as empty, never as meeting a target", async () => {
    const adoption = await run("inviter_adoption", {
      start: T("2026-06-01T00:00:00Z"),
      end: T("2026-06-08T00:00:00Z"),
      asOf: T("2026-07-01T00:00:00Z"),
    });
    expect(adoption.empty).toBe(true);
    expect(Number(adoption.results[0]![0]!.bookers)).toBe(0);
    expect(adoption.results[0]![0]!.adoption_rate).toBeNull();

    const conversion = await run("invite_conversion", {
      start: T("2026-06-01T00:00:00Z"),
      end: T("2026-06-08T00:00:00Z"),
      asOf: T("2026-07-01T00:00:00Z"),
    });
    expect(Number(conversion.results[0]![0]!.opportunities)).toBe(0);
    expect(conversion.results[0]![0]!.conversion_rate).toBeNull();

    const completion = await run("holdout_comparison", {
      start: T("2026-06-01T00:00:00Z"),
      end: T("2026-06-08T00:00:00Z"),
      asOf: T("2026-07-01T00:00:00Z"),
    });
    // No assigned activities: no arm rows at all, which is an empty report,
    // not a passing one.
    expect(completion.results[0]).toHaveLength(0);
    expect(completion.empty).toBe(true);
    expect(completion.mature).toBe(true);
    const k = await run("k_factor_by_rail", { start: T("2026-06-01T00:00:00Z"), end: T("2026-06-08T00:00:00Z"), asOf: T("2026-07-01T00:00:00Z") });
    expect(k.empty).toBe(true);
    expect(k.results[0]).toHaveLength(2);
    expect(k.results[0]!.every(r => Number(r.cohort_inviters) === 0 && r.k_factor === null)).toBe(true);
  });

  it("withholds completeness when the as-of clock has not passed the cohort end", async () => {
    const report = await run("k_factor_by_rail", {
      start: T("2026-06-01T00:00:00Z"),
      end: T("2026-06-08T00:00:00Z"),
      asOf: T("2026-06-05T00:00:00Z"),
    });
    for (const row of report.results[0]!) {
      expect(row.mature).toBe(false);
    }
  });
});

function randomVisitor(): string {
  return randomUUID();
}

describe("as-of facts and dataset boundaries", () => {
  it("when an invite is created after as-of, adoption excludes it and K includes hosts of future activities", async () => {
    const host = await insertUser(pool, { key: "time-host", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
    const guest = await insertUser(pool, { key: "time-guest", name: "Guest", createdAt: "2027-01-01T00:00:00Z" });
    const a = await insertActivity(pool, { hostId: host, title: "Time", startsAt: "2027-02-10T00:00:00Z", arm: "treatment" });
    await insertBooking(pool, { ...a, userId: guest, createdAt: "2027-02-02T08:00:00Z" });
    await insertInvite(pool, { ...a, code: "T1ME1AAAAAAA", rail: "public_share", creatorId: guest, createdAt: "2027-02-02T10:00:00Z", expiresAt: "2027-02-09T00:00:00Z" });
    const adoption = await run("inviter_adoption", { start: "2027-02-01T00:00:00Z", end: "2027-02-08T00:00:00Z", asOf: "2027-02-02T09:00:00Z" });
    expect(Number(adoption.results[0]![0]!.bookers)).toBe(1);
    expect(Number(adoption.results[0]![0]!.inviters)).toBe(0);
    expect(adoption.mature).toBe(false);
    const k = await run("k_factor_by_rail", { start: "2027-01-25T00:00:00Z", end: "2027-02-01T00:00:00Z", asOf: "2027-02-03T00:00:00Z" });
    expect(Number(k.results[0]![0]!.cohort_inviters)).toBe(1);
  });

  it("when an open has only a claim event, conversion remains zero until its canonical attribution exists at as-of", async () => {
    const host = await insertUser(pool, { key: "canon-host", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
    const guest = await insertUser(pool, { key: "canon-guest", name: "Guest", createdAt: "2027-01-01T00:00:00Z" });
    const a = await insertActivity(pool, { hostId: host, title: "Canonical", startsAt: "2027-03-20T00:00:00Z", arm: "treatment" });
    const i = await insertInvite(pool, { ...a, code: "CAN0N1AAAAAA", rail: "public_share", creatorId: host, createdAt: "2027-03-01T00:00:00Z", expiresAt: "2027-03-19T00:00:00Z" });
    const visitor = randomVisitor();
    await pool.query("INSERT INTO visitor_identities (visitor_id,user_id,created_at) VALUES ($1,$2,'2027-03-01')", [visitor, host]);
    await insertEvent(pool, { name: "invite_opened", userId: guest, visitorId: visitor, inviteId: i, outcome: "available", channel: "web", occurredAt: "2027-03-02T08:00:00Z" });
    await insertEvent(pool, { name: "spot_claimed", userId: guest, inviteId: i, occurredAt: "2027-03-02T09:00:00Z" });
    const other = await insertInvite(pool, { ...a, code: "CAN0N2AAAAAA", rail: "public_share", creatorId: guest, createdAt: "2027-03-01T00:00:00Z", expiresAt: "2027-03-19T00:00:00Z" });
    await insertEvent(pool, { name: "invite_opened", userId: guest, visitorId: visitor, inviteId: other, outcome: "available", channel: "web", occurredAt: "2027-03-02T08:30:00Z" });
    const inputs = { start: "2027-03-01T00:00:00Z", end: "2027-03-08T00:00:00Z", asOf: "2027-03-09T00:00:00Z" };
    const report = await run("invite_conversion", inputs);
    const total = report.results[0]!.find(r => r.segment === "total")!;
    expect(Number(total.opportunities)).toBe(2);
    expect(Number(total.converted_opportunities)).toBe(0);
    const b = await insertBooking(pool, { ...a, userId: guest, createdAt: "2027-03-02T10:00:00Z" });
    await attributeClaim(b, i, "2027-03-02T10:00:00Z");
    const before = await run("invite_conversion", { ...inputs, asOf: "2027-03-02T09:00:00Z" });
    expect(Number(before.results[0]!.find(r => r.segment === "total")!.converted_opportunities)).toBe(0);
    const after = await run("invite_conversion", inputs);
    expect(Number(after.results[0]!.find(r => r.segment === "total")!.converted_opportunities)).toBe(1);
  });

  it("when a real inviter acquires a real person through a demo activity, K excludes that crossing", async () => {
    const host = await insertUser(pool, { key: "cross-host", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
    await insertActivity(pool, { hostId: host, title: "Pre-cohort", startsAt: "2027-03-20T00:00:00Z", arm: "treatment" });
    const a = await insertActivity(pool, { hostId: host, title: "Synthetic crossing", startsAt: "2027-04-20T00:00:00Z", arm: "treatment", dataset: "demo" });
    const i = await insertInvite(pool, { ...a, code: "CR0SS1AAAAAA", rail: "public_share", creatorId: host, createdAt: "2027-04-01T00:00:00Z", expiresAt: "2027-04-19T00:00:00Z" });
    await insertUser(pool, { key: "cross-new", name: "New", createdAt: "2027-04-02T00:00:00Z", signupSource: "public_share", generation: 1, signupInviteId: i });
    const report = await run("k_factor_by_rail", { start: "2027-04-01T00:00:00Z", end: "2027-04-08T00:00:00Z", asOf: "2027-04-09T00:00:00Z" });
    expect(Number(report.results[0]!.find(r => r.rail === "public_share")!.acquired_users)).toBe(0);
  });

  it("when control is absent and a booking is later than as-of, comparison stays unknown and the booking is excluded", async () => {
    const host = await insertUser(pool, { key: "alone-host", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
    const guest = await insertUser(pool, { key: "alone-guest", name: "Guest", createdAt: "2027-01-01T00:00:00Z" });
    const a = await insertActivity(pool, { hostId: host, title: "Alone", startsAt: "2027-05-03T00:00:00Z", arm: "treatment", experimentVersion: "alone" });
    await insertBooking(pool, { ...a, userId: guest, createdAt: "2027-05-02T12:00:00Z" });
    const report = await run("holdout_comparison", { start: "2027-05-01T00:00:00Z", end: "2027-05-08T00:00:00Z", asOf: "2027-05-02T10:00:00Z" });
    const row = report.results[0]![0]!;
    expect(Number(row.booked_participants)).toBe(0);
    expect(row.difference_vs_control).toBeNull();
  });

  it("when application credentials set or change dataset labels, PostgreSQL refuses them and accepts ordinary defaults", async () => {
    const u = await insertUser(pool, { key: "label-guard", name: "Guard", createdAt: "2027-01-01T00:00:00Z" });
    const a = await insertActivity(pool, { hostId: u, title: "Guard", startsAt: "2027-06-02T00:00:00Z" });
    await expect(reportingPool.query("UPDATE activities SET dataset='demo' WHERE id=$1", [a.activityId])).rejects.toThrow();
    await expect(reportingPool.query("INSERT INTO users (contact_key,display_name,signup_source,signup_generation,dataset) VALUES ('app-label','App','direct',0,'demo')")).rejects.toThrow();
    await expect(reportingPool.query("INSERT INTO users (contact_key,display_name,signup_source,signup_generation) VALUES ('app-default','App','direct',0)")).resolves.toMatchObject({ rowCount: 1 });
  });
});


it.each([false, true])("when demo-prefixed real records exist (both arms=%s), seeding labels only its own new records and reruns reuse them", async (bothArms) => {
  const user = await insertUser(pool, { key: "demo-unrelated-real", name: "Real", createdAt: "2026-01-01T00:00:00Z" });
  await insertActivity(pool, { hostId: user, title: "[demo] unrelated treatment", startsAt: "2030-01-01T00:00:00Z", arm: "treatment" });
  if (bothArms) await insertActivity(pool, { hostId: user, title: "[demo] unrelated control", startsAt: "2030-01-01T00:00:00Z", arm: "control" });
  const seed = () => execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-experiment-demo.mts"], {
    env: { ...process.env, DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: migrationUrl }, encoding: "utf8", timeout: 15000,
  });
  seed();
  const first = await pool.query("SELECT id,dataset FROM activities ORDER BY id");
  expect(first.rows.filter(r => r.dataset === "demo")).toHaveLength(2);
  expect(first.rows.filter(r => r.dataset === "real")).toHaveLength(bothArms ? 2 : 1);
  expect((await pool.query("SELECT dataset FROM users WHERE id=$1", [user])).rows[0]!.dataset).toBe("real");
  seed();
  expect((await pool.query("SELECT id,dataset FROM activities ORDER BY id")).rows).toEqual(first.rows);
});

it("when anonymous opens precede the cohort or lead to a started activity, conversion preserves their first-open boundary", async () => {
  const h = await insertUser(pool, { key: "boundary-h", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
  const u = await insertUser(pool, { key: "boundary-u", name: "Booker", createdAt: "2027-01-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: h, title: "Started", startsAt: "2027-07-01T00:00:00Z", arm: "treatment" });
  const i = await insertInvite(pool, { ...a, code: "B0VNDARYAAAA", rail: "vouch", creatorId: h, createdAt: "2027-06-01T00:00:00Z", expiresAt: "2027-07-01T00:00:00Z", targetContactKey: "boundary-u" });
  const v = randomVisitor();
  await insertEvent(pool, { name: "invite_opened", visitorId: v, inviteId: i, channel: "flutter", outcome: "available", occurredAt: "2027-06-30T08:00:00Z" });
  await insertEvent(pool, { name: "account_entry_completed", userId: u, visitorId: v, occurredAt: "2027-06-30T09:00:00Z" });
  await insertEvent(pool, { name: "invite_opened", visitorId: v, userId: u, inviteId: i, channel: "flutter", outcome: "expired", occurredAt: "2027-07-02T08:00:00Z" });
  await insertEvent(pool, { name: "invite_opened", visitorId: randomVisitor(), inviteId: i, channel: "flutter", outcome: "expired", occurredAt: "2027-07-03T08:00:00Z" });
  const report = await run("invite_conversion", { start: "2027-07-01T00:00:00Z", end: "2027-07-08T00:00:00Z", asOf: "2027-07-09T00:00:00Z" });
  const total = report.results[0]!.find(r => r.segment === "total")!;
  expect(Number(total.opportunities)).toBe(1);
  expect(Number(total.converted_opportunities)).toBe(0);
  expect(Number(total.closed_landings)).toBe(1);
  expect(report.results[0]!.find(r => r.rail === "vouch")!.channel).toBe("flutter");
});

it("when acquisition or booking occurs after as-of, K preserves its fixed denominator and excludes those later outcomes", async () => {
  const h = await insertUser(pool, { key: "k-time-h", name: "Host", createdAt: "2027-01-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: h, title: "K time", startsAt: "2027-08-20T00:00:00Z", arm: "treatment" });
  const i = await insertInvite(pool, { ...a, code: "KT1MEAAAAAAA", rail: "public_share", creatorId: h, createdAt: "2027-08-01T00:00:00Z", expiresAt: "2027-08-19T00:00:00Z" });
  const u = await insertUser(pool, { key: "k-time-u", name: "Acquired", createdAt: "2027-08-02T00:00:00Z", signupSource: "public_share", generation: 1, signupInviteId: i });
  await insertUser(pool, { key: "k-time-later", name: "Later", createdAt: "2027-08-04T00:00:00Z", signupSource: "public_share", generation: 1, signupInviteId: i });
  await insertBooking(pool, { ...a, userId: u, createdAt: "2027-08-05T00:00:00Z" });
  const inputs = { start: "2027-08-01T00:00:00Z", end: "2027-08-08T00:00:00Z", asOf: "2027-08-03T00:00:00Z" };
  const report = await run("k_factor_by_rail", inputs);
  const row = report.results[0]!.find(r => r.rail === "public_share")!;
  expect(Number(row.cohort_inviters)).toBe(1);
  expect(Number(row.acquired_users)).toBe(1);
  expect(Number(row.acquired_users_who_booked)).toBe(0);
  expect(report.remainingObservationHours).toBe(120);
  const after = await run("k_factor_by_rail", { ...inputs, asOf: "2027-08-09T00:00:00Z" });
  expect(Number(after.results[0]!.find(r => r.rail === "public_share")!.acquired_users)).toBe(2);
  expect(Number(after.results[0]!.find(r => r.rail === "public_share")!.acquired_users_who_booked)).toBe(1);
});

it("when every fixture fact is labeled demo, all real reports exclude it and explicit demo returns exact samples", async () => {
  const h = await insertUser(pool, { key: "all-demo-h", name: "Host", dataset: "demo", createdAt: "2027-01-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: h, title: "Demo treatment", startsAt: "2027-09-03T00:00:00Z", arm: "treatment", dataset: "demo" });
  await insertActivity(pool, { hostId: h, title: "Demo control", startsAt: "2027-09-03T00:00:00Z", arm: "control", dataset: "demo" });
  const i = await insertInvite(pool, { ...a, code: "A11DEM0AAAAA", rail: "public_share", creatorId: h, createdAt: "2027-09-01T00:00:00Z", expiresAt: "2027-09-03T00:00:00Z" });
  const u = await insertUser(pool, { key: "all-demo-u", name: "Acquired", dataset: "demo", createdAt: "2027-09-02T08:30:00Z", signupSource: "public_share", generation: 1, signupInviteId: i });
  const v = randomVisitor();
  await insertEvent(pool, { name: "invite_opened", visitorId: v, inviteId: i, activityId: a.activityId, channel: "web", outcome: "available", occurredAt: "2027-09-02T08:00:00Z" });
  await insertEvent(pool, { name: "account_entry_completed", userId: u, visitorId: v, occurredAt: "2027-09-02T08:30:00Z" });
  const b = await insertBooking(pool, { ...a, userId: u, createdAt: "2027-09-02T09:00:00Z" });
  await attributeClaim(b,i,"2027-09-02T09:00:00Z");
  await insertInvite(pool, { ...a, code: "A11DEM0BBBBB", rail: "vouch", creatorId: u, targetContactKey: "demo-next", createdAt: "2027-09-02T10:00:00Z", expiresAt: "2027-09-03T00:00:00Z" });
  const inputs = { start: "2027-09-01T00:00:00Z", end: "2027-09-08T00:00:00Z", asOf: "2027-09-10T00:00:00Z" };
  const realAdoption = await run("inviter_adoption", inputs);
  expect(Number(realAdoption.results[0]![0]!.bookers)).toBe(0);
  const realConversion = await run("invite_conversion", inputs);
  expect(Number(realConversion.results[0]!.find(r => r.segment === "total")!.opportunities)).toBe(0);
  const realK = await run("k_factor_by_rail", inputs);
  expect(realK.results[0]!.every(r => Number(r.cohort_inviters) === 0 && r.k_factor === null)).toBe(true);
  expect((await run("holdout_comparison", inputs)).results[0]).toHaveLength(0);
  const demo = { ...inputs, dataset: "demo" };
  const adoption = (await run("inviter_adoption", demo)).results[0]![0]!;
  expect(Number(adoption.bookers)).toBe(1);
  expect(Number(adoption.inviters)).toBe(1);
  const conversion = (await run("invite_conversion", demo)).results[0]!.find(r => r.segment === "total")!;
  expect(Number(conversion.opportunities)).toBe(1);
  expect(Number(conversion.converted_opportunities)).toBe(1);
  const k = (await run("k_factor_by_rail", demo)).results[0]!.find(r => r.rail === "public_share")!;
  expect(Number(k.cohort_inviters)).toBe(1);
  expect(Number(k.acquired_users)).toBe(1);
  expect(Number(k.acquired_users_who_booked)).toBe(1);
  const holdout = (await run("holdout_comparison", demo)).results[0]!;
  expect(Number(holdout.find(r => r.arm === "treatment")!.booked_participants)).toBe(1);
  expect(Number(holdout.find(r => r.arm === "control")!.activities)).toBe(1);
});

it("when two accounts use one device in separate visits, each anonymous opening belongs to its own visit's account", async () => {
  const host = await insertUser(pool, { key: "switch-host", name: "Host", createdAt: "2027-10-01T00:00:00Z" });
  const first = await insertUser(pool, { key: "switch-a", name: "First", createdAt: "2027-10-01T00:00:00Z" });
  const second = await insertUser(pool, { key: "switch-b", name: "Second", createdAt: "2027-10-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: host, title: "Shared device", startsAt: "2027-11-01T00:00:00Z", arm: "treatment" });
  const firstInvite = await insertInvite(pool, { ...a, code: "SW1TCHAAAAAA", rail: "public_share", creatorId: host, createdAt: "2027-10-01T00:00:00Z", expiresAt: "2027-11-01T00:00:00Z" });
  const secondInvite = await insertInvite(pool, { ...a, code: "SW1TCHBBBBBB", rail: "vouch", targetContactKey: "switch-b", creatorId: host, createdAt: "2027-10-01T00:00:00Z", expiresAt: "2027-11-01T00:00:00Z" });
  const device = randomVisitor();
  const visit1 = randomUUID();
  const visit2 = randomUUID();
  // The device link is written once, for the first account ever used there.
  await pool.query("INSERT INTO visitor_identities (visitor_id,user_id,created_at) VALUES ($1,$2,'2027-10-02T08:05:00Z')", [device, first]);
  await insertEvent(pool, { name: "invite_opened", visitorId: device, inviteId: firstInvite, channel: "flutter", outcome: "available", occurredAt: "2027-10-02T08:00:00Z", details: { visitId: visit1 } });
  await insertEvent(pool, { name: "account_entry_completed", userId: first, visitorId: device, occurredAt: "2027-10-02T08:05:00Z", details: { visitId: visit1 } });
  await insertEvent(pool, { name: "invite_opened", visitorId: device, inviteId: secondInvite, channel: "flutter", outcome: "available", occurredAt: "2027-10-03T08:00:00Z", details: { visitId: visit2 } });
  await insertEvent(pool, { name: "claim_started", visitorId: device, inviteId: secondInvite, occurredAt: "2027-10-03T08:01:00Z", details: { visitId: visit2 } });
  await insertEvent(pool, { name: "account_entry_completed", userId: second, visitorId: device, occurredAt: "2027-10-03T08:05:00Z", details: { visitId: visit2 } });
  const booking = await insertBooking(pool, { ...a, userId: second, createdAt: "2027-10-03T08:10:00Z" });
  await attributeClaim(booking, secondInvite, "2027-10-03T08:10:00Z");

  // A third visit opens the first invitation and leaves without signing in;
  // the next account on the device (a different visit) must not inherit it.
  const visit3 = randomUUID();
  await insertEvent(pool, { name: "invite_opened", visitorId: device, inviteId: firstInvite, channel: "flutter", outcome: "available", occurredAt: "2027-10-04T08:00:00Z", details: { visitId: visit3 } });
  await insertEvent(pool, { name: "account_entry_completed", userId: second, visitorId: device, occurredAt: "2027-10-04T10:00:00Z", details: { visitId: randomUUID() } });

  const report = await run("invite_conversion", { start: "2027-10-01T00:00:00Z", end: "2027-10-08T00:00:00Z", asOf: "2027-10-09T00:00:00Z" });
  const total = report.results[0]!.find(r => r.segment === "total")!;
  // first+firstInvite, second+secondInvite, and the unlinked visit-3 visitor.
  expect(Number(total.opportunities)).toBe(3);
  expect(Number(total.converted_opportunities)).toBe(1);
  expect(Number(total.claim_started_opportunities)).toBe(1);
  // Only the two visits that entered an account are linked to one.
  expect(Number(total.identity_completed_people_in_window)).toBe(2);
});

it("when a booker copies one public invitation repeatedly, adoption counts the first creation once and share actions separately", async () => {
  const host = await insertUser(pool, { key: "share-host", name: "Host", createdAt: "2027-12-01T00:00:00Z" });
  const sharer = await insertUser(pool, { key: "share-sharer", name: "Sharer", createdAt: "2027-12-01T00:00:00Z" });
  const viewer = await insertUser(pool, { key: "share-viewer", name: "Viewer", createdAt: "2027-12-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: host, title: "Share", startsAt: "2027-12-20T00:00:00Z", arm: "treatment" });
  await insertBooking(pool, { ...a, userId: sharer, createdAt: "2027-12-02T08:00:00Z" });
  await insertBooking(pool, { ...a, userId: viewer, createdAt: "2027-12-02T09:00:00Z" });
  const invite = await insertInvite(pool, { ...a, code: "SHARE1AAAAAA", rail: "public_share", creatorId: sharer, createdAt: "2027-12-02T08:05:00Z", expiresAt: "2027-12-20T00:00:00Z" });
  for (const minute of ["05", "06", "30"]) {
    await insertEvent(pool, { name: "invite_share_action", userId: sharer, activityId: a.activityId, inviteId: invite, occurredAt: `2027-12-02T08:${minute}:00Z`, details: { shareMethod: "copy" } });
  }
  // Displaying the confirmation (and its sharing controls) is not inviting.
  await insertEvent(pool, { name: "activity_viewed", userId: viewer, activityId: a.activityId, occurredAt: "2027-12-02T09:01:00Z" });

  const report = await run("inviter_adoption", { start: "2027-12-01T00:00:00Z", end: "2027-12-08T00:00:00Z", asOf: "2027-12-10T00:00:00Z" });
  const row = report.results[0]![0]!;
  expect(Number(row.bookers)).toBe(2);
  expect(Number(row.inviters)).toBe(1);
  expect(Number(row.adoption_rate)).toBeCloseTo(0.5);
  expect(Number(row.share_actions)).toBe(3);
  expect(Number(row.bookers_with_share_actions)).toBe(1);
});

it("when acquisition and later bookings use different sources, the audit keeps signup source and generation distinct from each booking source", async () => {
  const host = await insertUser(pool, { key: "audit-host", name: "Host", createdAt: "2027-12-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: host, title: "Audit A", startsAt: "2028-01-20T00:00:00Z", arm: "treatment" });
  const b = await insertActivity(pool, { hostId: host, title: "Audit B", startsAt: "2028-01-21T00:00:00Z", arm: "treatment" });
  const returning = await insertUser(pool, { key: "audit-returning", name: "Returning", createdAt: "2027-12-01T00:00:00Z" });
  const hostInvite = await insertInvite(pool, { ...a, code: "AVD1TAAAAAAA", rail: "public_share", creatorId: host, createdAt: "2028-01-02T00:00:00Z", expiresAt: "2028-01-20T00:00:00Z" });
  // Newly acquired through the host's invitation (generation 1).
  const acquired = await insertUser(pool, { key: "audit-new", name: "New", createdAt: "2028-01-03T00:00:00Z", signupSource: "public_share", generation: 1, signupInviteId: hostInvite });
  const first = await insertBooking(pool, { ...a, userId: acquired, createdAt: "2028-01-03T00:10:00Z" });
  await attributeClaim(first, hostInvite, "2028-01-03T00:10:00Z");
  // The acquired account later books another activity directly.
  await insertBooking(pool, { ...b, userId: acquired, createdAt: "2028-01-04T00:00:00Z" });
  // A returning account books through an invitation: no acquisition.
  const returningBooking = await insertBooking(pool, { ...a, userId: returning, createdAt: "2028-01-04T01:00:00Z" });
  await attributeClaim(returningBooking, hostInvite, "2028-01-04T01:00:00Z");
  // Second generation: acquired through the acquired account's invitation.
  const secondInvite = await insertInvite(pool, { ...a, code: "AVD1TBBBBBBB", rail: "vouch", targetContactKey: "audit-second", creatorId: acquired, createdAt: "2028-01-05T00:00:00Z", expiresAt: "2028-01-20T00:00:00Z" });
  const second = await insertUser(pool, { key: "audit-second", name: "Second", createdAt: "2028-01-05T01:00:00Z", signupSource: "vouch", generation: 2, signupInviteId: secondInvite });

  const report = await run("acquisition_audit", { start: "2028-01-01T00:00:00Z", end: "2028-01-08T00:00:00Z", asOf: "2028-01-10T00:00:00Z" });
  const rows = report.results[0]!;
  const row = (id: string) => rows.find((r) => r.account_id === id)!;
  expect(row(acquired)).toMatchObject({ signup_source: "public_share", signup_generation: 1, signup_inviter_id: host, acquired_in_cohort: true });
  expect(row(acquired).booking_sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "public_share", generation: 1, inviter_id: host }),
    expect.objectContaining({ source: "direct", generation: null, inviter_id: null }),
  ]));
  expect(row(returning)).toMatchObject({ signup_source: "direct", signup_generation: 0, acquired_in_cohort: false });
  expect(row(returning).booking_sources).toEqual([expect.objectContaining({ source: "public_share", inviter_id: host })]);
  expect(row(second)).toMatchObject({ signup_source: "vouch", signup_generation: 2, signup_inviter_id: acquired, acquired_in_cohort: true, booking_sources: [] });
  expect(rows.find((r) => r.account_id === host)).toBeUndefined(); // neither acquired nor booking in the cohort
  // The host existed and hosted before the cohort, so its acquisition counts
  // toward K; the second generation was invited by a cohort newcomer.
  expect(row(acquired).in_k_factor_numerator).toBe(true);
  expect(row(second).in_k_factor_numerator).toBe(false);
  expect(row(returning).in_k_factor_numerator).toBe(false);
});

it("when reports run, rates carry uncertainty and only a mature, non-empty real cohort is judged against its target", async () => {
  const host = await insertUser(pool, { key: "assess-host", name: "Host", createdAt: "2028-02-01T00:00:00Z" });
  const inviter = await insertUser(pool, { key: "assess-inviter", name: "Inviter", createdAt: "2028-02-01T00:00:00Z" });
  const quiet = await insertUser(pool, { key: "assess-quiet", name: "Quiet", createdAt: "2028-02-01T00:00:00Z" });
  const a = await insertActivity(pool, { hostId: host, title: "Assess", startsAt: "2028-02-20T00:00:00Z", arm: "treatment" });
  await insertBooking(pool, { ...a, userId: inviter, createdAt: "2028-02-02T08:00:00Z" });
  await insertBooking(pool, { ...a, userId: quiet, createdAt: "2028-02-02T09:00:00Z" });
  const invite = await insertInvite(pool, { ...a, code: "ASSESSAAAAAA", rail: "public_share", creatorId: inviter, createdAt: "2028-02-02T08:10:00Z", expiresAt: "2028-02-20T00:00:00Z" });
  for (const hour of ["10", "11", "12", "13"]) {
    await insertEvent(pool, { name: "invite_opened", visitorId: randomVisitor(), inviteId: invite, channel: "flutter", outcome: "available", occurredAt: `2028-02-02T${hour}:00:00Z` });
  }
  const week = { start: "2028-02-01T00:00:00Z", end: "2028-02-08T00:00:00Z" };
  const mature = { ...week, asOf: "2028-02-10T00:00:00Z" };

  const adoption = await run("inviter_adoption", mature);
  const row = adoption.results[0]![0]!;
  expect(Number(row.adoption_rate)).toBeCloseTo(0.5);
  expect(row.adoption_rate_ci_low).toBeCloseTo(0.0945, 3); // Wilson 95%, 1 of 2
  expect(row.adoption_rate_ci_high).toBeCloseTo(0.9055, 3);
  expect(adoption.assessment).toMatchObject({ target: 0.3, observed: 0.5, status: "meets", trigger: null });

  const conversion = await run("invite_conversion", mature);
  expect(conversion.assessment).toMatchObject({ target: 0.25, observed: 0, status: "below" });
  expect(conversion.assessment.trigger).toContain("below 25%");
  const total = conversion.results[0]!.find((r) => r.segment === "total")!;
  expect(total.conversion_rate_ci_low).toBe(0);
  expect(Number(total.conversion_rate_ci_high)).toBeGreaterThan(0);

  const immature = await run("inviter_adoption", { ...week, asOf: "2028-02-08T12:00:00Z" });
  expect(immature.assessment.status).toBe("not_assessable");
  expect(immature.assessment.reasons).toContain("incomplete_window");
  const demo = await run("inviter_adoption", { ...mature, dataset: "demo" });
  expect(demo.assessment.status).toBe("not_assessable");
  expect(demo.assessment.reasons).toEqual(expect.arrayContaining([expect.stringContaining("demo_dataset"), "empty_sample"]));
  const empty = await run("invite_conversion", { start: "2028-03-01T00:00:00Z", end: "2028-03-08T00:00:00Z", asOf: "2028-03-10T00:00:00Z" });
  expect(empty.assessment).toMatchObject({ status: "not_assessable", reasons: ["empty_sample"], observed: null });

  const k = await run("k_factor_by_rail", mature);
  expect(k.assessment).toMatchObject({ status: "descriptive", target: null });
  expect(k.assessment.note).toContain("No numerical K-factor target");
  expect(k.results[0]![0]).toHaveProperty("k_factor_ci_high");
});

it("bounds K-factor with an exact Poisson interval that widens monotonically with the count", () => {
  const [zeroLow, zeroHigh] = poissonInterval(0);
  expect(zeroLow).toBe(0);
  expect(zeroHigh).toBeCloseTo(3.689, 2);
  const [oneLow, oneHigh] = poissonInterval(1);
  expect(oneLow).toBeCloseTo(0.0253, 3);
  expect(oneHigh).toBeCloseTo(5.572, 2);
  expect(poissonInterval(10)[1]).toBeCloseTo(18.39, 1);
});
