import "../src/config.ts"; // loads the repo-root .env into process.env
import { readFileSync } from "node:fs";
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
      "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Experiment Schema Host', 'direct', 0) RETURNING id",
      [`exp-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    return result.rows[0].id as string;
  });
});

/** Insert an activity with the migration role and no assignment row. */
async function insertActivity(title: string): Promise<string> {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
         VALUES ($1, $2, now() + interval '48 hours', 'UTC', 100, 'EUR', 5) RETURNING id`,
        [hostId, title],
      )
      .then((r) => r.rows[0].id as string),
  );
}

describe("activity_experiments schema", () => {
  it("accepts only treatment and control arms", async () => {
    const activityId = await insertActivity("Arm Check");
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          "INSERT INTO activity_experiments (activity_id, arm, experiment_version) VALUES ($1, 'holdout', 'v1')",
          [activityId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps exactly one assignment per activity", async () => {
    const activityId = await insertActivity("One Assignment");
    await withClient(migrationUrl, (client) =>
      client.query(
        "INSERT INTO activity_experiments (activity_id, arm, experiment_version) VALUES ($1, 'treatment', 'v1')",
        [activityId],
      ),
    );
    await expect(
      withClient(migrationUrl, (client) =>
        client.query(
          "INSERT INTO activity_experiments (activity_id, arm, experiment_version) VALUES ($1, 'control', 'v2')",
          [activityId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects assignment updates and deletes for every role", async () => {
    const activityId = await insertActivity("Immutable");
    await withClient(migrationUrl, (client) =>
      client.query(
        "INSERT INTO activity_experiments (activity_id, arm, experiment_version) VALUES ($1, 'control', 'v1')",
        [activityId],
      ),
    );
    // The application role is denied by the revoked grants before any
    // statement runs; the migration role owns the table, so there the
    // mutation-rejecting trigger is the layer that refuses.
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      await expect(
        app.query("UPDATE activity_experiments SET arm = 'treatment' WHERE activity_id = $1", [activityId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query("DELETE FROM activity_experiments WHERE activity_id = $1", [activityId]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    await expect(
      withClient(migrationUrl, (client) =>
        client.query("UPDATE activity_experiments SET arm = 'treatment' WHERE activity_id = $1", [activityId]),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withClient(migrationUrl, (client) =>
        client.query("DELETE FROM activity_experiments WHERE activity_id = $1", [activityId]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("backfills activities without an assignment exactly once, without reassigning", async () => {
    // Simulate a pre-feature activity: inserted after the migrations ran, so
    // no assignment exists and no application path will ever assign it.
    const legacyId = await insertActivity("Legacy Backfill");
    const before = await withClient(migrationUrl, (client) =>
      client.query("SELECT count(*)::int AS n FROM activity_experiments WHERE activity_id = $1", [legacyId]),
    );
    expect(before.rows[0].n).toBe(0);

    // Execute the migration's own backfill statement (everything after the
    // '-- backfill:' marker), so the test runs the real artifact.
    const migration = readFileSync(
      new URL("../migrations/0004_activity_experiments.sql", import.meta.url),
      "utf8",
    );
    const tail = migration.split("-- backfill:")[1];
    expect(tail, "migration 0004 must carry a '-- backfill:' section").toBeTruthy();
    const backfill = (tail as string).slice(tail!.indexOf("\n") + 1);
    await withClient(migrationUrl, (client) => client.query(backfill));

    const first = await withClient(migrationUrl, (client) =>
      client.query("SELECT arm, experiment_version, assigned_at FROM activity_experiments WHERE activity_id = $1", [legacyId]),
    );
    expect(first.rows[0]).toMatchObject({ experiment_version: "rollout-1" });
    expect(["treatment", "control"]).toContain(first.rows[0].arm);

    // Re-running never reassigns: same single row, same arm, same timestamp.
    await withClient(migrationUrl, (client) => client.query(backfill));
    const second = await withClient(migrationUrl, (client) =>
      client.query("SELECT arm, experiment_version, assigned_at FROM activity_experiments WHERE activity_id = $1", [legacyId]),
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].arm).toBe(first.rows[0].arm);
    expect((second.rows[0].assigned_at as Date).getTime()).toBe((first.rows[0].assigned_at as Date).getTime());
  });
});
