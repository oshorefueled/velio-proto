import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let hostId: string;
let bookerId: string;
let activityId: string;
let planId: string;
let inviteCode: string;
let inviteId: string;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await withClient(migrationUrl, async (client) => {
    const users = await client.query(
      `INSERT INTO users (contact_key, display_name, signup_source, signup_generation)
       VALUES
         ('invite-schema-host', 'Invite Schema Host', 'direct', 0),
         ('invite-schema-booker', 'Invite Schema Booker', 'direct', 0)
       RETURNING id`,
    );
    hostId = users.rows[0].id as string;
    bookerId = users.rows[1].id as string;
    const activity = await client.query(
      `WITH a AS (
         INSERT INTO activities (host_id, title, starts_at, ends_at, display_timezone, price_minor_units, currency, capacity)
         VALUES ($1, 'Invite Schema', now() + interval '48 hours', now() + interval '50 hours', 'UTC', 100, 'EUR', 5)
         RETURNING id
       ), p AS (INSERT INTO plans (activity_id) SELECT id FROM a RETURNING id)
       SELECT a.id AS activity_id, p.id AS plan_id FROM a, p`,
      [hostId],
    );
    activityId = activity.rows[0].activity_id as string;
    planId = activity.rows[0].plan_id as string;
    const invite = await client.query(
      `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
       VALUES ('SCHEMATEST1', 'public_share', $1, $2, $3, 1, now() + interval '24 hours')
       RETURNING id`,
      [hostId, activityId, planId],
    );
    inviteId = invite.rows[0].id as string;
    inviteCode = "SCHEMATEST1";
  });
});

function appClient(): Client {
  return new Client({ connectionString: appUrl });
}

