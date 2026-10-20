import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "../..");

// Load the repository-root .env when present. Variables already set in the
// real environment keep precedence, so tests and deployments can override.
loadDotenv({ path: process.env.ENV_FILE ?? path.join(repoRoot, ".env") });

export interface Config {
  /** Application role: DML only, no DDL. */
  databaseUrl: string;
  /** Migration role: owns schema objects; used by `npm run migrate`. */
  migrationDatabaseUrl: string;
  redisUrl: string;
  port: number;
  /** Finite readiness probe budget; an unanswered dependency is unavailable. */
  readyCheckTimeoutMs: number;
  /** Pool-wide statement timeout, independent of the readiness budget. */
  databaseStatementTimeoutMs: number;
  /** Pool size: concurrent clients available to the API. */
  databasePoolMax: number;
  /** Pool connection establishment budget, independent of readiness. */
  databaseConnectTimeoutMs: number;
  /** Booking transaction lock wait (SET LOCAL lock_timeout), PLANS 5.2. */
  bookingLockTimeoutMs: number;
  /** Booking transaction statement timeout (SET LOCAL), PLANS 5.2. */
  bookingStatementTimeoutMs: number;
  /** Demo session lifetime in hours; finite and documented (PLANS.md 5.2). */
  demoSessionTtlHours: number;
  /** Version saved with each experiment assignment (PLANS.md 3.6); a new
   *  allocation ships as a new version while saved assignments stay fixed. */
  experimentVersion: string;
  /** Treatment percentage for newly created activities (integer 0-100). */
  experimentTreatmentAllocationPercent: number;
  /** Invite-creation kill switch; does not revoke issued invitations. */
  experimentInviteCreationEnabled: boolean;
  /** Configured invite lifetime in hours; expiry never passes the activity start. */
  inviteExpiryHours: number;
  /** Finite publication budget for one Redis availability publish (PLANS 3.4). */
  livePublishTimeoutMs: number;
  /** Environment prefix for live channels, keeping stages off each other. */
  liveChannelPrefix: string;
  /** Liveness lease for measurement-registered live connections (PLANS 4.2). */
  liveLeaseSeconds: number;
  /** Owning instance label for live presence; defaults to a per-boot UUID. */
  liveInstanceId?: string;
  logLevel: string;
}

export class MissingConfigError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variables: ${missing.join(", ")}`);
    this.name = "MissingConfigError";
  }
}

function positiveInt(value: string, name: string): number {
  // Strict decimal digits: parseInt would silently accept "14.5" as 14 or
  // "1e2" as 100, and a misread budget is worse than a refused one.
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function percent(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be an integer between 0 and 100, got: ${value}`);
  }
  return parsed;
}

function boolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got: ${value}`);
}

function experimentVersion(value: string): string {
  if (value.trim().length === 0 || [...value].length > 64) {
    throw new Error("EXPERIMENT_VERSION must contain 1 to 64 characters");
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
  return value;
}

const REQUIRED_KEYS = ["DATABASE_URL", "MIGRATION_DATABASE_URL", "REDIS_URL"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new MissingConfigError(missing);
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL as string,
    redisUrl: env.REDIS_URL as string,
    port: positiveInt(env.PORT ?? "3000", "PORT"),
    readyCheckTimeoutMs: positiveInt(env.READY_CHECK_TIMEOUT_MS ?? "2000", "READY_CHECK_TIMEOUT_MS"),
    databaseStatementTimeoutMs: positiveInt(
      env.DATABASE_STATEMENT_TIMEOUT_MS ?? "5000",
      "DATABASE_STATEMENT_TIMEOUT_MS",
    ),
    databasePoolMax: positiveInt(env.DATABASE_POOL_MAX ?? "64", "DATABASE_POOL_MAX"),
    databaseConnectTimeoutMs: positiveInt(env.DATABASE_CONNECT_TIMEOUT_MS ?? "5000", "DATABASE_CONNECT_TIMEOUT_MS"),
    bookingLockTimeoutMs: positiveInt(env.BOOKING_LOCK_TIMEOUT_MS ?? "2000", "BOOKING_LOCK_TIMEOUT_MS"),
    bookingStatementTimeoutMs: positiveInt(
      env.BOOKING_STATEMENT_TIMEOUT_MS ?? "5000",
      "BOOKING_STATEMENT_TIMEOUT_MS",
    ),
    demoSessionTtlHours: positiveInt(env.DEMO_SESSION_TTL_HOURS ?? "12", "DEMO_SESSION_TTL_HOURS"),
    experimentVersion: experimentVersion(env.EXPERIMENT_VERSION ?? "rollout-1"),
    experimentTreatmentAllocationPercent: percent(
      env.EXPERIMENT_TREATMENT_ALLOCATION_PERCENT ?? "10",
      "EXPERIMENT_TREATMENT_ALLOCATION_PERCENT",
    ),
    experimentInviteCreationEnabled: boolean(
      env.EXPERIMENT_INVITE_CREATION_ENABLED ?? "true",
      "EXPERIMENT_INVITE_CREATION_ENABLED",
    ),
    inviteExpiryHours: positiveInt(env.INVITE_EXPIRY_HOURS ?? "336", "INVITE_EXPIRY_HOURS"),
    livePublishTimeoutMs: positiveInt(env.LIVE_PUBLISH_TIMEOUT_MS ?? "500", "LIVE_PUBLISH_TIMEOUT_MS"),
    liveChannelPrefix: nonEmpty(env.LIVE_CHANNEL_PREFIX ?? "velio-local", "LIVE_CHANNEL_PREFIX"),
    liveLeaseSeconds: positiveInt(env.LIVE_LEASE_SECONDS ?? "30", "LIVE_LEASE_SECONDS"),
    liveInstanceId: env.LIVE_INSTANCE_ID === undefined ? undefined : nonEmpty(env.LIVE_INSTANCE_ID, "LIVE_INSTANCE_ID"),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
