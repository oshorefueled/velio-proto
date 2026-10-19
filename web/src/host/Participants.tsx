import { useEffect, useState } from "react";
import type { ParticipantsView } from "../api.js";
import { useSession } from "../session.js";

export function Participants({ activityId, version }: { activityId: string; version: string }) {
  const { authorized, state } = useSession();
  const token = state.status.status === "ready" ? state.status.token : null;
  const [result, setResult] = useState<{ token: string | null; data: ParticipantsView | null; error?: string }>({ token: null, data: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void authorized((api, credential) => api.getParticipants(activityId, credential)).then(data => {
      if (current) setResult({ token, data });
    }).catch(error => {
      if (current && !(error instanceof DOMException && error.name === "AbortError")) setResult(previous => ({ token, data: previous.token === token ? previous.data : null, error: "The participant list could not be refreshed and may be out of date." }));
    });
    return () => { current = false; };
  }, [activityId, version, token, authorized, retry]);
  const data = result.token === token ? result.data : null;
  return <section className="participants" aria-label="Booked participants">
    <h3>Participants{data ? ` (${data.confirmedCount})` : ""}</h3>
    {result.token === token && result.error && <div className="notice notice-warn" role="status">{result.error} <button type="button" className="button-ghost" onClick={() => setRetry(value => value + 1)}>Refresh participants</button></div>}
    {data ? data.participants.length ? <ul>{data.participants.map(person => <li key={person.userId}>{person.displayName}</li>)}</ul> : <p className="hint">No confirmed bookings yet.</p> : !result.error && <p className="hint">Loading participants…</p>}
  </section>;
}
