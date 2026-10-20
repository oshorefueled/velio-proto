import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountSelector, type DemoAccount } from "./AccountSelector.js";
import type { HostActivityView } from "./api.js";
import { createBookingStore } from "./booking-store.js";
import { IdentityPanel } from "./IdentityPanel.js";
import { ActivityBrowser } from "./guest/ActivityBrowser.js";
import { GuestActivity } from "./guest/GuestActivity.js";
import { InviteLanding } from "./guest/InviteLanding.js";
import { InvitePanel } from "./guest/InvitePanel.js";
import { HostedActivities } from "./host/HostedActivities.js";
import { PublishForm } from "./host/PublishForm.js";
import { SavedBookings } from "./SavedBookings.js";
import { useSession } from "./session.js";

type Page = "explore" | "hosting" | "bookings" | "publish";

export function App(): ReactNode {
  const { api, state, store, authorized } = useSession();
  const status = state.status;
  const ready = status.status === "ready";
  const sessionToken = ready ? status.token : null;
  const bookingStore = useMemo(() => createBookingStore(api, store), [api, store]);
  const [bookingRevision, setBookingRevision] = useState(0);
  useEffect(() => {
    let lastBookingId: string | undefined;
    return bookingStore.subscribe(({ phase }) => {
      if (phase.kind !== "confirmed" || phase.booking.id === lastBookingId) return;
      lastBookingId = phase.booking.id;
      setBookingRevision(value => value + 1);
    });
  }, [bookingStore]);
  const [page, setPage] = useState<Page>(() => {
    if (new URLSearchParams(location.search).has("activity") || !ready) return "explore";
    return status.user.email === "host@demo.velio.test" ? "hosting" : status.user.email === "booker@demo.velio.test" ? "bookings" : "explore";
  });
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get("activity") || localStorage.getItem("velio.selected.v1") || null);
  const [view, setView] = useState<"activity" | "invites">(() => new URLSearchParams(location.search).get("view") === "invites" ? "invites" : "activity");
  const [inviteCode, setInviteCode] = useState<string | null>(() => new URLSearchParams(location.search).get("invite")?.trim().toUpperCase() || null);
  const [hosted, setHosted] = useState<{ activities: HostActivityView[]; loading: boolean; error: string | null }>({ activities: [], loading: false, error: null });
  const [identityPrompt, setIdentityPrompt] = useState(false);
  const [liveAvailability, setLiveAvailability] = useState<{ activityId: string; version: string; remainingSpots: number } | null>(null);
  const promptDialog = useRef<HTMLDialogElement>(null);
  const hostedGeneration = useRef(0);
  const observationId = useMemo(() => crypto.randomUUID(), [selectedId, sessionToken]);
  const needsSignIn = identityPrompt || (status.status === "credential-lost" && !status.restoring);

  useEffect(() => {
    if (ready) setIdentityPrompt(false);
  }, [ready]);
  useEffect(() => {
    if (needsSignIn && !ready) promptDialog.current?.showModal?.();
    else promptDialog.current?.close?.();
  }, [needsSignIn, ready]);

  const syncUrl = useCallback((activityId: string | null, nextView: "activity" | "invites", code: string | null) => {
    const url = new URL(location.href);
    if (activityId) url.searchParams.set("activity", activityId); else url.searchParams.delete("activity");
    if (nextView === "invites") url.searchParams.set("view", "invites"); else url.searchParams.delete("view");
    if (code) url.searchParams.set("invite", code); else url.searchParams.delete("invite");
    if (url.href !== location.href) history.pushState(null, "", url);
  }, []);
  const selectActivity = useCallback((id: string | null) => {
    setSelectedId(id); setView("activity"); setInviteCode(null);
    syncUrl(id, "activity", null);
    localStorage.setItem("velio.selected.v1", id ?? "");
  }, [syncUrl]);
  function navigate(next: Page) {
    setPage(next); setView("activity"); setInviteCode(null);
    syncUrl(selectedId, "activity", null);
  }
  function chooseAccount(account: DemoAccount) {
    setPage(account === "Host" ? "hosting" : account === "Booker" ? "bookings" : "explore");
    setIdentityPrompt(false);
  }
  function openInvites() { setView("invites"); syncUrl(selectedId, "invites", inviteCode); }
  function backToActivity() { setView("activity"); syncUrl(selectedId, "activity", inviteCode); }

  const reloadHosted = useCallback(() => {
    if (!sessionToken) return;
    const generation = ++hostedGeneration.current;
    setHosted(previous => ({ ...previous, loading: true, error: null }));
    void authorized((client, token) => client.getMyActivities(token)).then(activities => {
      if (generation === hostedGeneration.current) setHosted({ activities, loading: false, error: null });
    }).catch(error => {
      if (generation === hostedGeneration.current && !(error instanceof DOMException && error.name === "AbortError")) setHosted({ activities: [], loading: false, error: error instanceof Error ? error.message : "Could not load your activities." });
    });
  }, [authorized, sessionToken]);
  useEffect(() => {
    setHosted({ activities: [], loading: false, error: null });
    reloadHosted();
    return () => { hostedGeneration.current += 1; };
  }, [reloadHosted]);
  useEffect(() => {
    function pop() {
      const params = new URLSearchParams(location.search);
      setSelectedId(params.get("activity"));
      setView(params.get("view") === "invites" ? "invites" : "activity");
      setInviteCode(params.get("invite")?.trim().toUpperCase() || null);
      setPage("explore");
    }
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  return <div className="app-shell">
    <header className="masthead">
      <div><p className="eyebrow">Velio</p><h1>Good plans. Better company.</h1></div>
      <AccountSelector onSelect={chooseAccount} onSignIn={() => setIdentityPrompt(true)} />
    </header>
    <nav className="product-nav" aria-label="Main navigation">
      <button type="button" aria-current={page === "explore" ? "page" : undefined} onClick={() => navigate("explore")}>Explore activities</button>
      {ready && <>
        <button type="button" aria-current={page === "bookings" ? "page" : undefined} onClick={() => navigate("bookings")}>My bookings</button>
        <button type="button" aria-current={page === "hosting" ? "page" : undefined} onClick={() => navigate("hosting")}>My activities</button>
        <button type="button" className="button-primary publish-action" aria-current={page === "publish" ? "page" : undefined} onClick={() => navigate("publish")}>Publish activity</button>
      </>}
    </nav>
    {needsSignIn && !ready && <dialog ref={promptDialog} className="overlay" aria-label="Select your identity" onCancel={() => setIdentityPrompt(false)}>
      <button type="button" className="button-ghost" onClick={() => { setIdentityPrompt(false); if (status.status === "credential-lost") store.signOut(); }}>Close</button>
      <IdentityPanel contextNote="Your draft and selected activity are kept." inviteCode={inviteCode ?? undefined} />
    </dialog>}
    {status.status === "credential-lost" && status.restoring && <p className="notice" role="status">Restoring access for {status.lostFrom?.email}… Your checkout and drafts are kept.</p>}
    <main className={`workspace${page === "publish" && !inviteCode ? " publishing" : ""}`}>
      <div className="column publish-column" hidden={page !== "publish" || !!inviteCode}>
        <PublishForm onPublished={activity => { selectActivity(activity.id); setPage("hosting"); reloadHosted(); }} />
      </div>
      {!inviteCode && page !== "publish" && <>
        <div className="column">
          {page === "explore" ? <ActivityBrowser selectedId={selectedId} onSelect={selectActivity} bookingRevision={bookingRevision} live={liveAvailability} />
            : page === "hosting" ? <HostedActivities activities={hosted.activities} selectedId={selectedId} onSelect={selectActivity} reload={reloadHosted} loading={hosted.loading} error={hosted.error} />
              : ready ? <SavedBookings onSelect={selectActivity} /> : <p className="hint">Sign in to see your bookings.</p>}
        </div>
        <div className="column">
          {view === "invites" && selectedId ? <InvitePanel key={selectedId} activityId={selectedId} onBack={backToActivity} onRequestIdentity={() => setIdentityPrompt(true)} />
            : selectedId ? <GuestActivity key={selectedId} activityId={selectedId} booking={bookingStore} visible observationId={observationId} onOpenInvites={openInvites} onAvailability={setLiveAvailability} />
              : <div className="selection-intro"><p className="eyebrow">{page === "hosting" ? "Make something happen" : page === "bookings" ? "Your next outing" : "Find your people"}</p><h2>{page === "hosting" ? "Bring a good plan to life." : "A little adventure starts here."}</h2><p>{page === "hosting" ? "Choose an activity to see its bookings, or publish something new." : "Choose an activity to see the itinerary, meet your host and plan your day."}</p></div>}
        </div>
      </>}
      {inviteCode && <div className="column invite-column"><InviteLanding key={inviteCode} code={inviteCode} onCodeChange={code => { setInviteCode(code); syncUrl(selectedId, view, code); }} visible booking={bookingStore} onRequestIdentity={() => setIdentityPrompt(true)} onBrowse={() => { selectActivity(null); setPage("explore"); }} /></div>}
    </main>
  </div>;
}
