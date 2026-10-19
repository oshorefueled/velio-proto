import { describe, expect, it } from "vitest";
import { localWallToUtcInstant, isValidTimeZone } from "./schedule.js";

/**
 * Focused risk check: the publication form converts the host's local wall
 * time + timezone into the exact UTC instant, including across DST changes.
 * The backend rejects non-future starts and validates instants, so a wrong
 * conversion here would publish the plan an hour off.
 */
describe("localWallToUtcInstant", () => {
  it("converts a winter wall time in a negative-offset zone", () => {
    // America/New_York is UTC-5 in January.
    expect(localWallToUtcInstant("2026-01-15T09:30", "America/New_York").toISOString()).toBe(
      "2026-01-15T14:30:00.000Z",
    );
  });

  it("converts a summer wall time in the same zone (DST active)", () => {
    // America/New_York is UTC-4 in July.
    expect(localWallToUtcInstant("2026-07-15T09:30", "America/New_York").toISOString()).toBe(
      "2026-07-15T13:30:00.000Z",
    );
  });

  it("rejects a spring-forward wall time that does not exist in the selected timezone", () => {
    expect(() => localWallToUtcInstant("2026-03-08T02:30", "America/New_York")).toThrow("does not exist");
  });

  it("keeps positive-offset zones exact", () => {
    expect(localWallToUtcInstant("2026-02-01T18:45", "Europe/Stockholm").toISOString()).toBe(
      "2026-02-01T17:45:00.000Z",
    );
  });

  it("rejects malformed wall input and unknown zones", () => {
    expect(() => localWallToUtcInstant("tomorrow", "UTC")).toThrow();
    expect(() => localWallToUtcInstant("2026-01-15T09:30", "Mars/Olympus")).toThrow();
  });

  it("validates zone names for the picker", () => {
    expect(isValidTimeZone("Europe/Stockholm")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
