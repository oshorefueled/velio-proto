import { useEffect, useState } from "react";
import type { VelioApi } from "./api.js";
import { useSession } from "./session.js";

type Bookings = Awaited<ReturnType<VelioApi["getMyBookings"]>>;

export function SavedBookings({ onSelect }: { onSelect: (id: string) => void }) {
  const { authorized, state } = useSession();
  const token = state.status.status === "ready" ? state.status.token : null;
  const [result, setResult] = useState<{ token: string | null; bookings: Bookings | null; error?: string }>({ token: null, bookings: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setResult({ token, bookings: null });
    if (token) void authorized((api, credential) => api.getMyBookings(credential)).then(bookings => {
      if (current) setResult({ token, bookings });
    }).catch(error => {
      if (current && !(error instanceof DOMException && error.name === "AbortError")) setResult({ token, bookings: null, error: error instanceof Error ? error.message : "Could not load bookings." });
    });
    return () => { current = false; };
  }, [authorized, token, retry]);
  const bookings = result.token === token ? result.bookings : null;
  return <section className="panel" aria-labelledby="bookings-heading">
    <div className="panel-head"><h2 id="bookings-heading">My bookings</h2><button type="button" className="button-ghost" onClick={() => setRetry(value => value + 1)}>Refresh</button></div>
    {result.token === token && result.error ? <div role="alert">{result.error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
      : bookings === null ? <p className="hint" role="status">Loading your bookings…</p>
        : bookings.length === 0 ? <p className="hint">You haven’t booked an activity yet. Explore to find your next outing.</p>
          : <ul className="browse-list">{bookings.map(booking => <li key={booking.id}><button type="button" className="browse-item" onClick={() => onSelect(booking.activityId)}><span className="browse-title">{booking.activity.title}</span><span className="browse-meta">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: booking.activity.timezone }).format(new Date(booking.activity.startsAt))} · Spot confirmed</span></button></li>)}</ul>}
  </section>;
}
