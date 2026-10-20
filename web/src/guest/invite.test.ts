// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  endsAt: "2026-12-01T20:00:00Z",
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
  hostDisplayName: "Host", hostId: "host",
  planId: `plan-${id}`,
  startsAt: "2026-12-01T18:00:00Z",
  endsAt: "2026-12-01T20:00:00Z",
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
const inviteOf = (rail: "public_share" | "vouch", recipientEmail: string | null) => ({
  id: "invite-1",
  code: "0ABCDEFHJKM2",
  rail,
  generation: 2,
  activityId: "a",
  planId: "plan-a",
  expiresAt: "2026-12-01T18:00:00Z",
  createdAt: "2026-10-18T21:00:00Z",
  recipientEmail,
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
  { session, search = "?activity=a" }: { session?: typeof hostUser | null; search?: string } = {},
) {
  if (session) {
    localStorage.setItem("velio.session.v1", JSON.stringify({ token: `${session.id}-token`, user: session }));
  }
  window.history.replaceState(null, "", `/${search}`);
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
      const input = JSON.parse(init.body ?? "{}");
      return ok({ invite: inviteOf(input.rail, input.recipientEmail ?? null) }, 201);
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

const savedBooking = ok({ booking: { id: "b1", activityId: "a", planId: "plan-a", userId: "booker", createdAt: "2026-10-18T12:00:00Z", attribution: { rail: "direct", generation: 0 } } });
const shareActions = (events: string[]) => events.filter((raw) => JSON.parse(raw).type === "invite_share_action");
function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

it("when a confirmed booker opens the activity, the invite card follows the details card and rendering it records nothing", async () => {
  const posts: string[] = [];
  const events: string[] = [];
  await mount(inviteTransport({ myBooking: savedBooking, events, create: (_url, init) => { posts.push(init.body ?? ""); return ok({}, 500); } }), { session: bookerUser });
  const aside = document.querySelector(".detail-aside")!;
  const cards = [...aside.children].map((card) => card.className);
  expect(cards.indexOf("aside-card invite-card")).toBe(cards.indexOf("aside-card aside-facts") + 1);
  const card = document.querySelector(".invite-card")!;
  expect(card.textContent).toContain("Invite someone you can vouch for");
  expect(card.querySelector("#vouch-contact")).not.toBeNull();
  expect(card.querySelector("hr.invite-divider")).not.toBeNull();
  expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Invite", "Or generate a public invite"]);
  expect(document.body.textContent).not.toContain("Invite someone to this plan");
  expect(posts).toHaveLength(0);
  expect(shareActions(events)).toHaveLength(0);
});

it("when the invites view is requested by URL, the activity page shows instead of a separate invites page", async () => {
  await mount(inviteTransport({ myBooking: savedBooking }), { session: bookerUser, search: "?activity=a&view=invites" });
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity a");
  expect(document.querySelectorAll(".invite-card")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("Back to activity");
});

it("when the viewer is a guest or has no booking, no invite card shows", async () => {
  await mount(inviteTransport({}), { session: null });
  expect(document.querySelector(".invite-card")).toBeNull();
  await act(async () => root!.unmount());
  root = undefined;
  await mount(inviteTransport({}), { session: bookerUser });
  expect(document.querySelector(".invite-card")).toBeNull();
});

it("when the owning host invites an email, a personal invitation bound to it is created and its link shows with Copy", async () => {
  const postBodies: string[] = [];
  await mount(
    inviteTransport({
      hosted: [hostedActivity("a")],
      create: async (_url, init) => {
        postBodies.push(init.body ?? "");
        return ok({ invite: inviteOf("vouch", "friend@example.test") }, 201);
      },
    }),
    { session: hostUser },
  );
  await fillContact("friend@example.test");
  await click("Invite");
  await settle();
  expect(postBodies).toEqual([JSON.stringify({ rail: "vouch", recipientEmail: "friend@example.test" })]);
  const card = document.querySelector(".invite-card")!.textContent ?? "";
  expect(card).toContain("Invitation saved for friend@example.test — only that email can use it.");
  expect(card).toContain("http://localhost:3000/?invite=0ABCDEFHJKM2");
  expect(card).toContain("Copy");
});

it("when generate is tapped, the public invite link shows with Copy, and a second tap while it is pending sends nothing", async () => {
  const postBodies: string[] = [];
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(inviteTransport({ myBooking: savedBooking, create: (_url, init) => { postBodies.push(init.body ?? ""); return pending.promise; } }), { session: bookerUser });
  await click("Or generate a public invite");
  const generating = [...document.querySelectorAll("button")].find((b) => b.textContent === "Generating…")!;
  expect(generating.disabled).toBe(true);
  await act(async () => generating.click());
  expect(postBodies).toEqual([JSON.stringify({ rail: "public_share" })]);
  await act(async () => pending.resolve(ok({ invite: inviteOf("public_share", null), created: true }, 201)));
  await settle();
  const card = document.querySelector(".invite-card")!;
  expect(card.textContent).toContain("http://localhost:3000/?invite=0ABCDEFHJKM2");
  expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toContain("Copy");
  expect(card.textContent).not.toContain("Or generate a public invite");
});

it("when Copy is tapped, each successful copy records one share action; a failed copy records nothing", async () => {
  const events: string[] = [];
  const writes: string[] = [];
  clipboard(async (text) => { writes.push(text); });
  await mount(inviteTransport({ myBooking: savedBooking, events }), { session: bookerUser });
  await click("Or generate a public invite");
  await settle();
  expect(shareActions(events)).toHaveLength(0);
  await click("Copy");
  await settle();
  await click("Copied");
  await settle();
  expect(writes).toEqual(["http://localhost:3000/?invite=0ABCDEFHJKM2", "http://localhost:3000/?invite=0ABCDEFHJKM2"]);
  expect(shareActions(events)).toHaveLength(2);
  expect(JSON.parse(shareActions(events)[0]!)).toEqual({
    type: "invite_share_action",
    eventId: expect.any(String),
    visitorId: expect.any(String),
    channel: "web",
    visitId: expect.any(String),
    inviteCode: "0ABCDEFHJKM2",
    shareMethod: "copy",
  });
  clipboard(() => Promise.reject(new Error("denied")));
  await click("Copied");
  await settle();
  expect(document.body.textContent).toContain("Copying was not available");
  expect(shareActions(events)).toHaveLength(2);
});

it("when the activity is control, creation is switched off or it has started, the card follows the creation restrictions and a saved public link stays retrievable", async () => {
  const posts: string[] = [];
  const capabilities = (over: Record<string, unknown>) => ({ eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1", ...over });
  await mount(inviteTransport({ myBooking: savedBooking, detail: ok({ activity: detailOf("a"), invites: capabilities({ canCreateInvites: false, arm: "control" }) }) }), { session: bookerUser });
  expect(document.querySelector(".invite-card")!.textContent).toContain("control group");
  expect(document.querySelector(".invite-card button")).toBeNull();
  await act(async () => root!.unmount());
  for (const [detail, explanation] of [
    [ok({ activity: detailOf("a"), invites: capabilities({ canCreateInvites: false }) }), "switched off"],
    [ok({ activity: detailOf("a", { started: true }), invites: capabilities({}) }), "has already started — new invitations are closed"],
  ] as const) {
    await mount(inviteTransport({ myBooking: savedBooking, detail, create: (_url, init) => { posts.push(init.body ?? ""); return ok({ invite: inviteOf("public_share", null), created: false }); } }), { session: bookerUser });
    const card = document.querySelector(".invite-card")!;
    expect(card.textContent).toContain(explanation);
    expect(card.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await click("Show saved public link");
    await settle();
    expect(card.textContent).toContain("http://localhost:3000/?invite=0ABCDEFHJKM2");
    await act(async () => root!.unmount());
  }
  root = undefined;
  expect(posts).toEqual([JSON.stringify({ rail: "public_share" }), JSON.stringify({ rail: "public_share" })]);
});

it("when creation fails before an answer, the contact is kept, no phantom invitation appears, and an explicit retry can create one", async () => {
  const postBodies: string[] = [];
  let fail = true;
  await mount(
    inviteTransport({
      hosted: [hostedActivity("a")],
      create: async (_url, init) => {
        postBodies.push(init.body ?? "");
        if (fail) throw new TypeError("network unreachable");
        return ok({ invite: inviteOf("vouch", "friend@example.test") }, 201);
      },
    }),
    { session: hostUser },
  );
  await fillContact("friend@example.test");
  await click("Invite");
  await settle();
  const bodyAfterFailure = document.body.textContent ?? "";
  expect(bodyAfterFailure).toContain("cannot tell whether the invitation was saved");
  expect(bodyAfterFailure).not.toContain("Invitation saved");
  expect(bodyAfterFailure).not.toContain("0ABCDEFHJKM2");
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("friend@example.test");
  fail = false;
  await click("Try again");
  await settle();
  expect(document.body.textContent).toContain("Invitation saved");
  expect(postBodies).toHaveLength(2);
});

it("when the contact changes during creation, the delayed invitation cannot replace the new draft", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(inviteTransport({ hosted: [hostedActivity("a")], create: () => pending.promise }), { session: hostUser });
  await fillContact("friend@example.test");
  await click("Invite");
  await fillContact("another@example.test");
  await act(async () => pending.resolve(ok({ invite: inviteOf("vouch", "friend@example.test") }, 201)));
  await settle();
  expect(document.body.textContent).not.toContain("Invitation saved");
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("another@example.test");
});

it("when a late 401 arrives after an identity switch, the newer session stays intact and nothing attaches to it", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(
    async (url, init) => {
      if (url.endsWith("/invites") && init.method === "POST") return pending.promise;
      if (url.endsWith("/demo/sessions"))
        return ok({ session: { token: "second-token", expiresAt: "2027-01-01" }, user: secondUser, created: true });
      return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
    },
    { session: hostUser },
  );
  await fillContact("friend@example.test");
  await click("Invite");
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

it("when creation is rate limited, another submit waits until Retry-After elapses and preserves the contact", async () => {
  let attempts = 0;
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  await mount(async (url, init) => {
    if (url.endsWith("/invites") && init.method === "POST") {
      attempts++;
      return { status: 429, json: { error: { code: "request_limit", message: "wait" } }, headers: { "retry-after": "2" } };
    }
    return inviteTransport({ hosted: [hostedActivity("a")] })(url, init);
  }, { session: hostUser });
  await fillContact("friend@example.test");
  await click("Invite");
  await settle();
  await click("Invite");
  expect(attempts).toBe(1);
  expect((document.querySelector("#vouch-contact") as HTMLInputElement).value).toBe("friend@example.test");
  clock.mockReturnValue(3001);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });
  await click("Invite");
  expect(attempts).toBe(2);
});

it("when creation is refused because the activity has started, the activity facts refresh and the card shows invitations are closed", async () => {
  let started = false;
  let detailFetches = 0;
  const base = inviteTransport({ myBooking: savedBooking });
  await mount(async (url, init) => {
    if (url.endsWith("/invites") && init.method === "POST") { started = true; return ok({ error: { code: "activity_started", message: "Started" } }, 409); }
    if (url.endsWith("/activities/a")) { detailFetches++; return ok({ activity: detailOf("a", { started }), invites: { eligible: true, canCreateInvites: true, arm: "treatment", experimentVersion: "v1" } }); }
    return base(url, init);
  }, { session: bookerUser });
  const before = detailFetches;
  await fillContact("friend@example.test");
  await click("Invite");
  await settle();
  expect(detailFetches).toBeGreaterThan(before);
  const card = document.querySelector(".invite-card")!;
  expect(card.textContent).toContain("has already started — new invitations are closed");
  expect(card.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
