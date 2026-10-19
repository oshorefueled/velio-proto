import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { appendEvent } from "../events/append.js";
import { findInviteForAcquisition } from "../invites/service.js";
import { InviteExpiredError, InviteUsedError, InviteNotFoundError, InviteRecipientMismatchError } from "../invites/domain.js";
import { linkVisitorIdentity } from "../clientevents/service.js";
import { validateChannel } from "../clientevents/domain.js";
import {
  ValidationError,
  canonicalUuid,
  directAcquisition,
  validateContactKey,
  normalizeEmail,
  validateDisplayName,
  type SessionGrant,
  type UserSnapshot,
} from "./domain.js";

/**
 * Application services for demo identity (PLANS.md 3.5). Each write path owns
 * exactly one transaction: the person, their session and the identity events
 * commit together or not at all. The database clock decides expiry.
 */

export interface IdentityDeps {
  pool: Pool;
  /** Finite, documented session lifetime in hours (PLANS.md 5.2). */
  sessionTtlHours: number;
}

export interface Establishment {
  session: SessionGrant;
  user: UserSnapshot;
  /** True when this call created the person; false when an existing contact resumed. */
  created: boolean;
}

export class SessionInvalidError extends Error {
  constructor() {
    super("Session token is not recognized");
    this.name = "SessionInvalidError";
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Session has expired; select your identity again");
    this.name = "SessionExpiredError";
  }
}

const USER_COLUMNS = "id, contact_key, display_name, signup_source, signup_generation";

function toSnapshot(row: {
  id: string;
  contact_key: string;
  display_name: string;
  signup_source: string;
  signup_generation: number;
}): UserSnapshot {
  return {
    id: row.id,
    contactKey: row.contact_key,
    email: row.contact_key,
    displayName: row.display_name,
    signupSource: row.signup_source,
    signupGeneration: row.signup_generation,
  };
}

/** Opaque bearer token: 32 random bytes; only its SHA-256 hash is stored. */
function issueToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Establish (resolve-or-create) the person for a contact key and start a new
 * session for them. Concurrent establishments of one new contact key converge
 * on a single user row and a single user_created event via the unique contact
 * key and the event dedup key. An existing contact resumes: a supplied
 * display name is ignored and the recorded identity stands, and a supplied
 * invite never rewrites their saved acquisition (PLANS.md 3.5: an optional
 * invite sets acquisition only for a new user, after validation).
 */
export async function establishIdentity(
  deps: IdentityDeps,
  input: {
    contactKey?: unknown;
    email?: unknown;
    visitId?: unknown;
    displayName?: unknown;
    inviteCode?: unknown;
    /** Optional device visitor ID; linked once identity completion commits. */
    visitorId?: unknown;
    /** Device surface of the completion; requires visitorId when supplied. */
    channel?: unknown;
  },
): Promise<Establishment> {
  const contactKey = input.email !== undefined ? normalizeEmail(input.email) : validateContactKey(input.contactKey);
  const visitId = input.visitId === undefined ? undefined : canonicalUuid(input.visitId, "visitId");
  const visitorId =
    input.visitorId === undefined ? undefined : canonicalUuid(input.visitorId, "visitorId");
  const channel =
    input.channel === undefined ? undefined : validateChannel(input.channel);
  if (channel !== undefined && visitorId === undefined) {
    throw new ValidationError("channel requires visitorId");
  }
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE contact_key = $1`,
      [contactKey],
    );

    let user = existing.rows[0] ?? null;
    let created = false;

    if (!user) {
      const displayName = input.displayName === undefined && input.email !== undefined
        ? contactKey.split("@")[0]!.slice(0, 120)
        : validateDisplayName(input.displayName);
      // The invite is validated before any user row is written: an unknown
      // or expired code leaves no acquisition, no session and no event.
      let acquisition: { signupSource: string; signupGeneration: number } = directAcquisition();
      let signupInviteId: string | null = null;
      if (input.inviteCode !== undefined) {
        const lookup = await findInviteForAcquisition(client, input.inviteCode, contactKey);
        if (!lookup.ok) {
          throw lookup.reason === "used"
            ? new InviteUsedError()
            : lookup.reason === "expired"
              ? new InviteExpiredError()
              : lookup.reason === "recipient_mismatch"
                ? new InviteRecipientMismatchError()
                : new InviteNotFoundError();
        }
        acquisition = { signupSource: lookup.invite.rail, signupGeneration: lookup.invite.generation };
        signupInviteId = lookup.invite.id;
      }
      const inserted = await client.query(
        `INSERT INTO users (contact_key, display_name, signup_source, signup_generation, signup_invite_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (contact_key) DO NOTHING
         RETURNING ${USER_COLUMNS}`,
        [contactKey, displayName, acquisition.signupSource, acquisition.signupGeneration, signupInviteId],
      );
      user = inserted.rows[0] ?? null;
      if (user) {
        created = true;
        // Replay-safe: the dedup key holds even if a committed outcome is
        // ever written again.
        await appendEvent(client, {
          eventName: "user_created",
          dedupKey: `user_created:${user.id}`,
          userId: user.id,
          details: {
            signupSource: user.signup_source,
            signupGeneration: user.signup_generation,
            signupInviteId: signupInviteId ?? undefined,
          },
        });
      } else {
        // A concurrent request created the person first; resume them.
        const raced = await client.query(
          `SELECT ${USER_COLUMNS} FROM users WHERE contact_key = $1`,
          [contactKey],
        );
        user = raced.rows[0] ?? null;
      }
    }

    if (!user) {
      // Unreachable: the conflict winner's committed row is visible here.
      throw new Error(`Identity for contact key disappeared during establishment`);
    }

    const token = issueToken();
    const session = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO demo_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3))
       RETURNING id, expires_at`,
      [hashToken(token), user.id, deps.sessionTtlHours],
    );
    const sessionRow = session.rows[0];
    if (!sessionRow) {
      // Unreachable: INSERT ... RETURNING always yields the inserted row.
      throw new Error("Session row missing after insert");
    }

    await appendEvent(client, {
      eventName: "account_entry_completed",
      dedupKey: `account_entry_completed:${sessionRow.id}`,
      userId: user.id,
      visitorId,
      channel,
      details: { mode: created ? "created" : "resumed", visitId },
    });

    // Identity completion links the visitor for both new and returning
    // identities; the first resolved identity wins and is never reassigned.
    if (visitorId !== undefined) {
      await linkVisitorIdentity(client, { visitorId, userId: user.id, channel });
    }

    await client.query("COMMIT");

    return {
      session: { token, expiresAt: sessionRow.expires_at.toISOString() },
      user: toSnapshot(user),
      created,
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

/**
 * Resolve the actor from an opaque session token. A client-supplied user id
 * never influences this lookup (PLANS.md 3.2: identity comes from the session).
 */
export async function resolveSession(deps: IdentityDeps, token: unknown): Promise<UserSnapshot> {
  if (typeof token !== "string" || token.length === 0) {
    throw new SessionInvalidError();
  }
  const result = await deps.pool.query<{
    id: string;
    contact_key: string;
    display_name: string;
    signup_source: string;
    signup_generation: number;
    expired: boolean;
  }>(
    `SELECT u.id, u.contact_key, u.display_name, u.signup_source, u.signup_generation,
            s.expires_at <= now() AS expired
     FROM demo_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SessionInvalidError();
  }
  if (row.expired) {
    throw new SessionExpiredError();
  }
  return toSnapshot(row);
}
