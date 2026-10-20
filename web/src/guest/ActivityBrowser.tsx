import { formatMoney } from "../money.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicActivityView } from "../api.js";
import { compareVersions } from "../live/availability.js";
import { useSession } from "../session.js";

/**
 * Public activity browse (issue #15, US02): the list loads and stays
 * selectable before any identity selection. A failed load means availability
 * is unknown — never zero — so the error state offers Retry instead of
 * facts. Selection is the app's single selected activity (URL-persistent).
 */



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
    <section className="panel browse-panel" aria-labelledby="browse-heading">
      <div className="panel-head">
        <h2 id="browse-heading">Browse activities</h2>
        <button
          type="button"
          className="button-ghost"
          onClick={() => setRetry((value) => value + 1)}
          disabled={loading}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {loading && <p className="hint" aria-busy="true">Loading activities — availability unknown until they arrive…</p>}
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
      <ul className="browse-list">
        {(activities ?? []).map((loaded) => {
          const activity =
            live !== null && live.activityId === loaded.id && compareVersions(live.version, loaded.availabilityVersion) > 0
              ? { ...loaded, remainingSpots: live.remainingSpots }
              : loaded;
          return (
          <li key={activity.id}>
            <button
              type="button"
              className={`browse-item${activity.id === selectedId ? " selected" : ""}`}
              onClick={() => onSelect(activity.id)}
              aria-current={activity.id === selectedId ? "true" : undefined}
            >
              <span className="browse-title">{activity.title}</span>
              <span className="browse-meta">
                {activity.hostDisplayName} ·{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: activity.timezone,
                }).format(new Date(activity.startsAt))}{" "}
                ({activity.timezone}) · {formatMoney(activity.priceMinorUnits, activity.currency)} ·{" "}
                {activity.started
                  ? "started"
                  : activity.remainingSpots > 0
                    ? `${activity.remainingSpots} of ${activity.capacity} spots left`
                    : "full"}
              </span>
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
