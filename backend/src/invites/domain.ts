/**
 * Invitation domain language and invariants (CONTEXT.md "Invites and trust";
 * PLANS.md 3.2/3.5). A code is the typeable form of an invite and never
 * sequenced or derived; rail and generation are immutable creation-time
 * snapshots. A public share carries reach, not trust, and reserves no spot —
 * only claiming does, through the locked booking transaction.
 */

export type InviteRail = "public_share" | "vouch";

/** Readable lifecycle state for a resolved invite (US-07). */
export type InviteState = "claimable" | "expired" | "full" | "used";

export class InviteNotFoundError extends Error {
  constructor() {
    super("This invite code is not recognized");
    this.name = "InviteNotFoundError";
  }
}

export class InviteExpiredError extends Error {
  constructor() {
    super("This invite has expired");
    this.name = "InviteExpiredError";
  }
}

/** A vouch claims only its named recipient (PLANS 2.5 "wrong recipient"). */
export class InviteRecipientMismatchError extends Error {
  constructor() {
    super("This invitation was vouched for a different email");
    this.name = "InviteRecipientMismatchError";
  }
}

/** Uppercase Crockford base32: typeable, no I/L/O/U ambiguity. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 12;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{8,32}$`);

/** Normalize typed input to the stored form; anything malformed is unknown. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toUpperCase();
  return CODE_PATTERN.test(value) ? value : null;
}

/** Immutable snapshot used by the claim transaction and attribution write. */
export interface InviteSnapshot {
  id: string;
  code: string;
  rail: InviteRail;
  creatorId: string;
  activityId: string;
  planId: string;
  generation: number;
}
