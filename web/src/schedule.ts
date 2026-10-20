/**
 * Local wall-clock + IANA timezone -> correct UTC instant. A wall time in a
 * zone maps through the zone's offset at that wall time (DST aware): the
 * conversion tentatively reads the wall time as UTC, measures the zone's
 * offset there, re-measures at the adjusted instant and settles — a wrong
 * side of a DST transition corrects on the second pass because the offset at
 * the adjusted instant is the one that applies.
 */

export function localWallToUtcInstant(wall: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) {
    throw new Error("Choose a date and a start time.");
  }
  let candidate = Date.parse(`${wall}:00Z`);
  if (Number.isNaN(candidate)) {
    throw new Error("Choose a date and a start time.");
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const offsetMinutes = zoneOffsetMinutes(new Date(candidate), timeZone);
    const adjusted = Date.parse(`${wall}:00Z`) - offsetMinutes * 60_000;
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  const date = new Date(candidate);
  const requested = Date.parse(`${wall}:00Z`);
  const roundTrip = date.getTime() + zoneOffsetMinutes(date, timeZone) * 60_000;
  if (Number.isNaN(date.getTime()) || roundTrip !== requested || new Date(requested).toISOString().slice(0, 16) !== wall) {
    throw new Error("That moment does not exist in this timezone");
  }
  return date;
}

/** The zone's offset in minutes east of UTC at the given instant. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (Number.isNaN(value)) throw new Error(`Unknown timezone: ${timeZone}`);
    return value;
  };
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
