import type { FastifyInstance } from "fastify";
import {
  getActivity,
  getHostContext,
  listHostActivities,
  listParticipants,
  listPublicActivities,
  publishActivity,
  type ActivitiesDeps,
} from "./service.js";
import type { IdentityDeps } from "../identity/service.js";
import { getInviteCapability, type InviteCapability } from "../experiments/service.js";
import { requireSession, useDomainErrorHandler } from "../http.js";

export interface ActivitiesRouteDeps {
  activities: ActivitiesDeps;
  identity: IdentityDeps;
  experiments: { pool: ActivitiesDeps["pool"] };
  /** Saved assignments decide the arm; this switch only gates creation. */
  inviteCreationEnabled: boolean;
}

/**
 * Thin transport for activity publication and inspection. Publishing and host
 * views act as the session's person; browse and detail are public; participant
 * inspection is reserved to the owning host. No editing or cancellation
 * routes exist (outside prototype scope).
 */
export function registerActivitiesRoutes(app: FastifyInstance, deps: ActivitiesRouteDeps): void {
  useDomainErrorHandler(app);

  app.post("/activities", async (request, reply) => {
    const host = await requireSession(deps.identity, request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    void reply.code(201);
    return publishActivity(deps.activities, host, body);
  });

  app.get("/activities", async () => {
    return { activities: await listPublicActivities(deps.activities) };
  });

  app.get("/activities/:id", async (request) => {
    const { id } = request.params as { id: string };
    // The capability is read from the saved assignment and involves no
    // identity, so every viewer of a shared activity receives the same
    // stable arm and version (ticket #5, stable-assignment scenario).
    const activity = await getActivity(deps.activities, id);
    const invites: InviteCapability = await getInviteCapability(deps.experiments.pool, id, {
      inviteCreationEnabled: deps.inviteCreationEnabled,
    });
    return { activity, plan: { id: activity.planId, activityId: activity.id, itinerary: activity.itinerary }, host: await getHostContext(deps.activities, activity), invites: { ...invites, creationEnabled: deps.inviteCreationEnabled } };
  });

  app.get("/my/activities", async (request) => {
    const host = await requireSession(deps.identity, request);
    return { activities: await listHostActivities(deps.activities, host) };
  });

  app.get("/activities/:id/participants", async (request) => {
    const host = await requireSession(deps.identity, request);
    const { id } = request.params as { id: string };
    return listParticipants(deps.activities, host, id);
  });

}
