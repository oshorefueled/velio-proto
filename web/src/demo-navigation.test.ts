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
