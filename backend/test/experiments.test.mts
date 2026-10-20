import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import { ActivityNotFoundError } from "../src/activities/domain.ts";
import { publishActivity, type ActivitiesDeps } from "../src/activities/service.ts";
import { getInviteCapability } from "../src/experiments/service.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let host: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  host = (
    await establishIdentity(
      { pool, sessionTtlHours: 12 },
      { contactKey: uniqueKey("exp-host"), displayName: "Experiment Host" },
    )
  ).user;
  return () => pool.end();
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deps(experiment: { allocationPercent: number; experimentVersion: string }): ActivitiesDeps {
  return { pool, experiment };
}

function input(title: string) {
  return { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title,
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
    timezone: "UTC",
    priceMinorUnits: 1000,
    currency: "EUR",
    spots: 5,
  };
}

/** Insert a legacy activity with the migration role: no assignment row. */
async function insertLegacyActivity(title: string): Promise<string> {
  return withClient(migrationUrl, (client) =>
    client
      .query(
        `INSERT INTO activities (host_id, title, starts_at, ends_at, display_timezone, price_minor_units, currency, capacity)
         VALUES ($1, $2, now() + interval '48 hours', now() + interval '50 hours', 'UTC', 100, 'EUR', 5) RETURNING id`,
        [host.id, title],
      )
      .then((r) => r.rows[0].id as string),
  );
}

async function assignmentCount(activityId: string): Promise<number> {
  return withClient(migrationUrl, (client) =>
    client
      .query("SELECT count(*)::int AS n FROM activity_experiments WHERE activity_id = $1", [activityId])
      .then((r) => r.rows[0].n as number),
  );
}

describe("saved experiment assignments", () => {
  it("commits the assignment with the activity: a failing assignment leaves nothing observable", async () => {
    // Fault injection at the assignment write: publication must roll back
    // completely, leaving no activity or plan that could be seen unassigned.
    await withClient(migrationUrl, async (client) => {
      await client.query(`CREATE OR REPLACE FUNCTION probe_fail_assignment() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected assignment failure'; END; $$ LANGUAGE plpgsql`);
      await client.query(
        "CREATE TRIGGER probe_fail_assignment_t BEFORE INSERT ON activity_experiments FOR EACH ROW EXECUTE FUNCTION probe_fail_assignment()",
      );
    });
    const outcome = await publishActivity(
      deps({ allocationPercent: 50, experimentVersion: "t1" }),
      host,
      input("Atomic Assignment"),
    ).then(
      () => "unexpected-success",
      (err) => (err instanceof Error ? err.message : String(err)),
    );
    await withClient(migrationUrl, (client) => client.query("DROP TRIGGER probe_fail_assignment_t ON activity_experiments"));
    expect(outcome).toContain("injected assignment failure");

    const counts = await withClient(migrationUrl, (client) =>
      client.query(
        `SELECT (SELECT count(*)::int FROM activities WHERE title = 'Atomic Assignment') AS activities,
                (SELECT count(*)::int FROM plans p JOIN activities a ON a.id = p.activity_id WHERE a.title = 'Atomic Assignment') AS plans`,
      ),
    );
    expect(counts.rows[0]).toMatchObject({ activities: 0, plans: 0 });
  });

  it("gives every viewer the same saved arm and version, unchanged when the allocation changes", async () => {
    const first = await publishActivity(
      deps({ allocationPercent: 100, experimentVersion: "rollout-a" }),
      host,
      input("Stable Treatment"),
    );
    expect(first.experiment).toEqual({ arm: "treatment", experimentVersion: "rollout-a" });

    // A rollout change ships as a new version for NEW activities; the saved
    // assignment of the older activity must not move.
    await publishActivity(deps({ allocationPercent: 0, experimentVersion: "rollout-b" }), host, input("New Version Control"));

    const capability = await getInviteCapability(pool, first.activity.id, { inviteCreationEnabled: true });
    expect(capability).toMatchObject({
      eligible: true,
      canCreateInvites: true,
      arm: "treatment",
      experimentVersion: "rollout-a",
    });
    const again = await getInviteCapability(pool, first.activity.id, { inviteCreationEnabled: true });
    expect(again).toEqual(capability);

    const saved = await withClient(migrationUrl, (client) =>
      client.query("SELECT arm, experiment_version FROM activity_experiments WHERE activity_id = $1", [first.activity.id]),
    );
    expect(saved.rows[0]).toMatchObject({ arm: "treatment", experiment_version: "rollout-a" });
  });

  it("assigns deterministic arms at the allocation bounds", async () => {
    const treatment = await publishActivity(deps({ allocationPercent: 100, experimentVersion: "bounds" }), host, input("All Treatment"));
    const control = await publishActivity(deps({ allocationPercent: 0, experimentVersion: "bounds" }), host, input("All Control"));
    expect(treatment.experiment.arm).toBe("treatment");
    expect(control.experiment.arm).toBe("control");
  });

  it("keeps control eligible but invite-incapable", async () => {
    const control = await publishActivity(deps({ allocationPercent: 0, experimentVersion: "control" }), host, input("Plain Control"));
    const capability = await getInviteCapability(pool, control.activity.id, { inviteCreationEnabled: true });
    expect(capability).toMatchObject({
      eligible: true,
      canCreateInvites: false,
      arm: "control",
      experimentVersion: "control",
    });
  });

  it("gates only creation when the kill switch is off, keeping the saved assignment", async () => {
    const treatment = await publishActivity(deps({ allocationPercent: 100, experimentVersion: "switch" }), host, input("Switch Off"));
    const capability = await getInviteCapability(pool, treatment.activity.id, { inviteCreationEnabled: false });
    expect(capability).toMatchObject({
      eligible: true,
      canCreateInvites: false,
      arm: "treatment",
      experimentVersion: "switch",
    });
    expect(await assignmentCount(treatment.activity.id)).toBe(1);
  });

  it("never assigns or fabricates on read for an activity without an assignment", async () => {
    const legacyId = await insertLegacyActivity("Legacy Read");
    const capability = await getInviteCapability(pool, legacyId, { inviteCreationEnabled: true });
    expect(capability).toEqual({ eligible: false, canCreateInvites: false, arm: null, experimentVersion: null });

    await getInviteCapability(pool, legacyId, { inviteCreationEnabled: true });
    expect(await assignmentCount(legacyId)).toBe(0);
  });

  it("reports unknown and malformed activity ids as not found", async () => {
    await expect(
      getInviteCapability(pool, "not-a-uuid", { inviteCreationEnabled: true }),
    ).rejects.toBeInstanceOf(ActivityNotFoundError);
    await expect(
      getInviteCapability(pool, randomUUID(), { inviteCreationEnabled: true }),
    ).rejects.toBeInstanceOf(ActivityNotFoundError);
  });
});
