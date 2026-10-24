import { plural } from "@/domain/format";
import type { TradeOrigin } from "@/domain/ledger";
import { addDays, formatDay, formatMonth, strategyDay, weekdayIndex } from "@/domain/time-display";

/**
 * Review periods (docs/V2_ARCHITECTURE.md §11.5, §14.10): calendar weeks (Monday–Sunday) and calendar months in the
 * fixed UTC−5 strategy clock, the same boundaries the periodic AI reviews use. Pure: labels, period lists and counts of
 * closed trades per period, so the pickers can say which periods have something to review.
 */

/** Periods listed in a picker at most (older ones stay reachable with the previous arrow). */
export const MAX_WEEK_OPTIONS = 52;
export const MAX_MONTH_OPTIONS = 24;

/** Monday (`YYYY-MM-DD`) of the strategy week containing `day`. */
export function mondayOf(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

/**
 * `Oct 12–18`, `Sep 28–Oct 4`; with the year (`Dec 22–28, 2025`) when the week ends in another year than
 * `currentYear`. Calendar days, so no time zone conversion applies.
 */
export function weekRange(start: string, currentYear?: string): string {
  const end = addDays(start, 6);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const range = `${formatDay(start)}–${sameMonth ? Number(end.slice(8, 10)) : formatDay(end)}`;
  return currentYear !== undefined && end.slice(0, 4) !== currentYear ? `${range}, ${end.slice(0, 4)}` : range;
}

/** `Week of Oct 12–18`: the wording the periodic AI review uses for its scope. */
export function weekTitle(start: string): string {
  return `Week of ${weekRange(start)}`;
}

/** `September 2026`. */
export function monthTitle(month: string): string {
  return formatMonth(month);
}

/** `YYYY-MM` shifted by whole months. */
export function addMonths(month: string, months: number): string {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

/** Mondays from `latest` back to `earliest` (both inclusive), newest first, at most `max`. */
export function weeksBack(latest: string, earliest: string, max: number): string[] {
  const weeks: string[] = [];
  for (let week = latest; week >= earliest && weeks.length < max; week = addDays(week, -7)) weeks.push(week);
  return weeks;
}

/** Months from `latest` back to `earliest` (both inclusive), newest first, at most `max`. */
export function monthsBack(latest: string, earliest: string, max: number): string[] {
  const months: string[] = [];
  for (let month = latest; month >= earliest && months.length < max; month = addMonths(month, -1)) months.push(month);
  return months;
}

/** A closed trade as the period counts need it (`trade_ledger` row). */
export interface ClosedTrade {
  origin: TradeOrigin;
  exited_at: string;
}

/** Closed trades of one period: planned trades are what a periodic review covers; live-first and imported are not. */
export interface PeriodCounts {
  planned: number;
  liveFirst: number;
  imported: number;
}

export const EMPTY_COUNTS: PeriodCounts = Object.freeze({ planned: 0, liveFirst: 0, imported: 0 });

const COUNT_KEYS: Readonly<Record<TradeOrigin, keyof PeriodCounts>> = { PLANNED: "planned", LIVE_FIRST: "liveFirst", IMPORTED: "imported" };

/** Closed trades by origin. */
export function countOrigins(trades: readonly Pick<ClosedTrade, "origin">[]): PeriodCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const trade of trades) counts[COUNT_KEYS[trade.origin]] += 1;
  return counts;
}

function countBy(trades: readonly ClosedTrade[], keyOf: (day: string) => string): Map<string, PeriodCounts> {
  const counts = new Map<string, PeriodCounts>();
  for (const trade of trades) {
    const key = keyOf(strategyDay(trade.exited_at));
    const current = counts.get(key) ?? { ...EMPTY_COUNTS };
    current[COUNT_KEYS[trade.origin]] += 1;
    counts.set(key, current);
  }
  return counts;
}

/** Closed trades per strategy week (keyed by Monday), by exit time in fixed UTC−5. */
export function countByWeek(trades: readonly ClosedTrade[]): Map<string, PeriodCounts> {
  return countBy(trades, mondayOf);
}

/** Closed trades per strategy month (`YYYY-MM`), by exit time in fixed UTC−5. */
export function countByMonth(trades: readonly ClosedTrade[]): Map<string, PeriodCounts> {
  return countBy(trades, day => day.slice(0, 7));
}

