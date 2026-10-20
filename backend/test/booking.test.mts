import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Pool } from "pg";
import { createPool } from "../src/db/pool.ts";
import { Redis } from "ioredis";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import {
  ActivityNotFoundError,
  ActivitySoldOutError,
  ActivityStartedError,
  BookingFailedError,
  LockTimeoutError,
} from "../src/booking/domain.ts";
import {
  bookActivity,
  classifyBookingFailure,
  getMyBooking,
  type BookingDeps,
} from "../src/booking/service.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let deps: BookingDeps;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl, { max: 10 });
  const redis = new Redis(process.env.REDIS_URL as string);
  redis.on("error", () => {});
  // Generous test quotas; the dedicated quota boundary test overrides downward.
  deps = {
    pool,
    redis,
    quota: { perIdentity: 1000, perIp: 100000, windowSeconds: 3600 },
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
  };
  return () => {
    redis.quit();
    return pool.end();
  };
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function newPerson(displayName: string): Promise<UserSnapshot> {
  return (
    await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("bk4"), displayName })
  ).user;
}

async function publishActivity(hostId: string, capacity: number, startsInMs = 48 * 3600 * 1000): Promise<string> {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `WITH new_activity AS (
           INSERT INTO activities (host_id, title, starts_at, ends_at, display_timezone, price_minor_units, currency, capacity)
           VALUES ($1, 'Race Kayak', now() + make_interval(secs => $2), now() + make_interval(secs => $2) + interval '2 hours', 'UTC', 1000, 'EUR', $3)
           RETURNING id
         ), new_plan AS (
           INSERT INTO plans (activity_id) SELECT id FROM new_activity RETURNING id
         )
         SELECT new_activity.id AS activity_id, new_plan.id AS plan_id FROM new_activity, new_plan`,
        [hostId, startsInMs / 1000, capacity],
      )
      .then((r) => r.rows[0].activity_id as string),
  );
}

async function counts(activityId: string) {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `SELECT
           (SELECT booked_count FROM activities WHERE id = $1) AS booked_count,
           (SELECT availability_version FROM activities WHERE id = $1) AS availability_version,
           (SELECT count(*)::int FROM bookings WHERE activity_id = $1) AS booking_rows,
           (SELECT count(*)::int FROM booking_attributions ba
              JOIN bookings b ON b.id = ba.booking_id WHERE b.activity_id = $1) AS attributions,
           (SELECT count(*)::int FROM events
              WHERE event_name = 'booking_confirmed'
                AND activity_id = $1) AS confirmed_events`,
        [activityId],
      )
      .then((r) => r.rows[0] as Record<string, number>),
  );
}

describe("classifyBookingFailure", () => {
  const cases: Array<[string, unknown, boolean, string]> = [
    ["lock timeout before commit", { code: "55P03", message: "lock timeout" }, false, "lock_timeout"],
    ["lock timeout at commit", { code: "55P03", message: "lock timeout" }, true, "lock_timeout"],
    ["statement cancellation before commit", { code: "57014", message: "canceling statement" }, false, "failed"],
    ["statement cancellation at commit", { code: "57014", message: "canceling statement" }, true, "failed"],
    ["serialization failure at commit", { code: "40001", message: "could not serialize" }, true, "failed"],
    ["constraint violation at commit", { code: "23505", message: "duplicate key" }, true, "failed"],
    ["socket reset at commit (system code, not SQLSTATE)", { code: "ECONNRESET", message: "read ECONNRESET" }, true, "commit_unknown"],
    ["terminated connection at commit (no code)", { message: "Connection terminated unexpectedly" }, true, "commit_unknown"],
    ["any failure before commit is definitive", { message: "Connection terminated unexpectedly" }, false, "failed"],
  ];
  it.each(cases)("%s", (_label, err, commitAttempted, expected) => {
    expect(classifyBookingFailure(err, commitAttempted)).toBe(expected);
  });
});

