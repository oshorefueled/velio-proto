import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import { appendEvent } from "../events/append.js";
import { consumeBookingQuota, RateLimitError, type QuotaLimits } from "../ratelimit.js";
import { isActivityId } from "../activities/service.js";
import { findInviteForClaim } from "../invites/service.js";
import type { AvailabilityUpdate } from "../live/publication.js";
import { captureExpectedViewers } from "../live/presence.js";
import {
  InviteExpiredError,
  InviteNotFoundError,
  InviteRecipientMismatchError,
  type InviteSnapshot,
} from "../invites/domain.js";
import {
  ActivityNotFoundError,
  ActivitySoldOutError,
  ActivityStartedError,
  BookingFailedError,
  BookingNotFoundError,
  BookingOutcomeUnknownError,
  InvalidOperationError,
  LockTimeoutError,
  validateOperationId,
  type BookingView,
} from "./domain.js";

/**
 * Application service for booking (PLANS.md 3.3). bookActivity owns the one
 * READ COMMITTED transaction: lock the activity row, decide on the database
 * wall clock (clock_timestamp, so a lock wait that crosses the start time
 * cannot book), return any committed booking before lifecycle and capacity
 * gates, then update count+version, insert the booking with its composite
 * activity/plan reference, write the explicit direct attribution and the
 * deduplicated confirmed event — commit or roll back together.
 *
 * Every request gets its own attempt id; the client's operation id stays
 * stable across retries. Attempt outcomes are recorded for every request,
 * including failures after rollback.
 */

export interface BookingDeps {
  pool: Pool;
  redis: Redis;
  quota: QuotaLimits;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /**
   * Live availability publication (PLANS 3.4), invoked strictly after COMMIT
   * with a finite internal budget. Absent (tests) means no publication.
   * A failure is swallowed inside the implementation and can never change
   * the committed booking's outcome.
   */
  live?: { publishAvailability(update: AvailabilityUpdate): Promise<void> };
}

