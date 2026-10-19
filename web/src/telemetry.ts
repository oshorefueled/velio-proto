import type { VelioApi } from "./api.js";

/**
 * activity_viewed telemetry (issue #14 slice): emitted from the effect that
 * runs after visible details have been applied — never before render, never
 * blocking host operations. One stable event id per activity observation, so
 * a retry of the same observation is a server-side duplicate, not a second
 * viewed event.
 */
export function emitActivityViewed(
  api: VelioApi,
  input: { eventId: string; activityId: string; visitorId: string; token?: string | null },
): void {
  void api.emitActivityViewed(input).catch(() => {
    // Observation failure must not prevent host operations.
  });
}
