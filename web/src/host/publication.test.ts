// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { PublishForm } from "./PublishForm.js";
import { SessionProvider } from "../session.js";
import type { Transport } from "../api.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("when capacity is fractional, publication retains the draft; correcting it publishes the itinerary and ordinary price in minor units", async () => {
  localStorage.setItem("velio.session.v1", JSON.stringify({ token: "host", user: { id: "host", email: "host@example.test", displayName: "Host" } }));
  const requests: Record<string, unknown>[] = [];
  const transport: Transport = async (_url, init) => { requests.push(JSON.parse(init.body!)); return { status: 201, json: { activity: { id: "published" } } }; };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let published: string | undefined;
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(PublishForm, { onPublished: activity => { published = activity.id; } }) })));
    async function fill(id: string, value: string) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await fill("pub-title", "Sunset paddle"); await fill("pub-description", "A calm paddle."); await fill("pub-itinerary", "Meet. Paddle. Tea."); await fill("pub-price", "12.50"); await fill("pub-spots", "2.5");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(requests).toHaveLength(0);
    expect(container.textContent).toContain("whole number");
    expect(container.querySelector<HTMLTextAreaElement>("#pub-itinerary")!.value).toBe("Meet. Paddle. Tea.");
    await fill("pub-spots", "6");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(requests).toEqual([expect.objectContaining({ title: "Sunset paddle", description: "A calm paddle.", itinerary: "Meet. Paddle. Tea.", spots: 6, priceMinorUnits: 1250, currency: "EUR" })]);
    expect(published).toBe("published");
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); }
});
