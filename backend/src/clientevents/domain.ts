import { ValidationError, canonicalUuid } from "../identity/domain.js";

/**
 * Client observation events (PLANS.md 4.1, issue #10). A client event is an
 * observation made after a display or an explicit interaction — never
 * evidence that a link was delivered, that a claim finished or that any
 * server-owned outcome happened. Only the four allowlisted types exist;
 * server-owned outcomes (bookings, completions, identity records) are not
 * submittable, and unknown fields are refused rather than ignored so no raw
 * contact data or unchecked property can ride along.
 */

export const CLIENT_EVENT_TYPES = [
  "activity_viewed",
  "invite_share_action",
  "invite_opened",
  "claim_started",
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** The surfaces that can display journeys (PLANS.md 4.1 web/Flutter). */
export const CLIENT_CHANNELS = ["web", "flutter"] as const;

export type ClientChannel = (typeof CLIENT_CHANNELS)[number];

/** Displayed landing outcomes only; current availability is never rewritten in. */
export const OPEN_OUTCOMES = ["available", "full", "expired", "used"] as const;

export type OpenOutcome = (typeof OPEN_OUTCOMES)[number];

/** Explicit copy/share method, stored without claiming delivery. */
export const SHARE_METHODS = ["copy", "system_share"] as const;

export type ShareMethod = (typeof SHARE_METHODS)[number];

/** A replay that carries different content than the accepted original. */
export class EventConflictError extends Error {
  constructor() {
    super("This event ID was already accepted with different content");
    this.name = "EventConflictError";
  }
}

function enumValue<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * The strict per-type body shape. Everything outside an event type's listed
 * fields — including userId, contactKey and any free-form property — is a
 * validation error, so an event row can only ever carry the checked fields
 * below plus server-derived facts.
 */
export type ParsedClientEvent = {
  visitId?: string;
  eventId: string;
  visitorId: string;
  channel: ClientChannel;
} & (
  | { type: "activity_viewed"; activityId: string }
  | { type: "invite_share_action"; inviteCode: unknown; shareMethod: ShareMethod }
  | { type: "invite_opened"; inviteCode: unknown; outcome: OpenOutcome }
  | { type: "claim_started"; inviteCode: unknown }
);

const COMMON_FIELDS = new Set(["type", "eventId", "visitorId", "channel", "visitId"]);

const TYPE_FIELDS: Record<ClientEventType, Set<string>> = {
  activity_viewed: new Set(["activityId"]),
  invite_share_action: new Set(["inviteCode", "shareMethod"]),
  invite_opened: new Set(["inviteCode", "outcome"]),
  claim_started: new Set(["inviteCode"]),
};

/** Validate the raw body into its discriminated shape, refusing anything extra. */
export function parseClientEvent(body: unknown): ParsedClientEvent {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const type = enumValue(raw.type, "type", CLIENT_EVENT_TYPES);
  for (const key of Object.keys(raw)) {
    if (!COMMON_FIELDS.has(key) && !TYPE_FIELDS[type].has(key)) {
      throw new ValidationError(`unknown field "${key}" for ${type}`);
    }
  }
  const eventId = canonicalUuid(raw.eventId, "eventId");
  const visitorId = canonicalUuid(raw.visitorId, "visitorId");
  const channel = enumValue(raw.channel, "channel", CLIENT_CHANNELS);
  // The invite code stays uninterpreted here: malformed or unknown codes are
  // an invite_not_found from the authoritative lookup, like code resolution.
  const visitId = raw.visitId === undefined ? undefined : canonicalUuid(raw.visitId, "visitId");
  switch (type) {
    case "activity_viewed":
      return { type, visitId, eventId, visitorId, channel, activityId: canonicalUuid(raw.activityId, "activityId") };
    case "invite_share_action":
      return {
        type,
        visitId,
        eventId,
        visitorId,
        channel,
        inviteCode: raw.inviteCode,
        shareMethod: enumValue(raw.shareMethod, "shareMethod", SHARE_METHODS),
      };
    case "invite_opened":
      return {
        type,
        visitId,
        eventId,
        visitorId,
        channel,
        inviteCode: raw.inviteCode,
        outcome: enumValue(raw.outcome, "outcome", OPEN_OUTCOMES),
      };
    case "claim_started":
      return { type, visitId, eventId, visitorId, channel, inviteCode: raw.inviteCode };
  }
}

/** The device-persisted channel of an identity completion (optional there). */
export function validateChannel(raw: unknown): ClientChannel {
  return enumValue(raw, "channel", CLIENT_CHANNELS);
}
