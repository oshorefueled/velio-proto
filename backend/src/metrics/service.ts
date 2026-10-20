import type { Pool } from "pg";
import type { PublicationStats } from "../live/publication.js";
import { ValidationError } from "../identity/domain.js";
import { ActivityNotFoundError } from "../activities/domain.js";
import { AckRejectedError, type ParsedAvailabilityAck } from "./domain.js";

/**
 * Applied-availability measurement collector and technical aggregation
 * (PLANS.md 4.2/4.3, issue #11).
 *
 * Closing: the first qualifying arrival wins. One acknowledgement for
 * (connection, activity, appliedVersion) closes every still-open measurement
 * of that viewer (the connection and any earlier connection it reconnected
 * from, migration 0014) and activity whose captured version is <= the applied
 * version — a newer snapshot legitimately closes updates whose Pub/Sub
 * delivery was missed — and no later, older or duplicate ack can rewrite a
 * closed row (the UPDATE targets acked_at IS NULL; a database trigger makes
 * the once-only rule hold for every role). acked_at is the database clock at
 * arrival, the same clock that stamped measured_at just before COMMIT, so
 * the interval is one consistent upper bound on commit-to-display.
 *
 * Validation: the connection must exist (server-issued capability), the
 * activity must be (or have been) registered for that connection, and the
 * applied version may never exceed the authoritative committed availability
 * version. A websocket-sourced appliedEventId must be a committed
 * booking_confirmed event of the same activity carrying exactly that
 * version, so a fabricated future state is refused before anything closes.
 */

export interface MetricsDeps {
  pool: Pool;
}

export interface RecordedAck {
  connectionId: string;
  activityId: string;
  appliedVersion: string;
  /** Captured versions closed by this arrival, oldest first. */
  closed: Array<{ version: string; waitedMs: number }>;
}

