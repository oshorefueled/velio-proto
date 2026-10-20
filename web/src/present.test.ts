import { describe, expect, it } from "vitest";
import { chipDateRange, chipDateTime, countryName, hostStatus, initials, zoneOffsetLabel } from "./present.js";
import { formatMoneyCompact } from "./money.js";

// Revamp mockups 1–4: presentation derivations shared by the redesigned
// surfaces. They render only facts the API already provides — no invented
// fields — so each helper is a pure reshape of existing data.

describe("initials", () => {
  it("takes the first two letters of the person's first word", () => {
    expect(initials("Ada Okafor")).toBe("AD");
    expect(initials("Tunde Bello")).toBe("TU");
  });

  it("stays two characters even for short or single-word names", () => {
    expect(initials("Ada")).toBe("AD");
    expect(initials("A")).toBe("A");
    expect(initials("")).toBe("");
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

describe("chipDateRange", () => {
  it("adds the end time on the same local day", () => {
    expect(chipDateRange("2026-10-22T17:30:00Z", "2026-10-22T19:30:00Z", "Europe/London")).toBe("Thu, 22 Oct 2026 · 18:30–20:30");
  });

  it("says when the end falls on the next local day", () => {
    expect(chipDateRange("2026-10-22T20:30:00Z", "2026-10-23T00:00:00Z", "Europe/London")).toBe("Thu, 22 Oct 2026 · 21:30–01:00 (next day)");
  });
});

describe("zoneOffsetLabel", () => {
  it("shows nothing when the activity's offset matches the viewer's at that moment", () => {
    expect(zoneOffsetLabel("2026-10-22T17:30:00Z", "Europe/London", "Europe/London")).toBeNull();
    expect(zoneOffsetLabel("2026-10-22T17:30:00Z", "Africa/Lagos", "Europe/London")).toBeNull();
  });

  it("names the activity's offset at its own date when it differs", () => {
    expect(zoneOffsetLabel("2026-10-22T17:30:00Z", "Africa/Lagos", "America/New_York")).toBe("GMT+1");
    expect(zoneOffsetLabel("2026-12-10T17:30:00Z", "Africa/Lagos", "Europe/London")).toBe("GMT+1");
    expect(zoneOffsetLabel("2026-12-10T17:30:00Z", "UTC", "Africa/Lagos")).toBe("GMT");
    expect(zoneOffsetLabel("2026-10-22T17:30:00Z", "Asia/Kolkata", "Europe/London")).toBe("GMT+5:30");
  });
});

describe("countryName", () => {
  it("names listed countries", () => {
    expect(countryName("GB")).toBe("United Kingdom");
  });
});

describe("formatMoneyCompact", () => {
  it("drops zero minor units but keeps real cents", () => {
    expect(formatMoneyCompact(1_250_000, "NGN")).toBe("NGN\u00A012,500");
    expect(formatMoneyCompact(1_250, "EUR")).toBe("€12.50");
  });
});
