import type { FastifyInstance } from "fastify";
import { normalizeEmail } from "./domain.js";
import { establishIdentity, resolveSession, type IdentityDeps } from "./service.js";
import { bearerToken, SessionRequiredError, useDomainErrorHandler } from "../http.js";

/**
 * Thin transport for the identity application services: parse input, delegate,
 * let the shared domain error handler map failures to machine-readable codes.
 * The actor always comes from the session token; no route accepts a user id as
 * the actor.
 */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  useDomainErrorHandler(app);

  app.post("/demo/sessions", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return establishIdentity(deps, {
      email: normalizeEmail(body.email),
      visitId: body.visitId,
      displayName: body.displayName,
      // The invitation survives identity selection: a new person acquires
      // their signup origin from it; a resuming person keeps theirs.
      inviteCode: body.inviteCode,
      // Optional device correlation: links the visitor once completion
      // commits, so pre-identity observations join the person's journey.
      visitorId: body.visitorId,
      channel: body.channel,
    });
  });

  app.get("/demo/me", async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      throw new SessionRequiredError();
    }
    return { user: await resolveSession(deps, token) };
  });
}
