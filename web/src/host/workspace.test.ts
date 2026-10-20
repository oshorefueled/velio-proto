// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  id: "host",
  displayName: "Host",
  contactKey: "host",
  signupSource: "direct",
  signupGeneration: 0,
};
const activity = (id: string) => ({
  id,
  title: `Activity ${id}`,
  hostDisplayName: "Host",
  hostId: "host",
  planId: `plan-${id}`,
  startsAt: "2025-01-01T12:00:00Z",
  timezone: "UTC",
  priceMinorUnits: 1050,
  currency: "EUR",
  capacity: 4,
  bookedCount: 1,
  remainingSpots: 3,
  availabilityVersion: "1",
  started: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}
async function mount(transport: Transport) {
  localStorage.setItem(
    "velio.session.v1",
    JSON.stringify({ token: "host-token", user }),
  );
  window.history.replaceState(null, "", "/?activity=a");
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root!.render(
      createElement(SessionProvider, {
        transport,
        children: createElement(App),
      }),
    ),
  );
  await settle();
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
function transportWith(override: Transport): Transport {
  return async (url, init) => {
    if (url.endsWith("/client-events")) return override(url, init);
    if (url.endsWith("/bookings/me")) return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    if (url.endsWith("/my/activities"))
      return {
        status: 200,
        json: { activities: [activity("a"), activity("b")] },
      };
    if (url.endsWith("/activities"))
      return { status: 200, json: { activities: [] } };
    if (url.endsWith("/participants"))
      return {
        status: 200,
        json: {
          activityId: "a",
          planId: "plan-a",
          confirmedCount: 1,
          participants: [{ userId: "booker", displayName: "Private Booker" }],
        },
      };
    return override(url, init);
  };
}
it("when activity details fail, Retry reloads the same selected activity", async () => {
  let failed = true;
  await mount(
    transportWith(async (url, init) =>
      url.endsWith("/client-events")
        ? { status: 200, json: {} }
        : init.headers.authorization !== undefined && failed
          ? { status: 500, json: {} }
          : { status: 200, json: { activity: activity("a"), invites: {} } },
    ),
  );
  expect(document.body.textContent).toContain("Request failed");
  failed = false;
  await click("Retry");
  await settle(4);
  expect(document.querySelector("#guest-detail-heading")?.textContent).toBe(
    "Activity a",
  );
});

it("when details are observed, activity_viewed is sent only after the title is committed to the DOM", async () => {
  const titles: Array<string | null | undefined> = [];
  await mount(
    transportWith(async (url) => {
      if (url.endsWith("/client-events")) {
        titles.push(document.querySelector("#guest-detail-heading")?.textContent);
        return { status: 200, json: {} };
      }
      return { status: 200, json: { activity: activity("a"), invites: {} } };
    }),
  );
  // Re-mounts of the same observation re-emit the same event id (the server
  // deduplicates), but never before the title is committed.
  expect(titles.length).toBeGreaterThanOrEqual(1);
  expect(new Set(titles)).toEqual(new Set(["Activity a"]));
  expect(document.body.textContent).toContain("10.50");
});
it.each([200, 401])(
  "when a prior identity's hosted request returns %s after re-selection, it cannot replace or expire the current workspace",
  async (status) => {
    const pending = deferred<{ status: number; json: unknown }>();
    let first = true;
    await mount(async (url) => {
      if (url.endsWith("/my/activities")) {
        if (first) {
          first = false;
          return pending.promise;
        }
        return { status: 200, json: { activities: [activity("new")] } };
      }
      if (url.endsWith("/activities")) return { status: 200, json: { activities: [] } };
      if (url.endsWith("/demo/sessions"))
        return {
          status: 200,
          json: {
            session: { token: "new-token", expiresAt: "2027-01-01" },
            user: { ...user, id: "new", displayName: "New Host" },
            created: true,
          },
        };
      if (url.endsWith("/participants"))
        return {
          status: 403,
          json: { error: { code: "forbidden", message: "Owning host only" } },
        };
      if (url.endsWith("/client-events")) return { status: 200, json: {} };
      return { status: 200, json: { activity: activity("a"), invites: {} } };
    });
    await click("Sign out");
    await click("Sign in");
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('[name="email"]')!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLInputElement>('[name="email"]')!.closest("form")!.requestSubmit());
    await act(async () =>
      pending.resolve(
        status === 200
          ? {
              status: 200,
              json: {
                activities: [
                  { ...activity("old"), title: "Old private activity" },
                ],
              },
            }
          : {
              status: 401,
              json: {
                error: {
                  code: "session_expired",
                  message: "Old session expired",
                },
              },
            },
      ),
    );
    expect(document.body.textContent).toContain("New Host");
    expect(document.body.textContent).not.toContain("Old private activity");
    expect(document.body.textContent).not.toContain("Your session expired");
  },
);
const visibleHeading = () => [...document.querySelectorAll("h1")].find(h => !h.closest("[hidden]"))?.textContent;
it("when navigating from a detail to the activity lists, each list opens and the detail leaves no extra live owner or observation", async () => {
  ScriptedLiveSocket.instances.length = 0;
  const eventIds: string[] = [];
  await mount(transportWith(async url => {
    if (url.endsWith("/client-events")) { eventIds.push("observed"); return { status: 200, json: {} }; }
    return { status: 200, json: { activity: activity("a"), invites: {} } };
  }));
  expect(document.querySelectorAll("#guest-detail-heading")).toHaveLength(1);
  await click("Explore");
  await settle();
  expect(visibleHeading()).toBe("Explore activities");
  expect(document.querySelector('nav [aria-current="page"]')?.textContent).toBe("Explore");
  await click("My activities");
  await settle();
  expect(visibleHeading()).toBe("My activities");
  expect(document.querySelector('nav [aria-current="page"]')?.textContent).toBe("My activities");
  expect(document.querySelectorAll("#guest-detail-heading")).toHaveLength(0);
  expect(window.location.search).not.toContain("activity=");
  expect(ScriptedLiveSocket.instances).toHaveLength(1);
  expect(eventIds).toHaveLength(1);
});

