import type { EntryModel, TradeOrigin } from "@/domain/ledger";
import type { CalendarMode } from "@/domain/performance";
import type { Session } from "@/domain/session";
import { addDays, daysInMonth, isCalendarDay, strategyDay } from "@/domain/time-display";
import { ALL_ACCOUNTS_VALUE, type AccountContext } from "@/lib/account-context";
import { CALENDAR_MODES, parseMonth, shiftMonth } from "@/lib/performance-data";
import { accountFilterLabel, type FilterParams, parseTradeFilters, resolveAccountFilter, type TradeFilters } from "@/lib/trades-data";
import { CALENDAR_VIEW_PARAM, EDGE_PATH, edgeParams, RANGE_PRESETS, type RangePreset, withParams } from "./params";

/**
 * EDGE state from the page's search parameters (docs/V2_ARCHITECTURE.md §14.6). The filter row is a date range
 * (presets relative to the server's strategy day, or a custom range of exit days) plus model, session, origin and
 * instrument; the account comes from the shell's context, and in All Accounts a read-only account filter
 * (`accountFilter`, the Journal's) can narrow it to one account, archived ones included. Server only: it uses the
 * Journal's filter parser.
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
  /** Read-only account filter of All Accounts (an account id; shown by name, see `accountFilterChip`). */
  accountFilter?: string;
  /** Parameters that could not be read (named, never shown raw). */
  invalid: string[];
}

const DIMENSION_KEYS = ["closedFrom", "closedTo", "model", "session", "origin", "instrument", "accountFilter"];

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

/**
 * EDGE state from the page's search parameters; `now` is the server time the presets are relative to. With the
 * request's account `context`, the read-only account filter is resolved as the Journal resolves it
 * (`resolveAccountFilter`): it combines with All Accounts only, so in an account context a filter left in the URL (the
 * header selector keeps the other parameters) is dropped, and the counts, links and files of the page ignore it.
 */
export function parseEdgeQuery(params: FilterParams, now: string, context?: Pick<AccountContext, "accounts" | "selected">): EdgeQuery {
  const { filters: parsed, invalid: filterInvalid } = parseTradeFilters(params);
  const filters = context ? resolveAccountFilter(parsed, context).filters : parsed;
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
    ...(filters.accountFilter ? { accountFilter: filters.accountFilter } : {}),
    invalid: [...new Set(invalid)],
  };
}

/**
 * The ledger filters the statistics use: exit-day range plus the dimensions (closed trades only), and the read-only
 * account filter, which narrows an All Accounts read and leaves an account context as it is (`filteredScope`).
 */
export function edgeFilters(query: EdgeQuery): TradeFilters {
  return {
    ...(query.closedFrom ? { closedFrom: query.closedFrom } : {}),
    ...(query.closedTo ? { closedTo: query.closedTo } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.session ? { session: query.session } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.instrument ? { instrument: query.instrument } : {}),
    ...(query.accountFilter ? { accountFilter: query.accountFilter } : {}),
  };
}

/** Filters the user set (the date range counts when it is not "All time"). */
export function activeFilterCount(query: EdgeQuery): number {
  return [query.range !== "all", query.model, query.session, query.origin, query.instrument, query.accountFilter].filter(Boolean).length;
}

/** The filters without calendar navigation: the parameters the calendar's month and mode links extend. */
export function filterQuery(query: EdgeQuery): string {
  const params = edgeParams({ ...query, month: undefined, calendar: "NET_R", currency: undefined });
  if (query.accountFilter) params.set("accountFilter", query.accountFilter);
  return params.toString();
}

/** The read-only account filter as the filter row shows it: the account in words, the page without it, and its id for links. */
export interface AccountFilterChip {
  id: string;
  /** "Account: Personal 12K · archived" ("Account: not available" for an account the user cannot read). */
  label: string;
  /** This page without the account filter (the context stays All Accounts). */
  removeHref: string;
}

/**
 * The read-only account filter of All Accounts for the filter row, resolved against the user's accounts; null without
 * one, and in an account context, where it does not apply.
 */
export function accountFilterChip(query: EdgeQuery, context: Pick<AccountContext, "accounts" | "selected">): AccountFilterChip | null {
  const { state } = resolveAccountFilter({ accountFilter: query.accountFilter }, context);
  const label = accountFilterLabel(state);
  if (!query.accountFilter || label === null) return null;
  // Removed by name, so the way back never keeps the filter, whichever parameters `edgeParams` writes.
  const removeHref = withParams(edgeParams({ ...query, month: undefined }).toString(), { accountFilter: undefined });
  return { id: query.accountFilter, label, removeHref };
}

/** EDGE of one account's history from All Accounts (an archived account can't be the context, §9.2). */
export function edgeAccountHistoryHref(accountId: string): string {
  return `${EDGE_PATH}?${new URLSearchParams({ accountFilter: accountId, account: ALL_ACCOUNTS_VALUE }).toString()}`;
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
