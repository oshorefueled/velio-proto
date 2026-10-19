import { consumeFixedWindowQuota } from "../ratelimit.js";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { AvailabilityUpdate } from "./publication.js";
import { availabilityChannel } from "./publication.js";
import {
  markPresenceInactive,
  registerMeasurementConnection,
  setPresenceVisibility,
  upsertPresence,
} from "./presence.js";

/**
 * Live gateway (PLANS.md 3.4): a websocket endpoint at GET /live where public
 * viewers subscribe to activities and receive committed availability updates
 * fanned out from the environment-prefixed Redis Pub/Sub channel. Frames
 * carry public data only — activity id, monotonic availability version
 * (string, safe for bigint), remaining spots and the committed event id;
 * participant identities, names and private invitation data are never
 * broadcast.
 *
 * Delivery deliberately flows through Redis even for this process's own
 * publications, so subscribers handle exactly one message shape. Pub/Sub has
 * no replay: whenever the gateway's subscription (re)connects, every
 * connected socket is told to resnapshot from the database.
 *
 * Protocol (documented in README):
 *   client -> {type:"subscribe", activityId} | {type:"unsubscribe", activityId}
 *             | {type:"register_measurement", visible}  (opt-in, once per socket)
 *             | {type:"visibility", visible}            (opt-in follow-up)
 *   server -> {type:"availability", ...} | {type:"resnapshot"} |
 *             {type:"subscribed", activityId} |
 *             {type:"measurement_registered", connectionId} |
 *             {type:"error", code:"invalid_message"} (socket stays open)
 *
 * Measurement registration is opt-in and compatible: plain subscribe-only
 * clients keep receiving updates and are simply never expected viewers. A
 * registered connection receives a server-issued opaque connection id — a
 * measurement capability, never person authentication — and its presence
 * (activity, visibility, liveness lease) is owned by the server in
 * PostgreSQL, so capture works across API instances (PLANS 4.2).
 */

interface RegisteredSocket {
  socket: { send: (payload: string) => void; close?: () => void };
  subscriptions: Set<string>;
  measurement?: { connectionId: string; visible: boolean };
}

