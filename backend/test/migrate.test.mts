import "../src/config.ts"; // loads the repo-root .env into process.env
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runMigrations } from "../src/db/migrate.ts";

// The migration role owns velio_test, so tests can reset its schema freely.
const testDbUrl = new URL(process.env.MIGRATION_DATABASE_URL as string);
testDbUrl.pathname = "/velio_test";
const migrationUrl = testDbUrl.href;

async function resetSchema() {
  // Drop every table but keep the public schema itself: recreating the schema
  // would change its OID and void the default privileges set at cluster init.
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  await client.query(`
    DO $$
    DECLARE table_name text;
    BEGIN
      FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', table_name);
      END LOOP;
    END
    $$;
  `);
  await client.end();
}

let tempDir: string;

beforeEach(async () => {
  await resetSchema();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "velio-migrations-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("succeeds applying nothing against an empty migrations directory", async () => {
    const result = await runMigrations({ migrationUrl, dir: tempDir });
    expect(result).toEqual({ applied: [], skipped: [] });
  });

  it("applies a migration, records it, and creates the migrated object", async () => {
    writeFileSync(
      path.join(tempDir, "0001_create_probe.sql"),
      "CREATE TABLE probe_migrated (id int PRIMARY KEY);",
    );
    const result = await runMigrations({ migrationUrl, dir: tempDir });
    expect(result.applied).toEqual(["0001_create_probe.sql"]);

    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    const rows = await client.query("SELECT name FROM schema_migrations ORDER BY name");
    await client.query("SELECT id FROM probe_migrated"); // object exists
    await client.end();
    expect(rows.rows.map((r) => r.name)).toEqual(["0001_create_probe.sql"]);
  });

  it("is idempotent: a rerun skips recorded migrations and changes nothing", async () => {
    writeFileSync(
      path.join(tempDir, "0001_create_probe.sql"),
      "CREATE TABLE probe_migrated (id int PRIMARY KEY);",
    );
    await runMigrations({ migrationUrl, dir: tempDir });
    const second = await runMigrations({ migrationUrl, dir: tempDir });
    expect(second).toEqual({ applied: [], skipped: ["0001_create_probe.sql"] });
  });

  it("applies pending migrations in lexicographic order and skips the rest", async () => {
    writeFileSync(path.join(tempDir, "0001_first.sql"), "SELECT 1;");
    await runMigrations({ migrationUrl, dir: tempDir });
    writeFileSync(path.join(tempDir, "0002_second.sql"), "SELECT 2;");
    const result = await runMigrations({ migrationUrl, dir: tempDir });
    expect(result).toEqual({ applied: ["0002_second.sql"], skipped: ["0001_first.sql"] });
  });

  it("rolls back a failing migration completely", async () => {
    writeFileSync(
      path.join(tempDir, "0001_bad.sql"),
      "CREATE TABLE probe_rollback (id int PRIMARY KEY);\nTHIS IS NOT SQL;",
    );
    await expect(runMigrations({ migrationUrl, dir: tempDir })).rejects.toThrow(/0001_bad\.sql/);

    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    const records = await client.query("SELECT name FROM schema_migrations");
    await client.end();
    expect(records.rows).toEqual([]); // no record for the failed migration
  });

  it("serializes concurrent runners so each migration is applied exactly once", async () => {
    writeFileSync(
      path.join(tempDir, "0001_once.sql"),
      "CREATE TABLE probe_concurrent (id int PRIMARY KEY);",
    );
    const [first, second] = await Promise.all([
      runMigrations({ migrationUrl, dir: tempDir }),
      runMigrations({ migrationUrl, dir: tempDir }),
    ]);

    const applications = [...first.applied, ...second.applied].filter(
      (name) => name === "0001_once.sql",
    );
    expect(applications).toEqual(["0001_once.sql"]);
  });
});
