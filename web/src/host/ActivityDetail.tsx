import { formatMoney } from "../money.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, type ActivityDetailView, type ParticipantsView } from "../api.js";
import { LiveStatus } from "../live/LiveStatus.js";
import { compareVersions, useLiveAcknowledgement, useLiveAvailability } from "../live/availability.js";
import { useSession } from "../session.js";
import { emitActivityViewed } from "../telemetry.js";

/**
 * Selected-activity detail for the host: public detail, host-only
 * participants and idempotent plan completion. Every authorized fetch is
 * generation-guarded and abortable, so a delayed response from an abandoned
 * activity or identity can never repopulate the panel — private
 * participants cannot leak across switches. activity_viewed is emitted from
 * the effect that runs after visible details have been applied.
 */



export function ActivityDetail({
  activityId,
  refreshToken,
  visible,
  observationId,
  onOpenInvites,
}: {
  activityId: string;
  /** Bumps when authorized state must reload (e.g. after re-selection). */
  refreshToken: number;
  visible: boolean;
  /** Shared per selected activity — a sibling panel's emission is a duplicate. */
  observationId: string;
  /** Host entry to the invitation view (issue #16). */
  onOpenInvites?: () => void;
}): ReactNode {
  const { api, authorized, state } = useSession();
  const [detail, setDetail] = useState<ActivityDetailView | null>(null);
  const [participants, setParticipants] = useState<ParticipantsView | null>(null);
  const [participantsDenied, setParticipantsDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const [retry, setRetry] = useState(0);
  const sessionToken = state.status.status === "ready" ? state.status.token : null;
  // The availability version the participant list reflects, plus a run guard
  // so a late private response can never overwrite a newer refetch.
  const [participantsVersion, setParticipantsVersion] = useState<string | null>(null);
  const participantsRunRef = useRef(0);
  const [participantsStale, setParticipantsStale] = useState(false);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setParticipants(null);
    setParticipantsVersion(null);
    setParticipantsStale(false);
    participantsRunRef.current += 1;
    setParticipantsDenied(false);

    const token = state.status.status === "ready" ? state.status.token : null;
    void (async () => {
      try {
        const { activity, invites } = await api.getActivity(activityId, { token, signal: controller.signal });
        if (generation.current !== currentGeneration) return;
        setDetail({ ...activity, invites });
        setLoading(false);
        // Host-only; a non-owner is refused without any private data.
        if (token !== null) {
          try {
            const participants = await authorized((authorizedApi, authorizedToken) =>
              authorizedApi.getParticipants(activityId, authorizedToken, controller.signal),
            );
            if (generation.current !== currentGeneration) return;
            setParticipantsVersion(activity.availabilityVersion);
            setParticipants(participants);
          } catch (err) {
            if (generation.current !== currentGeneration) return;
            if (err instanceof ApiError && (err.status === 403 || err.code === "forbidden")) {
              setParticipantsDenied(true);
            } else if (!(err instanceof DOMException && err.name === "AbortError")) {
              throw err;
            }
          }
        }
      } catch (err) {
        if (generation.current !== currentGeneration) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : "Could not load this activity.");
      }
    })();
    return () => { generation.current += 1; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId, refreshToken, sessionToken, retry]);

  useEffect(() => {
    if (!visible || loading || loadError !== null || detail === null || detail.id !== activityId) return;
    emitActivityViewed(api, { eventId: observationId, activityId, visitorId: state.visitorId, token: sessionToken });
  }, [api, activityId, detail, loading, loadError, state.visitorId, sessionToken, visible, observationId]);

  // Live availability (issue #18): the shared lifecycle owner binds only
  // while this panel is visible with facts displayed. The host's private
  // participant list refreshes when a newer version is applied; a failed
  // private refresh is disclosed and recoverable and never blocks the public
  // availability, and completion state is untouched by interval refreshes.
  const fetchParticipants = useCallback(
    (forVersion: string | null): void => {
      if (sessionToken === null) return;
      const run = ++participantsRunRef.current;
      const currentGeneration = generation.current;
      void authorized((authorizedApi, token) => authorizedApi.getParticipants(activityId, token))
        .then((participants) => {
          if (participantsRunRef.current !== run || generation.current !== currentGeneration) return;
          if (forVersion !== null) setParticipantsVersion(forVersion);
          setParticipants(participants);
          setParticipantsStale(false);
        })
        .catch(() => {
          if (participantsRunRef.current !== run || generation.current !== currentGeneration) return;
          setParticipantsStale(true);
        });
    },
    [activityId, sessionToken, authorized],
  );
  const live = useLiveAvailability({
    activityId,
    visible: visible && !loading && loadError === null && detail !== null,
    displayedVersion: detail?.availabilityVersion ?? null,
    loadSnapshot: useCallback(
      async (signal: AbortSignal) => {
        const { activity } = await authorized((authorizedApi, token) =>
          authorizedApi.getActivity(activityId, { token, signal }),
        );
        setDetail((prev) =>
          prev !== null && prev.id === activity.id
            ? { ...prev, started: prev.started || activity.started, invites: activity.invites ?? prev.invites }
            : prev,
        );
        return { availabilityVersion: activity.availabilityVersion, remainingSpots: activity.remainingSpots };
      },
      [activityId, authorized],
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
    const applied = live.applied;
    if (applied === null || participantsVersion === null) return;
    if (compareVersions(applied.version, participantsVersion) <= 0) return;
    fetchParticipants(applied.version);
  }, [live.applied, fetchParticipants, participantsVersion]);

  if (loading) {
    return (
      <section className="panel detail-panel" aria-busy="true">
        <p className="hint">Opening the activity…</p>
      </section>
    );
  }
  if (loadError !== null) {
    return (
      <section className="panel detail-panel">
        <div className="notice notice-warn" role="alert">{loadError}</div>
        <button type="button" className="button-primary" onClick={() => setRetry(value => value + 1)}>Retry</button>
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
    <section className="panel detail-panel" aria-labelledby="detail-heading">
      <p className="eyebrow">{detail.started ? "Started" : "Upcoming"}</p>
      <h2 id="detail-heading">{detail.title}</h2>
      <p className="activity-prose">{detail.description}</p>
      <h3>Itinerary</h3>
      <p className="activity-prose">{detail.itinerary}</p>
      <h3>About your host</h3>
      <p>{detail.host?.summary || "This host has not added a background yet."}</p>
      <h4>Previous activities</h4>
      {detail.host?.previousActivities.length ? <ul>{detail.host.previousActivities.map(activity => <li key={activity.id}>{activity.title}</li>)}</ul> : <p className="hint">No previous activities yet.</p>}
      <dl className="detail-grid">
        <div>
          <dt>Host</dt>
          <dd>{detail.hostDisplayName}</dd>
        </div>
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
          <dd>{detail.bookedCount} booked · {detail.remainingSpots} remaining of {detail.capacity}</dd>
        </div>
      </dl>
      {detail.started ? <p className="notice" role="status">Bookings closed — this activity has started.</p> : detail.remainingSpots === 0 ? <p className="notice" role="status">Sold out — every spot is booked.</p> : null}
      <LiveStatus live={live} />

      {participantsDenied ? (
        <div className="notice" role="note">
          Participants are visible to the owning host only.
        </div>
      ) : participants !== null ? (
        <div className="participants">
          <h3>Participants ({participants.confirmedCount})</h3>
          {participantsStale && (
            <div className="notice notice-warn" role="status">
              The participant list could not be refreshed and may be out of date.{" "}
              <button type="button" className="button-ghost" onClick={() => fetchParticipants(null)}>
                Refresh participants
              </button>
            </div>
          )}
          {participants.participants.length === 0 ? (
            <p className="hint">No confirmed bookings yet.</p>
          ) : (
            <ul>
              {participants.participants.map((participant) => (
                <li key={participant.userId}>{participant.displayName}</li>
              ))}
            </ul>
          )}
          {onOpenInvites !== undefined && (
            <div className="invite-entry">
              <button type="button" className="button-ghost" onClick={onOpenInvites}>
                Invite guests to this activity
              </button>
              <p className="hint">
                Create a contact vouch or a public share link. Invitations never reserve spots.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="notice" role="note">Sign in as the host to see participants.</div>
      )}
    </section>
  );
}
