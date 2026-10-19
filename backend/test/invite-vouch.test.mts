import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity, type IdentityDeps } from "../src/identity/service.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { bookActivity, type BookingDeps } from "../src/booking/service.ts";
import { createInvite, resolveInvite, type InvitesDeps } from "../src/invites/service.ts";
import { ActivityStartedError } from "../src/booking/domain.ts";
import { InviteRecipientMismatchError } from "../src/invites/domain.js";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let identity: IdentityDeps;
let activities: ActivitiesDeps;
let booking: BookingDeps;
let invites: InvitesDeps;
let host: UserSnapshot;
let nextContact = 0;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  const redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  identity = { pool, sessionTtlHours: 12 };
  activities = { pool, experiment: { allocationPercent: 100, experimentVersion: "t7" } };
  const quota = { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 };
  booking = { pool, redis, quota, lockTimeoutMs: 2000, statementTimeoutMs: 5000 };
  invites = {
    pool,
    redis,
    inviteCreationEnabled: true,
    expiryHours: 336,
    creationQuota: quota,
    resolveQuota: { perIp: quota.perIp, windowSeconds: quota.windowSeconds },
  };
  host = (await establishIdentity(identity, { contactKey: uniqueContact("host"), displayName: "Vouch Host" })).user;
  return () => {
    redis.quit();
    return pool.end();
  };
});

function uniqueContact(prefix: string): string {
  nextContact += 1;
  return `${prefix}-${Date.now()}-${nextContact}@example.test`;
}

function uniqueIp(): string {
  return `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${(nextContact += 1) % 250}`;
}

async function newPerson(displayName: string, contactKey?: string): Promise<UserSnapshot> {
  return (
    await establishIdentity(identity, {
      contactKey: contactKey ?? uniqueContact("p"),
      displayName,
    })
  ).user;
}

async function publishTreatment(title: string, spots = 5): Promise<string> {
  const result = await publishActivity(activities, host, { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title,
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    timezone: "UTC",
    priceMinorUnits: 1000,
    currency: "EUR",
    spots,
  });
  return result.activity.id;
}

async function createVouch(creator: UserSnapshot, activityId: string, recipientEmail: string) {
  return createInvite(invites, creator, activityId, {
    ip: uniqueIp(),
    rail: "vouch",
    recipientEmail,
  });
}

