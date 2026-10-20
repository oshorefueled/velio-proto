import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { bookActivity, type BookingDeps } from "../src/booking/service.ts";
import { createPublicShare, type InvitesDeps } from "../src/invites/service.ts";
import { ActivitySoldOutError } from "../src/booking/domain.ts";
import { InviteExpiredError, InviteNotFoundError } from "../src/invites/domain.js";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let redis: Redis;
let booking: BookingDeps;
let activities: ActivitiesDeps;
let invites: InvitesDeps;
let host: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  const quota = { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 };
  booking = {
    pool,
    redis,
    quota,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
  };
  activities = { pool, experiment: { allocationPercent: 100, experimentVersion: "t6-claim" } };
  invites = {
    pool,
    redis,
    inviteCreationEnabled: true,
    expiryHours: 336,
    creationQuota: quota,
    resolveQuota: { perIp: quota.perIp, windowSeconds: quota.windowSeconds },
  };
  host = (await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("claim-host"), displayName: "Claim Host" })).user;
  return () => {
    redis.quit();
    return pool.end();
  };
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function newPerson(displayName: string): Promise<UserSnapshot> {
  return (
    await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("claim"), displayName })
  ).user;
}

async function publishTreatment(title: string, spots = 5): Promise<string> {
  const result = await publishActivity(activities, host, { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title,
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
    timezone: "UTC",
    priceMinorUnits: 1000,
    currency: "EUR",
    spots,
  });
  return result.activity.id;
}

async function attributionFor(bookingId: string) {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `SELECT rail, generation, inviter_id, invite_id, code
         FROM booking_attributions WHERE booking_id = $1`,
        [bookingId],
      )
      .then((r) => r.rows[0] as Record<string, unknown>),
  );
}

