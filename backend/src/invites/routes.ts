import type { FastifyInstance } from "fastify";
import { ActivityValidationError } from "../activities/domain.js";
import type { IdentityDeps } from "../identity/service.js";
import { createInvite, getPublicShare, resolveInvite, type InvitesDeps } from "./service.js";
import { requireSession, useDomainErrorHandler } from "../http.js";

export interface InvitesRouteDeps {
  invites: InvitesDeps;
  identity: IdentityDeps;
}

export function registerInvitesRoutes(app: FastifyInstance, deps: InvitesRouteDeps): void {
  useDomainErrorHandler(app);

  app.post("/activities/:id/invites", async (request, reply) => {
    const creator = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.rail !== "public_share" && body.rail !== "vouch") {
      throw new ActivityValidationError({ rail: "must be 'public_share' or 'vouch'" });
    }
    if (body.rail === "vouch" && typeof body.recipientEmail !== "string") {
      throw new ActivityValidationError({ recipientEmail: "must be an email address" });
    }
    const { created, ...invite } = await createInvite(deps.invites, creator, id, {
      ip: request.ip,
      rail: body.rail,
      recipientEmail: body.recipientEmail,
    });
    void reply.code(created ? 201 : 200);
    return { invite, created };
  });

  app.get("/activities/:id/invites/public", async (request) => {
    const creator = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    return { invite: await getPublicShare(deps.invites, creator, id) };
  });

  app.get("/invites/:code", async (request) => {
    const { code } = request.params as { code: string };
    return { invite: await resolveInvite(deps.invites, code, { ip: request.ip }) };
  });
}
