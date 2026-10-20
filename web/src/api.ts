/**
 * Typed transport for the Velio backend (docs/client-contract.md). One place
 * owns the base URL, credentials, error envelope and AbortSignal plumbing so
 * every caller speaks the machine-readable contract. The transport is
 * injectable (tests pass fakes); production uses fetch against `/api` (dev
 * proxy) or `VITE_API_BASE` (documented production base).
 */

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;

export const defaultTransport: Transport = async (url, init) => {
  const response = await fetch(url, { ...init, headers: init.headers });
  const json = (await response.json().catch(() => null)) as unknown;
  // Only the contract headers callers must see survive the boundary; the
  // 429 retry delay is the one documented today (docs/client-contract.md).
  return {
    status: response.status,
    json,
    headers: { "retry-after": response.headers.get("retry-after") ?? "" },
  };
};

export interface UserSnapshot {
  id: string;
  contactKey: string;
  email?: string;
  displayName: string;
  signupSource: string;
  signupGeneration: number;
}

export interface SessionEstablishment {
  session: { token: string; expiresAt: string };
  user: UserSnapshot;
  created: boolean;
}

export interface ActivityView {
  hostId?: string;
  description?: string;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  country: string | null;
  priceMinorUnits: number;
  currency: string;
  capacity: number;
  bookedCount: number;
  remainingSpots: number;
  availabilityVersion: string;
  planId?: string;
}

export interface ActivityDetailView extends ActivityView {
  itinerary?: string;
  host?: { id: string; displayName: string; summary: string; previousActivities: Array<{ id: string; title: string; startsAt: string }> };
  /** The detail route always joins the activity's unique plan. */
  planId: string;
  hostDisplayName: string;
  started: boolean;
  invites?: {
    eligible: boolean;
    canCreateInvites: boolean;
    arm: "treatment" | "control" | null;
    experimentVersion: string | null;
  };
}

export interface PublicActivityView {
  id: string;
  hostId: string;
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  country: string | null;
  priceMinorUnits: number;
  currency: string;
  capacity: number;
  bookedCount: number;
  remainingSpots: number;
  availabilityVersion: string;
  hostDisplayName: string;
  started: boolean;
}

/** Saved booking receipt exactly as docs/client-contract.md documents it. */
export interface BookingView {
  id: string;
  activityId: string;
  planId: string;
  userId: string;
  createdAt: string;
  attribution: { rail: string; generation: number };
}

/** POST /activities/:id/bookings result envelope (201 created, 200 replay). */
export interface BookingOperationResult {
  booking: BookingView;
  created: boolean;
  attemptId: string;
  availabilityVersion: string;
}

export interface HostActivityView extends ActivityView {
  confirmedCount: number;
  started: boolean;
}

export interface ParticipantsView {
  activityId: string;
  planId: string;
  confirmedCount: number;
  participants: Array<{ userId: string; bookingId: string; displayName: string; maskedEmail: string }>;
}

/** Saved invitation exactly as docs/client-contract.md §4 documents it. */
export interface InviteView {
  id: string;
  code: string;
  rail: "public_share" | "vouch";
  generation: number;
  activityId: string;
  planId: string;
  expiresAt: string;
  createdAt: string;
  /** The vouched contact, echoed to its creator only; null on public shares. */
  recipientEmail: string | null;
}

