import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { createPool } from "../src/db/pool.ts";
import { establishIdentity, type IdentityDeps } from "../src/identity/service.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { createPublicShare, type InvitesDeps } from "../src/invites/service.ts";
import { InviteExpiredError, InviteNotFoundError } from "../src/invites/domain.js";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let identity: IdentityDeps;
let activities: ActivitiesDeps;
let invites: InvitesDeps;
let host: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  const redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  identity = { pool, sessionTtlHours: 12 };
  activities = { pool, experiment: { allocationPercent: 100, experimentVersion: "t6-id" } };
  const quota = { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 };
  invites = {
    pool,
    redis,
    inviteCreationEnabled: true,
    expiryHours: 336,
    creationQuota: quota,
    resolveQuota: { perIp: quota.perIp, windowSeconds: quota.windowSeconds },
  };
  host = (await establishIdentity(identity, { contactKey: uniqueKey("id-host"), displayName: "Acq Host" })).user;
  return () => {
    redis.quit();
    return pool.end();
  };
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueIp(): string {
  return `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${Math.floor(Math.random() * 250)}`;
}

async function newShare(creator: UserSnapshot): Promise<{ code: string; generation: number }> {
  const result = await publishActivity(activities, creator, { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title: `Acquisition ${uniqueKey("t")}`,
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
    country: "GB",
    priceMinorUnits: 1000,
    currency: "EUR",
    spots: 5,
  });
  const share = await createPublicShare(invites, creator, result.activity.id, { ip: uniqueIp() });
  return { code: share.code, generation: share.generation };
}

describe("invite-aware identity acquisition", () => {
  it("records the invite's rail and generation for a new user, immutably", async () => {
    const share = await newShare(host); // host gen 0 -> invite generation 1
    const establishment = await establishIdentity(identity, {
      contactKey: uniqueKey("acq"),
      displayName: "Acquired Guest",
      inviteCode: share.code,
    });
    expect(establishment.created).toBe(true);
    expect(establishment.user).toMatchObject({ signupSource: "public_share", signupGeneration: 1 });

    const saved = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT signup_source, signup_generation, signup_invite_id FROM users WHERE id = $1",
        [establishment.user.id],
      ),
    );
    expect(saved.rows[0].signup_source).toBe("public_share");
    expect(saved.rows[0].signup_generation).toBe(1);
    expect(saved.rows[0].signup_invite_id).not.toBeNull();

    // user_created carries the acquisition snapshot.
    const created = await withClient(migrationUrl, (client) =>
      client.query(
        "SELECT details FROM events WHERE event_name = 'user_created' AND user_id = $1",
        [establishment.user.id],
      ),
    );
    expect(created.rows[0].details).toMatchObject({ signupSource: "public_share", signupGeneration: 1 });
  });

  it("chains a second acquisition generation from an invited creator", async () => {
    const firstShare = await newShare(host); // generation 1
    const invited = (
      await establishIdentity(identity, {
        contactKey: uniqueKey("acq-gen2"),
        displayName: "Generation Two",
        inviteCode: firstShare.code,
      })
    ).user;
    expect(invited.signupGeneration).toBe(1);

    // The invited user hosts their own treatment activity and shares it.
    const secondShare = await newShare(invited);
    expect(secondShare.generation).toBe(2);

    const guest = (
      await establishIdentity(identity, {
        contactKey: uniqueKey("acq-gen2-guest"),
        displayName: "Generation Two Guest",
        inviteCode: secondShare.code,
      })
    ).user;
    expect(guest.signupGeneration).toBe(2);
  });

  it("never rewrites saved acquisition when an existing identity resumes with a code", async () => {
    const share = await newShare(host);
    const contactKey = uniqueKey("acq-resume");
    const original = (
      await establishIdentity(identity, { contactKey, displayName: "Direct First" })
    ).user;
    expect(original.signupSource).toBe("direct");

    // Same contact key: resolve-or-create resumes the recorded identity.
    const resumed = await establishIdentity(identity, {
      contactKey,
      displayName: "Ignored",
      inviteCode: share.code,
    });
    expect(resumed.created).toBe(false);
    expect(resumed.user.signupSource).toBe("direct");
    expect(resumed.user.signupGeneration).toBe(0);
  });

  it("saves nothing when the invite is unknown or expired", async () => {
    await expect(
      establishIdentity(identity, {
        contactKey: uniqueKey("acq-bad"),
        displayName: "Unknown Code",
        inviteCode: "ZZZZZZZZZZZZ",
      }),
    ).rejects.toBeInstanceOf(InviteNotFoundError);

    const activity = await publishActivity(activities, host, { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title: `Expiry ${uniqueKey("t")}`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      country: "GB",
      priceMinorUnits: 1000,
      currency: "EUR",
      spots: 5,
    });
    const share = await createPublicShare(invites, host, activity.activity.id, { ip: uniqueIp() });
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites DISABLE TRIGGER invites_immutable"),
    );
    await withClient(migrationUrl, (client) =>
      client.query(
        "UPDATE invites SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute' WHERE code = $1",
        [share.code],
      ),
    );
    await withClient(migrationUrl, (client) =>
      client.query("ALTER TABLE invites ENABLE TRIGGER invites_immutable"),
    );
    const contactKey = uniqueKey("acq-expired");
    await expect(
      establishIdentity(identity, {
        contactKey,
        displayName: "Expired Code",
        inviteCode: share.code,
      }),
    ).rejects.toBeInstanceOf(InviteExpiredError);

    const rows = await withClient(migrationUrl, (client) =>
      client.query("SELECT count(*)::int AS n FROM users WHERE contact_key = $1", [contactKey]),
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
