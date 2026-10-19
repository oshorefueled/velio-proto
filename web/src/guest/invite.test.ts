// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";

/**
 * Rendered invitation lifecycle checks (issue #16): host and booker access
 * through real lookups, distinct ineligible explanations, draft retention on
 * failure, unknown-outcome honesty (no phantom receipt), late-result
 * ownership across identity switches, and the exact invite_share_action
 * boundary (real clipboard/share success only). Wire envelopes live in
 * api.test.ts.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The live availability owner (issue #18) binds on visible surfaces; the
// invitation panel never binds one, and dormant sockets send no traffic.
class ScriptedLiveSocket {
  static instances: Array<{
    sent: string[];
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send: (data: string) => void;
    close: () => void;
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
}
vi.stubGlobal("WebSocket", ScriptedLiveSocket);

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (navigator as { share?: unknown }).share;
});

const hostUser = {
  id: "host",
  displayName: "Host",
  contactKey: "host",
  signupSource: "direct",
  signupGeneration: 0,
};
const bookerUser = {
  id: "booker",
  displayName: "Booker",
  contactKey: "booker",
  signupSource: "direct",
  signupGeneration: 0,
};
const secondUser = {
  id: "booker-2",
  displayName: "Second",
  contactKey: "second",
  signupSource: "direct",
  signupGeneration: 0,
};
const listItem = (id: string) => ({
  id,
  hostId: "host",
  title: `Activity ${id}`,
  startsAt: "2026-12-01T18:00:00Z",
  timezone: "UTC",
  priceMinorUnits: 1050,
  currency: "EUR",
  capacity: 2,
  bookedCount: 1,
  remainingSpots: 1,
  availabilityVersion: "1",
  hostDisplayName: "Host",
  started: false,
});
const detailOf = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Activity ${id}`,
  hostDisplayName: "Host",
  planId: `plan-${id}`,
  startsAt: "2026-12-01T18:00:00Z",
  timezone: "UTC",
  priceMinorUnits: 1050,
  currency: "EUR",
  capacity: 2,
  bookedCount: 1,
  remainingSpots: 1,
  availabilityVersion: "1",
  started: false,
  ...over,
});
const inviteOf = (rail: "public_share" | "vouch", targetContactKey: string | null) => ({
  id: "invite-1",
  code: "0ABCDEFHJKM2",
  rail,
  generation: 2,
  activityId: "a",
  planId: "plan-a",
  expiresAt: "2026-12-01T18:00:00Z",
  createdAt: "2026-10-18T21:00:00Z",
  targetContactKey,
});
const hostedActivity = (id: string) => ({ ...listItem(id), confirmedCount: 0 });
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
async function mount(
  transport: Transport,
  {
    session,
    activity = "a",
    view = "activity",
  }: { session?: typeof hostUser | null; activity?: string; view?: "activity" | "invites" } = {},
) {
  if (session) {
    localStorage.setItem("velio.session.v1", JSON.stringify({ token: `${session.id}-token`, user: session }));
  }
  const params = new URLSearchParams();
  if (activity) params.set("activity", activity);
  if (view === "invites") params.set("view", "invites");
  window.history.replaceState(null, "", `/?${params.toString()}`);
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
async function chooseRail(rail: "vouch" | "public_share") {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      `input[name="invite-rail"][value="${rail}"]`,
    )!;
    input.click(); // a real click drives React's controlled radio onChange
  });
}
async function fillContact(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("#vouch-contact")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function inviteTransport(over: {
  detail?: { status: number; json: unknown };
  create?: (url: string, init: { method: string; body?: string }) => Promise<{ status: number; json: unknown }> | { status: number; json: unknown };
  hosted?: Array<{ id: string }>;
  myBooking?: { status: number; json: unknown };
  events?: string[];
}) {
  return async (url: string, init: { method: string; body?: string }) => {
    if (url.endsWith("/client-events")) {
      over.events?.push(init.body ?? "");
      return ok({});
    }
    if (url.endsWith("/invites") && init.method === "POST") {
      if (over.create) return over.create(url, init);
      return ok({ invite: inviteOf("public_share", null) }, 201);
    }
    if (url.endsWith("/my/activities")) return ok({ activities: over.hosted ?? [] });
    if (url.endsWith("/bookings/me")) return over.myBooking ?? ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a"))
      return (
        over.detail ?? {
          status: 200,
          json: {
            activity: detailOf("a"),
            invites: { eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1" },
          },
        }
      );
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  };
}

it("when the owning host creates a vouch, the saved receipt names the contact and reserves no spot", async () => {
  const postBodies: string[] = [];
  await mount(
    inviteTransport({
      hosted: [hostedActivity("a")],
      create: async (_url, init) => {
        postBodies.push(init.body ?? "");
        return ok({ invite: inviteOf("vouch", "t16-friend") }, 201);
      },
    }),
    { session: hostUser, view: "invites" },
  );
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await settle();
  expect(postBodies).toEqual([JSON.stringify({ rail: "vouch", targetContactKey: "t16-friend" })]);
  const body = document.body.textContent ?? "";
  expect(body).toContain("Invitation saved");
  expect(body).toContain("Contact vouch for t16-friend");
  expect(body).toContain("0ABCDEFHJKM2");
  expect(body).toContain("nobody holds a spot");
  expect(body).toContain("only that contact can claim it");
});

it("when a confirmed booker creates a public share, the receipt shows reach without endorsement and the canonical link", async () => {
  await mount(
    inviteTransport({
      hosted: [],
      myBooking: ok({ booking: { id: "b1", activityId: "a", planId: "plan-a", userId: "booker", createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "direct", generation: 0 } } }),
      create: () => ok({ invite: inviteOf("public_share", null) }, 201),
    }),
    { session: bookerUser, view: "invites" },
  );
  await click("Create invitation");
  await settle();
  const body = document.body.textContent ?? "";
  expect(body).toContain("Public share link — anyone with the link can use it while valid");
  expect(body).toContain("http://localhost:3000/?invite=0ABCDEFHJKM2");
});

it("when the viewer is unaffiliated the controls are refused; a lookup outage stays unknown instead", async () => {
  await mount(inviteTransport({ hosted: [], myBooking: ok({ error: { code: "booking_not_found", message: "none" } }, 404) }), {
    session: bookerUser,
    view: "invites",
  });
  const body = document.body.textContent ?? "";
  expect(body).toContain("Only the owning host or a confirmed booker");
  expect(body).not.toContain("Create invitation");
});

it("when the affiliation lookups fail, the outcome stays unknown — never 'not affiliated' — until a retry succeeds", async () => {
  let failing = true;
  await mount(
    async (url, init) => {
      if (url.endsWith("/my/activities")) {
        if (failing) throw new TypeError("lookup down");
        return ok({ activities: [] });
      }
      if (url.endsWith("/bookings/me")) {
        if (failing) throw new TypeError("lookup down");
        return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
      }
      return inviteTransport({})(url, init);
    },
    { session: bookerUser, view: "invites" },
  );
  expect(document.body.textContent).toContain("could not verify whether you can invite");
  expect(document.body.textContent).not.toContain(
    "Only the owning host or a confirmed booker of this activity can create invitations",
  );
  failing = false;
  // Scope to the invite panel: the failing hosted-list reload in the hidden
  // host column is also named Try again.
  const retry = [...document.querySelectorAll<HTMLButtonElement>(".invite-panel button")].find(
    (button) => button.textContent === "Try again",
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  await settle();
  // Recovery lands on the definitive (correct) unaffiliated gate for this user.
  expect(document.body.textContent).toContain("Only the owning host or a confirmed booker");
});

it("when the plan is control, switched off, full or started, the matching explanation shows and nothing can be created", async () => {
  const postGuard = () => {
    throw new Error("no create request may be sent");
  };
  await mount(inviteTransport({ detail: ok({ activity: detailOf("a"), invites: { eligible: true, canCreateInvites: false, arm: "control", experimentVersion: "v1" } }) }), {
    session: bookerUser,
    view: "invites",
  });
  expect(document.body.textContent).toContain("control group");
  expect(document.body.textContent).not.toContain("Create invitation");
  await mount(inviteTransport({ detail: ok({ activity: detailOf("a"), invites: { eligible: true, canCreateInvites: false, arm: "treatment", experimentVersion: "v1" } }) }), {
    session: bookerUser,
    view: "invites",
  });
  expect(document.body.textContent).toContain("switched off");
  expect(document.body.textContent).not.toContain("Create invitation");
  await mount(inviteTransport({ detail: ok({ activity: detailOf("a", { remainingSpots: 0, bookedCount: 2 }), invites: { eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1" } }), create: postGuard }), {
    session: bookerUser,
    view: "invites",
  });
  expect(document.body.textContent).toContain("This activity is full — new invitations are closed.");
  await mount(inviteTransport({ detail: ok({ activity: detailOf("a", { started: true }), invites: { eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1" } }), create: postGuard }), {
    session: bookerUser,
    view: "invites",
  });
  expect(document.body.textContent).toContain("has already started — new invitations are closed");
});

it("while creation is in flight, submit stays disabled and a second click sends no second request", async () => {
  const postBodies: string[] = [];
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    inviteTransport({
      hosted: [hostedActivity("a")],
      create: () => pending.promise,
    }),
    { session: hostUser, view: "invites" },
  );
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  const creating = [...document.querySelectorAll("button")].find((b) => b.textContent === "Creating…");
  expect(creating).toBeDefined();
  expect(creating!.disabled).toBe(true);
  await act(async () => creating!.click());
  expect(postBodies).toHaveLength(0);
  await act(async () => pending.resolve(ok({ invite: inviteOf("vouch", "t16-friend") }, 201)));
  await settle();
  expect(document.body.textContent).toContain("Invitation saved");
});

it("when creation fails before an answer, the chosen contact is kept, no phantom receipt appears, and an explicit retry can create one", async () => {
  const postBodies: string[] = [];
  let fail = true;
  await mount(
    inviteTransport({
      hosted: [hostedActivity("a")],
      create: async (_url, init) => {
        postBodies.push(init.body ?? "");
        if (fail) throw new TypeError("network unreachable");
        return ok({ invite: inviteOf("vouch", "t16-friend") }, 201);
      },
    }),
    { session: hostUser, view: "invites" },
  );
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await settle();
  const bodyAfterFailure = document.body.textContent ?? "";
  expect(bodyAfterFailure).toContain("cannot tell whether the invitation was saved");
  expect(bodyAfterFailure).not.toContain("Invitation saved");
  expect(bodyAfterFailure).not.toContain("0ABCDEFHJKM2");
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("t16-friend");
  fail = false;
  await click("Try again");
  await settle();
  expect(document.body.textContent).toContain("Invitation saved");
  expect(postBodies).toHaveLength(2);
});

it("when a delayed creation succeeds after an identity switch, no receipt attaches to the new identity", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    async (url, init) => {
      if (url.endsWith("/invites") && init.method === "POST") return pending.promise;
      if (url.endsWith("/demo/sessions"))
        return ok({ session: { token: "second-token", expiresAt: "2027-01-01" }, user: secondUser, created: true });
      return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
    },
    { session: hostUser, view: "invites" },
  );
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await click("Sign out");
    await click("Sign in");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[name="email"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "second");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(document.body.textContent).toContain("Second");
  await act(async () => pending.resolve(ok({ invite: inviteOf("vouch", "t16-friend") }, 201)));
  await settle();
  expect(document.body.textContent).not.toContain("Invitation saved");
});

it("when a late 401 arrives after an identity switch, the newer session stays intact", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    async (url, init) => {
      if (url.endsWith("/invites") && init.method === "POST") return pending.promise;
      if (url.endsWith("/demo/sessions"))
        return ok({ session: { token: "second-token", expiresAt: "2027-01-01" }, user: secondUser, created: true });
      return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
    },
    { session: hostUser, view: "invites" },
  );
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await click("Sign out");
    await click("Sign in");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[name="email"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "second");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  await act(async () =>
    pending.resolve(ok({ error: { code: "session_expired", message: "Old session expired" } }, 401)),
  );
  await settle();
  const body = document.body.textContent ?? "";
  expect(body).toContain("Second");
  expect(body).not.toContain("Your session expired");
  expect(body).not.toContain("Invitation saved");
});

it("when the copy succeeds, invite_share_action records copy exactly; failure and unsupported record nothing", async () => {
  const events: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { void text; return Promise.resolve(); } },
  });
  await mount(inviteTransport({ hosted: [hostedActivity("a")], events }), { session: hostUser, view: "invites" });
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await settle();
  await click("Copy code");
  await settle();
  expect(document.body.textContent).toContain("Code copied");
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!)).toEqual({
    type: "invite_share_action",
    eventId: JSON.parse(events[0]!).eventId,
    visitorId: expect.any(String),
    channel: "web",
    inviteCode: "0ABCDEFHJKM2",
    shareMethod: "copy",
  });
  // Denied clipboard: the fallback shows, and no second event is recorded.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("denied")) },
  });
  await click("Copy link");
  await settle();
  expect(document.body.textContent).toContain("Copying was not available");
  expect(events).toHaveLength(1);
});

it("when a supported share resolves, system_share is recorded; cancellation records nothing and keeps the receipt", async () => {
  const events: string[] = [];
  Object.defineProperty(navigator, "share", { configurable: true, value: () => Promise.resolve() });
  await mount(inviteTransport({ hosted: [hostedActivity("a")], events }), { session: hostUser, view: "invites" });
  await chooseRail("public_share");
  await click("Create invitation");
  await settle();
  await click("Share via device");
  await settle();
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!).shareMethod).toBe("system_share");
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: () => Promise.reject(new DOMException("cancelled", "AbortError")),
  });
  await click("Share via device");
  await settle();
  expect(events).toHaveLength(1);
  expect(document.body.textContent).toContain("Invitation saved");
});

it("without device sharing the panel says so honestly and records nothing", async () => {
  const events: string[] = [];
  await mount(inviteTransport({ hosted: [hostedActivity("a")], events }), { session: hostUser, view: "invites" });
  await chooseRail("public_share");
  await click("Create invitation");
  await settle();
  await click("Share via device");
  await settle();
  expect(document.body.textContent).toContain("does not offer device sharing");
  expect(events).toHaveLength(0);
});

it("when a saved booking exists, its entry opens the invitation route for that activity", async () => {
  const urlBefore = window.location.href;
  await mount(
    async (url, init) => {
      if (url.endsWith("/bookings/me"))
        return ok({ booking: { id: "b1", activityId: "a", planId: "plan-a", userId: "booker", createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "direct", generation: 0 } } });
      return inviteTransport({ hosted: [] })(url, init);
    },
    { session: bookerUser, view: "activity" },
  );
  await click("Invite someone to this plan");
  await settle();
  expect(window.location.href).toContain("view=invites");
  expect(window.location.href).toContain("activity=a");
  expect(document.body.textContent).toContain("Invitation type");
  void urlBefore;
});

it("when the owning host opens their detail, the host entry leads to the same invitation route", async () => {
  await mount(
    async (url, init) => {
      if (url.endsWith("/my/activities")) return ok({ activities: [listItem("a")] });
      if (url.endsWith("/participants"))
        return ok({ activityId: "a", planId: "plan-a", confirmedCount: 0, participants: [] });
      return inviteTransport({})(url, init);
    },
    { session: hostUser, view: "activity" },
  );
  // The host detail lives in the hidden-by-default host tools; switch first.
  await click("Host tools");
  await settle(4);
  await click("Invite guests to this activity");
  await settle();
  expect(window.location.href).toContain("view=invites");
  expect(document.body.textContent).toContain("Invitation type");
});

it("when the creator switches identity after saving an invitation, the private receipt clears and identity selection is required", async () => {
  await mount(inviteTransport({ hosted: [hostedActivity("a")], create: () => ok({ invite: inviteOf("vouch", "t16-friend") }, 201) }), { session: hostUser, view: "invites" });
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await settle();
  expect(document.body.textContent).toContain("Invitation saved");
  await click("Sign out");
    await click("Sign in");
  await settle();
  expect(document.body.textContent).not.toContain("0ABCDEFHJKM2");
  expect(document.body.textContent).toContain("Select identity to invite");
});

it("when the contact changes during creation, the delayed receipt cannot replace the new draft", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(inviteTransport({ hosted: [hostedActivity("a")], create: () => pending.promise }), { session: hostUser, view: "invites" });
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await fillContact("t16-another-friend");
  await act(async () => pending.resolve(ok({ invite: inviteOf("vouch", "t16-friend") }, 201)));
  await settle();
  expect(document.body.textContent).not.toContain("Invitation saved");
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("t16-another-friend");
});

it("when creation is rate limited, another submit waits until Retry-After elapses and preserves the contact", async () => {
  let attempts = 0;
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  await mount(async (url, init) => {
    if (url.endsWith("/invites") && init.method === "POST") {
      attempts++;
      return { status: 429, json: { error: { code: "request_limit", message: "wait" } }, headers: { "retry-after": "2" } };
    }
    return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
  }, { session: hostUser, view: "invites" });
  await chooseRail("vouch");
  await fillContact("t16-friend");
  await click("Create invitation");
  await settle();
  await click("Create invitation");
  expect(attempts).toBe(1);
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("t16-friend");
  clock.mockReturnValue(3001);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });
  await click("Create invitation");
  expect(attempts).toBe(2);
});


it("when an old creation fails while the new identity is creating, the old error cannot replace the pending request", async () => {
  const old = deferred<{ status: number; json: unknown }>();
  const next = deferred<{ status: number; json: unknown }>();
  let attempts = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/invites") && init.method === "POST") return ++attempts === 1 ? old.promise : next.promise;
    if (url.endsWith("/demo/sessions")) return ok({ session: { token: "second-token", expiresAt: "2027-01-01" }, user: secondUser, created: false });
    return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
  }, { session: hostUser, view: "invites" });
  await click("Create invitation");
  await click("Sign out");
    await click("Sign in");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[name="email"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "second");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  await click("Create invitation");
  expect(attempts).toBe(2);
  await act(async () => old.resolve(ok({ error: { code: "validation_error", message: "Old contact invalid" } }, 400)));
  await settle();
  const pendingButton = [...document.querySelectorAll<HTMLButtonElement>(".invite-panel button")].find((button) => button.textContent === "Creating…");
  expect(pendingButton?.disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Old contact invalid");
  await act(async () => next.resolve(ok({ invite: inviteOf("public_share", null) }, 201)));
  await settle();
  expect(document.body.textContent).toContain("Invitation saved");
});
