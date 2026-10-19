import type { FastifyInstance } from "fastify";
import { ActivityValidationError } from "../activities/domain.js";
import type { IdentityDeps } from "../identity/service.js";
import { createInvite, resolveInvite, type InvitesDeps } from "./service.js";
import { requireSession, useDomainErrorHandler } from "../http.js";

export interface InvitesRouteDeps {
  invites: InvitesDeps;
  identity: IdentityDeps;
}

/**
 * Thin transport for the public-share rail (ticket #6). Creation acts as the
 * session's person and consumes the creation quota for identity and IP;
 * resolution is anonymous and consumes the per-IP resolution quota. Claiming
 * goes through the booking route with an invite code, not through here.
 */
export function registerInvitesRoutes(app: FastifyInstance, deps: InvitesRouteDeps): void {
  useDomainErrorHandler(app);

  app.post("/activities/:id/invites", async (request, reply) => {
    const creator = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.rail !== "public_share" && body.rail !== "vouch") {
      throw new ActivityValidationError({ rail: "must be 'public_share' or 'vouch'" });
    }
    if (body.rail === "vouch" && typeof body.targetContactKey !== "string") {
      throw new ActivityValidationError({ targetContactKey: "must name the vouched contact" });
    }
    const invite = await createInvite(deps.invites, creator, id, {
      ip: request.ip,
      rail: body.rail,
      targetContactKey: body.targetContactKey,
    });
    void reply.code(201);
    return { invite };
  });

  app.get("/invites/:code", async (request) => {
    const { code } = request.params as { code: string };
    return { invite: await resolveInvite(deps.invites, code, { ip: request.ip }) };
  });
}
