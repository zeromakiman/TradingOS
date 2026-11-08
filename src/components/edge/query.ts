import { RESULT_LABELS } from "@/components/journal/labels";
import type { EntryModel, TradeOrigin } from "@/domain/ledger";
import type { CalendarMode } from "@/domain/performance";
import type { Session } from "@/domain/session";
import { addDays, daysInMonth, isCalendarDay, strategyDay } from "@/domain/time-display";
import { ALL_ACCOUNTS_VALUE, type AccountContext } from "@/lib/account-context";
import { CALENDAR_MODES, parseMonth, shiftMonth } from "@/lib/performance-data";
import { accountFilterLabel, type FilterParams, parseTradeFilters, resolveAccountFilter, type TradeFilters, type WeekdayName } from "@/lib/trades-data";
import { CALENDAR_VIEW_PARAM, EDGE_PATH, edgeParams, RANGE_PRESETS, type RangePreset, withParams } from "./params";

/**
 * EDGE state from the page's search parameters (docs/V2_ARCHITECTURE.md §1.2, §14.6). The filter row is a date range
 * (presets relative to the server's strategy day, or a custom range of exit days) plus model, session, origin and
 * instrument; the account comes from the shell's context, and in All Accounts a read-only account filter
 * (`accountFilter`, the Journal's) can narrow it to one account, archived ones included. A link can also carry filters
 * the row has no control for (entry weekday, strategy version, risk-plan version, result): they apply, show as
 * removable chips in words (`linkFilterChips`) and travel with every link of the page. Server only: it uses the
 * Journal's filter parser.
 *
 * V1 EDGE links (bc5441c `/edge`) keep their V1 meaning: `from` and `to` are exit days (V1 dated a closed trade by its
 * exit), `period=month` is this strategy month, `strategy` a strategy version, `risk` a risk-plan version (the
 * Journal's `risk` is a risk percent, so EDGE reads it here), `outcome` a result, `weekday` the entry weekday, and the
 * session `ASIAN_RANGE` is Asia. Every filter narrows (exit-day bounds intersect). Two V1 options have no EDGE
 * equivalent a drill-down link could carry, `period=last30` (the last 30 closed trades) and `session=OTHER` (trades
 * without a recorded entry time): the page states that it does not apply them (`unappliedNotice`). The legacy CSV
 * (src/app/edge/export/contract.ts) reads its request with this parser too, so the page and the file of one link
 * select the same trades; only the file applies those two options, as V1's file did.
 */

export { RANGE_LABELS } from "./params";

/** Results of closed trades (EDGE measures closed trades only). */
export const CLOSED_RESULTS = ["WIN", "LOSS", "BREAKEVEN"] as const;
export type ClosedResult = (typeof CLOSED_RESULTS)[number];

/** V1 `period=last30`: the last 30 closed trades in exit order, after every other filter. */
export const LEGACY_LAST_CLOSED = 30;

export interface EdgeQuery {
  range: RangePreset;
  /** Effective exit-day bounds (strategy days, inclusive), from the preset or the custom range. */
  closedFrom?: string;
  closedTo?: string;
  model?: EntryModel;
  session?: Session;
  origin?: TradeOrigin;
  instrument?: string;
  /** Entry weekday: a filter a link carries (V1 `weekday`), without a control in the filter row. */
  weekday?: WeekdayName;
  /** Strategy version id: a filter a link carries (`strategy`, as in V1). */
  strategyVersionId?: string;
  /** Risk-plan version id: a filter a link carries (`riskPlan`, the Journal's name, or V1 `risk`). */
  riskPlanVersionId?: string;
  /** Result of the closed trades: a filter a link carries (`result`, the Journal's name, or V1 `outcome`). */
  result?: ClosedResult;
  /** Calendar month asked for in the URL (`YYYY-MM`); the page picks a default when absent. */
  month?: string;
  /** Calendar day whose trades open in the day sheet (a shareable link to one day). */
  day?: string;
  calendar: CalendarMode;
  /** Currency of the money calendar modes when trades span several currencies. */
  currency?: string;
  /** Read-only account filter of All Accounts (an account id; shown by name, see `accountFilterChip`). */
  accountFilter?: string;
  /**
   * V1 `period=last30` (the last N closed trades, after every other filter): an option of an older link that the page
   * does not apply (no drill-down link could carry it), and says so (`unappliedNotice`). The legacy CSV applies it.
   */
  lastClosed?: number;
  /** V1 `session=OTHER` (trades without a recorded entry time): not applied by the page either; the CSV applies it. */
  withoutEntryTime?: boolean;
  /** Parameters that could not be read (named, never shown raw). */
  invalid: string[];
}

