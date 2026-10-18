/**
 * Time display for Trading OS. Strategy time is a fixed UTC−5 clock computed by offset
 * arithmetic (never a DST zone); "local" uses Intl with an explicit IANA zone captured from
 * the browser (cookie `tos_tz`). Display never changes risk policy: risk rules always use
 * the strategy clock from `session.ts`.
 */

export type TimeDisplayMode = "strategy" | "utc" | "local";
export interface TimeDisplay {
  mode: TimeDisplayMode;
  /** IANA zone, required for `local`. */
  zone?: string;
}
export type Instant = string | Date;

export const STRATEGY_TIME: TimeDisplay = Object.freeze({ mode: "strategy" });
export const STRATEGY_ZONE_LABEL = "UTC−5";

const STRATEGY_OFFSET_MS = -5 * 3_600_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}(?::?\d{2})?)$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function normalizeZone(zone: string): string {
  if (zone === "Z" || zone === "z") return "Z";
  const digits = zone.slice(1).replace(":", "");
  return `${zone[0]}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2) : "00"}`;
}

/** True for a real calendar day in `YYYY-MM-DD` form (Date.parse silently rolls 02-30 over). */
export function isCalendarDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Microseconds since the epoch. PostgreSQL timestamps keep microseconds, which `Date` drops,
 * so ordering and equality must use this key (same idea as `instantKey` in analytics.ts).
 * Strings must carry an explicit zone; local wall-clock strings are rejected.
 */
export function instantMicros(value: Instant): bigint {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new RangeError("Invalid timestamp.");
    return BigInt(ms) * 1000n;
  }
  const match = INSTANT_PATTERN.exec(value.trim());
  if (!match) throw new RangeError("A timestamp with an explicit timezone is required.");
  const [, day, hours, minutes, seconds = "00", fraction = "", zone] = match;
  if (!isCalendarDay(day) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) throw new RangeError("Invalid timestamp.");
  const ms = Date.parse(`${day}T${hours}:${minutes}:${seconds}${normalizeZone(zone)}`);
  if (!Number.isFinite(ms)) throw new RangeError("Invalid timestamp.");
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

export function isInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    instantMicros(value);
    return true;
  } catch {
    return false;
  }
}

export function compareInstants(a: Instant, b: Instant): number {
  const x = instantMicros(a);
  const y = instantMicros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Millisecond Date for display arithmetic (microseconds are truncated toward the past). */
export function toDate(value: Instant): Date {
  return new Date(Number(floorDiv(instantMicros(value), 1000n)));
}

/** True when the two instants are more than `minutes` apart (microsecond exact). */
export function differsByMoreThan(a: Instant, b: Instant, minutes: number): boolean {
  const delta = instantMicros(a) - instantMicros(b);
  return (delta < 0n ? -delta : delta) > BigInt(minutes) * 60_000_000n;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Parses the persisted preference (cookies `tos_time` / `tos_tz`); anything invalid falls back to strategy time. */
export function resolveTimeDisplay(mode?: string | null, zone?: string | null): TimeDisplay {
  if (mode === "utc") return { mode: "utc" };
  if (mode === "local" && isValidTimeZone(zone)) return { mode: "local", zone };
  return STRATEGY_TIME;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching Date#getUTCDay. */
  weekday: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(zone);
  if (!formatter) {
    if (!isValidTimeZone(zone)) throw new RangeError("Unknown time zone.");
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    zonedFormatters.set(zone, formatter);
  }
  return formatter;
}

function wallClock(instant: Instant, display: TimeDisplay): WallClock {
  const date = toDate(instant);
  if (display.mode === "local") {
    const parts = Object.fromEntries(zonedFormatter(display.zone ?? "").formatToParts(date).map(part => [part.type, part.value]));
    return {
      year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour) % 24, minute: Number(parts.minute),
      weekday: WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]),
    };
  }
  const shifted = display.mode === "strategy" ? new Date(date.getTime() + STRATEGY_OFFSET_MS) : date;
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), weekday: shifted.getUTCDay(),
  };
}

function calendarDayParts(day: string): WallClock {
  if (!isCalendarDay(day)) throw new RangeError("Invalid calendar day.");
  const [year, month, date] = day.split("-").map(Number);
  return { year, month, day: date, hour: 0, minute: 0, weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay() };
}

/** Strategy day (fixed UTC−5) of an instant, `YYYY-MM-DD`. */
export function strategyDay(instant: Instant): string {
  const clock = wallClock(instant, STRATEGY_TIME);
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`;
}

/** Strategy month (fixed UTC−5) of an instant, `YYYY-MM`. */
export function strategyMonth(instant: Instant): string {
  return strategyDay(instant).slice(0, 7);
}

/** Calendar day of an instant in the chosen display. */
export function displayDay(instant: Instant, display: TimeDisplay = STRATEGY_TIME): string {
  const clock = wallClock(instant, display);
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`;
}

