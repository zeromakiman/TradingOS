import { displayDay, formatTime, type Instant, isCalendarDay, isValidTimeZone, type TimeDisplay, zoneLabel } from "@/domain/time-display";

/**
 * "Earlier" time fields of the trade page (entry and exit times, docs/V2_ARCHITECTURE.md §5.1, §14.3): the trader
 * types a wall-clock time in their own time display (strategy UTC−5 by default, UTC, or their captured local zone),
 * and the form sends an ISO 8601 instant with an explicit zone. Pure: no browser clock, safe on server and client.
 * The server validates every time again (not in the future, after the lock or the entry).
 */

/** Value format of `<input type="datetime-local">` at minute precision: `2026-10-23T09:42`. */
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;
const STRATEGY_OFFSET_MINUTES = -5 * 60;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

/** Minutes the zone is ahead of UTC at the instant `utcMs` (negative west of Greenwich). */
function zoneOffsetMinutes(utcMs: number, zone: string): number {
  const parts = Object.fromEntries(zoneFormatter(zone).formatToParts(new Date(utcMs)).map(part => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / MINUTE_MS);
}

/** `YYYY-MM-DDTHH:mm` of an instant in the display (the value a datetime-local field shows for it). */
export function wallClockOf(instant: Instant, display: TimeDisplay): string {
  return `${displayDay(instant, display)}T${formatTime(instant, display)}`;
}

/** A typed wall-clock value as the epoch milliseconds of the same reading in UTC; null when it is not a real minute. */
function wallReading(value: string): number | null {
  const match = WALL_CLOCK.exec(value.trim());
  if (!match) return null;
  const [, day, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!isCalendarDay(day) || hour > 23 || minute > 59) return null;
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date, hour, minute);
}

/**
 * The offset (minutes ahead of UTC) a local reading is converted with, and an instant at which the zone has that
 * offset: the offset at the reading taken as UTC, then at the instant that gives; two passes settle around a change.
 * Inside a daylight-saving gap this is the offset before the change, so the time moves forward with the clock.
 */
function localReadingOffset(wallUtc: number, zone: string): { minutes: number; at: number } {
  const at = wallUtc - zoneOffsetMinutes(wallUtc, zone) * MINUTE_MS;
  return { minutes: zoneOffsetMinutes(at, zone), at };
}

/**
 * The instant a wall-clock time names in the display, as an ISO 8601 UTC string; null when the text is not a real
 * minute (`2026-02-30T10:00`, `24:00`). Strategy time is a fixed UTC−5 clock (offset arithmetic, never a DST zone);
 * a local time is read with the zone's offset at that time (`localReadingOffset`), so a time inside a daylight-saving
 * gap moves forward with the clock.
 */
export function instantOfWallClock(value: string, display: TimeDisplay): string | null {
  const wallUtc = wallReading(value);
  if (wallUtc === null) return null;
  let offset = 0;
  if (display.mode === "strategy") offset = STRATEGY_OFFSET_MINUTES;
  else if (display.mode === "local") {
    const zone = display.zone ?? "";
    if (!isValidTimeZone(zone)) return null;
    offset = localReadingOffset(wallUtc, zone).minutes;
  }
  const instant = new Date(wallUtc - offset * MINUTE_MS);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * The zone words of a typed value: `tag` beside the field and in its label, `hint` below it. They name the offset
 * `instantOfWallClock` converts this value with, so the typed time and its tag are exactly the instant recorded: a
 * local zone is named at the typed date, not today, and a time on the other side of a daylight-saving change from now
 * says "GMT+3" when it is read as GMT+3. `fallback` names the zone while the value is empty or not a real minute.
 */
export function wallClockZone(value: string, display: TimeDisplay, fallback: Instant): { tag: string; hint: string } {
  let at: Instant = fallback;
  const zone = display.zone ?? "";
  const wallUtc = display.mode === "local" && isValidTimeZone(zone) ? wallReading(value) : null;
  if (wallUtc !== null) at = new Date(localReadingOffset(wallUtc, zone).at);
  return { tag: zoneTag(display, at), hint: zoneHint(display, at) };
}

/** Zone words for the field hint: `UTC−5 (strategy time)`, `UTC`, or the local zone's short name at `at`. */
export function zoneHint(display: TimeDisplay, at?: Instant): string {
  if (display.mode === "strategy") return "UTC−5 (strategy time)";
  return zoneTag(display, at);
}

/**
 * The zone a time field reads its value in, as the short tag shown beside the field and in its label: `UTC−5`, `UTC`,
 * or the local zone's short name at `at` ("GMT+3", "EEST"). An unreadable local zone reads as UTC, as
 * `instantOfWallClock` then refuses the value instead of guessing.
 */
export function zoneTag(display: TimeDisplay, at?: Instant): string {
  try {
    return zoneLabel(display, at);
  } catch {
    return "UTC";
  }
}