export async function recordAvailabilityAck(
  deps: MetricsDeps,
  ack: ParsedAvailabilityAck,
  input: { ip: string },
): Promise<RecordedAck> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    const connection = await client.query(
      "SELECT 1 FROM live_connections WHERE connection_id = $1",
      [ack.connectionId],
    );
    if (connection.rows.length === 0) {
      throw new AckRejectedError("Unknown measurement connection");
    }
    const presence = await client.query(
      "SELECT 1 FROM live_presence WHERE connection_id = $1 AND activity_id = $2",
      [ack.connectionId, ack.activityId],
    );
    if (presence.rows.length === 0) {
      throw new AckRejectedError("Activity is not registered for this measurement connection");
    }

    // Authoritative committed state bounds what a client can claim to have
    // applied: a fabricated future version is refused here, before closing.
    const current = await client.query<{ availability_version: string }>(
      "SELECT availability_version::text AS availability_version FROM activities WHERE id = $1",
      [ack.activityId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) {
      throw new ActivityNotFoundError();
    }
    const applied = await client.query<{ too_new: boolean }>(
      "SELECT $1::numeric > $2::numeric AS too_new",
      [ack.appliedVersion, currentRow.availability_version],
    );
    if (applied.rows[0]?.too_new) {
      throw new AckRejectedError("Applied version is newer than any committed state");
    }
    if (ack.appliedEventId !== undefined) {
      const event = await client.query<{ version: string | null }>(
        `SELECT details->>'availabilityVersion' AS version
         FROM events
         WHERE event_id = $1 AND activity_id = $2 AND event_name = 'booking_confirmed'`,
        [ack.appliedEventId, ack.activityId],
      );
      const eventRow = event.rows[0];
      if (!eventRow) {
        throw new AckRejectedError("Applied event is not a committed confirmation of this activity");
      }
      if (eventRow.version !== ack.appliedVersion) {
        throw new AckRejectedError("Applied event does not carry the acknowledged version");
      }
    }

    // First qualifying arrival closes each pending measurement once; rows
    // already closed are invisible to this UPDATE and stay untouched. One
    // clock stamp serves both columns: acked_at IS closed_at by construction.
    const closed = await client.query<{ version: string; waited_ms: number }>(
      `WITH stamp AS (SELECT clock_timestamp() AS ts)
       UPDATE availability_measurements m
       SET acked_at = stamp.ts,
           ack_source = $3,
           ack_reason = $4,
           ack_applied_version = $5,
           closed_at = stamp.ts
       FROM stamp
       WHERE m.connection_id IN (
               SELECT lineage.connection_id FROM live_connections lineage
               WHERE lineage.viewer_id = (SELECT viewer_id FROM live_connections WHERE connection_id = $1))
         AND m.activity_id = $2
         AND m.acked_at IS NULL
         AND m.version::numeric <= $6::numeric
       RETURNING m.version,
                 EXTRACT(EPOCH FROM (m.acked_at - m.measured_at)) * 1000 AS waited_ms`,
      [ack.connectionId, ack.activityId, ack.source, ack.reason, ack.appliedVersion, ack.appliedVersion],
    );

    await client.query("COMMIT");
    return {
      connectionId: ack.connectionId,
      activityId: ack.activityId,
      appliedVersion: ack.appliedVersion,
      closed: closed.rows
        .map((row) => ({ version: row.version, waitedMs: Number(row.waited_ms) }))
        .sort((a, b) => Number(a.version) - Number(b.version)),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be broken; release it below either way.
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface BookingHealthFilters {
  from?: string;
  to?: string;
}

function measuredAtFilter(filters: BookingHealthFilters, params: unknown[], column: string): string {
  let clause = "";
  if (filters.from !== undefined) {
    params.push(filters.from);
    clause += ` AND ${column} >= $${params.length}`;
  }
  if (filters.to !== undefined) {
    params.push(filters.to);
    clause += ` AND ${column} <= $${params.length}`;
  }
  return clause;
}

/** Outcome classes of persisted booking attempts (PLANS.md 4.1/4.2). */
export async function bookingAttemptOutcomeCounts(
  pool: Pool,
  filters: BookingHealthFilters,
): Promise<Record<string, number>> {
  const params: unknown[] = [];
  const counts = await pool.query<{ outcome: string; attempts: string }>(
    `SELECT details->>'outcome' AS outcome, count(*) AS attempts
     FROM events
     WHERE event_name = 'booking_attempted'${measuredAtFilter(filters, params, "occurred_at")}
     GROUP BY 1`,
    params,
  );
  const outcomes: Record<string, number> = {};
  let total = 0;
  for (const row of counts.rows) {
    outcomes[row.outcome] = Number(row.attempts);
    total += Number(row.attempts);
  }
  outcomes.total = total;
  return outcomes;
}

async function logicalOperationCount(pool: Pool, filters: BookingHealthFilters): Promise<number> {
  const params: unknown[] = [];
  const result = await pool.query<{ operations: string }>(
    `SELECT count(DISTINCT details->>'operationId') AS operations
     FROM events
     WHERE event_name = 'booking_attempted'${measuredAtFilter(filters, params, "occurred_at")}`,
    params,
  );
  return Number(result.rows[0]?.operations ?? 0);
}

async function consistencyInspection(pool: Pool): Promise<{ oversellActivities: number; storedCountMismatches: number }> {
  const oversell = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM activities a
     WHERE booked_count > capacity OR (SELECT count(*) FROM bookings b WHERE b.activity_id = a.id) > capacity`,
  );
  const mismatch = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM activities a
     WHERE a.booked_count <> (SELECT count(*) FROM bookings b WHERE b.activity_id = a.id)`,
  );
  return {
    oversellActivities: Number(oversell.rows[0]?.count ?? 0),
    storedCountMismatches: Number(mismatch.rows[0]?.count ?? 0),
  };
}

/**
 * Latency aggregation (PLANS 4.2). Per booking the maximum interval across
 * ALL its expected viewers; p95 (linear interpolation, percentile_cont)
 * across those booking maxima, using elapsed time for unacked viewers as
 * a lower bound rather than excluding them. Viewer states beyond the two-second deadline:
 * closed late stays a permanent breach with its real interval; a viewer still
 * registered and visible with no ack is missing; one that unsubscribed,
 * backgrounded, disconnected or lost its lease before acking is
 * disconnected. Pending counts measurements still inside the deadline. No
 * empty set is ever reported as meeting the target.
 */
export async function availabilityLatencyReport(
  pool: Pool,
  filters: BookingHealthFilters,
): Promise<Record<string, unknown>> {
  const params: unknown[] = [];
  const filter = measuredAtFilter(filters, params, "m.measured_at");
  const states = await pool.query<{
    total: string;
    on_time: string;
    late: string;
    pending: string;
    missing: string;
    disconnected: string;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE m.acked_at IS NOT NULL AND m.acked_at - m.measured_at <= interval '2 seconds') AS on_time,
            count(*) FILTER (WHERE m.acked_at IS NOT NULL AND m.acked_at - m.measured_at > interval '2 seconds') AS late,
            count(*) FILTER (WHERE m.acked_at IS NULL AND now() - m.measured_at <= interval '2 seconds') AS pending,
            count(*) FILTER (WHERE m.acked_at IS NULL AND now() - m.measured_at > interval '2 seconds'
                             AND p.active AND p.visible AND c.lease_expires_at > now()) AS missing,
            count(*) FILTER (WHERE m.acked_at IS NULL AND now() - m.measured_at > interval '2 seconds'
                             AND NOT (p.active AND p.visible AND c.lease_expires_at > now())) AS disconnected
     FROM availability_measurements m
     JOIN live_presence p ON p.connection_id = m.connection_id AND p.activity_id = m.activity_id
     JOIN live_connections c ON c.connection_id = m.connection_id
     WHERE true${filter}`,
    params,
  );
  const row = states.rows[0];

  const p95 = await pool.query<{ p95_ms: string | null; bookings: string; incomplete: boolean }>(
    `WITH per_booking AS (
       SELECT booking_id, EXTRACT(EPOCH FROM max(COALESCE(acked_at, statement_timestamp()) - measured_at)) * 1000 AS max_ms,
              bool_or(acked_at IS NULL) AS incomplete
       FROM availability_measurements m
       WHERE true${filter}
       GROUP BY booking_id
     )
     SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY max_ms) AS p95_ms,
            count(*) AS bookings, COALESCE(bool_or(incomplete), false) AS incomplete
     FROM per_booking`,
    params,
  );

  const withMissing = await pool.query<{ bookings: string }>(
    `SELECT count(DISTINCT m.booking_id) AS bookings
     FROM availability_measurements m
     JOIN live_presence p ON p.connection_id = m.connection_id AND p.activity_id = m.activity_id
     JOIN live_connections c ON c.connection_id = m.connection_id
     WHERE m.acked_at IS NULL AND now() - m.measured_at > interval '2 seconds'${filter}`,
    params,
  );

  const buckets = await pool.query<{ le100: string; le500: string; le1000: string; le2000: string; above2000: string }>(
    `SELECT count(*) FILTER (WHERE acked_at - measured_at <= interval '100 milliseconds') AS le100,
            count(*) FILTER (WHERE acked_at - measured_at <= interval '500 milliseconds') AS le500,
            count(*) FILTER (WHERE acked_at - measured_at <= interval '1 second') AS le1000,
            count(*) FILTER (WHERE acked_at - measured_at <= interval '2 seconds') AS le2000,
            count(*) FILTER (WHERE acked_at - measured_at > interval '2 seconds') AS above2000
     FROM availability_measurements m WHERE acked_at IS NOT NULL${filter}`, params,
  );
  const coverageParams: unknown[] = [];
  const coverage = await pool.query<{ total: string; unrecorded: string; failed: string; empty: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE c.booking_id IS NULL) AS unrecorded,
            count(*) FILTER (WHERE NOT c.capture_succeeded) AS failed,
            count(*) FILTER (WHERE c.capture_succeeded AND c.expected_viewers = 0) AS empty
     FROM bookings b LEFT JOIN availability_captures c ON c.booking_id = b.id
     WHERE true${measuredAtFilter(filters, coverageParams, "COALESCE(c.measured_at, b.created_at)")}`,
    coverageParams,
  );
  const breakdown = await pool.query<{ source: string; reason: string; count: string; within_deadline: string; late: string }>(
    `SELECT ack_source AS source, ack_reason AS reason, count(*) AS count,
            count(*) FILTER (WHERE acked_at - measured_at <= interval '2 seconds') AS within_deadline,
            count(*) FILTER (WHERE acked_at - measured_at > interval '2 seconds') AS late
     FROM availability_measurements m WHERE acked_at IS NOT NULL${filter}
     GROUP BY ack_source, ack_reason ORDER BY ack_source, ack_reason`, params,
  );

  return {
    coverage: {
      committedBookings: Number(coverage.rows[0]?.total ?? 0),
      unrecordedBookings: Number(coverage.rows[0]?.unrecorded ?? 0),
      captureFailures: Number(coverage.rows[0]?.failed ?? 0),
      bookingsWithoutViewers: Number(coverage.rows[0]?.empty ?? 0),
    },
    closedLatencyBuckets: Object.fromEntries(Object.entries(buckets.rows[0] ?? {}).map(([key, count]) => [key, Number(count)])),
    appliedBySourceAndReason: breakdown.rows.map((entry) => ({
      source: entry.source, reason: entry.reason, count: Number(entry.count),
      withinDeadline: Number(entry.within_deadline), late: Number(entry.late),
    })),
    measurements: {
      total: Number(row?.total ?? 0),
      closedWithinDeadline: Number(row?.on_time ?? 0),
      late: Number(row?.late ?? 0),
      pendingUnderDeadline: Number(row?.pending ?? 0),
      missing: Number(row?.missing ?? 0),
      disconnected: Number(row?.disconnected ?? 0),
    },
    bookingsMeasured: Number(p95.rows[0]?.bookings ?? 0),
    bookingsWithMissingViewer: Number(withMissing.rows[0]?.bookings ?? 0),
    p95IntervalMs: p95.rows[0]?.p95_ms === null || p95.rows[0]?.p95_ms === undefined ? null : Math.round(Number(p95.rows[0].p95_ms)),
    p95IsLowerBound: p95.rows[0]?.incomplete ?? false,
    percentileConvention: "p95 = percentile_cont(0.95, linear interpolation) over per-booking maxima across ALL captured viewers; unacked viewers use elapsed time at query and make the result a lower bound",
    deadlineMs: 2000,
  };
}