export interface BookInput {
  ip: string;
  operationId: unknown;
  /** Public-share (ticket #7: vouch) invite code presented with this claim. */
  inviteCode?: unknown;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface BookingResult {
  booking: BookingView;
  created: boolean;
  attemptId: string;
  /** Activity version resulting from this operation (PLANS 3.3 step 7). */
  availabilityVersion: string;
}

interface BookingRow {
  id: string;
  activity_id: string;
  plan_id: string;
  user_id: string;
  created_at: Date;
  rail: string | null;
  generation: number | null;
}

function toView(row: BookingRow): BookingView {
  return {
    id: row.id,
    activityId: row.activity_id,
    planId: row.plan_id,
    userId: row.user_id,
    createdAt: row.created_at.toISOString(),
    attribution: { rail: row.rail ?? "direct", generation: row.generation ?? 0 },
  };
}

type AttemptOutcome =
  | "created"
  | "existing"
  | "sold_out"
  | "started"
  | "not_found"
  | "invite_not_found"
  | "invite_expired"
  | "invite_recipient_mismatch"
  | "lock_timeout"
  | "failed"
  | "commit_unknown"
  | "rate_limited";

async function recordAttempt(
  executor: Pick<PoolClient, "query">,
  attempt: {
    attemptId: string;
    operationId: string;
    outcome: AttemptOutcome;
    userId?: string;
    activityId?: string;
    decisionAt?: string;
    /** Server-derived booking source for this attempt (PLANS.md 4.1). */
    source?: string;
  },
): Promise<void> {
  // Errors propagate: inside the booking transaction this record is a
  // required transactional write, and swallowing its failure would let a
  // rolled-back transaction be reported as a confirmation (acceptance R1).
  // Execution-span evidence (PLANS 5.2): occurred_at is the transaction
  // start clock (now() = transaction_timestamp); recordedAt is read with
  // clock_timestamp() at attempt-record time. The pair bounds this
  // attempt's transaction lifetime, so concurrent booking transactions are
  // visible as overlapping spans — a serial mock cannot produce overlap.
  const recorded = await executor.query<{ recorded_at: Date }>(
    "SELECT clock_timestamp() AS recorded_at",
  );
  await appendEvent(executor, {
    eventName: "booking_attempted",
    dedupKey: `booking_attempted:${attempt.attemptId}`,
    userId: attempt.userId,
    activityId: attempt.activityId,
    details: {
      operationId: attempt.operationId,
      outcome: attempt.outcome,
      decisionAt: attempt.decisionAt,
      recordedAt: recorded.rows[0]?.recorded_at.toISOString(),
      source: attempt.source,
    },
  });
}

/** Post-rollback evidence: best-effort, never masks the primary outcome. */
async function recordAttemptBestEffort(
  pool: Pool,
  attempt: Parameters<typeof recordAttempt>[1],
): Promise<void> {
  try {
    await recordAttempt(pool, attempt);
  } catch {
    // Evidence loss is accepted here by design; the primary outcome stands.
  }
}

/**
 * Classify a booking failure for attempt evidence and HTTP semantics.
 * A reported COMMIT error carries a 5-character SQLSTATE: PostgreSQL has
 * spoken, the transaction definitively rolled back. A connection-level
 * failure (system codes like ECONNRESET, or no code at all) after COMMIT
 * was attempted leaves the outcome unknowable — recovery is the lookup and
 * operation-replay paths, never a "nothing was consumed" claim.
 */
export function classifyBookingFailure(
  err: unknown,
  commitAttempted: boolean,
): "failed" | "lock_timeout" | "commit_unknown" {
  if (isPostgresError(err, "55P03")) {
    return "lock_timeout";
  }
  if (!commitAttempted) {
    return "failed";
  }
  if (isPostgresError(err, "57014") || isPostgresError(err, "40001")) {
    return "failed";
  }
  const code = (err as { code?: unknown }).code;
  const isSqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  return isSqlState ? "failed" : "commit_unknown";
}

function isPostgresError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

export async function bookActivity(
  deps: BookingDeps,
  person: { id: string; contactKey?: string },
  activityId: unknown,
  input: BookInput,
): Promise<BookingResult> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  const operationId = validateOperationId(input.operationId);
  const attemptId = randomUUID();
  let source = input.inviteCode === undefined ? "direct" : "invited";
  const lockTimeoutMs = input.lockTimeoutMs ?? deps.lockTimeoutMs;
  const statementTimeoutMs = input.statementTimeoutMs ?? deps.statementTimeoutMs;

