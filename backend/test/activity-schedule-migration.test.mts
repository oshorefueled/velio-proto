import "../src/config.ts";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.ts";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

it("when activities predate end times and countries, migration ends them two hours after start in the United Kingdom", async () => {
  const url = urlFor("MIGRATION_DATABASE_URL", "velio_test");
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  await resetAndMigrate(url);
  await withClient(url, client => client.query(`
    ALTER TABLE activities DROP COLUMN ends_at, DROP COLUMN country_code;
    DELETE FROM schema_migrations WHERE name='0015_activity_schedule_location.sql'`));
  await withClient(url, client => client.query(`
    WITH u AS (INSERT INTO users (contact_key,display_name,signup_source,signup_generation) VALUES ('schedule@example.test','Schedule','direct',0) RETURNING id)
    INSERT INTO activities (host_id,title,starts_at,display_timezone,price_minor_units,currency,capacity)
    SELECT id,'Historical','2026-03-29T00:30:00Z','Europe/London',100,'GBP',5 FROM u`));
  await runMigrations({ migrationUrl: url, dir: migrations });
  const rows = await withClient(url, client => client.query(
    "SELECT starts_at, ends_at, country_code FROM activities WHERE title='Historical'"));
  expect(rows.rows).toEqual([{
    starts_at: new Date("2026-03-29T00:30:00Z"),
    ends_at: new Date("2026-03-29T02:30:00Z"),
    country_code: "GB",
  }]);
  await resetAndMigrate(url);
});
