import { useEffect, useRef, useState } from "react";
import { API_BASE, type VelioApi } from "../api.js";

/**
 * One live-availability lifecycle owner (issue #18, PLANS 3.4,
 * docs/client-contract.md §6) reused by the visible host detail, the direct
 * guest detail and the invitation activity facts. The owner owns the whole
 * recovery protocol: register measurement and subscribe before any snapshot
 * fetch, apply only strictly newer availability (BigInt comparison — never
 * Number), refetch on `resnapshot`, on reconnect, on foreground return and
 * every five seconds while the view is visible, and reconnect with a bounded
 * backoff. Booking mutation and reconciliation stay in booking-store.ts:
 * live facts never confirm membership and never replay a POST.
 *
 * Acknowledgements are a measurement capability, not authentication: an
 * application is acknowledged only after the rendered facts actually show
 * its version (useLiveAcknowledgement beside the surface's committed
 * render), carrying the server-issued connection id, the exact event for a
 * websocket application, and the refresh reason for a snapshot. A superseded
 * application is never acknowledged late, a dead socket's callbacks never
 * act for its replacement, and a failed acknowledgement never blocks the view.
 */

export type AckSource = "websocket" | "snapshot";
export type AckReason = "interval" | "reconnect" | "foreground";
export type LiveConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface AvailabilityFacts {
  availabilityVersion: string;
  remainingSpots: number;
}

export interface LiveSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface AppliedAvailability {
  activityId: string;
  /** Digits-only monotonic availability version; compare with compareVersions. */
  version: string;
  remainingSpots: number;
  source: AckSource;
  reason: AckReason;
  /** The committed confirmation event for a websocket application. */
  eventId: string | null;
  /** Server-issued measurement capability of the socket that delivered it. */
  connectionId: string | null;
  /** Monotonic within one mounted owner: later applications supersede earlier. */
  seq: number;
}

export interface LiveAvailability {
  readonly applied: AppliedAvailability | null;
  /** The newest application awaiting its rendered acknowledgement. */
  readonly pendingAck: AppliedAvailability | null;
  readonly connection: LiveConnectionState;
  /** Known loss or failed refresh: the displayed facts may be out of date. */
  readonly stale: boolean;
  acknowledgeRendered(application: AppliedAvailability): void;
}

export interface LiveAvailabilityOptions {
  activityId: string | null;
  visible: boolean;
  /** The availability version the surface currently renders — the ack watermark. */
  displayedVersion: string | null;
  loadSnapshot: (signal: AbortSignal) => Promise<AvailabilityFacts>;
  api: Pick<VelioApi, "postAvailabilityAck">;
  socketFactory?: (url: string) => LiveSocketLike;
}

const VERSION_PATTERN = /^[0-9]{1,19}$/;

/** Arbitrary-precision ordering; an unparsable version is never newer. */
export function compareVersions(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return -1;
  }
}

export interface ParsedAvailabilityFrame {
  activityId: string;
  version: string;
  remainingSpots: number;
  eventId: string | null;
}

/** External frames are parsed defensively; anything else is ignored. */
export function parseAvailabilityFrame(raw: string, activityId: string): ParsedAvailabilityFrame | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const frame = message as Record<string, unknown>;
  if (frame.type !== "availability" || frame.activityId !== activityId) return null;
  if (typeof frame.version !== "string" || !VERSION_PATTERN.test(frame.version)) return null;
  if (typeof frame.remainingSpots !== "number" || !Number.isSafeInteger(frame.remainingSpots) || frame.remainingSpots < 0) {
    return null;
  }
  if (frame.eventId !== null && frame.eventId !== undefined && typeof frame.eventId !== "string") return null;
  return {
    activityId,
    version: frame.version,
    remainingSpots: frame.remainingSpots,
    eventId: frame.eventId === undefined ? null : frame.eventId,
  };
}

/** The api base mapped to a websocket: through the dev proxy, or origin-swapped. */
export function liveSocketUrl(baseUrl: string, protocol: string, host: string): string {
  if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) {
    const url = new URL(baseUrl);
    url.protocol = `${url.protocol === "https:" ? "wss" : "ws"}:`;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/live`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${host}${baseUrl.replace(/\/$/, "")}/live`;
}

const defaultSocketFactory = (url: string): LiveSocketLike => new WebSocket(url) as unknown as LiveSocketLike;

interface OwnerState {
  applied: AppliedAvailability | null;
  pendingAck: AppliedAvailability | null;
  connection: LiveConnectionState;
  stale: boolean;
}

const initialOwnerState: OwnerState = { applied: null, pendingAck: null, connection: "connecting", stale: false };