  try {
    await consumeBookingQuota(deps.redis, {
      userId: person.id,
      ip: input.ip,
      limits: { perIdentity: deps.quota.perIdentity, perIp: deps.quota.perIp, windowSeconds: deps.quota.windowSeconds },
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      await recordAttemptBestEffort(deps.pool, {
        attemptId,
        source,
        operationId,
        outcome: "rate_limited",
        userId: person.id,
        activityId,
      });
    }
    throw err;
  }

  // Expected viewers are captured at booking start — before waiting on locks
  // or committing — from server-owned PostgreSQL presence, so viewers on any
  // API instance count and later subscribers cannot inflate the set. A
  // capture read that cannot run is a measurement gap, never a booking
  // failure: the booking proceeds with an empty captured set (documented
  // evidence limit), because technical measurement may not disturb booking.
  let expectedViewers: string[] = [];
  let captureSucceeded = true;
  try {
    expectedViewers = await captureExpectedViewers(deps.pool, activityId);
  } catch (err) {
    captureSucceeded = false;
    console.warn(
      `metrics: expected-viewer capture failed for ${activityId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const client = await deps.pool.connect();
  // A domain decision (not found / existing / started / sold out) is read
  // from the locked activity row, so no COMMIT outcome can change it — the
  // transaction only carries its evidence. Tracking the decision here, not
  // reconstructing it from the caught error, keeps the catch honest when the
  // decision path's own COMMIT fails (the domain error is thrown after
  // COMMIT and would never be seen). Invite rejections are decided against
  // the immutable invite row and the database clock the same way.
  let decidedOutcome:
    | "existing"
    | "sold_out"
    | "started"
    | "not_found"
    | "invite_not_found"
    | "invite_expired"
    | "invite_recipient_mismatch"
    | undefined;
  let pendingResult: BookingResult | undefined;
  let commitAttempted = false;
  let decisionAt: string | undefined;
  try {
    await client.query("BEGIN");
    // set_config(local=true) is the parameterized form of SET LOCAL (utility
    // SET cannot bind); both values are validated nonnegative integers.
    await client.query("SELECT set_config('lock_timeout', $1, true)", [String(lockTimeoutMs)]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);

    const activity = await client.query<{
      id: string;
      starts_at: Date;
      capacity: number;
      booked_count: number;
      availability_version: string;
    }>("SELECT id, starts_at, capacity, booked_count, availability_version FROM activities WHERE id = $1 FOR UPDATE", [activityId]);
    const activityRow = activity.rows[0];
    if (!activityRow) {
      await recordAttempt(client, {
        attemptId,
        source,
        operationId,
        outcome: "not_found",
        userId: person.id,
      });
      decidedOutcome = "not_found";
      await client.query("COMMIT");
      throw new ActivityNotFoundError();
    }

    // Replays precede every lifecycle and capacity gate: a committed booking
    // is returned even after the activity starts or fills.
    const existing = await client.query<BookingRow>(
      `SELECT b.id, b.activity_id, b.plan_id, b.user_id, b.created_at,
              ba.rail, ba.generation
       FROM bookings b
       JOIN booking_attributions ba ON ba.booking_id = b.id
       WHERE b.activity_id = $1 AND b.user_id = $2`,
      [activityId, person.id],
    );
    if (existing.rows[0]) {
      source = existing.rows[0].rail ?? "direct";
      await recordAttempt(client, {
        attemptId,
        source,
        operationId,
        outcome: "existing",
        userId: person.id,
        activityId,
      });
      // The booking predates this transaction, so the replay result stays
      // truthful even if the evidence COMMIT fails; the catch returns it.
      const result: BookingResult = {
        booking: toView(existing.rows[0]),
        created: false,
        attemptId,
        availabilityVersion: activityRow.availability_version,
      };
      decidedOutcome = "existing";
      pendingResult = result;
      await client.query("COMMIT");
      return result;
    }

    // Invited claim (PLANS 3.3 step 4): the replay above has already
    // returned any committed booking with its original source, so an
    // expired or unknown code can never rewrite history. A valid invite is
    // an immutable snapshot; expiry is judged on the database clock inside
    // this transaction.
    let invite: InviteSnapshot | undefined;
    if (input.inviteCode !== undefined) {
      const lookup = await findInviteForClaim(client, input.inviteCode, activityId, {
        contactKey: person.contactKey,
      });
      if (!lookup.ok) {
        const outcome: AttemptOutcome =
          lookup.reason === "expired"
            ? "invite_expired"
            : lookup.reason === "recipient_mismatch"
              ? "invite_recipient_mismatch"
              : "invite_not_found";
        await recordAttempt(client, {
          attemptId,
          source,
          operationId,
          outcome,
          userId: person.id,
          activityId,
        });
        decidedOutcome = outcome;
        await client.query("COMMIT");
        throw lookup.reason === "expired"
          ? new InviteExpiredError()
          : lookup.reason === "recipient_mismatch"
            ? new InviteRecipientMismatchError()
            : new InviteNotFoundError();
      }
      invite = lookup.invite;
    }
    source = invite?.rail ?? "direct";

    // Wall clock, read after the lock: a lock wait that crosses the start
    // time must refuse, never book (PLANS 3.3 step 4).
    const decision = await client.query<{ decision: Date }>("SELECT clock_timestamp() AS decision");
    const decisionRow = decision.rows[0];
    if (!decisionRow) {
      // Unreachable: SELECT without FROM always yields one row.
      throw new Error("Database clock unreadable");
    }
    if (activityRow.starts_at.getTime() <= decisionRow.decision.getTime()) {
      decisionAt = decisionRow.decision.toISOString();
      await recordAttempt(client, {
        attemptId,
        source,
        operationId,
        outcome: "started",
        userId: person.id,
        activityId,
        decisionAt,
      });
      decidedOutcome = "started";
      await client.query("COMMIT");
      throw new ActivityStartedError();
    }

    if (activityRow.booked_count >= activityRow.capacity) {
      decisionAt = decisionRow.decision.toISOString();
      await recordAttempt(client, {
        attemptId,
        source,
        operationId,
        outcome: "sold_out",
        decisionAt,
        userId: person.id,
        activityId,
      });
      decidedOutcome = "sold_out";
      await client.query("COMMIT");
      throw new ActivitySoldOutError();
    }

    // Conditional update: zero rows means another transaction won the seat
    // between the check and the update.
    const updated = await client.query<{ booked_count: number; availability_version: string }>(
      `UPDATE activities
       SET booked_count = booked_count + 1, availability_version = availability_version + 1
       WHERE id = $1 AND booked_count < capacity
       RETURNING booked_count, availability_version`,
      [activityId],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      decisionAt = decisionRow.decision.toISOString();
      await recordAttempt(client, {
        attemptId,
        source,
        operationId,
        outcome: "sold_out",
        decisionAt,
        userId: person.id,
        activityId,
      });
      decidedOutcome = "sold_out";
      await client.query("COMMIT");
      throw new ActivitySoldOutError();
    }

    const plan = await client.query<{ id: string }>(
      "SELECT id FROM plans WHERE activity_id = $1",
      [activityId],
    );
    const planRow = plan.rows[0];
    if (!planRow) {
      // Unreachable: every activity gets its plan atomically at publication.
      throw new Error(`Plan missing for activity ${activityId}`);
    }

    const booking = await client.query<BookingRow>(
      `INSERT INTO bookings (activity_id, plan_id, user_id)
       VALUES ($1, $2, $3)
       RETURNING id, activity_id, plan_id, user_id, created_at`,
      [activityId, planRow.id, person.id],
    );
    const bookingRow = booking.rows[0];
    if (!bookingRow) {
      throw new Error("Booking row missing after insert");
    }

    // Server-derived origin: the client never supplies rail, inviter or
    // generation; every invited field is a snapshot of the saved invite
    // (PLANS.md 3.1/3.2).
    if (invite) {
      await client.query(
        `INSERT INTO booking_attributions (booking_id, rail, generation, inviter_id, invite_id, code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bookingRow.id, invite.rail, invite.generation, invite.creatorId, invite.id, invite.code],
      );
    } else {
      await client.query(
        "INSERT INTO booking_attributions (booking_id, rail, generation) VALUES ($1, 'direct', 0)",
        [bookingRow.id],
      );
    }
    const remaining = activityRow.capacity - updatedRow.booked_count;
    const confirmedEventId = await appendEvent(client, {
      eventName: "booking_confirmed",
      dedupKey: `booking_confirmed:${bookingRow.id}`,
      userId: person.id,
      activityId,
      bookingId: bookingRow.id,
      planId: planRow.id,
      details: { remainingSpots: remaining, availabilityVersion: updatedRow.availability_version },
    });
    if (invite) {
      // Exactly one claim event per committed invited booking: the booking
      // id is the deduplication key (PLANS.md 4.1).
      await appendEvent(client, {
        eventName: "spot_claimed",
        dedupKey: `spot_claimed:${bookingRow.id}`,
        userId: person.id,
        activityId,
        planId: planRow.id,
        bookingId: bookingRow.id,
        inviteId: invite.id,
        details: { rail: invite.rail, generation: invite.generation },
      });
    }
    decisionAt = decisionRow.decision.toISOString();
    await recordAttempt(client, {
      attemptId,
      source,
      operationId,
      outcome: "created",
      userId: person.id,
      activityId,
      decisionAt,
    });
    // Technical measurement must not veto a valid booking. A savepoint
    // isolates a rejected measurement write; its missing capture remains
    // inspectable by comparing committed bookings with capture records.
    await client.query("SAVEPOINT availability_measurement");
    try {
      await client.query(
        `WITH stamp AS (SELECT clock_timestamp() AS ts), captured AS (
           INSERT INTO availability_captures (booking_id, measured_at, expected_viewers, capture_succeeded)
           SELECT $1, ts, cardinality($5::uuid[]), $6 FROM stamp
         )
         INSERT INTO availability_measurements
           (booking_id, activity_id, version, event_id, connection_id, measured_at)
         SELECT $1, $2, $3, $4, connection_id, ts
         FROM stamp CROSS JOIN unnest($5::uuid[]) AS connection_id`,
        [bookingRow.id, activityId, String(updatedRow.availability_version), confirmedEventId,
          expectedViewers, captureSucceeded],
      );
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT availability_measurement");
      console.warn("metrics: measurement persistence failed", err instanceof Error ? err.message : "unknown");
    }
    await client.query("RELEASE SAVEPOINT availability_measurement");
    commitAttempted = true;
    await client.query("COMMIT");
    // The transaction and its row locks are fully released above: live
    // publication happens strictly post-commit with a finite internal
    // budget, and a refusal, stall or failure is counted and logged inside
    // the implementation — it can never undo the booking or surface as
    // booking_failed. Replays (created:false) never publish.
    if (deps.live) {
      try {
        await deps.live.publishAvailability({
          activityId,
          version: updatedRow.availability_version,
          remainingSpots: remaining,
          eventId: confirmedEventId,
        });
      } catch {
        // Defense in depth: the implementation already swallows failures;
        // this keeps any injected or future publisher from turning a
        // committed booking into a transport error.
      }
    }
    // The view reports the server-derived origin: a claimed booking shows
    // its invite snapshot, a direct booking the explicit direct source.
    const view = toView(bookingRow);
    return {
      booking: invite
        ? { ...view, attribution: { rail: invite.rail, generation: invite.generation } }
        : view,
      created: true,
      attemptId,
      availabilityVersion: updatedRow.availability_version,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be broken; release it below either way.
    }

    if (decidedOutcome !== undefined) {
      // The decision was read from the locked activity row (or the immutable
      // invite row and the database clock), so the COMMIT outcome
      // (definitive failure or uncertain transport failure) cannot change
      // it; the in-transaction evidence row rolled back, so re-record the
      // decision best-effort and surface the truthful primary outcome.
      await recordAttemptBestEffort(deps.pool, {
        attemptId,
        source,
        operationId,
        outcome: decidedOutcome,
        userId: person.id,
        activityId,
        decisionAt,
      });
      if (pendingResult) {
        return pendingResult;
      }
      if (decidedOutcome === "sold_out") {
        throw new ActivitySoldOutError();
      }
      if (decidedOutcome === "started") {
        throw new ActivityStartedError();
      }
      if (decidedOutcome === "invite_not_found") {
        throw new InviteNotFoundError();
      }
      if (decidedOutcome === "invite_expired") {
        throw new InviteExpiredError();
      }
      if (decidedOutcome === "invite_recipient_mismatch") {
        throw new InviteRecipientMismatchError();
      }
      throw new ActivityNotFoundError();
    }

    // Everything here is a genuine failure: a reported COMMIT error carries
    // a 5-character SQLSTATE (PostgreSQL has spoken — definitive rollback),
    // while a connection-level failure after COMMIT was attempted leaves the
    // outcome unknowable; recovery is the lookup and operation-replay paths.
    const outcome = classifyBookingFailure(err, commitAttempted);
    await recordAttemptBestEffort(deps.pool, {
      attemptId,
      source,
      operationId,
      outcome,
      userId: person.id,
      activityId,
      decisionAt,
    });
    if (outcome === "lock_timeout") {
      throw new LockTimeoutError();
    }
    if (outcome === "commit_unknown") {
      throw new BookingOutcomeUnknownError();
    }
    throw new BookingFailedError(err);
  } finally {
    client.release();
  }
}

/** Lost-response recovery: the session person's committed booking, if any. */
export async function getMyBooking(deps: BookingDeps, person: { id: string }, activityId: unknown): Promise<BookingView> {
  if (!isActivityId(activityId)) {
    throw new BookingNotFoundError();
  }
  const result = await deps.pool.query<BookingRow>(
    `SELECT b.id, b.activity_id, b.plan_id, b.user_id, b.created_at,
            ba.rail, ba.generation
     FROM bookings b
     JOIN booking_attributions ba ON ba.booking_id = b.id
     WHERE b.activity_id = $1 AND b.user_id = $2`,
    [activityId, person.id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new BookingNotFoundError();
  }
  return toView(row);
}