/** Public invite preview (docs/client-contract.md §4): never a target contact. */
export interface InvitePreview {
  code: string;
  rail: "public_share" | "vouch";
  generation: number;
  state: "claimable" | "expired" | "full" | "used";
  expiresAt: string;
  inviterDisplayName: string;
  activity: ActivityDetailView;
  plan: { id: string; activityId: string; itinerary: string };
  host: NonNullable<ActivityDetailView["host"]>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

function retryAfterFrom(headers?: Record<string, string>): number | undefined {
  const raw = headers?.["retry-after"];
  if (raw === undefined || raw === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function requireEnvelope(
  json: unknown,
  status: number,
  headers?: Record<string, string>,
): Record<string, unknown> {
  if (typeof json === "object" && json !== null && "error" in json) {
    const error = (json as { error: { code?: unknown; message?: unknown; fields?: unknown } }).error;
    throw new ApiError(
      status,
      typeof error.code === "string" ? error.code : "server_error",
      typeof error.message === "string" ? error.message : "Request failed",
      typeof error.fields === "object" && error.fields !== null
        ? (error.fields as Record<string, string>)
        : undefined,
      status === 429 ? retryAfterFrom(headers) : undefined,
    );
  }
  if (status >= 400) {
    throw new ApiError(status, "server_error", `Request failed with ${status}`);
  }
  return json as Record<string, unknown>;
}

export class VelioApi {
  constructor(
    private readonly transport: Transport = defaultTransport,
    private readonly baseUrl: string = API_BASE,
  ) {}

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string | null; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const { status, json, headers: responseHeaders } = await this.transport(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    return requireEnvelope(json, status, responseHeaders);
  }

  /** Public browse (docs/client-contract.md §3.5): no identity required. */
  listActivities(signal?: AbortSignal): Promise<PublicActivityView[]> {
    return this.request("GET", "/activities", { signal }).then(
      (json) => (json as { activities: PublicActivityView[] }).activities,
    );
  }

  bookActivity(
    token: string,
    activityId: string,
    operationId: string,
    signal?: AbortSignal,
    inviteCode?: string,
  ): Promise<BookingOperationResult> {
    return this.request("POST", `/activities/${activityId}/bookings`, {
      body: inviteCode === undefined ? { operationId } : { operationId, inviteCode },
      token,
      signal,
    }) as never;
  }

  /** Public resolution (docs/client-contract.md §4): never mutates, never tracks. */
  resolveInvite(code: string, signal?: AbortSignal): Promise<InvitePreview> {
    return this.request("GET", `/invites/${encodeURIComponent(code)}`, {
      signal,
    }).then((json) => (json as { invite: InvitePreview }).invite);
  }

  /**
   * invite_opened (docs/client-contract.md §5): only after a resolved
   * landing was displayed, with the literal documented outcome.
   */
  emitInviteOpened(input: {
    eventId: string;
    visitorId: string;
    inviteCode: string;
    outcome: "available" | "full" | "expired" | "used";
    token?: string | null;
  }): Promise<{ event: { eventId: string; type: string; status: string } }> {
    return this.request("POST", "/client-events", {
      body: {
        type: "invite_opened",
        eventId: input.eventId,
        visitorId: input.visitorId,
        channel: "web",
        visitId: globalThis.sessionStorage?.getItem("velio.visit.v1") ?? undefined,
        inviteCode: input.inviteCode,
        outcome: input.outcome,
      },
      token: input.token ?? undefined,
    }) as never;
  }

  /** claim_started: an explicit authenticated claim action (§5). */
  emitClaimStarted(input: {
    eventId: string;
    visitorId: string;
    inviteCode: string;
    token: string;
  }): Promise<{ event: { eventId: string; type: string; status: string } }> {
    return this.request("POST", "/client-events", {
      body: {
        type: "claim_started",
        eventId: input.eventId,
        visitorId: input.visitorId,
        channel: "web",
        visitId: globalThis.sessionStorage?.getItem("velio.visit.v1") ?? undefined,
        inviteCode: input.inviteCode,
      },
      token: input.token,
    }) as never;
  }

  /**
   * Lost-response recovery lookup. Absence is the contractual 404
   * booking_not_found (an ApiError), never a fabricated empty result.
   */
  getMyBooking(token: string, activityId: string, signal?: AbortSignal): Promise<BookingView> {
    return this.request("GET", `/activities/${activityId}/bookings/me`, {
      token,
      signal,
    }).then((json) => (json as { booking: BookingView }).booking);
  }

  /** Create a vouch or public share (docs/client-contract.md §4); 201 {invite}. */
  createInvite(
    token: string,
    activityId: string,
    input: { rail: "public_share" | "vouch"; recipientEmail?: string },
    signal?: AbortSignal,
  ): Promise<InviteView> {
    return this.request("POST", `/activities/${activityId}/invites`, {
      body: input,
      token,
      signal,
    }).then((json) => (json as { invite: InviteView }).invite);
  }

  getPublicInvite(token: string, activityId: string, signal?: AbortSignal): Promise<InviteView | null> {
    return this.request("GET", `/activities/${activityId}/invites/public`, {
      token,
      signal,
    }).then((json) => (json as { invite: InviteView | null }).invite);
  }

  /**
   * invite_share_action (docs/client-contract.md §5): only an actual
   * successful copy or supported share interaction is recorded.
   */
  emitInviteShareAction(input: {
    eventId: string;
    visitorId: string;
    inviteCode: string;
    shareMethod: "copy" | "system_share";
    token?: string | null;
  }): Promise<{ event: { eventId: string; type: string; status: string } }> {
    return this.request("POST", "/client-events", {
      body: {
        type: "invite_share_action",
        eventId: input.eventId,
        visitorId: input.visitorId,
        channel: "web",
        visitId: globalThis.sessionStorage?.getItem("velio.visit.v1") ?? undefined,
        inviteCode: input.inviteCode,
        shareMethod: input.shareMethod,
      },
      token: input.token ?? undefined,
    }) as never;
  }

  establishSession(input: {
    email: string;
    displayName?: string;
    inviteCode?: string;
    visitorId?: string;
    channel?: string;
    visitId?: string;
  }, signal?: AbortSignal): Promise<SessionEstablishment> {
    return this.request("POST", "/demo/sessions", { body: input, signal }) as never;
  }

  getMyBookings(token: string, signal?: AbortSignal): Promise<Array<{ id: string; activityId: string; planId: string; activity: { id: string; title: string; startsAt: string; timezone: string } }>> {
    return this.request("GET", "/my/bookings", { token, signal }).then(json => (json.bookings ?? []) as never);
  }

  getMyActivities(token: string, signal?: AbortSignal): Promise<HostActivityView[]> {
    return this.request("GET", "/my/activities", { token, signal }).then(
      (json) => (json as { activities: HostActivityView[] }).activities,
    );
  }

  getActivity(
    activityId: string,
    opts: { token?: string | null; signal?: AbortSignal } = {},
  ): Promise<{ activity: ActivityDetailView; invites: NonNullable<ActivityDetailView["invites"]> }> {
    return this.request("GET", `/activities/${activityId}`, opts).then(
      (json) => {
        const envelope = json as { activity: ActivityDetailView; invites: NonNullable<ActivityDetailView["invites"]> };
        return { activity: { ...envelope.activity, host: (json.host as ActivityDetailView["host"]), itinerary: (json.plan as { itinerary?: string } | undefined)?.itinerary ?? envelope.activity.itinerary }, invites: envelope.invites };
      },
    );
  }

  getParticipants(activityId: string, token: string, signal?: AbortSignal): Promise<ParticipantsView> {
    return this.request("GET", `/activities/${activityId}/participants`, { token, signal }) as never;
  }

  publishActivity(
    token: string,
    draft: { title: string; description: string; itinerary: string; startsAt: string; endsAt: string; country: string; priceMinorUnits: number; currency: string; spots: number },
  ): Promise<{ activity: ActivityView; plan: { id: string }; experiment: { arm: string; experimentVersion: string } }> {
    return this.request("POST", "/activities", { body: draft, token }) as never;
  }

  /** Fire-and-forget observation; the optional session rides the header. */
  emitActivityViewed(input: {
    eventId: string;
    visitorId: string;
    activityId: string;
    token?: string | null;
  }): Promise<{ event: { eventId: string; type: string; status: string } }> {
    return this.request("POST", "/client-events", {
      body: {
        type: "activity_viewed",
        eventId: input.eventId,
        visitorId: input.visitorId,
        channel: "web",
        activityId: input.activityId,
        visitId: globalThis.sessionStorage?.getItem("velio.visit.v1") ?? undefined,
      },
      token: input.token ?? undefined,
    }) as never;
  }

  /**
   * Applied-availability acknowledgement (docs/client-contract.md §6): a
   * measurement capability keyed by the server-issued connection id, sent
   * only after the rendered facts actually show the applied version. No
   * person authentication is attached — the contract refuses a malformed
   * header and the capability alone identifies the connection.
   */
  postAvailabilityAck(input: {
    connectionId: string;
    activityId: string;
    appliedVersion: string;
    appliedEventId?: string;
    source: "websocket" | "snapshot";
    reason: "interval" | "reconnect" | "foreground";
  }): Promise<{
    ack: {
      connectionId: string;
      activityId: string;
      appliedVersion: string;
      closed: Array<{ version: string; waitedMs: number }>;
    };
  }> {
    return this.request("POST", "/availability-acks", { body: input }) as never;
  }
}
