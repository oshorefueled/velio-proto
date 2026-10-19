/**
 * Identity domain language and invariants (CONTEXT.md "Identity"; PLANS.md 1).
 * A person is known by a demo contact with a stable contact key; original
 * acquisition is fixed at creation and never changes afterwards.
 */

export const CONTACT_KEY_MAX_LENGTH = 120;
export const DISPLAY_NAME_MAX_LENGTH = 120;

export interface UserSnapshot {
  id: string;
  contactKey: string;
  email: string;
  displayName: string;
  signupSource: string;
  signupGeneration: number;
}

export interface SessionGrant {
  /** Opaque bearer token; only its SHA-256 hash is stored. */
  token: string;
  /** Absolute expiry taken from the database clock. */
  expiresAt: string;
}

/** Original acquisition for a person created without an invite (ticket #6 extends this). */
export function directAcquisition(): { signupSource: "direct"; signupGeneration: 0 } {
  return { signupSource: "direct", signupGeneration: 0 };
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function requireNonEmptyString(raw: unknown, field: string, maxLength: number): string {
  if (typeof raw !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > maxLength) {
    throw new ValidationError(`${field} must be between 1 and ${maxLength} characters`);
  }
  return value;
}

export function validateContactKey(raw: unknown): string {
  return requireNonEmptyString(raw, "contactKey", CONTACT_KEY_MAX_LENGTH);
}

export function validateDisplayName(raw: unknown): string {
  return requireNonEmptyString(raw, "displayName", DISPLAY_NAME_MAX_LENGTH);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID only; other spellings are invalid input. */
export function canonicalUuid(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw new ValidationError(`${field} must be a canonical lowercase UUID`);
  }
  return raw;
}

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("email must be a valid email address");
  const email = raw.trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("email must be a valid email address (at most 120 characters)");
  }
  return email;
}
