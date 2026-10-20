/**
 * Presentation derivations for the redesigned surfaces (revamp mockups 1–4).
 * Each helper reshapes a fact the API already provides; nothing here invents
 * data the backend does not send.
 */

export function initials(displayName: string): string {
  const word = displayName.trim().split(/\s+/)[0] ?? "";
  return word.slice(0, 2).toUpperCase();
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

function zoneParts(instant: string, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone,
  }).formatToParts(new Date(instant));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return { day: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

export function chipDateRange(startsAt: string, endsAt: string, timezone: string): string {
  const start = zoneParts(startsAt, timezone);
  const end = zoneParts(endsAt, timezone);
  const days = Math.round((Date.parse(`${end.day}T00:00:00Z`) - Date.parse(`${start.day}T00:00:00Z`)) / 86_400_000);
  const later = days === 0 ? "" : days === 1 ? " (next day)" : ` (+${days} days)`;
  return `${chipDateTime(startsAt, timezone)}–${end.time}${later}`;
}

export function durationLabel(startsAt: string, endsAt: string): string {
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours} h ${rest} min`;
}

export const COUNTRIES = [
  ["GB", "United Kingdom", "Europe/London"],
  ["IE", "Ireland", "Europe/Dublin"],
  ["FR", "France", "Europe/Paris"],
  ["DE", "Germany", "Europe/Berlin"],
  ["NL", "Netherlands", "Europe/Amsterdam"],
  ["ES", "Spain", "Europe/Madrid"],
  ["NG", "Nigeria", "Africa/Lagos"],
] as const;

export function countryName(code: string): string {
  return COUNTRIES.find(([value]) => value === code)?.[1] ?? code;
}

const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function offsetName(instant: string, timezone: string): string {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(instant))
    .find((part) => part.type === "timeZoneName")?.value ?? timezone;
  return name === "GMT+0" || name === "UTC" ? "GMT" : name;
}

export function zoneOffsetLabel(instant: string, timezone: string, viewer: string = viewerZone): string | null {
  const activity = offsetName(instant, timezone);
  return activity === offsetName(instant, viewer) ? null : activity;
}
