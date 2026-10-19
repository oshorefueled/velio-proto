import type { PoolClient } from "pg";

export interface DomainEvent {
  eventName: string;
  /** Stable deduplication identifier; omit for events that are not replayed. */
  dedupKey?: string;
  userId?: string;
  visitorId?: string;
  activityId?: string;
  planId?: string;
  bookingId?: string;
  inviteId?: string;
  channel?: string;
  outcome?: string;
  experimentVersion?: string;
  experimentArm?: string;
  details?: object;
}

/**
 * Append one event inside the caller's transaction. The timestamp is the
 * database clock. A repeated dedup key is a no-op, so replaying a committed
 * outcome can never write a second row; distinct or absent keys never conflict.
 */
export async function appendEvent(
  client: Pick<PoolClient, "query">,
  event: DomainEvent,
): Promise<string | null> {
  const result = await client.query<{ event_id: string }>(
    `INSERT INTO events
       (event_name, dedup_key, user_id, visitor_id, activity_id, plan_id,
        booking_id, invite_id, channel, outcome, experiment_version, experiment_arm, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING event_id`,
    [
      event.eventName,
      event.dedupKey ?? null,
      event.userId ?? null,
      event.visitorId ?? null,
      event.activityId ?? null,
      event.planId ?? null,
      event.bookingId ?? null,
      event.inviteId ?? null,
      event.channel ?? null,
      event.outcome ?? null,
      event.experimentVersion ?? null,
      event.experimentArm ?? null,
      JSON.stringify(event.details ?? {}),
    ],
  );
  return result.rows[0]?.event_id ?? null;
}
