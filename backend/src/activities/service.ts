import type { Pool } from "pg";
import {
  ActivityNotFoundError,
  ForbiddenError,
  assertFutureStart,
  isActivityId,
  validateActivityInput,
  type ActivityInput,
  type ActivityView,
  type Country,
} from "./domain.js";
import { assignAtCreation, type SavedAssignment } from "../experiments/service.js";

/**
 * Application services for activities (PLANS.md 3.5). publishActivity owns the
 * single transaction: the activity, its unique shared plan and its saved
 * invitation-experiment assignment commit together or not at all, and the
 * future-start rule is judged against the database clock. Reads never require
 * an identity; participant inspection is reserved to the owning host's
 * session.
 */

export interface ActivitiesDeps {
  pool: Pool;
  /** Allocation and version for the assignment saved with each publication. */
  experiment: { allocationPercent: number; experimentVersion: string };
}

export interface Publication {
  activity: ActivityView;
  plan: { id: string; activityId: string; itinerary: string };
  experiment: SavedAssignment;
}

export interface ActivityDetailView extends ActivityView {
  hostDisplayName: string;
  planId: string;
  started: boolean;
  itinerary: string;
  hostSummary: string;
}

export interface PublicActivityView {
  id: string;
  hostId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  country: Country | null;
  priceMinorUnits: number;
  currency: string;
  capacity: number;
  bookedCount: number;
  remainingSpots: number;
  availabilityVersion: string;
  bookingState: "available" | "full" | "closed";
  hostDisplayName: string;
  started: boolean;
}

export interface HostActivityView extends ActivityView {
  confirmedCount: number;
  started: boolean;
}

export interface ParticipantsView {
  activityId: string;
  planId: string;
  confirmedCount: number;
  /** Confirmed participants; the host sees a masked email, never the raw one. */
  participants: Array<{ userId: string; bookingId: string; displayName: string; maskedEmail: string }>;
}

interface ActivityRow {
  id: string;
  host_id: string;
  title: string;
  description: string;
  itinerary?: string;
  host_summary?: string;
  starts_at: Date;
  ends_at: Date;
  display_timezone: string;
  country_code: Country | null;
  price_minor_units: string;
  currency: string;
  capacity: number;
  booked_count: number;
  availability_version: string;
  host_display_name?: string;
  plan_id?: string;
  started?: boolean;
}

function toView(row: ActivityRow): ActivityView {
  return {
    id: row.id,
    hostId: row.host_id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    timezone: row.display_timezone,
    country: row.country_code,
    priceMinorUnits: Number(row.price_minor_units),
    currency: row.currency,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    remainingSpots: row.capacity - row.booked_count,
    availabilityVersion: row.availability_version,
    bookingState: row.started ? "closed" : row.booked_count >= row.capacity ? "full" : "available",
  };
}

/**
 * Publish an activity and its unique shared plan in one transaction. A
 * failure anywhere — including a past start judged against the database
 * clock — leaves no activity or plan behind.
 */
export async function publishActivity(
  deps: ActivitiesDeps,
  host: { id: string },
  raw: Record<string, unknown>,
): Promise<Publication> {
  const input: ActivityInput = validateActivityInput(raw);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const now = await client.query<{ db_now: Date }>("SELECT now() AS db_now");
    const nowRow = now.rows[0];
    if (!nowRow) {
      // Unreachable: SELECT without FROM always yields one row.
      throw new Error("Database clock unreadable");
    }
    assertFutureStart(input.startsAt, nowRow.db_now);

    const activity = await client.query<ActivityRow>(
      `INSERT INTO activities
         (host_id, title, starts_at, ends_at, display_timezone, country_code, price_minor_units, currency, capacity, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, host_id, title, description, starts_at, ends_at, display_timezone, country_code,
                 price_minor_units, currency, capacity, booked_count, availability_version`,
      [
        host.id,
        input.title,
        input.startsAt,
        input.endsAt,
        input.timezone,
        input.country,
        input.priceMinorUnits,
        input.currency,
        input.spots,
        input.description,
      ],
    );
    const activityRow = activity.rows[0];
    if (!activityRow) {
      // Unreachable: INSERT ... RETURNING always yields the inserted row.
      throw new Error("Activity row missing after insert");
    }
    const plan = await client.query<{ id: string }>(
      "INSERT INTO plans (activity_id, itinerary) VALUES ($1, $2) RETURNING id",
      [activityRow.id, input.itinerary],
    );
    const planRow = plan.rows[0];
    if (!planRow) {
      // Unreachable: INSERT ... RETURNING always yields the inserted row.
      throw new Error("Plan row missing after insert");
    }
    // The saved arm commits with the activity: no one can ever observe an
    // activity before its experiment assignment exists (PLANS.md 3.6).
    const experiment = await assignAtCreation(client, activityRow.id, deps.experiment);

    await client.query("COMMIT");
    return { activity: toView(activityRow), plan: { id: planRow.id, activityId: activityRow.id, itinerary: input.itinerary }, experiment };
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

const PUBLIC_VIEW = `a.id, a.host_id, a.title, a.description, a.starts_at, a.ends_at, a.display_timezone, a.country_code, a.price_minor_units,
                     a.currency, a.capacity, a.booked_count, a.availability_version,
                     u.display_name AS host_display_name,
                     a.starts_at <= now() AS started`;

/** Browse activities without any identity (US-02). */
export async function listPublicActivities(deps: ActivitiesDeps): Promise<PublicActivityView[]> {
  const result = await deps.pool.query<ActivityRow>(
    `SELECT ${PUBLIC_VIEW}
     FROM activities a
     JOIN users u ON u.id = a.host_id
     ORDER BY a.starts_at`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    hostId: row.host_id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    timezone: row.display_timezone,
    country: row.country_code,
    priceMinorUnits: Number(row.price_minor_units),
    currency: row.currency,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    remainingSpots: row.capacity - row.booked_count,
    availabilityVersion: row.availability_version,
    bookingState: row.started ? "closed" : row.booked_count >= row.capacity ? "full" : "available",
    hostDisplayName: row.host_display_name ?? "",
    started: row.started ?? false,
  }));
}

