import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountSelector, type DemoAccount } from "./AccountSelector.js";
import type { HostActivityView } from "./api.js";
import { createBookingStore } from "./booking-store.js";
import { IdentityPanel } from "./IdentityPanel.js";
import { ActivityBrowser } from "./guest/ActivityBrowser.js";
import { GuestActivity } from "./guest/GuestActivity.js";
import { InviteLanding } from "./guest/InviteLanding.js";
import { HostedActivities } from "./host/HostedActivities.js";
import { PublishForm } from "./host/PublishForm.js";
import { SavedBookings } from "./SavedBookings.js";
import { useSession } from "./session.js";

type Page = "explore" | "hosting" | "bookings" | "publish";
const PAGES: readonly string[] = ["explore", "hosting", "bookings", "publish"];

function pageIn(search: string): Page | null {
  const page = new URLSearchParams(search).get("page");
  return page !== null && PAGES.includes(page) ? page as Page : null;
}

const PAGE_TITLE: Record<"explore" | "hosting" | "bookings", { title: string; sub: string }> = {
  explore: { title: "Explore activities", sub: "Discover something worth doing together." },
  hosting: { title: "My activities", sub: "Manage what you're hosting and keep plans moving." },
  bookings: { title: "My bookings", sub: "The plans you have already joined." },
};

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
    const linked = pageIn(location.search);
    if (linked !== null) return linked;
    if (new URLSearchParams(location.search).has("activity") || !ready) return "explore";
    return status.user.email === "host@velio.test" ? "hosting" : status.user.email === "booker@velio.test" ? "bookings" : "explore";
  });
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get("activity"));
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

  useEffect(() => {
    if (pageIn(location.search) !== null) return;
    const url = new URL(location.href);
    url.searchParams.set("page", page);
    history.replaceState(null, "", url);
  }, [page]);
  const syncUrl = useCallback((listPage: Page, activityId: string | null, code: string | null) => {
    const url = new URL(location.href);
    url.searchParams.set("page", listPage);
    if (activityId) url.searchParams.set("activity", activityId); else url.searchParams.delete("activity");
    if (code) url.searchParams.set("invite", code); else url.searchParams.delete("invite");
    if (url.href !== location.href) history.pushState(null, "", url);
  }, []);
  const selectActivity = useCallback((id: string | null, listPage: Page = page) => {
    setPage(listPage); setSelectedId(id); setInviteCode(null);
    syncUrl(listPage, id, null);
  }, [page, syncUrl]);
  function navigate(next: Page) {
    selectActivity(null, next);
  }
  function chooseAccount(account: DemoAccount) {
    const next = account === "Host" ? "hosting" : account === "Booker" ? "bookings" : "explore";
    setPage(next);
    syncUrl(next, selectedId, inviteCode);
    setIdentityPrompt(false);
  }

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
      setInviteCode(params.get("invite")?.trim().toUpperCase() || null);
      setPage(pageIn(location.search) ?? "explore");
    }
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  // The redesigned screens are full pages: the selected activity is the
  // detail page, reached from any list and left via its back link or the
  // main navigation, which always opens that page's list.
  const showDetail = selectedId !== null && page !== "publish";
  const backLabel = page === "hosting" ? "Back to My activities" : page === "bookings" ? "Back to My bookings" : "Back to Explore";

  return <div className="app-shell">
    <header className="app-nav">
      <div className="app-nav-inner">
        <span className="brand">Velio</span>
        <nav className="nav-links" aria-label="Main navigation">
          <button type="button" aria-current={page === "explore" ? "page" : undefined} onClick={() => navigate("explore")}>Explore</button>
          {ready && <>
            <button type="button" aria-current={page === "bookings" ? "page" : undefined} onClick={() => navigate("bookings")}>My bookings</button>
            <button type="button" aria-current={page === "hosting" ? "page" : undefined} onClick={() => navigate("hosting")}>My activities</button>
          </>}
        </nav>
        <div className="nav-side">
          <AccountSelector onSelect={chooseAccount} onSignIn={() => setIdentityPrompt(true)} />
          {ready && <span className="nav-divider" aria-hidden="true" />}
          {ready && <button type="button" className="button-primary publish-action" aria-current={page === "publish" ? "page" : undefined} onClick={() => navigate("publish")}>Publish activity</button>}
        </div>
      </div>
    </header>
    {needsSignIn && !ready && <dialog ref={promptDialog} className="overlay" aria-label="Select your identity" onCancel={() => setIdentityPrompt(false)}>
      <button type="button" className="button-ghost" onClick={() => { setIdentityPrompt(false); if (status.status === "credential-lost") store.signOut(); }}>Close</button>
      <IdentityPanel contextNote="Your draft and selected activity are kept." inviteCode={inviteCode ?? undefined} />
    </dialog>}
    {status.status === "credential-lost" && status.restoring && <div className="page"><p className="notice" role="status">Restoring access for {status.lostFrom?.email}… Your checkout and drafts are kept.</p></div>}
    <main>
      {inviteCode && <div className="page"><InviteLanding key={inviteCode} code={inviteCode} onCodeChange={code => { setInviteCode(code); syncUrl(page, selectedId, code); }} visible booking={bookingStore} onRequestIdentity={() => setIdentityPrompt(true)} onBrowse={() => selectActivity(null, "explore")} onViewBooking={activityId => selectActivity(activityId, "bookings")} /></div>}
      {/* The publish draft stays mounted (hidden) so switching accounts,
          pages or opening an invitation retains every entered value. */}
      <div className="page page-narrow" hidden={page !== "publish" || !!inviteCode}>
        <PublishForm onPublished={activity => { selectActivity(activity.id, "hosting"); reloadHosted(); }} />
      </div>
      {!inviteCode && <>
        {page !== "publish" && (showDetail && selectedId
          ? <div className="page"><GuestActivity key={selectedId} activityId={selectedId} booking={bookingStore} visible observationId={observationId} onAvailability={setLiveAvailability} onBack={() => selectActivity(null)} backLabel={backLabel} /></div>
          : <div className="page">
            <div className="page-head">
              <h1>{PAGE_TITLE[page].title}</h1>
              <p className="page-sub">{PAGE_TITLE[page].sub}</p>
            </div>
            {page === "explore" ? <ActivityBrowser selectedId={selectedId} onSelect={selectActivity} bookingRevision={bookingRevision} live={liveAvailability} />
              : page === "hosting" ? <HostedActivities activities={hosted.activities} selectedId={selectedId} onSelect={selectActivity} reload={reloadHosted} loading={hosted.loading} error={hosted.error} />
                : ready ? <SavedBookings onSelect={selectActivity} /> : <p className="hint">Sign in to see your bookings.</p>}
          </div>)}
      </>}
    </main>
  </div>;
}
