import type { ReactNode } from "react";
import type { HostActivityView } from "../api.js";

/**
 * The host's own activities (GET /my/activities). Selecting one is a client
 * convenience that drives which detail the workspace shows — the backend
 * session, never this toggle, authorizes every action.
 */
export function HostedActivities({
  activities,
  selectedId,
  onSelect,
  reload,
  loading,
  error,
}: {
  activities: HostActivityView[];
  selectedId: string | null;
  onSelect: (activityId: string) => void;
  reload: () => void;
  loading: boolean;
  error: string | null;
}): ReactNode {
  return (
    <section className="panel hosted-panel" aria-labelledby="hosted-heading">
      <div className="panel-head">
        <h2 id="hosted-heading">My activities</h2>
        <button type="button" className="button-ghost" onClick={reload} disabled={loading}>
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error !== null && (
        <div className="notice notice-warn" role="alert">
          {error}{" "}
          <button type="button" className="button-ghost" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {!loading && error === null && activities.length === 0 && (
        <p className="hint">Nothing published yet — your first activity appears here.</p>
      )}
      <ul className="hosted-list">
        {activities.map((activity) => (
          <li key={activity.id}>
            <button
              type="button"
              className={`hosted-item${activity.id === selectedId ? " selected" : ""}`}
              onClick={() => onSelect(activity.id)}
              aria-current={activity.id === selectedId ? "true" : undefined}
            >
              <span className="hosted-title">{activity.title}</span>
              <span className="hosted-meta">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: activity.timezone,
                }).format(new Date(activity.startsAt))}{" "}
                · {activity.confirmedCount}/{activity.capacity} confirmed ·{" "}
                {activity.started ? "started" : "upcoming"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
