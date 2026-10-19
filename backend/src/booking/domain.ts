/**
 * Booking domain invariants and outcome errors (PLANS.md 3.3). One person
 * holds at most one spot per activity; the booking decision is made on the
 * database wall clock after the activity row lock; replays return the
 * committed booking before any lifecycle or capacity gate.
 */

export interface BookingView {
  id: string;
  activityId: string;
  planId: string;
  userId: string;
  createdAt: string;
  attribution: { rail: string; generation: number };
}

export class ActivitySoldOutError extends Error {
  constructor() {
    super("The activity just filled; no spot remains");
    this.name = "ActivitySoldOutError";
  }
}

export class ActivityStartedError extends Error {
  constructor() {
    super("The activity has started; booking is closed");
    this.name = "ActivityStartedError";
  }
}

/** The activity's plan has been completed by the host (PLANS.md 3.5). */
export class ActivityCompletedError extends Error {
  constructor() {
    super("This plan has been completed");
    this.name = "ActivityCompletedError";
  }
}

// The activity not existing is an activities-context fact; re-using that
// error keeps one class for the shared HTTP mapping.
export { ActivityNotFoundError } from "../activities/domain.js";

export class BookingNotFoundError extends Error {
  constructor() {
    super("No booking exists for this identity and activity");
    this.name = "BookingNotFoundError";
  }
}

export class LockTimeoutError extends Error {
  constructor() {
    super("Booking decision timed out waiting for the activity lock; retry");
    this.name = "LockTimeoutError";
  }
}

export class BookingFailedError extends Error {
  constructor(cause?: unknown) {
    super("Booking failed; nothing was consumed", { cause });
    this.name = "BookingFailedError";
  }
}

/** The booking transaction's commit outcome could not be confirmed. */
export class BookingOutcomeUnknownError extends Error {
  constructor() {
    super("Booking outcome is unknown; check your booking before retrying");
    this.name = "BookingOutcomeUnknownError";
  }
}

export class InvalidOperationError extends Error {
  constructor() {
    super("operationId must be a stable token of 1 to 120 characters");
    this.name = "InvalidOperationError";
  }
}

export function validateOperationId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InvalidOperationError();
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > 120) {
    throw new InvalidOperationError();
  }
  return value;
}