it("when a live booking frame is newer, the host sees updated spots and participants without refresh and the rendered application is acknowledged", async () => {
  ScriptedLiveSocket.instances.length = 0;
  const acks: Array<{ body: Record<string, unknown>; dom: string }> = [];
  let published = false;
  await mount(async (url, init) => {
    if (url.endsWith("/availability-acks")) {
      acks.push({ body: JSON.parse(init.body ?? "{}") as Record<string, unknown>, dom: document.body.textContent ?? "" });
      return { status: 200, json: { ack: {} } };
    }
    if (url.endsWith("/client-events")) return { status: 200, json: {} };
    if (url.endsWith("/bookings/me")) {
      return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    }
    if (url.endsWith("/my/activities")) {
      return { status: 200, json: { activities: [activity("a"), activity("b")] } };
    }
    if (url.endsWith("/participants")) {
      return {
        status: 200,
        json: {
          activityId: "a",
          planId: "plan-a",
          confirmedCount: published ? 2 : 1,
          participants: published
            ? [
                { userId: "booker", displayName: "Private Booker" },
                { userId: "late", displayName: "Late Booker" },
              ]
            : [{ userId: "booker", displayName: "Private Booker" }],
        },
      };
    }
    if (url.endsWith("/activities")) return { status: 200, json: { activities: [] } };
    return {
      status: 200,
      json: {
        activity: published
          ? { ...activity("a"), bookedCount: 2, remainingSpots: 2, availabilityVersion: "2" }
          : activity("a"),
        invites: {},
      },
    };
  });
  expect(document.body.textContent).toContain("1 booked · 3 remaining of 4");
  expect(document.body.textContent).toContain("Private Booker");
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () =>
    socket.receive({ type: "measurement_registered", connectionId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" }),
  );
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  // Establishment snapshot at the same version: counts stay, nothing is acked.
  expect(acks).toHaveLength(0);
  published = true;
  await act(async () =>
    socket.receive({
      type: "availability",
      activityId: "a",
      version: "2",
      remainingSpots: 2,
      eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
    }),
  );
  await settle();
  expect(document.body.textContent).toContain("2 booked · 2 remaining of 4");
  expect(document.body.textContent).toContain("Participants (2)");
  expect(document.body.textContent).toContain("Late Booker");
  expect(acks).toHaveLength(1);
  expect(acks[0].body).toMatchObject({
    appliedVersion: "2",
    source: "websocket",
    appliedEventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  });
  expect(acks[0].dom).toContain("2 booked · 2 remaining of 4");
});

it("when a booking arrives before the initial participant response, the host refreshes that list to the displayed version", async () => {
  ScriptedLiveSocket.instances.length = 0;
  const initialParticipants = deferred<{ status: number; json: unknown }>();
  let participantRequests = 0;
  await mount(async (url) => {
    if (url.endsWith("/participants")) {
      participantRequests += 1;
      if (participantRequests === 1) return initialParticipants.promise;
      return { status: 200, json: { activityId: "a", planId: "plan-a", confirmedCount: 2,
        participants: [{ userId: "late", displayName: "New Participant" }] } };
    }
    if (url.endsWith("/my/activities")) return { status: 200, json: { activities: [activity("a")] } };
    if (url.endsWith("/activities")) return { status: 200, json: { activities: [] } };
    if (url.endsWith("/bookings/me")) return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    if (url.endsWith("/client-events") || url.endsWith("/availability-acks")) return { status: 200, json: {} };
    return { status: 200, json: { activity: activity("a"), invites: {} } };
  });
  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive({ type: "measurement_registered", connectionId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" });
    socket.receive({ type: "subscribed", activityId: "a" });
  });
  await settle();
  await act(async () => socket.receive({ type: "availability", activityId: "a", version: "2", remainingSpots: 2, eventId: null }));
  await settle();
  expect(document.body.textContent).toContain("2 booked · 2 remaining of 4");
  await act(async () => initialParticipants.resolve({ status: 200, json: {
    activityId: "a", planId: "plan-a", confirmedCount: 1,
    participants: [{ userId: "old", displayName: "Original Participant" }],
  } }));
  await settle();
  expect(document.body.textContent).toContain("Participants (2)");
  expect(document.body.textContent).toContain("New Participant");
  expect(participantRequests).toBe(2);
});

it("when an account signs out with an unpublished activity, switching accounts retains its title and itinerary", async () => {
  await mount(transportWith(async (url) => url.endsWith("/demo/sessions")
    ? { status: 200, json: { session: { token: "booker-token" }, user: { ...user, id: "booker", email: "booker@demo.velio.test" } } }
    : { status: 200, json: { activity: activity("a"), invites: {} } }));
  await click("Publish activity");
  await act(async () => {
    const title = document.querySelector<HTMLInputElement>("#pub-title")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Keep my activity draft");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    const itinerary = document.querySelector<HTMLTextAreaElement>("#pub-itinerary")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(itinerary, "Meet at the harbour.");
    itinerary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Sign out");
  await click("Booker");
  await settle();
  expect(document.querySelector<HTMLInputElement>("#pub-title")?.value).toBe("Keep my activity draft");
  expect(document.querySelector<HTMLTextAreaElement>("#pub-itinerary")?.value).toBe("Meet at the harbour.");
});

it("when a newer availability version arrives, the host's participant list refreshes with the new booker's masked email", async () => {
  const booker = { userId: "booker", bookingId: "bk-1", displayName: "Private Booker", maskedEmail: "p***@example.test" };
  const newcomer = { userId: "new", bookingId: "bk-2", displayName: "New Booker", maskedEmail: "n***@example.test" };
  let participantCalls = 0;
  await mount(async (url) => {
    if (url.endsWith("/my/activities")) return { status: 200, json: { activities: [activity("a")] } };
    if (url.endsWith("/participants")) {
      participantCalls += 1;
      const participants = participantCalls === 1 ? [booker] : [booker, newcomer];
      return { status: 200, json: { activityId: "a", planId: "plan-a", confirmedCount: participants.length, participants } };
    }
    if (url.endsWith("/bookings/me")) return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    if (url.endsWith("/activities")) return { status: 200, json: { activities: [] } };
    if (url.endsWith("/client-events") || url.endsWith("/availability-acks")) return { status: 200, json: {} };
    return { status: 200, json: { activity: activity("a"), invites: {} } };
  });
  await settle();
  const list = () => document.querySelector('[aria-label="Booked participants"]')!.textContent;
  expect(list()).toContain("Private Booker");
  expect(list()).toContain("p***@example.test");

  const socket = ScriptedLiveSocket.instances.at(-1)!;
  await act(async () => socket.open());
  await act(async () => socket.receive({ type: "subscribed", activityId: "a" }));
  await settle();
  // An older or equal version never refreshes private details.
  await act(async () => socket.receive({ type: "availability", activityId: "a", version: "1", remainingSpots: 3, eventId: null }));
  await settle();
  expect(participantCalls).toBe(1);

  await act(async () => socket.receive({ type: "availability", activityId: "a", version: "2", remainingSpots: 2, eventId: null }));
  await settle();
  expect(participantCalls).toBe(2);
  expect(list()).toContain("Participants (2)");
  expect(list()).toContain("New Booker");
  expect(list()).toContain("n***@example.test");
});
