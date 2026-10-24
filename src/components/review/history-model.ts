import { addDays, displayDay, formatDay, formatTime, type TimeDisplay } from "@/domain/time-display";
import type { HistoryEntry } from "./history-data";

/**
 * Presentation of the AI history list (docs/V2_ARCHITECTURE.md §11.1, §14.10): entries grouped by day in the user's
 * time display ("Today", "Yesterday", "Wed, Oct 21"), each with the time it finished (or was requested, while it is
 * still running). Pure.
 */

export interface HistoryEntryView extends HistoryEntry {
  /** The instant shown: when the result was saved, else when it was requested. */
  at: string;
  /** `09:42` in the display; null when the stored time can't be read. */
  time: string | null;
}

export interface HistoryDayGroup {
  /** Unique key: the calendar day in the display (`YYYY-MM-DD`, or `unknown`), suffixed when a day repeats. */
  key: string;
  /** The calendar day, or null when the stored time can't be read. */
  day: string | null;
  label: string;
  entries: HistoryEntryView[];
}

function dayOf(at: string, display: TimeDisplay): string | null {
  try {
    return displayDay(at, display);
  } catch {
    return null;
  }
}

function timeOf(at: string, display: TimeDisplay): string | null {
  try {
    return formatTime(at, display);
  } catch {
    return null;
  }
}

/** "Today", "Yesterday", "Wed, Oct 21" (with the year outside the current one). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return formatDay(day, undefined, { weekday: true, year: day.slice(0, 4) !== today.slice(0, 4) });
}

/**
 * Consecutive entries of the same day share one group. Entries arrive newest first, so a day normally forms one group;
 * a request that finished after midnight never moves into a group out of order.
 */
export function groupByDay(entries: readonly HistoryEntry[], nowIso: string, display: TimeDisplay): HistoryDayGroup[] {
  const today = dayOf(nowIso, display) ?? "";
  const groups: HistoryDayGroup[] = [];
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const at = entry.completedAt ?? entry.requestedAt;
    const day = dayOf(at, display);
    const view: HistoryEntryView = { ...entry, at, time: timeOf(at, display) };
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.entries.push(view);
      continue;
    }
    const base = day ?? "unknown";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    groups.push({ key: count === 1 ? base : `${base}#${count}`, day, label: day ? dayLabel(day, today) : "Earlier", entries: [view] });
  }
  return groups;
}