// Canonical validator lives in the domain module; re-exported so existing
// import sites keep one path.
export { isActivityId } from "./domain.js";

/** Inspect one activity without any identity. */
export async function getActivity(deps: { pool: Pick<Pool, "query"> }, activityId: unknown): Promise<ActivityDetailView> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  const result = await deps.pool.query<ActivityRow>(
    `SELECT ${PUBLIC_VIEW}, p.id AS plan_id, p.itinerary, u.summary AS host_summary
     FROM activities a
     JOIN users u ON u.id = a.host_id
     JOIN plans p ON p.activity_id = a.id
     WHERE a.id = $1`,
    [activityId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ActivityNotFoundError();
  }
  return {
    ...toView(row),
    hostDisplayName: row.host_display_name ?? "",
    planId: row.plan_id ?? "",
    itinerary: row.itinerary ?? "",
    hostSummary: row.host_summary ?? "",
    started: row.started ?? false,
  };
}

/** The session host's own activities for their workspace (US-01). */
export async function listHostActivities(
  deps: ActivitiesDeps,
  host: { id: string },
): Promise<HostActivityView[]> {
  const result = await deps.pool.query<ActivityRow>(
    `SELECT a.id, a.host_id, a.title, a.description, a.starts_at, a.ends_at, a.display_timezone, a.country_code, a.price_minor_units,
            a.currency, a.capacity, a.booked_count, a.availability_version,
            a.starts_at <= now() AS started
     FROM activities a
     WHERE a.host_id = $1
     ORDER BY a.starts_at`,
    [host.id],
  );
  return result.rows.map((row) => ({
    ...toView(row),
    confirmedCount: row.booked_count,
    started: row.started ?? false,
  }));
}

/**
 * Owning-host participant inspection (US-01). Host identity comes from the
 * session; participant rows arrive with bookings in ticket #4.
 */
export async function listParticipants(
  deps: ActivitiesDeps,
  host: { id: string },
  activityId: unknown,
): Promise<ParticipantsView> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  // Count and list derive from one snapshot so they can never disagree.
  const result = await deps.pool.query<{
    id: string;
    host_id: string;
    plan_id: string;
    confirmed_total: string;
    participant_user_id: string | null;
    participant_booking_id: string | null;
    participant_display_name: string | null;
    participant_email: string | null;
  }>(
    `SELECT a.id, a.host_id, p.id AS plan_id,
            b.user_id AS participant_user_id, b.id AS participant_booking_id,
            u.display_name AS participant_display_name, u.contact_key AS participant_email,
            count(b.user_id) OVER () AS confirmed_total
     FROM activities a
     JOIN plans p ON p.activity_id = a.id
     LEFT JOIN bookings b ON b.activity_id = a.id
     LEFT JOIN users u ON u.id = b.user_id
     WHERE a.id = $1
     ORDER BY b.created_at`,
    [activityId],
  );
  const rows = result.rows;
  if (rows.length === 0) {
    throw new ActivityNotFoundError();
  }
  const first = rows[0];
  if (!first) {
    throw new ActivityNotFoundError();
  }
  if (first.host_id !== host.id) {
    throw new ForbiddenError();
  }
  return {
    activityId: first.id,
    planId: first.plan_id,
    confirmedCount: Number(first.confirmed_total ?? 0),
    participants: rows
      .filter((row): row is typeof row & { participant_user_id: string } => row.participant_user_id !== null)
      .map((row) => ({
        userId: row.participant_user_id,
        bookingId: row.participant_booking_id ?? "",
        displayName: row.participant_display_name ?? "",
        maskedEmail: maskEmail(row.participant_email ?? ""),
      })),
  };
}

/** First character of the local part, then the domain: `a***@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export async function getHostContext(deps: { pool: Pick<Pool, "query"> }, activity: ActivityDetailView) {
  const previous = await deps.pool.query<{ id: string; title: string; starts_at: Date }>(
    `SELECT id, title, starts_at FROM activities WHERE host_id=$1 AND id<>$2 AND starts_at < clock_timestamp() ORDER BY starts_at DESC`,
    [activity.hostId, activity.id],
  );
  return { id: activity.hostId, displayName: activity.hostDisplayName, summary: activity.hostSummary,
    previousActivities: previous.rows.map(row => ({ id: row.id, title: row.title, startsAt: row.starts_at.toISOString() })) };
}
