import { getActivity, getHostContext } from "../activities/service.js";
import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import { appendEvent } from "../events/append.js";
import { ActivityNotFoundError, ForbiddenError, isActivityId } from "../activities/domain.js";
import { ActivityStartedError } from "../booking/domain.js";
import { ValidationError, normalizeEmail } from "../identity/domain.js";
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

export interface InvitesDeps {
  pool: Pool;
  redis: Redis;
  /** Creation switch: gates creation only, never issued invites or claims. */
  inviteCreationEnabled: boolean;
  /** Legacy configuration accepted by callers; invitation expiry is activity start. */
  expiryHours: number;
  /** Legacy caller configuration; creation does not consume a quota. */
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
  /** The recipient email, echoed to its creator only; never in previews. */
  recipientEmail: string | null;
}

export interface InvitePreview {
  code: string;
  rail: InviteRail;
  generation: number;
  state: InviteState;
  expiresAt: string;
  inviterDisplayName: string;
  activity: Awaited<ReturnType<typeof getActivity>>;
  plan: { id: string; activityId: string; itinerary: string };
  host: Awaited<ReturnType<typeof getHostContext>>;
}

interface CreationRow {
  id: string;
  starts_at: Date;
  arm: string | null;
  experiment_version: string;
  affiliated: boolean;
  creator_generation: number;
  creator_contact_key: string;
}

interface PreviewRow {
  code: string;
  rail: InviteRail;
  generation: number;
  expires_at: Date;
  activity_id: string;
  capacity: number;
  booked_count: number;
  inviter_display_name: string;
  started: boolean;
  expired: boolean;
  used: boolean;
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

function inviteView(invite: InviteRow): InviteView {
  return { id: invite.id, code: invite.code, rail: invite.rail, generation: invite.generation,
    activityId: invite.activity_id, planId: invite.plan_id, expiresAt: invite.expires_at.toISOString(),
    createdAt: invite.created_at.toISOString(), recipientEmail: invite.target_contact_key };
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

/** Save a personal vouch or atomically retrieve/create the account's public link. */
export async function createInvite(
  deps: InvitesDeps,
  creator: { id: string },
  activityId: unknown,
  input: { ip: string; rail: InviteRail; recipientEmail?: unknown },
): Promise<InviteView & { created: boolean }> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  let targetContactKey: string | null = null;
  if (input.rail === "vouch") {
    targetContactKey = normalizeEmail(input.recipientEmail);
  } else if (input.recipientEmail !== undefined) {
    // A public share names no recipient; a stray field is invalid input.
    throw new ValidationError("public_share invites must not carry a recipient email");
  }

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    // Lock order per PLANS.md 3.3 step 2: the activity row first, every gate
    // judged against the locked row.
    const locked = await client.query<CreationRow>(
      `SELECT a.id, a.starts_at, e.arm, e.experiment_version,
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
    if (input.rail === "public_share") {
      const existing = await client.query<InviteRow>(
        "SELECT * FROM invites WHERE creator_id=$1 AND activity_id=$2 AND rail='public_share'",
        [creator.id, activityId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { ...inviteView(existing.rows[0]), created: false };
      }
    }
    if (targetContactKey !== null && targetContactKey === row.creator_contact_key.trim().toLowerCase()) {
      throw new ValidationError("A vouch must name an email other than your own");
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
    // The generation snapshots the inviter's signup generation plus one and
    // never changes afterwards; expiry never passes the activity start.
    const generation = row.creator_generation + 1;
    let invite: InviteRow | undefined;
    for (let attempt = 0; attempt < 3 && !invite; attempt += 1) {
      const inserted = await client.query<InviteRow>(
        `INSERT INTO invites (code, rail, creator_id, activity_id, plan_id, generation, expires_at, target_contact_key)
         SELECT $1, $2, $3, a.id, p.id, $4,
                a.starts_at, $5
         FROM activities a JOIN plans p ON p.activity_id = a.id
         WHERE a.id = $6
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, rail, creator_id, activity_id, plan_id, generation, expires_at, created_at, target_contact_key`,
        [generateCode(), input.rail, creator.id, generation, targetContactKey, activityId],
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
    return { ...inviteView(invite), created: true };
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
): Promise<InviteView & { created: boolean }> {
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
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await client.query<PreviewRow>(
      `SELECT i.code, i.rail, i.generation, i.expires_at,
              a.id AS activity_id, a.capacity, a.booked_count,
              u.display_name AS inviter_display_name,
              a.starts_at <= clock_timestamp() AS started,
              i.expires_at <= clock_timestamp() AS expired,
              EXISTS (SELECT 1 FROM booking_attributions ba WHERE ba.invite_id=i.id AND ba.rail='vouch') AS used
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
    const state: InviteState = row.used ? "used" : row.started || row.expired ? "expired"
      : row.booked_count >= row.capacity ? "full" : "claimable";
    const activityDeps = { pool: client };
    const activity = await getActivity(activityDeps, row.activity_id);
    const host = await getHostContext(activityDeps, activity);
    await client.query("COMMIT");
    return {
      code: row.code, rail: row.rail, generation: row.generation, state,
      expiresAt: row.expires_at.toISOString(), inviterDisplayName: row.inviter_display_name,
      activity, plan: { id: activity.planId, activityId: activity.id, itinerary: activity.itinerary }, host,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type InviteClaimLookup =
  | { ok: true; invite: InviteSnapshot }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "recipient_mismatch" }
  | { ok: false; reason: "used" };

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
  const result = await executor.query<InviteRow & { expired: boolean; used: boolean; target_contact_key: string | null }>(
    `SELECT id, code, rail, creator_id, activity_id, plan_id, generation,
            expires_at, created_at, target_contact_key,
            expires_at <= clock_timestamp() AS expired,
            rail = 'vouch' AND EXISTS (
              SELECT 1 FROM booking_attributions WHERE invite_id = invites.id AND rail = 'vouch'
            ) AS used
     FROM invites
     WHERE code = $1 AND activity_id = $2`,
    [normalized, activityId],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.used) {
    return { ok: false, reason: "used" };
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
  | { ok: false; reason: "recipient_mismatch" }
  | { ok: false; reason: "used" };

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
  const result = await executor.query<InviteRow & { expired: boolean; used: boolean; target_contact_key: string | null }>(
    `SELECT id, code, rail, creator_id, activity_id, plan_id, generation,
            expires_at, created_at, target_contact_key,
            expires_at <= clock_timestamp() AS expired,
            rail = 'vouch' AND EXISTS (
              SELECT 1 FROM booking_attributions WHERE invite_id = invites.id AND rail = 'vouch'
            ) AS used
     FROM invites
     WHERE code = $1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  if (row.used) {
    return { ok: false, reason: "used" };
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
