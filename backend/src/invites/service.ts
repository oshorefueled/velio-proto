import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import { appendEvent } from "../events/append.js";
import { ActivityNotFoundError, ForbiddenError, isActivityId } from "../activities/domain.js";
import { ActivityCompletedError, ActivitySoldOutError, ActivityStartedError } from "../booking/domain.js";
import { ValidationError, validateContactKey } from "../identity/domain.js";
import { consumeFixedWindowQuota, type QuotaLimits } from "../ratelimit.js";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  InviteNotFoundError,
  normalizeCode,
  type InviteRail,
  type InviteSnapshot,
  type InviteState,
} from "./domain.js";

/**
 * Invitation services (PLANS.md 3.3/3.5). createPublicShare owns one
 * transaction and takes the activity row lock in the booking lock order: the
 * saved treatment assignment, the creation switch, the lifecycle gates
 * (future, spots, not completed) and the creator's host-or-booker
 * authorization are all judged against that locked row, then the invite and
 * its invite_created event commit together. An invite reserves no spot —
 * only claiming does, through the locked booking transaction.
 *
 * resolveInvite reads one consistent snapshot for anonymous preview and
 * derives the readable lifecycle state from the database clock and saved
 * availability. It never mutates anything.
 *
 * Claiming and signup acquisition never pass through the public functions:
 * the booking and identity transactions load the invite themselves
 * (findInviteForClaim / findInviteForAcquisition) so origin snapshots and
 * the booking or user row commit atomically.
 */

export interface InvitesDeps {
  pool: Pool;
  redis: Redis;
  /** Creation switch: gates creation only, never issued invites or claims. */
  inviteCreationEnabled: boolean;
  /** Configured invite lifetime in hours, capped by the activity start. */
  expiryHours: number;
  /** Finite creation quotas per identity and per IP (PLANS.md 5.2). */
  creationQuota: QuotaLimits;
  /** Finite resolution quota per IP. */
  resolveQuota: Pick<QuotaLimits, "perIp" | "windowSeconds">;
}

export interface InviteView {
  id: string;
  code: string;
  rail: InviteRail;
  generation: number;
  activityId: string;
  planId: string;
  expiresAt: string;
  createdAt: string;
  /** The vouched contact, echoed to its creator only; never in previews. */
  targetContactKey: string | null;
}

export interface InvitePreview {
  code: string;
  rail: InviteRail;
  generation: number;
  state: InviteState;
  expiresAt: string;
  inviterDisplayName: string;
  activity: {
    id: string;
    title: string;
    startsAt: string;
    timezone: string;
    priceMinorUnits: number;
    currency: string;
    capacity: number;
    bookedCount: number;
    remainingSpots: number;
    availabilityVersion: string;
  };
}

interface CreationRow {
  id: string;
  starts_at: Date;
  capacity: number;
  booked_count: number;
  completed: boolean;
  arm: string | null;
  experiment_version: string;
  affiliated: boolean;
  creator_generation: number;
  creator_contact_key: string;
}

interface PreviewRow {
  id: string;
  code: string;
  rail: InviteRail;
  generation: number;
  expires_at: Date;
  activity_id: string;
  title: string;
  starts_at: Date;
  display_timezone: string;
  price_minor_units: string;
  currency: string;
  capacity: number;
  booked_count: number;
  availability_version: string;
  inviter_display_name: string;
  completed: boolean;
  started: boolean;
  expired: boolean;
}

interface InviteRow {
  id: string;
  code: string;
  rail: InviteRail;
  creator_id: string;
  activity_id: string;
  plan_id: string;
  generation: number;
  expires_at: Date;
  created_at: Date;
  target_contact_key: string | null;
}

/** Cryptographic draw over the typeable alphabet; byte & 31 is bias-free. */
function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte & 31];
  }
  return code;
}

/**
 * Create an invite on either rail for an available future treatment activity.
 * The creator must be the host or hold a confirmed spot; the invite reserves
 * nothing and expires no later than the activity start. The switch gates only
 * creation: issued invites stay claimable (ticket #6 AC5). A vouch names one
 * other stable demo contact — never the creator themself — and the private
 * target is stored only on the invite row (never in events, never in
 * previews). Rail and recipient are immutable once saved.
 */
