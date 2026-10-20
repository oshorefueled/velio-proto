// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "./App.js";
import { SessionProvider } from "./session.js";
import type { Transport } from "./api.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("when demo accounts are selected, Host opens hosted activities, Booker opens saved bookings and Guest opens public exploration", async () => {
  localStorage.clear(); window.history.replaceState(null, "", "/");
  const requests: string[] = [];
  const transport: Transport = async (url, init) => {
    requests.push(url);
    if (url.endsWith("/demo/sessions")) {
      const { email } = JSON.parse(init.body!);
      return { status: 200, json: { session: { token: email }, user: { id: email, email, displayName: email.split("@")[0] } } };
    }
    if (url.endsWith("/my/bookings")) return { status: 200, json: { bookings: [{ id: "saved", activityId: "paddle", activity: { id: "paddle", title: "Saved sunset paddle", startsAt: "2030-11-20T16:00:00Z", timezone: "Africa/Lagos" } }] } };
    return { status: 200, json: { activities: [] } };
  };
  vi.stubGlobal("WebSocket", class { close() {} });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const text = () => [...container.querySelectorAll("h1,h2")].filter(el => !el.closest("[hidden]")).map(el => el.textContent);
  const click = async (name: string) => act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === name)!.click());
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(App) })));
    await click("Host");
    expect(text()).toContain("My activities");
    expect(container.textContent).not.toContain("Host tools");
    expect(container.textContent).not.toContain("Booking tools");
    await click("Booker");
    expect(text()).toContain("My bookings");
    expect(container.textContent).toContain("Saved sunset paddle");
    expect(requests.some(url => url.endsWith("/my/bookings"))).toBe(true);
    await click("Guest");
    expect(text()).toContain("Explore activities");
    expect([...container.querySelectorAll("input[name=email]")].filter(el => !el.closest("[hidden]") )).toHaveLength(0);
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it("when an activity is opened from My bookings or My activities, browser back returns to that list, and a refresh keeps the list page", async () => {
  localStorage.clear(); window.history.replaceState(null, "", "/");
  const host = { id: "host", email: "host@velio.test", displayName: "Ada" };
  localStorage.setItem("velio.session.v1", JSON.stringify({ token: "host-token", user: host }));
  const listed = { id: "paddle", hostId: "host", title: "Sunset paddle", description: "On the water.", startsAt: "2030-11-20T16:00:00Z", endsAt: "2030-11-20T18:00:00Z", timezone: "Europe/London", country: "GB", priceMinorUnits: 1000, currency: "GBP", capacity: 4, bookedCount: 1, remainingSpots: 3, availabilityVersion: "1", hostDisplayName: "Ada", started: false };
  const transport: Transport = async (url) => {
    if (url.endsWith("/my/bookings")) return { status: 200, json: { bookings: [{ id: "saved", activityId: "paddle", planId: "plan", activity: { id: "paddle", title: "Sunset paddle", startsAt: listed.startsAt, timezone: listed.timezone } }] } };
    if (url.endsWith("/my/activities")) return { status: 200, json: { activities: [{ ...listed, confirmedCount: 1 }] } };
    if (url.endsWith("/bookings/me")) return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    if (url.endsWith("/participants")) return { status: 200, json: { activityId: "paddle", planId: "plan", confirmedCount: 0, participants: [] } };
    if (url.endsWith("/activities/paddle")) return { status: 200, json: { activity: listed, plan: { id: "plan", itinerary: "Paddle." }, invites: { eligible: true, canCreateInvites: true, arm: "treatment" } } };
    return { status: 200, json: { activities: [listed] } };
  };
  vi.stubGlobal("WebSocket", class { close() {} send() {} });
  const container = document.createElement("div"); document.body.append(container);
  let root = createRoot(container);
  const heading = () => container.querySelector("main h1:not([hidden] h1)")?.textContent;
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => {}); };
  const click = async (name: string) => act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === name)!.click());
  const back = async () => { await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 20)); }); await settle(); };
  const render = async () => { await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(App) }))); await settle(); };
  try {
    await render();
    await click("My bookings");
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>(".browse-item")!.click());
    await settle();
    expect(heading()).toBe("Sunset paddle");
    expect(container.textContent).toContain("Back to My bookings");
    await back();
    expect(heading()).toBe("My bookings");
    await click("My activities");
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>(".hosted-row-card")!.click());
    await settle();
    expect(container.textContent).toContain("Back to My activities");
    await back();
    expect(heading()).toBe("My activities");
    await click("My bookings");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(heading()).toBe("My bookings");
    await click("Explore");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(heading()).toBe("Explore activities");
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it("when the default page opens an activity, browser back returns to that default list", async () => {
  localStorage.clear(); window.history.replaceState(null, "", "/");
  const booker = { id: "booker", email: "booker@velio.test", displayName: "Tunde" };
  localStorage.setItem("velio.session.v1", JSON.stringify({ token: "booker-token", user: booker }));
  const listed = { id: "paddle", hostId: "host", title: "Sunset paddle", description: "On the water.", startsAt: "2030-11-20T16:00:00Z", endsAt: "2030-11-20T18:00:00Z", timezone: "Europe/London", country: "GB", priceMinorUnits: 1000, currency: "GBP", capacity: 4, bookedCount: 1, remainingSpots: 3, availabilityVersion: "1", hostDisplayName: "Ada", started: false };
  const transport: Transport = async (url) => {
    if (url.endsWith("/my/bookings")) return { status: 200, json: { bookings: [{ id: "saved", activityId: "paddle", planId: "plan", activity: { id: "paddle", title: "Sunset paddle", startsAt: listed.startsAt, timezone: listed.timezone } }] } };
    if (url.endsWith("/bookings/me")) return { status: 404, json: { error: { code: "booking_not_found", message: "none" } } };
    if (url.endsWith("/activities/paddle")) return { status: 200, json: { activity: listed, plan: { id: "plan", itinerary: "Paddle." }, invites: { eligible: true, canCreateInvites: true, arm: "treatment" } } };
    return { status: 200, json: { activities: [] } };
  };
  vi.stubGlobal("WebSocket", class { close() {} send() {} });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const heading = () => container.querySelector("main h1:not([hidden] h1)")?.textContent;
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => {}); };
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(App) })));
    await settle();
    expect(heading()).toBe("My bookings");
    await act(async () => container.querySelector<HTMLButtonElement>(".browse-item")!.click());
    await settle();
    expect(heading()).toBe("Sunset paddle");
    await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 20)); });
    await settle();
    expect(heading()).toBe("My bookings");
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});
