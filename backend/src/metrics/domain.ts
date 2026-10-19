import { ValidationError } from "../identity/domain.js";

/**
 * Applied-availability acknowledgement input (PLANS.md 4.2, issue #11). An
 * ack says "this connection now displays applied state": it is a measurement
 * capability keyed by the server-issued connection id — never person
 * authentication, and never a claim about anyone else's viewer. The schema is
 * bounded like every public surface: canonical UUIDs, a digits-only version,
 * enum source/reason and no free-form properties.
 */

export const ACK_SOURCES = ["websocket", "snapshot"] as const;
export type AckSource = (typeof ACK_SOURCES)[number];

export const ACK_REASONS = ["interval", "reconnect", "foreground"] as const;
export type AckReason = (typeof ACK_REASONS)[number];

export class AckRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckRejectedError";
  }
}

export interface ParsedAvailabilityAck {
  connectionId: string;
  activityId: string;
  /** Digits only: availability versions are monotonic bigints carried as strings. */
  appliedVersion: string;
  /** Committed event id the client says it applied; validated when present. */
  appliedEventId?: string;
  source: AckSource;
  reason: AckReason;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

function canonicalUuid(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw new ValidationError(`${field} must be a canonical lowercase UUID`);
  }
  return raw;
}

function enumValue<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/** Validate the raw body into the strict ack shape, refusing anything extra. */
export function parseAvailabilityAck(body: unknown): ParsedAvailabilityAck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (
      !["connectionId", "activityId", "appliedVersion", "appliedEventId", "source", "reason"].includes(key)
    ) {
      throw new ValidationError(`unknown field "${key}"`);
    }
  }
  if (typeof raw.appliedVersion !== "string" || !VERSION_PATTERN.test(raw.appliedVersion)) {
    throw new ValidationError("appliedVersion must be a canonical nonnegative bigint version string");
  }
  if (raw.appliedEventId !== undefined && (typeof raw.appliedEventId !== "string" || !UUID_PATTERN.test(raw.appliedEventId))) {
    throw new ValidationError("appliedEventId must be a canonical lowercase UUID");
  }
  return {
    connectionId: canonicalUuid(raw.connectionId, "connectionId"),
    activityId: canonicalUuid(raw.activityId, "activityId"),
    appliedVersion: raw.appliedVersion,
    appliedEventId: raw.appliedEventId === undefined ? undefined : (raw.appliedEventId as string),
    source: enumValue(raw.source, "source", ACK_SOURCES),
    reason: enumValue(raw.reason, "reason", ACK_REASONS),
  };
}
