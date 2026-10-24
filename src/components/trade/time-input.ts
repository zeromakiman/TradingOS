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

/**
 * The instant a wall-clock time names in the display, as an ISO 8601 UTC string; null when the text is not a real
 * minute (`2026-02-30T10:00`, `24:00`). Strategy time is a fixed UTC−5 clock (offset arithmetic, never a DST zone);
 * a local time inside a daylight-saving gap resolves to the zone's offset after the change.
 */
export function instantOfWallClock(value: string, display: TimeDisplay): string | null {
  const match = WALL_CLOCK.exec(value.trim());
  if (!match) return null;
  const [, day, hourText, minuteText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!isCalendarDay(day) || hour > 23 || minute > 59) return null;
  const [year, month, date] = day.split("-").map(Number);
  const wallUtc = Date.UTC(year, month - 1, date, hour, minute);
  let offset = 0;
  if (display.mode === "strategy") offset = STRATEGY_OFFSET_MINUTES;
  else if (display.mode === "local") {
    const zone = display.zone ?? "";
    if (!isValidTimeZone(zone)) return null;
    // The offset at the wall-clock reading, then at the instant it gives: two passes settle around a change.
    const first = zoneOffsetMinutes(wallUtc, zone);
    const second = zoneOffsetMinutes(wallUtc - first * MINUTE_MS, zone);
    offset = second;
  }
  const instant = new Date(wallUtc - offset * MINUTE_MS);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/** Zone words for the field hint: `UTC−5 (strategy time)`, `UTC`, or the local zone's short name at `at`. */
export function zoneHint(display: TimeDisplay, at?: Instant): string {
  if (display.mode === "strategy") return "UTC−5 (strategy time)";
  try {
    return zoneLabel(display, at);
  } catch {
    return "UTC";
  }
}
