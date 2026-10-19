import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { clearIdentityData, resetAndMigrate, urlFor, withClient } from "./support/db.mts";
import type { InjectOptions, Response as LightInjectResponse } from "light-my-request";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const appUrl = urlFor("DATABASE_URL", "velio_test");

function configWith(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: appUrl,
    redisUrl: process.env.REDIS_URL as string,
    migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL as string,
    port: 0,
    readyCheckTimeoutMs: 500,
    databasePoolMax: 10,
    databaseConnectTimeoutMs: 5000,
    databaseStatementTimeoutMs: 5000,
    bookingLockTimeoutMs: 2000,
    bookingStatementTimeoutMs: 5000,
    bookingRateLimitPerIdentity: 30,
    bookingRateLimitPerIp: 10000,
    bookingRateWindowSeconds: 3600,
    demoSessionTtlHours: 12,
    logLevel: "silent",
    experimentVersion: "test-rollout",
    experimentTreatmentAllocationPercent: 100,
    experimentInviteCreationEnabled: true,
    inviteExpiryHours: 336,
    inviteRateLimitPerIdentity: 10,
    inviteRateLimitPerIp: 60,
    inviteResolveRateLimitPerIp: 120,
    inviteRateWindowSeconds: 3600,
    clientEventRateLimitPerIp: 240,
    clientEventRateWindowSeconds: 3600,
    liveLeaseSeconds: 30,
    availabilityAckRateLimitPerIp: 240,
    availabilityAckRateWindowSeconds: 3600,
    livePublishTimeoutMs: 500,
    liveChannelPrefix: "test-live",
    ...overrides,
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  app = buildApp(configWith({}));
  return () => app.close();
});

type App = Awaited<ReturnType<typeof buildApp>>;

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let callCounter = 0;

/** Fresh source IP per request: run-persistent Redis windows must not leak across runs. */
function nextInject(app: App, options: InjectOptions): Promise<LightInjectResponse> {
  callCounter += 1;
  return app.inject({
    remoteAddress: `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${callCounter % 250}`,
    ...options,
  });
}

