import type { FastifyInstance } from "fastify";
import { resolveSession, SessionInvalidError, type IdentityDeps } from "../identity/service.js";
import { bearerToken, useDomainErrorHandler } from "../http.js";
import { parseClientEvent } from "./domain.js";
import { recordClientEvent, type ClientEventsDeps } from "./service.js";

/**
 * Thin transport for client observation events (PLANS.md 3.5). The route is
 * a public observation surface with bounded abuse control; a presented
 * session is validated through the bearer token alone and an invalid one is
 * refused rather than downgraded to anonymous. The actor never comes from
 * the body.
 */
export function registerClientEventsRoutes(
  app: FastifyInstance,
  deps: { events: ClientEventsDeps; identity: IdentityDeps },
): void {
  useDomainErrorHandler(app);

  app.post("/client-events", async (request) => {
    // A presented session is resolved before the body is interpreted, so an
    // invalid credential is refused as such rather than mixed into input
    // validation or downgraded to anonymous.
    const token = bearerToken(request.headers.authorization);
    if (request.headers.authorization !== undefined && token === null) {
      throw new SessionInvalidError();
    }
    const session = token === null ? undefined : await resolveSession(deps.identity, token);
    const parsed = parseClientEvent((request.body ?? {}) as Record<string, unknown>);
    return {
      event: await recordClientEvent(deps.events, parsed, { ip: request.ip, session }),
    };
  });
}
