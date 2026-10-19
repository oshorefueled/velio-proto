import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type ActivityDetailView, type InviteView } from "../api.js";
import { useSession } from "../session.js";

/**
 * Invitation view (issue #16, US05/06): the owning host or a confirmed
 * booker intentionally creates a contact vouch or a public share for the
 * selected activity and copies/shares the saved receipt. The draft
 * (rail + vouched contact) survives failures and credential loss; only an
 * explicit submit creates; only an actual 201 shows a receipt; a lost
 * creation response is unknown because the API offers no create
 * idempotency — a retry may create another invitation and no spot is ever
 * held. invite_share_action fires only for a real clipboard success or a
 * successful supported share interaction.
 */

type Rail = "public_share" | "vouch";

type Affiliation = "checking" | "host" | "booker" | "none" | "anonymous" | "unknown";

type CreatePhase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "unknown"; message: string }
  | { kind: "created"; invite: InviteView }
  | { kind: "refused"; message: string; field?: string };

function formatExpiry(expiresAt: string, timezone: string): string {
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(expiresAt))} (${timezone})`;
}

function inviteLink(code: string): string {
  return `${window.location.origin}/?invite=${code}`;
}

export function InvitePanel({
  activityId,
  onBack,
  onRequestIdentity,
}: {
  activityId: string;
  onBack: () => void;
  onRequestIdentity: () => void;
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

  const [detail, setDetail] = useState<ActivityDetailView | null>(null);
  const [capabilities, setCapabilities] = useState<ActivityDetailView["invites"]>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const factsGeneration = useRef(0);

  const [affiliation, setAffiliation] = useState<Affiliation>("checking");
  const [affiliationRetry, setAffiliationRetry] = useState(0);
  const affiliationRun = useRef(0);

  const [rail, setRail] = useState<Rail>("public_share");
  const [contactKey, setContactKey] = useState("");
  const [phase, setPhase] = useState<CreatePhase>({ kind: "idle" });
  const operation = useRef(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [, updateClock] = useState(0);
  const waiting = retryAt !== null && Date.now() < retryAt;
  const [copied, setCopied] = useState<string | null>(null);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  const [shareUnavailable, setShareUnavailable] = useState(false);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => updateClock((value) => value + 1), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  useEffect(() => {
    operation.current += 1;
    setPhase({ kind: "idle" });
    setCopied(null);
    setCopyUnavailable(false);
    setShareUnavailable(false);
    return () => { operation.current += 1; };
  }, [sessionToken, activityId]);
  const changeDraft = (): void => {
    operation.current += 1;
    setPhase({ kind: "idle" });
  };
  // Public facts and the activity's saved capability block.
  useEffect(() => {
    const currentGeneration = ++factsGeneration.current;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const { activity, invites } = await api.getActivity(activityId);
        if (factsGeneration.current !== currentGeneration || !mounted.current) return;
        setDetail(activity);
        setCapabilities(invites);
        setLoading(false);
      } catch (err) {
        if (factsGeneration.current !== currentGeneration || !mounted.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : "Could not load this activity.");
      }
    })();
    return () => {
      factsGeneration.current += 1;
    };
  }, [api, activityId, refresh]);

  // Server-confirmed affiliation: own hosted activity OR own saved booking.
  // A successful host lookup never requires a booking; an unknown lookup
  // failure stays unknown instead of claiming "not affiliated".
  useEffect(() => {
    const run = ++affiliationRun.current;
    if (sessionToken === null) {
      setAffiliation("anonymous");
      return;
    }
    setAffiliation("checking");
    void (async () => {
      try {
        const hosted = await authorized((api, token) => api.getMyActivities(token));
        if (run !== affiliationRun.current || !mounted.current) return;
        if (hosted.some((activity) => activity.id === activityId)) {
          setAffiliation("host");
          return;
        }
        try {
          await authorized((api, token) => api.getMyBooking(token, activityId));
          if (run !== affiliationRun.current || !mounted.current) return;
          setAffiliation("booker");
        } catch (err) {
          if (run !== affiliationRun.current || !mounted.current) return;
          if (err instanceof ApiError && err.status === 404 && err.code === "booking_not_found") {
            setAffiliation("none");
          } else if (!(err instanceof DOMException && err.name === "AbortError")) {
            setAffiliation("unknown");
          }
        }
      } catch (err) {
        if (run !== affiliationRun.current || !mounted.current) return;
        if (!(err instanceof DOMException && err.name === "AbortError")) setAffiliation("unknown");
      }
    })();
  }, [activityId, sessionToken, authorized, affiliationRetry]);

  // Lifecycle refusals refresh the real facts.
  const refuseAndRefresh = (phase: CreatePhase): void => {
    setPhase(phase);
    setRefresh((value) => value + 1);
  };

  const create = (): void => {
    if (sessionToken === null || phase.kind === "pending" || (retryAt !== null && Date.now() < retryAt)) return;
    const trimmedContact = contactKey.trim();
    if (rail === "vouch" && trimmedContact.length === 0) return;
    const owner = store.getState().status;
    const run = ++operation.current;
    const isCurrent = (): boolean => mounted.current && operation.current === run && store.getState().status === owner;
    setCopied(null);
    setCopyUnavailable(false);
    setShareUnavailable(false);
    setPhase({ kind: "pending" });
    const input =
      rail === "vouch"
        ? { rail: "vouch" as const, targetContactKey: trimmedContact }
        : { rail: "public_share" as const };
    void authorized((api, token) => api.createInvite(token, activityId, input))
      .then((invite) => {
        if (!isCurrent()) return;
        if (invite.activityId !== activityId) return;
        setPhase({ kind: "created", invite });
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        if (err instanceof DOMException && err.name === "AbortError") return; // identity changed mid-flight
        if (!(err instanceof ApiError)) {
          // Lost response: the create may have committed; the API offers no
          // create idempotency, so the outcome is unknown — never a receipt.
          setPhase({
            kind: "unknown",
            message:
              err instanceof Error
                ? `We cannot tell whether the invitation was saved (${err.message}). No spot is held either way.`
                : "We cannot tell whether the invitation was saved.",
          });
          return;
        }
        switch (err.code) {
          case "forbidden":
            refuseAndRefresh({
              kind: "refused",
              message: "Invitations cannot be created for this activity with your current access.",
            });
            return;
          case "validation_error":
            setPhase({
              kind: "refused",
              message: err.message,
              field: err.fields?.targetContactKey ?? err.fields?.rail,
            });
            return;
          case "activity_started":
            refuseAndRefresh({ kind: "refused", message: "This activity has already started, so new invitations are closed." });
            return;
          case "activity_sold_out":
            refuseAndRefresh({ kind: "refused", message: "This activity is full — new invitations are closed." });
            return;
          case "activity_completed":
            refuseAndRefresh({ kind: "refused", message: "This activity is already completed." });
            return;
          case "request_limit": {
            const retryAt = Date.now() + (err.retryAfterSeconds ?? 0) * 1000;
            setRetryAt(retryAt);
            setPhase({
              kind: "refused",
              message: "Too many attempts. Please wait before creating again.",
            });
            return;
          }
          case "session_required":
          case "session_invalid":
          case "session_expired":
            // Only the lost credential is cleared (authorized already reported
            // the loss); the draft stays and nothing is replayed.
            setPhase({ kind: "idle" });
            return;
          default:
            setPhase({
              kind: "unknown",
              message: `We cannot tell whether the invitation was saved (${err.message}). No spot is held either way.`,
            });
            return;
        }
      });
  };

  // Share telemetry: one fresh event id per deliberate, successful
  // interaction; failures never block or fake a copy.
  const recordShare = (invite: InviteView, shareMethod: "copy" | "system_share"): void => {
    void api
      .emitInviteShareAction({
        eventId: crypto.randomUUID(),
        visitorId: state.visitorId,
        inviteCode: invite.code,
        shareMethod,
        token: sessionToken,
      })
      .catch(() => {});
  };

  const copyText = (invite: InviteView, label: string, text: string): void => {
    const owner = store.getState().status;
    const run = operation.current;
    const isCurrent = (): boolean => mounted.current && operation.current === run && store.getState().status === owner;
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (typeof writeText !== "function") {
      // Unsupported: honest fallback, never a faked "copied".
      setCopied(null);
      setCopyUnavailable(true);
      return;
    }
    void writeText(text)
      .then(() => {
        if (!isCurrent()) return;
        setCopied(label);
        setCopyUnavailable(false);
        recordShare(invite, "copy");
      })
      .catch(() => {
        if (!isCurrent()) return;
        setCopied(null);
        setCopyUnavailable(true);
      });
  };

  const systemShare = (invite: InviteView): void => {
    if (typeof navigator.share !== "function") {
      setShareUnavailable(true);
      return;
    }
    void navigator
      .share({
        title: detail?.title ?? "Velio invitation",
        text: `Join me at ${detail?.title ?? "an activity"} — code ${invite.code}`,
        url: inviteLink(invite.code),
      })
      .then(() => {
        if (!mounted.current) return;
        recordShare(invite, "system_share");
      })
      .catch(() => {
        // Cancellation or failure keeps the receipt and the Copy fallback;
        // nothing is recorded and nothing is sent by this app.
      });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create();
  };

  const gate = (message: string): ReactNode => (
    <div className="notice" role="note">
      {message}
    </div>
  );

  let controls: ReactNode;

  if (loading || loadError !== null) {
    controls = loadError !== null ? (
      <div className="notice notice-warn" role="alert">
        {loadError} Facts are unknown, not zero.{" "}
        <button type="button" className="button-ghost" onClick={() => setRefresh((value) => value + 1)}>
          Try again
        </button>
      </div>
    ) : (
      <p className="hint" aria-busy="true">Opening the activity…</p>
    );
  } else if (capabilities !== undefined && !capabilities.eligible) {
    controls = gate("This plan is not part of the invitation experiment, so invitations cannot be created for it.");
  } else if (capabilities !== undefined && !capabilities.canCreateInvites) {
    controls = gate(
      capabilities.arm === "control"
        ? "This activity is in the control group — it keeps ordinary browsing and booking, without invitation controls."
        : "Invitation creation is switched off for this demonstration right now. Already issued invitations stay redeemable.",
    );
  } else if (detail !== null && detail.started) {
    controls = gate("This activity has already started — new invitations are closed.");
  } else if (detail !== null && detail.remainingSpots <= 0) {
    controls = gate("This activity is full — new invitations are closed.");
  } else if (affiliation === "checking") {
    controls = <p className="hint" aria-busy="true">Checking whether you can invite…</p>;
  } else if (affiliation === "anonymous") {
    controls = (
      <div className="booking-panel">
        <button type="button" className="button-primary" onClick={onRequestIdentity}>
          Select identity to invite
        </button>
        <p className="hint">Only the owning host or a confirmed booker can create invitations.</p>
      </div>
    );
  } else if (affiliation === "none") {
    controls = gate("Only the owning host or a confirmed booker of this activity can create invitations.");
  } else if (affiliation === "unknown") {
    controls = (
      <div className="notice notice-warn" role="alert">
        We could not verify whether you can invite for this activity.{" "}
        <button
          type="button"
          className="button-ghost"
          onClick={() => setAffiliationRetry((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  } else {
    // host or booker with an invitable activity
    const pending = phase.kind === "pending";
    controls = (
      <form onSubmit={submit} noValidate>
        <fieldset className="invite-rails">
          <legend>Invitation type</legend>
          <label className="invite-rail">
            <input
              type="radio"
              name="invite-rail"
              value="vouch"
              checked={rail === "vouch"}
              onChange={() => { changeDraft(); setRail("vouch"); }}
            />{" "}
            Contact vouch — your personal endorsement; only this contact can claim it.
          </label>
          <label className="invite-rail">
            <input
              type="radio"
              name="invite-rail"
              value="public_share"
              checked={rail === "public_share"}
              onChange={() => { changeDraft(); setRail("public_share"); }}
            />{" "}
            Public share link — reaches anyone with the link; no personal endorsement.
          </label>
        </fieldset>
        {rail === "vouch" && (
          <>
            <label htmlFor="vouch-contact">Vouched contact key</label>
            <input
              id="vouch-contact"
              name="targetContactKey"
              autoComplete="off"
              value={contactKey}
              onChange={(event) => { changeDraft(); setContactKey(event.target.value); }}
              aria-describedby="vouch-contact-hint"
              required
            />
            <p className="hint" id="vouch-contact-hint">
              The stable demo contact of the person you vouch for — it cannot be your own. Only
              that contact may claim this invitation.
            </p>
          </>
        )}
        {rail === "public_share" && (
          <p className="hint">
            Anyone with the link can use it while it is valid. Neither rail reserves a spot: joining
            always requires an actual booking, and invitations expire no later than the activity
            start.
          </p>
        )}
        {phase.kind === "refused" && (
          <div className="notice notice-warn" role="alert">
            {phase.message}
            {phase.field !== undefined ? ` (${phase.field})` : ""}
          </div>
        )}
        {phase.kind === "unknown" && (
          <div className="notice notice-warn" role="alert">
            {phase.message}
          </div>
        )}
        {waiting && <p className="hint" role="status">Please wait until the retry delay ends before creating again.</p>}
        <div className="invite-actions">
          <button type="submit" className="button-primary" disabled={pending || waiting}>
            {pending ? "Creating…" : "Create invitation"}
          </button>
          {phase.kind === "unknown" && (
            <button type="button" className="button-ghost" onClick={create}>
              Try again
            </button>
          )}
        </div>
        {phase.kind === "unknown" && (
          <p className="hint">
            Creating again may make another invitation — nothing is sent automatically and no spot
            is held.
          </p>
        )}
      </form>
    );
  }

  const created = phase.kind === "created" ? phase.invite : null;

  return (
    <section className="panel invite-panel" aria-labelledby="invite-heading">
      <p className="eyebrow">Invitations</p>
      <h2 id="invite-heading">{detail !== null ? detail.title : "Activity invitations"}</h2>
      {detail !== null && (
        <p className="hint">
          Starts {new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short", timeZone: detail.timezone }).format(new Date(detail.startsAt))} ·{" "}
          {detail.bookedCount} booked · {detail.remainingSpots} remaining of {detail.capacity}
        </p>
      )}
      <button type="button" className="button-ghost invite-back" onClick={onBack}>
        ← Back to activity
      </button>
      {created !== null ? (
        <div className="invite-receipt">
          <div className="notice notice-good" role="status">
            Invitation saved — nobody holds a spot through it.
          </div>
          <dl className="detail-grid receipt-grid" aria-label="Saved invitation">
            <div>
              <dt>Rail</dt>
              <dd>
                {created.rail === "vouch"
                  ? `Contact vouch for ${created.targetContactKey ?? "the chosen contact"} — only that contact can claim it`
                  : "Public share link — anyone with the link can use it while valid; no personal endorsement"}
              </dd>
            </div>
            <div>
              <dt>Code</dt>
              <dd>
                <code>{created.code}</code>
              </dd>
            </div>
            <div>
              <dt>Link</dt>
              <dd>
                <code>{inviteLink(created.code)}</code>
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatExpiry(created.expiresAt, detail?.timezone ?? "UTC")}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd>{created.generation}</dd>
            </div>
          </dl>
          <p className="hint">
            A claim must become an actual booking to join the plan; the invitation itself never
            reserves a spot. Your recipient opens <code>{inviteLink(created.code)}</code> to preview
            and claim — a prototype origin URL, not a deployment.
          </p>
          <div className="invite-actions">
            <button
              type="button"
              className="button-primary"
              onClick={() => copyText(created, "code", created.code)}
            >
              {copied === "code" ? "Code copied" : "Copy code"}
            </button>
            <button
              type="button"
              className="button-ghost"
              onClick={() => copyText(created, "link", inviteLink(created.code))}
            >
              {copied === "link" ? "Link copied" : "Copy link"}
            </button>
            <button type="button" className="button-ghost" onClick={() => systemShare(created)}>
              Share via device
            </button>
          </div>
          {copyUnavailable && (
            <div className="notice notice-warn" role="alert">
              Copying was not available. Select the code or link above and copy it manually.
            </div>
          )}
          {shareUnavailable && (
            <div className="notice" role="note">
              This browser does not offer device sharing. Use the copy buttons instead.
            </div>
          )}
          <div className="invite-actions invite-again">
            <button
              type="button"
              className="button-ghost"
              onClick={() => {
                changeDraft();
                setCopied(null);
                setCopyUnavailable(false);
                setShareUnavailable(false);
              }}
            >
              Create another invitation
            </button>
          </div>
        </div>
      ) : (
        controls
      )}
    </section>
  );
}
