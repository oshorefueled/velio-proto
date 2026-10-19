import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.ts";
import {
  establishIdentity,
  resolveSession,
  SessionExpiredError,
  SessionInvalidError,
} from "../src/identity/service.ts";
import { ValidationError } from "../src/identity/domain.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let deps: Parameters<typeof establishIdentity>[0];

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  // Cleanup requires the migration role: the app role cannot delete.
  await clearIdentityData(migrationUrl);
  const pool = createPool(appUrl);
  deps = { pool, sessionTtlHours: 12 };
  return () => pool.end();
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function sessionRowCount(key: string): Promise<number> {
  return withClient(migrationUrl, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM demo_sessions s
       JOIN users u ON u.id = s.user_id WHERE u.contact_key = $1`,
      [key],
    );
    return result.rows[0].n as number;
  });
}

describe("establishIdentity", () => {
  it("creates a new user with direct acquisition at generation zero and deduplicated events", async () => {
    const key = uniqueKey("identity-create");
    const result = await establishIdentity(deps, { contactKey: key, displayName: "Ada Reiter" });

    expect(result.created).toBe(true);
    expect(result.user).toMatchObject({
      contactKey: key,
      displayName: "Ada Reiter",
      signupSource: "direct",
      signupGeneration: 0,
    });

    await withClient(migrationUrl, async (client) => {
      const events = await client.query(
        "SELECT event_name, dedup_key FROM events WHERE user_id = $1 ORDER BY event_name",
        [result.user.id],
      );
      expect(events.rows.map((row) => row.event_name).sort()).toEqual([
        "account_entry_completed",
        "user_created",
      ]);
      expect(events.rows.find((row) => row.event_name === "user_created").dedup_key).toBe(
        `user_created:${result.user.id}`,
      );
    });
  });

  it("resumes the same person for an existing contact key without a second user_created", async () => {
    const key = uniqueKey("identity-resume");
    const first = await establishIdentity(deps, { contactKey: key, displayName: "Original Name" });
    const second = await establishIdentity(deps, { contactKey: key, displayName: "Ignored" });

    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe("Original Name"); // resume keeps the recorded identity

    await withClient(migrationUrl, async (client) => {
      const users = await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key = $1", [key]);
      const created = await client.query(
        "SELECT count(*)::int AS n FROM events WHERE dedup_key = $1",
        [`user_created:${first.user.id}`],
      );
      expect(users.rows[0].n).toBe(1);
      expect(created.rows[0].n).toBe(1);
      expect(await sessionRowCount(key)).toBe(2); // one session per establishment

      // Both identity steps are recorded once each, distinguishable by mode.
      const steps = await client.query(
        `SELECT details ->> 'mode' AS mode FROM events
         WHERE event_name = 'account_entry_completed' AND user_id = $1
         ORDER BY occurred_at`,
        [first.user.id],
      );
      expect(steps.rows.map((row) => row.mode)).toEqual(["created", "resumed"]);
    });
  });

  it("converges concurrent repeated establishment on one person with one user_created event", async () => {
    const key = uniqueKey("identity-race");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => establishIdentity(deps, { contactKey: key, displayName: "Racer" })),
    );

    const userIds = new Set(results.map((result) => result.user.id));
    expect(userIds.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const sharedUserId = results[0]?.user.id;
    if (sharedUserId === undefined) throw new Error("concurrent establishment produced no results");

    await withClient(migrationUrl, async (client) => {
      const users = await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key = $1", [key]);
      const created = await client.query(
        "SELECT count(*)::int AS n FROM events WHERE event_name = 'user_created' AND user_id = $1",
        [sharedUserId],
      );
      expect(users.rows[0].n).toBe(1);
      expect(created.rows[0].n).toBe(1);
    });
  });

  it("gives different contacts different people", async () => {
    const a = await establishIdentity(deps, { contactKey: uniqueKey("identity-a"), displayName: "A" });
    const b = await establishIdentity(deps, { contactKey: uniqueKey("identity-b"), displayName: "B" });
    expect(a.user.id).not.toBe(b.user.id);
  });

  it("rejects invalid establishment input as ValidationError", async () => {
    await expect(establishIdentity(deps, { contactKey: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(establishIdentity(deps, { contactKey: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(establishIdentity(deps, { contactKey: "x".repeat(121) })).rejects.toBeInstanceOf(ValidationError);
    await expect(establishIdentity(deps, { contactKey: uniqueKey("identity-noname") })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("resolveSession", () => {
  it("round-trips a session token to its user", async () => {
    const key = uniqueKey("identity-roundtrip");
    const established = await establishIdentity(deps, { contactKey: key, displayName: "Round Trip" });
    const resolved = await resolveSession(deps, established.session.token);
    expect(resolved.id).toBe(established.user.id);
  });

  it("issues an opaque token that is neither the stored hash nor the session id", async () => {
    const key = uniqueKey("identity-opaque");
    const established = await establishIdentity(deps, { contactKey: key, displayName: "Opaque" });
    expect(established.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    await withClient(migrationUrl, async (client) => {
      const session = await client.query(
        "SELECT id, token_hash FROM demo_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [established.user.id],
      );
      expect(established.session.token).not.toBe(session.rows[0].token_hash);
      expect(established.session.token).not.toBe(session.rows[0].id);
    });
  });

  it("rejects unknown tokens as invalid", async () => {
    await expect(resolveSession(deps, "not-a-real-token")).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it("rejects an expired session distinctly and keeps the user", async () => {
    const key = uniqueKey("identity-expiry");
    const established = await establishIdentity(deps, { contactKey: key, displayName: "Expiring" });
    await withClient(migrationUrl, async (client) => {
      // Shift the whole session into the past: keeps the born-valid CHECK
      // (expires_at > created_at) while expiring it against the DB clock.
      await client.query(
        "UPDATE demo_sessions SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1",
        [established.user.id],
      );
    });
    await expect(resolveSession(deps, established.session.token)).rejects.toBeInstanceOf(SessionExpiredError);

    // The person still exists: re-establishing resolves the same user id.
    const again = await establishIdentity(deps, { contactKey: key });
    expect(again.user.id).toBe(established.user.id);
  });
});
