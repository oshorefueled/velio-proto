import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type ActivityDetailView, type InviteView } from "../api.js";
import { useSession } from "../session.js";

type Rail = "public_share" | "vouch";

type CreatePhase =
  | { kind: "idle" }
  | { kind: "pending"; rail: Rail }
  | { kind: "unknown"; rail: Rail; message: string }
  | { kind: "refused"; rail: Rail; message: string; field?: string };

function inviteLink(code: string): string {
  const origin = import.meta.env.VITE_INVITE_ORIGIN || window.location.origin;
  const url = new URL("/", origin);
  url.searchParams.set("invite", code);
  return url.toString();
}

export function InviteCard({
  activityId,
  capabilities,
  started,
  onRefused,
}: {
  activityId: string;
  capabilities: ActivityDetailView["invites"];
  started: boolean;
  onRefused: () => void;
}): ReactNode {
  const { api, state, store, authorized } = useSession();
  const sessionToken = state.status.status === "ready" ? state.status.token : null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [recipientEmail, setRecipientEmail] = useState("");
  const [vouchInvite, setVouchInvite] = useState<InviteView | null>(null);
  const [publicInvite, setPublicInvite] = useState<InviteView | null>(null);
  const [phase, setPhase] = useState<CreatePhase>({ kind: "idle" });
  const operation = useRef(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [, updateClock] = useState(0);
  const waiting = retryAt !== null && Date.now() < retryAt;
  const [copied, setCopied] = useState<Rail | null>(null);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => updateClock((value) => value + 1), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const changeContact = (value: string): void => {
    if (phase.kind !== "idle" && phase.rail === "vouch") {
      operation.current += 1;
      setPhase({ kind: "idle" });
    }
    setVouchInvite(null);
    setRecipientEmail(value);
  };

  const create = (rail: Rail): void => {
    if (sessionToken === null || phase.kind === "pending" || (retryAt !== null && Date.now() < retryAt)) return;
    const trimmedEmail = recipientEmail.trim();
    if (rail === "vouch" && trimmedEmail.length === 0) return;
    const owner = store.getState().status;
    const run = ++operation.current;
    const isCurrent = (): boolean => mounted.current && operation.current === run && store.getState().status === owner;
    setCopied(null);
    setCopyUnavailable(false);
    setPhase({ kind: "pending", rail });
    const input = rail === "vouch" ? { rail: "vouch" as const, recipientEmail: trimmedEmail } : { rail: "public_share" as const };
    void authorized((api, token) => api.createInvite(token, activityId, input))
      .then((invite) => {
        if (!isCurrent() || invite.activityId !== activityId) return;
        if (rail === "vouch") setVouchInvite(invite); else setPublicInvite(invite);
        setPhase({ kind: "idle" });
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!(err instanceof ApiError)) {
          setPhase({
            kind: "unknown",
            rail,
            message: err instanceof Error
              ? `We cannot tell whether the invitation was saved (${err.message}). No spot is held either way.`
              : "We cannot tell whether the invitation was saved.",
          });
          return;
        }
        switch (err.code) {
          case "forbidden":
            setPhase({ kind: "refused", rail, message: "Invitations cannot be created for this activity with your current access." });
            onRefused();
            return;
          case "validation_error":
            setPhase({ kind: "refused", rail, message: err.message, field: err.fields?.recipientEmail ?? err.fields?.rail });
            return;
          case "activity_started":
            setPhase({ kind: "refused", rail, message: "This activity has already started, so new invitations are closed." });
            onRefused();
            return;
          case "activity_sold_out":
            setPhase({ kind: "refused", rail, message: "This activity is full — new invitations are closed." });
            onRefused();
            return;
          case "request_limit":
            setRetryAt(Date.now() + (err.retryAfterSeconds ?? 0) * 1000);
            setPhase({ kind: "refused", rail, message: "Too many attempts. Please wait before creating again." });
            return;
          case "session_required":
          case "session_invalid":
          case "session_expired":
            setPhase({ kind: "idle" });
            return;
          default:
            setPhase({
              kind: "unknown",
              rail,
              message: `We cannot tell whether the invitation was saved (${err.message}). No spot is held either way.`,
            });
        }
      });
  };

  const copyLink = (invite: InviteView, rail: Rail): void => {
    const owner = store.getState().status;
    const run = operation.current;
    const isCurrent = (): boolean => mounted.current && operation.current === run && store.getState().status === owner;
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (typeof writeText !== "function") {
      setCopied(null);
      setCopyUnavailable(true);
      return;
    }
    void writeText(inviteLink(invite.code))
      .then(() => {
        if (!isCurrent()) return;
        setCopied(rail);
        setCopyUnavailable(false);
        void api
          .emitInviteShareAction({ eventId: crypto.randomUUID(), visitorId: state.visitorId, inviteCode: invite.code, shareMethod: "copy", token: sessionToken })
          .catch(() => {});
      })
      .catch(() => {
        if (!isCurrent()) return;
        setCopied(null);
        setCopyUnavailable(true);
      });
  };

  const submitVouch = (event: FormEvent): void => {
    event.preventDefault();
    create("vouch");
  };

  const notice = (rail: Rail): ReactNode => phase.kind !== "idle" && phase.kind !== "pending" && phase.rail === rail && (
    <div className="notice notice-warn" role="alert">
      {phase.message}
      {phase.kind === "refused" && phase.field !== undefined ? ` (${phase.field})` : ""}
    </div>
  );

  const savedLink = (invite: InviteView, rail: Rail): ReactNode => (
    <div className="invite-link">
      <code>{inviteLink(invite.code)}</code>
      <button type="button" className="button-ghost" onClick={() => copyLink(invite, rail)}>
        {copied === rail ? "Copied" : "Copy"}
      </button>
    </div>
  );

  if (capabilities !== undefined && (!capabilities.eligible || capabilities.arm === "control")) {
    return (
      <section className="aside-card invite-card" aria-label="Invite people">
        <p className="notice" role="note">This activity is in the control group, so invitation creation is unavailable.</p>
      </section>
    );
  }

  const creationClosed = capabilities?.canCreateInvites === false || started;
  const pending = phase.kind === "pending";

  return (
    <section className="aside-card invite-card" aria-label="Invite people">
      <form onSubmit={submitVouch} noValidate>
        <label htmlFor="vouch-contact" className="invite-prompt">Invite someone you can vouch for</label>
        <div className="invite-row">
          <input id="vouch-contact" name="recipientEmail" type="email" autoComplete="email" placeholder="Their email" value={recipientEmail}
            onChange={(event) => changeContact(event.target.value)} disabled={creationClosed} required />
          <button type="submit" className="button-primary" disabled={pending || waiting || creationClosed}>
            {pending && phase.rail === "vouch" ? "Inviting…" : "Invite"}
          </button>
        </div>
        <p className="hint">Only this email can use your personal invitation.</p>
      </form>
      {notice("vouch")}
      {phase.kind === "unknown" && phase.rail === "vouch" && (
        <div className="invite-actions">
          <button type="button" className="button-ghost" onClick={() => create("vouch")}>Try again</button>
          <span className="hint">Retrying may create another personal invitation.</span>
        </div>
      )}
      {vouchInvite !== null && <>
        <p className="notice notice-good" role="status">Invitation saved for {vouchInvite.recipientEmail ?? "your recipient"} — only that email can use it.</p>
        {savedLink(vouchInvite, "vouch")}
      </>}
      <hr className="invite-divider" />
      {publicInvite !== null ? <>
        <p className="invite-prompt">Public invite</p>
        {savedLink(publicInvite, "public_share")}
        <p className="hint">Anyone with the link can book while spots remain.</p>
      </> : (
        <button type="button" className="button-ghost invite-generate" disabled={pending || waiting} onClick={() => create("public_share")}>
          {pending && phase.rail === "public_share" ? "Generating…" : creationClosed ? "Show saved public link" : "Or generate a public invite"}
        </button>
      )}
      {notice("public_share")}
      {phase.kind === "unknown" && phase.rail === "public_share" && (
        <button type="button" className="button-ghost" onClick={() => create("public_share")}>Try again</button>
      )}
      {creationClosed && <p className="notice" role="note">{started ? "This activity has already started — new invitations are closed." : "Invitation creation is switched off. You can still copy an existing public link."}</p>}
      {waiting && <p className="hint" role="status">Please wait until the retry delay ends before creating again.</p>}
      {copyUnavailable && (
        <div className="notice notice-warn" role="alert">
          Copying was not available. Select the link above and copy it manually.
        </div>
      )}
      <p className="hint">Invitations do not reserve a spot.</p>
    </section>
  );
}