/** Parameters EDGE reads with the Journal's parser: an unreadable one is named. */
const FILTER_KEYS: readonly string[] = [
  "closedFrom", "closedTo", "model", "session", "origin", "instrument", "accountFilter", "weekday", "strategy", "riskPlan", "result", "outcome",
];
/**
 * V1 parameters the Journal's parser would misread (it reads `from`/`to` as trade dates and `risk` as a risk percent):
 * read here with their V1 meanings instead.
 */
const V1_KEYS: readonly string[] = ["from", "to", "period", "risk"];
/** The order unreadable parameters are named in (the CSV's refusal lists them so). */
const INVALID_ORDER: readonly string[] = [
  "range", "closedFrom", "closedTo", "model", "session", "origin", "instrument", "accountFilter", "from", "to", "period", "weekday", "strategy", "riskPlan",
  "risk", "result", "outcome", "month", "day", "view", "currency",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DayBounds = { closedFrom?: string; closedTo?: string };

function readOne(params: FilterParams, key: string): string | undefined {
  const values = params instanceof URLSearchParams ? params.getAll(key) : [params[key]].flat();
  const text = values.filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean);
  return text.length ? text[text.length - 1] : undefined;
}

function copyParams(params: FilterParams): URLSearchParams {
  if (params instanceof URLSearchParams) return new URLSearchParams(params);
  const copy = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") copy.append(key, value);
    else if (value) for (const item of value) copy.append(key, item);
  }
  return copy;
}

/** Exit-day bounds of a preset relative to `today` (strategy day). */
export function presetBounds(range: RangePreset, today: string): DayBounds {
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

/** Bounds intersect: the later start and the earlier end. */
function intersect(a: DayBounds, b: DayBounds): DayBounds {
  const closedFrom = a.closedFrom !== undefined && b.closedFrom !== undefined ? (a.closedFrom > b.closedFrom ? a.closedFrom : b.closedFrom) : (a.closedFrom ?? b.closedFrom);
  const closedTo = a.closedTo !== undefined && b.closedTo !== undefined ? (a.closedTo < b.closedTo ? a.closedTo : b.closedTo) : (a.closedTo ?? b.closedTo);
  return { ...(closedFrom ? { closedFrom } : {}), ...(closedTo ? { closedTo } : {}) };
}

interface LegacyDates {
  /** Exit-day bounds of V1 `from`, `to` and `period=month`, intersected; null without any of them. */
  bounds: DayBounds | null;
  /** `period=month` alone: EDGE's "This month". */
  thisMonth: boolean;
  /** The V1 parameters behind `bounds`. */
  keys: string[];
  lastClosed?: number;
}

/** V1 date filters: `from`/`to` (exit days: V1 dated closed trades by their exit) and `period` (`month` | `last30`). */
function legacyDates(params: FilterParams, today: string, invalid: string[]): LegacyDates {
  const day = (key: "from" | "to") => {
    const value = readOne(params, key);
    if (value === undefined) return undefined;
    if (isCalendarDay(value)) return value;
    invalid.push(key);
    return undefined;
  };
  let from = day("from");
  let to = day("to");
  // An inverted V1 range is read the way it was meant, like EDGE's own custom range (the CSV refuses it, as V1 did).
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];
  const period = readOne(params, "period")?.toLowerCase();
  if (period !== undefined && period !== "month" && period !== "last30") invalid.push("period");
  let bounds: DayBounds | null = from || to ? { ...(from ? { closedFrom: from } : {}), ...(to ? { closedTo: to } : {}) } : null;
  if (period === "month") bounds = intersect(bounds ?? {}, presetBounds("month", today));
  return {
    bounds,
    thisMonth: period === "month" && !from && !to,
    keys: [...(from ? ["from"] : []), ...(to ? ["to"] : []), ...(period === "month" ? ["period"] : [])],
    ...(period === "last30" ? { lastClosed: LEGACY_LAST_CLOSED } : {}),
  };
}

function orderInvalid(keys: readonly string[]): string[] {
  const rank = (key: string) => {
    const index = INVALID_ORDER.indexOf(key);
    return index === -1 ? INVALID_ORDER.length : index;
  };
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b));
}

