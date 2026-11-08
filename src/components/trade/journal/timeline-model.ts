import { differsByMoreThan, displayDay, formatDateTime, formatTime, type TimeDisplay, zoneLabel } from "@/domain/time-display";
import type { TimelineItem } from "@/domain/timeline";

/**
 * Time rules of the trade timeline (docs/V2_ARCHITECTURE.md §5.4): an item shows when it happened
 * (`at`: user-reported entry and exit times, otherwise the server recording time) and, when it was recorded
 * more than five minutes apart from that, also when it was recorded: "09:42 · recorded 10:15". A recording
 * on another day dates both times ("Sep 15, 03:15 · recorded Oct 30, 20:34"), so the event's own day is never
 * read as the recording day. Same rule as `TimelineItem.timeLabel`, formatted here with the page's time
 * display. Pure; safe in server components.
 */

export const RECORDED_GAP_MINUTES = 5;

export interface TimelineTime {
  /** "09:42", or "Oct 14, 09:42" when the timeline spans several days or the item was recorded on another day. */
  main: string;
  /** Recording time when it differs by more than five minutes, else null; dated like `main`. */
  recorded: string | null;
  /** Full description for the `title` attribute: "Oct 14, 2026, 09:42 UTC−5 · recorded Oct 14, 2026, 10:15". */
  full: string;
}

/** Whether the item shows its recording time: recorded more than five minutes apart from when it happened. */
function showsRecording(item: Pick<TimelineItem, "at" | "recordedAt">): boolean {
  return differsByMoreThan(item.at, item.recordedAt, RECORDED_GAP_MINUTES);
}

export function timelineTime(item: Pick<TimelineItem, "at" | "recordedAt">, display: TimeDisplay, withDay = false): TimelineTime {
  const gap = showsRecording(item);
  // Both times carry their day when the recording shown fell on another day than the event.
  const dated = withDay || (gap && displayDay(item.at, display) !== displayDay(item.recordedAt, display));
  const format = dated ? formatDateTime : formatTime;
  const zone = zoneLabel(display, item.at);
  const full = `${formatDateTime(item.at, display, { year: true })} ${zone}${gap ? ` · recorded ${formatDateTime(item.recordedAt, display, { year: true })}` : ""}`;
  return { main: format(item.at, display), recorded: gap ? format(item.recordedAt, display) : null, full };
}

/**
 * True when the times the timeline shows fall on more than one day in this display, so every time carries its day:
 * when the items happened, and when they were recorded wherever that is shown (more than five minutes later).
 */
export function spansSeveralDays(items: readonly (Pick<TimelineItem, "at"> & Partial<Pick<TimelineItem, "recordedAt">>)[], display: TimeDisplay): boolean {
  const days = new Set<string>();
  for (const item of items) {
    try {
      days.add(displayDay(item.at, display));
      if (item.recordedAt !== undefined && showsRecording({ at: item.at, recordedAt: item.recordedAt })) days.add(displayDay(item.recordedAt, display));
    } catch {
      // A malformed time cannot place the item on a day; it never decides the format of the others.
    }
    if (days.size > 1) return true;
  }
  return false;
}
