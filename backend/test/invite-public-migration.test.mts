import "../src/config.ts";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.ts";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

it("when historical public links conflict, migration refuses uniqueness without deleting or rewriting their history", async () => {
  const url = urlFor("MIGRATION_DATABASE_URL", "velio_test");
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  await resetAndMigrate(url);
  // Recreate the pre-Ticket-03 schema in this dedicated test database.
  await withClient(url, client => client.query("DROP INDEX invites_public_account_activity; DELETE FROM schema_migrations WHERE name='0013_reusable_public_invites.sql'"));
  await withClient(url, client => client.query(`
    WITH u AS (INSERT INTO users (contact_key,display_name,signup_source,signup_generation) VALUES ('historical@example.test','Historical','direct',0) RETURNING id),
    a AS (INSERT INTO activities (host_id,title,starts_at,display_timezone,price_minor_units,currency,capacity) SELECT id,'Historical',now()+interval '48 hours','UTC',100,'EUR',5 FROM u RETURNING id,host_id),
    p AS (INSERT INTO plans (activity_id) SELECT id FROM a RETURNING id,activity_id)
    INSERT INTO invites (code,rail,creator_id,activity_id,plan_id,generation,expires_at)
    SELECT code,'public_share',a.host_id,a.id,p.id,1,now()+interval '24 hours'
    FROM a JOIN p ON p.activity_id=a.id CROSS JOIN (VALUES ('H1ST0RYAAAAA'),('H1ST0RYBBBBB')) codes(code)
  `));
  const before = await withClient(url, client => client.query("SELECT * FROM invites ORDER BY code"));
  await expect(runMigrations({ migrationUrl: url, dir: migrations })).rejects.toThrow(/invites_public_account_activity/);
  const after = await withClient(url, client => client.query("SELECT * FROM invites ORDER BY code"));
  expect(after.rows).toEqual(before.rows);
  expect(after.rows).toHaveLength(2);
});
