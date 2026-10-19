import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../src/db/pool.ts";
import type { UserSnapshot } from "../src/identity/domain.ts";
import { establishIdentity } from "../src/identity/service.ts";
import { ActivityNotFoundError, ActivityValidationError, ForbiddenError } from "../src/activities/domain.ts";
import {
  getActivity,
  listHostActivities,
  listParticipants,
  listPublicActivities,
  publishActivity,
  type ActivitiesDeps,
} from "../src/activities/service.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

let pool: Pool;
let deps: ActivitiesDeps;
let host: UserSnapshot;
let otherHost: UserSnapshot;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  pool = createPool(appUrl);
  deps = { pool, experiment: { allocationPercent: 50, experimentVersion: "test-rollout" } };
  host = (await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("act-host"), displayName: "Host Ada" })).user;
  otherHost = (await establishIdentity({ pool, sessionTtlHours: 12 }, { contactKey: uniqueKey("act-other"), displayName: "Host Bo" })).user;
  return () => pool.end();
});

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
  return { description: "A guided activity.", itinerary: "Meet, explore, return.",
    title: "Sunset Kayaking",
    startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    timezone: "Europe/Berlin",
    priceMinorUnits: 4500,
    currency: "EUR",
    spots: 6,
    ...overrides,
  };
}

async function activityCount(): Promise<number> {
  return withClient(migrationUrl, (client) =>
    client.query("SELECT count(*)::int AS n FROM activities").then((result) => result.rows[0].n as number),
  );
}

describe("publishActivity", () => {
  it("creates the activity and its unique plan atomically with all spots available", async () => {
    const before = await activityCount();
    const result = await publishActivity(deps, host, validInput());

    expect(result.activity).toMatchObject({
      hostId: host.id,
      title: "Sunset Kayaking",
      timezone: "Europe/Berlin",
      priceMinorUnits: 4500,
      currency: "EUR",
      capacity: 6,
      bookedCount: 0,
      remainingSpots: 6, // hosting consumes no spot
      availabilityVersion: "1",
    });
    expect(result.plan.id).toBeTruthy();

    const after = await activityCount();
    expect(after).toBe(before + 1);
    await withClient(migrationUrl, (client) =>
      client
        .query("SELECT count(*)::int AS n FROM plans WHERE activity_id = $1", [result.activity.id])
        .then((plans) => expect(plans.rows[0].n).toBe(1)),
    );
  });

  it("keeps independently published activities on their own plans", async () => {
    const first = await publishActivity(deps, host, validInput({ title: "First" }));
    const second = await publishActivity(deps, host, validInput({ title: "Second" }));

    expect(second.activity.id).not.toBe(first.activity.id);
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(second.activity.bookedCount).toBe(0);
    expect(second.activity.remainingSpots).toBe(second.activity.capacity);
  });

  it("rejects invalid details naming each offending field without publishing", async () => {
    const before = await activityCount();
    const past = new Date(Date.now() - 3600 * 1000).toISOString();

    const cases: Array<[string, Record<string, unknown>]> = [
      ["description", validInput({ description: "" })],
      ["itinerary", validInput({ itinerary: "   " })],
      ["title", validInput({ title: "" })],
      ["title", validInput({ title: "   " })],
      ["startsAt", validInput({ startsAt: "not-a-date" })],
      ["timezone", validInput({ timezone: "Mars/Olympus" })],
      ["priceMinorUnits", validInput({ priceMinorUnits: -1 })],
      ["priceMinorUnits", validInput({ priceMinorUnits: 10.5 })],
      ["currency", validInput({ currency: "eur" })],
      ["currency", validInput({ currency: "EURO" })],
      ["spots", validInput({ spots: 0 })],
      ["spots", validInput({ spots: 2.5 })],
    ];
    for (const [field, input] of cases) {
      const err = await publishActivity(deps, host, input).catch((e) => e);
      expect(err, `${field}: ${JSON.stringify(input[field])}`).toBeInstanceOf(ActivityValidationError);
      expect(err.fields, field).toHaveProperty(field);
    }

    const pastErr = await publishActivity(deps, host, validInput({ startsAt: past })).catch((e) => e);
    expect(pastErr).toBeInstanceOf(ActivityValidationError);
    expect(pastErr.fields).toHaveProperty("startsAt");

    // Multiple invalid fields are all reported at once.
    const multi = await publishActivity(deps, host, validInput({ currency: "nope", spots: -3, title: "" })).catch(
      (e) => e,
    );
    expect(Object.keys(multi.fields).sort()).toEqual(["currency", "spots", "title"]);

    expect(await activityCount()).toBe(before); // nothing was published
  });

  it("reports an unknown activity distinctly", async () => {
    await expect(getActivity(deps, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    await expect(getActivity(deps, "not-a-uuid")).rejects.toBeInstanceOf(ActivityNotFoundError);
  });

  it("restricts participant inspection to the owning host", async () => {
    const published = await publishActivity(deps, host, validInput());

    const owned = await listParticipants(deps, host, published.activity.id);
    expect(owned).toMatchObject({ activityId: published.activity.id, planId: published.plan.id, confirmedCount: 0 });
    expect(owned.participants).toEqual([]); // booking rows arrive with ticket #4

    await expect(listParticipants(deps, otherHost, published.activity.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("public reads", () => {
  it("lists and inspects activities without any identity, with availability and host name but no participants", async () => {
    const published = await publishActivity(deps, host, validInput({ title: "Public Viewing" }));

    const list = await listPublicActivities(deps);
    const view = list.find((activity) => activity.id === published.activity.id);
    expect(view).toMatchObject({
      title: "Public Viewing",
      hostDisplayName: "Host Ada",
      bookedCount: 0,
      remainingSpots: 6,
      started: false,
    });
    expect(view).not.toHaveProperty("participants");

    const detail = await getActivity(deps, published.activity.id);
    expect(detail?.planId).toBe(published.plan.id);
    expect(detail).toMatchObject({ hostDisplayName: "Host Ada", started: false });
    expect(detail).not.toHaveProperty("participants");
  });

  it("lists only the session host's own activities for the host workspace", async () => {
    const mineOnly = await publishActivity(deps, otherHost, validInput({ title: "Bo's Own" }));

    const hostList = await listHostActivities(deps, host);
    expect(hostList.find((activity) => activity.id === mineOnly.activity.id)).toBeUndefined();

    const otherList = await listHostActivities(deps, otherHost);
    expect(otherList.find((activity) => activity.id === mineOnly.activity.id)).toMatchObject({ title: "Bo's Own" });
  });
});
