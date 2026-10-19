import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import {
  ActivityCompletedError,
  ActivitySoldOutError,
  ActivityStartedError,
} from "../src/booking/domain.ts";
import { ForbiddenError } from "../src/activities/domain.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { bookActivity } from "../src/booking/service.ts";
import { createPublicShare, resolveInvite, type InvitesDeps } from "../src/invites/service.ts";
import { RateLimitError } from "../src/ratelimit.js";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let redis: Redis;
let activities: ActivitiesDeps;
let invites: InvitesDeps;
let invitesSwitchedOff: InvitesDeps;
let host: UserSnapshot;
let outsider: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  const quota = { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 };
  activities = { pool, experiment: { allocationPercent: 50, experimentVersion: "t6" } };
  const base = {
    pool,
    redis,
    expiryHours: 336,
    creationQuota: quota,
    resolveQuota: { perIp: quota.perIp, windowSeconds: quota.windowSeconds },
  };
  invites = { ...base, inviteCreationEnabled: true };
  invitesSwitchedOff = { ...base, inviteCreationEnabled: false };
  host = (await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("t6-host"), displayName: "Invite Host" })).user;
  outsider = (await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("t6-out"), displayName: "Outsider" })).user;
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
    await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("t6"), displayName })
  ).user;
}

async function publish(title: string, allocationPercent: number, startsInMs = 48 * 3600 * 1000): Promise<string> {
  return publishAs(host, title, allocationPercent, startsInMs);
}

async function publishAs(
  hostPerson: UserSnapshot,
  title: string,
  allocationPercent: number,
  startsInMs = 48 * 3600 * 1000,
): Promise<string> {
  const result = await publishActivity(
    { pool, experiment: { allocationPercent, experimentVersion: "t6" } },
    hostPerson,
    { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title,
      startsAt: new Date(Date.now() + startsInMs).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 1000,
      currency: "EUR",
      spots: 5,
    },
  );
  return result.activity.id;
}

let ipCounter = 0;

