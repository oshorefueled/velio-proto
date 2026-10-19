import { expect, it } from "vitest";
import { ApiError, VelioApi } from "./api.js";


it("when activity detail includes sibling invite capabilities, getActivity preserves them beside the activity", async () => {
  const api = new VelioApi(async () => ({
    status: 200,
    json: {
      activity: { id: "activity-a", title: "Evening walk" },
      invites: { eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1" },
    },
  }));
  const detail = await api.getActivity("activity-a");
  expect(detail.activity.id).toBe("activity-a");
  expect(detail.invites).toEqual({
    eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1",
  });
});

it("when the public list answers with its activities envelope, listActivities exposes the activities", async () => {
  const api = new VelioApi(async () => ({
    status: 200,
    json: { activities: [{ id: "activity-a", title: "Evening walk", remainingSpots: 3 }] },
  }));
  const activities = await api.listActivities();
  expect(activities).toEqual([
    { id: "activity-a", title: "Evening walk", remainingSpots: 3 },
  ]);
});

it("when a new booking answers its saved-booking envelope, bookActivity exposes booking, created, attemptId and version", async () => {
  const api = new VelioApi(async () => ({
    status: 201,
    json: {
      booking: {
        id: "booking-1", activityId: "activity-a", planId: "plan-a", userId: "booker",
        createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "direct", generation: 0 },
      },
      created: true,
      attemptId: "attempt-1",
      availabilityVersion: "7",
    },
  }));
  const result = await api.bookActivity("booker-token", "activity-a", "op-1");
  expect(result.created).toBe(true);
  expect(result.attemptId).toBe("attempt-1");
  expect(result.availabilityVersion).toBe("7");
  expect(result.booking).toEqual({
    id: "booking-1", activityId: "activity-a", planId: "plan-a", userId: "booker",
    createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "direct", generation: 0 },
  });
});

