import type { FastifyInstance } from "fastify";
import type { PublicationStats } from "../live/publication.js";
import { bearerToken, useDomainErrorHandler } from "../http.js";
import { SessionInvalidError } from "../identity/service.js";
import { parseAvailabilityAck } from "./domain.js";
import {
  buildBookingHealth,
  parseBookingHealthFilters,
  recordAvailabilityAck,
  type MetricsDeps,
} from "./service.js";

/**
 * Thin transport for the measurement collector and technical metrics
 * (PLANS.md 4.3). Acks authenticate by the server-issued connection
 * capability alone — no session, no person; any presented-but-unparseable
 * Authorization header is refused rather than silently ignored, matching the
 * client-event route. Metrics expose aggregate counts and durations only.
 */
export function registerMetricsRoutes(
  app: FastifyInstance,
  deps: { metrics: MetricsDeps; publication?: PublicationStats },
): void {
  useDomainErrorHandler(app);

  app.post("/availability-acks", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (request.headers.authorization !== undefined && token === null) {
      throw new SessionInvalidError();
    }
    const ack = parseAvailabilityAck((request.body ?? {}) as Record<string, unknown>);
    return {
      ack: await recordAvailabilityAck(deps.metrics, ack, { ip: request.ip }),
    };
  });

  app.get("/metrics", async (request) => {
    const filters = parseBookingHealthFilters(request.query as Record<string, unknown>);
    return buildBookingHealth(deps.metrics.pool, deps.publication, filters);
  });
}