export interface LiveGatewayDeps {
  redis: Redis;
  channelPrefix: string;
  /** Presence owner for measurement-registered connections (PLANS 4.2). */
  pool: import("pg").Pool;
  instanceId: string;
  leaseSeconds: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerLiveRoutes(app: FastifyInstance, deps: LiveGatewayDeps): void {
  const channel = availabilityChannel(deps.channelPrefix);
  const sockets = new Set<RegisteredSocket>();
  const measurementConnections = new Set<string>();
  let subscriber: Redis | undefined;

  const deliver = (payload: string) => {
    // Availability frames go only to sockets subscribed to their activity;
    // frames without an activity id (resnapshot) reach everyone.
    let activityId: string | undefined;
    try {
      activityId = (JSON.parse(payload) as { activityId?: string }).activityId;
    } catch {
      return; // never forward anything unparsable
    }
    for (const entry of sockets) {
      if (activityId !== undefined && !entry.subscriptions.has(activityId)) {
        continue;
      }
      try {
        entry.socket.send(payload);
      } catch {
        // A closing socket is cleaned up by its own close handler.
      }
    }
  };

  const subscriberRedis: Redis = deps.redis.duplicate();
  subscriberRedis.on("error", () => {
    // Reconnection is ioredis's job; connected viewers are told to
    // resnapshot when the subscription comes back (see the ready handler).
  });
  // Ready permits commands; only the SUBSCRIBE acknowledgement closes the
  // delivery gap. Refetching earlier can miss a commit made before Redis
  // starts delivering this channel.
  subscriberRedis.on("ready", () => {
    void subscriberRedis.subscribe(channel).then(() => {
      deliver(JSON.stringify({ type: "resnapshot" }));
    }).catch(() => {
      // The next ready cycle resubscribes.
    });
  });
  subscriberRedis.on("message", (_channelName, payload) => {
    // Forward the committed update verbatim; its shape is ours.
    deliver(payload);
  });
  subscriber = subscriberRedis;

  // Liveness leases stand in for the close event an instance's crash never
  // sends: while the process lives it renews its own connections, and after
  // a crash the rows expire instead of counting as present forever.
  const leaseTimer = setInterval(
    () => {
      void import("./presence.js").then(({ refreshInstanceLeases }) =>
        refreshInstanceLeases(deps.pool, deps.instanceId, deps.leaseSeconds, [
          ...measurementConnections,
        ]),
      ).catch(() => {
        // An expired lease is the safe direction: the viewer stops counting
        // as present until the next successful renewal.
      });
    },
    Math.max(1, Math.floor(deps.leaseSeconds / 3)) * 1000,
  );
  leaseTimer.unref();

  app.get("/live", { websocket: true }, (socket, request) => {
    const registered: RegisteredSocket = { socket, subscriptions: new Set() };
    sockets.add(registered);

    const send = (payload: object) => {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // A closing socket is cleaned up by its close handler.
      }
    };

    let pending = Promise.resolve();
    let queued = 0;
    let closed = false;
    let frameWindow = Date.now();
    let framesInWindow = 0;
    const handleMessage = async (raw: unknown) => {
      if (closed) return;
      let message: { type?: unknown; activityId?: unknown; visible?: unknown };
      try {
        message = JSON.parse(String(raw));
      } catch {
        send({ type: "error", code: "invalid_message" });
        return;
      }
      if (message === null || typeof message !== "object") {
        send({ type: "error", code: "invalid_message" });
        return;
      }

      // Opt-in measurement registration: one per socket, idempotent on
      // repeat. The identifier is server-issued; the client's visibility
      // report is stored but never treated as proof of attention.
      if (message.type === "register_measurement") {
        if (typeof message.visible !== "boolean") {
          send({ type: "error", code: "invalid_message" });
          return;
        }
        if (registered.measurement) {
          send({
            type: "measurement_registered",
            connectionId: registered.measurement.connectionId,
          });
          return;
        }
        await consumeFixedWindowQuota(deps.redis, {
          scope: "measurement-register", ip: request.ip,
          limits: { perIdentity: 60, perIp: 60, windowSeconds: 3600 },
        });
        const connectionId = await registerMeasurementConnection(deps.pool, {
          instanceId: deps.instanceId,
          leaseSeconds: deps.leaseSeconds,
          activities: [...registered.subscriptions],
          visible: message.visible,
        });
        registered.measurement = { connectionId, visible: message.visible };
        measurementConnections.add(connectionId);
        send({ type: "measurement_registered", connectionId });
        return;
      }

      if (message.type === "visibility") {
        if (!registered.measurement || typeof message.visible !== "boolean") {
          send({ type: "error", code: "invalid_message" });
          return;
        }
        registered.measurement.visible = message.visible;
        // Ordered with subscription and close, so subsequent frames cannot
        // overtake a foreground/background transition.
        await setPresenceVisibility(deps.pool, registered.measurement.connectionId, message.visible);
        return;
      }

      if (
        (message.type !== "subscribe" && message.type !== "unsubscribe") ||
        typeof message.activityId !== "string" ||
        !UUID_PATTERN.test(message.activityId)
      ) {
        send({ type: "error", code: "invalid_message" });
        return;
      }
      const activityId = message.activityId.toLowerCase();
      if (message.type === "subscribe") {
        if (!registered.subscriptions.has(activityId) && registered.subscriptions.size >= 100) {
          send({ type: "error", code: "subscription_limit" });
          return;
        }
        registered.subscriptions.add(activityId);
        if (registered.measurement) {
          // Presence is persisted before the acknowledgement, so a booking
          // that starts after the ack can capture this viewer (ticket #9:
          // the subscribed ack closes the registration window).
          await upsertPresence(
            deps.pool,
            registered.measurement.connectionId,
            activityId,
            registered.measurement.visible,
          );
          send({ type: "subscribed", activityId });
        } else {
          send({ type: "subscribed", activityId });
        }
      } else {
        registered.subscriptions.delete(activityId);
        if (registered.measurement) {
          // Retained, not deleted: captured history keeps its context.
          await markPresenceInactive(deps.pool, registered.measurement.connectionId, activityId);
        }
      }
    };

    socket.on("message", (raw: unknown) => {
      if (Date.now() - frameWindow >= 60_000) {
        frameWindow = Date.now();
        framesInWindow = 0;
      }
      framesInWindow += 1;
      if (queued >= 32 || framesInWindow > 240) {
        socket.close(1008, "Too many pending frames");
        return;
      }
      queued += 1;
      pending = pending.then(() => handleMessage(raw)).catch(() => {
        send({ type: "error", code: "invalid_message" });
        socket.close(1011, "Presence unavailable");
      }).finally(() => { queued -= 1; });
    });

    socket.on("close", () => {
      closed = true;
      sockets.delete(registered);
      pending = pending.then(async () => {
        registered.subscriptions.clear();
        if (registered.measurement) {
          measurementConnections.delete(registered.measurement.connectionId);
          await markPresenceInactive(deps.pool, registered.measurement.connectionId);
        }
      }).catch(() => {});
    });
  });

  // Graceful shutdown: drop the duplicated subscription connection so the
  // process can exit while the main Redis connection is closed by its owner.
  app.addHook("onClose", async () => {
    clearInterval(leaseTimer);
    for (const entry of sockets) {
      entry.socket.close?.();
    }
    sockets.clear();
    void subscriber?.disconnect();
  });
}

export type { AvailabilityUpdate };
