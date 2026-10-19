import { Participants } from "../host/Participants.js";
import { formatMoney } from "../money.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BookingStore, BookingState } from "../booking-store.js";
import type { ActivityDetailView } from "../api.js";
import { LiveStatus } from "../live/LiveStatus.js";
import { compareVersions, useLiveAcknowledgement, useLiveAvailability } from "../live/availability.js";
import { useSession } from "../session.js";
import { emitActivityViewed } from "../telemetry.js";

/**
 * Public activity detail with the booking panel (issue #15, US02/03). Facts
 * load before any identity selection; booking requires one. The booking
 * phase comes from the shared controller (booking-store.ts), so pending is
 * never a confirmation, an unknown outcome reconciles against the saved
 * booking, and a refusal refreshes the real facts instead of claiming them.
 */



function BookingControls({
  booking,
  detail,
  validityPending,
  onBook,
  onCheckAgain,
  onNeedIdentity,
}: {
  booking: BookingState;
  detail: ActivityDetailView;
  validityPending: boolean;
  onBook: () => void;
  onCheckAgain: () => void;
  onNeedIdentity: () => void;
}): ReactNode {
  const { state } = useSession();
  const phase = booking.phase;
  const ready = state.status.status === "ready";
  const bookable = !detail.started && detail.remainingSpots > 0;
  const [now, setNow] = useState(Date.now);
  const retryAt = phase.kind === "refused" ? phase.retryAt : undefined;
  useEffect(() => {
    if (retryAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  if (phase.kind === "confirmed") {
    return (
      <div className="booking-panel">
        <div className="notice notice-good" role="status">
          Your spot is saved — you are in the plan for {detail.title}.
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
        </dl>
        <p className="hint">
          This is the saved record — reopening or refreshing shows it again, even if the
          activity is now full or started.
        </p>
      </div>
    );
  }

  if (phase.kind === "unknown") {
    return (
      <div className="booking-panel">
        <div className="notice notice-warn" role="alert">
          We could not confirm whether your booking was saved. Your request may still be in
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
    const retryEnabled =
      (phase.reason === "absent" || phase.reason === "failed" || phase.reason === "rate-limited") &&
      !validityPending &&
      (retryAt === undefined || now >= retryAt) &&
      bookable;
    return (
      <div className="booking-panel">
        <div className="notice notice-warn" role="alert">
          {phase.message}
          {retryAt !== undefined && now < retryAt ? ` Try again in about ${Math.ceil((retryAt - now) / 1000)}s.` : ""}
          {phase.reason === "sold-out" || phase.reason === "absent" || phase.reason === "started"
            ? " The facts below were refreshed just now."
            : ""}
        </div>
        {(phase.reason === "absent" || phase.reason === "failed" || phase.reason === "rate-limited") && (
          <>
            <button type="button" className="button-primary" onClick={onBook} disabled={!retryEnabled}>
              {validityPending ? "Refreshing availability…" : "Book again"}
            </button>
            {phase.reason === "absent" && (
              <p className="hint">
                A retry books again with the same request identity once availability above is
                confirmed. Nothing is sent automatically.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  if (phase.kind === "pending" || phase.kind === "checking") {
    return (
      <div className="booking-panel" aria-busy="true">
        <button type="button" className="button-primary" disabled>
          {phase.kind === "pending" ? "Reserving…" : "Checking your booking…"}
        </button>
        <p className="hint">
          {phase.kind === "pending"
            ? "Your request is in progress — this is not a confirmation yet."
            : phase.quiet
              ? "Looking up any booking you already hold for this activity…"
              : "Looking up your saved booking before anything else is attempted."}
        </p>
      </div>
    );
  }

  // idle
  if (detail.started) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary" disabled>
          Booking closed
        </button>
        <p className="hint">This activity has started, so new bookings are closed.</p>
      </div>
    );
  }
  if (detail.remainingSpots <= 0) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary" disabled>
          Full
        </button>
        <p className="hint">Every spot is taken. If one of your bookings exists, it is shown above.</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary" onClick={onNeedIdentity}>
          Sign in to book
        </button>
        <p className="hint">
          Your selected activity stays here while you sign in.
        </p>
      </div>
    );
  }
  return (
    <div className="booking-panel">
      <button type="button" className="button-primary" onClick={onBook}>
        Book a spot
      </button>
      <p className="hint">
        One spot is reserved only after the server saves your booking — no payment in this
        prototype.
      </p>
    </div>
  );
}

export function GuestActivity({
  activityId,
  booking,
  visible,
  observationId,
  onRequestIdentity,
  onOpenInvites,
}: {
  activityId: string;
  booking: BookingStore;
  visible: boolean;
  /** Shared per selected activity — a sibling panel's emission is a duplicate. */
  observationId: string;
  onRequestIdentity: () => void;
  onOpenInvites: () => void;
}): ReactNode {
  const { api, state } = useSession();
  const [detail, setDetail] = useState<ActivityDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [validityPending, setValidityPending] = useState(false);
  const generation = useRef(0);
  const sessionToken = state.status.status === "ready" ? state.status.token : null;
  const isOwner = state.status.status === "ready" && (detail?.hostId ?? detail?.host?.id) === state.status.user.id;

  // The controller owns this activity's phase; subscribe for updates.
  const [livePhase, setLivePhase] = useState(() => booking.getState());
  useEffect(() => booking.subscribe(setLivePhase), [booking]);
  const currentBooking = livePhase.activityId === activityId ? livePhase : null;

  // Selection + credential: (re)point the controller and check any saved
  // booking so reopening shows existing membership.
  useEffect(() => {
    booking.viewActivity(activityId, sessionToken);
    return () => booking.viewActivity(null, null);
  }, [booking, activityId, sessionToken]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const { activity } = await api.getActivity(activityId, { token: sessionToken });
        if (generation.current !== currentGeneration) return;
        setDetail(activity);
        setLoading(false);
        setValidityPending(false);
      } catch (err) {
        if (generation.current !== currentGeneration) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : "Could not load this activity.");
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [api, activityId, refresh, sessionToken]);

  // A sold-out or reconciled-absent refusal refreshes the real facts; the
  // explicit retry stays disabled until that refresh has landed.
  const refusedReason = currentBooking?.phase.kind === "refused" ? currentBooking.phase.reason : null;
  const previousRefused = useRef<string | null>(null);
  useEffect(() => {
    if (
      (refusedReason === "sold-out" || refusedReason === "absent" || refusedReason === "started" || refusedReason === "completed") &&
      previousRefused.current !== refusedReason
    ) {
      setValidityPending(true);
      setRefresh((value) => value + 1);
    }
    previousRefused.current = refusedReason;
  }, [refusedReason]);

  // Live availability (issue #18): the shared lifecycle owner binds only
  // while this panel is visible with facts displayed. A snapshot refresh is
  // a quiet metadata recheck; counts arrive exclusively through the owner's
  // arbitration so a delayed HTTP response can never regress a newer frame.
  const live = useLiveAvailability({
    activityId,
    visible: visible && !loading && loadError === null && detail !== null,
    displayedVersion: detail?.availabilityVersion ?? null,
    loadSnapshot: useCallback(
      async (signal: AbortSignal) => {
        const { activity } = await api.getActivity(activityId, { signal });
        setDetail((prev) =>
          prev !== null && prev.id === activity.id ? { ...prev, started: prev.started || activity.started } : prev,
        );
        return { availabilityVersion: activity.availabilityVersion, remainingSpots: activity.remainingSpots };
      },
      [api, activityId],
    ),
    api,
  });
  useLiveAcknowledgement(live, detail?.availabilityVersion ?? null);
  useEffect(() => {
    const applied = live.applied;
    if (applied === null) return;
    setDetail((prev) => {
      if (prev === null || prev.id !== activityId) return prev;
      if (compareVersions(applied.version, prev.availabilityVersion) <= 0) return prev;
      const remaining = applied.remainingSpots;
      return {
        ...prev,
        remainingSpots: remaining,
        bookedCount: Math.max(0, prev.capacity - remaining),
        availabilityVersion: applied.version,
      };
    });
  }, [live.applied, activityId]);

  useEffect(() => {
    if (!visible || loading || loadError !== null || detail === null || detail.id !== activityId) return;
    emitActivityViewed(api, {
      eventId: observationId,
      activityId,
      visitorId: state.visitorId,
      token: sessionToken,
    });
  }, [api, activityId, detail, loading, loadError, state.visitorId, sessionToken, visible, observationId]);

  if (loading) {
    return (
      <section className="panel detail-panel" aria-busy="true" aria-label="Activity">
        <p className="hint">Opening the activity…</p>
        <p className="hint">Availability is unknown until it loads — it is not zero.</p>
      </section>
    );
  }
  if (loadError !== null) {
    return (
      <section className="panel detail-panel" aria-label="Activity">
        <div className="notice notice-warn" role="alert">
          {loadError} Availability is unknown, not zero.
        </div>
        <button type="button" className="button-primary" onClick={() => setRefresh((value) => value + 1)}>
          Retry
        </button>
      </section>
    );
  }
  if (detail === null) return null;

  const startsInZone = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: detail.timezone,
  }).format(new Date(detail.startsAt));

  return (
    <section className="panel detail-panel" aria-labelledby="guest-detail-heading">
      <p className="eyebrow">{detail.started ? "Started" : "Upcoming"}</p>
      <h2 id="guest-detail-heading">{detail.title}</h2>
      <p className="activity-prose">{detail.description}</p>
      <dl className="detail-grid">
        <div>
          <dt>Starts</dt>
          <dd>
            <time dateTime={detail.startsAt}>{startsInZone} ({detail.timezone})</time>
          </dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{formatMoney(detail.priceMinorUnits, detail.currency)}</dd>
        </div>
        <div>
          <dt>Spots</dt>
          <dd>
            {detail.bookedCount} booked · {detail.remainingSpots} remaining of {detail.capacity}
          </dd>
        </div>
      </dl>
      {detail.started ? <p className="notice" role="status">Bookings closed — this activity has started.</p> : detail.remainingSpots === 0 ? <p className="notice" role="status">Sold out — every spot is booked.</p> : null}
      <h3>Itinerary</h3>
      <p className="activity-prose">{detail.itinerary}</p>
      <h3>Your host · {detail.hostDisplayName}</h3>
      <p>{detail.host?.summary || "This host has not added a background yet."}</p>
      <h4>Previous activities</h4>
      {detail.host?.previousActivities.length ? <ul>{detail.host.previousActivities.map(activity => <li key={activity.id}>{activity.title}</li>)}</ul> : <p className="hint">No previous activities yet.</p>}
      <LiveStatus live={live} />
      {isOwner && <Participants key={`${activityId}:${sessionToken}`} activityId={activityId} version={detail.availabilityVersion} />}
      {currentBooking !== null && (
        <BookingControls
          booking={currentBooking}
          detail={detail}
          validityPending={validityPending}
          onBook={() => {
            if (sessionToken !== null) booking.submit(activityId, sessionToken);
          }}
          onCheckAgain={() => {
            if (sessionToken !== null) booking.checkAgain(activityId, sessionToken);
          }}
          onNeedIdentity={onRequestIdentity}
        />
      )}
      {(isOwner || currentBooking?.phase.kind === "confirmed") && (
        <div className="invite-entry">
          <button type="button" className="button-ghost" onClick={onOpenInvites}>
            Invite someone to this plan
          </button>
        </div>
      )}
    </section>
  );
}
