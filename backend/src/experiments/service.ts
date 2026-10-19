import type { Pool, PoolClient } from "pg";
import { ActivityNotFoundError, isActivityId } from "../activities/domain.js";

/**
 * Saved invitation-experiment assignments (PLANS.md 3.6). Every activity
 * receives exactly one random arm inside its creation transaction, so no one
 * can ever observe an activity without its assignment; saved arms never
 * change — a rollout change ships as a new experiment version and keeps
 * previous assignments untouched. Eligibility reads only the saved row (the
 * API checks the assignment even if a caller bypasses the interface): the
 * creation kill switch gates invite creation without touching saved
 * assignments or issued invitations, and control retains ordinary booking.
 * The invite routes delivered in tickets #6/#7 call this same policy.
 */

export type ExperimentArm = "treatment" | "control";

export interface ExperimentSettings {
  /** Treatment percentage for newly created activities (integer 0-100). */
  allocationPercent: number;
  /** Version saved with new assignments; change it when allocation changes. */
  experimentVersion: string;
  /** Creation kill switch; switching off never revokes issued invitations. */
  inviteCreationEnabled: boolean;
}

export interface SavedAssignment {
  arm: ExperimentArm;
  experimentVersion: string;
}

export interface InviteCapability {
  /** A saved assignment exists for this activity. */
  eligible: boolean;
  /** Saved treatment arm with creation currently switched on. */
  canCreateInvites: boolean;
  arm: ExperimentArm | null;
  experimentVersion: string | null;
}

interface AssignmentRow {
  arm: ExperimentArm | null;
  experiment_version: string | null;
}

/**
 * Draw and save one arm inside the publishing transaction. The database's
 * random source decides against the configured allocation; the bounds are
 * deterministic (100 always treatment, 0 always control), which the tests
 * pin without mocking randomness.
 */
export async function assignAtCreation(
  client: Pick<PoolClient, "query">,
  activityId: string,
  settings: Pick<ExperimentSettings, "allocationPercent" | "experimentVersion">,
): Promise<SavedAssignment> {
  const inserted = await client.query<AssignmentRow>(
    `INSERT INTO activity_experiments (activity_id, arm, experiment_version)
     VALUES ($1, CASE WHEN random() * 100 < $2 THEN 'treatment' ELSE 'control' END, $3)
     RETURNING arm, experiment_version`,
    [activityId, settings.allocationPercent, settings.experimentVersion],
  );
  const row = inserted.rows[0];
  if (!row || row.arm === null || row.experiment_version === null) {
    // Unreachable: INSERT ... RETURNING always yields the inserted row, and
    // the schema CHECKs pin both columns non-null.
    throw new Error(`Experiment assignment missing after insert for activity ${activityId}`);
  }
  return { arm: row.arm, experimentVersion: row.experiment_version };
}

/**
 * Inspect invitation eligibility from the saved assignment only. Every
 * viewer receives the same saved arm and version for the shared activity;
 * a read never assigns anything, so activities published before assignments
 * existed simply stay ineligible.
 */
export async function getInviteCapability(
  pool: Pool,
  activityId: unknown,
  settings: Pick<ExperimentSettings, "inviteCreationEnabled">,
): Promise<InviteCapability> {
  if (!isActivityId(activityId)) {
    throw new ActivityNotFoundError();
  }
  const result = await pool.query<AssignmentRow>(
    `SELECT e.arm, e.experiment_version
     FROM activities a
     LEFT JOIN activity_experiments e ON e.activity_id = a.id
     WHERE a.id = $1`,
    [activityId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ActivityNotFoundError();
  }
  if (row.arm === null || row.experiment_version === null) {
    return { eligible: false, canCreateInvites: false, arm: null, experimentVersion: null };
  }
  return {
    eligible: true,
    canCreateInvites: row.arm === "treatment" && settings.inviteCreationEnabled,
    arm: row.arm,
    experimentVersion: row.experiment_version,
  };
}
