import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserSnapshot } from "./identity/domain.js";
import { ValidationError } from "./identity/domain.js";
import {
  resolveSession,
  SessionExpiredError,
  SessionInvalidError,
  type IdentityDeps,
} from "./identity/service.js";
import {
  ActivityNotFoundError,
  ActivityValidationError,
  ForbiddenError,
} from "./activities/domain.js";
import {
  ActivityCompletedError,
  ActivitySoldOutError,
  ActivityStartedError,
  BookingNotFoundError,
  BookingOutcomeUnknownError,
  InvalidOperationError,
  LockTimeoutError,
} from "./booking/domain.js";
import { InviteExpiredError, InviteUsedError, InviteNotFoundError, InviteRecipientMismatchError } from "./invites/domain.js";
import { EventConflictError } from "./clientevents/domain.js";
import { AckRejectedError } from "./metrics/domain.js";
import { RateLimitError } from "./ratelimit.js";

/**
 * Shared transport concerns for the API's route plugins: bearer-token session
 * resolution and the machine-readable error envelope. Every route plugin
 * registers `domainErrorHandler`, so infrastructure and domain failures speak
 * one consistent shape (PLANS 3.5 distinct codes).
 */

const STATUS: Record<string, number> = {
  validation_error: 400,
  session_required: 401,
  session_invalid: 401,
  session_expired: 401,
  forbidden: 403,
  activity_not_found: 404,
  booking_not_found: 404,
  invite_not_found: 404,
  invite_expired: 410,
  invite_used: 409,
  invite_recipient_mismatch: 403,
  booking_outcome_unknown: 500,
  activity_sold_out: 409,
  activity_started: 409,
  activity_completed: 409,
  event_conflict: 409,
  ack_rejected: 400,
  request_limit: 429,
  lock_timeout: 503,
  server_error: 500,
};

export class SessionRequiredError extends Error {
  constructor() {
    super("Provide a Bearer session token");
    this.name = "SessionRequiredError";
  }
}

export function sendError(
  reply: FastifyReply,
  code: string,
  message: string,
  fields?: Record<string, string>,
  retryAfterSeconds?: number,
) {
  // An unmapped code is a programming error: surface it as 500, not as success.
  void reply.code(STATUS[code] ?? 500);
  if (retryAfterSeconds !== undefined) {
    void reply.header("retry-after", retryAfterSeconds);
  }
  return fields
    ? { error: { code, message, fields } }
    : { error: { code, message } };
}

/** The only accepted credential form; anything else means "select an identity". */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * Resolve the acting person from the request's session token alone. A
 * client-supplied user id never influences the actor.
 */
export async function requireSession(deps: IdentityDeps, request: FastifyRequest): Promise<UserSnapshot> {
  const token = bearerToken(request.headers.authorization);
  if (token === null) {
    throw new SessionRequiredError();
  }
  return resolveSession(deps, token);
}

/** Map every known domain failure to its code; anything else is a server error. */
export function domainErrorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof SessionRequiredError) return sendError(reply, "session_required", err.message);
  if (err instanceof SessionExpiredError) return sendError(reply, "session_expired", err.message);
  if (err instanceof SessionInvalidError) return sendError(reply, "session_invalid", err.message);
  if (err instanceof ActivityValidationError) {
    return sendError(reply, "validation_error", err.message, err.fields);
  }
  if (err instanceof ValidationError) return sendError(reply, "validation_error", err.message);
  if (err instanceof InvalidOperationError) return sendError(reply, "validation_error", err.message);
  if (err instanceof ActivityNotFoundError) return sendError(reply, "activity_not_found", err.message);
  if (err instanceof BookingNotFoundError) return sendError(reply, "booking_not_found", err.message);
  if (err instanceof BookingOutcomeUnknownError) return sendError(reply, "booking_outcome_unknown", err.message);
  if (err instanceof ForbiddenError) return sendError(reply, "forbidden", err.message);
  if (err instanceof ActivitySoldOutError) return sendError(reply, "activity_sold_out", err.message);
  if (err instanceof ActivityStartedError) return sendError(reply, "activity_started", err.message);
  if (err instanceof ActivityCompletedError) return sendError(reply, "activity_completed", err.message);
  if (err instanceof InviteNotFoundError) return sendError(reply, "invite_not_found", err.message);
  if (err instanceof InviteUsedError) return sendError(reply, "invite_used", err.message);
  if (err instanceof InviteExpiredError) return sendError(reply, "invite_expired", err.message);
  if (err instanceof InviteRecipientMismatchError) {
    return sendError(reply, "invite_recipient_mismatch", err.message);
  }
  if (err instanceof EventConflictError) {
    return sendError(reply, "event_conflict", err.message);
  }
  if (err instanceof AckRejectedError) {
    return sendError(reply, "ack_rejected", err.message);
  }
  if (err instanceof RateLimitError) {
    return sendError(reply, "request_limit", err.message, undefined, err.retryAfterSeconds);
  }
  if (err instanceof LockTimeoutError) {
    return sendError(reply, "lock_timeout", err.message, undefined, 1);
  }
  // Fastify's own client faults (malformed JSON, unsupported content type)
  // keep their own status inside the envelope; only genuine server failures
  // become server_error.
  if (typeof err.statusCode === "number" && err.statusCode < 500) {
    void reply.code(err.statusCode);
    return { error: { code: "validation_error", message: err.message } };
  }
  request.log.error(err);
  return sendError(reply, "server_error", "Unexpected server failure");
}

export function useDomainErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(domainErrorHandler);
}
