import type { EntryModel, TradeOrigin } from "@/domain/ledger";
import type { CalendarMode } from "@/domain/performance";
import type { Session } from "@/domain/session";
import { addDays, daysInMonth, isCalendarDay, strategyDay } from "@/domain/time-display";
import { CALENDAR_MODES, parseMonth, shiftMonth } from "@/lib/performance-data";
import { type FilterParams, parseTradeFilters, type TradeFilters } from "@/lib/trades-data";
import { CALENDAR_VIEW_PARAM, edgeParams, RANGE_PRESETS, type RangePreset } from "./params";

/**
 * EDGE state from the page's search parameters (docs/V2_ARCHITECTURE.md §14.6). The filter row is a date range
 * (presets relative to the server's strategy day, or a custom range of exit days) plus model, session, origin and
 * instrument; the account comes from the shell's context. Server only: it uses the Journal's filter parser.
 */

export { RANGE_LABELS } from "./params";

export interface EdgeQuery {
  range: RangePreset;
  /** Effective exit-day bounds (strategy days, inclusive), from the preset or the custom range. */
  closedFrom?: string;
  closedTo?: string;
  model?: EntryModel;
  session?: Session;
  origin?: TradeOrigin;
  instrument?: string;
  /** Calendar month asked for in the URL (`YYYY-MM`); the page picks a default when absent. */
  month?: string;
  /** Calendar day whose trades open in the day sheet (a shareable link to one day). */
  day?: string;
  calendar: CalendarMode;
  /** Currency of the money calendar modes when trades span several currencies. */
  currency?: string;
  /** Parameters that could not be read (named, never shown raw). */
  invalid: string[];
}

const DIMENSION_KEYS = ["closedFrom", "closedTo", "model", "session", "origin", "instrument"];

function readOne(params: FilterParams, key: string): string | undefined {
  const values = params instanceof URLSearchParams ? params.getAll(key) : [params[key]].flat();
  const text = values.filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean);
  return text.length ? text[text.length - 1] : undefined;
}

/** Exit-day bounds of a preset relative to `today` (strategy day). */
export function presetBounds(range: RangePreset, today: string): { closedFrom?: string; closedTo?: string } {
  switch (range) {
    case "30d": return { closedFrom: addDays(today, -29), closedTo: today };
    case "90d": return { closedFrom: addDays(today, -89), closedTo: today };
    case "month": return { closedFrom: `${today.slice(0, 7)}-01`, closedTo: today };
    case "last-month": {
      const month = shiftMonth(today.slice(0, 7), -1);
      return { closedFrom: `${month}-01`, closedTo: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
    }
    case "ytd": return { closedFrom: `${today.slice(0, 4)}-01-01`, closedTo: today };
    case "all":
    case "custom":
      return {};
  }
}

/** EDGE state from the page's search parameters; `now` is the server time the presets are relative to. */
export function parseEdgeQuery(params: FilterParams, now: string): EdgeQuery {
  const { filters, invalid: filterInvalid } = parseTradeFilters(params);
  const invalid = filterInvalid.filter(key => DIMENSION_KEYS.includes(key));
  const rawRange = readOne(params, "range")?.toLowerCase();
  const presetRange = RANGE_PRESETS.find(preset => preset === rawRange);
  if (rawRange !== undefined && presetRange === undefined) invalid.push("range");
  const hasCustomBounds = filters.closedFrom !== undefined || filters.closedTo !== undefined;
  const range: RangePreset = presetRange ?? (hasCustomBounds ? "custom" : "all");
  let bounds: { closedFrom?: string; closedTo?: string };
  if (range === "custom") {
    // An inverted range is read the way it was meant.
    const [from, to] = filters.closedFrom && filters.closedTo && filters.closedFrom > filters.closedTo
      ? [filters.closedTo, filters.closedFrom]
      : [filters.closedFrom, filters.closedTo];
    bounds = { ...(from ? { closedFrom: from } : {}), ...(to ? { closedTo: to } : {}) };
  } else {
    bounds = presetBounds(range, strategyDay(now));
  }
  const rawDay = readOne(params, "day");
  const day = rawDay !== undefined && isCalendarDay(rawDay) ? rawDay : undefined;
  if (rawDay !== undefined && day === undefined) invalid.push("day");
  const rawMonth = readOne(params, "month");
  const month = rawMonth === undefined ? day?.slice(0, 7) : parseMonth(rawMonth, "");
  if (rawMonth !== undefined && !month) invalid.push("month");
  const rawView = readOne(params, "view")?.toLowerCase();
  const calendar = CALENDAR_MODES.find(mode => CALENDAR_VIEW_PARAM[mode] === rawView);
  if (rawView !== undefined && calendar === undefined) invalid.push("view");
  const rawCurrency = readOne(params, "currency")?.toUpperCase();
  const currency = rawCurrency !== undefined && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : undefined;
  if (rawCurrency !== undefined && currency === undefined) invalid.push("currency");
  return {
    range,
    ...bounds,
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.session ? { session: filters.session } : {}),
    ...(filters.origin ? { origin: filters.origin } : {}),
    ...(filters.instrument ? { instrument: filters.instrument } : {}),
    ...(month ? { month } : {}),
    ...(day ? { day } : {}),
    calendar: calendar ?? "NET_R",
    ...(currency ? { currency } : {}),
    invalid: [...new Set(invalid)],
  };
}

/** The ledger filters the statistics use: exit-day range plus the dimensions (closed trades only). */
export function edgeFilters(query: EdgeQuery): TradeFilters {
  return {
    ...(query.closedFrom ? { closedFrom: query.closedFrom } : {}),
    ...(query.closedTo ? { closedTo: query.closedTo } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.session ? { session: query.session } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.instrument ? { instrument: query.instrument } : {}),
  };
}

/** Filters the user set (the date range counts when it is not "All time"). */
export function activeFilterCount(query: EdgeQuery): number {
  return [query.range !== "all", query.model, query.session, query.origin, query.instrument].filter(Boolean).length;
}

/** The filters without calendar navigation: the parameters the calendar's month and mode links extend. */
export function filterQuery(query: EdgeQuery): string {
  return edgeParams({ ...query, month: undefined, calendar: "NET_R", currency: undefined }).toString();
}

/**
 * The legacy CSV (`GET /edge/export`, V1 parameters): closed planned trades of one account with a locked plan,
 * filtered by exit day, model, session and instrument. Origin has no V1 equivalent (the file never contains
 * live-first trades), and the V1 name of the Asia session is ASIAN_RANGE.
 */
export function exportHref(query: EdgeQuery, accountId: string): string {
  const params = new URLSearchParams({ account: accountId });
  if (query.closedFrom) params.set("from", query.closedFrom);
  if (query.closedTo) params.set("to", query.closedTo);
  if (query.model) params.set("model", query.model);
  if (query.session) params.set("session", query.session === "ASIA" ? "ASIAN_RANGE" : query.session);
  if (query.instrument) params.set("instrument", query.instrument);
  return `/edge/export?${params.toString()}`;
}
