// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VelioApi, type Transport } from "../api.js";
import {
  compareVersions,
  liveSocketUrl,
  parseAvailabilityFrame,
  useLiveAcknowledgement,
  useLiveAvailability,
  type AvailabilityFacts,
  type LiveSocketLike,
} from "./availability.js";
import { LiveStatus } from "./LiveStatus.js";

/**
 * Live availability lifecycle owner (issue #18, docs/client-contract.md §6):
 * subscribe before snapshot, apply only strictly newer availability so a
 * duplicate or older update never regresses the displayed count, repair a
 * silently missed update with the visible five-second refresh, resubscribe
 * and refresh on interruption or foreground return, and acknowledge an
 * application only after the committed DOM shows it — with the exact
 * connection capability, version, event, source and refresh reason.
 * Wire envelopes and surface rendering have their canonical owners in
 * api.test.ts and the surface suites; this file owns the shared lifecycle.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVITY = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const CONNECTION = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";

class FakeSocket implements LiveSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    act(() => {
      this.onclose?.();
    });
  }
  open(): void {
    act(() => {
      this.onopen?.();
    });
  }
  receive(frame: unknown): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
}

let root: Root | undefined;
let documentVisible = true;

beforeEach(() => {
  vi.useFakeTimers();
  documentVisible = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    documentVisible ? "visible" : "hidden",
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function ok(json: unknown, status = 200): { status: number; json: unknown } {
  return { status, json };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {});
}

interface Harness {
  sockets: FakeSocket[];
  acks: Array<{ body: Record<string, unknown>; dom: string }>;
  snapshotFetches: number;
  setSnapshotFacts: (facts: AvailabilityFacts) => void;
  holdNextSnapshot: () => void;
  resolveHeldSnapshot: (facts: AvailabilityFacts) => void;
  failSnapshotFetches: () => void;
  recoverSnapshotFetches: () => void;
  failAcks: () => void;
  rerender: (visible: boolean) => Promise<void>;
  dom: () => string;
  state: () => { connection: string; stale: boolean };
}

async function mountOwner(
  initialFacts: AvailabilityFacts = { availabilityVersion: "5", remainingSpots: 1 },
): Promise<Harness> {
  const sockets: FakeSocket[] = [];
  const acks: Harness["acks"] = [];
  let snapshotFetches = 0;
  let snapshotFacts = { ...initialFacts };
  let failSnapshots = false;
  let failAckPosts = false;
  let heldSnapshot: ReturnType<typeof deferred<{ status: number; json: unknown }>> | null = null;

  const transport: Transport = async (url, init) => {
    if (url.endsWith("/availability-acks")) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      acks.push({ body, dom: document.body.textContent ?? "" });
      return ok({}, failAckPosts ? 500 : 200);
    }
    if (url.endsWith(`/activities/${ACTIVITY}`) && init.method === "GET") {
      snapshotFetches += 1;
      if (failSnapshots) return ok({ error: { code: "server_error", message: "down" } }, 500);
      if (heldSnapshot !== null) {
        const pending = heldSnapshot;
        heldSnapshot = null;
        return pending.promise;
      }
      return ok({
        activity: {
          id: ACTIVITY,
          availabilityVersion: snapshotFacts.availabilityVersion,
          remainingSpots: snapshotFacts.remainingSpots,
          capacity: 2,
        },
        invites: {},
      });
    }
    return ok({}, 404);
  };
  const api = new VelioApi(transport);
  const factory = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };

  function OwnerSurface({ visible }: { visible: boolean }): ReactNode {
    const [displayed, setDisplayedState] = useState<{ version: string; remaining: number } | null>(null);
    const live = useLiveAvailability({
      activityId: ACTIVITY,
      visible,
      displayedVersion: displayed?.version ?? null,
      loadSnapshot: async (): Promise<AvailabilityFacts> => {
        const { activity } = await api.getActivity(ACTIVITY);
        return {
          availabilityVersion: activity.availabilityVersion,
          remainingSpots: activity.remainingSpots,
        };
      },
      api,
      socketFactory: factory,
    });
    useLiveAcknowledgement(live, displayed?.version ?? null);
    // Mirrors the production surfaces: applied availability merges into the
    // rendered facts in a committed effect, and an older application never
    // regresses what is already displayed.
    useEffect(() => {
      const applied = live.applied;
      if (applied === null) return;
      setDisplayedState((prev) =>
        prev !== null && compareVersions(applied.version, prev.version) <= 0
          ? prev
          : { version: applied.version, remaining: applied.remainingSpots },
      );
    }, [live.applied]);
    return createElement(
      "section",
      { "data-state": JSON.stringify({ connection: live.connection, stale: live.stale }) },
      createElement(LiveStatus, { live }),
      displayed === null ? "unknown" : `version ${displayed.version} · Spots left: ${displayed.remaining}`,
    );
  }

  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root!.render(createElement(OwnerSurface, { visible: true }));
  });
  await settle();

  return {
    sockets,
    acks,
    get snapshotFetches() {
      return snapshotFetches;
    },
    setSnapshotFacts(facts: AvailabilityFacts) {
      snapshotFacts = { ...facts };
    },
    holdNextSnapshot() {
      heldSnapshot = deferred<{ status: number; json: unknown }>();
    },
    resolveHeldSnapshot(facts: AvailabilityFacts) {
      heldSnapshot?.resolve(
        ok({
          activity: { id: ACTIVITY, ...facts, capacity: 2 },
          invites: {},
        }),
      );
    },
    failSnapshotFetches() {
      failSnapshots = true;
    },
    recoverSnapshotFetches() {
      failSnapshots = false;
    },
    failAcks() {
      failAckPosts = true;
    },
    async rerender(visible: boolean) {
      await act(async () => {
        root!.render(createElement(OwnerSurface, { visible }));
      });
    },
    dom: () => document.body.textContent ?? "",
    state: () => {
      const section = document.querySelector("[data-state]");
      return section === null
        ? { connection: "none", stale: false }
        : (JSON.parse(section.getAttribute("data-state") ?? "{}") as { connection: string; stale: boolean });
    },
  };
}

function establishFirstConnection(harness: Harness): void {
  const socket = harness.sockets[0];
  socket.open();
  socket.receive({ type: "measurement_registered", connectionId: CONNECTION });
  socket.receive({ type: "subscribed", activityId: ACTIVITY });
}

it("when the document returns while a socket is still connecting, replacing it closes the abandoned socket", async () => {
  const harness = await mountOwner();
  documentVisible = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  documentVisible = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(harness.sockets).toHaveLength(2);
  expect(harness.sockets[0].closed).toBe(true);
  await harness.rerender(false);
  expect(harness.sockets.every((socket) => socket.closed)).toBe(true);
});

it("compares availability versions as arbitrary-precision integers, not Numbers", () => {
  expect(compareVersions("9007199254740993", "9007199254740994")).toBe(-1);
  expect(compareVersions("10", "9")).toBe(1);
  expect(compareVersions("7", "7")).toBe(0);
  expect(compareVersions("bogus", "7")).toBe(-1);
});

it("parses only availability frames for the subscribed activity with a digits version and finite spots", () => {
  expect(
    parseAvailabilityFrame(
      JSON.stringify({ type: "availability", activityId: ACTIVITY, version: "3", remainingSpots: 1, eventId: null }),
      ACTIVITY,
    ),
  ).toEqual({ activityId: ACTIVITY, version: "3", remainingSpots: 1, eventId: null });
  expect(parseAvailabilityFrame("not json", ACTIVITY)).toBeNull();
  expect(
    parseAvailabilityFrame(JSON.stringify({ type: "availability", activityId: "other", version: "3", remainingSpots: 1 }), ACTIVITY),
  ).toBeNull();
  expect(
    parseAvailabilityFrame(JSON.stringify({ type: "availability", activityId: ACTIVITY, version: "1e3", remainingSpots: 1 }), ACTIVITY),
  ).toBeNull();
  expect(
    parseAvailabilityFrame(JSON.stringify({ type: "availability", activityId: ACTIVITY, version: "3", remainingSpots: -1 }), ACTIVITY),
  ).toBeNull();
});

it("maps the api base to a proxied same-origin websocket and an origin-swapped absolute url", () => {
  expect(liveSocketUrl("/api", "http:", "localhost:5173")).toBe("ws://localhost:5173/api/live");
  expect(liveSocketUrl("/api", "https:", "velio.example")).toBe("wss://velio.example/api/live");
  expect(liveSocketUrl("https://api.example.com/v0", "https:", "velio.example")).toBe("wss://api.example.com/v0/live");
  expect(liveSocketUrl("http://api.example.com", "https:", "velio.example")).toBe("ws://api.example.com/live");
});

it("when a selected surface becomes visible, the owner registers measurement and subscribes before any snapshot fetch", async () => {
  const harness = await mountOwner();
  expect(harness.sockets).toHaveLength(1);
  expect(harness.sockets[0].sent).toEqual([]);
  expect(harness.snapshotFetches).toBe(0);
  harness.sockets[0].open();
  await settle();
  expect(harness.sockets[0].sent.map((frame) => JSON.parse(frame).type)).toEqual([
    "register_measurement",
    "subscribe",
  ]);
  expect(JSON.parse(harness.sockets[0].sent[0]).visible).toBe(true);
  expect(JSON.parse(harness.sockets[0].sent[1]).activityId).toBe(ACTIVITY);
  expect(harness.snapshotFetches).toBe(0);
  harness.sockets[0].receive({ type: "subscribed", activityId: ACTIVITY });
  await settle();
  expect(harness.snapshotFetches).toBe(1);
  expect(harness.dom()).toContain("Spots left: 1");
});

it("when a live availability frame is newer, the displayed count updates without refresh and the rendered application is acknowledged with exact metadata", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  expect(harness.dom()).toContain("Spots left: 1");
  harness.sockets[0].receive({
    type: "availability",
    activityId: ACTIVITY,
    version: "6",
    remainingSpots: 0,
    eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.dom()).toContain("version 6");
  expect(harness.acks).toHaveLength(2);
  expect(harness.acks[1].body).toEqual({
    connectionId: CONNECTION,
    activityId: ACTIVITY,
    appliedVersion: "6",
    appliedEventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
    source: "websocket",
    reason: "reconnect",
  });
  expect(harness.acks[1].dom).toContain("Spots left: 0");
});

it("when a duplicate or older update arrives after a newer version is applied, the displayed count does not regress and no acknowledgement is sent", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  harness.sockets[0].receive({ type: "availability", activityId: ACTIVITY, version: "6", remainingSpots: 0, eventId: null });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  harness.sockets[0].receive({ type: "availability", activityId: ACTIVITY, version: "6", remainingSpots: 2, eventId: null });
  harness.sockets[0].receive({ type: "availability", activityId: ACTIVITY, version: "5", remainingSpots: 1, eventId: null });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.snapshotFetches).toBe(1);
  expect(harness.acks).toHaveLength(2);
});

it("when a publication is missed while the connection stays open, the next five-second visible refresh repairs the displayed state and acknowledges the snapshot", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  harness.setSnapshotFacts({ availabilityVersion: "6", remainingSpots: 0 });
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  await settle();
  expect(harness.snapshotFetches).toBe(2);
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.dom()).toContain("version 6");
  const intervalAcks = harness.acks.filter((ack) => ack.body.reason === "interval");
  expect(intervalAcks).toHaveLength(1);
  expect(intervalAcks[0].body).toMatchObject({ appliedVersion: "6", source: "snapshot" });
  expect(intervalAcks[0].body.appliedEventId).toBeUndefined();
  expect(intervalAcks[0].dom).toContain("Spots left: 0");
});

it("when the server asks to resnapshot, the owner refetches immediately and applies the database state", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  harness.setSnapshotFacts({ availabilityVersion: "6", remainingSpots: 0 });
  harness.sockets[0].receive({ type: "resnapshot" });
  await settle();
  expect(harness.snapshotFetches).toBe(2);
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.acks).toHaveLength(2);
  expect(harness.acks[1].body).toMatchObject({ appliedVersion: "6", source: "snapshot", reason: "reconnect" });
});

it("when the socket closes, the owner marks availability out of date, reconnects with a new subscription, and clears the indication only after a snapshot applies", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  expect(harness.state().connection).toBe("live");
  harness.setSnapshotFacts({ availabilityVersion: "6", remainingSpots: 0 });
  harness.sockets[0].close();
  await settle();
  expect(harness.state()).toMatchObject({ connection: "reconnecting", stale: true });
  expect(harness.dom()).toContain("out of date");
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await settle();
  expect(harness.sockets).toHaveLength(2);
  harness.sockets[1].open();
  await settle();
  // Socket open alone is not reconciliation: the indication stays until the
  // database snapshot applies.
  expect(harness.state().stale).toBe(true);
  expect(harness.dom()).toContain("out of date");
  harness.sockets[1].receive({ type: "measurement_registered", connectionId: CONNECTION });
  harness.sockets[1].receive({ type: "subscribed", activityId: ACTIVITY });
  await settle();
  expect(harness.state()).toMatchObject({ connection: "live", stale: false });
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.dom()).not.toContain("out of date");
  const reconnectAck = harness.acks.find(
    (ack) => ack.body.source === "snapshot" && ack.body.reason === "reconnect" && ack.body.appliedVersion === "6",
  );
  expect(reconnectAck).toBeDefined();
  // A frame delivered through the dead socket's callback must never apply or
  // acknowledge against the replacement connection.
  harness.sockets[0].receive({ type: "availability", activityId: ACTIVITY, version: "9", remainingSpots: 0, eventId: null });
  await settle();
  expect(harness.dom()).toContain("version 6");
  expect(harness.acks).toHaveLength(2);
});

it("when a snapshot response issued before a newer frame resolves late, the applied count keeps the frame and the stale response is not acknowledged", async () => {
  const harness = await mountOwner();
  harness.holdNextSnapshot();
  establishFirstConnection(harness);
  await settle();
  expect(harness.snapshotFetches).toBe(1);
  expect(harness.dom()).toContain("unknown");
  harness.sockets[0].receive({
    type: "availability",
    activityId: ACTIVITY,
    version: "6",
    remainingSpots: 0,
    eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.acks).toHaveLength(1);
  harness.resolveHeldSnapshot({ availabilityVersion: "5", remainingSpots: 1 });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.acks).toHaveLength(1);
});

it("when the document is hidden the five-second refresh pauses, and returning to the foreground reports visibility and refreshes", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  documentVisible = false;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
  expect(
    harness.sockets[0].sent.some((frame) => JSON.parse(frame).type === "visibility" && JSON.parse(frame).visible === false),
  ).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(10000);
  });
  await settle();
  expect(harness.snapshotFetches).toBe(1);
  harness.setSnapshotFacts({ availabilityVersion: "6", remainingSpots: 0 });
  documentVisible = true;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
  expect(
    harness.sockets[0].sent.some((frame) => JSON.parse(frame).type === "visibility" && JSON.parse(frame).visible === true),
  ).toBe(true);
  expect(harness.dom()).toContain("Spots left: 0");
  const foregroundAcks = harness.acks.filter((ack) => ack.body.reason === "foreground");
  expect(foregroundAcks).toHaveLength(1);
  expect(foregroundAcks[0].body.source).toBe("snapshot");
  expect(foregroundAcks[0].body.appliedVersion).toBe("6");
});

it("when the surface is hidden or unmounted, timers and the socket close so no hidden view keeps polling", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  await harness.rerender(false);
  expect(harness.sockets[0].closed).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(15000);
  });
  await settle();
  expect(harness.snapshotFetches).toBe(1);
  expect(harness.sockets).toHaveLength(1);
  await harness.rerender(true);
  await settle();
  expect(harness.sockets).toHaveLength(2);
});

it("when an acknowledgement transport fails, the applied state stays rendered and the owner neither retries the ack nor disturbs the view", async () => {
  const harness = await mountOwner();
  harness.failAcks();
  establishFirstConnection(harness);
  await settle();
  harness.sockets[0].receive({ type: "availability", activityId: ACTIVITY, version: "6", remainingSpots: 0, eventId: null });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.acks).toHaveLength(2);
  await act(async () => {
    vi.advanceTimersByTime(15000);
  });
  await settle();
  expect(harness.acks).toHaveLength(2);
  expect(harness.dom()).toContain("Spots left: 0");
});

it("when a snapshot refresh fails, the view marks cached availability out of date and a later successful refresh clears it", async () => {
  const harness = await mountOwner();
  establishFirstConnection(harness);
  await settle();
  harness.failSnapshotFetches();
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  await settle();
  expect(harness.state().stale).toBe(true);
  expect(harness.dom()).toContain("out of date");
  harness.recoverSnapshotFetches();
  harness.setSnapshotFacts({ availabilityVersion: "6", remainingSpots: 0 });
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  await settle();
  expect(harness.state().stale).toBe(false);
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.dom()).not.toContain("out of date");
});

it("when the measurement connection id arrives after a frame was applied, the rendered application is acknowledged once the capability is known", async () => {
  const harness = await mountOwner();
  harness.sockets[0].open();
  harness.sockets[0].receive({ type: "subscribed", activityId: ACTIVITY });
  await settle();
  harness.sockets[0].receive({
    type: "availability",
    activityId: ACTIVITY,
    version: "6",
    remainingSpots: 0,
    eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  });
  await settle();
  expect(harness.dom()).toContain("Spots left: 0");
  expect(harness.acks).toHaveLength(0);
  harness.sockets[0].receive({ type: "measurement_registered", connectionId: CONNECTION });
  await settle();
  expect(harness.acks).toHaveLength(1);
  expect(harness.acks[0].body).toMatchObject({ connectionId: CONNECTION, appliedVersion: "6" });
});
