/**
 * Activities domain language and publication invariants (CONTEXT.md Activity,
 * Spot, Availability; PLANS.md 3.2). A published activity is future-dated,
 * priced in minor units with an ISO currency, and never holds more bookings
 * than its spots. Remaining spots are derived, never stored.
 */

export const TITLE_MAX_LENGTH = 200;
export const TIMEZONE_MAX_LENGTH = 64;
const MAX_SPOTS = 2147483647;
const CURRENCIES = new Set<string>(Intl.supportedValuesOf("currency"));

export interface ActivityInput {
  itinerary: string;
  title: string;
  description: string;
  startsAt: Date;
  timezone: string;
  priceMinorUnits: number;
  currency: string;
  spots: number;
}

export interface ActivityView {
  id: string;
  hostId: string;
  title: string;
  description: string;
  startsAt: string;
  timezone: string;
  priceMinorUnits: number;
  currency: string;
  capacity: number;
  bookedCount: number;
  remainingSpots: number;
  availabilityVersion: string;
  bookingState: "available" | "full" | "closed";
}

export class ActivityValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super(`Invalid activity details: ${Object.keys(fields).join(", ")}`);
    this.name = "ActivityValidationError";
    this.fields = fields;
  }
}

export class ActivityNotFoundError extends Error {
  constructor() {
    super("Activity not found");
    this.name = "ActivityNotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("Only the owning host may inspect participants");
    this.name = "ForbiddenError";
  }
}

function isPresentString(raw: unknown): raw is string {
  return typeof raw === "string";
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Validate every publication field, reporting all offending fields at once. */
export function validateActivityInput(raw: Record<string, unknown>): ActivityInput {
  const fields: Record<string, string> = {};

  let title = "";
  if (isPresentString(raw.title)) {
    title = raw.title.trim();
    if (title.length < 1 || title.length > TITLE_MAX_LENGTH) {
      fields.title = `must be between 1 and ${TITLE_MAX_LENGTH} characters`;
    }
  } else {
    fields.title = "must be a string";
  }

  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const itinerary = typeof raw.itinerary === "string" ? raw.itinerary.trim() : "";
  if (!description) fields.description = "Describe the activity.";
  if (!itinerary) fields.itinerary = "Add the shared itinerary.";

  let startsAt = new Date(Number.NaN);
  if (isPresentString(raw.startsAt)) {
    startsAt = new Date(raw.startsAt);
    const instant = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw.startsAt);
    const calendarDate = instant ? new Date(`${instant[1]}T00:00:00Z`) : new Date(Number.NaN);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(calendarDate.getTime()) ||
        calendarDate.toISOString().slice(0, 10) !== instant?.[1] || /T24:/.test(raw.startsAt)) {
      fields.startsAt = "must be an ISO 8601 instant with an explicit UTC offset (Z or ±HH:MM) and a real calendar date";
    }
  } else {
    fields.startsAt = "must be a string containing an ISO 8601 instant";
  }

  let timezone = "";
  if (isPresentString(raw.timezone)) {
    timezone = raw.timezone.trim();
    if (timezone.length < 1 || timezone.length > TIMEZONE_MAX_LENGTH || !isValidTimeZone(timezone)) {
      fields.timezone = "must be a valid IANA time zone";
    }
  } else {
    fields.timezone = "must be a string";
  }

  let priceMinorUnits = -1;
  if (typeof raw.priceMinorUnits === "number" && Number.isSafeInteger(raw.priceMinorUnits) && raw.priceMinorUnits >= 0) {
    priceMinorUnits = raw.priceMinorUnits;
  } else {
    fields.priceMinorUnits = "must be a nonnegative safe integer amount in minor units";
  }

  let currency = "";
  if (isPresentString(raw.currency) && CURRENCIES.has(raw.currency)) {
    currency = raw.currency;
  } else {
    fields.currency = "must be a three-letter ISO 4217 code in capitals";
  }

  let spots = -1;
  if (typeof raw.spots === "number" && Number.isInteger(raw.spots) && raw.spots > 0 && raw.spots <= MAX_SPOTS) {
    spots = raw.spots;
  } else {
    fields.spots = `must be a positive whole number no greater than ${MAX_SPOTS}`;
  }

  if (Object.keys(fields).length > 0) {
    throw new ActivityValidationError(fields);
  }
  return { title, description, itinerary, startsAt, timezone, priceMinorUnits, currency, spots };
}

/** The schedule must still be in the future at the moment of publication. */
export function assertFutureStart(startsAt: Date, databaseNow: Date): void {
  if (startsAt.getTime() <= databaseNow.getTime()) {
    throw new ActivityValidationError({ startsAt: "must be in the future" });
  }
}

/** A well-formed activity id; anything else is simply not an activity. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isActivityId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