it("when the saved-booking lookup answers its booking envelope, getMyBooking exposes the booking; contractual absence is a booking_not_found error", async () => {
  const saved = new VelioApi(async () => ({
    status: 200,
    json: {
      booking: {
        id: "booking-1", activityId: "activity-a", planId: "plan-a", userId: "booker",
        createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
      },
    },
  }));
  const booking = await saved.getMyBooking("booker-token", "activity-a");
  expect(booking.id).toBe("booking-1");
  expect(booking.attribution).toEqual({ rail: "public_share", generation: 2 });

  const absent = new VelioApi(async () => ({
    status: 404,
    json: { error: { code: "booking_not_found", message: "No saved membership" } },
  }));
  const err = await absent.getMyBooking("booker-token", "activity-a").then(
    () => null,
    (error) => error,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("booking_not_found");
  expect(err.status).toBe(404);
});

it("when a request limit carries Retry-After, the error exposes the retry delay", async () => {
  const api = new VelioApi(async () => ({
    status: 429,
    json: { error: { code: "request_limit", message: "Too many attempts" } },
    headers: { "retry-after": "17" },
  }));
  const err = await api.bookActivity("booker-token", "activity-a", "op-1").then(
    () => null,
    (error) => error,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("request_limit");
  expect(err.retryAfterSeconds).toBe(17);
});

it("when invite creation answers its saved-invite envelope, createInvite exposes the invite with its vouched contact", async () => {
  let capturedBody: unknown;
  const api = new VelioApi(async (_url, init) => {
    capturedBody = init.body;
    return {
      status: 201,
      json: {
        invite: {
          id: "invite-1",
          code: "0ABCDEFHJKM2",
          rail: "vouch",
          generation: 2,
          activityId: "activity-a",
          planId: "plan-a",
          expiresAt: "2026-12-01T18:00:00Z",
          createdAt: "2026-10-18T21:00:00Z",
          targetContactKey: "t16-friend",
        },
      },
    };
  });
  const invite = await api.createInvite("host-token", "activity-a", {
    rail: "vouch",
    targetContactKey: "t16-friend",
  });
  expect(capturedBody).toBe(
    JSON.stringify({ rail: "vouch", targetContactKey: "t16-friend" }),
  );
  expect(invite.code).toBe("0ABCDEFHJKM2");
  expect(invite.rail).toBe("vouch");
  expect(invite.targetContactKey).toBe("t16-friend");
  expect(invite.activityId).toBe("activity-a");
});

it("when a share interaction is recorded, the client-events body matches the documented invite_share_action shape", async () => {
  let capturedBody: unknown;
  const api = new VelioApi(async (_url, init) => {
    capturedBody = init.body;
    return { status: 200, json: { event: { eventId: "event-1", type: "invite_share_action", status: "accepted" } } };
  });
  await api.emitInviteShareAction({
    eventId: "event-1",
    visitorId: "visitor-1",
    inviteCode: "0ABCDEFHJKM2",
    shareMethod: "copy",
    token: "booker-token",
  });
  expect(capturedBody).toBe(
    JSON.stringify({
      type: "invite_share_action",
      eventId: "event-1",
      visitorId: "visitor-1",
      channel: "web",
      inviteCode: "0ABCDEFHJKM2",
      shareMethod: "copy",
    }),
  );
});

it("when a public code resolves, resolveInvite exposes the literal public preview without any target contact", async () => {
  const api = new VelioApi(async (url) => {
    expect(url).toBe("/api/invites/8WKWE7DG82VR");
    return {
      status: 200,
      json: {
        invite: {
          code: "8WKWE7DG82VR",
          rail: "public_share",
          generation: 2,
          state: "claimable",
          expiresAt: "2026-12-01T18:00:00Z",
          inviterDisplayName: "T16 Booker",
          activity: {
            id: "activity-a",
            title: "Evening walk",
            startsAt: "2026-12-01T18:00:00Z",
            timezone: "Europe/Stockholm",
            priceMinorUnits: 1200,
            currency: "EUR",
            capacity: 2,
            bookedCount: 1,
            remainingSpots: 1,
            availabilityVersion: "4",
          },
        },
      },
    };
  });
  const preview = await api.resolveInvite("8WKWE7DG82VR");
  expect(preview.state).toBe("claimable");
  expect(preview.rail).toBe("public_share");
  expect(preview.inviterDisplayName).toBe("T16 Booker");
  expect(preview.activity.remainingSpots).toBe(1);
  expect((preview as unknown as Record<string, unknown>).targetContactKey).toBeUndefined();
});

it("when a claim carries an invite code, the booking body includes it; a direct booking body stays exact", async () => {
  const bodies: string[] = [];
  const api = new VelioApi(async (_url, init) => {
    bodies.push(init.body ?? "");
    return {
      status: 201,
      json: {
        booking: {
          id: "booking-1", activityId: "activity-a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
        created: true, attemptId: "attempt-1", availabilityVersion: "5",
      },
    };
  });
  await api.bookActivity("guest-token", "activity-a", "op-invited", undefined, "8WKWE7DG82VR");
  await api.bookActivity("guest-token", "activity-a", "op-direct");
  expect(bodies).toEqual([
    JSON.stringify({ operationId: "op-invited", inviteCode: "8WKWE7DG82VR" }),
    JSON.stringify({ operationId: "op-direct" }),
  ]);
});

it("when a resolved landing is displayed and a claim is deliberate, the opened and claim_started bodies match the contract", async () => {
  const bodies: string[] = [];
  const api = new VelioApi(async (_url, init) => {
    bodies.push(init.body ?? "");
    return { status: 200, json: { event: { eventId: "e", type: "x", status: "accepted" } } };
  });
  await api.emitInviteOpened({
    eventId: "opened-1",
    visitorId: "visitor-1",
    inviteCode: "8WKWE7DG82VR",
    outcome: "available",
  });
  await api.emitClaimStarted({
    eventId: "claim-1",
    visitorId: "visitor-1",
    inviteCode: "8WKWE7DG82VR",
    token: "guest-token",
  });
  expect(JSON.parse(bodies[0]!)).toEqual({
    type: "invite_opened",
    eventId: "opened-1",
    visitorId: "visitor-1",
    channel: "web",
    inviteCode: "8WKWE7DG82VR",
    outcome: "available",
  });
  expect(JSON.parse(bodies[1]!)).toEqual({
    type: "claim_started",
    eventId: "claim-1",
    visitorId: "visitor-1",
    channel: "web",
    inviteCode: "8WKWE7DG82VR",
  });
});

it("when identity selection carries an invitation, the session body forwards it unchanged", async () => {
  let capturedBody: unknown;
  const api = new VelioApi(async (_url, init) => {
    capturedBody = init.body;
    return {
      status: 200,
      json: {
        session: { token: "t", expiresAt: "2027-01-01" },
        user: { id: "u", email: "c", displayName: "C", signupSource: "public_share", signupGeneration: 2 },
        created: true,
      },
    };
  });
  await api.establishSession({ email: "guest", inviteCode: "8WKWE7DG82VR", visitorId: "v-1", channel: "web" });
  expect(JSON.parse(capturedBody as string)).toEqual({
    email: "guest",
    inviteCode: "8WKWE7DG82VR",
    visitorId: "v-1",
    channel: "web",
  });
});