/**
 * EDGE state from the page's search parameters; `now` is the server time the presets are relative to. With the
 * request's account `context`, the read-only account filter is resolved as the Journal resolves it
 * (`resolveAccountFilter`): it combines with All Accounts only, so in an account context a filter left in the URL (the
 * header selector keeps the other parameters) is dropped, and the counts, links and files of the page ignore it.
 */
export function parseEdgeQuery(params: FilterParams, now: string, context?: Pick<AccountContext, "accounts" | "selected">): EdgeQuery {
  const today = strategyDay(now);
  const invalid: string[] = [];
  // The Journal's parser reads the filters EDGE shares with it; the V1 names it would misread are read below instead,
  // and the V1 session names are translated first.
  const shared = copyParams(params);
  for (const key of V1_KEYS) shared.delete(key);
  const v1Session = readOne(params, "session")?.toUpperCase().replace(/-/g, "_");
  let withoutEntryTime = false;
  if (v1Session === "ASIAN_RANGE") shared.set("session", "ASIA");
  else if (v1Session === "OTHER") {
    shared.delete("session");
    withoutEntryTime = true;
  }
  const { filters: parsed, invalid: filterInvalid } = parseTradeFilters(shared);
  const filters = context ? resolveAccountFilter(parsed, context).filters : parsed;
  invalid.push(...filterInvalid.filter(key => FILTER_KEYS.includes(key)));
  // EDGE measures closed trades only: a result filter for live trades would select nothing.
  const result = filters.result === "OPEN" ? undefined : filters.result;
  if (filters.result === "OPEN") invalid.push("result");
  // V1 `risk` names a risk-plan version; the Journal's `riskPlan` wins when a link carries both.
  let riskPlanVersionId = filters.riskPlanVersionId;
  const v1Risk = readOne(params, "risk")?.toLowerCase();
  if (v1Risk !== undefined && !UUID.test(v1Risk)) invalid.push("risk");
  else if (v1Risk !== undefined && readOne(params, "riskPlan") === undefined) riskPlanVersionId = v1Risk;

  const rawRange = readOne(params, "range")?.toLowerCase();
  const presetRange = RANGE_PRESETS.find(preset => preset === rawRange);
  if (rawRange !== undefined && presetRange === undefined) invalid.push("range");
  const hasCustomBounds = filters.closedFrom !== undefined || filters.closedTo !== undefined;
  let range: RangePreset = presetRange ?? (hasCustomBounds ? "custom" : "all");
  let bounds: DayBounds;
  if (range === "custom") {
    // An inverted range is read the way it was meant.
    const [from, to] = filters.closedFrom && filters.closedTo && filters.closedFrom > filters.closedTo
      ? [filters.closedTo, filters.closedFrom]
      : [filters.closedFrom, filters.closedTo];
    bounds = { ...(from ? { closedFrom: from } : {}), ...(to ? { closedTo: to } : {}) };
  } else {
    bounds = presetBounds(range, today);
  }
  // V1 date filters narrow the range (every filter narrows: bounds intersect).
  const legacy = legacyDates(params, today, invalid);
  if (legacy.bounds) {
    const narrowed = intersect(bounds, legacy.bounds);
    if (narrowed.closedFrom !== undefined && narrowed.closedTo !== undefined && narrowed.closedFrom > narrowed.closedTo) {
      // They exclude every day of the link's own range: contradictory, so named and ignored (the CSV refuses them).
      invalid.push(...legacy.keys);
    } else if (legacy.thisMonth && (range === "all" || range === "month")) {
      range = "month";
      bounds = presetBounds("month", today);
    } else if (narrowed.closedFrom !== bounds.closedFrom || narrowed.closedTo !== bounds.closedTo) {
      range = "custom";
      bounds = narrowed;
    }
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
    ...(filters.weekday ? { weekday: filters.weekday } : {}),
    ...(filters.strategyVersionId ? { strategyVersionId: filters.strategyVersionId } : {}),
    ...(riskPlanVersionId ? { riskPlanVersionId } : {}),
    ...(result ? { result } : {}),
    ...(month ? { month } : {}),
    ...(day ? { day } : {}),
    calendar: calendar ?? "NET_R",
    ...(currency ? { currency } : {}),
    ...(filters.accountFilter ? { accountFilter: filters.accountFilter } : {}),
    ...(legacy.lastClosed ? { lastClosed: legacy.lastClosed } : {}),
    ...(withoutEntryTime ? { withoutEntryTime } : {}),
    invalid: orderInvalid(invalid),
  };
}

