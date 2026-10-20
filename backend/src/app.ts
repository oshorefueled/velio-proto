import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { createDependencies } from "./deps.js";
import { registerBookingRoutes } from "./booking/routes.js";
import { registerActivitiesRoutes } from "./activities/routes.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { registerInvitesRoutes } from "./invites/routes.js";
import { registerClientEventsRoutes } from "./clientevents/routes.js";
import websocketPlugin from "@fastify/websocket";
import { registerLiveRoutes } from "./live/gateway.js";
import { createLivePublication } from "./live/publication.js";
import { registerMetricsRoutes } from "./metrics/routes.js";
import { registerReadyz } from "./routes/readyz.js";

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });
  const deps = createDependencies(config);

  app.register(registerReadyz, { deps, readyCheckTimeoutMs: config.readyCheckTimeoutMs });
  app.register(registerIdentityRoutes, {
    pool: deps.pool,
    sessionTtlHours: config.demoSessionTtlHours,
  });
  app.register(registerActivitiesRoutes, {
    activities: {
      pool: deps.pool,
      experiment: {
        allocationPercent: config.experimentTreatmentAllocationPercent,
        experimentVersion: config.experimentVersion,
      },
    },
    identity: { pool: deps.pool, sessionTtlHours: config.demoSessionTtlHours },
    experiments: { pool: deps.pool },
    inviteCreationEnabled: config.experimentInviteCreationEnabled,
  });
  // Live availability: publication goes through Redis Pub/Sub with a finite
  // budget after booking commit; /live forwards committed updates and asks
  // viewers to resnapshot whenever the subscription reconnects (PLANS 3.4).
  // The websocket plugin loads at the root so the /live route is declared
  // websocket-aware.
  app.register(websocketPlugin);
  const live = createLivePublication(deps.redis, config.liveChannelPrefix, config.livePublishTimeoutMs);
  app.register(registerBookingRoutes, {
    booking: {
      pool: deps.pool,
      lockTimeoutMs: config.bookingLockTimeoutMs,
      statementTimeoutMs: config.bookingStatementTimeoutMs,
      live,
    },
    identity: { pool: deps.pool, sessionTtlHours: config.demoSessionTtlHours },
  });
  app.register(registerLiveRoutes, {
    redis: deps.redis,
    channelPrefix: config.liveChannelPrefix,
    // Server-owned presence for measurement-registered viewers (PLANS 4.2):
    // PostgreSQL ownership makes capture work across API instances, and the
    // liveness lease replaces the close event a crash never sends.
    pool: deps.pool,
    instanceId: config.liveInstanceId ?? randomUUID(),
    leaseSeconds: config.liveLeaseSeconds,
  });
  app.register(registerInvitesRoutes, {
    invites: {
      pool: deps.pool,
      inviteCreationEnabled: config.experimentInviteCreationEnabled,
      expiryHours: config.inviteExpiryHours,
    },
    identity: { pool: deps.pool, sessionTtlHours: config.demoSessionTtlHours },
  });
  // Client observation events: a public route; observations land in the append-only event log and the first visitor
  // link wins (PLANS.md 4.1).
  app.register(registerClientEventsRoutes, {
    events: {
      pool: deps.pool,
    },
    identity: { pool: deps.pool, sessionTtlHours: config.demoSessionTtlHours },
  });
  // Booking health and applied-availability measurement (PLANS 4.2/4.3):
  // persisted attempt/measurement rows are the restart-safe facts; the
  // publication counters are this instance's process-local view of them.
  app.register(registerMetricsRoutes, {
    metrics: {
      pool: deps.pool,
    },
    publication: live.stats,
  });

  app.addHook("onClose", async () => {
    // Force-close: quit() can hang when Redis never connected.
    deps.redis.disconnect();
    await deps.pool.end();
  });

  return app;
}
