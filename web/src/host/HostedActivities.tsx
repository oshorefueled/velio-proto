import { formatMoneyCompact } from "../money.js";
import { chipDateRange, hostStatus, initials, zoneOffsetLabel } from "../present.js";
import { ArrowRightIcon, CalendarIcon } from "../icons.js";
import type { ReactNode } from "react";
import type { HostActivityView } from "../api.js";
import { useSession } from "../session.js";

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
      <div className="panel-head list-tools">
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
          const offset = zoneOffsetLabel(activity.startsAt, activity.timezone);
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
                    <span className="chip"><CalendarIcon /> {chipDateRange(activity.startsAt, activity.endsAt, activity.timezone)}</span>
                    {offset !== null && <span className="chip">{offset}</span>}
                  </span>
                  <span className="hosted-row-title">{activity.title}</span>
                  <span className="hosted-by">{hostName && <><span className="avatar">{initials(hostName)}</span> Hosted by {hostName}</>}</span>
                  {activity.description && <span className="hosted-row-desc">{activity.description}</span>}
                </span>
                <span className="hosted-row-status">
                  <span className={`pill pill-${status.tone}`}>{status.label}</span>
                  <span className="hosted-row-booked">
                    <strong>{activity.confirmedCount} booked</strong>{" · "}
                    {activity.started
                      ? <span className="spots-muted">activity started</span>
                      : <span className={activity.capacity - activity.confirmedCount > 0 ? "spots-free" : "spots-none"}>{activity.capacity - activity.confirmedCount} {activity.capacity - activity.confirmedCount === 1 ? "spot" : "spots"} left</span>}
                  </span>
                  <span className="card-spots-sub">of {activity.capacity}</span>
                </span>
                <span className="hosted-row-price">
                  <span className="card-price">{formatMoneyCompact(activity.priceMinorUnits, activity.currency)}</span>
                  <span className="card-price-sub">per person</span>
                </span>
                <span className="view-details">
                  View details<ArrowRightIcon size={18} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
