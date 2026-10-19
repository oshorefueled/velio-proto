import "../src/config.ts"; // loads the repo-root .env into process.env
import { describe, expect, it } from "vitest";
import { Client } from "pg";

function appUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = "/velio_test";
  return url.href;
}

function migratorUrl(): string {
  const url = new URL(process.env.MIGRATION_DATABASE_URL as string);
  url.pathname = "/velio_test";
  return url.href;
}

describe("database role separation", () => {
  it("refuses DDL to the application role", async () => {
    const client = new Client({ connectionString: appUrl() });
    await client.connect();
    await expect(
      client.query("CREATE TABLE probe_app_ddl (id int)"),
    ).rejects.toThrow(/permission denied/);
    await client.end();
  });

  it("lets the migration role create schema objects", async () => {
    const client = new Client({ connectionString: migratorUrl() });
    await client.connect();
    await client.query("CREATE TABLE probe_migration_ddl (id int PRIMARY KEY)");
    await client.query("DROP TABLE probe_migration_ddl");
    await client.end();
  });

  it("grants the application role DML on migration-owned tables via default privileges", async () => {
    const migrator = new Client({ connectionString: migratorUrl() });
    await migrator.connect();
    await migrator.query(
      "CREATE TABLE probe_default_grants (id int PRIMARY KEY, note text)",
    );
    const app = new Client({ connectionString: appUrl() });
    await app.connect();
    await app.query("INSERT INTO probe_default_grants VALUES (1, 'app-role-write')");
    const rows = await app.query("SELECT note FROM probe_default_grants");
    await app.end();
    await migrator.query("DROP TABLE probe_default_grants");
    await migrator.end();
    expect(rows.rows).toEqual([{ note: "app-role-write" }]);
  });
});