async function establish(app: App, displayName: string, extra: object = {}): Promise<{
  token: string;
  userId: string;
}> {
  const response = await nextInject(app, {
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (uniqueKey("ce-identity")) + "@example.test", displayName, ...extra },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return { token: body.session.token, userId: body.user.id };
}

async function publishActivity(app: App, token: string, title: string): Promise<string> {
  const response = await nextInject(app, {
    method: "POST",
    url: "/activities",
    headers: { authorization: `Bearer ${token}` },
    payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      timezone: "UTC",
      priceMinorUnits: 2500,
      currency: "EUR",
      spots: 5,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().activity.id;
}

async function createShare(app: App, token: string, activityId: string): Promise<string> {
  const response = await nextInject(app, {
    method: "POST",
    url: `/activities/${activityId}/invites`,
    headers: { authorization: `Bearer ${token}` },
    payload: { rail: "public_share" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().invite.code;
}

function clientEvent(payload: object, token?: string) {
  return nextInject(app, {
    method: "POST",
    url: "/client-events",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    payload,
  });
}

function observation(overrides: object): object {
  return {
    type: "activity_viewed",
    eventId: randomUUID(),
    visitorId: randomUUID(),
    channel: "web",
    ...overrides,
  };
}

async function eventsWhere(clause: string, params: unknown[] = []): Promise<
  Array<Record<string, unknown>>
> {
  return withClient(appUrl, async (client) => {
    const result = await client.query(`SELECT * FROM events WHERE ${clause}`, params);
    return result.rows;
  });
}

function firstRow(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

describe("POST /client-events — guest journey (issue #10 AC1)", () => {
  it("links an anonymous displayed open through identity completion to a claim", async () => {
    const host = await establish(app, "Journey Host");
    const activityId = await publishActivity(app, host.token, "Journey Activity");
    const code = await createShare(app, host.token, activityId);
    const visitorId = randomUUID();

    // Anonymous displayed open, before any identity exists.
    const opened = await clientEvent({
      type: "invite_opened",
      eventId: randomUUID(),
      visitorId,
      channel: "web",
      inviteCode: code,
      outcome: "available",
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().event).toMatchObject({ status: "accepted", type: "invite_opened" });

    // Identity completion links the visitor to the session-resolved identity.
    const completion = await nextInject(app, {
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (uniqueKey("ce-journey")) + "@example.test", displayName: "Journey Guest", visitorId, channel: "web" },
    });
    expect(completion.statusCode).toBe(200);
    const userId = completion.json().user.id;

    // The explicit claim action joins the same visitor and identity.
    const claimPayload = {
      type: "claim_started",
      eventId: randomUUID(),
      visitorId,
      channel: "web",
      inviteCode: code,
    };
    const claim = await clientEvent(claimPayload, completion.json().session.token);
    expect(claim.statusCode).toBe(200);

    // Retrying the claim records nothing new and rewrites no attribution:
    // signup acquisition and conversions stay server-owned (issue #10).
    const claimRetry = await clientEvent(claimPayload, completion.json().session.token);
    expect(claimRetry.statusCode).toBe(200);
    expect(claimRetry.json().event.status).toBe("duplicate");
    await withClient(appUrl, async (client) => {
      const person = await client.query(
        "SELECT signup_source, signup_generation, signup_invite_id FROM users WHERE id = $1",
        [userId],
      );
      expect(person.rows[0]).toMatchObject({ signup_source: "direct", signup_generation: 0 });
      const bookings = await client.query("SELECT id FROM bookings WHERE user_id = $1", [userId]);
      expect(bookings.rows).toHaveLength(0);
      const claims = await client.query(
        "SELECT event_id FROM events WHERE dedup_key = $1",
        [`client_event:${claimPayload.eventId}`],
      );
      expect(claims.rows).toHaveLength(1);
    });

    // Pre-identity open and later claim analyze as one person-invite
    // opportunity: both events carry the same visitor_id, the claim also
    // carries the resolved user, and the link row reconciles them.
    const rows = await eventsWhere("visitor_id = $1 ORDER BY event_name", [visitorId]);
    expect(rows.map((row) => row.event_name)).toEqual(["account_entry_completed", "claim_started", "invite_opened"]);
    const openRow = rows.find((row) => row.event_name === "invite_opened")!;
    const claimRow = rows.find((row) => row.event_name === "claim_started")!;
    expect(openRow.user_id).toBeNull();
    expect(openRow.outcome).toBe("available");
    // Both steps point at the same resolved invite, not just at absent IDs.
    expect(openRow.invite_id).not.toBeNull();
    expect(claimRow.invite_id).not.toBeNull();
    expect(openRow.invite_id).toBe(claimRow.invite_id);
    expect(claimRow.user_id).toBe(userId);
    expect(claimRow.activity_id).toBe(activityId);
    await withClient(appUrl, async (client) => {
      const link = await client.query(
        "SELECT visitor_id, user_id, channel FROM visitor_identities WHERE visitor_id = $1",
        [visitorId],
      );
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0].user_id).toBe(userId);
      expect(link.rows[0].channel).toBe("web");
    });
  });

  it("keeps the first link on a returning identity and never reassigns it", async () => {
    const visitorId = randomUUID();
    const contactKey = uniqueKey("ce-return");
    const created = await nextInject(app, {
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (contactKey) + "@example.test", displayName: "Returning Person", visitorId, channel: "flutter" },
    });
    expect(created.statusCode).toBe(200);
    const userId = created.json().user.id;

    // A returning identity resumes the same person and keeps the same link.
    const resumed = await nextInject(app, {
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (contactKey) + "@example.test", displayName: "Ignored", visitorId, channel: "flutter" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().created).toBe(false);
    expect(resumed.json().user.id).toBe(userId);
    await withClient(appUrl, async (client) => {
      const links = await client.query(
        "SELECT user_id FROM visitor_identities WHERE visitor_id = $1",
        [visitorId],
      );
      expect(links.rows).toHaveLength(1);
      expect(links.rows[0].user_id).toBe(userId);
    });

    // Another person's session records its event under their own user ID
    // but the visitor link stays with the first resolved identity.
    const other = await establish(app, "Other Person");
    const host = await establish(app, "Reassign Host");
    const activityId = await publishActivity(app, host.token, "Reassign Activity");
    const viewed = await clientEvent(
      observation({ visitorId, activityId }),
      other.token,
    );
    expect(viewed.statusCode).toBe(200);
    const rows = await eventsWhere("event_name = 'activity_viewed' AND visitor_id = $1", [visitorId]);
    expect(firstRow(rows).user_id).toBe(other.userId);
    await withClient(appUrl, async (client) => {
      const links = await client.query(
        "SELECT user_id FROM visitor_identities WHERE visitor_id = $1",
        [visitorId],
      );
      expect(links.rows[0].user_id).toBe(userId);
    });
  });
});

describe("POST /client-events — dedup and conflict (issue #10 AC2)", () => {
  it("counts a repeated event once and never rewrites the accepted original", async () => {
    const host = await establish(app, "Dedup Host");
    const activityId = await publishActivity(app, host.token, "Dedup Activity");
    const code = await createShare(app, host.token, activityId);
    const eventId = randomUUID();
    const visitorId = randomUUID();
    const payload = {
      type: "invite_opened",
      eventId,
      visitorId,
      channel: "web",
      inviteCode: code,
      outcome: "available",
    };

    const first = await clientEvent(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().event.status).toBe("accepted");

    const retry = await clientEvent(payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().event.status).toBe("duplicate");

    const rows = await eventsWhere("dedup_key = $1", [`client_event:${eventId}`]);
    expect(rows[0]!.outcome).toBe("available");

    // Changed content under a known ID is refused and changes nothing.
    const conflict = await clientEvent({ ...payload, outcome: "full" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("event_conflict");
    const after = await eventsWhere("dedup_key = $1", [`client_event:${eventId}`]);
    expect(after[0]!.outcome).toBe("available");

    // Replay with a session under an anonymous original is different content.
    const person = await establish(app, "Replay Person");
    const authedReplay = await clientEvent(payload, person.token);
    expect(authedReplay.statusCode).toBe(409);
    expect(authedReplay.json().error.code).toBe("event_conflict");
    expect(await eventsWhere("dedup_key = $1", [`client_event:${eventId}`])).toHaveLength(1);
  });
});

describe("POST /client-events — fabricated server-owned outcomes (issue #10 AC3)", () => {
  it("rejects server-owned event types and identity/contact fields", async () => {
    for (const fabricated of ["booking_confirmed", "booking_completed", "account_entry_completed", "spot_claimed"]) {
      const response = await clientEvent(observation({ type: fabricated }));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("validation_error");
    }
    // No client-supplied identity and no contact data can ride along.
    const person = await establish(app, "Fabrication Person");
    for (const extra of [{ userId: person.userId }, { contactKey: "some-contact" }]) {
      const response = await clientEvent(observation(extra));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("validation_error");
    }
  });

  it("derives the actor from the session, never from the body", async () => {
    const host = await establish(app, "Actor Host");
    const activityId = await publishActivity(app, host.token, "Actor Activity");
    const personA = await establish(app, "Actor A");
    const personB = await establish(app, "Actor B");
    const viewed = await clientEvent(observation({ activityId }), personA.token);
    expect(viewed.statusCode).toBe(200);
    const rows = await eventsWhere("dedup_key = $1", [`client_event:${viewed.json().event.eventId}`]);
    expect(firstRow(rows).user_id).toBe(personA.userId);
    expect(firstRow(rows).user_id).not.toBe(personB.userId);
  });
});

describe("POST /client-events — authoritative context validation", () => {
  it("refuses unknown activity, unknown or malformed invite, and bad enums", async () => {
    const unknownActivity = await clientEvent(observation({ activityId: randomUUID() }));
    expect(unknownActivity.statusCode).toBe(404);
    expect(unknownActivity.json().error.code).toBe("activity_not_found");

    for (const inviteCode of ["UNKNOWNCODE1", "has lower case!", 42]) {
      const response = await clientEvent({
        type: "invite_opened",
        eventId: randomUUID(),
        visitorId: randomUUID(),
        channel: "web",
        inviteCode,
        outcome: "available",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("invite_not_found");
    }

    const badChannel = await clientEvent(observation({ channel: "android" }));
    expect(badChannel.statusCode).toBe(400);
    expect(badChannel.json().error.code).toBe("validation_error");

    const badOutcome = await clientEvent({
      type: "invite_opened",
      eventId: randomUUID(),
      visitorId: randomUUID(),
      channel: "web",
      inviteCode: "WHATEVER12",
      outcome: "started",
    });
    expect(badOutcome.statusCode).toBe(400);
    expect(badOutcome.json().error.code).toBe("validation_error");

    // Non-canonical UUID spellings are invalid input, on any ID field.
    const nonCanonical = await clientEvent(observation({ eventId: randomUUID().toUpperCase() }));
    expect(nonCanonical.statusCode).toBe(400);
    const notUuid = await clientEvent(observation({ visitorId: "correlation-token" }));
    expect(notUuid.statusCode).toBe(400);
  });

  it("when unavailable invitations are displayed, full, expired and used outcomes are saved as observations", async () => {
    const host = await establish(app, "Outcomes Host");
    const activityId = await publishActivity(app, host.token, "Outcomes Activity");
    const code = await createShare(app, host.token, activityId);
    for (const outcome of ["full", "expired", "used"]) {
      const response = await clientEvent({
        type: "invite_opened",
        eventId: randomUUID(),
        visitorId: randomUUID(),
        channel: "flutter",
        inviteCode: code,
        outcome,
      });
      expect(response.statusCode).toBe(200);
    }
    const rows = await eventsWhere(
      "event_name = 'invite_opened' AND outcome IN ('full','expired','used') AND details->>'rail' = 'public_share'",
    );
    expect(rows.map((row) => row.outcome).sort()).toEqual(["expired", "full", "used"]);
  });

  it("stores the explicit share method with server-derived rail and assignment", async () => {
    const host = await establish(app, "Share Host");
    const activityId = await publishActivity(app, host.token, "Share Method Activity");
    const code = await createShare(app, host.token, activityId);
    const response = await clientEvent({
      type: "invite_share_action",
      eventId: randomUUID(),
      visitorId: randomUUID(),
      channel: "web",
      inviteCode: code,
      shareMethod: "copy",
    });
    expect(response.statusCode).toBe(200);

    const rows = await eventsWhere("event_name = 'invite_share_action' AND details->>'shareMethod' = 'copy'");
    const shareRow = firstRow(rows);
    await withClient(appUrl, async (client) => {
      const assignment = await client.query(
        "SELECT arm, experiment_version FROM activity_experiments WHERE activity_id = $1",
        [activityId],
      );
      expect(shareRow.experiment_arm).toBe(assignment.rows[0].arm);
      expect(shareRow.experiment_version).toBe(assignment.rows[0].experiment_version);
      expect(shareRow.invite_id).not.toBeNull();
      expect((shareRow.details as { rail: string }).rail).toBe("public_share");
    });
  });
});

describe("POST /client-events — session and route boundaries", () => {
  it("refuses invalid bearer credentials instead of downgrading to anonymous", async () => {
    const host = await establish(app, "Credential Host");
    const activityId = await publishActivity(app, host.token, "Credential Activity");
    for (const authorization of ["Bearer not-a-real-token", "Bearer", "Basic invalid", "Bearer two tokens"]) {
      const eventId = randomUUID();
      const response = await nextInject(app, {
        method: "POST", url: "/client-events", headers: { authorization },
        payload: observation({ eventId, activityId }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("session_invalid");
      expect(await eventsWhere("dedup_key = $1", [`client_event:${eventId}`])).toHaveLength(0);
    }
  });

  it("records an anonymous claim action before identity selection and links it on completion", async () => {
    const host = await establish(app, "Pre-identity Host");
    const activityId = await publishActivity(app, host.token, "Pre-identity Activity");
    const inviteCode = await createShare(app, host.token, activityId);
    const visitorId = randomUUID();
    const eventId = randomUUID();
    const response = await clientEvent({ type: "claim_started", eventId, visitorId, channel: "web", inviteCode });
    expect(response.statusCode).toBe(200);
    const person = await establish(app, "Pre-identity Guest", { visitorId, channel: "web" });
    await withClient(appUrl, async (client) => {
      const result = await client.query(
        `SELECT e.user_id, v.user_id AS linked_user FROM events e
         JOIN visitor_identities v ON v.visitor_id::text = e.visitor_id
         WHERE e.dedup_key = $1`, [`client_event:${eventId}`]);
      expect(result.rows).toEqual([{ user_id: null, linked_user: person.userId }]);
    });
  });

  it("never records an open from preview resolution or unknown codes", async () => {
    const host = await establish(app, "Preview Host");
    const activityId = await publishActivity(app, host.token, "Preview Activity");
    const code = await createShare(app, host.token, activityId);

    const resolved = await nextInject(app, { method: "GET", url: `/invites/${code}` });
    expect(resolved.statusCode).toBe(200);
    const unknown = await nextInject(app, { method: "GET", url: "/invites/UNKNOWNCODE1" });
    expect(unknown.statusCode).toBe(404);

    const opens = await eventsWhere("event_name = 'invite_opened' AND details->>'rail' IS NOT NULL AND activity_id = $1", [activityId]);
    expect(opens).toHaveLength(0);
  });

  it("keeps the observation quota bounded per IP", async () => {
    const host = await establish(app, "Quota Host");
    const activityId = await publishActivity(app, host.token, "Quota Activity");
    // One stable source IP per run: persisted Redis windows must not leak
    // across runs into this boundary sequence.
    const runIp = `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.201`;
    // Purge any window left for this IP by an earlier run, then wait for the
    // bounded app's Redis to be reachable (readyz), so the whole boundary
    // sequence is counted by the same Redis window instead of the startup
    // fallback counter.
    const cleaner = new Redis(process.env.REDIS_URL as string);
    for (const key of await cleaner.keys(`rl:client-event:ip:${runIp}:*`)) {
      await cleaner.del(key);
    }
    const boundedApp = buildApp(configWith({ clientEventRateLimitPerIp: 2 }));
    try {
      for (let i = 0; i < 50; i += 1) {
        const ready = await boundedApp.inject({ method: "GET", url: "/readyz" });
        if (ready.statusCode === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let i = 0; i < 2; i += 1) {
        const accepted = await boundedApp.inject({
          method: "POST",
          url: "/client-events",
          remoteAddress: runIp,
          payload: observation({ activityId }),
        });
        expect(accepted.statusCode).toBe(200);
      }
      const limited = await boundedApp.inject({
        method: "POST",
        url: "/client-events",
        remoteAddress: runIp,
        payload: observation({ activityId }),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("request_limit");
    } finally {
      await boundedApp.close();
      cleaner.disconnect();
    }
  });

  it("keeps visitor links append-only for the application role", async () => {
    const visitorId = randomUUID();
    await establish(app, "Link Owner", { visitorId, channel: "web" });
    await withClient(appUrl, async (client) => {
      // A value-preserving UPDATE: the denial comes from the revoked
      // permission, not from any constraint on the new value.
      await expect(
        client.query("UPDATE visitor_identities SET channel = channel"),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM visitor_identities")).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