describe("bookActivity", () => {
  it("confirms one spot atomically with direct attribution and a single confirmed event", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Booker");
    const activityId = await publishActivity(host.id, 3);
    const operationId = randomUUID();

    const result = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId });

    expect(result.created).toBe(true);
    expect(result.availabilityVersion).toBe("2");
    expect(result.booking).toMatchObject({
      activityId,
      planId: result.booking.planId,
      userId: booker.id,
      attribution: { rail: "direct", generation: 0 },
    });

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, attributions: 1, confirmed_events: 1 });

    await withClient(migrationUrl, (client) => {
      const attempts = client.query(
        `SELECT details ->> 'outcome' AS outcome, booking_id, plan_id
         FROM events WHERE event_name = 'booking_attempted' AND user_id = $1`,
        [booker.id],
      );
      const confirmed = client.query(
        "SELECT booking_id, plan_id FROM events WHERE dedup_key = $1",
        [`booking_confirmed:${result.booking.id}`],
      );
      return Promise.all([attempts, confirmed]).then(([attemptRows, confirmedRows]) => {
        const outcomes = attemptRows.rows.map((row) => row.outcome);
        expect(outcomes).toContain("created");
        expect(outcomes).toHaveLength(1); // one attempt, one record
        // Structured event columns carry the booking and its plan (PLANS 3.2).
        expect(confirmedRows.rows[0].booking_id).toBe(result.booking.id);
        expect(confirmedRows.rows[0].plan_id).toBe(result.booking.planId);
      });
    });
  });

  it("returns the existing booking before lifecycle and capacity gates, even after start", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Booker");
    const activityId = await publishActivity(host.id, 2);
    const operationId = randomUUID();
    const first = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId });

    // Force the activity into the past: a replay must still return the booking.
    await withClient(migrationUrl, (client) =>
      client.query("UPDATE activities SET starts_at = now() - interval '1 hour' WHERE id = $1", [activityId]),
    );

    const replay = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId });
    expect(replay.created).toBe(false);
    expect(replay.booking.id).toBe(first.booking.id);

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, attributions: 1, confirmed_events: 1 });

    const looked = await getMyBooking(deps, booker, activityId);
    expect(looked.id).toBe(first.booking.id);
  });

  it("sells out without overselling", async () => {
    const host = await newPerson("Host");
    const first = await newPerson("First");
    const second = await newPerson("Second");
    const activityId = await publishActivity(host.id, 1);

    await bookActivity(deps, first, activityId, { ip: "127.0.0.1", operationId: randomUUID() });
    await expect(
      bookActivity(deps, second, activityId, { ip: "127.0.0.1", operationId: randomUUID() }),
    ).rejects.toBeInstanceOf(ActivitySoldOutError);

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, confirmed_events: 1 });
  });

  it("refuses a new booking decided after the start despite waiting on the activity lock", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Late Booker");
    // Start 1 second out; the lock holder blocks the row for 1.6 seconds, so
    // the booking decision (clock_timestamp after the lock) lands post-start.
    const activityId = await publishActivity(host.id, 2, 1000);

    const holder = new Client({ connectionString: migrationUrl });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM activities WHERE id = $1 FOR UPDATE", [activityId]);
    const booking = bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId: randomUUID() });
    booking.catch(() => {}); // the rejection is asserted below
    await new Promise((resolve) => setTimeout(resolve, 150));
    await holder.query("SELECT pg_sleep(1.6)");
    await holder.query("COMMIT");
    await holder.end();

    await expect(booking).rejects.toBeInstanceOf(ActivityStartedError);
    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, confirmed_events: 0 });
  });

  it("records a lock timeout and consumes nothing when the row stays locked", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Impatient");
    const activityId = await publishActivity(host.id, 2);

    const holder = new Client({ connectionString: migrationUrl });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM activities WHERE id = $1 FOR UPDATE", [activityId]);

    const booking = bookActivity(deps, booker, activityId, {
      ip: "127.0.0.1",
      operationId: randomUUID(),
      lockTimeoutMs: 200,
    });
    await expect(booking).rejects.toBeInstanceOf(LockTimeoutError);

    await holder.query("ROLLBACK");
    await holder.end();

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, attributions: 0, confirmed_events: 0 });
    await withClient(migrationUrl, async (client) => {
      const rows = await client
        .query(
          "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
          [booker.id],
        )
        .then((r) => r.rows);
      expect(rows.map((row) => row.outcome)).toContain("lock_timeout");
    });
  });

  it("rolls back every transactional write when the attribution insert fails after the capacity update", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Rolled Back");
    const activityId = await publishActivity(host.id, 2);
    await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId: randomUUID() }); // seat 1

    const second = await newPerson("Second Rolled Back");
    // Fault injection at the exact window: after the capacity update, before
    // attribution/events — installed by the migration role, no production seam.
    await withClient(migrationUrl, (client) => {
      client.query(`CREATE OR REPLACE FUNCTION probe_inject_failure() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
      return client.query(
        "CREATE TRIGGER probe_inject BEFORE INSERT ON booking_attributions FOR EACH ROW EXECUTE FUNCTION probe_inject_failure()",
      );
    });
    const outcome = await bookActivity(deps, second, activityId, { ip: "127.0.0.1", operationId: randomUUID() }).then(
      () => "unexpected-success",
      (err) => (err instanceof BookingFailedError ? "failed" : `other:${String(err)}`),
    );
    await withClient(migrationUrl, (client) =>
      client.query("DROP TRIGGER probe_inject ON booking_attributions"),
    );
    expect(outcome).toBe("failed");

    // Seat 1's committed state is untouched; the failed attempt left nothing.
    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, attributions: 1, confirmed_events: 1 });
    await withClient(migrationUrl, async (client) => {
      const rows = await client
        .query(
          "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
          [second.id],
        )
        .then((r) => r.rows);
      expect(rows.map((row) => row.outcome)).toEqual(["failed"]);
    });
  });

  it("keeps a repeated same-identity race at exactly one booking", async () => {
    const host = await newPerson("Host");
    const booker = await newPerson("Impatient Retry");
    const activityId = await publishActivity(host.id, 5);
    const operationId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId }).catch((err) => err),
      ),
    );
    const created = results.filter((r) => !(r instanceof Error) && r.created);
    const replays = results.filter((r) => !(r instanceof Error) && !r.created);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(7);
    const ids = new Set(
      results.filter((r) => !(r instanceof Error)).map((r) => (r as { booking: { id: string } }).booking.id),
    );
    expect(ids.size).toBe(1);
    expect(await counts(activityId)).toMatchObject({ booked_count: 1, booking_rows: 1, confirmed_events: 1 });
  });

  it("surfaces the sold-out decision when the sold-out path's commit fails", async () => {
    const host = await newPerson("Sold-Out Commit Host");
    const winner = await newPerson("Sold-Out Winner");
    const loser = await newPerson("Sold-Out Loser");
    const activityId = await publishActivity(host.id, 1);
    await bookActivity(deps, winner, activityId, { ip: "127.0.0.1", operationId: randomUUID() });

    // Deferred trigger fires at COMMIT of the loser's sold-out attempt: a
    // real coded COMMIT-time failure on the no-seat path.
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_sold_out_commit() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected sold-out commit failure'; END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE CONSTRAINT TRIGGER probe_fail_sold_out_t AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_fail_sold_out_commit()",
      );
    });
    const outcome = await bookActivity(deps, loser, activityId, { ip: "127.0.0.1", operationId: randomUUID() }).then(
      () => "unexpected-success",
      (err) => (err instanceof ActivitySoldOutError ? "sold_out" : `other:${err.name}:${err.message}`),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_sold_out_t ON events"));
    // The client still receives the truthful sold-out decision: the decision
    // was made against the locked row and needs no durable state of its own.
    expect(outcome).toBe("sold_out");

    // Winner state untouched; no false confirmation for the loser. (The
    // loser's sold-out attempt-evidence row cannot survive this injection —
    // every events write fails at commit — and the best-effort post-rollback
    // re-record accepts that loss rather than masking the failure.)
    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, confirmed_events: 1 });
  });

  it("returns the existing booking even when the replay's evidence commit fails", async () => {
    const host = await newPerson("Replay Commit Host");
    const booker = await newPerson("Replay Commit Booker");
    const activityId = await publishActivity(host.id, 2);
    const operationId = randomUUID();
    const first = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId });

    // Deferred trigger fails the COMMIT of the replay's evidence write. The
    // booking predates this transaction, so the replay must still return it
    // — not claim a failure about an already-committed spot.
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_existing_commit() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_name = 'booking_attempted' THEN
            RAISE EXCEPTION 'injected existing-commit failure';
          END IF;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE CONSTRAINT TRIGGER probe_fail_existing_t AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_fail_existing_commit()",
      );
    });
    const replay = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId });
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_existing_t ON events"));
    expect(replay.created).toBe(false);
    expect(replay.booking.id).toBe(first.booking.id);

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 1, booking_rows: 1, attributions: 1, confirmed_events: 1 });
  });

  it("surfaces the started decision when the started path's commit fails", async () => {
    const host = await newPerson("Started Commit Host");
    const booker = await newPerson("Started Commit Booker");
    // Already started: the decision is refused regardless of the evidence
    // commit, so a commit-time failure must not turn it into a 500.
    const activityId = await publishActivity(host.id, 2, -3600 * 1000);
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_started_commit() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_name = 'booking_attempted' THEN
            RAISE EXCEPTION 'injected started-commit failure';
          END IF;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE CONSTRAINT TRIGGER probe_fail_started_t AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_fail_started_commit()",
      );
    });
    const outcome = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId: randomUUID() }).then(
      () => "unexpected-success",
      (err) => (err instanceof ActivityStartedError ? "started" : `other:${err.name}:${err.message}`),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_started_t ON events"));
    expect(outcome).toBe("started");

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, confirmed_events: 0 });
  });

  it("classifies a coded COMMIT failure as a definitive rollback with surviving evidence", async () => {
    const host = await newPerson("Uncertain Host");
    const booker = await newPerson("Uncertain Booker");
    const activityId = await publishActivity(host.id, 2);
    // Deferred trigger fires at COMMIT: a real, coded commit-time failure.
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_commit() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_name = 'booking_confirmed' THEN
            RAISE EXCEPTION 'injected commit failure';
          END IF;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql`);
      // Deferred to COMMIT: the confirmed event's insert passes, the commit
      // itself fails (a real coded commit-time failure), and the attempt
      // evidence insert — a different event — survives the rollback window.
      await client.query(
        "CREATE CONSTRAINT TRIGGER probe_fail_commit_t AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION probe_fail_commit()",
      );
    });
    const outcome = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId: randomUUID() }).then(
      () => "unexpected-success",
      (err) => (err instanceof BookingFailedError ? "failed" : `other:${err.name}:${err.message}`),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_commit_t ON events"));
    expect(outcome).toBe("failed");

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, attributions: 0, confirmed_events: 0 });
    // The in-transaction attempt row rolled back with the commit; the
    // post-rollback re-record keeps one truthful "failed" evidence row.
    await withClient(migrationUrl, async (client) => {
      const rows = await client
        .query(
          "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
          [booker.id],
        )
        .then((r) => r.rows);
      expect(rows.map((row) => row.outcome)).toEqual(["failed"]);
    });
  });

  it("reports unknown activities distinctly", async () => {
    const booker = await newPerson("Ghost Booker");
    await expect(
      bookActivity(deps, booker, randomUUID(), { ip: "127.0.0.1", operationId: randomUUID() }),
    ).rejects.toBeInstanceOf(ActivityNotFoundError);
  });

  it("propagates attempt-recording failures instead of claiming a confirmation", async () => {
    const host = await newPerson("Trigger Host");
    const booker = await newPerson("Trigger Booker");
    const activityId = await publishActivity(host.id, 2);
    // Migration-role fault injection at the attempt-evidence write: if the
    // service swallowed this in-transaction failure, it would still claim a
    // confirmation that does not exist.
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_attempted() RETURNS trigger AS $$
        BEGIN IF NEW.event_name = 'booking_attempted' THEN RAISE EXCEPTION 'injected attempt failure'; END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE TRIGGER probe_fail_attempted_t BEFORE INSERT ON events FOR EACH ROW WHEN (NEW.event_name = 'booking_attempted') EXECUTE FUNCTION probe_fail_attempted()",
      );
    });
    const outcome = await bookActivity(deps, booker, activityId, { ip: "127.0.0.1", operationId: randomUUID() }).then(
      () => "unexpected-success",
      (err) => (err instanceof BookingFailedError ? "failed" : `other:${err.name}:${err.message}`),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_attempted_t ON events"));
    expect(outcome).toBe("failed");

    // Nothing was retained: the claimed confirmation must not exist.
    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, attributions: 0, confirmed_events: 0 });
    // No false "created" attempt evidence either.
    await withClient(migrationUrl, async (client) => {
      const rows = await client
        .query(
          "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
          [booker.id],
        )
        .then((r) => r.rows);
      expect(rows.map((row) => row.outcome)).not.toContain("created");
    });
  });

  it("cancels a booking statement exceeding the statement budget and consumes nothing", async () => {
    const host = await newPerson("Slow Trigger Host");
    const booker = await newPerson("Slow Trigger Booker");
    const activityId = await publishActivity(host.id, 2);
    // Migration-role injection: the booking insert itself exceeds the
    // statement budget, forcing a real statement cancellation (57014).
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_slow_insert() RETURNS trigger AS $$
        BEGIN PERFORM pg_sleep(1); RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE TRIGGER probe_slow_insert_t BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION probe_slow_insert()",
      );
    });
    const outcome = await bookActivity(deps, booker, activityId, {
      ip: "127.0.0.1",
      operationId: randomUUID(),
      statementTimeoutMs: 200,
    }).then(
      () => "unexpected-success",
      (err) => (err instanceof BookingFailedError ? "failed" : `other:${err.name}:${err.message}`),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_slow_insert_t ON bookings"));
    expect(outcome).toBe("failed");

    const state = await counts(activityId);
    expect(state).toMatchObject({ booked_count: 0, booking_rows: 0, attributions: 0, confirmed_events: 0 });
    await withClient(migrationUrl, async (client) => {
      const rows = await client
        .query(
          "SELECT details ->> 'outcome' AS outcome FROM events WHERE event_name = 'booking_attempted' AND user_id = $1",
          [booker.id],
        )
        .then((r) => r.rows);
      expect(rows.map((row) => row.outcome)).toEqual(["failed"]);
    });
  });
});
