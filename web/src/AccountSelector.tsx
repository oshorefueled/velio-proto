import { useState } from "react";
import { useSession } from "./session.js";

export type DemoAccount = "Host" | "Booker" | "Guest";

export function AccountSelector({ onSelect, onSignIn }: {
  onSelect?: (account: DemoAccount) => void;
  onSignIn?: () => void;
}) {
  const { state, store } = useSession();
  const [pendingSelection, setPendingSelection] = useState<DemoAccount>("Guest");
  const user = state.status.status === "ready" ? state.status.user : null;
  const selected = user ? user.email === "host@demo.velio.test" ? "Host" : user.email === "booker@demo.velio.test" ? "Booker" : "Guest" : pendingSelection;
  function select(account: DemoAccount) {
    setPendingSelection(account);
    store.signOut();
    onSelect?.(account);
    if (account !== "Guest") void store.establish({ email: `${account.toLowerCase()}@demo.velio.test` });
  }
  return <div className="account-access">
    <span className="demo-label">Demo account</span>
    <div className="tool-toggle" role="group" aria-label="Demo account">
      {(["Host", "Booker", "Guest"] as const).map(account => <button key={account} type="button" aria-pressed={selected === account} className={selected === account ? "toggle-on" : ""} onClick={() => select(account)}>{account}</button>)}
    </div>
    {user ? <span className="account-name">{user.displayName} <button type="button" className="button-ghost" onClick={() => select("Guest")}>Sign out</button></span>
      : selected === "Guest" ? <button type="button" className="button-ghost" onClick={onSignIn}>Sign in</button>
        : <span className="hint" role="status">Opening account…</span>}
    {state.status.status === "anonymous" && state.status.error && <span role="alert">{state.status.error}</span>}
  </div>;
}
