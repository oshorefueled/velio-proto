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
    expect(requests).toEqual([expect.objectContaining({ title: "Sunset paddle", description: "A calm paddle.", itinerary: "Meet. Paddle. Tea.", spots: 6, priceMinorUnits: 1250, currency: "GBP", country: "GB", endsAt: expect.any(String) })]);
    expect(published).toBe("published");
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); }
});
it("when a description runs past 500 characters, the counter shows its length and the full text is published", async () => {
  localStorage.setItem("velio.session.v1", JSON.stringify({ token: "host", user: { id: "host", email: "host@example.test", displayName: "Host" } }));
  const requests: Record<string, unknown>[] = [];
  const transport: Transport = async (_url, init) => { requests.push(JSON.parse(init.body!)); return { status: 201, json: { activity: { id: "published" } } }; };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const long = "A long, detailed description. ".repeat(20).trim();
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(PublishForm, { onPublished: () => {} }) })));
    async function fill(id: string, value: string) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await fill("pub-title", "Sunset paddle"); await fill("pub-description", long); await fill("pub-itinerary", "Meet. Paddle. Tea."); await fill("pub-price", "12.50"); await fill("pub-spots", "6");
    expect(container.querySelector<HTMLTextAreaElement>("#pub-description")!.maxLength).toBe(-1);
    expect(container.textContent).toContain(`${long.length} characters`);
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(requests).toEqual([expect.objectContaining({ description: long })]);
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); }
});
it("when the end time is earlier on the clock, the activity ends the next day; an unspecified country is sent as null", async () => {
  localStorage.setItem("velio.session.v1", JSON.stringify({ token: "host", user: { id: "host", email: "host@example.test", displayName: "Host" } }));
  const requests: Record<string, unknown>[] = [];
  const transport: Transport = async (_url, init) => { requests.push(JSON.parse(init.body!)); return { status: 201, json: { activity: { id: "published" } } }; };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionProvider, { transport, children: createElement(PublishForm, { onPublished: () => {} }) })));
    async function fill(id: string, value: string) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!;
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
    }
    await fill("pub-title", "Late show"); await fill("pub-description", "A night out."); await fill("pub-itinerary", "Meet. Watch. Talk.");
    await fill("pub-timezone", "Europe/London"); await fill("pub-date", "2030-11-20"); await fill("pub-time", "21:30"); await fill("pub-end-time", "01:00");
    await fill("pub-country", "");
    expect(container.textContent).toContain("Ends the next day");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(requests).toEqual([expect.objectContaining({ startsAt: "2030-11-20T21:30:00.000Z", endsAt: "2030-11-21T01:00:00.000Z", country: null })]);
    await fill("pub-end-time", "21:30");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(requests).toHaveLength(1);
    expect(container.textContent).toContain("The end time must differ from the start time.");
  } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); }
});
