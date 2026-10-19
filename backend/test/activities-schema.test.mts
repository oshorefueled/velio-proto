import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let hostId: string;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  hostId = await withClient(migrationUrl, async (client) => {
    const result = await client.query(
      "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Schema Host', 'direct', 0) RETURNING id",
      [`schema-host-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    return result.rows[0].id as string;
  });
});

interface ActivityOverrides {
  title?: string;
  starts_at?: string;
  display_timezone?: string;
  price_minor_units?: string;
  currency?: string;
  capacity?: string;
}

/** INSERT with SQL-literal overrides, as the application role would publish. */
async function publish(overrides: ActivityOverrides = {}) {
  const values: Record<string, string> = {
    title: `'Sunset Kayaking'`,
    starts_at: `now() + interval '48 hours'`,
    display_timezone: `'Europe/Berlin'`,
    price_minor_units: `4500`,
    currency: `'EUR'`,
    capacity: `6`,
    ...overrides,
  };
  const columns = Object.keys(values);
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    return await client.query(
      `INSERT INTO activities (host_id, ${columns.join(", ")})
       SELECT $1, ${columns.map((column) => values[column]).join(", ")}`,
      [hostId],
    );
  } finally {
    await client.end();
  }
}

describe("activities schema", () => {
  it("creates activities and plans tables", async () => {
    const result = await withClient(appUrl, (client) =>
      client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"),
    );
    const names = result.rows.map((row: { tablename: string }) => row.tablename);
    expect(names).toEqual(expect.arrayContaining(["activities", "plans"]));
  });

  it("publishes with safe defaults: booked_count 0 and availability_version 1", async () => {
    const result = await withClient(appUrl, (client) =>
      client.query(
        `INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
         VALUES ($1, 'Defaults Kayaking', now() + interval '48 hours', 'UTC', 1000, 'EUR', 4)
         RETURNING booked_count, availability_version`,
        [hostId],
      ),
    );
    // bigint columns are delivered as strings by pg (precision-safe on the wire).
    expect(result.rows[0]).toMatchObject({ booked_count: 0, availability_version: "1" });
  });

  it("rejects invariant violations through CHECK constraints", async () => {
    await expect(publish({ price_minor_units: "-1" }), "negative price").rejects.toThrow(/check/i);
    await expect(publish({ capacity: "0" }), "zero spots").rejects.toThrow(/check/i);
    await expect(publish({ currency: "'eur'" }), "lowercase currency").rejects.toThrow(/check/i);
    await expect(publish({ currency: "'EURO'" }), "overlong currency").rejects.toThrow(/check/i);
    await expect(publish({ display_timezone: "''" }), "empty timezone").rejects.toThrow(/check/i);
    await expect(publish({ title: "''" }), "empty title").rejects.toThrow(/check/i);
  });

  it("allows exactly one plan per activity through the unique index", async () => {
    const activityId = await withClient(appUrl, (client) =>
      client
        .query(
          `INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
           VALUES ($1, 'Planned Kayaking', now() + interval '48 hours', 'UTC', 2000, 'GBP', 3)
           RETURNING id`,
          [hostId],
        )
        .then((result) => result.rows[0].id as string),
    );

    const first = await withClient(appUrl, (client) =>
      client.query("INSERT INTO plans (activity_id) VALUES ($1) RETURNING id", [activityId]),
    );
    expect(first.rows[0].id).toBeTruthy();
    await expect(
      withClient(appUrl, (client) => client.query("INSERT INTO plans (activity_id) VALUES ($1)", [activityId])),
    ).rejects.toThrow(/duplicate key/);
  });

  it("keeps booked_count within capacity bounds", async () => {
    const activityId = await withClient(appUrl, (client) =>
      client
        .query(
          `INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
           VALUES ($1, 'Bounded Kayaking', now() + interval '48 hours', 'UTC', 2000, 'USD', 2)
           RETURNING id`,
          [hostId],
        )
        .then((result) => result.rows[0].id as string),
    );

    await expect(
      withClient(appUrl, (client) =>
        client.query("UPDATE activities SET booked_count = 3 WHERE id = $1", [activityId]),
      ),
    ).rejects.toThrow(/check/i);
  });
});
