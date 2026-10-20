import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.ts";
import { establishIdentity } from "../src/identity/service.js";
import { publishActivity } from "../src/activities/service.js";
import { getInviteCapability } from "../src/experiments/service.js";

// Exercise the real publication services. A fresh seed owns its exact IDs;
// display names/contact prefixes never confer authority to relabel records.
const config = loadConfig();
const pool = createPool(config.databaseUrl, { max: 2 });
const operator = createPool(config.migrationDatabaseUrl, { max: 1 });
try {
  const seeded = await pool.query(
    `SELECT a.host_id, e.experiment_version
     FROM activities a JOIN users u ON u.id = a.host_id
     JOIN activity_experiments e ON e.activity_id = a.id
     WHERE a.dataset = 'demo' AND u.dataset = 'demo'
       AND a.title IN ('[demo] Treatment: invites can be created', '[demo] Control: ordinary booking only')
     GROUP BY a.host_id, e.experiment_version HAVING COUNT(DISTINCT e.arm) = 2`,
  );
  if (seeded.rowCount) {
    console.log("experiment demo already seeded: labeled treatment and control activities exist");
  } else {
    const host = (await establishIdentity(
      { pool, sessionTtlHours: config.demoSessionTtlHours },
      { contactKey: `demo-experiment-host:${randomUUID()}`, displayName: "Demo Host" },
    )).user;
    // Label the new root before publishing: any partially created activities
    // are excluded from real reports by their demo host until labeled below.
    await operator.query("UPDATE users SET dataset = 'demo' WHERE id = $1", [host.id]);
    const base = { description: "A guided activity.", itinerary: "Meet, explore, return.",
      startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      timezone: "UTC", priceMinorUnits: 1000, currency: "EUR", spots: 20,
    };
    const treatment = await publishActivity(
      { pool, experiment: { allocationPercent: 100, experimentVersion: config.experimentVersion } },
      host, { ...base, title: "[demo] Treatment: invites can be created" },
    );
    const control = await publishActivity(
      { pool, experiment: { allocationPercent: 0, experimentVersion: config.experimentVersion } },
      host, { ...base, title: "[demo] Control: ordinary booking only" },
    );
    await operator.query("UPDATE activities SET dataset = 'demo' WHERE id = ANY($1::uuid[])",
      [[treatment.activity.id, control.activity.id]]);
    const flags = { inviteCreationEnabled: config.experimentInviteCreationEnabled };
    console.log(JSON.stringify({
      experimentVersion: config.experimentVersion,
      inviteCreationEnabled: config.experimentInviteCreationEnabled,
      treatment: { activityId: treatment.activity.id, capability: await getInviteCapability(pool, treatment.activity.id, flags) },
      control: { activityId: control.activity.id, capability: await getInviteCapability(pool, control.activity.id, flags) },
      note: "synthetic seed: exact new person/activity IDs labeled demo by the operator; no historical relabeling",
    }, null, 2));
  }
} finally {
  await pool.end();
  await operator.end();
}