export function countsFor(counts: ReadonlyMap<string, PeriodCounts>, key: string): PeriodCounts {
  return counts.get(key) ?? EMPTY_COUNTS;
}

/**
 * The closed planned trades a review covers, compact enough for a picker option: `5 trades`, `1 trade`. A period
 * without any says `nothing to review`, which stays true when it has live-first or imported trades.
 */
export function sampleText(planned: number): string {
  return planned > 0 ? plural(planned, "trade") : "nothing to review";
}

/** The same in full, where there is room: `5 planned trades`, `1 planned trade`, `nothing to review`. */
export function plannedSampleText(planned: number): string {
  return planned > 0 ? plural(planned, "planned trade") : "nothing to review";
}

/** A period that is still running, whose count can change: `3 planned trades so far`, `no planned trades so far`. */
export function plannedSoFarText(planned: number): string {
  return planned > 0 ? `${plural(planned, "planned trade")} so far` : "no planned trades so far";
}

export interface PeriodOption {
  value: string;
  label: string;
  href: string;
}

export interface PeriodStep {
  href: string;
  /** Accessible name, for example "Previous week, Oct 5–11". */
  label: string;
}

export interface PeriodPickerModel {
  /** Field label: "Week" or "Month". */
  label: string;
  value: string;
  /** Newest first; always includes the selected period. */
  options: PeriodOption[];
  previous: PeriodStep | null;
  next: PeriodStep | null;
}

export interface PickerInput {
  /** Selected period: a Monday or a `YYYY-MM` month. */
  selected: string;
  /** The newest completed period (the default). */
  lastCompleted: string;
  /** The oldest period worth listing: the one containing the account's creation. */
  earliest: string;
  /** Closed trades per period; null when they could not be read (the options then carry no count). */
  counts: ReadonlyMap<string, PeriodCounts> | null;
  /** Periods that already have a completed AI review. */
  reviewed: ReadonlySet<string>;
  /** `YYYY` of today (strategy clock), to add years only where they are needed. */
  currentYear: string;
  href: (period: string) => string;
}

/** `Oct 12–18 · 5 trades · reviewed`; an unfinished period says so instead of a count. */
function optionLabel(name: string, period: string, input: PickerInput): string {
  const parts = [name];
  if (period > input.lastCompleted) parts.push("not finished");
  else if (input.counts !== null) parts.push(sampleText(countsFor(input.counts, period).planned));
  if (input.reviewed.has(period)) parts.push("reviewed");
  return parts.join(" · ");
}

function withSelected(periods: string[], selected: string): string[] {
  return periods.includes(selected) ? periods : [...periods, selected].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Week picker: the last 52 completed weeks since the account started, with trade counts and review marks. */
export function weekPicker(input: PickerInput): PeriodPickerModel {
  const weeks = withSelected(weeksBack(input.lastCompleted, input.earliest, MAX_WEEK_OPTIONS), input.selected);
  const previous = addDays(input.selected, -7);
  const next = addDays(input.selected, 7);
  return {
    label: "Week",
    value: input.selected,
    options: weeks.map(week => ({ value: week, label: optionLabel(weekRange(week, input.currentYear), week, input), href: input.href(week) })),
    previous: input.selected > input.earliest ? { href: input.href(previous), label: `Previous week, ${weekRange(previous, input.currentYear)}` } : null,
    next: input.selected < input.lastCompleted ? { href: input.href(next), label: `Next week, ${weekRange(next, input.currentYear)}` } : null,
  };
}

/** Month picker: the last 24 completed months since the account started, with trade counts and review marks. */
export function monthPicker(input: PickerInput): PeriodPickerModel {
  const months = withSelected(monthsBack(input.lastCompleted, input.earliest, MAX_MONTH_OPTIONS), input.selected);
  const previous = addMonths(input.selected, -1);
  const next = addMonths(input.selected, 1);
  return {
    label: "Month",
    value: input.selected,
    options: months.map(month => ({ value: month, label: optionLabel(monthTitle(month), month, input), href: input.href(month) })),
    previous: input.selected > input.earliest ? { href: input.href(previous), label: `Previous month, ${monthTitle(previous)}` } : null,
    next: input.selected < input.lastCompleted ? { href: input.href(next), label: `Next month, ${monthTitle(next)}` } : null,
  };
}
