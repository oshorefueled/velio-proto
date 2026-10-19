import { createElement, type ReactNode } from "react";
import type { LiveAvailability } from "./availability.js";

/**
 * Recovery indicator (issue #18): an honest, small status line. "Out of date"
 * is claimed only on known loss or a failed refresh, and it clears only when
 * a database snapshot has actually reconciled the view — a socket opening
 * alone proves nothing about freshness. When the snapshot is fresh but the
 * transport is still down, the two facts are stated separately.
 */
export function LiveStatus({ live }: { live: LiveAvailability }): ReactNode | null {
  if (live.stale) {
    return createElement(
      "p",
      { className: "hint live-status", role: "status" },
      "Live updates are unavailable — the availability shown may be out of date.",
    );
  }
  if (live.connection === "reconnecting" || live.connection === "offline") {
    return createElement(
      "p",
      { className: "hint live-status", role: "status" },
      "Reconnecting live updates…",
    );
  }
  return null;
}
