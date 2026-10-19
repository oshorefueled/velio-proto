import { useState } from "react";
import { IdentityPanel } from "./IdentityPanel.js";
import { useSession } from "./session.js";

export function AccountSelector() {
  const { state, store } = useSession();
  const [selected, setSelected] = useState<"Host" | "Booker" | "Guest">(() => {
    if (state.status.status !== "ready") return "Guest";
    const email = state.status.user.email;
    return email === "host@demo.velio.test" ? "Host" : email === "booker@demo.velio.test" ? "Booker" : "Guest";
  });
  const [signingIn, setSigningIn] = useState(false);
  const ready = state.status.status === "ready";
  return <div className="account-access">
    <div className="tool-toggle" role="group" aria-label="Account shortcuts">
      {(["Host", "Booker", "Guest"] as const).map(label => <button key={label} type="button" aria-pressed={selected === label} className={selected === label ? "toggle-on" : ""} onClick={() => {
        setSelected(label);
        setSigningIn(false);
        store.signOut();
        if (label !== "Guest") void store.establish({ email: `${label.toLowerCase()}@demo.velio.test` });
      }}>{label}</button>)}
    </div>
    {ready ? <p className="who">{state.status.status === "ready" && state.status.user.displayName} <button type="button" className="button-ghost" onClick={() => { store.signOut(); setSelected("Guest"); setSigningIn(false); }}>Sign out</button></p>
      : selected === "Guest" ? <button type="button" className="button-ghost" onClick={() => setSigningIn(value => !value)}>Sign in</button> : <p className="hint" role="status">Opening account…</p>}
    {!ready && state.status.status === "anonymous" && state.status.error && <p role="alert">{state.status.error}</p>}
    {signingIn && !ready && <IdentityPanel />}
    <p className="hint">Host and Booker use synthetic demo accounts. Each account can host and book.</p>
  </div>;
}
