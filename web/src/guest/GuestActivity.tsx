import { IdentityPanel } from "../IdentityPanel.js";
import { Participants } from "../host/Participants.js";
import { formatMoneyCompact } from "../money.js";
import { chipDateRange, chipDateTime, countryName, durationLabel, initials, zoneOffsetLabel } from "../present.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BookingStore, BookingState } from "../booking-store.js";
import type { ActivityDetailView } from "../api.js";
import { LiveStatus } from "../live/LiveStatus.js";
import { compareVersions, useLiveAcknowledgement, useLiveAvailability } from "../live/availability.js";
import { useSession } from "../session.js";
import { emitActivityViewed } from "../telemetry.js";
import { InviteCard } from "./InviteCard.js";
import { ArrowLeftIcon, ArrowRightIcon, CalendarIcon, ClockIcon, GlobeIcon, GroupIcon } from "../icons.js";

function BookingControls({
  booking,
  detail,
  validityPending,
  onBook,
  onCheckAgain,
  reviewing,
  onReview,
}: {
  booking: BookingState;
  detail: ActivityDetailView;
  validityPending: boolean;
  onBook: () => void;
  onCheckAgain: () => void;
  reviewing: boolean;
  onReview: () => void;
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
            ? " Availability has been refreshed."
            : ""}
        </div>
        {(phase.reason === "absent" || phase.reason === "failed" || phase.reason === "rate-limited") && (
          <>
            <button type="button" className="button-primary" onClick={onBook} disabled={!retryEnabled}>
              {validityPending ? "Refreshing availability…" : reviewing ? "Book again" : "Review booking"}
            </button>
            {phase.reason === "absent" && (
              <p className="hint">
                You can try again once availability is refreshed. Nothing is sent automatically.
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
        <button type="button" className="button-primary book-cta" disabled>
          Booking closed
        </button>
        <p className="hint">This activity has started, so new bookings are closed.</p>
      </div>
    );
  }
  if (detail.remainingSpots <= 0) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary book-cta" disabled>
          Full
        </button>
        <p className="hint">Every spot is taken. If one of your bookings exists, it is shown above.</p>
      </div>
    );
  }
  if (!reviewing) {
    return (
      <div className="booking-panel">
        <button type="button" className="button-primary book-cta" onClick={onReview}>
          Book a spot<span className="cta-arrow"><ArrowRightIcon /></span>
        </button>
      </div>
    );
  }
  if (!ready) {
    if (state.status.status === "credential-lost") return null;
    return <IdentityPanel contextNote="Your checkout is kept." />;
  }
  return (
    <div className="booking-panel">
      <button type="button" className="button-primary book-cta" onClick={onBook}>Confirm one spot</button>
      <p className="hint">Your spot is confirmed once your booking is saved.</p>
    </div>
  );
}

