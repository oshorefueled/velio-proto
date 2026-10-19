import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let hostId: string;
let activityId: string;
let planId: string;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await withClient(migrationUrl, async (client) => {
    hostId = (await client.query(
      "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1,'B-Host','direct',0) RETURNING id",
      [`bk-host-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    )).rows[0].id;
    activityId = (await client.query(
      `INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
       VALUES ($1,'Book Schema Kayak', now() + interval '48 hours','UTC',1000,'EUR',3) RETURNING id`,
      [hostId],
    )).rows[0].id;
    planId = (await client.query(
      "INSERT INTO plans (activity_id) VALUES ($1) RETURNING id",
      [activityId],
    )).rows[0].id;
  });
});

/** Each booking gets a fresh person: the unique key allows one per user. */
async function book(): Promise<string> {
  const userId = await withClient(migrationUrl, (client) =>
    client
      .query(
        "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'B-Booker', 'direct', 0) RETURNING id",
        [`bk-user-${Date.now()}-${Math.random().toString(36).slice(2)}`],
      )
      .then((r) => r.rows[0].id as string),
  );
  const bookingId = await withClient(appUrl, (client) =>
    client
      .query(
        "INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3) RETURNING id",
        [activityId, planId, userId],
      )
      .then((r) => r.rows[0].id as string),
  );
  await withClient(appUrl, (client) =>
    client.query("INSERT INTO booking_attributions (booking_id, rail, generation) VALUES ($1, 'direct', 0)", [
      bookingId,
    ]),
  );
  return bookingId;
}

describe("booking schema", () => {
  it("creates bookings and booking_attributions tables", async () => {
    const names = await withClient(appUrl, (client) =>
      client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'"),
    ).then((r) => r.rows.map((row: { tablename: string }) => row.tablename));
    expect(names).toEqual(expect.arrayContaining(["bookings", "booking_attributions"]));
  });

  it("enforces one booking per person per activity through the unique key", async () => {
    const bookingId = await book();
    const userId = await withClient(appUrl, (client) =>
      client
        .query("SELECT user_id FROM bookings WHERE id = $1", [bookingId])
        .then((r) => r.rows[0].user_id as string),
    );
    await expect(
      withClient(appUrl, (client) =>
        client.query("INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3)", [
          activityId,
          planId,
          userId,
        ]),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("rejects a booking whose plan belongs to a different activity through the composite FK", async () => {
    const otherPlan = await withClient(migrationUrl, (client) =>
      client
        .query(
          `WITH other AS (
             INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
             SELECT $1,'Other Activity', now() + interval '48 hours','UTC',1000,'EUR',2 RETURNING id
           )
           INSERT INTO plans (activity_id) SELECT id FROM other RETURNING id`,
          [hostId],
        )
        .then((r) => r.rows[0].id as string),
    );
    const userId = await withClient(migrationUrl, (client) =>
      client
        .query(
          "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'FK Booker', 'direct', 0) RETURNING id",
          [`bk-fk-${Date.now()}-${Math.random().toString(36).slice(2)}`],
        )
        .then((r) => r.rows[0].id as string),
    );
    await expect(
      withClient(appUrl, (client) =>
        client.query(
          "INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1, $2, $3)",
          [activityId, otherPlan, userId],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("restricts attributions to direct origins at generation zero", async () => {
    // booking_id is the attribution primary key, so each case needs a fresh booking.
    const makeBooking = async (label: string): Promise<string> => {
      const userId = await withClient(migrationUrl, (client) =>
        client
          .query(
            "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1,'X','direct',0) RETURNING id",
            [`bk-attr-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`],
          )
          .then((r) => r.rows[0].id as string),
      );
      return withClient(appUrl, (client) =>
        client
          .query("INSERT INTO bookings (activity_id, plan_id, user_id) VALUES ($1,$2,$3) RETURNING id", [
            activityId,
            planId,
            userId,
          ])
          .then((r) => r.rows[0].id as string),
      );
    };

    const vouchBooking = await makeBooking("vouch");
    await expect(
      withClient(appUrl, (client) =>
        client.query("INSERT INTO booking_attributions (booking_id, rail, generation) VALUES ($1, 'vouch', 0)", [
          vouchBooking,
        ]),
      ),
    ).rejects.toThrow(/check/i);

    const genBooking = await makeBooking("gen");
    await expect(
      withClient(appUrl, (client) =>
        client.query("INSERT INTO booking_attributions (booking_id, rail, generation) VALUES ($1, 'direct', 2)", [
          genBooking,
        ]),
      ),
    ).rejects.toThrow(/check/i);
  });

  it("denies the application role mutation of committed bookings and attributions", async () => {
    await book();
    for (const statement of [
      "UPDATE bookings SET user_id = user_id",
      "DELETE FROM bookings",
      "UPDATE booking_attributions SET rail = rail",
      "DELETE FROM booking_attributions",
    ]) {
      await expect(withClient(appUrl, (client) => client.query(statement)), statement).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it("rejects mutation triggers even for the migration role", async () => {
    await book();
    for (const statement of [
      "UPDATE booking_attributions SET generation = 7",
      "DELETE FROM booking_attributions",
    ]) {
      await expect(withClient(migrationUrl, (client) => client.query(statement)), statement).rejects.toThrow(
        /immutable|attribution/i,
      );
    }
  });
});
