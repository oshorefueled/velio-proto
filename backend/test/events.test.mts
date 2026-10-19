import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { appendEvent } from "../src/events/append.ts";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
});

describe("appendEvent", () => {
  it("appends an event row with a database timestamp", async () => {
    await withClient(migrationUrl, async (client) => {
      await client.query("BEGIN");
      await appendEvent(client, { eventName: "user_created", dedupKey: "dedup-appends-1", details: { source: "direct" } });
      await client.query("COMMIT");
    });
    await withClient(migrationUrl, async (client) => {
      const result = await client.query(
        "SELECT event_name, dedup_key, details, occurred_at IS NOT NULL AS has_time FROM events WHERE dedup_key = 'dedup-appends-1'",
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].event_name).toBe("user_created");
      expect(result.rows[0].details).toEqual({ source: "direct" });
      expect(result.rows[0].has_time).toBe(true);
    });
  });

  it("is replay-safe: the same dedup key writes one row even across transactions", async () => {
    await withClient(migrationUrl, async (client) => {
      await client.query("BEGIN");
      await appendEvent(client, { eventName: "user_created", dedupKey: "dedup-appends-2" });
      await client.query("COMMIT");
    });
    await withClient(migrationUrl, async (client) => {
      await client.query("BEGIN");
      await appendEvent(client, { eventName: "user_created", dedupKey: "dedup-appends-2" });
      await client.query("COMMIT");
    });
    await withClient(migrationUrl, async (client) => {
      const result = await client.query("SELECT count(*)::int AS n FROM events WHERE dedup_key = 'dedup-appends-2'");
      expect(result.rows[0].n).toBe(1);
    });
  });

  it("keeps events without dedup keys independent", async () => {
    await withClient(migrationUrl, async (client) => {
      await client.query("BEGIN");
      await appendEvent(client, { eventName: "account_entry_completed" });
      await appendEvent(client, { eventName: "account_entry_completed" });
      await client.query("COMMIT");
    });
    await withClient(migrationUrl, async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'account_entry_completed' AND dedup_key IS NULL",
      );
      expect(result.rows[0].n).toBe(2);
    });
  });

  it("rolls back with the caller's transaction", async () => {
    await withClient(migrationUrl, async (client) => {
      await client.query("BEGIN");
      await appendEvent(client, { eventName: "user_created", dedupKey: "dedup-appends-3" });
      await client.query("ROLLBACK");
    });
    await withClient(migrationUrl, async (client) => {
      const result = await client.query("SELECT count(*)::int AS n FROM events WHERE dedup_key = 'dedup-appends-3'");
      expect(result.rows[0].n).toBe(0);
    });
  });
});