export function useLiveAvailability(options: LiveAvailabilityOptions): LiveAvailability {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<OwnerState>(initialOwnerState);
  const appliedRef = useRef<AppliedAvailability | null>(null);
  const pendingAckRef = useRef<AppliedAvailability | null>(null);
  const connectionRef = useRef<LiveConnectionState>("connecting");
  const connectionIdRef = useRef<string | null>(null);
  const lifecycleReasonRef = useRef<AckReason>("reconnect");
  const seqRef = useRef(0);
  const generationRef = useRef(0);
  const socketRef = useRef<LiveSocketLike | null>(null);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const snapshotControllerRef = useRef<AbortController | null>(null);

  function updateConnection(connection: LiveConnectionState): void {
    connectionRef.current = connection;
    setState((prev) => (prev.connection === connection ? prev : { ...prev, connection }));
  }

  function apply(application: AppliedAvailability): void {
    // An application at or below the version the surface already renders was
    // never a new display: it is recorded, but not queued for acknowledgement.
    const displayed = optionsRef.current.displayedVersion;
    const alreadyDisplayed = displayed !== null && compareVersions(application.version, displayed) <= 0;
    appliedRef.current = application;
    pendingAckRef.current = alreadyDisplayed ? null : application;
    setState((prev) => ({ ...prev, applied: application, pendingAck: pendingAckRef.current, stale: false }));
  }

  function acknowledgeRendered(application: AppliedAvailability): void {
    const pending = pendingAckRef.current;
    // Only the newest application is acknowledged; a superseded one never
    // travels as a newer rendered event.
    if (pending === null || pending.seq !== application.seq || application.connectionId === null) return;
    pendingAckRef.current = null;
    setState((prev) =>
      prev.pendingAck !== null && prev.pendingAck.seq === application.seq ? { ...prev, pendingAck: null } : prev,
    );
    const { connectionId, activityId, version, eventId, source, reason } = application;
    void optionsRef.current.api
      .postAvailabilityAck({
        connectionId,
        activityId,
        appliedVersion: version,
        ...(eventId !== null ? { appliedEventId: eventId } : {}),
        source,
        reason,
      })
      .catch(() => {
        // Measurement failure never vetoes the applied facts or a booking.
      });
  }

  useEffect(() => {
    const activityId = options.activityId;
    const visible = options.visible;

    const clearRetryTimer = (): void => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
    const stopRefreshTimer = (): void => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    const closeSocket = (): void => {
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket !== null) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
    const teardown = (): void => {
      generationRef.current += 1;
      clearRetryTimer();
      stopRefreshTimer();
      snapshotControllerRef.current?.abort();
      closeSocket();
      appliedRef.current = null;
      pendingAckRef.current = null;
      connectionIdRef.current = null;
      setState({ ...initialOwnerState });
    };

    if (activityId === null || !visible) {
      // A hidden surface never keeps a subscription, a timer or fetched state.
      teardown();
      return;
    }

    const generation = ++generationRef.current;
    lifecycleReasonRef.current = "reconnect";
    const apiBase = API_BASE;

    const sendFrame = (frame: Record<string, unknown>): void => {
      const socket = socketRef.current;
      if (socket === null || connectionIdRef.current === null) return;
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // A closing socket is recovered by its close handler.
      }
    };

    const fetchSnapshot = (reason: AckReason): void => {
      if (generation !== generationRef.current) return;
      snapshotControllerRef.current?.abort();
      const controller = new AbortController();
      snapshotControllerRef.current = controller;
      void optionsRef.current
        .loadSnapshot(controller.signal)
        .then((facts) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          const current = appliedRef.current;
          if (current !== null && compareVersions(facts.availabilityVersion, current.version) <= 0) {
            // Equal or older database state: the caller refreshed its
            // metadata, the displayed counts stay untouched, and an equal
            // snapshot is never acknowledged as a newer rendered event. A
            // successful database fetch is the reconciliation that clears a
            // stale indication.
            setState((prev) => (prev.stale ? { ...prev, stale: false } : prev));
            return;
          }
          apply({
            activityId,
            version: facts.availabilityVersion,
            remainingSpots: facts.remainingSpots,
            source: "snapshot",
            reason,
            eventId: null,
            connectionId: connectionIdRef.current,
            seq: ++seqRef.current,
          });
        })
        .catch(() => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          // A failed refresh is known loss: cached availability may be stale.
          setState((prev) => (prev.stale ? prev : { ...prev, stale: true }));
        });
    };

    const applyFrame = (frame: ParsedAvailabilityFrame): void => {
      const current = appliedRef.current;
      if (current !== null && compareVersions(frame.version, current.version) <= 0) return;
      apply({
        activityId,
        version: frame.version,
        remainingSpots: frame.remainingSpots,
        source: "websocket",
        reason: lifecycleReasonRef.current,
        eventId: frame.eventId,
        connectionId: connectionIdRef.current,
        seq: ++seqRef.current,
      });
    };

    const handleFrame = (raw: string): void => {
      if (generation !== generationRef.current) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const frame = message as Record<string, unknown>;
      if (frame.type === "measurement_registered" && typeof frame.connectionId === "string") {
        connectionIdRef.current = frame.connectionId;
        const pending = pendingAckRef.current;
        if (pending !== null && pending.connectionId === null) {
          const withCapability: AppliedAvailability = { ...pending, connectionId: frame.connectionId };
          pendingAckRef.current = withCapability;
          setState((prev) => ({ ...prev, pendingAck: withCapability }));
        }
        return;
      }
      if (frame.type === "subscribed" && frame.activityId === activityId) {
        retryAttemptRef.current = 0;
        updateConnection("live");
        // Recovery protocol: subscribe first; the snapshot fetch starts only
        // on the established subscription so no commit can slip between.
        fetchSnapshot(lifecycleReasonRef.current);
        return;
      }
      if (frame.type === "resnapshot") {
        fetchSnapshot("reconnect");
        return;
      }
      if (frame.type === "availability") {
        const parsed = parseAvailabilityFrame(raw, activityId);
        if (parsed !== null) applyFrame(parsed);
      }
      // Error and unknown frames leave the socket open and are ignored.
    };

    const startSocket = (): void => {
      clearRetryTimer();
      closeSocket();
      connectionIdRef.current = null;
      let socket: LiveSocketLike;
      try {
        socket = (optionsRef.current.socketFactory ?? defaultSocketFactory)(
          liveSocketUrl(apiBase, window.location.protocol, window.location.host),
        );
      } catch {
        updateConnection(window.navigator.onLine === false ? "offline" : "reconnecting");
        scheduleRetry();
        return;
      }
      socketRef.current = socket;
      const thisSocket = socket;
      socket.onopen = () => {
        if (socketRef.current !== thisSocket || generation !== generationRef.current) return;
        try {
          // Opt-in measurement first (idempotent per socket), then the
          // subscription whose acknowledgement opens the snapshot window.
          socket.send(JSON.stringify({ type: "register_measurement", visible: document.visibilityState === "visible" }));
          socket.send(JSON.stringify({ type: "subscribe", activityId }));
        } catch {
          // A closing socket is recovered by its close handler.
        }
      };
      socket.onmessage = (event) => {
        if (socketRef.current !== thisSocket || generation !== generationRef.current) return;
        handleFrame(String(event.data));
      };
      socket.onclose = () => {
        if (socketRef.current !== thisSocket || generation !== generationRef.current) return;
        connectionIdRef.current = null; // A replacement socket registers anew.
        updateConnection(window.navigator.onLine === false ? "offline" : "reconnecting");
        setState((prev) => (prev.stale ? prev : { ...prev, stale: true }));
        scheduleRetry();
      };
      socket.onerror = () => {
        // The close event follows; nothing to do here.
      };
    };

    const scheduleRetry = (): void => {
      clearRetryTimer();
      const delay = Math.min(1000 * 2 ** retryAttemptRef.current, 5000);
      retryAttemptRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (generation === generationRef.current) startSocket();
      }, delay);
    };

    const startRefreshTimer = (): void => {
      stopRefreshTimer();
      refreshTimerRef.current = window.setInterval(() => {
        if (generation !== generationRef.current) return;
        if (document.visibilityState !== "visible") return;
        fetchSnapshot("interval");
      }, 5000);
    };

    const handleVisibilityChange = (): void => {
      if (generation !== generationRef.current) return;
      if (document.visibilityState === "visible") {
        lifecycleReasonRef.current = "foreground";
        sendFrame({ type: "visibility", visible: true });
        if (connectionRef.current !== "live") startSocket();
        startRefreshTimer();
        fetchSnapshot("foreground");
      } else {
        sendFrame({ type: "visibility", visible: false });
        stopRefreshTimer();
      }
    };
    const handleOffline = (): void => {
      if (generation === generationRef.current && connectionRef.current !== "live") updateConnection("offline");
    };
    const handleOnline = (): void => {
      if (generation === generationRef.current && connectionRef.current === "offline") updateConnection("reconnecting");
    };

    startSocket();
    startRefreshTimer();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      teardown();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.activityId, options.visible]);

  return {
    applied: state.applied,
    pendingAck: state.pendingAck,
    connection: state.connection,
    stale: state.stale,
    acknowledgeRendered,
  };
}

/**
 * The render gate for acknowledgements: call it beside the committed render
 * that displays the surface's facts. An application is acknowledged only
 * when the rendered version equals the applied one — message receipt alone
 * never qualifies.
 */
export function useLiveAcknowledgement(live: LiveAvailability, displayedVersion: string | null): void {
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    const pending = liveRef.current.pendingAck;
    if (pending === null || pending.connectionId === null) return;
    if (displayedVersion === null || displayedVersion !== pending.version) return;
    liveRef.current.acknowledgeRendered(pending);
  }, [live.pendingAck, displayedVersion]);
}