export async function createInvite(
  deps: InvitesDeps,
  creator: { id: string },
  activityId: unknown,
  input: { ip: string; rail: InviteRail; targetContactKey?: unknown },
): Promise<InviteView> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  let targetContactKey: string | null = null;
  if (input.rail === "vouch") {
    targetContactKey = validateContactKey(input.targetContactKey);
  } else if (input.targetContactKey !== undefined) {
    // A public share names no recipient; a stray field is invalid input.
    throw new ValidationError("public_share invites must not carry a target contact");
  }

  await consumeFixedWindowQuota(deps.redis, {
    scope: "invite-create",
    ip: input.ip,
    userId: creator.id,
    limits: deps.creationQuota,
  });

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    // Lock order per PLANS.md 3.3 step 2: the activity row first, every gate
    // judged against the locked row.
    const locked = await client.query<CreationRow>(
      `SELECT a.id, a.starts_at, a.capacity, a.booked_count,
              p.completed, e.arm, e.experiment_version,
              (a.host_id = $2 OR EXISTS (
                 SELECT 1 FROM bookings b
                 WHERE b.activity_id = a.id AND b.user_id = $2)) AS affiliated,
              cu.signup_generation AS creator_generation,
              cu.contact_key AS creator_contact_key
       FROM activities a
       JOIN plans p ON p.activity_id = a.id
       LEFT JOIN activity_experiments e ON e.activity_id = a.id
       JOIN users cu ON cu.id = $2
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [activityId, creator.id],
    );
    const row = locked.rows[0];
    if (!row) {
      throw new ActivityNotFoundError();
    }
    // Authorization before lifecycle detail: an unrelated person learns
    // nothing about availability from this endpoint.
    if (!row.affiliated) {
      throw new ForbiddenError();
    }
    // A vouch is a personal endorsement: it cannot name its own creator.
    if (targetContactKey !== null && targetContactKey === row.creator_contact_key) {
      throw new ValidationError("A vouch must name a contact other than your own");
    }
    // Control-arm activities and a switched-off creation gate refuse the
    // feature itself; neither state touches already-issued invites.
    if (row.arm !== "treatment" || !deps.inviteCreationEnabled) {
      throw new ForbiddenError();
    }
    const decision = await client.query<{ started: boolean }>(
      "SELECT $1::timestamptz <= clock_timestamp() AS started",
      [row.starts_at],
    );
    if (decision.rows[0]?.started) {
      throw new ActivityStartedError();
    }
    if (row.booked_count >= row.capacity) {
      throw new ActivitySoldOutError();
    }
    if (row.completed) {
      throw new ActivityCompletedError();
    }

    // The generation snapshots the inviter's signup generation plus one and
    // never changes afterwards; expiry never passes the activity start.
    const generation = row.creator_generation + 1;
    let invite: InviteRow | undefined;
    for (let attempt = 0; attempt < 3 && !invite; attempt += 1) {
      const inserted = await client.query<InviteRow>(
        `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at, target_contact_key)
         SELECT $1, $2, $3, a.id, p.id, $4,
                LEAST(now() + make_interval(hours => $5), a.starts_at), $6
         FROM activities a JOIN plans p ON p.activity_id = a.id
         WHERE a.id = $7
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, rail, creator_id, activity_id, plan_id, generation, expires_at, created_at, target_contact_key`,
        [generateCode(), input.rail, creator.id, generation, deps.expiryHours, targetContactKey, activityId],
      );
      invite = inserted.rows[0];
    }
    if (!invite) {
      // Unreachable at 60 bits of entropy; three collisions would mean a
      // broken generator, not a retry story.
      throw new Error("Invite code collision repeated");
    }

    await appendEvent(client, {
      eventName: "invite_created",
      experimentVersion: row.experiment_version,
      experimentArm: row.arm,
      dedupKey: `invite_created:${invite.id}`,
      userId: creator.id,
      activityId: invite.activity_id,
      planId: invite.plan_id,
      inviteId: invite.id,
      details: { rail: invite.rail, generation: invite.generation },
    });

    await client.query("COMMIT");
    return {
      id: invite.id,
      code: invite.code,
      rail: invite.rail,
      generation: invite.generation,
      activityId: invite.activity_id,
      planId: invite.plan_id,
      expiresAt: invite.expires_at.toISOString(),
      createdAt: invite.created_at.toISOString(),
      targetContactKey: invite.target_contact_key,
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

/** Public-share creation: the same transaction without a named recipient. */
export async function createPublicShare(
  deps: InvitesDeps,
  creator: { id: string },
  activityId: unknown,
  input: { ip: string },
): Promise<InviteView> {
  return createInvite(deps, creator, activityId, { ...input, rail: "public_share" });
}

/**
 * Anonymous preview: activity, inviter display name, public rail, expiry and
 * current availability with a readable lifecycle state. Resolving an invite
 * never reveals a vouch target's contact key (ticket #7 owns that rail) and
 * never mutates anything.
 */
export async function resolveInvite(deps: InvitesDeps, code: unknown, input: { ip: string }): Promise<InvitePreview> {
  await consumeFixedWindowQuota(deps.redis, {
    scope: "invite-resolve",
    ip: input.ip,
    limits: { perIdentity: deps.resolveQuota.perIp, perIp: deps.resolveQuota.perIp, windowSeconds: deps.resolveQuota.windowSeconds },
  });
  const normalized = normalizeCode(code);
  if (normalized === null) {
    throw new InviteNotFoundError();
  }
  const result = await deps.pool.query<PreviewRow>(
    `SELECT i.id, i.code, i.rail, i.generation, i.expires_at,
            a.id AS activity_id, a.title, a.starts_at, a.display_timezone,
            a.price_minor_units, a.currency, a.capacity, a.booked_count,
            a.availability_version,
            u.display_name AS inviter_display_name,
            p.completed, a.starts_at <= clock_timestamp() AS started,
            i.expires_at <= clock_timestamp() AS expired
     FROM invites i
     JOIN activities a ON a.id = i.activity_id
     JOIN plans p ON p.activity_id = a.id
     JOIN users u ON u.id = i.creator_id
     WHERE i.code = $1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) {
    throw new InviteNotFoundError();
  }
  const remainingSpots = row.capacity - row.booked_count;
  const state: InviteState = row.started
    ? "started"
    : row.expired
      ? "expired"
      : row.completed
        ? "completed"
        : remainingSpots <= 0
          ? "full"
          : "claimable";
  return {
    code: row.code,
    rail: row.rail,
    generation: row.generation,
    state,
    expiresAt: row.expires_at.toISOString(),
    inviterDisplayName: row.inviter_display_name,
    activity: {
      id: row.activity_id,
      title: row.title,
      startsAt: row.starts_at.toISOString(),
      timezone: row.display_timezone,
      priceMinorUnits: Number(row.price_minor_units),
      currency: row.currency,
      capacity: row.capacity,
      bookedCount: row.booked_count,
      remainingSpots,
      availabilityVersion: row.availability_version,
    },
  };
}

