import type { Pool, PoolClient } from "pg";

/**
 * Server-owned presence for measurement-registered live connections
 * (PLANS.md 4.2). Rows live in PostgreSQL, not in one process's socket set,
 * so capturing the expected viewers of a booking works across API instances
 * and survives restarts. A finite liveness lease replaces the socket's close
 * event when an instance dies: expired leases stop counting as present, and
 * the rows stay for inspection (disclosed limit: the last lease interval of
 * a crashed instance's viewers may over- or under-count presence).
 *
 * Presence is lifecycle state, not trust history: visibility is the client's
 * report (never proof of human attention), while ownership of the connection
 * identifier is server-established. Nothing is ever deleted — unsubscribe and
 * disconnect flip `active` and the captured history keeps its context.
 */

export interface PresenceDeps {
  pool: Pool;
  instanceId: string;
  leaseSeconds: number;
}

/** Register one measurement connection and its current activity presence. */
export async function registerMeasurementConnection(
  executor: Pick<PoolClient, "query">,
  input: { instanceId: string; leaseSeconds: number; activities: string[]; visible: boolean },
): Promise<string> {
  const inserted = await executor.query<{ connection_id: string }>(
    `WITH connection AS (
       INSERT INTO live_connections (instance_id, lease_expires_at)
       VALUES ($1, now() + make_interval(secs => $2)) RETURNING connection_id
     ), presence AS (
       INSERT INTO live_presence (connection_id, activity_id, visible, active)
       SELECT connection_id, activity_id, $4, true
       FROM connection CROSS JOIN unnest($3::uuid[]) AS activity_id
     ) SELECT connection_id FROM connection`,
    [input.instanceId, input.leaseSeconds, input.activities, input.visible],
  );
  return inserted.rows[0]!.connection_id;
}

/** A subscription on a measurement connection counts as present for its activity. */
export async function upsertPresence(
  pool: Pool,
  connectionId: string,
  activityId: string,
  visible: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO live_presence (connection_id, activity_id, visible, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (connection_id, activity_id)
     DO UPDATE SET visible = EXCLUDED.visible, active = true, updated_at = now()`,
    [connectionId, activityId, visible],
  );
}

/** Unsubscribe or disconnect: presence is retained, active flips false. */
export async function markPresenceInactive(
  pool: Pool,
  connectionId: string,
  activityId?: string,
): Promise<void> {
  await pool.query(
    `UPDATE live_presence SET active = false, updated_at = now()
     WHERE connection_id = $1 AND ($2::uuid IS NULL OR activity_id = $2)`,
    [connectionId, activityId ?? null],
  );
}

/** The client's foreground/background report; never proof of attention. */
export async function setPresenceVisibility(
  pool: Pool,
  connectionId: string,
  visible: boolean,
): Promise<void> {
  await pool.query(
    `UPDATE live_presence SET visible = $2, updated_at = now() WHERE connection_id = $1`,
    [connectionId, visible],
  );
}

/** Keep every live measurement connection of this instance leased. */
export async function refreshInstanceLeases(
  pool: Pool,
  instanceId: string,
  leaseSeconds: number,
  connectionIds: string[],
): Promise<void> {
  if (connectionIds.length === 0) {
    return;
  }
  await pool.query(
    `UPDATE live_connections
     SET lease_expires_at = now() + make_interval(secs => $2)
     WHERE instance_id = $1 AND connection_id = ANY($3)`,
    [instanceId, leaseSeconds, connectionIds],
  );
}

/**
 * Capture the expected viewers for an activity at booking start: registered,
 * subscribed, currently reported visible and inside their liveness lease.
 * Viewers arriving after this read cannot inflate the captured set, and a
 * later unsubscribe, background or disconnect cannot remove it.
 */
export async function captureExpectedViewers(pool: Pool, activityId: string): Promise<string[]> {
  const result = await pool.query<{ connection_id: string }>(
    `SELECT p.connection_id
     FROM live_presence p
     JOIN live_connections c ON c.connection_id = p.connection_id
     WHERE p.activity_id = $1 AND p.active AND p.visible AND c.lease_expires_at > now()`,
    [activityId],
  );
  return result.rows.map((row) => row.connection_id);
}
