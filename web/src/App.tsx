import { AccountSelector } from "./AccountSelector.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostActivityView } from "./api.js";
import { createBookingStore } from "./booking-store.js";
import { IdentityPanel } from "./IdentityPanel.js";
import { ActivityBrowser } from "./guest/ActivityBrowser.js";
import { GuestActivity } from "./guest/GuestActivity.js";
import { InviteLanding } from "./guest/InviteLanding.js";
import { InvitePanel } from "./guest/InvitePanel.js";
import { ActivityDetail } from "./host/ActivityDetail.js";
import { HostedActivities } from "./host/HostedActivities.js";
import { PublishForm } from "./host/PublishForm.js";
import { useSession } from "./session.js";

/**
 * One workspace for every journey (issues #15/#16/#17): public browse and
 * detail load before any identity selection; an ?invite=<code> deep link
 * opens the invitation landing where the shared booking controller owns the
 * claim; booking tools and host tools stay behind intentional identity
 * selection — selecting a tool never authorizes anything. Selected activity
 * and invite code live in the URL so refresh and browser navigation keep the
 * context; browsing clears the invite; the host draft survives credential
 * recovery because the columns stay mounted.
 */
export function App(): ReactNode {
  const { api, state, store, authorized } = useSession();
  const status = state.status;
  const bookingStore = useMemo(() => createBookingStore(api, store), [api, store]);

  const [tools, setTools] = useState<"host" | "booker">("booker");
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("activity");
    return fromUrl !== null && fromUrl !== "" ? fromUrl : window.localStorage.getItem("velio.selected.v1");
  });
  const [view, setView] = useState<"activity" | "invites">(() =>
    new URLSearchParams(window.location.search).get("view") === "invites" ? "invites" : "activity",
  );
  const [inviteCode, setInviteCode] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("invite");
    return fromUrl !== null && fromUrl.trim() !== "" ? fromUrl.trim().toUpperCase() : null;
  });
  const [hosted, setHosted] = useState<{ activities: HostActivityView[]; loading: boolean; error: string | null }>({
    activities: [],
    loading: false,
    error: null,
  });
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [identityPrompt, setIdentityPrompt] = useState(false);
  const hostedGeneration = useRef(0);
  const recoveryDialog = useRef<HTMLDialogElement>(null);
  const promptDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (status.status === "credential-lost") recoveryDialog.current?.showModal?.();
  }, [status.status]);
  useEffect(() => {
    if (identityPrompt) promptDialog.current?.showModal?.();
  }, [identityPrompt]);
  useEffect(() => {
    if (status.status === "ready" && identityPrompt) {
      promptDialog.current?.close?.();
      setIdentityPrompt(false);
    }
  }, [status.status, identityPrompt]);
  const sessionToken = status.status === "ready" ? status.token : null;
  const ready = status.status === "ready";

  // One observation id per selected activity, shared by both detail panels:
  // whichever panel is visible emits it, and a second panel's emission is a
  // server-side duplicate — the same display is never counted twice.
  const observationId = useMemo(() => crypto.randomUUID(), [selectedId, sessionToken]);

  const syncUrl = useCallback(
    (activityId: string | null, nextView: "activity" | "invites", nextInvite: string | null) => {
      const url = new URL(window.location.href);
      if (activityId === null) {
        url.searchParams.delete("activity");
        url.searchParams.delete("view");
      } else {
        url.searchParams.set("activity", activityId);
        if (nextView === "invites") url.searchParams.set("view", "invites");
        else url.searchParams.delete("view");
      }
      if (nextInvite === null) url.searchParams.delete("invite");
      else url.searchParams.set("invite", nextInvite);
      if (url.href !== window.location.href) window.history.pushState(null, "", url);
    },
    [],
  );

  const selectActivity = useCallback(
    (activityId: string | null) => {
      setSelectedId(activityId);
      setView("activity");
      setInviteCode(null); // intentional browsing clears the invite context
      syncUrl(activityId, "activity", null);
      window.localStorage.setItem("velio.selected.v1", activityId ?? "");
    },
    [syncUrl],
  );

  const openInvites = useCallback(() => {
    if (selectedId === null) return;
    setView("invites");
    syncUrl(selectedId, "invites", inviteCode);
  }, [selectedId, inviteCode, syncUrl]);

  const backToActivity = useCallback(() => {
    setView("activity");
    if (selectedId !== null) syncUrl(selectedId, "activity", inviteCode);
  }, [selectedId, inviteCode, syncUrl]);

  const reloadHosted = useCallback((): void => {
    if (status.status !== "ready") return;
    const generation = ++hostedGeneration.current;
    setHosted((previous) => ({ ...previous, loading: true, error: null }));
    void authorized((api, token) => api.getMyActivities(token))
      .then((activities) => {
        if (generation === hostedGeneration.current) setHosted({ activities, loading: false, error: null });
      })
      .catch((err) => {
        if (generation === hostedGeneration.current && store.getState().status.status === "ready" && !(err instanceof DOMException && err.name === "AbortError")) {
          setHosted((previous) => ({ ...previous, loading: false, error: err instanceof Error ? err.message : "Could not load your activities." }));
        }
      });
  }, [authorized, store, sessionToken]);

  useEffect(() => {
    setHosted({ activities: [], loading: false, error: null });
    if (sessionToken !== null) {
      reloadHosted();
      setDetailRefresh((previous) => previous + 1);
    }
    return () => { hostedGeneration.current += 1; };
  }, [sessionToken, reloadHosted]);

  // Keep the selected activity, view and invite in sync with browser
  // navigation.
  useEffect(() => {
    const onPopState = (): void => {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("activity");
      const fromInvite = params.get("invite");
      setSelectedId(fromUrl !== null && fromUrl !== "" ? fromUrl : null);
      setView(params.get("view") === "invites" ? "invites" : "activity");
      setInviteCode(fromInvite !== null && fromInvite.trim() !== "" ? fromInvite.trim().toUpperCase() : null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const identityOverlay = status.status === "credential-lost";

  return (
    <div className="app-shell">
      <header className="masthead">
        <p className="eyebrow">Velio</p>
        <h1>Group bookings</h1>
        <div className="masthead-side">
          <div className="tool-toggle" role="group" aria-label="Workspace tools">
            <button type="button" className={tools === "host" ? "toggle-on" : ""} onClick={() => setTools("host")}>
              Host tools
            </button>
            <button type="button" className={tools === "booker" ? "toggle-on" : ""} onClick={() => setTools("booker")}>
              Booking tools
            </button>
          </div>
          <AccountSelector />
        </div>
      </header>

      {identityOverlay && (
        <dialog ref={recoveryDialog} className="overlay" aria-label="Select your identity" onCancel={(event) => event.preventDefault()}>
          <IdentityPanel contextNote="Your draft and selected activity are kept." inviteCode={inviteCode ?? undefined} />
        </dialog>
      )}
      {identityPrompt && (
        <dialog ref={promptDialog} className="overlay" aria-label="Select your identity to book" onCancel={(event) => event.preventDefault()}>
          <IdentityPanel contextNote="Your selected activity is kept." inviteCode={inviteCode ?? undefined} />
        </dialog>
      )}

      <main className="workspace">
        <div className="column" hidden={tools !== "booker" || inviteCode !== null}>
          <ActivityBrowser selectedId={selectedId} onSelect={selectActivity} />
        </div>
        <div className="column" hidden={tools !== "booker" || view !== "activity" || inviteCode !== null}>
          {inviteCode === null && selectedId !== null ? (
            <GuestActivity
              key={selectedId}
              activityId={selectedId}
              booking={bookingStore}
              visible={tools === "booker" && view === "activity" && inviteCode === null}
              observationId={observationId}
              onRequestIdentity={() => setIdentityPrompt(true)}
              onOpenInvites={openInvites}
            />
          ) : (
            <section className="panel detail-panel" aria-label="No selection">
              <h2>Nothing selected</h2>
              <p className="hint">
                Pick an activity from the list — its host, schedule, price and remaining
                spots open here before you sign in.
              </p>
            </section>
          )}
        </div>
        <div className="column" hidden={tools !== "host"}>
          <div hidden={!ready && !identityOverlay}>
              <PublishForm
                onPublished={(activity) => {
                  selectActivity(activity.id);
                  reloadHosted();
                }}
              />
              <HostedActivities
                activities={hosted.activities}
                selectedId={selectedId}
                onSelect={selectActivity}
                reload={reloadHosted}
                loading={hosted.loading}
                error={hosted.error}
              />
          </div>
          {!ready && !identityOverlay && <IdentityPanel contextNote="Your selected activity is kept." inviteCode={inviteCode ?? undefined} />}
        </div>
        <div className="column" hidden={tools !== "host" || view !== "activity"}>
          {!ready ? (
            <section className="panel detail-panel" aria-label="Host tools">
              <h2>Host tools</h2>
              <p className="hint">Sign in to publish activities.</p>
            </section>
          ) : selectedId !== null ? (
            <ActivityDetail key={`${selectedId}:${sessionToken ?? "none"}`} activityId={selectedId} refreshToken={detailRefresh} visible={tools === "host" && view === "activity" && inviteCode === null} observationId={observationId} onOpenInvites={openInvites} />
          ) : (
            <section className="panel detail-panel" aria-label="No selection">
              <h2>Nothing selected</h2>
              <p className="hint">
                Publish an activity or pick one from your list — its detail and participants open here.
              </p>
            </section>
          )}
        </div>
        <div className="column" hidden={view !== "invites"}>
          {view === "invites" && selectedId !== null ? (
            <InvitePanel
              key={selectedId}
              activityId={selectedId}
              onBack={backToActivity}
              onRequestIdentity={() => setIdentityPrompt(true)}
            />
          ) : (
            <section className="panel detail-panel" aria-label="No selection">
              <h2>Nothing selected</h2>
              <p className="hint">Pick an activity first — its invitation controls open here.</p>
            </section>
          )}
        </div>
        <div className="column invite-column" hidden={inviteCode === null}>
          {inviteCode !== null ? (
            <InviteLanding
              key={inviteCode}
              code={inviteCode}
              visible={inviteCode !== null}
              booking={bookingStore}
              onRequestIdentity={() => setIdentityPrompt(true)}
              onBrowse={() => selectActivity(null)}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
