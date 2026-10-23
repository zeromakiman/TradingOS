import { differsByMoreThan, displayDay, formatDateTime, formatTime, type TimeDisplay, zoneLabel } from "@/domain/time-display";
import type { TimelineItem } from "@/domain/timeline";

/**
 * Time rules of the trade timeline (docs/V2_ARCHITECTURE.md §5.4): an item shows when it happened
 * (`at`: user-reported entry and exit times, otherwise the server recording time) and, when it was recorded
 * more than five minutes apart from that, also when it was recorded: "09:42 · recorded 10:15" (the
 * recording day is added when it differs). Same rule as `TimelineItem.timeLabel`, formatted here with the
 * page's time display. Pure; safe in server components.
 */

export const RECORDED_GAP_MINUTES = 5;

export interface TimelineTime {
  /** "09:42", or "Oct 14, 09:42" when the timeline spans several days. */
  main: string;
  /** Recording time when it differs by more than five minutes, else null. */
  recorded: string | null;
  /** Full description for the `title` attribute: "Oct 14, 2026, 09:42 UTC−5 · recorded Oct 14, 2026, 10:15". */
  full: string;
}

export function timelineTime(item: Pick<TimelineItem, "at" | "recordedAt">, display: TimeDisplay, withDay = false): TimelineTime {
  const main = withDay ? formatDateTime(item.at, display) : formatTime(item.at, display);
  const gap = differsByMoreThan(item.at, item.recordedAt, RECORDED_GAP_MINUTES);
  const sameDay = displayDay(item.at, display) === displayDay(item.recordedAt, display);
  const recorded = gap ? (sameDay && !withDay ? formatTime(item.recordedAt, display) : formatDateTime(item.recordedAt, display)) : null;
  const zone = zoneLabel(display, item.at);
  const full = `${formatDateTime(item.at, display, { year: true })} ${zone}${gap ? ` · recorded ${formatDateTime(item.recordedAt, display, { year: true })}` : ""}`;
  return { main, recorded, full };
}

/** "09:42" or "09:42 · recorded 10:15". */
export function timelineTimeLabel(item: Pick<TimelineItem, "at" | "recordedAt">, display: TimeDisplay, withDay = false): string {
  const time = timelineTime(item, display, withDay);
  return time.recorded ? `${time.main} · recorded ${time.recorded}` : time.main;
}

/** True when the items happened on more than one day in this display, so times carry their day. */
export function spansSeveralDays(items: readonly Pick<TimelineItem, "at">[], display: TimeDisplay): boolean {
  const days = new Set<string>();
  for (const item of items) {
    try {
      days.add(displayDay(item.at, display));
    } catch {
      // A malformed time cannot place the item on a day; it never decides the format of the others.
    }
    if (days.size > 1) return true;
  }
  return false;
}