describe("vouch invites", () => {
  it("vouches for a named other contact without reserving a spot", async () => {
    const activityId = await publishTreatment("Vouch Creation");
    const target = uniqueContact("friend");
    const vouch = await createVouch(host, activityId, target);
    expect(vouch).toMatchObject({ rail: "vouch", generation: 1, recipientEmail: target });

    // Stored immutably with the target; the invite_created event carries no
    // private target identifier.
    const saved = await withClient(migrationUrl, async (client) => {
      const invite = await client.query(
        "SELECT target_contact_key FROM invites WHERE id = $1",
        [vouch.id],
      );
      const events = await client.query(
        "SELECT count(*)::int AS n, details::text AS details FROM events WHERE event_name = 'invite_created' AND invite_id = $1 GROUP BY details",
        [vouch.id],
      );
      return { invite: invite.rows[0], events: events.rows[0] };
    });
    expect(saved.invite.target_contact_key).toBe(target);
    expect(saved.events.n).toBe(1);
    expect(saved.events.details).not.toContain(target);
    // Reserves no spot.
    const seats = await withClient(migrationUrl, (client) =>
      client.query("SELECT booked_count FROM activities WHERE id = $1", [activityId]),
    );
    expect(seats.rows[0].booked_count).toBe(0);
  });

  it("prohibits self-vouch and rejects a public share that carries a target", async () => {
    const activityId = await publishTreatment("Vouch Self");
    await expect(createVouch(host, activityId, host.contactKey)).rejects.toMatchObject({
      name: "ValidationError",
    });
    await expect(
      createInvite(invites, host, activityId, {
        ip: uniqueIp(),
        rail: "public_share",
        recipientEmail: uniqueContact("stray"),
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("keeps the vouch target private in the anonymous preview", async () => {
    const activityId = await publishTreatment("Vouch Privacy");
    const target = uniqueContact("private-friend");
    const vouch = await createVouch(host, activityId, target);
    const preview = await resolveInvite(invites, vouch.code, { ip: uniqueIp() });
    expect(preview.rail).toBe("vouch");
    expect(JSON.stringify(preview)).not.toContain(target);
  });

  it("refuses a foreign claimant with recipient mismatch, consuming nothing", async () => {
    const activityId = await publishTreatment("Vouch Mismatch");
    const targetContact = uniqueContact("right-friend");
    const vouch = await createVouch(host, activityId, targetContact);
    const stranger = await newPerson("Wrong Claimant");

    const outcome = await bookActivity(booking, stranger, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: vouch.code,
    }).then(
      () => "unexpected-success",
      (err) => (err instanceof InviteRecipientMismatchError ? "mismatch" : `other:${String(err)}`),
    );
    expect(outcome).toBe("mismatch");

    // No seat, no attribution, no conversion — and the vouch still redeems
    // for its named contact afterwards.
    const state = await withClient(migrationUrl, (client) =>
      client.query(
        `SELECT (SELECT booked_count FROM activities WHERE id = $1) AS booked,
                (SELECT count(*)::int FROM booking_attributions ba
                   JOIN bookings b ON b.id = ba.booking_id WHERE ba.invite_id = $2) AS redemptions,
                (SELECT count(*)::int FROM events WHERE event_name = 'spot_claimed' AND activity_id = $1) AS conversions`,
        [activityId, vouch.id],
      ),
    );
    expect(state.rows[0]).toMatchObject({ booked: 0, redemptions: 0, conversions: 0 });

    // The attempt evidence records the invited category and the refusal.
    const attempts = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT details ->> 'source' AS source, details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
        [stranger.id],
      ),
    );
    expect(attempts.rows[0]).toMatchObject({ source: "invited", outcome: "invite_recipient_mismatch" });

    // The named contact redeems it: establish the target identity, claim.
    const target = await newPerson("Rightful Recipient", targetContact);
    const claimed = await bookActivity(booking, target, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: vouch.code,
    });
    expect(claimed.created).toBe(true);
    expect(claimed.booking.attribution).toMatchObject({ rail: "vouch", generation: 1 });
  });

  it("rejects acquisition for a foreign contact and saves nothing", async () => {
    const activityId = await publishTreatment("Vouch Acquisition");
    const targetContact = uniqueContact("acq-friend");
    const vouch = await createVouch(host, activityId, targetContact);

    const strangerKey = uniqueContact("acq-stranger");
    await expect(
      establishIdentity(identity, {
        contactKey: strangerKey,
        displayName: "Should Not Exist",
        inviteCode: vouch.code,
      }),
    ).rejects.toBeInstanceOf(InviteRecipientMismatchError);
    const rows = await withClient(migrationUrl, (client) =>
      client.query("SELECT count(*)::int AS n FROM users WHERE contact_key = $1", [strangerKey]),
    );
    expect(rows.rows[0].n).toBe(0);

    // The named contact acquires the vouch's generation as their signup.
    const acquired = await establishIdentity(identity, {
      contactKey: targetContact,
      displayName: "Named Recipient",
      inviteCode: vouch.code,
    });
    expect(acquired.user).toMatchObject({ signupSource: "vouch", signupGeneration: 1 });
  });

  it("returns the original confirmation when the redeemed vouch has expired", async () => {
    const activityId = await publishTreatment("Vouch Replay");
    const targetContact = uniqueContact("replay-friend");
    const vouch = await createVouch(host, activityId, targetContact);
    const target = await newPerson("Replay Recipient", targetContact);
    const operationId = randomUUID();
    const first = await bookActivity(booking, target, activityId, {
      ip: uniqueIp(),
      operationId,
      inviteCode: vouch.code,
    });
    expect(first.created).toBe(true);

    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable"),
    );
    await withClient(migrationUrl, (client) =>
      client.query(
        "UPDATE invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute' WHERE id = $1",
        [vouch.id],
      ),
    );
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable"),
    );

    // Requesting the booking again — even with the dead code — returns the
    // original confirmation without a second conversion.
    const replay = await bookActivity(booking, target, activityId, {
      ip: uniqueIp(),
      operationId: randomUUID(),
      inviteCode: vouch.code,
    });
    expect(replay).toMatchObject({ created: false, booking: { id: first.booking.id } });
    expect(replay.booking.attribution).toMatchObject({ rail: "vouch", generation: 1 });
    const conversions = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'spot_claimed' AND user_id = $1",
        [target.id],
      ),
    );
    expect(conversions.rows[0].n).toBe(1);
  });

  it("keeps the started lifecycle gate for a valid vouch", async () => {
    const activityId = await publishTreatment("Vouch Started");
    const targetContact = uniqueContact("started-friend");
    const vouch = await createVouch(host, activityId, targetContact);
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [activityId]),
    );
    const target = await newPerson("Started Recipient", targetContact);
    await expect(
      bookActivity(booking, target, activityId, {
        ip: uniqueIp(),
        operationId: randomUUID(),
        inviteCode: vouch.code,
      }),
    ).rejects.toBeInstanceOf(ActivityStartedError);
  });

  it("collapses concurrent redemptions of one vouch to exactly one", async () => {
    const activityId = await publishTreatment("Vouch Concurrent", 5);
    const targetContact = uniqueContact("concurrent-friend");
    const vouch = await createVouch(host, activityId, targetContact);
    const target = await newPerson("Concurrent Recipient", targetContact);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        bookActivity(booking, target, activityId, {
          ip: uniqueIp(),
          operationId: randomUUID(),
          inviteCode: vouch.code,
        }).then(
          (r) => (r.created ? "created" : "replayed"),
          (err) => `failed:${err.name}`,
        ),
      ),
    );
    expect(results.filter((r) => r === "created")).toHaveLength(1);

    const state = await withClient(migrationUrl, (client) =>
      client.query(
        `SELECT (SELECT booked_count FROM activities WHERE id = $1) AS booked,
                (SELECT count(*)::int FROM booking_attributions WHERE invite_id = $2 AND rail = 'vouch') AS redemptions,
                (SELECT count(*)::int FROM events WHERE event_name = 'spot_claimed' AND user_id = $3) AS conversions`,
        [activityId, vouch.id, target.id],
      ),
    );
    expect(state.rows[0]).toMatchObject({ booked: 1, redemptions: 1, conversions: 1 });
  });
});
