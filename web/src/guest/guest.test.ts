// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";

/**
 * Rendered booking lifecycle checks (issue #15): pending is never a
 * confirmation, an unknown outcome reconciles against the saved booking,
 * absence is distinct from unknown, the operation id is stable across
 * retries, and identity/selection changes cannot confirm or expire the
 * wrong person. Wire envelopes have their canonical owner in api.test.ts.
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
});

const user = {
  id: "booker",
  displayName: "Booker",
  email: "booker@example.test",
  signupSource: "direct",
  signupGeneration: 0,
};
const secondUser = {
  id: "booker-2",
  displayName: "Second",
  email: "second@example.test",
  signupSource: "direct",
  signupGeneration: 0,
};
const listItem = (id: string) => ({
  id,
  hostId: "host",
  title: `Activity ${id}`,
  startsAt: "2026-06-01T12:00:00Z",
  endsAt: "2026-06-01T14:00:00Z",
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
  startsAt: "2026-06-01T12:00:00Z",
  endsAt: "2026-06-01T14:00:00Z",
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
const bookingOf = () => ({
  id: "booking-booker",
  activityId: "a",
  planId: "plan-a",
  userId: "booker",
  createdAt: "2026-10-18T12:00:00Z",
  attribution: { rail: "direct", generation: 0 },
});
const bookingEnvelope = (created: boolean) => ({
  booking: bookingOf(),
  created,
  attemptId: "attempt-1",
  availabilityVersion: "2",
});

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
  { authenticated = true, activity = "a" }: { authenticated?: boolean; activity?: string } = {},
) {
  if (authenticated) {
    localStorage.setItem("velio.session.v1", JSON.stringify({ token: "booker-token", user }));
  }
  window.history.replaceState(null, "", activity ? `/?activity=${activity}` : "/");
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

it("when a booking request is in flight, submit stays disabled and a second click sends no second request", async () => {
  const postBodies: string[] = [];
  let saved = false;
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      postBodies.push(init.body ?? "");
      return pending.promise;
    }
    if (url.endsWith("/bookings/me"))
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [{ ...listItem("a"), remainingSpots: saved ? 0 : 1 }] });
    return ok({});
  });
  await click("Book a spot");
  const checkout = document.querySelector('[aria-label="Checkout"]');
  expect(checkout).not.toBeNull();
  expect(checkout!.textContent).toContain("Activity a");
  expect(checkout!.textContent).toContain("12:00–14:00");
  expect(checkout!.textContent).toContain("€10.50");
  expect(checkout!.textContent).toContain("1 spot");
  expect(checkout!.textContent).toContain("booker@example.test");
  expect(checkout!.querySelector('[name="email"]')).toBeNull();
  expect(postBodies).toHaveLength(0);
  await click("Confirm one spot");
  const reserving = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Reserving…",
  );
  expect(reserving).toBeDefined();
  expect(reserving!.disabled).toBe(true);
  await act(async () => reserving!.click());
  expect(postBodies).toHaveLength(1);
  saved = true;
  await act(async () => pending.resolve(ok(bookingEnvelope(true), 201)));
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  expect(document.body.textContent).toContain("booking-booker");
  const receipt = document.querySelector('[aria-label="Saved booking"]')!;
  expect(receipt.textContent).toContain("plan-a");
  expect(receipt.textContent).not.toContain("Source");
  expect(receipt.textContent).not.toContain("direct");
  // The full-page detail leaves the grid unmounted until the back link.
  await click("Back to Explore");
  await settle();
  expect(document.querySelector(".activity-card")!.textContent).toContain("No spots left");
  expect(postBodies).toHaveLength(1);
});

it("when a committed booking's response is lost, the saved-booking lookup shows the confirmation", async () => {
  let posted = false;
  let myBookingCalls = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      posted = true;
      return ok({ error: { code: "booking_outcome_unknown", message: "Lost after commit" } }, 500);
    }
    if (url.endsWith("/bookings/me")) {
      myBookingCalls += 1;
      return posted
        ? ok({ booking: bookingOf() })
        : ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    }
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [{ ...listItem("a"), remainingSpots: posted ? 0 : 1 }] });
    return ok({});
  });
  expect(myBookingCalls).toBe(1); // boot check: nothing saved yet
  await click("Book a spot");
  await click("Confirm one spot");
  await settle();
  expect(myBookingCalls).toBe(2); // unknown outcome reconciled before anything else
  expect(document.body.textContent).toContain("Your spot is saved");
  await click("Back to Explore");
  await settle();
  expect(document.querySelector(".activity-card")!.textContent).toContain("No spots left");
});

it("when the saved-booking check cannot run the outcome stays unknown; established absence enables only an explicit retry with the SAME operation id", async () => {
  const postBodies: string[] = [];
  let postCount = 0;
  let checkFails = false;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      postCount += 1;
      postBodies.push(init.body ?? "");
      return postCount === 1
        ? ok({ error: { code: "booking_outcome_unknown", message: "Lost" } }, 500)
        : ok(bookingEnvelope(true), 201);
    }
    if (url.endsWith("/bookings/me")) {
      if (checkFails) throw new TypeError("network down");
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    }
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  checkFails = true;
  await click("Book a spot");
  await click("Confirm one spot");
  await settle();
  expect(document.body.textContent).toContain("Check again");
  expect(document.body.textContent).not.toContain("nothing was reserved");
  const firstOperationId = (JSON.parse(postBodies[0]!) as { operationId: string }).operationId;

  checkFails = false;
  await click("Check again");
  await settle();
  expect(document.body.textContent).toContain("nothing was reserved");

  await click("Book again");
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  const secondOperationId = (JSON.parse(postBodies[1]!) as { operationId: string }).operationId;
  expect(secondOperationId).toBe(firstOperationId);
  expect(postBodies).toHaveLength(2);
});

it("when a delayed booking success arrives after an identity switch, it confirms nothing for the new identity", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  let postCount = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      postCount += 1;
      return pending.promise;
    }
    if (url.endsWith("/bookings/me"))
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/demo/sessions"))
      return ok({
        session: { token: "second-token", expiresAt: "2027-01-01" },
        user: secondUser,
        created: true,
      });
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  await click("Confirm one spot");
  await click("Sign out");
    await click("Sign in");
  await fillContact("second");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(document.body.textContent).toContain("Second");
  expect(document.body.textContent).toContain("Confirm one spot");
  await act(async () => pending.resolve(ok(bookingEnvelope(true), 201)));
  await settle();
  expect(document.body.textContent).not.toContain("Your spot is saved");
  expect(postCount).toBe(1);
});

it("when activity details fail, Retry keeps the selection and availability stays unknown, not zero", async () => {
  let fail = true;
  await mount(
    async (url) => {
      if (url.includes("/activities/a"))
        return fail
          ? ok({ error: { code: "server_error", message: "Details unavailable" } }, 500)
          : ok({ activity: detailOf("a"), invites: {} });
      if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
      return ok({});
    },
    { authenticated: false },
  );
  const body = document.body.textContent ?? "";
  expect(body).toContain("Details unavailable");
  expect(body).toContain("Availability is unknown");
  expect(body).not.toContain("0 booked");
  expect(body).not.toContain("Full");
  fail = false;
  await click("Retry");
  await settle();
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity a");
  expect(document.body.textContent).toContain("1 of 2 spots left");
  expect(document.body.textContent).toContain("Book a spot");
});

it("when booking is requested without an identity, the selection is retained and nothing is sent until identity selection completes", async () => {
  let postCount = 0;
  await mount(
    async (url, init) => {
      if (url.endsWith("/bookings") && init.method === "POST") {
        postCount += 1;
        return ok(bookingEnvelope(true), 201);
      }
      if (url.endsWith("/bookings/me"))
        return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
      if (url.endsWith("/demo/sessions"))
        return ok({
          session: { token: "booker-token", expiresAt: "2027-01-01" },
          user,
          created: true,
        });
      if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
      if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
      return ok({});
    },
    { authenticated: false },
  );
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity a");
  await click("Book a spot");
  expect(document.querySelector('[aria-label="Checkout"]')).not.toBeNull();
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity a");
  await fillContact("booker");
  await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(postCount).toBe(0);
  expect(document.body.textContent).toContain("Confirm one spot");
});

it("when reopening with a saved booking, the receipt shows even though the activity is now full and started", async () => {
  await mount(async (url) => {
    if (url.endsWith("/bookings/me")) return ok({ booking: bookingOf() });
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a"))
      return ok({
        activity: detailOf("a", { started: true, remainingSpots: 0, bookedCount: 2 }),
        invites: {},
      });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  expect(document.body.textContent).toContain("booking-booker");
});


it("when reopening cannot check saved membership, only Check again is offered until absence is verified", async () => {
  let unavailable = true;
  let posts = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings/me")) {
      if (unavailable) throw new TypeError("offline");
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    }
    if (init.method === "POST" && url.endsWith("/bookings")) posts += 1;
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  expect(document.body.textContent).toContain("Check again");
  expect(document.body.textContent).not.toContain("Book a spot");
  unavailable = false;
  await click("Check again");
  await settle();
  expect(document.body.textContent).toContain("Review booking");
  await click("Review booking");
  expect(document.querySelector('[aria-label="Checkout"]')).not.toBeNull();
  expect(posts).toBe(0);
});

it("when the saved-booking lookup expires the credential, the remembered email restores the same booking without a mutation", async () => {
  const entries: Array<{ email: string }> = [];
  let posts = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/demo/sessions")) {
      entries.push(JSON.parse(init.body!));
      return ok({ session: { token: "restored-token", expiresAt: "2027-01-01" }, user, created: false });
    }
    if (url.endsWith("/bookings/me")) return init.headers.authorization === "Bearer restored-token"
      ? ok({ booking: bookingOf() })
      : ok({ error: { code: "session_expired", message: "Expired" } }, 401);
    if (url.endsWith("/bookings") && init.method === "POST") posts += 1;
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.email).toBe(user.email);
  expect(localStorage.getItem("velio.session.v1")).toContain("restored-token");
  expect(document.querySelector('dialog[aria-label="Select your identity"]')).toBeNull();
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity a");
  expect(document.body.textContent).toContain("booking-booker");
  expect(posts).toBe(0);
});

it("when a host publication expires the credential, identity recovery retains the entered draft", async () => {
  await mount(async (url, init) => {
    if (url.endsWith("/activities") && init.method === "POST") return ok({ error: { code: "session_expired", message: "Expired" } }, 401);
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Publish activity");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("#pub-title")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Keep this draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    for (const id of ["pub-description", "pub-itinerary"]) {
      const input = document.getElementById(id)!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "A complete activity.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => document.querySelector<HTMLFormElement>("#pub-title")!.closest("form")!.requestSubmit());
  await settle();
  expect(document.querySelector<HTMLInputElement>("#pub-title")?.value).toBe("Keep this draft");
  expect(document.querySelector('dialog[aria-label="Select your identity"]')).not.toBeNull();
});

it("when selecting another activity before an old booking returns 401, the current identity and selection remain", async () => {
  const pending = deferred<{ status: number; json: unknown }>();
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") return pending.promise;
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities/b")) return ok({ activity: detailOf("b"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a"), listItem("b")] });
    return ok({});
  });
  await click("Book a spot");
  await click("Confirm one spot");
  await click("Back to Explore");
  await settle();
  const next = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Activity b"));
  expect(next).toBeDefined();
  await act(async () => next!.click());
  await act(async () => pending.resolve(ok({ error: { code: "session_expired", message: "old" } }, 401)));
  await settle();
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity b");
  expect(localStorage.getItem("velio.session.v1")).toContain("booker-token");
  expect(document.body.textContent).not.toContain("Your spot is saved");
});

it("when a booking is rate limited, Book again stays disabled until Retry-After elapses", async () => {
  vi.useFakeTimers();
  try {
    await mount(async (url, init) => {
      if (url.endsWith("/bookings") && init.method === "POST") return { status: 429, json: { error: { code: "request_limit", message: "wait" } }, headers: { "retry-after": "2" } };
      if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
      if (url.endsWith("/my/activities")) return ok({ activities: [] });
      if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
      if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
      if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
      return ok({});
    });
    await click("Book a spot");
    await click("Confirm one spot");
    await settle();
    const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Book again")!;
    expect(retry.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1999));
    expect(retry.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(retry.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("when a live availability frame is newer, the guest's displayed spots update without refresh and the booking controls follow the applied facts", async () => {
  ScriptedLiveSocket.instances.length = 0;
  const acks: Array<{ body: Record<string, unknown>; dom: string }> = [];
  await mount(async (url, init) => {
    if (url.endsWith("/availability-acks")) {
      acks.push({ body: JSON.parse(init.body ?? "{}") as Record<string, unknown>, dom: document.body.textContent ?? "" });
      return ok({ ack: {} });
    }
    if (url.endsWith("/bookings/me"))
      return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants"))
      return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  expect(document.body.textContent).toContain("1 of 2 spots left");
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () =>
    socket.receive({ type: "measurement_registered", connectionId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" }),
  );
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  await act(async () =>
    socket.receive({ type: "availability", activityId: "a", version: "7", remainingSpots: 0, eventId: null }),
  );
  await settle();
  expect(document.body.textContent).toContain("0 of 2 spots left");
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Full")).toBe(true);
  expect(acks.length).toBeGreaterThanOrEqual(1);
  const renderedAck = acks.at(-1)!;
  expect(renderedAck.body).toMatchObject({ appliedVersion: "7", source: "websocket" });
  expect(renderedAck.dom).toContain("0 of 2 spots left");
});

it("when a guest confirms then signs out, signing in with the same email reopens the original saved booking", async () => {
  let saved = false;
  let posts = 0;
  const entries: string[] = [];
  await mount(async (url, init) => {
    if (url.endsWith("/demo/sessions")) {
      entries.push(JSON.parse(init.body!).email);
      return ok({ session: { token: "booker-token", expiresAt: "2027-01-01" }, user, created: false });
    }
    if (url.endsWith("/bookings") && init.method === "POST") {
      saved = true;
      posts += 1;
      return ok(bookingEnvelope(true), 201);
    }
    if (url.endsWith("/bookings/me")) return saved && url.includes("/activities/a/") ? ok({ booking: bookingOf() }) : ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/bookings")) return ok({ bookings: saved ? [{ ...bookingOf(), activity: listItem("a") }] : [] });
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities/b")) return ok({ activity: detailOf("b"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a"), listItem("b")] });
    return ok({});
  }, { authenticated: false });
  await click("Book a spot");
  await fillContact("booker@example.test");
  await act(async () => document.querySelector('[name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  expect(posts).toBe(0);
  expect(document.querySelector('[aria-label="Checkout"]')!.textContent).toContain(user.email);
  await click("Confirm one spot");
  await settle();
  expect(document.body.textContent).toContain("booking-booker");
  await click("Sign out");
  expect(document.body.textContent).not.toContain("booking-booker");
  // The grid returns through the detail's back link in the full-page layout.
  await click("Back to Explore");
  await settle();
  const anotherActivity = [...document.querySelectorAll<HTMLButtonElement>(".activity-card")].find(button => button.textContent?.includes("Activity b"))!;
  await act(async () => anotherActivity.click());
  await settle();
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe("Activity b");
  await click("Sign in");
  // Standalone Sign in and checkout both have an email field; use the dialog.
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('dialog [name="email"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  BOOKER@example.test  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector('dialog [name="email"]')!.closest("form")!.requestSubmit());
  await settle();
  await click("My bookings");
  await settle();
  const savedActivity = [...document.querySelectorAll<HTMLButtonElement>(".browse-item")].find(button => button.textContent?.includes("Activity a"))!;
  await act(async () => savedActivity.click());
  await settle();
  expect(document.querySelector('[aria-label="Saved booking"]')!.textContent).toContain("booking-booker");
  expect(document.querySelector('[aria-label="Saved booking"]')!.textContent).toContain("plan-a");
  expect(entries).toEqual(["booker@example.test", "BOOKER@example.test"]);
  expect(posts).toBe(1);
});

it("when confirmation expires the credential, restoring access checks the saved booking without replaying confirmation", async () => {
  let posts = 0;
  let restored = false;
  await mount(async (url, init) => {
    if (url.endsWith("/demo/sessions")) {
      restored = true;
      return ok({ session: { token: "renewed", expiresAt: "2027-01-01" }, user, created: false });
    }
    if (url.endsWith("/bookings") && init.method === "POST") {
      posts += 1;
      return ok({ error: { code: "session_expired", message: "Expired" } }, 401);
    }
    if (url.endsWith("/bookings/me")) return restored
      ? ok({ booking: bookingOf() })
      : ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  await click("Confirm one spot");
  await settle();
  expect(document.body.textContent).toContain("booking-booker");
  expect(document.querySelector('[aria-label="Checkout"]')!.textContent).toContain(user.email);
  expect(posts).toBe(1);
});

it.each([
  ["activity_sold_out", "This activity just filled", { remainingSpots: 0, bookedCount: 2 }],
  ["activity_started", "This activity has already started", { started: true }],
] as const)("when checkout confirmation returns %s, readable details remain and availability refreshes", async (code, message, changed) => {
  let posted = false;
  let refreshes = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") {
      posted = true;
      return ok({ error: { code, message } }, 409);
    }
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/activities/a")) {
      if (posted) refreshes += 1;
      return ok({ activity: detailOf("a", posted ? changed : {}), invites: {} });
    }
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  await click("Confirm one spot");
  await settle();
  expect(document.body.textContent).toContain(message);
  expect(document.querySelector('[aria-label="Checkout"]')!.textContent).toContain("€10.50");
  expect(document.body.textContent).toContain("Activity a");
  expect(document.body.textContent).not.toContain("Your spot is saved");
  expect([...document.querySelectorAll("button")].some(button => button.textContent === "Confirm one spot")).toBe(false);
  expect(refreshes).toBeGreaterThan(0);
});

it("when an account shortcut is selected during checkout, unmounting email entry cannot cancel the selected account", async () => {
  let entry = deferred<Awaited<ReturnType<Transport>>>();
  const emails: string[] = [];
  let posts = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/demo/sessions")) {
      emails.push(JSON.parse(init.body!).email);
      return entry.promise;
    }
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/bookings") && init.method === "POST") posts += 1;
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/my/bookings")) return ok({ bookings: [] });
    if (url.endsWith("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  for (const account of ["Host", "Booker"]) {
    const email = `${account.toLowerCase()}@velio.test`;
    await click(account);
    await settle();
    await act(async () => entry.resolve(ok({
      session: { token: `${account}-token`, expiresAt: "2027-01-01" },
      user: { ...user, id: account, email, displayName: `${account} account` },
      created: false,
    })));
    await settle();
    expect(document.querySelector(".account-viewing")?.textContent).toContain(`${account} account`);
    expect(document.body.textContent).not.toContain("Opening account…");
    expect(document.querySelector('[aria-label="Checkout"]')!.textContent).toContain(email);
    entry = deferred<Awaited<ReturnType<Transport>>>();
  }
  expect(emails).toEqual(["host@velio.test", "booker@velio.test"]);
  expect(posts).toBe(0);
});

it("when availability refreshes while an activity stays open, viewing telemetry is sent once until the account changes", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const observations: Array<{ eventId: string; authorization?: string }> = [];
  let snapshots = 0;
  try {
    await mount(async (url, init) => {
      if (url.endsWith("/client-events")) {
        const body = JSON.parse(init.body!);
        if (body.type === "activity_viewed") observations.push({ eventId: body.eventId, authorization: init.headers.authorization });
        return ok({ error: { code: "request_limit", message: "wait" } }, 429);
      }
      if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
      if (url.endsWith("/my/activities")) return ok({ activities: [] });
      if (url.endsWith("/activities/a")) {
        snapshots += 1;
        return ok({ activity: detailOf("a"), invites: {} });
      }
      if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
      return ok({});
    });
    expect(observations).toHaveLength(1);
    const socket = ScriptedLiveSocket.instances.at(-1)!;
    await act(async () => socket.open());
    await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
    for (let i = 0; i < 3; i++) {
      await act(async () => vi.advanceTimersByTime(5000));
      await settle();
    }
    await act(async () => socket.receive({ type: "availability", activityId: "a", version: "7", remainingSpots: 0, eventId: null }));
    await settle();
    expect(snapshots).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).toContain("0 of 2 spots left");
    expect(observations).toHaveLength(1);
    await click("Sign out");
    await settle();
    expect(observations).toHaveLength(2);
    expect(observations[0]!.authorization).toBe("Bearer booker-token");
    expect(observations[1]!.authorization).toBeUndefined();
    expect(observations[1]!.eventId).not.toBe(observations[0]!.eventId);
  } finally { vi.useRealTimers(); }
});

it("when the selected activity's live availability advances, its browse row shows the same newer count", async () => {
  await mount(async (url) => {
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/bookings")) return ok({ bookings: [] });
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await settle();
  expect(document.body.textContent).toContain("1 of 2 spots left");
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  await act(async () => socket.receive({ type: "availability", activityId: "a", version: "2", remainingSpots: 0, eventId: null }));
  await settle();
  // The detail applies the newer frame, and the browse row shows the same
  // count once the grid is reached again through the back link.
  expect(document.body.textContent).toContain("0 of 2 spots left");
  await click("Back to Explore");
  await settle();
  expect(document.querySelector(".activity-card")!.textContent).toContain("No spots left");
});

it("when the activity fills during checkout, the booking control shows Full and sends no booking request", async () => {
  ScriptedLiveSocket.instances.length = 0;
  let posts = 0;
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") { posts += 1; return ok(bookingEnvelope(true), 201); }
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  await act(async () => socket.receive({ type: "availability", activityId: "a", version: "7", remainingSpots: 0, eventId: null }));
  await settle();
  const buttons = [...document.querySelectorAll("button")];
  expect(buttons.find(b => b.textContent === "Confirm one spot")).toBeUndefined();
  expect(buttons.find(b => b.textContent === "Full")?.disabled).toBe(true);
  expect(posts).toBe(0);
});

it("when a booking is confirmed from checkout, Back to activity returns to the full activity page", async () => {
  await mount(async (url, init) => {
    if (url.endsWith("/bookings") && init.method === "POST") return ok(bookingEnvelope(true), 201);
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  });
  await click("Book a spot");
  await click("Confirm one spot");
  await settle();
  expect(document.body.textContent).toContain("Your spot is saved");
  expect(document.body.textContent).not.toContain("About this activity");
  await click("Back to activity");
  await settle();
  expect(document.querySelector('[aria-label="Checkout"]')).toBeNull();
  expect(document.body.textContent).toContain("About this activity");
  expect(document.querySelector('[aria-label="Saved booking"]')!.textContent).toContain("booking-booker");
});

it("when an invitation link is opened and left, the unpublished draft is kept", async () => {
  await mount(async (url) => {
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/my/bookings")) return ok({ bookings: [] });
    if (url.includes("/invites/")) return ok({ error: { code: "invite_not_found", message: "Not found" } }, 404);
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  }, { activity: "" });
  await click("Publish activity");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("#pub-title")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "My draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  history.pushState(null, "", "/?invite=ABC123");
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await settle();
  expect(document.querySelector(".invite-landing")).not.toBeNull();
  history.pushState(null, "", "/");
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await settle();
  await click("Publish activity");
  expect(document.querySelector<HTMLInputElement>("#pub-title")!.value).toBe("My draft");
});

it("when a card opens the activity page, focus lands on its heading", async () => {
  await mount(async (url) => {
    if (url.endsWith("/bookings/me")) return ok({ error: { code: "booking_not_found", message: "none" } }, 404);
    if (url.endsWith("/my/activities")) return ok({ activities: [] });
    if (url.endsWith("/participants")) return ok({ error: { code: "forbidden", message: "Owning host only" } }, 403);
    if (url.includes("/activities/a")) return ok({ activity: detailOf("a"), invites: {} });
    if (url.endsWith("/activities")) return ok({ activities: [listItem("a")] });
    return ok({});
  }, { activity: "" });
  await act(async () => document.querySelector<HTMLButtonElement>(".activity-card")!.click());
  await settle();
  expect(document.activeElement?.id).toBe("guest-detail-heading");
});
