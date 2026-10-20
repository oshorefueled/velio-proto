// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AccountSelector } from "./AccountSelector.js";
import { SessionProvider } from "./session.js";
import type { Transport } from "./api.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("when Host entry is pending and Guest is selected, a late Host response cannot replace Guest sign-in", async () => {
  localStorage.clear();
  let resolve!: (value: Awaited<ReturnType<Transport>>) => void;
  const pending = new Promise<Awaited<ReturnType<Transport>>>(r => { resolve = r; });
  const transport: Transport = async () => pending;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(AccountSelector) })));
    const click = async (text: string) => act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === text)!.click());
    await click("Host");
    await click("Guest");
    await act(async () => resolve({ status: 200, json: { session: { token: "old" }, user: { id: "host", email: "host@velio.test", displayName: "Old Host" }, created: false } }));
    expect(container.textContent).toContain("Sign in");
    expect(container.textContent).not.toContain("Old Host");
    expect(localStorage.getItem("velio.session.v1")).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); }
});
