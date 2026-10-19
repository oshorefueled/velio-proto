import { appendEvent } from "../events/append.js";
import { isActivityId } from "../activities/domain.js";
import { ActivityNotFoundError, validateOperationId } from "./domain.js";
import type { FastifyRequest } from "fastify";
import type { FastifyInstance } from "fastify";
import {
  bookActivity,
  getMyBooking,
  type BookingDeps,
} from "./service.js";
import type { IdentityDeps } from "../identity/service.js";
import { requireSession, useDomainErrorHandler } from "../http.js";

export interface BookingRouteDeps {
  booking: BookingDeps;
  identity: IdentityDeps;
}

/**
 * Thin transport for booking. The actor comes from the session; the request
 * ip feeds the quota; the client's operationId stays stable across retries
 * while the server assigns a fresh attempt id per request. Retries return
 * 200 with the committed booking; a new booking is 201.
 */
export function registerBookingRoutes(app: FastifyInstance, deps: BookingRouteDeps): void {
  useDomainErrorHandler(app);

  const enteredService = new WeakSet<FastifyRequest>();
  app.post("/activities/:id/bookings", {
    onError: async (request, _reply, error) => {
      if (enteredService.has(request)) return;
      const unauthorized = ["SessionRequiredError", "SessionInvalidError", "SessionExpiredError"].includes(error.name);
      const invalid = error.name === "InvalidOperationError" || error.name === "ActivityNotFoundError"
        || (error.statusCode !== undefined && error.statusCode < 500);
      const body = request.body as { operationId?: unknown } | null;
      let operationId: string | undefined;
      try { operationId = validateOperationId(body?.operationId); } catch { /* Uncorrelatable raw request. */ }
      try {
        await appendEvent(deps.booking.pool, {
          eventName: "booking_attempted",
          details: { outcome: unauthorized ? "unauthorized" : invalid ? "invalid" : "failed", operationId },
        });
      } catch { /* Evidence loss must not replace the original response. */ }
    },
  }, async (request, reply) => {
    const person = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isActivityId(id)) throw new ActivityNotFoundError();
    validateOperationId(body.operationId);
    enteredService.add(request);
    // The client owns retry identity: a required operation id makes replays
    // deterministic, so a naive retry can never silently become a new
    // booking operation. An optional invite code carries the claim's public
    // share; the server derives the recorded origin from the saved invite.
    const result = await bookActivity(deps.booking, person, id, {
      ip: request.ip,
      operationId: body.operationId,
      inviteCode: body.inviteCode,
    });
    void reply.code(result.created ? 201 : 200);
    return result;
  });

  app.get("/my/bookings", async (request) => {
    const person = await requireSession(deps.identity, request);
    const result = await deps.booking.pool.query<{
      id: string; activity_id: string; plan_id: string; title: string; starts_at: Date; display_timezone: string;
    }>(`SELECT b.id, b.activity_id, b.plan_id, a.title, a.starts_at, a.display_timezone
        FROM bookings b JOIN activities a ON a.id=b.activity_id
        WHERE b.user_id=$1 ORDER BY a.starts_at`, [person.id]);
    return { bookings: result.rows.map(row => ({ id: row.id, activityId: row.activity_id, planId: row.plan_id,
      activity: { id: row.activity_id, title: row.title, startsAt: row.starts_at.toISOString(), timezone: row.display_timezone } })) };
  });

  app.get("/activities/:id/bookings/me", async (request) => {
    const person = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    return { booking: await getMyBooking(deps.booking, person, id) };
  });
}
