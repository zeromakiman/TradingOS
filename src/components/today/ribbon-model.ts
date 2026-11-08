import { SESSION_LABELS, formatMinutes, minutesUntil } from "@/components/shell/session-labels";
import { nextBoundary, type Session, strategyClock } from "@/domain/session";

/**
 * Session ribbon of Today (docs/V2_ARCHITECTURE.md §14.1): the strategy day (fixed UTC−5) cut into its sessions, the
 * current one, and the next boundary. Every segment end comes from `nextBoundary` (src/domain/session.ts, parity-tested
 * against `strategyClock`), so the ribbon can never disagree with the Risk Engine's session rules. Pure: the client
 * ribbon recomputes it as its clock ticks, and the server renders the same markup.
 */

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

export interface RibbonSegment {
  session: Session;
  label: string;
  /** Minutes after 00:00 UTC−5 (0 ≤ from < to ≤ 1440). */
  from: number;
  to: number;
  /** "02:00"; the day's end reads "24:00". */
  fromLabel: string;
  toLabel: string;
  current: boolean;
}

export interface RibbonNext {
  session: Session;
  label: string;
  /** "18:00" (UTC−5). */
  time: string;
  /** ISO instant of the boundary. */
  at: string;
  /** "3h 15m". */
  countdown: string;
  /** The boundary falls on the next strategy day (after 18:00 the next one is Judas at 01:00). */
  nextDay: boolean;
}

export interface RibbonModel {
  day: string;
  /** "14:45" (UTC−5). */
  time: string;
  session: Session;
  sessionLabel: string;
  /** Minutes elapsed in the strategy day, with seconds as a fraction (the "now" marker). */
  minute: number;
  segments: RibbonSegment[];
  next: RibbonNext;
  /** The whole ribbon in words, for assistive technology. */
  summary: string;
}

function clockLabel(minute: number): string {
  const whole = Math.round(minute);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** Start of a strategy day: 00:00 UTC−5 is 05:00 UTC (the strategy clock never observes daylight saving). */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T05:00:00.000Z`);
}

/** The sessions of one strategy day, walked boundary by boundary with `nextBoundary`. */
export function daySegments(day: string): Omit<RibbonSegment, "current">[] {
  const start = dayStartMs(day);
  const end = start + DAY_MINUTES * MINUTE_MS;
  const segments: Omit<RibbonSegment, "current">[] = [];
  let at = start;
  while (at < end) {
    const session = strategyClock(new Date(at)).session;
    const boundary = Math.min(Date.parse(nextBoundary(new Date(at)).at), end);
    const from = (at - start) / MINUTE_MS;
    const to = (boundary - start) / MINUTE_MS;
    segments.push({ session, label: SESSION_LABELS[session], from, to, fromLabel: clockLabel(from), toLabel: clockLabel(to) });
    at = boundary;
  }
  return segments;
}

export function ribbonModel(nowMs: number): RibbonModel {
  const now = new Date(nowMs);
  const clock = strategyClock(now);
  const minute = (nowMs - dayStartMs(clock.day)) / MINUTE_MS;
  const segments = daySegments(clock.day).map(segment => ({ ...segment, current: segment.from <= minute && minute < segment.to }));
  const boundary = nextBoundary(now);
  const next: RibbonNext = {
    session: boundary.session,
    label: SESSION_LABELS[boundary.session],
    time: boundary.time,
    at: boundary.at,
    countdown: formatMinutes(minutesUntil(Date.parse(boundary.at), nowMs)),
    nextDay: boundary.day !== clock.day,
  };
  const sessionLabel = SESSION_LABELS[clock.session];
  const parts = segments.map(segment => `${segment.label} ${segment.fromLabel}–${segment.toLabel}`).join(", ");
  const summary = `Sessions today (UTC−5): ${parts}. Now ${clock.time}, ${sessionLabel}. Next: ${next.label} at ${next.time}${next.nextDay ? " tomorrow" : ""}, in ${next.countdown}.`;
  return { day: clock.day, time: clock.time, session: clock.session, sessionLabel, minute, segments, next, summary };
}

/**
 * Whether a page rendered at `renderedAt` shows a session or strategy day that has ended by `nowMs`: Today's status
 * (Dead Pool, the day's usage) must then be computed again on the server.
 */
export function renderOutdated(renderedAt: string, nowMs: number): boolean {
  const rendered = Date.parse(renderedAt);
  if (!Number.isFinite(rendered) || !Number.isFinite(nowMs)) return false;
  if (nowMs >= Date.parse(nextBoundary(new Date(rendered)).at)) return true;
  return strategyClock(new Date(nowMs)).day !== strategyClock(new Date(rendered)).day;
}
