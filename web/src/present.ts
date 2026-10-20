/**
 * Presentation derivations for the redesigned surfaces (revamp mockups 1–4).
 * Each helper reshapes a fact the API already provides; nothing here invents
 * data the backend does not send.
 */

/** "Ada · Demo host" → "AD"; the first two letters of the first word. */
export function initials(displayName: string): string {
  const word = displayName.trim().split(/\s+/)[0] ?? "";
  return word.slice(0, 2).toUpperCase();
}

/** "Africa/Lagos" → "Lagos time"; "UTC" stays "UTC". */
export function zoneLabel(timezone: string): string {
  if (!timezone.includes("/")) return timezone;
  const city = timezone.split("/").pop()!.replaceAll("_", " ");
  return `${city} time`;
}

export interface HostStatus {
  tone: "gray" | "blue" | "red";
  label: string;
}

/** The host row's status pill: started, full, or upcoming — the real states. */
export function hostStatus(hosted: { started: boolean; confirmedCount: number; capacity: number }): HostStatus {
  if (hosted.started) return { tone: "blue", label: "Started" };
  if (hosted.confirmedCount >= hosted.capacity) return { tone: "red", label: "Full" };
  return { tone: "gray", label: "Upcoming" };
}

/** "Tue, 21 Oct 2026 · 08:30" in the activity's own timezone. */
export function chipDateTime(startsAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).formatToParts(new Date(startsAt));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("weekday")}, ${pick("day")} ${pick("month")} ${pick("year")} · ${pick("hour")}:${pick("minute")}`;
}