/**
 * The ledger filters the statistics use: exit-day range plus the dimensions (closed trades only), the filters a link
 * carries, and the read-only account filter, which narrows an All Accounts read and leaves an account context as it is
 * (`filteredScope`).
 */
export function edgeFilters(query: EdgeQuery): TradeFilters {
  return {
    ...(query.closedFrom ? { closedFrom: query.closedFrom } : {}),
    ...(query.closedTo ? { closedTo: query.closedTo } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.session ? { session: query.session } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
    ...(query.instrument ? { instrument: query.instrument } : {}),
    ...(query.weekday ? { weekday: query.weekday } : {}),
    ...(query.strategyVersionId ? { strategyVersionId: query.strategyVersionId } : {}),
    ...(query.riskPlanVersionId ? { riskPlanVersionId: query.riskPlanVersionId } : {}),
    ...(query.result ? { result: query.result } : {}),
    ...(query.accountFilter ? { accountFilter: query.accountFilter } : {}),
  };
}

/** The filters a link carries beyond the filter row's controls (they show as chips; see `linkFilterChips`). */
export function linkFilterCount(query: Pick<EdgeQuery, "weekday" | "strategyVersionId" | "riskPlanVersionId" | "result">): number {
  return [query.weekday, query.strategyVersionId, query.riskPlanVersionId, query.result].filter(Boolean).length;
}

/** Filters the user set (the date range counts when it is not "All time"). */
export function activeFilterCount(query: EdgeQuery): number {
  return [query.range !== "all", query.model, query.session, query.origin, query.instrument, query.accountFilter].filter(Boolean).length + linkFilterCount(query);
}

/** The filters without calendar navigation: the parameters the calendar's month and mode links extend. */
export function filterQuery(query: EdgeQuery): string {
  const params = edgeParams({ ...query, month: undefined, calendar: "NET_R", currency: undefined });
  if (query.accountFilter) params.set("accountFilter", query.accountFilter);
  return params.toString();
}

/** A filter shown as a chip in words: the page without it is the way to remove it. */
export interface EdgeFilterChip {
  key: string;
  label: string;
  removeHref: string;
}

/** Names of the versions a link filters by (never shown as ids); null when no trade read carries the name. */
export interface EdgeVersionNames {
  strategy: string | null;
  riskPlan: string | null;
}

/**
 * The filters a link carries that the filter row has no control for (entry weekday, strategy version, risk-plan
 * version, result), in the Journal's words, each with this page without it (calendar mode kept, month dropped).
 */
export function linkFilterChips(query: EdgeQuery, names: EdgeVersionNames): EdgeFilterChip[] {
  const base = edgeParams({ ...query, month: undefined }).toString();
  // Removed by name, so the way back never keeps the filter, whichever parameters `edgeParams` writes.
  const without = (param: string) => withParams(base, { [param]: undefined });
  const chips: EdgeFilterChip[] = [];
  if (query.weekday) chips.push({ key: "weekday", label: `Entry weekday: ${query.weekday}`, removeHref: without("weekday") });
  if (query.strategyVersionId) chips.push({ key: "strategy", label: `Strategy: ${names.strategy ?? "selected version"}`, removeHref: without("strategy") });
  if (query.riskPlanVersionId) {
    const name = names.riskPlan;
    const label = name ? (/^risk plan/i.test(name) ? name : `Risk plan ${name}`) : "Risk plan: selected version";
    chips.push({ key: "risk-plan", label, removeHref: without("riskPlan") });
  }
  if (query.result) chips.push({ key: "result", label: `Result: ${RESULT_LABELS[query.result]}`, removeHref: without("result") });
  return chips;
}

/** What the page says about the V1 options it does not apply (`lastClosed`, `withoutEntryTime`); null without any. */
export function unappliedNotice(query: Pick<EdgeQuery, "lastClosed" | "withoutEntryTime">): string | null {
  const window = query.lastClosed ? `“last ${query.lastClosed} completed trades” window` : null;
  const session = query.withoutEntryTime ? "“no recorded entry time” session" : null;
  if (window && session) {
    return `This link's ${window} and ${session} aren't available in EDGE: the statistics include every closed trade that matches the other filters.`;
  }
  if (window) return `This link's ${window} isn't available in EDGE: the statistics include every closed trade that matches the other filters.`;
  if (session) return `This link's ${session} isn't available in EDGE: the statistics include trades of every session.`;
  return null;
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