/** Fixed-window counters persist across runs; every test gets a fresh IP. */
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(Date.now() / 1000) % 250}.${ipCounter % 250}.${ipCounter}`;
}

describe("createPublicShare", () => {
  it("gives a host a reusable code that expires by the activity start and records invite_created once", async () => {
    const activityId = await publish("Share Gates Host", 100);
    const view = await createPublicShare(invites, host, activityId, { ip: "10.1.0.1" });
    expect(view.rail).toBe("public_share");
    expect(view.generation).toBe(1); // direct host signup generation 0 + 1
    expect(view.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);

    const saved = await withClient(migrationUrl, async (client) => {
      const invite = await client.query(
        "SELECT expires_at, (SELECT starts_at FROM activities WHERE id = $1) AS starts_at FROM invites WHERE id = $2",
        [activityId, view.id],
      );
      const events = await client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'invite_created' AND invite_id = $1",
        [view.id],
      );
      return { invite: invite.rows[0], events: events.rows[0].n };
    });
    // Expiry never passes the activity start; 336h exceeds the 48h horizon.
    expect(new Date(saved.invite.expires_at).getTime()).toBe(new Date(saved.invite.starts_at).getTime());
    expect(saved.events).toBe(1);
    const assignment = await pool.query(
      "SELECT experiment_version, experiment_arm FROM events WHERE event_name = 'invite_created' AND invite_id = $1",
      [view.id],
    );
    expect(assignment.rows).toEqual([{ experiment_version: "t6", experiment_arm: "treatment" }]);

    const second = await createPublicShare(invites, host, activityId, { ip: "10.1.0.2" });
    expect(second.code).not.toBe(view.code);
  });

  it("lets a confirmed booker create but refuses unrelated people", async () => {
    const activityId = await publish("Share Gates Booker", 100);
    const booker = await newPerson("Confirmed Booker");
    await bookActivityDirectly(booker, activityId);
    const view = await createPublicShare(invites, booker, activityId, { ip: "10.2.0.1" });
    expect(view.generation).toBe(1);

    await expect(createPublicShare(invites, outsider, activityId, { ip: "10.2.0.2" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("refuses control activities and a switched-off creation gate without touching issued invites", async () => {
    const control = await publish("Share Gates Control", 0);
    await expect(createPublicShare(invites, host, control, { ip: "10.3.0.1" })).rejects.toBeInstanceOf(ForbiddenError);

    const treatment = await publish("Share Gates Switch", 100);
    const issued = await createPublicShare(invites, host, treatment, { ip: "10.3.0.2" });
    await expect(createPublicShare(invitesSwitchedOff, host, treatment, { ip: "10.3.0.3" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // The issued link still resolves and stays claimable.
    const preview = await resolveInvite(invitesSwitchedOff, issued.code, { ip: "10.3.0.4" });
    expect(preview.state).toBe("claimable");
  });

  it("refuses started, full and completed activities", async () => {
    const full = await publish("Share Gates Full", 100);
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET booked_count = capacity WHERE id = $1", [full]),
    );
    await expect(createPublicShare(invites, host, full, { ip: "10.4.0.2" })).rejects.toBeInstanceOf(
      ActivitySoldOutError,
    );

    const completed = await publish("Share Gates Completed", 100);
    await withClient(migrationUrl, (client) => client.query(
        "UPDATE plans SET completed = true, completed_by = $2, completed_at = now() WHERE activity_id = $1",
        [completed, host.id],
      ));
    await expect(createPublicShare(invites, host, completed, { ip: "10.4.0.3" })).rejects.toBeInstanceOf(
      ActivityCompletedError,
    );

    // A started activity: publish future, then move the start into the past.
    const started = await publish("Share Gates Started", 100);
    const before = await createPublicShare(invites, host, started, { ip: "10.4.0.4" });
    expect(before.rail).toBe("public_share");
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [started]),
    );
    await expect(createPublicShare(invites, host, started, { ip: "10.4.0.5" })).rejects.toBeInstanceOf(
      ActivityStartedError,
    );
  });

  it("applies finite creation quotas per identity with a retry delay", async () => {
    const limited: InvitesDeps = {
      ...invites,
      creationQuota: { perIdentity: 2, perIp: 1000, windowSeconds: 3600 },
    };
    // A fresh creator hosting their own activity: the fixed window persists
    // across the file's earlier creations, so the boundary must be observed
    // on clean counters and the creator must be the activity's host.
    const creator = await newPerson("Quota Creator");
    const activityId = await publishAs(creator, "Share Quota Identity", 100);
    await createPublicShare(limited, creator, activityId, { ip: uniqueIp() });
    await createPublicShare(limited, creator, activityId, { ip: uniqueIp() });
    const err = await createPublicShare(limited, creator, activityId, { ip: uniqueIp() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as RateLimitError).retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("applies a per-IP cap independent of identity", async () => {
    const limited: InvitesDeps = {
      ...invites,
      creationQuota: { perIdentity: 1000, perIp: 1, windowSeconds: 3600 },
    };
    const first = await newPerson("Ip Creator One");
    const activityId = await publishAs(first, "Share Quota Ip", 100);
    const sharedIp = uniqueIp();
    await createPublicShare(limited, first, activityId, { ip: sharedIp });
    const second = await newPerson("Ip Creator Two");
    await expect(createPublicShare(limited, second, activityId, { ip: sharedIp })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});

async function bookActivityDirectly(person: UserSnapshot, activityId: string): Promise<void> {
  const bookingRedis = new Redis(process.env.REDIS_URL as string);
  bookingRedis.on("error", () => {});
  try {
    await bookActivity(
      {
        pool,
        redis: bookingRedis,
        quota: { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 },
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
      },
      person,
      activityId,
      { ip: "10.9.9.9", operationId: uniqueKey("op") },
    );
  } finally {
    bookingRedis.disconnect();
  }
}

describe("resolveInvite", () => {
  it("previews activity, inviter, rail, expiry and availability without an identity", async () => {
    const activityId = await publish("Resolve Preview", 100);
    const issued = await createPublicShare(invites, host, activityId, { ip: "10.7.0.1" });
    const preview = await resolveInvite(invites, issued.code.toLowerCase(), { ip: "10.7.0.2" });
    expect(preview).toMatchObject({
      code: issued.code,
      rail: "public_share",
      generation: 1,
      state: "claimable",
      inviterDisplayName: "Invite Host",
      activity: {
        id: activityId,
        title: "Resolve Preview",
        capacity: 5,
        bookedCount: 0,
        remainingSpots: 5,
      },
    });
  });

  it("distinguishes unknown and malformed codes", async () => {
    const activityId = await publish("Resolve Unknown", 100);
    await createPublicShare(invites, host, activityId, { ip: "10.8.0.1" });
    await expect(resolveInvite(invites, "ZZZZZZZZZZZZ", { ip: "10.8.0.2" })).rejects.toMatchObject({
      name: "InviteNotFoundError",
    });
    await expect(resolveInvite(invites, "not-a-code!!", { ip: "10.8.0.3" })).rejects.toMatchObject({
      name: "InviteNotFoundError",
    });
  });

  it("reports expired, started and full as readable states instead of dead ends", async () => {
    const expiredActivity = await publish("Resolve Expired", 100);
    const expiring = await createPublicShare(invites, host, expiredActivity, { ip: "10.10.0.1" });
    // The migration role disables the immutability trigger for the bounded
    // correction, exactly as the migration comment prescribes.
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable"),
    );
    await withClient(migrationUrl, (client) =>
      client.query(
        "UPDATE invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute' WHERE code = $1",
        [expiring.code],
      ),
    );
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable"),
    );
    expect((await resolveInvite(invites, expiring.code, { ip: "10.10.0.2" })).state).toBe("expired");

    // A claimable invite whose activity then starts resolves as started.
    const startedActivity = await publish("Resolve Started", 100);
    const startedInvite = await createPublicShare(invites, host, startedActivity, { ip: "10.10.0.3" });
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [startedActivity]),
    );
    await withClient(migrationUrl, async (client) => {
      await client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable");
      try {
        await client.query("UPDATE invites SET created_at = now() - interval '2 hours', expires_at = (SELECT starts_at FROM activities WHERE id = $1) WHERE id = $2", [startedActivity, startedInvite.id]);
      } finally {
        await client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable");
      }
    });
    expect((await resolveInvite(invites, startedInvite.code, { ip: "10.10.0.4" })).state).toBe("started");

    const fullActivity = await publish("Resolve Full", 100);
    const fullInvite = await createPublicShare(invites, host, fullActivity, { ip: "10.10.0.5" });
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET booked_count = capacity WHERE id = $1", [fullActivity]),
    );
    const fullPreview = await resolveInvite(invites, fullInvite.code, { ip: "10.10.0.6" });
    expect(fullPreview.state).toBe("full");
    expect(fullPreview.activity.remainingSpots).toBe(0);
  });

  it("applies the per-IP resolution quota", async () => {
    const limited: InvitesDeps = {
      ...invites,
      resolveQuota: { perIp: 2, windowSeconds: 3600 },
    };
    // Two consumed attempts (unknown codes refuse, but the counter runs on
    // every resolution); the third must be refused with a retry delay.
    await resolveInvite(limited, "ZZZZZZZZZZZZ", { ip: "10.11.0.1" }).catch(() => {});
    await resolveInvite(limited, "ZZZZZZZZZZZZ", { ip: "10.11.0.1" }).catch(() => {});
    const err = await resolveInvite(limited, "ZZZZZZZZZZZZ", { ip: "10.11.0.1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
  });
});
