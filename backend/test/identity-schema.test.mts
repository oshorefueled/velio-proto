import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resetAndMigrate, urlFor } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
});

async function appQuery(sql: string, params: string[] = []) {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("identity schema", () => {
  it("creates users, demo_sessions and events tables", async () => {
    const result = await appQuery(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const names = result.rows.map((row: { tablename: string }) => row.tablename);
    expect(names).toEqual(expect.arrayContaining(["users", "demo_sessions", "events"]));
  });

  it("rejects duplicate contact keys through the unique constraint", async () => {
    const key = uniqueKey("schema-dup");
    await appQuery(
      "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'First', 'direct', 0)",
      [key],
    );
    await expect(
      appQuery(
        "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Second', 'direct', 0)",
        [key],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("denies UPDATE and DELETE to the application role on identity and event tables", async () => {
    const updateExpression: Record<string, string> = {
      users: "display_name = 'x'",
      // Type-valid expression: literal parse errors would surface before the
      // privilege check and mask the denial being tested.
      demo_sessions: "expires_at = now()",
      events: "channel = 'x'",
    };
    for (const table of ["users", "demo_sessions", "events"]) {
      await expect(
        appQuery(`UPDATE ${table} SET ${updateExpression[table]}`),
      ).rejects.toThrow(/permission denied/);
      await expect(appQuery(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
  });

  it("enforces direct-at-generation-zero and name and key length invariants in the database", async () => {
    const key = uniqueKey("schema-check");
    await expect(
      appQuery(
        "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Invited', 'invite', 1)",
        [key],
      ),
    ).rejects.toThrow();
    await expect(
      appQuery(
        "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'TooOld', 'direct', 2)",
        [`${key}-b`],
      ),
    ).rejects.toThrow();
    await expect(
      appQuery(
        "INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, '', 'direct', 0)",
        [`${key}-c`],
      ),
    ).rejects.toThrow();
  });
});