/** Aggregate technical health; every field is a count or duration, never a person. */
export async function buildBookingHealth(
  pool: Pool,
  publication: PublicationStats | undefined,
  filters: BookingHealthFilters,
): Promise<Record<string, unknown>> {
  const [outcomes, logicalOperations, consistency, latency] = await Promise.all([
    bookingAttemptOutcomeCounts(pool, filters),
    logicalOperationCount(pool, filters),
    consistencyInspection(pool),
    availabilityLatencyReport(pool, filters),
  ]);

  const created = outcomes.created ?? 0;
  // Eligible = a valid request that reached the capacity decision: success,
  // lock timeout, classified failure and unknown-availability failure.
  // Replays, sell-outs and invalid/unauthorized input are
  // excluded and shown separately (PLANS.md 4.2). Unknown-availability
  // server errors stay in the denominator as failures until classified.
  const eligible = created + (outcomes.lock_timeout ?? 0) + (outcomes.failed ?? 0) + (outcomes.commit_unknown ?? 0);
  const publications = {
    // Process-local counters: they describe this instance since boot and are
    // labeled as such; durable publication evidence lives in the measurement
    // rows and saved committed versions, not in these counters.
    scope: "process-local since instance start",
    attempts: publication?.attempts ?? 0,
    published: publication?.published ?? 0,
    failures: publication?.failures ?? 0,
  };

  return {
    bookings: {
      rawAttempts: outcomes.total ?? 0,
      logicalOperations,
      outcomes,
      reliability: {
        target: 0.995,
        eligibleAttempts: eligible,
        successfulNewSpotAttempts: created,
        ratio: eligible === 0 ? null : created / eligible,
        emptySample: eligible === 0,
        excludedSeparately: {
          confirmedResultReplays: outcomes.existing ?? 0,
          expectedSellOuts: outcomes.sold_out ?? 0,
          invalidOrUnauthorized:
            (outcomes.invalid ?? 0) + (outcomes.unauthorized ?? 0) +
            (outcomes.not_found ?? 0) +
            (outcomes.started ?? 0) +
            (outcomes.invite_not_found ?? 0) +
            (outcomes.invite_expired ?? 0) +
            (outcomes.invite_recipient_mismatch ?? 0) + (outcomes.invite_used ?? 0),
        },
      },
      oversellActivities: consistency.oversellActivities,
      storedCountMismatches: consistency.storedCountMismatches,
    },
    publication: publications,
    availability: latency,
  };
}

/** Validate optional interval filters on the metrics query string. */
export function parseBookingHealthFilters(query: Record<string, unknown>): BookingHealthFilters {
  const filters: BookingHealthFilters = {};
  for (const key of ["from", "to"] as const) {
    const raw = query[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || Number.isNaN(Date.parse(raw))) {
      throw new ValidationError(`${key} must be an ISO-8601 timestamp`);
    }
    filters[key] = raw;
  }
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
    throw new ValidationError("from must not be later than to");
  }
  return filters;
}
