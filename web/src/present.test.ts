import { describe, expect, it } from "vitest";
import { chipDateTime, hostStatus, initials, zoneLabel } from "./present.js";
import { formatMoneyCompact } from "./money.js";

// Revamp mockups 1–4: presentation derivations shared by the redesigned
// surfaces. They render only facts the API already provides — no invented
// fields — so each helper is a pure reshape of existing data.

describe("initials", () => {
  it("takes the first two letters of the person's first word", () => {
    expect(initials("Ada · Demo host")).toBe("AD");
    expect(initials("Tunde · Demo booker")).toBe("TU");
  });

  it("stays two characters even for short or single-word names", () => {
    expect(initials("Ada")).toBe("AD");
    expect(initials("A")).toBe("A");
    expect(initials("")).toBe("");
  });
});

describe("zoneLabel", () => {
  it("names the zone's city", () => {
    expect(zoneLabel("Africa/Lagos")).toBe("Lagos time");
    expect(zoneLabel("America/New_York")).toBe("New York time");
    expect(zoneLabel("Europe/Stockholm")).toBe("Stockholm time");
  });

  it("leaves zoneless identifiers alone", () => {
    expect(zoneLabel("UTC")).toBe("UTC");
  });
});

describe("hostStatus", () => {
  it("reports started before anything else", () => {
    expect(hostStatus({ started: true, confirmedCount: 8, capacity: 8 })).toEqual({ tone: "blue", label: "Started" });
  });

  it("reports full when every spot is confirmed", () => {
    expect(hostStatus({ started: false, confirmedCount: 4, capacity: 4 })).toEqual({ tone: "red", label: "Full" });
  });

  it("reports upcoming otherwise", () => {
    expect(hostStatus({ started: false, confirmedCount: 1, capacity: 8 })).toEqual({ tone: "gray", label: "Upcoming" });
  });
});

describe("chipDateTime", () => {
  it("formats a Lagos activity as weekday, date and 24h time", () => {
    const chip = chipDateTime("2026-10-21T08:30:00+01:00", "Africa/Lagos");
    expect(chip).toBe("Wed, 21 Oct 2026 · 08:30");
  });
});

describe("formatMoneyCompact", () => {
  it("drops zero minor units but keeps real cents", () => {
    expect(formatMoneyCompact(1_250_000, "NGN")).toBe("NGN\u00A012,500");
    expect(formatMoneyCompact(1_250, "EUR")).toBe("€12.50");
  });
});