describe("claiming through a public share", () => {
  it("attributes the claim to the share, joins the same plan and records spot_claimed once", async () => {
    const activityId = await publishTreatment("Claim Attribution");
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const guest = await newPerson("Claimed Guest");

    const result = await bookActivity(booking, guest, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: share.code,
    });
    expect(result.created).toBe(true);

    const attribution = await attributionFor(result.booking.id);
    expect(attribution).toMatchObject({
      rail: "public_share",
      generation: 1,
      inviter_id: host.id,
      invite_id: share.id,
      code: share.code,
    });
    expect(result.booking.planId).toBe(share.planId);
    expect(result.booking.attribution).toMatchObject({ rail: "public_share", generation: 1 });

    const events = await withClient(migrationUrl, (client) =>
      client.query(
        `SELECT event_name, count(*)::int AS n FROM events
         WHERE booking_id = $1 AND event_name IN ('booking_confirmed', 'spot_claimed')
         GROUP BY event_name`,
        [result.booking.id],
      ),
    );
    expect(events.rows).toEqual([
      { event_name: "booking_confirmed", n: 1 },
      { event_name: "spot_claimed", n: 1 },
    ]);

    // The attempt evidence records the invited source.
    const attempts = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT details ->> 'source' AS source FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
        [guest.id],
      ),
    );
    expect(attempts.rows.map((row) => row.source)).toEqual(["public_share"]);
    await bookActivity(booking, guest, activityId, {
      ip: uniqueIp(), operationId: randomUUID(), inviteCode: share.code,
    });
    const replayAttempt = await pool.query(
      "SELECT details ->> 'source' AS source FROM events WHERE event_name = 'booking_attempted' AND user_id = $1 AND details ->> 'outcome' = 'existing'",
      [guest.id],
    );
    expect(replayAttempt.rows).toEqual([{ source: "public_share" }]);
  });

  it("refuses a claim when the invite expires while waiting for the activity lock", async () => {
    const activityId = await publishTreatment("Claim Wait Expiry");
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const guest = await newPerson("Waiting Guest");
    await withClient(migrationUrl, async (client) => {
      await client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable");
      try {
        await client.query("UPDATE invites SET expires_at = clock_timestamp() + interval '2 seconds' WHERE id = $1", [share.id]);
      } finally {
        await client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable");
      }
      await client.query("BEGIN");
      await client.query("SELECT id FROM activities WHERE id = $1 FOR UPDATE", [activityId]);
      const outcome = bookActivity({ ...booking, lockTimeoutMs: 5000 }, guest, activityId, {
        ip: uniqueIp(), operationId: randomUUID(), inviteCode: share.code,
      }).then(() => null, (error: unknown) => error);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const locks = await client.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid' AND transactionid IN (SELECT transactionid FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'transactionid' AND granted)");
          waiting = locks.rowCount !== 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await client.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))) + 0.05) FROM invites WHERE id = $1", [share.id]);
      } finally {
        await client.query("ROLLBACK");
      }
      expect(await outcome).toBeInstanceOf(InviteExpiredError);
    });
    const state = await pool.query("SELECT booked_count, (SELECT count(*)::int FROM events WHERE activity_id = $1 AND event_name = 'spot_claimed') AS claims FROM activities WHERE id = $1", [activityId]);
    expect(state.rows[0]).toMatchObject({ booked_count: 0, claims: 0 });
  });

  it("lets different guests reuse one public link onto the same plan", async () => {
    const activityId = await publishTreatment("Claim Reuse", 5);
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const first = await newPerson("Reuse Guest One");
    const second = await newPerson("Reuse Guest Two");

    const one = await bookActivity(booking, first, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: share.code,
    });
    const two = await bookActivity(booking, second, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: share.code,
    });
    expect(one.created).toBe(true);
    expect(two.created).toBe(true);
    expect(one.booking.planId).toBe(two.booking.planId);
    expect(one.booking.id).not.toBe(two.booking.id);
  });

  it("keeps the committed booking and its source when replaying after expiry", async () => {
    const activityId = await publishTreatment("Claim Replay Expired");
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const guest = await newPerson("Expiry Replay Guest");
    const operationId = randomUUID();
    const first = await bookActivity(booking, guest, activityId, {
      ip: uniqueIp(),
      operationId,
      inviteCode: share.code,
    });
    expect(first.created).toBe(true);

    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable"),
    );
    await withClient(migrationUrl, (client) =>
      client.query(
        "UPDATE invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute' WHERE id = $1",
        [share.id],
      ),
    );
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable"),
    );

    // A replay — same person, any operation — returns the committed booking
    // with its original attribution; the dead code can neither rewrite it
    // nor double-charge a seat.
    const replay = await bookActivity(booking, guest, activityId, {
      ip: uniqueIp(),
      operationId,
      inviteCode: share.code,
    });
    expect(replay).toMatchObject({ created: false, booking: { id: first.booking.id } });
    const freshGuest = await newPerson("Expiry Fresh Guest");
    await expect(
      bookActivity(booking, freshGuest, activityId, {
        ip: uniqueIp(),
        operationId: randomUUID(),
        inviteCode: share.code,
      }),
    ).rejects.toBeInstanceOf(InviteExpiredError);

    const attribution = await attributionFor(first.booking.id);
    expect(attribution).toMatchObject({ rail: "public_share", generation: 1 });
    const seats = await withClient(migrationUrl, (client) =>
      client.query("SELECT booked_count FROM activities WHERE id = $1", [activityId]),
    );
    expect(seats.rows[0].booked_count).toBe(1);
  });

  it("refuses a new claim when the share's activity is full without consuming a spot", async () => {
    const activityId = await publishTreatment("Claim Sellout", 1);
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const winner = await newPerson("Sellout Winner");
    const loser = await newPerson("Sellout Loser");
    await bookActivity(booking, winner, activityId, { ip: uniqueIp(), operationId: randomUUID() });

    await expect(
      bookActivity(booking, loser, activityId, {
        ip: uniqueIp(),
        operationId: randomUUID(),
        inviteCode: share.code,
      }),
    ).rejects.toBeInstanceOf(ActivitySoldOutError);
    const seats = await withClient(migrationUrl, (client) =>
      client.query("SELECT booked_count FROM activities WHERE id = $1", [activityId]),
    );
    expect(seats.rows[0].booked_count).toBe(1);
  });

  it("returns the existing booking with its original direct source when a booked person claims a link", async () => {
    const activityId = await publishTreatment("Claim Already Booked");
    const share = await createPublicShare(invites, host, activityId, { ip: uniqueIp() });
    const booker = await newPerson("Already Booked");
    const direct = await bookActivity(booking, booker, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
    });
    expect(direct.created).toBe(true);

    const viaInvite = await bookActivity(booking, booker, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: share.code,
    });
    expect(viaInvite).toMatchObject({ created: false, booking: { id: direct.booking.id } });
    const attribution = await attributionFor(direct.booking.id);
    expect(attribution).toMatchObject({ rail: "direct", generation: 0, inviter_id: null, invite_id: null });
    const conversions = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'spot_claimed' AND user_id = $1",
        [booker.id],
      ),
    );
    expect(conversions.rows[0].n).toBe(0);
  });

  it("refuses unknown codes and ignores forged source fields", async () => {
    const activityId = await publishTreatment("Claim Forged");
    const guest = await newPerson("Forged Fields Guest");
    // Nothing in the request body can declare a source: rail, inviter and
    // generation are not booking inputs at all, so unknown keys are ignored
    // and the attribution stays direct.
    const result = await bookActivity(booking, guest, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( { rail: "public_share", generation: 99, inviterId: host.id } as any),
    } as Parameters<typeof bookActivity>[3]);
    expect(result.created).toBe(true);
    const attribution = await attributionFor(result.booking.id);
    expect(attribution).toMatchObject({ rail: "direct", generation: 0 });

    // A guest without a committed booking is refused by the unknown code;
    // the original guest's replay is covered by the expiry test above.
    const codeGuest = await newPerson("Unknown Code Guest");
    await expect(
      bookActivity(booking, codeGuest, activityId, {
        ip: uniqueIp(),
        operationId: randomUUID(),
        inviteCode: "ZZZZZZZZZZZZ",
      }),
    ).rejects.toBeInstanceOf(InviteNotFoundError);

    const attempts = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
        [codeGuest.id],
      ),
    );
    expect(attempts.rows.map((row) => row.outcome)).toEqual(["invite_not_found"]);
    const source = await pool.query("SELECT details ->> 'source' AS source FROM events WHERE event_name = 'booking_attempted' AND user_id = $1", [codeGuest.id]);
    expect(source.rows).toEqual([{ source: "invited" }]);
  });

  it("refuses malformed and unknown codes identically as not found, consuming nothing", async () => {
    const activityId = await publishTreatment("Claim Bad Codes");
    const guest = await newPerson("Bad Codes Guest");
    for (const code of ["BADCODE!", "ZZZZZZZZZZZZ"]) {
      await expect(
        bookActivity(booking, guest, activityId, {
          ip: uniqueIp(),
          operationId: randomUUID(),
          inviteCode: code,
        }),
      ).rejects.toBeInstanceOf(InviteNotFoundError);
    }
    const state = await withClient(migrationUrl, (client) =>
      client.query(
        `SELECT (SELECT booked_count FROM activities WHERE id = $1) AS booked,
                (SELECT count(*)::int FROM events WHERE event_name = 'spot_claimed' AND activity_id = $1) AS conversions`,
        [activityId],
      ),
    );
    expect(state.rows[0]).toMatchObject({ booked: 0, conversions: 0 });
  });
});

let ipCounter = 0;

function uniqueIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(Date.now() / 1000) % 250}.${ipCounter % 250}.${ipCounter}`;
}