export function GuestActivity({
  activityId,
  booking,
  visible,
  observationId,
  onAvailability,
  onBack,
  backLabel = "Back to Explore",
}: {
  activityId: string;
  booking: BookingStore;
  /** Newer applied availability, so other views of this activity can match it. */
  onAvailability?: (availability: { activityId: string; version: string; remainingSpots: number }) => void;
  visible: boolean;
  /** Shared per selected activity — a sibling panel's emission is a duplicate. */
  observationId: string;
  /** Return from the detail page to the list it was opened from. */
  onBack?: () => void;
  backLabel?: string;
}): ReactNode {
  const { api, state } = useSession();
  const [reviewing, setReviewing] = useState(false);
  const [detail, setDetail] = useState<ActivityDetailView | null>(null);
  const [capabilities, setCapabilities] = useState<ActivityDetailView["invites"]>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [validityPending, setValidityPending] = useState(false);
  const generation = useRef(0);
  const observed = useRef<string | null>(null);
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
        const { activity, invites } = await api.getActivity(activityId, { token: sessionToken });
        if (generation.current !== currentGeneration) return;
        setDetail(activity);
        setCapabilities(invites);
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
    if (live.applied !== null) {
      onAvailability?.({ activityId, version: live.applied.version, remainingSpots: live.applied.remainingSpots });
    }
  }, [live.applied, activityId, onAvailability]);

  useEffect(() => {
    if (!visible || loading || loadError !== null || detail === null || detail.id !== activityId) return;
    if (observed.current === observationId) return;
    observed.current = observationId;
    emitActivityViewed(api, {
      eventId: observationId,
      activityId,
      visitorId: state.visitorId,
      token: sessionToken,
    });
  }, [api, activityId, detail, loading, loadError, state.visitorId, sessionToken, visible, observationId]);

  // Opening the page unmounts the card or row that had focus; land focus on
  // the heading instead of leaving it on the document body.
  const heading = useRef<HTMLHeadingElement>(null);
  const detailId = detail?.id;
  useEffect(() => {
    if (detailId !== activityId) return;
    if (document.activeElement === null || document.activeElement === document.body) heading.current?.focus();
  }, [detailId, activityId]);

  if (loading) {
    return (
      <section className="activity-page" aria-busy="true" aria-label="Activity">
        {onBack && <button type="button" className="back-link" onClick={onBack}><ArrowLeftIcon />{backLabel}</button>}
        <p className="hint">Opening the activity…</p>
        <p className="hint">Availability is unknown until it loads — it is not zero.</p>
      </section>
    );
  }
  if (loadError !== null) {
    return (
      <section className="activity-page" aria-label="Activity">
        {onBack && <button type="button" className="back-link" onClick={onBack}><ArrowLeftIcon />{backLabel}</button>}
        <div className="notice notice-warn" role="alert">
          {loadError.replace(/\.?$/, ".")} Availability is unknown, not zero.
        </div>
        <button type="button" className="button-primary" onClick={() => setRefresh((value) => value + 1)}>
          Retry
        </button>
      </section>
    );
  }
  if (detail === null) return null;
  const offset = zoneOffsetLabel(detail.startsAt, detail.timezone);

  return (
    <section
      className="activity-page"
      aria-labelledby={reviewing ? undefined : "guest-detail-heading"}
      aria-label={reviewing ? "Checkout" : "Activity"}
    >
      {onBack && <button type="button" className="back-link" onClick={onBack}><ArrowLeftIcon />{backLabel}</button>}
      {reviewing && <button type="button" className="button-ghost" onClick={() => setReviewing(false)}>Back to activity</button>}
      <div className="detail-layout">
        <div className="detail-main">
          <h1 className="detail-title" id="guest-detail-heading" ref={heading} tabIndex={-1}>{detail.title}</h1>
          <p className="detail-sub">{detail.description}</p>
          <div className="detail-facts">
            <span className="hosted-by"><span className="avatar">{initials(detail.hostDisplayName)}</span> <span>Hosted by <strong>{detail.hostDisplayName}</strong></span></span>
            <span className="fact-divider" aria-hidden="true" />
            <span className="chip"><CalendarIcon /> {chipDateRange(detail.startsAt, detail.endsAt, detail.timezone)}</span>
            {offset !== null && <span className="chip">{offset}</span>}
            {detail.started && <span className="pill pill-blue">Started</span>}
          </div>
          {!reviewing && <>
            <section className="detail-section">
              <h2>About this activity</h2>
              <p className="activity-prose">{detail.description}</p>
            </section>
            <section className="detail-section">
              <h2>What we&rsquo;ll do</h2>
              <p className="activity-prose">{detail.itinerary}</p>
            </section>
            <section className="detail-section">
              <h2>Meet your host</h2>
              <div className="host-card">
                <span className="avatar avatar-large">{initials(detail.hostDisplayName)}</span>
                <div className="host-identity">
                  <div className="host-name">{detail.hostDisplayName}</div>
                  <div className="host-role">Host</div>
                </div>
                <p className="host-summary">{detail.host?.summary || "This host has not added a background yet."}</p>
              </div>
            </section>
          </>}
        </div>
        <aside className="detail-aside">
          <div className="aside-card">
            <p className="aside-label">Price</p>
            <p className="aside-price">{formatMoneyCompact(detail.priceMinorUnits, detail.currency)}</p>
            <p className="aside-price-sub">per person</p>
            <div className="aside-row">
              <span className="row-icon"><CalendarIcon /></span>
              <div>
                <div className="row-label">Date and time</div>
                <div className="row-value">{chipDateRange(detail.startsAt, detail.endsAt, detail.timezone)}{offset !== null && <> <span className="chip">{offset}</span></>}</div>
              </div>
            </div>
            <div className="aside-row">
              <span className="row-icon"><GroupIcon /></span>
              <div>
                <div className="row-label">Availability</div>
                <div className="row-value">
                  {detail.started
                    ? <span>Bookings closed · {detail.bookedCount} booked</span>
                    : <span className={detail.remainingSpots > 0 ? "spots-free" : "spots-none"}>{detail.remainingSpots} of {detail.capacity} {detail.capacity === 1 ? "spot" : "spots"} left</span>}
                </div>
              </div>
            </div>
            {detail.started ? <p className="notice" role="status">Bookings closed — this activity has started.</p> : detail.remainingSpots === 0 ? <p className="notice" role="status">Sold out — every spot is booked.</p> : null}
            {reviewing && <p>1 spot · {state.status.status === "ready" ? `Booking as ${state.status.user.email}` : "Sign in below to continue"}</p>}
            <LiveStatus live={live} />
            {currentBooking !== null && (
              <BookingControls
                booking={currentBooking}
                detail={detail}
                validityPending={validityPending}
                onBook={() => {
                  if (!reviewing) {
                    setReviewing(true);
                    return;
                  }
                  if (sessionToken !== null) booking.submit(activityId, sessionToken);
                }}
                onCheckAgain={() => {
                  if (sessionToken !== null) booking.checkAgain(activityId, sessionToken);
                }}
                reviewing={reviewing}
                onReview={() => setReviewing(true)}
              />
            )}
          </div>
          <div className="aside-card aside-facts">
            <div className="fact-row">
              <span className="row-icon"><GroupIcon /></span>
              <span className="row-label">Group size</span>
              <span className="row-value">Up to {detail.capacity} people</span>
            </div>
            <div className="fact-row">
              <span className="row-icon"><ClockIcon /></span>
              <span className="row-label">Duration</span>
              <span className="row-value">{durationLabel(detail.startsAt, detail.endsAt)}</span>
            </div>
            {detail.country !== null && <div className="fact-row">
              <span className="row-icon"><GlobeIcon /></span>
              <span className="row-label">Country</span>
              <span className="row-value">{countryName(detail.country)}</span>
            </div>}
          </div>
          {(isOwner || currentBooking?.phase.kind === "confirmed") && !reviewing && (
            <InviteCard key={`${activityId}:${sessionToken}`} activityId={activityId} capabilities={capabilities} started={detail.started} />
          )}
          {isOwner && !reviewing && <div className="aside-card"><Participants key={`${activityId}:${sessionToken}`} activityId={activityId} version={detail.availabilityVersion} /></div>}
        </aside>
      </div>
      {!reviewing && <section className="detail-section previous-section">
        <h2>Previous activities</h2>
        {detail.host?.previousActivities.length ? (
          <ul className="previous-grid">
            {detail.host.previousActivities.map(activity => (
              <li key={activity.id} className="previous-card">
                <span className="previous-title">{activity.title}</span>
                <span className="card-spots-sub">{chipDateTime(activity.startsAt, detail.timezone)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="hint">No previous activities yet.</p>}
      </section>}
    </section>
  );
}
