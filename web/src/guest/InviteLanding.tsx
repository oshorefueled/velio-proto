import { formatMoney } from "../money.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BookingStore, BookingState } from "../booking-store.js";
import type { InvitePreview } from "../api.js";
import { LiveStatus } from "../live/LiveStatus.js";
import { compareVersions, useLiveAcknowledgement, useLiveAvailability } from "../live/availability.js";
import { useSession } from "../session.js";

/**
 * Invitation landing (issue #17, US07/08/10/12): anyone with a code sees the
 * inviter, rail, activity facts, expiry and current availability BEFORE any
 * identity selection. The shared booking controller owns the claim, so the
 * ticket-15 recovery guarantees (unknown/checking/pending never confirm,
 * reconciliation before retry, stable operation) hold verbatim for invited
 * claims. An existing saved booking always wins over an unusable new claim.
 * Telemetry: one invite_opened per mounted landing observation, only for a
 * committed visible preview whose state maps to a documented outcome;
 * claim_started only for a deliberate authenticated claim action.
 */

const OPENED_OUTCOME: Record<string, "available" | "full" | "expired" | undefined> = {
  claimable: "available",
  full: "full",
  expired: "expired",
};



function ClaimControls({
  booking,
  claimable,
  onClaim,
  onCheckAgain,
  onNeedIdentity,
}: {
  booking: BookingState;
  claimable: boolean;
  onClaim: () => void;
  onCheckAgain: () => void;
  onNeedIdentity: () => void;
}): ReactNode {
  const { state } = useSession();
  const phase = booking.phase;
  const ready = state.status.status === "ready";
  const [now, setNow] = useState(Date.now);
  const retryAt = phase.kind === "refused" ? phase.retryAt : undefined;
  useEffect(() => {
    if (retryAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  if (phase.kind === "confirmed") {
    return (
      <div className="booking-panel">
        <div className="notice notice-good" role="status">
          Your spot is saved — you are in the plan.
        </div>
        <dl className="detail-grid receipt-grid" aria-label="Saved booking">
          <div>
            <dt>Booking</dt>
            <dd>
              <code>{phase.booking.id}</code>
            </dd>
          </div>
          <div>
            <dt>Saved</dt>
            <dd>
              {new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(
                new Date(phase.booking.createdAt),
              )}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {phase.booking.attribution.rail}
              {phase.booking.attribution.generation > 0
                ? ` · generation ${phase.booking.attribution.generation}`
                : ""}
            </dd>
          </div>
        </dl>
        <p className="hint">
          This is your saved record — your actual booking source is shown, regardless of which
          invitation link you opened.
        </p>
      </div>
    );
  }

  if (phase.kind === "unknown") {
    return (
      <div className="booking-panel">
        <div className="notice notice-warn" role="alert">
          We could not confirm whether your claim was saved. Your request may still be in
          progress — {phase.message}
        </div>
        <button type="button" className="button-primary" onClick={onCheckAgain}>
          Check again
        </button>
        <p className="hint">Checking looks up your saved booking before any new attempt.</p>
      </div>
    );
  }

  if (phase.kind === "refused") {
    return (
      <div className="booking-panel">
        <div className="notice notice-warn" role="alert">
          {phase.message}
        </div>
        {phase.reason === "invite-mismatch" && (
          <p className="hint">
            Use "Switch identity" above to select the contact this vouch was meant for.
          </p>
        )}
        {(phase.reason === "absent" || phase.reason === "failed" || phase.reason === "rate-limited") && (
          <button type="button" className="button-primary" onClick={onClaim} disabled={!claimable || (retryAt !== undefined && now < retryAt)}>
            {claimable ? "Try claiming again" : "Claiming is unavailable right now"}
          </button>
        )}
      </div>
    );
  }

  if (phase.kind === "pending" || phase.kind === "checking") {
    return (
      <div className="booking-panel" aria-busy="true">
        <button type="button" className="button-primary" disabled>
          {phase.kind === "pending" ? "Claiming…" : "Checking your booking…"}
        </button>
        <p className="hint">
          {phase.kind === "pending"
            ? "Your claim is in progress — this is not a confirmation yet."
            : phase.quiet
              ? "Looking up any booking you already hold for this plan…"
              : "Looking up your saved booking before anything else is attempted."}
        </p>
      </div>
    );
  }

  // idle
  if (!ready) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary" onClick={onNeedIdentity}>
          Select identity to claim
        </button>
        <p className="hint">
          Your invitation stays exactly where it is while you pick or resume your identity.
          Claiming never takes payment.
        </p>
      </div>
    );
  }
  if (!claimable) {
    return null; // lifecycle explanation already rendered above
  }
  return (
    <div className="booking-panel">
      <button
        type="button"
        className="button-primary"
        onClick={onClaim}
      >
        Claim your spot
      </button>
      <p className="hint">
        One spot is reserved only after the server saves your booking — no payment in this
        prototype.
      </p>
    </div>
  );
}

export function InviteLanding({
  code,
  visible,
  booking,
  onRequestIdentity,
  onBrowse,
}: {
  code: string;
  visible: boolean;
  booking: BookingStore;
  onRequestIdentity: () => void;
  onBrowse: () => void;
}): ReactNode {
  const { api, state } = useSession();
  const sessionToken = state.status.status === "ready" ? state.status.token : null;
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notRecognized, setNotRecognized] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const observationId = useRef(crypto.randomUUID());
  const openedForObservation = useRef(false);
  const viewedForObservation = useRef(false);
  const activityObservationId = useRef(crypto.randomUUID());

  const [livePhase, setLivePhase] = useState(() => booking.getState());
  useEffect(() => booking.subscribe(setLivePhase), [booking]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setLoadError(null);
    setNotRecognized(false);
    setPreview(null);
    openedForObservation.current = false;
    void (async () => {
      try {
        const invite = await api.resolveInvite(code);
        if (generation.current !== currentGeneration) return;
        setPreview(invite);
        setLoading(false);
      } catch (err) {
        if (generation.current !== currentGeneration) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
        if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) {
          setNotRecognized(true);
        }
        setLoadError(err instanceof Error ? err.message : "Could not open this invitation.");
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [api, code, retry]);

  // Single booking owner for the route: once the preview resolves, this
  // landing points the shared controller at the invited activity.
  const activityId = preview?.activity.id ?? null;
  useEffect(() => {
    if (activityId === null) return;
    booking.viewActivity(activityId, sessionToken);
    return () => booking.viewActivity(null, null);
  }, [booking, activityId, sessionToken]);

  // Live availability (issue #18): current facts for the invited activity.
  // The lifecycle owner refreshes the public activity, never the invitation
  // resolution — state precedence (expiry/started/full) stays with
  // resolveInvite, so a live count can never turn an unusable invite
  // claimable — and only counts merge, version-guarded, into the preview.
  const live = useLiveAvailability({
    activityId,
    visible: visible && activityId !== null,
    displayedVersion: preview?.activity.availabilityVersion ?? null,
    loadSnapshot: useCallback(
      async (signal: AbortSignal) => {
        const { activity } = await api.getActivity(activityId as string, { signal });
        return { availabilityVersion: activity.availabilityVersion, remainingSpots: activity.remainingSpots };
      },
      [api, activityId],
    ),
    api,
  });
  useLiveAcknowledgement(live, preview?.activity.availabilityVersion ?? null);
  useEffect(() => {
    const applied = live.applied;
    if (applied === null) return;
    setPreview((prev) => {
      if (prev === null || prev.activity.id !== activityId) return prev;
      if (compareVersions(applied.version, prev.activity.availabilityVersion) <= 0) return prev;
      const remaining = applied.remainingSpots;
      return {
        ...prev,
        activity: {
          ...prev.activity,
          remainingSpots: remaining,
          bookedCount: Math.max(0, prev.activity.capacity - remaining),
          availabilityVersion: applied.version,
        },
      };
    });
  }, [live.applied, activityId]);

  // One opened observation per mounted landing, only for a committed visible
  // preview with a documented outcome; started/completed have none.
  useEffect(() => {
    if (!visible || loading || loadError !== null || preview === null) return;
    if (!viewedForObservation.current) {
      viewedForObservation.current = true;
      void api.emitActivityViewed({
        eventId: activityObservationId.current,
        activityId: preview.activity.id,
        visitorId: state.visitorId,
        token: sessionToken,
      }).catch(() => {});
    }
    if (openedForObservation.current) return;
    const outcome = OPENED_OUTCOME[preview.state];
    if (outcome === undefined) return;
    openedForObservation.current = true;
    void api
      .emitInviteOpened({
        eventId: observationId.current,
        visitorId: state.visitorId,
        inviteCode: preview.code,
        outcome,
        token: sessionToken,
      })
      .catch(() => {});
  }, [api, preview, loading, loadError, visible, state.visitorId, sessionToken]);

  const claim = (): void => {
    if (sessionToken === null || preview === null) return;
    booking.submit(preview.activity.id, sessionToken, preview.code);
  };

  const currentBooking = livePhase !== null && livePhase.activityId === activityId ? livePhase : null;
  const [validityPending, setValidityPending] = useState(false);
  const [validityRetry, setValidityRetry] = useState(0);
  const refusal = currentBooking?.phase.kind === "refused" ? currentBooking.phase : null;
  useEffect(() => {
    if (refusal === null || preview === null) return;
    let active = true;
    setValidityPending(true);
    void api.resolveInvite(preview.code).then((fresh) => {
      if (!active) return;
      setPreview(fresh);
      setValidityPending(false);
    }).catch(() => {
      // Keep retry blocked until a successful public preview establishes eligibility.
    });
    return () => { active = false; };
  }, [api, refusal, code, validityRetry]);
  const claimable = preview?.state === "claimable" && !validityPending;

  const lifecycleExplanation = (state: InvitePreview["state"]): string => {
    switch (state) {
      case "expired":
        return "This invitation has expired, so it cannot be claimed.";
      case "started":
        return "The activity has already started — the invitation can no longer be claimed.";
      case "full":
        return "The activity is full — every spot is taken.";
      case "completed":
        return "This plan was already completed by its host.";
      default:
        return "";
    }
  };

  return (
    <section className="panel invite-landing" aria-labelledby="invite-landing-heading">
      <p className="eyebrow">Invitation · {code}</p>
      {loading && (
        <>
          <h2 id="invite-landing-heading">Opening your invitation…</h2>
          <p className="hint" aria-busy="true">
            Availability and facts are unknown until it opens — nothing is reserved by looking.
          </p>
        </>
      )}
      {!loading && notRecognized && (
        <>
          <h2 id="invite-landing-heading">Invitation not recognized</h2>
          <div className="notice notice-warn" role="alert">
            This invitation code is not recognized. Check the link or code — availability of the
            intended activity is unknown from here.
          </div>
          <div className="invite-actions">
            <button type="button" className="button-primary" onClick={() => setRetry((v) => v + 1)}>
              Retry
            </button>
            <button type="button" className="button-ghost" onClick={onBrowse}>
              Browse activities
            </button>
          </div>
        </>
      )}
      {!loading && !notRecognized && loadError !== null && (
        <>
          <h2 id="invite-landing-heading">Invitation unavailable</h2>
          <div className="notice notice-warn" role="alert">
            {loadError} Facts are unknown, not zero.
          </div>
          <div className="invite-actions">
            <button type="button" className="button-primary" onClick={() => setRetry((v) => v + 1)}>
              Retry
            </button>
            <button type="button" className="button-ghost" onClick={onBrowse}>
              Browse activities
            </button>
          </div>
        </>
      )}
      {!loading && preview !== null && (
        <>
          <h2 id="invite-landing-heading">{preview.activity.title}</h2>
          <dl className="detail-grid">
            <div>
              <dt>Invited by</dt>
              <dd>{preview.inviterDisplayName}</dd>
            </div>
            <div>
              <dt>Rail</dt>
              <dd>
                {preview.rail === "vouch"
                  ? "Contact vouch — a personal endorsement; only the invited contact can claim it"
                  : "Public share — anyone with the link can use it while valid; no personal endorsement"}
              </dd>
            </div>
            <div>
              <dt>Starts</dt>
              <dd>
                <time dateTime={preview.activity.startsAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "full",
                    timeStyle: "short",
                    timeZone: preview.activity.timezone,
                  }).format(new Date(preview.activity.startsAt))}{" "}
                  ({preview.activity.timezone})
                </time>
              </dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {formatMoney(preview.activity.priceMinorUnits, preview.activity.currency)} — no
                payment in this prototype
              </dd>
            </div>
            <div>
              <dt>Spots</dt>
              <dd>
                {preview.activity.bookedCount} booked · {preview.activity.remainingSpots} remaining
                of {preview.activity.capacity}
              </dd>
            </div>
            <div>
              <dt>Invitation expires</dt>
              <dd>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "full",
                  timeStyle: "short",
                  timeZone: preview.activity.timezone,
                }).format(new Date(preview.expiresAt))}{" "}
                ({preview.activity.timezone})
              </dd>
            </div>
          </dl>
          <LiveStatus live={live} />
          {preview.state !== "claimable" && (
            <div className="notice notice-warn" role="alert">
              {lifecycleExplanation(preview.state)}{" "}
              {currentBooking?.phase.kind === "confirmed"
                ? "Your saved booking below is unaffected."
                : "You can still browse other activities."}
            </div>
          )}
          {validityPending && (
            <p className="hint" role="status">
              Fresh invitation availability is required before retrying.{" "}
              <button type="button" className="button-ghost" onClick={() => setValidityRetry((value) => value + 1)}>
                Refresh invitation
              </button>
            </p>
          )}
          {currentBooking !== null && (
            <ClaimControls
              booking={currentBooking}
              claimable={claimable}
              onClaim={claim}
              onCheckAgain={() => {
                if (sessionToken !== null && activityId !== null) {
                  booking.checkAgain(activityId, sessionToken);
                }
              }}
              onNeedIdentity={onRequestIdentity}
            />
          )}
          {preview.state === "claimable" && currentBooking?.phase.kind === "idle" && (
            <p className="hint">
              Claiming joins the shared plan with this invitation retained as your booking's
              source. No spot is held until the server saves your booking.
            </p>
          )}
          <div className="invite-actions">
            <button type="button" className="button-ghost" onClick={onBrowse}>Browse activities</button>
          </div>
        </>
      )}
    </section>
  );
}
