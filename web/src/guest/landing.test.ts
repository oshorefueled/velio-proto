// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";

/**
 * Rendered invitation landing checks (issue #17): anonymous preview before
 * identity with documented opened outcomes only, recipient privacy, invited
 * claims through the shared booking controller (stable operation + code,
 * reconciliation before retry), existing-booking precedence over unusable
 * invites, and late-result ownership across code switches. Wire envelopes
 * live in api.test.ts.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The live availability owner (issue #18) binds on visible surfaces; unless a
// test opens a scripted socket, it stays dormant and sends no traffic.
class ScriptedLiveSocket {
  static instances: Array<{
    sent: string[];
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send: (data: string) => void;
    close: () => void;
    open: () => void;
    receive: (frame: unknown) => void;
  }> = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    ScriptedLiveSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
vi.stubGlobal("WebSocket", ScriptedLiveSocket);

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const guestUser = {
  id: "guest",
  displayName: "Guest",
  contactKey: "guest",
  signupSource: "public_share",
  signupGeneration: 2,
};
function ok(json: unknown, status = 200): { status: number; json: unknown } {
  return { status, json };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}
async function mount(transport: Transport, { session = null as typeof guestUser | null, invite = "8WKWE7DG82VR" } = {}) {
  if (root) await act(() => root!.unmount());
  if (session) {
    localStorage.setItem("velio.session.v1", JSON.stringify({ token: `${session.id}-token`, user: session }));
  }
  window.history.replaceState(null, "", `/?invite=${invite}`);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root!.render(createElement(SessionProvider, { transport, children: createElement(App) })),
  );
  await settle();
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function fillContact(key: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[name="email"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, key);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
type PreviewOverride = Partial<{
  state: "claimable" | "expired" | "full" | "used";
  rail: "public_share" | "vouch";
  remainingSpots: number;
  inviterDisplayName: string;
}>;
function previewFixture(code: string, over: PreviewOverride = {}) {
  return {
    code,
    rail: over.rail ?? "public_share",
    generation: 2,
    state: over.state ?? "claimable",
    expiresAt: "2026-12-01T18:00:00Z",
    inviterDisplayName: over.inviterDisplayName ?? "Inviter Name",
    plan: { id: "p", activityId: "a", itinerary: "Meet at the gate, then walk together." },
    host: { id: "host", displayName: "Walk Host", summary: "Local guide", previousActivities: [] },
    activity: {
      id: "a",
      title: "Evening walk",
      description: "Explore the city at sunset.",
      startsAt: "2026-12-01T18:00:00Z",
      timezone: "Europe/Stockholm",
      priceMinorUnits: 1200,
      currency: "EUR",
      capacity: 2,
      bookedCount: 1,
      remainingSpots: over.remainingSpots ?? 1,
      availabilityVersion: "4",
    },
  };
}
function landingTransport(over: {
  preview?: { status: number; json: unknown };
  booking?:
    | ((url: string, init: { method: string; body?: string }) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>);
  events?: string[];
  bookingPosts?: string[];
  sessionBodies?: string[];
  bookingsMe?:
    | { status: number; json: unknown }
    | ((url: string, init: { method: string; body?: string }) => { status: number; json: unknown });
} = {}) {
  return async (url: string, init: { method: string; body?: string }) => {
    if (url.endsWith("/client-events")) {
      if (JSON.parse(init.body!).type !== "activity_viewed") over.events?.push(init.body ?? "");
      return ok({});
    }
    if (url.includes("/bookings") && init.method === "POST") {
      over.bookingPosts?.push(init.body ?? "");
      if (over.booking) return over.booking(url, init);
      return ok({
        booking: {
          id: "booking-guest", activityId: "a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
        created: true, attemptId: "attempt-1", availabilityVersion: "5",
      });
    }
    if (url.endsWith("/bookings/me")) {
      const me = over.bookingsMe;
      if (typeof me === "function") return me(url, init);
      return me ?? ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    }
    if (url.endsWith("/demo/sessions")) {
      over.sessionBodies?.push(init.body ?? "");
      return ok({
        session: { token: "guest-token", expiresAt: "2027-01-01" },
        user: guestUser,
        created: true,
      });
    }
    if (url.includes("/invites/")) {
      return over.preview ?? ok({ invite: previewFixture("8WKWE7DG82VR") });
    }
    if (url.includes("/activities/a"))
      return ok({ activity: { id: "a", title: "Evening walk", planId: "plan-a" }, invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    return ok({});
  };
}

it("when an anonymous visitor opens a claimable invite, the facts show before identity, the open is recorded, and no booking is sent", async () => {
  const events: string[] = [];
  await mount(landingTransport({ events }));
  const body = document.body.textContent ?? "";
  expect(body).toContain("Evening walk");
  expect(body).toContain("Inviter Name");
  expect(body).toContain("Public link — anyone can book while spots remain");
  expect(body).toContain("1 booked · 1 remaining of 2");
  expect(body).toContain("Sign in to continue");
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!)).toEqual({
    type: "invite_opened",
    eventId: JSON.parse(events[0]!).eventId,
    visitorId: JSON.parse(events[0]!).visitorId,
    channel: "web",
    visitId: expect.any(String),
    inviteCode: "8WKWE7DG82VR",
    outcome: "available",
  });
  await click("Sign in to continue");
  await fillContact("guest");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(document.body.textContent).toContain("Claim your spot");
});

it("when a vouch is previewed, no target contact is disclosed anywhere", async () => {
  await mount(landingTransport({ preview: ok({ invite: previewFixture("V", { rail: "vouch" }) }) }), { invite: "V" });
  const body = document.body.textContent ?? "";
  expect(body).toContain("Personal invitation — use the email that was invited");
  expect(body).not.toContain("target");
  expect(document.body.innerHTML).not.toContain("secret-contact");
});

it("when a code is unknown, the explanation keeps the code path; a failing preview keeps availability unknown", async () => {
  const events: string[] = [];
  await mount(landingTransport({ preview: ok({ error: { code: "invite_not_found", message: "Unknown code" } }, 404), events }), {
    invite: "BADCODE1",
  });
  const body = document.body.textContent ?? "";
  expect(body).toContain("Invitation not recognized");
  expect(body).toContain("unknown from here");
  expect(events).toHaveLength(0);
  let failing = true;
  await mount(async (url) => {
    if (url.includes("/invites/")) {
      if (failing) throw new TypeError("network down");
      return ok({ invite: previewFixture("BADCODE1") });
    }
    return ok({ activities: [] });
  }, { invite: "BADCODE1" });
  expect(document.body.textContent).toContain("Facts are unknown, not zero");
  failing = false;
  await click("Retry");
  await settle();
  expect(document.body.textContent).toContain("Evening walk");
});

it("when a claim is created through identity selection, the invitation travels to the session and booking and the receipt shows the invited source", async () => {
  const events: string[] = [];
  const bookingPosts: string[] = [];
  const sessionBodies: string[] = [];
  await mount(landingTransport({ events, bookingPosts, sessionBodies }), { session: null });
  await click("Sign in to continue");
  await fillContact("guest");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(JSON.parse(sessionBodies[0]!).inviteCode).toBe("8WKWE7DG82VR");
  await click("Claim your spot");
  await settle();
  expect(JSON.parse(bookingPosts[0]!)).toEqual({ operationId: expect.any(String), inviteCode: "8WKWE7DG82VR" });
  expect(bookingPosts).toHaveLength(1);
  const claimEvents = events.map((e) => JSON.parse(e).type);
  expect(claimEvents).toContain("claim_started");
  const body = document.body.textContent ?? "";
  expect(body).toContain("Your spot is saved");
  expect(body).toContain("booking-guest");
  expect(body).not.toContain("generation 2");
});

it("when a pending claim is in flight, submit stays disabled and a second click sends no second request", async () => {
  const bookingPosts: string[] = [];
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    landingTransport({
      bookingPosts,
      booking: () => pending.promise,
    }),
  );
  await click("Sign in to continue");
  await fillContact("guest");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  await click("Claim your spot");
  const claiming = [...document.querySelectorAll("button")].find((b) => b.textContent === "Claiming…");
  expect(claiming).toBeDefined();
  expect(claiming!.disabled).toBe(true);
  await act(async () => claiming!.click());
  expect(bookingPosts).toHaveLength(1);
  await act(async () =>
    pending.resolve(
      ok({
        booking: {
          id: "booking-guest", activityId: "a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
        created: true, attemptId: "a1", availabilityVersion: "5",
      }),
    ),
  );
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  expect(bookingPosts).toHaveLength(1);
});

it("when the invite has expired but the visitor already holds the booking, the saved receipt wins", async () => {
  const events: string[] = [];
  const bookingPosts: string[] = [];
  await mount(
    landingTransport({
      preview: ok({ invite: previewFixture("8WKWE7DG82VR", { state: "expired" }) }),
      events,
      bookingPosts,
      bookingsMe: ok({
        booking: {
          id: "booking-guest", activityId: "a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
      }),
    }),
    { session: guestUser },
  );
  const body = document.body.textContent ?? "";
  expect(body).toContain("Booking is closed because this invitation has expired.");
  expect(body).toContain("Your spot is saved");
  expect(body).toContain("booking-guest");
  const opened = events.map((e) => JSON.parse(e));
  expect(opened).toHaveLength(1);
  expect(opened[0]!.outcome).toBe("expired");
  expect(bookingPosts).toHaveLength(0);
});

it("when a claim response is lost, the saved-booking lookup confirms; an unreachable lookup stays unknown and blocks another POST", async () => {
  const bookingPosts: string[] = [];
  let posted = false;
  let lookupFails = true;
  const transport = landingTransport({
    bookingPosts,
    booking: () => {
      posted = true;
      return ok({ error: { code: "booking_outcome_unknown", message: "Lost after commit" } }, 500);
    },
    bookingsMe: () => {
      if (posted && lookupFails) throw new TypeError("lookup down");
      if (posted) {
        return ok({
          booking: {
            id: "booking-guest", activityId: "a", planId: "plan-a", userId: "guest",
            createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
          },
        });
      }
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    },
  });
  await mount(transport, { session: guestUser });
  await settle();
  await click("Claim your spot");
  await settle();
  // The POST reached the server but the response was lost, and the lookup
  // failed: unknown, never a fabricated receipt.
  let body = document.body.textContent ?? "";
  expect(body).toContain("Check again");
  expect(body).not.toContain("Your spot is saved");
  lookupFails = false; // the next lookup now succeeds and finds the saved booking
  await click("Check again");
  await settle();
  body = document.body.textContent ?? "";
  expect(body).toContain("Your spot is saved");
  expect(bookingPosts).toHaveLength(1);
});

it("when a claim attempt fails before dispatch, a remount keeps the SAME operation id and invite code for the explicit retry", async () => {
  const bookingPosts: string[] = [];
  let bookingFails = true;
  const transport = landingTransport({
    bookingPosts,
    booking: () => {
      if (bookingFails) throw new TypeError("network unreachable");
      return ok({
        booking: {
          id: "booking-guest", activityId: "a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
        created: true, attemptId: "a1", availabilityVersion: "5",
      });
    },
    // Nothing ever reached the server: reconciliation finds no saved booking.
    bookingsMe: () => ok({ error: { code: "booking_not_found", message: "none" } }, 404),
  });
  await mount(transport, { session: guestUser });
  await click("Claim your spot");
  await settle();
  expect(document.body.textContent).toContain("nothing was reserved");
  // Remount the whole route: the operation context must persist.
  if (root) await act(() => root!.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root!.render(createElement(SessionProvider, { transport, children: createElement(App) })),
  );
  await settle();
  bookingFails = false;
  await click("Claim your spot");
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  expect(bookingPosts).toHaveLength(2);
  const first = JSON.parse(bookingPosts[0]!);
  const second = JSON.parse(bookingPosts[1]!);
  expect(second.operationId).toBe(first.operationId);
  expect(second.inviteCode).toBe("8WKWE7DG82VR");
});

it("when the browser navigates to another code, an in-flight claim cannot attach to the new landing", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    async (url, init) => {
      if (url.includes("/invites/BBBB")) return ok({ invite: previewFixture("BBBB") });
      if (url.includes("/bookings") && init.method === "POST") return pending.promise;
      return landingTransport({})(url, init);
    },
    { session: guestUser, invite: "8WKWE7DG82VR" },
  );
  await click("Claim your spot");
  window.history.replaceState(null, "", "/?invite=BBBB");
  await act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await settle();
  expect(document.body.textContent).toContain("Evening walk");
  await act(async () =>
    pending.resolve(
      ok({
        booking: {
          id: "booking-old", activityId: "a", planId: "plan-a", userId: "guest",
          createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "public_share", generation: 2 },
        },
        created: true, attemptId: "a1", availabilityVersion: "5",
      }),
    ),
  );
  await settle();
  expect(document.body.textContent).not.toContain("Your spot is saved");
});

it("when a late 401 arrives after the route moved on, the current session is not expired", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    async (url, init) => {
      if (url.includes("/invites/BBBB")) return ok({ invite: previewFixture("BBBB") });
      if (url.includes("/bookings") && init.method === "POST") return pending.promise;
      return landingTransport({})(url, init);
    },
    { session: guestUser, invite: "8WKWE7DG82VR" },
  );
  await click("Claim your spot");
  window.history.replaceState(null, "", "/?invite=BBBB");
  await act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await settle();
  await act(async () =>
    pending.resolve(ok({ error: { code: "session_expired", message: "Old session expired" } }, 401)),
  );
  await settle();
  const body = document.body.textContent ?? "";
  expect(body).toContain("Guest");
  expect(body).not.toContain("Your session expired");
});

it("when a claim hits a vouch meant for another contact, the reason explains without disclosing the recipient", async () => {
  await mount(
    landingTransport({
      booking: () => ok({ error: { code: "invite_recipient_mismatch", message: "Vouched for a different contact" } }, 403),
      preview: ok({ invite: previewFixture("VVVOUCH12", { rail: "vouch" }) }),
    }),
    { session: guestUser, invite: "VVVOUCH12" },
  );
  await click("Claim your spot");
  await settle();
  const body = document.body.textContent ?? "";
  expect(body).toContain("vouched for a different contact");
  expect(body).toContain("Sign out");
  expect(document.body.innerHTML).not.toContain("secret-contact");
});

it("when a used vouch is displayed, its useful facts remain and a used opening is recorded", async () => {
  const events: string[] = [];
  await mount(landingTransport({ preview: ok({ invite: previewFixture("8WKWE7DG82VR", { state: "used" }) }), events }), {
    session: guestUser,
  });
  const body = document.body.textContent ?? "";
  expect(body).toContain("This personal invitation has already been used");
  expect(body).not.toContain("Claim your spot");
  expect(events.map(raw => JSON.parse(raw).outcome)).toEqual(["used"]);
});

it("when the displayed invitation account changes, a new activity observation uses a distinct event ID", async () => {
  const views: unknown[] = [];
  const base = landingTransport();
  await mount(async (url, init) => {
    if (url.endsWith("/client-events") && JSON.parse(init.body!).type === "activity_viewed") {
      expect(document.querySelector(".invite-landing h2")?.textContent).toBe("Evening walk");
      views.push(JSON.parse(init.body!));
    }
    return base(url, init);
  });
  expect(views).toHaveLength(1);
  await click("Sign in to continue");
  await fillContact("guest");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(views).toHaveLength(2);
  expect(new Set(views.map(raw => (raw as { eventId: string }).eventId)).size).toBe(2);
});

it("when an uncertain claim reopens with another code, retry retains its original invite", async () => {
  const posts: string[] = [];
  let posted = false;
  let reachable = false;
  const base = landingTransport({ bookingPosts: posts, booking: () => { posted = true; throw new TypeError("lost"); }, bookingsMe: () => {
    if (posted && !reachable) throw new TypeError("offline");
    return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
  } });
  const transport: Transport = async (url, init) => url.includes("/invites/BBBB") ? ok({ invite: previewFixture("BBBB") }) : base(url, init);
  await mount(transport, { session: guestUser });
  await click("Claim your spot");
  await settle();
  expect(document.body.textContent).toContain("Check again");
  reachable = true;
  await mount(transport, { session: guestUser, invite: "BBBB" });
  await click("Claim your spot");
  await settle();
  expect(posts).toHaveLength(2);
  expect(JSON.parse(posts[1]!).inviteCode).toBe(JSON.parse(posts[0]!).inviteCode);
});

it("when a failed claim reconciles absent, retry waits for a fresh invite preview", async () => {
  const refresh = deferred<{ status: number; json: unknown }>();
  let previews = 0;
  const posts: string[] = [];
  const base = landingTransport({ bookingPosts: posts, booking: () => { throw new TypeError("lost"); } });
  await mount(async (url, init) => {
    if (url.includes("/invites/") && ++previews > 1) return refresh.promise;
    return base(url, init);
  }, { session: guestUser });
  await click("Claim your spot");
  await settle();
  const retry = [...document.querySelectorAll(".invite-landing button")].find((b) => b.textContent?.includes("Claiming is unavailable")) as HTMLButtonElement;
  expect(retry?.disabled).toBe(true);
  await act(async () => refresh.resolve(ok({ invite: previewFixture("8WKWE7DG82VR", { state: "full", remainingSpots: 0 }) })));
  await settle();
  expect(document.querySelector(".invite-landing")?.textContent).toContain("activity is full");
  expect(posts).toHaveLength(1);
});

it("when identity selection is pending and the invite changes, the late identity cannot attach to the new invite", async () => {
  const identity = deferred<{ status: number; json: unknown }>();
  const base = landingTransport();
  await mount(async (url, init) => {
    if (url.endsWith("/demo/sessions")) return identity.promise;
    if (url.includes("/invites/BBBB")) return ok({ invite: previewFixture("BBBB") });
    return base(url, init);
  });
  await click("Sign in to continue");
  await fillContact("guest");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  window.history.replaceState(null, "", "/?invite=BBBB");
  await act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await settle();
  await act(async () => identity.resolve(ok({ session: { token: "old-token", expiresAt: "2027-01-01" }, user: guestUser, created: true })));
  await settle();
  expect(document.querySelector(".invite-landing")?.textContent).toContain("Sign in to continue");
  expect(localStorage.getItem("velio.session.v1")).toBeNull();
});

it("when a claim is rate limited, retry remains disabled until Retry-After elapses", async () => {
  vi.useFakeTimers();
  let posts = 0;
  const base = landingTransport();
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      posts += 1;
      return { status: 429, json: { error: { code: "request_limit", message: "wait" } }, headers: { "retry-after": "2" } };
    }
    return base(url, init);
  }, { session: guestUser });
  await click("Claim your spot");
  await settle();
  const retry = [...document.querySelectorAll<HTMLButtonElement>(".invite-landing button")].find(b => b.textContent === "Try claiming again");
  expect(retry).toBeDefined();
  expect(retry!.disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(retry!.disabled).toBe(false);
  expect(posts).toBe(1);
});

it("when a live frame is newer on an expired invitation, the activity facts update while the invitation stays unusable", async () => {
  ScriptedLiveSocket.instances.length = 0;
  const acks: Array<Record<string, unknown>> = [];
  await mount(async (url, init) => {
    if (url.endsWith("/availability-acks")) {
      acks.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return ok({ ack: {} });
    }
    if (url.includes("/invites/")) {
      return ok({ invite: previewFixture("8WKWE7DG82VR", { state: "expired", remainingSpots: 0 }) });
    }
    if (url.includes("/activities/a")) {
      return ok({ activity: { id: "a", availabilityVersion: "4", remainingSpots: 0, capacity: 2 }, invites: {} });
    }
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.endsWith("/activities")) return ok({ activities: [] });
    return ok({});
  }, { session: guestUser });
  expect(document.body.textContent).toContain("this invitation has expired");
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () =>
    socket.receive({ type: "measurement_registered", connectionId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" }),
  );
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  expect(acks).toHaveLength(0);
  await act(async () =>
    socket.receive({ type: "availability", activityId: "a", version: "6", remainingSpots: 1, eventId: null }),
  );
  await settle();
  expect(document.body.textContent).toContain("1 booked · 1 remaining of 2");
  expect(document.body.textContent).toContain("this invitation has expired");
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Claim your spot")).toBe(false);
  expect(acks).toHaveLength(1);
  expect(acks[0]).toMatchObject({ appliedVersion: "6", source: "websocket" });
});


it("when an unknown invitation code is corrected, its recognized preview renders before one available opening is recorded", async () => {
  const events: string[] = [];
  const base = landingTransport({ events });
  await mount(async (url, init) => {
    if (url.endsWith("/invites/UNKNOWN1")) return ok({ error: { code: "invite_not_found", message: "Unknown" } }, 404);
    return base(url, init);
  }, { invite: "UNKNOWN1" });
  expect(events).toHaveLength(0);
  const input = document.querySelector<HTMLInputElement>('[name="inviteCode"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "8wkwe7dg82vr");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Open invitation");
  await settle();
  expect(window.location.search).toContain("invite=8WKWE7DG82VR");
  expect(document.body.textContent).toContain("Meet at the gate, then walk together.");
  expect(events.map(raw => JSON.parse(raw).outcome)).toEqual(["available"]);
});
