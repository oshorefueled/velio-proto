import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import { appendEvent } from "../events/append.js";
import { ActivityNotFoundError } from "../activities/domain.js";
import { InviteNotFoundError, normalizeCode } from "../invites/domain.js";
import { consumeFixedWindowQuota, type QuotaLimits } from "../ratelimit.js";
import type { UserSnapshot } from "../identity/domain.js";
import {
  EventConflictError,
  type ClientChannel,
  type ParsedClientEvent,
} from "./domain.js";

/**
 * Client observation events (PLANS.md 4.1, issue #10). One transaction per
 * accepted event: the append-only event row (deduplicated on
 * `client_event:<eventId>`) and the first visitor-to-identity link commit
 * together. Every saved fact about the world — activity, invite, rail,
 * experiment assignment — is derived from authoritative records; the body
 * only contributes the observation itself. A replay is judged by a hash of
 * the accepted content: identical content is an explicit duplicate no-op,
 * different content is a conflict, so a retry can never rewrite an accepted
 * event or attach it to new context.
 */

export interface ClientEventsDeps {
  pool: Pool;
  redis: Redis;
  /** Finite observation quota per IP within the window (PLANS.md 5.2). */
  quota: Pick<QuotaLimits, "perIp" | "windowSeconds">;
}

export interface RecordedClientEvent {
  /** The client-supplied canonical event ID, echoed back. */
  eventId: string;
  type: ParsedClientEvent["type"];
  status: "accepted" | "duplicate";
}

interface InviteFactRow {
  id: string;
  rail: string;
  generation: number;
  activity_id: string;
  plan_id: string;
  arm: string | null;
  experiment_version: string | null;
}

/**
 * Write the one visitor-to-identity link inside the caller's transaction.
 * The visitor's first resolved identity wins: a later session for a
 * different person records its events under that person's user ID but never
 * reassigns the link (PLANS.md 4.1: correlation, not authentication).
 */
export async function linkVisitorIdentity(
  executor: Pick<PoolClient, "query">,
  input: { visitorId: string; userId: string; channel?: ClientChannel },
): Promise<void> {
  await executor.query(
    `INSERT INTO visitor_identities (visitor_id, user_id, channel)
     VALUES ($1, $2, $3)
     ON CONFLICT (visitor_id) DO NOTHING`,
    [input.visitorId, input.userId, input.channel ?? null],
  );
}

/** Hash of the validated submission plus its resolved actor; replay verdicts compare this. */
function payloadHashOf(parsed: ParsedClientEvent, session: UserSnapshot | undefined): string {
  const content: Record<string, unknown> = {
    type: parsed.type,
    visitId: parsed.visitId,
    eventId: parsed.eventId,
    visitorId: parsed.visitorId,
    channel: parsed.channel,
  };
  if (parsed.type === "activity_viewed") {
    content.activityId = parsed.activityId;
  } else {
    content.inviteCode = parsed.inviteCode;
    if (parsed.type === "invite_share_action") content.shareMethod = parsed.shareMethod;
    if (parsed.type === "invite_opened") content.outcome = parsed.outcome;
  }
  content.userId = session?.id ?? null;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Record one client observation. An optional resolved session (transport
 *-resolved from the bearer token, never from the body) anchors the event to
 * an identity and links the visitor; anonymous observations carry no user.
 * claim_started can precede identity selection and is correlated by visitor ID.
 * Displayed landing outcomes are stored as reported — an
 * invite can change state between display and submission without the stored
 * observation becoming wrong.
 */
export async function recordClientEvent(
  deps: ClientEventsDeps,
  parsed: ParsedClientEvent,
  input: { ip: string; session?: UserSnapshot },
): Promise<RecordedClientEvent> {
  const session = input.session;
  await consumeFixedWindowQuota(deps.redis, {
    scope: "client-event",
    ip: input.ip,
    userId: session?.id,
    limits: { perIdentity: deps.quota.perIp, perIp: deps.quota.perIp, windowSeconds: deps.quota.windowSeconds },
  });

  const payloadHash = payloadHashOf(parsed, session);
  const dedupKey = `client_event:${parsed.eventId}`;

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    let activityId: string | null = null;
    let inviteId: string | null = null;
    let planId: string | null = null;
    let experimentArm: string | null = null;
    let experimentVersion: string | null = null;
    const details: Record<string, unknown> = { payloadHash, visitId: parsed.visitId };

    if (parsed.type === "activity_viewed") {
      const row = await client.query<{ id: string; arm: string | null; experiment_version: string | null }>(
        `SELECT a.id, e.arm, e.experiment_version
         FROM activities a
         LEFT JOIN activity_experiments e ON e.activity_id = a.id
         WHERE a.id = $1`,
        [parsed.activityId],
      );
      if (!row.rows[0]) {
        throw new ActivityNotFoundError();
      }
      activityId = row.rows[0].id;
      experimentArm = row.rows[0].arm;
      experimentVersion = row.rows[0].experiment_version;
    } else {
      const normalized = normalizeCode(parsed.inviteCode);
      if (normalized === null) {
        throw new InviteNotFoundError();
      }
      const row = await client.query<InviteFactRow>(
        `SELECT i.id, i.rail, i.generation, i.activity_id, i.plan_id,
                e.arm, e.experiment_version
         FROM invites i
         LEFT JOIN activity_experiments e ON e.activity_id = i.activity_id
         WHERE i.code = $1`,
        [normalized],
      );
      if (!row.rows[0]) {
        throw new InviteNotFoundError();
      }
      const invite = row.rows[0];
      inviteId = invite.id;
      activityId = invite.activity_id;
      planId = invite.plan_id;
      experimentArm = invite.arm;
      experimentVersion = invite.experiment_version;
      details.rail = invite.rail;
      details.generation = invite.generation;
      if (parsed.type === "invite_share_action") {
        details.shareMethod = parsed.shareMethod;
      }
    }

    const inserted = await appendEvent(client, {
      eventName: parsed.type,
      dedupKey,
      userId: session?.id,
      visitorId: parsed.visitorId,
      activityId: activityId ?? undefined,
      planId: planId ?? undefined,
      inviteId: inviteId ?? undefined,
      channel: parsed.channel,
      outcome: parsed.type === "invite_opened" ? parsed.outcome : undefined,
      experimentVersion: experimentVersion ?? undefined,
      experimentArm: experimentArm ?? undefined,
      details,
    });

    if (inserted === null) {
      // A known event ID: identical content stays an accepted no-op, any
      // difference (context, channel, outcome, actor) is a conflict. Either
      // way the stored row and any visitor link are left untouched.
      const existing = await client.query<{ hash: string | null }>(
        `SELECT details->>'payloadHash' AS hash FROM events WHERE dedup_key = $1`,
        [dedupKey],
      );
      await client.query("ROLLBACK");
      if (existing.rows[0]?.hash !== payloadHash) {
        throw new EventConflictError();
      }
      return { eventId: parsed.eventId, type: parsed.type, status: "duplicate" };
    }

    if (session) {
      await linkVisitorIdentity(client, {
        visitorId: parsed.visitorId,
        userId: session.id,
        channel: parsed.channel,
      });
    }

    await client.query("COMMIT");
    return { eventId: parsed.eventId, type: parsed.type, status: "accepted" };
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
