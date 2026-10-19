import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { withClient, urlFor, resetAndMigrate } from "./support/db.mts";
import { runWalkthrough } from "../scripts/acceptance-walkthrough.mts";
import { runAcceptanceLoad } from "../scripts/acceptance-load.mts";

/**
 * Reproducibility smoke for the acceptance load gate (issue #13): the same
 * runner that executes the 1,000-operation/20-in-flight acceptance command
 * proves its mechanics on a small workload — real HTTP against the real
 * server, distinct identities and operation ids, no oversell, and stored
 * counts that reconcile with the raw attempts. The full-scale run and its
 * retained result live in reports/ticket-13/attempt-1.
 */
beforeAll(async () => { await resetAndMigrate(urlFor("MIGRATION_DATABASE_URL", "velio_test")); });

describe("acceptance runners", () => {
  it("when unrelated acceptance-named records exist, a booking burst labels only its own data and reconciles spots", async () => {
    const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
    const sentinel = await withClient(migrationUrl, async client => {
      const user = await client.query("INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Unrelated', 'direct', 0) RETURNING id", [`acceptance-unrelated-${randomUUID()}`]);
      const activity = await client.query(`INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
        VALUES ($1, 'acceptance unrelated real activity', now() + interval '2 days', 'UTC', 0, 'EUR', 1) RETURNING id`, [user.rows[0].id]);
      return { userId: user.rows[0].id, activityId: activity.rows[0].id };
    });
    const walkthroughSentinel = await withClient(migrationUrl, async client => {
      const user = await client.query("INSERT INTO users (contact_key, display_name, signup_source, signup_generation) VALUES ($1, 'Unrelated', 'direct', 0) RETURNING id", [`walkthrough-unrelated-${randomUUID()}`]);
      const activity = await client.query(`INSERT INTO activities (host_id, title, starts_at, display_timezone, price_minor_units, currency, capacity)
        VALUES ($1, 'walkthrough unrelated real activity', now() + interval '2 days', 'UTC', 0, 'EUR', 1) RETURNING id`, [user.rows[0].id]);
      return { userId: user.rows[0].id, activityId: activity.rows[0].id };
    });
    const walkthrough = await runWalkthrough();
    expect(walkthrough.out.ok).toBe(true);
    await withClient(migrationUrl, async client => {
      const unrelated = await client.query("SELECT dataset FROM activities WHERE id=$1 UNION ALL SELECT dataset FROM users WHERE id=$2", [walkthroughSentinel.activityId, walkthroughSentinel.userId]);
      expect(unrelated.rows.map(row => row.dataset)).toEqual(["real", "real"]);
    });
    const result = await runAcceptanceLoad({ operations: 30, inFlight: 6 });

    await withClient(migrationUrl, async client => {
      const unrelated = await client.query("SELECT dataset FROM activities WHERE id=$1", [sentinel.activityId]);
      expect(unrelated.rows[0].dataset).toBe("real");
      const own = await client.query(`SELECT u.dataset FROM users u JOIN bookings b ON b.user_id=u.id WHERE b.activity_id=$1`, [result.verification.activityId]);
      expect(own.rows).toHaveLength(30);
      expect(own.rows.every(row => row.dataset === "demo")).toBe(true);
    });
    expect(result.workload.operations).toBe(30);
    expect(result.workload.inFlightMax).toBeGreaterThan(0);
    expect(result.workload.inFlightMax).toBeLessThanOrEqual(6);
    expect(result.attempts).toHaveLength(30);
    for (const attempt of result.attempts) {
      expect(attempt.status).toBe(201);
      expect(attempt.created).toBe(true);
    }
    expect(result.verification.consistent).toBe(true);
    expect(result.verification.oversoldActivities).toBe(0);
    expect(result.verification.bookings).toBe(30);
    expect(result.verification.storedBookedCount).toBe(30);
    expect(result.verification.attributionRows).toBe(30);
    expect(result.settings.quotaOverrideDisclosure).toContain("bookingRateLimitPerIp");
    const bookings = (result.metrics as { reliability?: { successfulNewSpotAttempts?: number } }).reliability;
    expect(bookings?.successfulNewSpotAttempts).toBeGreaterThanOrEqual(30);
  }, 60000);
});