export type InviteClaimLookup =
  | { ok: true; invite: InviteSnapshot }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "recipient_mismatch" };

/**
 * Claim-side lookup for the booking transaction: the invite must exist,
 * belong to the activity being booked and be unexpired by the database
 * clock, and a vouch claims only its named recipient (matched on the stable
 * demo contact key of the claiming session). Rail/recipient immutability
 * makes a plain read sufficient; the expiry comparison runs inside the
 * caller's transaction (PLANS 3.3 step 4).
 */
export async function findInviteForClaim(
  executor: Pick<PoolClient, "query">,
  code: unknown,
  activityId: string,
  claimant: { contactKey?: string },
): Promise<InviteClaimLookup> {
  const normalized = normalizeCode(code);
  if (normalized === null) {
    return { ok: false, reason: "not_found" };
  }
  const result = await executor.query<InviteRow & { expired: boolean; target_contact_key: string | null }>(
    `SELECT id, code, rail, creator_id, activity_id, plan_id, generation,
            expires_at, created_at, target_contact_key,
            expires_at <= clock_timestamp() AS expired
     FROM invites
     WHERE code = $1 AND activity_id = $2`,
    [normalized, activityId],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.expired) {
    return { ok: false, reason: "expired" };
  }
  if (row.rail === "vouch" && row.target_contact_key !== claimant.contactKey) {
    // Refusing a foreign claimant consumes nothing: no seat, no redemption —
    // the vouch stays redeemable by its named contact.
    return { ok: false, reason: "recipient_mismatch" };
  }
  return {
    ok: true,
    invite: {
      id: row.id,
      code: row.code,
      rail: row.rail,
      creatorId: row.creator_id,
      activityId: row.activity_id,
      planId: row.plan_id,
      generation: row.generation,
    },
  };
}

export type InviteAcquisitionLookup =
  | { ok: true; invite: InviteSnapshot }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "recipient_mismatch" };

/**
 * Signup-side lookup for the identity transaction: the first valid invite
 * used at identity creation owns acquisition, so it must exist, be
 * unexpired, and — for a vouch — belong to the contact key of the person
 * being created, all before any user row is written (PLANS.md 3.5).
 * Unknown, expired and mismatched codes stay distinguishable.
 */
export async function findInviteForAcquisition(
  executor: Pick<PoolClient, "query">,
  code: unknown,
  contactKey: string,
): Promise<InviteAcquisitionLookup> {
  const normalized = normalizeCode(code);
  if (normalized === null) {
    return { ok: false, reason: "not_found" };
  }
  const result = await executor.query<InviteRow & { expired: boolean; target_contact_key: string | null }>(
    `SELECT id, code, rail, creator_id, activity_id, plan_id, generation,
            expires_at, created_at, target_contact_key,
            expires_at <= clock_timestamp() AS expired
     FROM invites
     WHERE code = $1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.expired) {
    return { ok: false, reason: "expired" };
  }
  if (row.rail === "vouch" && row.target_contact_key !== contactKey) {
    return { ok: false, reason: "recipient_mismatch" };
  }
  return {
    ok: true,
    invite: {
      id: row.id,
      code: row.code,
      rail: row.rail,
      creatorId: row.creator_id,
      activityId: row.activity_id,
      planId: row.plan_id,
      generation: row.generation,
    },
  };
}
