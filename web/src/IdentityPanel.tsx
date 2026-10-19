import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "./session.js";

/**
 * Identity selection: a stable demo contact (with an optional display name
 * for a first visit) establishes or resumes the person. Shown on boot
 * without a stored credential and again after a 401 — in which case the
 * workspace (draft, selected activity) stays mounted underneath and
 * authorized state reloads once a person is re-established.
 */
export function IdentityPanel({
  contextNote,
  inviteCode,
}: {
  contextNote?: string;
  /** A resolved invitation kept across identity selection (issue #17). */
  inviteCode?: string;
}): ReactNode {
  const { state, store } = useSession();
  const fieldId = useId();
  const status = state.status;
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const selection = useRef(0);
  useEffect(() => {
    setPending(false);
    return () => { selection.current += 1; store.cancelEstablishment(); };
  }, [store, inviteCode]);

  const error =
    status.status === "anonymous" ? status.error : status.status === "credential-lost" ? status.error : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    const currentSelection = ++selection.current;
    setPending(true);
    void store
      .establish({
        email: email.trim(),
        inviteCode: inviteCode?.trim() || undefined,
      })
      .finally(() => { if (selection.current === currentSelection) setPending(false); });
  };

  return (
    <section className="panel identity-panel" aria-labelledby={`${fieldId}-heading`}>
      <p className="eyebrow">Velio</p>
      <h1 id={`${fieldId}-heading`}>Sign in</h1>
      <p className="lede">
        Enter your email to open your account or create one.
      </p>
      {status.status === "credential-lost" && (
        <div className="notice notice-warn" role="status">
          Your session expired. {contextNote ?? "Your work below is kept"} — sign in to continue where you were.
        </div>
      )}
      {inviteCode !== undefined && (
        <div className="notice" role="note">
          Your invitation <code>{inviteCode}</code> stays with you while you sign in.
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <label htmlFor={fieldId}>Email</label>
        <input
          id={fieldId}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={`${fieldId}-hint`}
        />
        <p className="hint" id={`${fieldId}-hint`}>
          Use the same email to return to your activities and bookings.
        </p>
        {error !== undefined && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button-primary" disabled={pending || email.trim().length === 0}>
          {pending ? "Opening…" : status.status === "credential-lost" ? "Continue where I was" : "Sign in"}
        </button>
      </form>
    </section>
  );
}