describe("invites schema", () => {
  it("when a second public invitation targets the same sharing account and activity, the database refuses it", async () => {
    await expect(withClient(migrationUrl, client => client.query(
      `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
       VALUES ('DVPPVB1AAAAA', 'public_share', $1, $2, $3, 1, now()+interval '24 hours')`,
      [hostId, activityId, planId],
    ))).rejects.toMatchObject({ code: "23505", constraint: "invites_public_account_activity" });
    const saved = await withClient(migrationUrl, client => client.query("SELECT id FROM invites WHERE creator_id=$1 AND activity_id=$2 AND rail='public_share'", [hostId, activityId]));
    expect(saved.rows).toEqual([{ id: inviteId }]);
  });

  it("accepts only the rails that exist today", async () => {
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('SCHEMABADR1', 'vouch', $1, $2, $3, 1, now() + interval '24 hours')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("enforces the typeable code shape and uniqueness", async () => {
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('has lowercase!!', 'public_share', $1, $2, $3, 1, now() + interval '24 hours')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ($1, 'public_share', $2, $3, $4, 1, now() + interval '24 hours')`,
          [inviteCode, hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("requires a generation of at least one and a sensible expiry", async () => {
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('SCHEMAGEN0', 'public_share', $1, $2, $3, 0, now() + interval '24 hours')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('SCHEMAEXP1', 'public_share', $1, $2, $3, 1, now() - interval '1 hour')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("pins the invite to its activity's own plan", async () => {
    const other = await withClient(migrationUrl, (client) =>
      client
        .query(
          `WITH a AS (
             INSERT INTO activities (host_id, title, starts_at, ends_at, display_timezone, price_minor_units, currency, capacity)
             VALUES ($1, 'Other Plan', now() + interval '48 hours', now() + interval '50 hours', 'UTC', 100, 'EUR', 5) RETURNING id
           ), p AS (INSERT INTO plans (activity_id) SELECT id FROM a RETURNING id)
           SELECT p.id AS plan_id FROM p`,
          [hostId],
        )
        .then((r) => r.rows[0].plan_id as string),
    );
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('SCHEMAPTN1', 'public_share', $1, $2, $3, 1, now() + interval '24 hours')`,
          [hostId, activityId, other],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects invite mutations for the application role and the trigger rejects every role", async () => {
    const app = appClient();
    await app.connect();
    try {
      await expect(app.query("UPDATE invites SET generation = 5 WHERE id = $1", [inviteId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("DELETE FROM invites WHERE id = $1", [inviteId])).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    await expect(
      withClient(migrationUrl, (client) =>
        client.query("UPDATE invites SET expires_at = now() + interval '1 hour' WHERE id = $1", [inviteId]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("keeps booking attribution origins consistent and immutable", async () => {
    const booking = await withClient(migrationUrl, (client) =>
      client
        .query(
          `INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id`,
          [activityId, planId, bookerId],
        )
        .then((r) => r.rows[0].id as string),
    );
    // A valid invited origin snapshots inviter, invite and code together.
    await withClient(migrationUrl, (client) =>
      client.query(
        `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
         VALUES ($1, 'public_share', 1, $2, $3, $4)`,
        [booking, hostId, inviteId, inviteCode],
      ),
    );
    // Direct rows keep every invite field null; invited rows require them.
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO booking_attributions (booking_id, rail, generation) VALUES ($1, 'direct', 1)`,
          [booking],
        ),
      ),
    ).rejects.toThrow();
    const directBooking = await withClient(migrationUrl, (client) =>
      client
        .query(`INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [
          activityId,
          planId,
          hostId,
        ])
        .then((r) => r.rows[0].id as string),
    );
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
           VALUES ($1, 'direct', 0, $2, $3, $4)`,
          [directBooking, hostId, inviteId, inviteCode],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
           VALUES ($1, 'public_share', 1, $2, $3, NULL)`,
          [directBooking, hostId, inviteId],
        ),
      ),
    ).rejects.toThrow();
    // The 0003 mutation trigger still guards the extended table.
    await expect(
      withClient(migrationUrl, (client) =>
        client.query("UPDATE booking_attributions SET generation = 9 WHERE booking_id = $1", [booking]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("keeps signup acquisition consistent and rejects rewrites", async () => {
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO users (contact_key, display_name, signup_source, signup_generation, signup_invite_id)
           VALUES ('invite-schema-gen', 'No Invite', 'public_share', 2, NULL)`,
        ),
      ),
    ).rejects.toThrow();
    const invited = await withClient(migrationUrl, (client) =>
      client
        .query(
          `INSERT INTO users (contact_key, display_name, signup_source, signup_generation, signup_invite_id)
           VALUES ('invite-schema-invited', 'Invited Schema', 'public_share', 1, $1) RETURNING id`,
          [inviteId],
        )
        .then((r) => r.rows[0].id as string),
    );
    // Renaming stays possible for the migration role; rewriting origin is not.
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE users SET display_name = 'Renamed Schema' WHERE id = $1", [invited]),
    );
    await expect(
      withClient(migrationUrl, (client) =>
        client.query("UPDATE users SET signup_source = 'direct', signup_generation = 0 WHERE id = $1", [invited]),
      ),
    ).rejects.toThrow(/immutable/);
    const app = appClient();
    await app.connect();
    try {
      await expect(app.query("UPDATE users SET display_name = 'X' WHERE id = $1", [invited])).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });

  it("enforces the vouch rail's target pairing at the storage layer", async () => {
    // A public share never carries a target; a vouch always does.
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at, target_contact_key)
           VALUES ('VSCHEMSHR1', 'public_share', $1, $2, $3, 1, now() + interval '24 hours', 'someone-else')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at)
           VALUES ('VSCHEMVCH1', 'vouch', $1, $2, $3, 1, now() + interval '24 hours')`,
          [hostId, activityId, planId],
        ),
      ),
    ).rejects.toThrow();
    const vouch = await withClient(migrationUrl, (client) =>
      client
        .query(
          `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at, target_contact_key)
           VALUES ('VSCHEMVCH2', 'vouch', $1, $2, $3, 1, now() + interval '24 hours', 'vouched-friend')
           RETURNING id`,
          [hostId, activityId, planId],
        )
        .then((r) => r.rows[0].id as string),
    );
    // The vouch's booking attribution carries the same snapshots as a share.
    // Fresh bookers: earlier tests in this file already booked the fixtures.
    const [friend, other] = await withClient(migrationUrl, async (client) => {
      const users = await client.query(
        `INSERT INTO users (contact_key, display_name, signup_source, signup_generation)
         VALUES ('vouch-schema-friend', 'Friend', 'direct', 0),
                ('vouch-schema-other', 'Other', 'direct', 0)
         RETURNING id`,
      );
      return [users.rows[0].id as string, users.rows[1].id as string];
    });
    const booking = await withClient(migrationUrl, (client) =>
      client
        .query(`INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [
          activityId,
          planId,
          friend,
        ])
        .then((r) => r.rows[0].id as string),
    );
    await withClient(migrationUrl, (client) =>
      client.query(
        `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
         VALUES ($1, 'vouch', 1, $2, $3, 'VSCHEMVCH2')`,
        [booking, hostId, vouch],
      ),
    );
    // One successful redemption per vouch, structurally, for every role.
    const secondBooking = await withClient(migrationUrl, (client) =>
      client
        .query(`INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [
          activityId,
          planId,
          other,
        ])
        .then((r) => r.rows[0].id as string),
    );
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
           VALUES ($1, 'vouch', 1, $2, $3, 'VSCHEMVCH2')`,
          [secondBooking, hostId, vouch],
        ),
      ),
    ).rejects.toThrow();
    // Public shares stay reusable: a second share attribution is fine.
    const share = inviteId;
    const shareBookings: string[] = [];
    for (const contact of ["vouch-schema-share1", "vouch-schema-share2"]) {
      const userId = await withClient(migrationUrl, (client) =>
        client
          .query(
            "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Sharer', 'direct', 0) RETURNING id",
            [contact],
          )
          .then((r) => r.rows[0].id as string),
      );
      const bookingId = await withClient(migrationUrl, (client) =>
        client
          .query(`INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [
            activityId,
            planId,
            userId,
          ])
          .then((r) => r.rows[0].id as string),
      );
      shareBookings.push(bookingId);
    }
    for (const b of shareBookings) {
      await withClient(migrationUrl, (client) =>
        client.query(
          `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
           VALUES ($1, 'public_share', 1, $2, $3, 'SCHEMATEST1')`,
          [b, hostId, share],
        ),
      );
    }
  });

  it("refuses destructive deletion of referenced history (no cascades)", async () => {
    await expect(
      withClient(migrationUrl, (client) => client.query("DELETE FROM activities WHERE id = $1", [activityId])),
    ).rejects.toThrow();
    await expect(
      withClient(migrationUrl, (client) => client.query("DELETE FROM invites WHERE id = $1", [inviteId])),
    ).rejects.toThrow();
  });
});
