import { formatMoneyCompact } from "../money.js";
import { chipDateTime, hostStatus, initials, zoneLabel } from "../present.js";
import { ArrowRightIcon, CalendarIcon } from "../icons.js";
import type { ReactNode } from "react";
import type { HostActivityView } from "../api.js";
import { useSession } from "../session.js";

/**
 * The host's own activities (GET /my/activities), revamped to full-width
 * rows with the real status pills (Started / Full / Upcoming — the mockup's
 * "Featured" has no backend basis and is not invented). Selecting a row —
 * anywhere on it, including View details — opens the detail page; the
 * backend session, never this toggle, authorizes every action.
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
  const { state } = useSession();
  const hostName = state.status.status === "ready" ? state.status.user.displayName : null;
  return (
    <section aria-label="My activities">
      <div className="panel-head">
        <span />
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
      <ul className="hosted-rows">
        {activities.map((activity) => {
          const status = hostStatus(activity);
          return (
            <li key={activity.id}>
              <button
                type="button"
                className={`hosted-row-card${activity.id === selectedId ? " selected" : ""}`}
                onClick={() => onSelect(activity.id)}
                aria-current={activity.id === selectedId ? "true" : undefined}
              >
                <span className="hosted-row-main">
                  <span className="chip-row">
                    <span className="chip"><CalendarIcon /> {chipDateTime(activity.startsAt, activity.timezone)}</span>
                    <span className="chip">{zoneLabel(activity.timezone)}</span>
                  </span>
                  <span className="hosted-row-title">{activity.title}</span>
                  <span className="hosted-by">{hostName && <><span className="avatar">{initials(hostName)}</span> Hosted by {hostName.split(" · ")[0]}</>}</span>
                  {activity.description && <span className="hosted-row-desc">{activity.description}</span>}
                </span>
                <span className="hosted-row-status">
                  <span className={`pill pill-${status.tone}`}>{status.label}</span>
                  <span className="hosted-row-booked">
                    {activity.confirmedCount} booked ·{" "}
                    {activity.started
                      ? "activity started"
                      : activity.capacity - activity.confirmedCount > 0
                        ? <span className="spots-free">{activity.capacity - activity.confirmedCount} spots left</span>
                        : <span className="spots-none">no spots left</span>}
                  </span>
                  <span className="card-spots-sub">of {activity.capacity}</span>
                </span>
                <span className="hosted-row-price">
                  <span className="card-price">{formatMoneyCompact(activity.priceMinorUnits, activity.currency)}</span>
                  <span className="card-price-sub">per person</span>
                </span>
                <span className={activity.id === selectedId ? "button-dark" : "button-ghost"}>
                  View details<ArrowRightIcon size={14} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
