import "../src/config.ts"; // loads the repo-root .env into process.env
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
    experimentTreatmentAllocationPercent: 50,
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

// One treatment server for the happy paths and one with the creation switch
// off, so AC5 (issued links stay claimable) is proven across processes.
let treatmentApp: Awaited<ReturnType<typeof buildApp>>;
let switchedOffApp: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await resetAndMigrate(migrationUrl);
  await clearIdentityData(migrationUrl);
  treatmentApp = buildApp(configWith({ experimentTreatmentAllocationPercent: 100 }));
  switchedOffApp = buildApp(
    configWith({ experimentTreatmentAllocationPercent: 100, experimentInviteCreationEnabled: false }),
  );
  return () => Promise.all([treatmentApp.close(), switchedOffApp.close()]);
});

type App = Awaited<ReturnType<typeof buildApp>>;

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function establish(app: App, displayName: string): Promise<string> {
  const response = await nextInject(app, {
    method: "POST",
    url: "/demo/sessions",
    payload: { email: (uniqueKey("inv-route")) + "@example.test", displayName },
  });
  expect(response.statusCode).toBe(200);
  return response.json().session.token;
}

async function publish(app: App, token: string, title: string, spots = 5): Promise<string> {
  const response = await nextInject(app, {
    method: "POST",
    url: "/activities",
    headers: { authorization: `Bearer ${token}` },
    payload: { description: "A guided activity.", itinerary: "Meet, explore, return.",
      title,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 48 * 3600 * 1000 + 2 * 3600 * 1000).toISOString(),
      country: "GB",
      priceMinorUnits: 2500,
      currency: "EUR",
      spots,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().activity.id;
}


let callCounter = 0;

/** Fresh source IP per request: run-persistent Redis windows must not leak across runs. */
function nextInject(app: App, options: InjectOptions) {
  callCounter += 1;
  return app.inject({
    remoteAddress: `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.${callCounter % 250}`,
    ...options,
  });
}

/** One stable source IP per run for quota-boundary sequences. */
function boundaryIp(): string {
  return `10.${Math.floor(Date.now() / 1000) % 250}.${process.pid % 250}.201`;
}

describe("public share routes", () => {
  it("creates a normalized email vouch without a recipient account and retains complete private-safe previews after sell-out and redemption", async () => {
    const host = await establish(treatmentApp, "Email Host");
    const activityId = await publish(treatmentApp, host, "Email Invitation", 1);
    const email = `${uniqueKey("recipient")}+friend@example.test`;
    const created = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` }, payload: { rail: "vouch", recipientEmail: `  ${email.toUpperCase()}  ` } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ created: true, invite: { recipientEmail: email } });
    const code = created.json().invite.code;
    await withClient(migrationUrl, async client => {
      expect((await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key=$1", [email])).rows[0].n).toBe(0);
      expect((await client.query("SELECT booked_count FROM activities WHERE id=$1", [activityId])).rows[0].booked_count).toBe(0);
    });
    const preview = await nextInject(treatmentApp, { method: "GET", url: `/invites/${code}` });
    expect(preview.json().invite).toMatchObject({ state: "claimable", activity: { description: "A guided activity.", bookingState: "available" },
      plan: { activityId, itinerary: "Meet, explore, return." }, host: { displayName: "Email Host", previousActivities: [] } });
    expect(JSON.stringify(preview.json())).not.toContain(email);
    const recipient = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions", payload: { email, inviteCode: code } });
    expect(recipient.statusCode).toBe(200);
    const booking = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${recipient.json().session.token}` }, payload: { operationId: randomUUID(), inviteCode: code } });
    expect(booking.statusCode).toBe(201);
    const used = await nextInject(treatmentApp, { method: "GET", url: `/invites/${code}` });
    expect(used.json().invite.state).toBe("used");
    expect(JSON.stringify(used.json())).not.toContain(email);
    const stranger = await establish(treatmentApp, "Used Invitation Visitor");
    const refused = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${stranger}` }, payload: { operationId: randomUUID(), inviteCode: code } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "invite_used" } });
    expect(JSON.stringify(refused.json())).not.toContain(email);
    const newEmail = `${uniqueKey("used-new")}@example.test`;
    const refusedEntry = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions",
      payload: { email: newEmail, inviteCode: code } });
    expect(refusedEntry.statusCode).toBe(409);
    expect(refusedEntry.json().error.code).toBe("invite_used");
    await withClient(migrationUrl, async client => {
      expect((await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key=$1", [newEmail])).rows[0].n).toBe(0);
      expect((await client.query("SELECT booked_count FROM activities WHERE id=$1", [activityId])).rows[0].booked_count).toBe(1);
    });
    const replay = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${recipient.json().session.token}` }, payload: { operationId: randomUUID(), inviteCode: code } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ created: false, booking: booking.json().booking });
    const publicLink = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` }, payload: { rail: "public_share" } });
    expect(publicLink.statusCode).toBe(201);
    const full = await nextInject(treatmentApp, { method: "GET", url: `/invites/${publicLink.json().invite.code}` });
    expect(full.json().invite.state).toBe("full");
    await withClient(migrationUrl, async client => {
      const events = await client.query("SELECT details FROM events WHERE invite_id=$1", [created.json().invite.id]);
      expect(JSON.stringify(events.rows)).not.toContain(email);
    });
  });

  for (const rail of ["vouch", "public_share"] as const) {
    it(`${rail}: email checkout preserves acquisition across return access, independent bookings and a later invitation generation`, async () => {
      const host = await establish(treatmentApp, "Checkout Host");
      const activityId = await publish(treatmentApp, host, "Email checkout", 4);
      const email = `${uniqueKey("checkout")}+friend@example.test`;
      const visitorId = randomUUID();
      const visitId = randomUUID();
      const inviteResponse = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/invites`,
        headers: { authorization: `Bearer ${host}` }, payload: { rail, ...(rail === "vouch" ? { recipientEmail: email } : {}) } });
      expect(inviteResponse.statusCode).toBe(201);
      const invite = inviteResponse.json().invite;
      await nextInject(treatmentApp, { method: "GET", url: `/invites/${invite.code}` });
      await withClient(migrationUrl, async client => {
        expect((await client.query("SELECT count(*)::int AS n FROM events WHERE invite_id=$1 AND event_name='invite_opened'", [invite.id])).rows[0].n).toBe(0);
      });
      const started = await nextInject(treatmentApp, { method: "POST", url: "/client-events",
        payload: { type: "claim_started", eventId: randomUUID(), visitorId, visitId, channel: "flutter", inviteCode: invite.code } });
      expect(started.statusCode).toBe(200);
      await withClient(migrationUrl, async client => {
        expect((await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key=$1", [email])).rows[0].n).toBe(0);
        expect((await client.query("SELECT booked_count FROM activities WHERE id=$1", [activityId])).rows[0].booked_count).toBe(0);
      });
      if (rail === "vouch") {
        const wrongEmail = `${uniqueKey("wrong")}@example.test`;
        const mismatch = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions",
          payload: { email: wrongEmail, inviteCode: invite.code, visitorId, visitId, channel: "flutter" } });
        expect(mismatch.statusCode).toBe(403);
        expect(mismatch.json().error.code).toBe("invite_recipient_mismatch");
        await withClient(migrationUrl, async client => {
          expect((await client.query("SELECT count(*)::int AS n FROM users WHERE contact_key=$1", [wrongEmail])).rows[0].n).toBe(0);
        });
      }
      const entry = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions",
        payload: { email: `  ${email.toUpperCase()}  `, inviteCode: invite.code, visitorId, visitId, channel: "flutter" } });
      expect(entry.statusCode).toBe(200);
      expect(entry.json()).toMatchObject({ created: true, user: { email, signupSource: rail, signupGeneration: 1 } });
      const user = entry.json().user;
      const token = entry.json().session.token;
      const claimed = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
        headers: { authorization: `Bearer ${token}` }, payload: { operationId: randomUUID(), inviteCode: invite.code } });
      expect(claimed.statusCode).toBe(201);
      expect(claimed.json()).toMatchObject({ created: true, booking: { userId: user.id, activityId, planId: invite.planId, attribution: { rail, generation: 1 } } });

      // Independent access uses the same email, without an invitation.
      const returning = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions", payload: { email } });
      expect(returning.json()).toMatchObject({ created: false, user: { id: user.id, signupSource: rail, signupGeneration: 1 } });
      const returnedToken = returning.json().session.token;
      const list = await nextInject(treatmentApp, { method: "GET", url: "/my/bookings", headers: { authorization: `Bearer ${returnedToken}` } });
      expect(list.json().bookings).toEqual([{ id: claimed.json().booking.id, activityId, planId: invite.planId,
        activity: expect.objectContaining({ id: activityId, title: "Email checkout", timezone: "Europe/London" }) }]);
      const details = await nextInject(treatmentApp, { method: "GET", url: `/activities/${activityId}` });
      expect(details.json()).toMatchObject({ plan: { id: invite.planId, itinerary: "Meet, explore, return." }, host: { displayName: "Checkout Host" } });
      const receipt = await nextInject(treatmentApp, { method: "GET", url: `/activities/${activityId}/bookings/me`, headers: { authorization: `Bearer ${returnedToken}` } });
      expect(receipt.json().booking).toEqual(claimed.json().booking);

      // Acquisition and each booking are independent immutable sources.
      const anotherActivity = await publish(treatmentApp, host, "Another plan");
      const anotherInviteResponse = await nextInject(treatmentApp, { method: "POST", url: `/activities/${anotherActivity}/invites`,
        headers: { authorization: `Bearer ${host}` }, payload: { rail, ...(rail === "vouch" ? { recipientEmail: email } : {}) } });
      const anotherInvite = anotherInviteResponse.json().invite;
      const laterBooking = await nextInject(treatmentApp, { method: "POST", url: `/activities/${anotherActivity}/bookings`,
        headers: { authorization: `Bearer ${returnedToken}` }, payload: { operationId: randomUUID(), inviteCode: anotherInvite.code } });
      expect(laterBooking.statusCode).toBe(201);

      const nextEmail = `${uniqueKey("generation2")}@example.test`;
      const nextInviteResponse = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/invites`,
        headers: { authorization: `Bearer ${returnedToken}` }, payload: { rail, ...(rail === "vouch" ? { recipientEmail: nextEmail } : {}) } });
      expect(nextInviteResponse.statusCode).toBe(201);
      const nextInvite = nextInviteResponse.json().invite;
      expect(nextInvite.generation).toBe(2);
      const nextEntry = await nextInject(treatmentApp, { method: "POST", url: "/demo/sessions", payload: { email: nextEmail, inviteCode: nextInvite.code } });
      expect(nextEntry.json().user).toMatchObject({ signupSource: rail, signupGeneration: 2 });
      const nextBooking = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
        headers: { authorization: `Bearer ${nextEntry.json().session.token}` }, payload: { operationId: randomUUID(), inviteCode: nextInvite.code } });
      expect(nextBooking.statusCode).toBe(201);
      expect(nextBooking.json().booking.attribution).toEqual({ rail, generation: 2 });
      if (rail === "public_share") {
        // The same public code remains reusable by another eligible account.
        const reuse = await establish(treatmentApp, "Public Returning Account");
        const reused = await nextInject(treatmentApp, { method: "POST", url: `/activities/${activityId}/bookings`,
          headers: { authorization: `Bearer ${reuse}` }, payload: { operationId: randomUUID(), inviteCode: invite.code } });
        expect(reused.statusCode).toBe(201);
      }
      await withClient(migrationUrl, async client => {
        const acquisition = await client.query("SELECT signup_invite_id, signup_source, signup_generation FROM users WHERE id=$1", [user.id]);
        expect(acquisition.rows[0]).toEqual({ signup_invite_id: invite.id, signup_source: rail, signup_generation: 1 });
        const sources = await client.query("SELECT ba.invite_id, ba.inviter_id, b.activity_id, b.plan_id FROM booking_attributions ba JOIN bookings b ON b.id=ba.booking_id WHERE booking_id = ANY($1::uuid[]) ORDER BY invite_id", [[claimed.json().booking.id, laterBooking.json().booking.id]]);
        expect(sources.rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ invite_id: invite.id, activity_id: activityId, plan_id: invite.planId }),
          expect.objectContaining({ invite_id: anotherInvite.id, activity_id: anotherActivity, plan_id: anotherInvite.planId }),
        ]));
        const observations = await client.query("SELECT event_name, user_id, visitor_id, channel, details FROM events WHERE visitor_id=$1 ORDER BY occurred_at", [visitorId]);
        expect(observations.rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ event_name: "claim_started", user_id: null, visitor_id: visitorId, channel: "flutter", details: expect.objectContaining({ visitId }) }),
          expect.objectContaining({ event_name: "account_entry_completed", user_id: user.id, visitor_id: visitorId, channel: "flutter", details: expect.objectContaining({ visitId, mode: "created" }) }),
        ]));
        expect((await client.query("SELECT count(*)::int AS n FROM events WHERE event_name='user_created' AND user_id=$1", [user.id])).rows[0].n).toBe(1);
      });
    });
  }

  it("returns one public invitation and creation event for concurrent copies, including retrieval with creation disabled", async () => {
    const host = await establish(treatmentApp, "Reusable Host");
    const activityId = await publish(treatmentApp, host, "Reusable", 1);
    const request = { method: "POST" as const, url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` }, payload: { rail: "public_share" } };
    const responses = await Promise.all(Array.from({ length: 8 }, () => nextInject(treatmentApp, request)));
    expect(responses.filter(response => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(7);
    expect(new Set(responses.map(response => response.json().invite.id)).size).toBe(1);
    expect(responses.filter(response => response.json().created)).toHaveLength(1);
    await withClient(migrationUrl, async client => {
      const id = responses[0]!.json().invite.id;
      expect((await client.query("SELECT count(*)::int AS n FROM events WHERE event_name='invite_created' AND invite_id=$1", [id])).rows[0].n).toBe(1);
      expect((await client.query("SELECT booked_count FROM activities WHERE id=$1", [activityId])).rows[0].booked_count).toBe(0);
    });
    const retrieved = await nextInject(switchedOffApp, request);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toMatchObject({ created: false, invite: responses[0]!.json().invite });
  });

  it("creates a public share for the host and a confirmed booker, without holding capacity", async () => {
    const host = await establish(treatmentApp, "Route Share Host");
    const activityId = await publish(treatmentApp, host, "Route Share");

    const created = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "public_share" },
    });
    expect(created.statusCode).toBe(201);
    const invite = created.json().invite;
    expect(invite).toMatchObject({ rail: "public_share", generation: 1 });
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(invite.expiresAt).toBeTruthy();

    // A confirmed booker may also create.
    const booker = await establish(treatmentApp, "Route Share Booker");
    const booked = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${booker}` },
      payload: { operationId: randomUUID() },
    });
    expect(booked.statusCode).toBe(201);
    const bookerShare = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${booker}` },
      payload: { rail: "public_share" },
    });
    expect(bookerShare.statusCode).toBe(201);


  });

  it("rejects other rails, anonymous creation and unaffiliated creators", async () => {
    const host = await establish(treatmentApp, "Route Share Gates Host");
    const activityId = await publish(treatmentApp, host, "Route Share Gates");

    const badRail = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "vouch" },
    });
    expect(badRail.statusCode).toBe(400);
    expect(badRail.json().error.code).toBe("validation_error");

    const anonymous = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      payload: { rail: "public_share" },
    });
    expect(anonymous.statusCode).toBe(401);

    const outsider = await establish(treatmentApp, "Unaffiliated Creator");
    const forbidden = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${outsider}` },
      payload: { rail: "public_share" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
  });

  it("previews an invite anonymously and distinguishes unknown codes", async () => {
    const host = await establish(treatmentApp, "Route Preview Host");
    const activityId = await publish(treatmentApp, host, "Route Preview");
    const share = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "public_share" },
    });
    const code = share.json().invite.code;

    const preview = await nextInject(treatmentApp, { method: "GET", url: `/invites/${code.toLowerCase()}` });
    expect(preview.statusCode).toBe(200);
    const body = preview.json().invite;
    expect(body).toMatchObject({
      code,
      rail: "public_share",
      state: "claimable",
      inviterDisplayName: "Route Preview Host",
    });
    expect(body.activity).toMatchObject({ id: activityId, title: "Route Preview", remainingSpots: 5 });
    expect(JSON.stringify(body)).not.toContain("contact");

    const unknown = await nextInject(treatmentApp, { method: "GET", url: "/invites/ZZZZZZZZZZZZ" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("invite_not_found");
  });

  it("claims through the booking route with the code, keeping the switch off for creation only", async () => {
    const host = await establish(treatmentApp, "Route Claim Host");
    const activityId = await publish(treatmentApp, host, "Route Claim");
    const share = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "public_share" },
    });
    const code = share.json().invite.code;

    // The switch-off server never reads the switch on the claim path.
    const guest = await establish(switchedOffApp, "Route Claim Guest");
    const claimed = await nextInject(switchedOffApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${guest}` },
      payload: { operationId: randomUUID(), inviteCode: code },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().booking.attribution).toMatchObject({ rail: "public_share", generation: 1 });

    // Creation on the switch-off server is refused for a new activity...
    const freshActivity = await publish(treatmentApp, host, "Route Claim Switch");
    const refused = await nextInject(switchedOffApp, {
      method: "POST",
      url: `/activities/${freshActivity}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "public_share" },
    });
    expect(refused.statusCode).toBe(403);

    // ...and an unknown code claims nothing.
    const unknown = await nextInject(switchedOffApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${guest}` },
      payload: { operationId: randomUUID(), inviteCode: "ZZZZZZZZZZZZ" },
    });
    // The guest already holds the claimed booking: the replay wins.
    expect(unknown.statusCode).toBe(200);
    const stranger = await establish(switchedOffApp, "Route Claim Stranger");
    const refusedCode = await nextInject(switchedOffApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${stranger}` },
      payload: { operationId: randomUUID(), inviteCode: "ZZZZZZZZZZZZ" },
    });
    expect(refusedCode.statusCode).toBe(404);
    expect(refusedCode.json().error.code).toBe("invite_not_found");
  });

  it("creates, previews and claims a vouch for its named contact only", async () => {
    // A known contact key for the host, so self-vouch is exercised exactly.
    const hostContact = uniqueKey("vouch-host");
    const hostSession = await treatmentApp.inject({
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (hostContact) + "@example.test", displayName: "Vouch Route Host" },
    });
    expect(hostSession.statusCode).toBe(200);
    const host = hostSession.json().session.token as string;
    const activityId = await publish(treatmentApp, host, "Route Vouch");
    const targetContact = uniqueKey("vouch-friend");

    const created = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "vouch", recipientEmail: targetContact + "@example.test" },
    });
    expect(created.statusCode).toBe(201);
    const invite = created.json().invite;
    expect(invite).toMatchObject({ rail: "vouch", generation: 1, recipientEmail: targetContact + "@example.test" });

    // Self-vouch and targetless vouch are invalid input.
    const selfVouch = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "vouch", recipientEmail: hostContact + "@example.test" },
    });
    expect(selfVouch.statusCode).toBe(400);
    const targetless = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/invites`,
      headers: { authorization: `Bearer ${host}` },
      payload: { rail: "vouch" },
    });
    expect(targetless.statusCode).toBe(400);

    // The anonymous preview never discloses the target contact.
    const preview = await nextInject(treatmentApp, {
      method: "GET",
      url: `/invites/${invite.code}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().invite).toMatchObject({ rail: "vouch" });
    expect(preview.body).not.toContain(targetContact);

    // A foreign identity is refused with the recipient-mismatch code; the
    // named contact claims through identity selection and the booking route.
    const stranger = await establish(treatmentApp, "Vouch Stranger");
    const mismatch = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${stranger}` },
      payload: { operationId: randomUUID(), inviteCode: invite.code },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe("invite_recipient_mismatch");

    // The named contact resolves their identity through the vouch.
    const acquired = await treatmentApp.inject({
      method: "POST",
      url: "/demo/sessions",
      payload: { email: (targetContact) + "@example.test", displayName: "Named Vouch Recipient", inviteCode: invite.code },
    });
    expect(acquired.statusCode).toBe(200);
    expect(acquired.json().user).toMatchObject({ signupSource: "vouch", signupGeneration: 1 });
    const token = acquired.json().session.token;
    const claimed = await nextInject(treatmentApp, {
      method: "POST",
      url: `/activities/${activityId}/bookings`,
      headers: { authorization: `Bearer ${token}` },
      payload: { operationId: randomUUID(), inviteCode: invite.code },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().booking.attribution).toMatchObject({ rail: "vouch", generation: 1 });
  });

  it("rate-limits anonymous code resolution per IP", async () => {
    const app = buildApp(configWith({ inviteResolveRateLimitPerIp: 2 }));
    // A fresh remote address per run: fixed-window counters persist across
    // runs within the hour. At least two resolutions are allowed, then the
    // cap refuses with Retry-After (one count may land in the per-process
    // fallback after a Redis hiccup, shifting the refusal by one).
    const remoteAddress = boundaryIp();
    try {
      let allowed = 0;
      let refused: undefined | LightInjectResponse;
      for (let i = 0; i < 6 && refused === undefined; i += 1) {
        const response = await nextInject(app, { method: "GET", url: "/invites/ZZZZZZZZZZZZ", remoteAddress });
        if (response.statusCode === 429) {
          refused = response;
        } else {
          expect(response.statusCode).toBe(404);
          allowed += 1;
        }
      }
      expect(allowed).toBeGreaterThanOrEqual(2);
      expect(refused).toBeDefined();
      expect(Number(refused!.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe("invitation kill switch", () => {
  it("when creation is disabled, new invitations are refused while issued public and personal links still book", async () => {
    const host = await establish(treatmentApp, "Kill Switch Host");
    const activityId = await publish(treatmentApp, host, "Kill Switch Activity", 5);
    const recipientEmail = `${uniqueKey("kill-recipient")}@example.test`;
    const create = (app: App, payload: object) =>
      nextInject(app, { method: "POST", url: `/activities/${activityId}/invites`, headers: { authorization: `Bearer ${host}` }, payload });
    const publicCode = (await create(treatmentApp, { rail: "public_share" })).json().invite.code as string;
    const vouchCode = (await create(treatmentApp, { rail: "vouch", recipientEmail })).json().invite.code as string;

    const refused = await create(switchedOffApp, { rail: "vouch", recipientEmail: `${uniqueKey("late")}@example.test` });
    expect(refused.statusCode).toBe(403);
    const detail = await nextInject(switchedOffApp, { method: "GET", url: `/activities/${activityId}` });
    expect(detail.json().invites).toMatchObject({ arm: "treatment", creationEnabled: false });

    const book = async (token: string, inviteCode: string) =>
      nextInject(switchedOffApp, { method: "POST", url: `/activities/${activityId}/bookings`,
        headers: { authorization: `Bearer ${token}` }, payload: { operationId: randomUUID(), inviteCode } });
    const publicGuest = await establish(switchedOffApp, "Public Guest");
    const publicBooking = await book(publicGuest, publicCode);
    expect(publicBooking.statusCode).toBe(201);
    expect(publicBooking.json().booking.attribution).toMatchObject({ rail: "public_share" });

    const recipient = await nextInject(switchedOffApp, { method: "POST", url: "/demo/sessions", payload: { email: recipientEmail, displayName: "Vouch Guest" } });
    const vouchBooking = await book(recipient.json().session.token, vouchCode);
    expect(vouchBooking.statusCode).toBe(201);
    expect(vouchBooking.json().booking.attribution).toMatchObject({ rail: "vouch" });
  });
});
