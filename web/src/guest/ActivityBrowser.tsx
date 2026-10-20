import { formatMoneyCompact } from "../money.js";
import { chipDateRange, initials, zoneOffsetLabel } from "../present.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicActivityView } from "../api.js";
import { compareVersions } from "../live/availability.js";
import { useSession } from "../session.js";
import { ArrowRightIcon, CalendarIcon } from "../icons.js";


function CardSpots({ activity }: { activity: PublicActivityView }): ReactNode {
  if (activity.started) {
    return <span className="card-spots">Started<span className="card-spots-sub">bookings closed</span></span>;
  }
  if (activity.remainingSpots > 0) {
    const noun = activity.remainingSpots === 1 ? "spot" : "spots";
    return <span className="card-spots"><span className="spots-free">{activity.remainingSpots} {noun} left</span><span className="card-spots-sub">of {activity.capacity}</span></span>;
  }
  return <span className="card-spots"><span className="spots-none">No spots left</span><span className="card-spots-sub">of {activity.capacity}</span></span>;
}

export function ActivityBrowser({
  selectedId,
  onSelect,
  bookingRevision = 0,
  live = null,
}: {
  selectedId: string | null;
  onSelect: (activityId: string) => void;
  bookingRevision?: number;
  /** The selected activity's live availability; a newer version wins over the loaded row. */
  live?: { activityId: string; version: string; remainingSpots: number } | null;
}): ReactNode {
  const { api } = useSession();
  const [activities, setActivities] = useState<PublicActivityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setError(null);
    void api
      .listActivities()
      .then((loaded) => {
        if (generation.current !== currentGeneration) return;
        setActivities(loaded);
      })
      .catch((err) => {
        if (generation.current !== currentGeneration) return;
        setActivities(null);
        setError(err instanceof Error ? err.message : "Could not load activities.");
      });
    return () => {
      generation.current += 1;
    };
  }, [api, retry, bookingRevision]);

  const loading = activities === null && error === null;

  return (
    <section aria-label="Explore activities">
      <div className="panel-head list-tools">
        <span className="hint" aria-busy={loading || undefined}>
          {loading ? "Loading activities — availability unknown until they arrive…" : ""}
        </span>
        <button
          type="button"
          className="button-ghost"
          onClick={() => setRetry((value) => value + 1)}
          disabled={loading}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error !== null && (
        <div className="notice notice-warn" role="alert">
          {error} Availability is unknown, not zero.{" "}
          <button type="button" className="button-ghost" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}
      {!loading && error === null && activities !== null && activities.length === 0 && (
        <p className="hint">Nothing published yet — check back soon.</p>
      )}
      <ul className="activity-grid">
        {(activities ?? []).map((loaded) => {
          const activity =
            live !== null && live.activityId === loaded.id && compareVersions(live.version, loaded.availabilityVersion) > 0
              ? { ...loaded, remainingSpots: live.remainingSpots }
              : loaded;
          const offset = zoneOffsetLabel(activity.startsAt, activity.timezone);
          return (
          <li key={activity.id}>
            <button
              type="button"
              className={`activity-card${activity.id === selectedId ? " selected" : ""}`}
              onClick={() => onSelect(activity.id)}
              aria-current={activity.id === selectedId ? "true" : undefined}
            >
              <span className="chip-row">
                <span className="chip"><CalendarIcon /> {chipDateRange(activity.startsAt, activity.endsAt, activity.timezone)}</span>
                {offset !== null && <span className="chip">{offset}</span>}
              </span>
              <span className="card-title">{activity.title}</span>
              <span className="hosted-by"><span className="avatar">{initials(activity.hostDisplayName)}</span> Hosted by {activity.hostDisplayName}</span>
              {activity.description && <span className="card-desc">{activity.description}</span>}
              <span className="card-foot">
                <span className="card-price">{formatMoneyCompact(activity.priceMinorUnits, activity.currency)}<span className="card-price-sub">per person</span></span>
                <span className="card-separator" />
                <CardSpots activity={activity} />
                <span className="card-arrow button-icon"><ArrowRightIcon /></span>
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