/** `09:42` in the chosen display (minutes are truncated, never rounded up). */
export function formatTime(instant: Instant, display: TimeDisplay = STRATEGY_TIME): string {
  const clock = wallClock(instant, display);
  return `${pad(clock.hour)}:${pad(clock.minute)}`;
}

export interface DayFormat {
  weekday?: boolean;
  year?: boolean;
}

function dayText(clock: WallClock, options: DayFormat): string {
  const weekday = options.weekday ? `${WEEKDAYS[clock.weekday]}, ` : "";
  const year = options.year ? `, ${clock.year}` : "";
  return `${weekday}${MONTHS[clock.month - 1]} ${clock.day}${year}`;
}

/**
 * `Oct 14` (optionally `Tue, Oct 14, 2026`). A plain `YYYY-MM-DD` day is formatted as that
 * calendar day without any zone conversion; an instant is converted to the display zone first.
 */
export function formatDay(value: Instant, display: TimeDisplay = STRATEGY_TIME, options: DayFormat = {}): string {
  const clock = typeof value === "string" && DAY_PATTERN.test(value) ? calendarDayParts(value) : wallClock(value, display);
  return dayText(clock, options);
}

/** `Oct 14, 09:42` (optionally with the year). */
export function formatDateTime(instant: Instant, display: TimeDisplay = STRATEGY_TIME, options: DayFormat = {}): string {
  const clock = wallClock(instant, display);
  return `${dayText(clock, options)}, ${pad(clock.hour)}:${pad(clock.minute)}`;
}

/** `October 2026` for `2026-10`. */
export function formatMonth(month: string): string {
  const match = MONTH_PATTERN.exec(month);
  const index = match ? Number(match[2]) - 1 : -1;
  if (!match || index < 0 || index > 11) throw new RangeError("Invalid month.");
  return `${MONTH_NAMES[index]} ${match[1]}`;
}

/** Header label for a strategy day: `Tue, Oct 14 (UTC−5)`. Accepts an instant or a `YYYY-MM-DD` day. */
export function strategyDayLabel(value: Instant, options: { year?: boolean } = {}): string {
  return `${formatDay(value, STRATEGY_TIME, { weekday: true, year: options.year })} (${STRATEGY_ZONE_LABEL})`;
}

/** Zone suffix for a display: `UTC−5`, `UTC`, or the local short zone name at `at` (the zone id when `at` is absent). */
export function zoneLabel(display: TimeDisplay, at?: Instant): string {
  if (display.mode === "strategy") return STRATEGY_ZONE_LABEL;
  if (display.mode === "utc") return "UTC";
  const zone = display.zone ?? "";
  if (!isValidTimeZone(zone)) throw new RangeError("Unknown time zone.");
  if (at === undefined) return zone;
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(toDate(at)).find(p => p.type === "timeZoneName");
  return part?.value ?? zone;
}

function unit(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Relative time against an explicit `now` (server time; never the browser clock):
 * `just now`, `5 min ago`, `3 h ago`, `2 days ago`, `in 10 min`; a week or more falls back to the day.
 */
export function formatRelative(instant: Instant, now: Instant, display: TimeDisplay = STRATEGY_TIME): string {
  const delta = Number(instantMicros(now) - instantMicros(instant)) / 1000;
  const magnitude = Math.abs(delta);
  if (magnitude < MINUTE_MS) return "just now";
  if (magnitude >= 7 * DAY_MS) return formatDay(instant, display);
  const text = magnitude < HOUR_MS
    ? `${Math.floor(magnitude / MINUTE_MS)} min`
    : magnitude < DAY_MS
      ? `${Math.floor(magnitude / HOUR_MS)} h`
      : unit(Math.floor(magnitude / DAY_MS), "day", "days");
  return delta > 0 ? `${text} ago` : `in ${text}`;
}

/** Compact elapsed time such as `45m`, `2h 15m` or `3d 4h` (truncated, never negative). */
export function formatDuration(from: Instant, to: Instant): string {
  const micros = instantMicros(to) - instantMicros(from);
  const minutes = micros > 0n ? Number(micros / 60_000_000n) : 0;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** `YYYY-MM-DD` plus `days` (calendar arithmetic, no zones). */
export function addDays(day: string, days: number): string {
  const { year, month, day: date } = calendarDayParts(day);
  return new Date(Date.UTC(year, month - 1, date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday (strategy weeks start on Monday). */
export function weekdayIndex(day: string): number {
  return (calendarDayParts(day).weekday + 6) % 7;
}

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export function daysInMonth(month: string): number {
  const match = MONTH_PATTERN.exec(month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new RangeError("Invalid month.");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
}
