import { describe, expect, it } from "vitest";
import { assessRendered } from "../scripts/measure-rendered.mts";

/** Rendered-availability verdicts (ticket 08): honest labels, never a silent pass. */
const complete = {
  coverage: { committedBookings: 30, unrecordedBookings: 0, captureFailures: 0, bookingsWithoutViewers: 0 },
  measurements: { total: 90, closedWithinDeadline: 90, late: 0, pendingUnderDeadline: 0, missing: 0, disconnected: 0 },
  bookingsMeasured: 30,
  bookingsWithMissingViewer: 0,
  p95IntervalMs: 98,
  p95IsLowerBound: false,
  deadlineMs: 2000,
};

describe("rendered availability verdict", () => {
  it("meets the target only with complete coverage of every expected viewer and p95 within two seconds", () => {
    expect(assessRendered(complete, { bookings: 30, viewers: 3 })).toMatchObject({ status: "meets", reasons: [] });
  });

  it("reports a failure when the slowest-viewer p95 exceeds two seconds", () => {
    expect(assessRendered({ ...complete, p95IntervalMs: 2400 }, { bookings: 30, viewers: 3 }).status).toBe("fails");
  });

  it("labels missing acknowledgements as a lower bound and missing captures as incomplete, never a pass", () => {
    const lowerBound = assessRendered(
      { ...complete, p95IsLowerBound: true, bookingsWithMissingViewer: 2, measurements: { ...complete.measurements, missing: 2 } },
      { bookings: 30, viewers: 3 },
    );
    expect(lowerBound.status).toBe("incomplete");
    expect(lowerBound.reasons).toEqual(expect.arrayContaining(["p95_lower_bound", "missing_acknowledgements"]));

    const uncovered = assessRendered(
      { ...complete, coverage: { ...complete.coverage, captureFailures: 1, bookingsWithoutViewers: 1 } },
      { bookings: 30, viewers: 3 },
    );
    expect(uncovered.status).toBe("incomplete");
    expect(uncovered.reasons).toEqual(expect.arrayContaining(["capture_failures", "bookings_without_viewers"]));

    // Fewer measurements than bookings x declared viewers: a viewer was not captured.
    const short = assessRendered({ ...complete, measurements: { ...complete.measurements, total: 60 } }, { bookings: 30, viewers: 3 });
    expect(short.reasons).toContain("fewer_viewers_captured_than_declared");
  });

  it("reports an empty sample as incomplete rather than an observed zero", () => {
    const empty = assessRendered(
      { ...complete, bookingsMeasured: 0, p95IntervalMs: null, measurements: { ...complete.measurements, total: 0, closedWithinDeadline: 0 } },
      { bookings: 30, viewers: 3 },
    );
    expect(empty).toMatchObject({ status: "incomplete" });
    expect(empty.reasons).toContain("empty_sample");
  });

  it("reports failed bookings and unrelated bookings in the window as incomplete evidence", () => {
    const verdict = assessRendered(complete, { bookings: 30, viewers: 3, failedBookings: 2, unrelatedBookingsInWindow: 1 });
    expect(verdict.status).toBe("incomplete");
    expect(verdict.reasons).toEqual(expect.arrayContaining(["booking_failures", "unrelated_bookings_in_window"]));
  });
});
