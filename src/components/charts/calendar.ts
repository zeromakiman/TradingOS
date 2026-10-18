import { daysInMonth, formatDay, formatMonth, WEEKDAY_NAMES, weekdayIndex } from "@/domain/time-display";

/** Calendar layout on strategy days (`YYYY-MM-DD`); labels come from the domain formatters. */

export type CalendarSlot = { date: string; day: number } | null;

/** Monday-first column headers. */
export const WEEKDAYS = WEEKDAY_NAMES.map((name) => ({ short: name.slice(0, 3), long: name }));

/** Monday-first weeks of a month ("2026-10"); days outside the month are null. Throws on an invalid month. */
export function monthWeeks(month: string): CalendarSlot[][] {
  const length = daysInMonth(month);
  const leading = weekdayIndex(`${month}-01`);
  const slots: CalendarSlot[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length }, (_, offset) => ({ date: `${month}-${String(offset + 1).padStart(2, "0")}`, day: offset + 1 })),
  ];
  while (slots.length % 7 !== 0) slots.push(null);
  return Array.from({ length: slots.length / 7 }, (_, week) => slots.slice(week * 7, week * 7 + 7));
}

/** "October 2026". */
export const monthLabel = (month: string) => formatMonth(month);

/** "Oct 14". */
export const shortDayLabel = (day: string) => formatDay(day);

/** "Wed, Oct 14". */
export const longDayLabel = (day: string) => formatDay(day, undefined, { weekday: true });
