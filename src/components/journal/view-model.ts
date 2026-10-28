import Decimal from "decimal.js";
import { formatPercent, formatR, formatSignedMoney, plural } from "@/domain/format";
import { ENTRY_MODELS, LIFECYCLES, type Lifecycle, TRADE_ORIGINS } from "@/domain/ledger";
import {
  addDays, displayDay, formatDateTime, formatDay, formatTime, STRATEGY_ZONE_LABEL, strategyDay, type TimeDisplay, zoneLabel,
} from "@/domain/time-display";
import {
  type AccountFilterState, accountFilterLabel, decodeTradeCursor, JOURNAL_PAGE_SIZE, journalHref, SESSIONS, TRADE_DATE_DEFINITION, TRADE_RESULTS,
  type TradeCounts, type TradeFilters, type TradeListPage, type TradeListRow, tradeFilterParams,
} from "@/lib/trades-data";
import {
  DIRECTION_LABELS, dateSourceVerb, FILTER_PARAM_NAMES, MODEL_LABELS, ORIGIN_LABELS, pillTone, RESULT_LABELS, SESSION_LABELS, STATE_LABELS,
  STATE_SHORT_LABELS,
} from "./labels";
import { INSTRUMENT_FORMAT, INSTRUMENT_PATTERN, TAG_FORMAT, TAG_PATTERN } from "./patterns";
import type {
  ChipView, DatePreset, EmptyView, FilterMenuView, FilterOptionView, FiltersView, HiddenField, JournalView, PaginationView, SheetChoiceGroup, SheetView,
  TradeGroupView, TradeRowView, ValueView,
} from "./types";

/**
 * Builds the Journal view model (docs/V2_ARCHITECTURE.md §14.5, §9.2, §13.7, §13.8, §15) from the parsed URL filters, the
 * account context and one page of `listTrades`. Pure: no I/O, no clock (server time is passed in), every link a finished
 * URL built with `journalHref`/`tradeFilterParams`, so the URL contract has a single owner (src/lib/trades-data.ts).
 */

export const JOURNAL_PATH = "/journal";
/** Pages remembered for "Newer" links (keyset pagination cannot step backwards on its own). */
export const MAX_TRAIL = 40;
/** The first page in a trail (it has no cursor). */
export const FIRST_PAGE_TOKEN = "0";
const VISIBLE_TAGS = 2;
const SUGGESTION_LIMIT = 12;

export interface JournalContext {
  mode: "all" | "account";
  /** Name of the selected account (account mode). */
  accountName: string | null;
  /** The user has at least one trading account. */
  hasAccounts: boolean;
}

export interface JournalInput {
  filters: TradeFilters;
  /** URL keys `parseTradeFilters` could not read. */
  invalid: readonly string[];
  context: JournalContext;
  /** The read-only account filter of All Accounts, resolved against the user's accounts (`resolveAccountFilter`). */
  accountFilter?: AccountFilterState;
  display: TimeDisplay;
  /** Server time of the request. */
  now: string;
  /** The loaded page; null when nothing was loaded (no accounts, or an impossible date range). */
  page: TradeListPage | null;
  /** The first trade of the next page has the same trade date as the last trade of this one (see `trimToPage`). */
  lastDayContinues: boolean;
  /**
   * Exact counts of a list that spans pages: every trade it holds, and each trade day the page shares with another page
   * (`journalCounts`); null for a single page, or when the counts could not be read (the copy then states no total).
   */
  counts?: TradeCounts | null;
  /** Validated cursor of this page (null on the first page). */
  cursor: string | null;
  /** Validated cursors of the previous pages, oldest first (`FIRST_PAGE_TOKEN` for page 1). */
  trail: readonly string[];
  /** Names for the version filters of drill-down links (never the ids). */
  versionNames: { strategy: string | null; riskPlan: string | null };
}

type FilterKey = keyof TradeFilters;

const NO_ACCOUNT_FILTER: AccountFilterState = Object.freeze({ kind: "none" });

function omit(filters: TradeFilters, ...keys: FilterKey[]): TradeFilters {
  const copy: TradeFilters = { ...filters };
  for (const key of keys) delete copy[key];
  return copy;
}

const href = (filters: TradeFilters) => journalHref(filters);

function hiddenFields(filters: TradeFilters): HiddenField[] {
  return [...tradeFilterParams(filters).entries()].map(([name, value]) => ({ name, value }));
}

/** The canonical URL spelling of one filter value (`win`, `live-first`, `OB_FIRST_TOUCH`). */
function paramValue(filters: TradeFilters, key: string): string {
  return tradeFilterParams(filters).get(key) ?? "";
}

/** URL of a page of the list: the filters plus the keyset position and the trail back to the newest page. */
export function pageHref(filters: TradeFilters, cursor: string | null, trail: readonly string[]): string {
  const params = tradeFilterParams(filters);
  if (cursor) params.set("cursor", cursor);
  if (trail.length) params.set("back", trail.join(","));
  const query = params.toString();
  return query ? `${JOURNAL_PATH}?${query}` : JOURNAL_PATH;
}

// ---------------------------------------------------------------------------------------------------------
// Dates.
// ---------------------------------------------------------------------------------------------------------
export function datePresets(today: string): DatePreset[] {
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "yesterday", label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    { key: "7d", label: "Last 7 days", from: addDays(today, -6), to: today },
    { key: "30d", label: "Last 30 days", from: addDays(today, -29), to: today },
    { key: "month", label: "This month", from: monthStart, to: today },
    { key: "last-month", label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    { key: "year", label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
}

function dayText(day: string, today: string): string {
  return formatDay(day, undefined, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

/** "Oct 14", "Oct 1 – Oct 14", "Since Oct 1", "Until Oct 14". */
export function rangeText(from: string | undefined, to: string | undefined, today: string): string | null {
  if (from && to) return from === to ? dayText(from, today) : `${dayText(from, today)} – ${dayText(to, today)}`;
  if (from) return `Since ${dayText(from, today)}`;
  if (to) return `Until ${dayText(to, today)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Filter menus.
// ---------------------------------------------------------------------------------------------------------
interface SingleChoice<T extends string> {
  key: FilterMenuView["key"];
  label: string;
  anyLabel: string;
  values: readonly T[];
  labels: Record<T, string>;
  current: T | undefined;
  apply: (value: T) => TradeFilters;
  without: TradeFilters;
  hint?: string;
}

function singleMenu<T extends string>(choice: SingleChoice<T>): FilterMenuView {
  const active = choice.current !== undefined;
  const options: FilterOptionView[] = [
    { key: "any", label: choice.anyLabel, href: href(choice.without), selected: !active },
    ...choice.values.map(value => ({ key: value.toLowerCase(), label: choice.labels[value], href: href(choice.apply(value)), selected: choice.current === value })),
  ];
  return {
    key: choice.key, label: choice.label, activeLabel: active ? choice.labels[choice.current as T] : null, removeHref: active ? href(choice.without) : null,
    multiple: false, options, hint: choice.hint ?? null, form: null,
  };
}

function listLabel(values: readonly string[]): string {
  return values.length <= 2 ? values.join(", ") : `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

const REVIEW_LABELS = { YES: "Reviewed", NO: "Review pending" } as const;
const AI_LABELS = { YES: "AI-reviewed", NO: "Not AI-reviewed" } as const;
const flagKey = (value: boolean | undefined) => (value === undefined ? undefined : value ? ("YES" as const) : ("NO" as const));

/** Symbols and tags of the trades on this page, most frequent first (quick picks for the tag and instrument menus). */
function frequent(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

export function buildMenus(filters: TradeFilters, today: string, rows: readonly TradeListRow[]): FilterMenuView[] {
  const presets = datePresets(today);
  const withoutDates = omit(filters, "from", "to");
  const preset = presets.find(item => item.from === filters.from && item.to === filters.to);
  const dateActive = Boolean(filters.from || filters.to);
  const date: FilterMenuView = {
    key: "date",
    label: "Date",
    activeLabel: dateActive ? (preset?.label ?? rangeText(filters.from, filters.to, today)) : null,
    removeHref: dateActive ? href(withoutDates) : null,
    multiple: false,
    options: [
      { key: "any", label: "Any date", href: href(withoutDates), selected: !dateActive },
      ...presets.map(item => ({ key: item.key, label: item.label, href: href({ ...filters, from: item.from, to: item.to }), selected: preset?.key === item.key })),
    ],
    hint: "Trade date: entry, else plan lock, else when recorded (UTC−5 days).",
    form: { kind: "date", from: filters.from ?? "", to: filters.to ?? "", max: today, hidden: hiddenFields(withoutDates) },
  };

  const states = filters.states ?? [];
  const toggledStates = (state: Lifecycle) => (states.includes(state) ? states.filter(item => item !== state) : [...states, state]);
  const state: FilterMenuView = {
    key: "state",
    label: "State",
    activeLabel: states.length ? listLabel(LIFECYCLES.filter(item => states.includes(item)).map(item => STATE_SHORT_LABELS[item])) : null,
    removeHref: states.length ? href(omit(filters, "states")) : null,
    multiple: true,
    options: LIFECYCLES.map(item => {
      const next = toggledStates(item);
      return { key: item.toLowerCase(), label: STATE_LABELS[item], href: href(next.length ? { ...filters, states: next } : omit(filters, "states")), selected: states.includes(item) };
    }),
    hint: "Draft includes blocked, ready-to-lock and recheck-needed drafts.",
    form: null,
  };

  const tags = filters.tags ?? [];
  const pageTags = frequent(rows.flatMap(row => row.trade.tags)).filter(tag => !tags.includes(tag)).slice(0, SUGGESTION_LIMIT);
  const withoutTag = (tag: string) => {
    const rest = tags.filter(item => item !== tag);
    return rest.length ? { ...filters, tags: rest } : omit(filters, "tags");
  };
  const tagMenu: FilterMenuView = {
    key: "tags",
    label: "Tags",
    activeLabel: tags.length ? listLabel(tags) : null,
    removeHref: tags.length ? href(omit(filters, "tags")) : null,
    multiple: true,
    options: tags.map(tag => ({ key: `tag-${tag}`, label: tag, href: href(withoutTag(tag)), selected: true })),
    hint: tags.length > 1 ? "Trades must carry every selected tag." : null,
    form: {
      kind: "text", name: "tag", label: "Add a tag", placeholder: "e.g. news", submitLabel: "Add", pattern: TAG_PATTERN, format: TAG_FORMAT, maxLength: 32,
      hidden: hiddenFields(filters), suggestionsLabel: "Tags on this page",
      suggestions: pageTags.map(tag => ({ key: `suggest-${tag}`, label: tag, href: href({ ...filters, tags: [...tags, tag] }), selected: false })),
    },
  };

  const pageSymbols = frequent(rows.flatMap(row => (row.trade.symbol ? [row.trade.symbol] : []))).filter(symbol => symbol !== filters.instrument).slice(0, SUGGESTION_LIMIT);
  const withoutInstrument = omit(filters, "instrument");
  const instrument: FilterMenuView = {
    key: "instrument",
    label: "Instrument",
    activeLabel: filters.instrument ?? null,
    removeHref: filters.instrument ? href(withoutInstrument) : null,
    multiple: false,
    options: filters.instrument ? [{ key: "any", label: "Any instrument", href: href(withoutInstrument), selected: false }] : [],
    hint: null,
    form: {
      kind: "text", name: "instrument", label: "Symbol", placeholder: "e.g. EURUSD", submitLabel: "Apply", pattern: INSTRUMENT_PATTERN, format: INSTRUMENT_FORMAT,
      maxLength: 20, hidden: hiddenFields(withoutInstrument), suggestionsLabel: "Instruments on this page",
      suggestions: pageSymbols.map(symbol => ({ key: `suggest-${symbol}`, label: symbol, href: href({ ...filters, instrument: symbol }), selected: false })),
    },
  };

  return [
    date,
    singleMenu({
      key: "result", label: "Result", anyLabel: "Any result", values: TRADE_RESULTS, labels: RESULT_LABELS, current: filters.result,
      apply: value => ({ ...filters, result: value }), without: omit(filters, "result"), hint: "Open lists live trades.",
    }),
    state,
    singleMenu({
      key: "origin", label: "Origin", anyLabel: "Any origin", values: TRADE_ORIGINS, labels: ORIGIN_LABELS, current: filters.origin,
      apply: value => ({ ...filters, origin: value }), without: omit(filters, "origin"),
    }),
    singleMenu({
      key: "model", label: "Model", anyLabel: "Any model", values: ENTRY_MODELS, labels: MODEL_LABELS, current: filters.model,
      apply: value => ({ ...filters, model: value }), without: omit(filters, "model"),
    }),
    singleMenu({
      key: "session", label: "Session", anyLabel: "Any session", values: SESSIONS, labels: SESSION_LABELS, current: filters.session,
      apply: value => ({ ...filters, session: value }), without: omit(filters, "session"),
      hint: "Session of the entry time (UTC−5). Trades without an entry are left out.",
    }),
    singleMenu({
      key: "review", label: "Review", anyLabel: "Any review status", values: ["YES", "NO"] as const, labels: REVIEW_LABELS, current: flagKey(filters.reviewed),
      apply: value => ({ ...filters, reviewed: value === "YES" }), without: omit(filters, "reviewed"),
      hint: "Review pending lists closed trades you haven't marked reviewed.",
    }),
    singleMenu({
      key: "ai", label: "AI review", anyLabel: "Any", values: ["YES", "NO"] as const, labels: AI_LABELS, current: flagKey(filters.aiReviewed),
      apply: value => ({ ...filters, aiReviewed: value === "YES" }), without: omit(filters, "aiReviewed"), hint: "Completed AI trade reviews.",
    }),
    tagMenu,
    instrument,
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Drill-down chips (filters that arrive from EDGE, the calendar or Accounts and have no menu).
// ---------------------------------------------------------------------------------------------------------
export function extraChips(filters: TradeFilters, today: string, names: JournalInput["versionNames"], accountFilter: AccountFilterState = NO_ACCOUNT_FILTER): ChipView[] {
  const chips: ChipView[] = [];
  // The read-only account filter (All Accounts only): the account's name in words, never its id.
  const account = filters.accountFilter ? accountFilterLabel(accountFilter.kind === "none" ? { kind: "unavailable" } : accountFilter) : null;
  if (account) chips.push({ key: "account", label: account, removeHref: href(omit(filters, "accountFilter")) });
  const closed = rangeText(filters.closedFrom, filters.closedTo, today);
  if (closed) {
    const text = filters.closedFrom && filters.closedTo ? `Closed ${closed}` : `Closed ${closed.charAt(0).toLowerCase()}${closed.slice(1)}`;
    chips.push({ key: "closed", label: text, removeHref: href(omit(filters, "closedFrom", "closedTo")) });
  }
  if (filters.weekday) chips.push({ key: "weekday", label: `Entry weekday: ${filters.weekday}`, removeHref: href(omit(filters, "weekday")) });
  if (filters.direction) chips.push({ key: "direction", label: `Direction: ${DIRECTION_LABELS[filters.direction]}`, removeHref: href(omit(filters, "direction")) });
  if (filters.riskPercent) chips.push({ key: "risk", label: `Planned risk: ${formatPercent(filters.riskPercent)}`, removeHref: href(omit(filters, "riskPercent")) });
  if (filters.strategyVersionId) {
    chips.push({ key: "strategy", label: `Strategy: ${names.strategy ?? "selected version"}`, removeHref: href(omit(filters, "strategyVersionId")) });
  }
  if (filters.riskPlanVersionId) {
    const name = names.riskPlan;
    chips.push({ key: "risk-plan", label: name ? (/^risk plan/i.test(name) ? name : `Risk plan ${name}`) : "Risk plan: selected version", removeHref: href(omit(filters, "riskPlanVersionId")) });
  }
  if (filters.rFrom !== undefined || filters.rTo !== undefined) {
    const label = filters.rFrom !== undefined && filters.rTo !== undefined
      ? `Realized R: ${formatR(filters.rFrom)} to ${formatR(filters.rTo)}`
      : filters.rFrom !== undefined ? `Realized R: ${formatR(filters.rFrom)} or more` : `Realized R: below ${formatR(filters.rTo)}`;
    chips.push({ key: "r-range", label, removeHref: href(omit(filters, "rFrom", "rTo")) });
  }
  return chips;
}

// ---------------------------------------------------------------------------------------------------------
// Mobile filter sheet.
// ---------------------------------------------------------------------------------------------------------
/** Filters the sheet does not edit; kept as hidden fields so applying the sheet never drops them. */
const SHEET_KEPT: FilterKey[] = [
  "q", "closedFrom", "closedTo", "weekday", "direction", "riskPercent", "strategyVersionId", "riskPlanVersionId", "rFrom", "rTo", "accountFilter",
];

function sheetView(filters: TradeFilters, today: string, activeCount: number): SheetView {
  const kept: TradeFilters = {};
  for (const key of SHEET_KEPT) if (filters[key] !== undefined) Object.assign(kept, { [key]: filters[key] });
  const radio = (name: string, legend: string, values: { value: string; label: string; checked: boolean }[], hint: string | null = null): SheetChoiceGroup => ({
    name, legend, type: "radio", hint, options: [{ value: "", label: "Any", checked: !values.some(option => option.checked) }, ...values],
  });
  const groups: SheetChoiceGroup[] = [
    radio("result", "Result", TRADE_RESULTS.map(value => ({ value: paramValue({ result: value }, "result"), label: RESULT_LABELS[value], checked: filters.result === value }))),
    {
      name: "state", legend: "State", type: "checkbox", hint: "Draft includes blocked, ready-to-lock and recheck-needed drafts.",
      options: LIFECYCLES.map(value => ({ value: paramValue({ states: [value] }, "state"), label: STATE_LABELS[value], checked: filters.states?.includes(value) ?? false })),
    },
    radio("origin", "Origin", TRADE_ORIGINS.map(value => ({ value: paramValue({ origin: value }, "origin"), label: ORIGIN_LABELS[value], checked: filters.origin === value }))),
    radio("model", "Model", ENTRY_MODELS.map(value => ({ value: paramValue({ model: value }, "model"), label: MODEL_LABELS[value], checked: filters.model === value }))),
    radio("session", "Session", SESSIONS.map(value => ({ value: paramValue({ session: value }, "session"), label: SESSION_LABELS[value], checked: filters.session === value })),
      "Session of the entry time (UTC−5)."),
    radio("reviewed", "Review", [
      { value: "yes", label: REVIEW_LABELS.YES, checked: filters.reviewed === true },
      { value: "no", label: REVIEW_LABELS.NO, checked: filters.reviewed === false },
    ]),
    radio("ai", "AI review", [
      { value: "yes", label: AI_LABELS.YES, checked: filters.aiReviewed === true },
      { value: "no", label: AI_LABELS.NO, checked: filters.aiReviewed === false },
    ]),
  ];
  return {
    signature: tradeFilterParams(filters).toString(),
    activeCount,
    date: { presets: datePresets(today), from: filters.from ?? "", to: filters.to ?? "", max: today },
    groups,
    tags: (filters.tags ?? []).join(", "),
    instrument: filters.instrument ?? "",
    hidden: hiddenFields(kept),
  };
}

/** Less frequent filters, grouped under "More filters" so the filter row stays one line. */
const MORE_KEYS: ReadonlySet<FilterMenuView["key"]> = new Set(["origin", "session", "review", "ai"]);

export function buildFilters(
  filters: TradeFilters, today: string, rows: readonly TradeListRow[], names: JournalInput["versionNames"], accountFilter: AccountFilterState = NO_ACCOUNT_FILTER,
): FiltersView {
  const menus = buildMenus(filters, today, rows);
  const extras = extraChips(filters, today, names, accountFilter);
  const allChips: ChipView[] = [];
  for (const menu of menus) {
    if (menu.activeLabel === null || menu.removeHref === null) continue;
    if (menu.key === "tags") {
      for (const option of menu.options) allChips.push({ key: option.key, label: `Tag: ${option.label}`, removeHref: option.href });
    } else {
      allChips.push({ key: menu.key, label: `${menu.label}: ${menu.activeLabel}`, removeHref: menu.removeHref });
    }
  }
  allChips.push(...extras);
  const activeCount = menus.filter(menu => menu.activeLabel !== null).length + extras.length;
  const q = filters.q ?? "";
  return {
    search: { value: q, hidden: hiddenFields(omit(filters, "q")), clearHref: q ? href(omit(filters, "q")) : null },
    menus: menus.filter(menu => !MORE_KEYS.has(menu.key)),
    moreMenus: menus.filter(menu => MORE_KEYS.has(menu.key)),
    extraChips: extras,
    allChips,
    clearHref: activeCount > 0 || q ? JOURNAL_PATH : null,
    sheet: sheetView(filters, today, activeCount),
    activeCount,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rows and groups.
// ---------------------------------------------------------------------------------------------------------
function signTone(value: string): ValueView["tone"] {
  const number = new Decimal(value);
  return number.isZero() ? "neutral" : number.isNegative() ? "neg" : "pos";
}

/** Lifecycles that end without a result: the plan was never taken, or the draft was thrown away. */
const NOT_TAKEN: ReadonlySet<Lifecycle> = new Set(["SKIPPED", "CANCELLED"]);

/** Screen-reader wording of an empty result cell of a trade that has not closed. */
function noResultText(lifecycle: Lifecycle): string {
  if (NOT_TAKEN.has(lifecycle)) return "No result: plan not taken";
  if (lifecycle === "DISCARDED") return "No result: draft discarded";
  return "No result yet";
}

/**
 * "Entered 09:42" in the person's time display. Rows are grouped by strategy day (UTC−5); when the display puts the
 * instant on another calendar day than its group (local or UTC display around midnight), the time carries its date.
 */
export function timeLabel(row: TradeListRow, display: TimeDisplay): string {
  const verb = dateSourceVerb(row.tradeDateSource, row.trade.origin);
  const otherDay = display.mode !== "strategy" && displayDay(row.tradeAt, display) !== row.tradeDay;
  return `${verb} ${otherDay ? formatDateTime(row.tradeAt, display) : formatTime(row.tradeAt, display)}`;
}

export function rowView(row: TradeListRow, context: JournalContext, display: TimeDisplay): TradeRowView {
  const trade = row.trade;
  const closed = trade.exited_at !== null;
  const planned = trade.origin === "PLANNED";
  const ended = NOT_TAKEN.has(trade.lifecycle) || trade.lifecycle === "DISCARDED";
  return {
    key: row.id,
    href: row.href,
    symbol: trade.symbol ?? "Unknown instrument",
    direction: trade.direction ? DIRECTION_LABELS[trade.direction] : null,
    timeLabel: timeLabel(row, display),
    accountName: context.mode === "all" ? row.account.name : null,
    model: trade.entry_model ? MODEL_LABELS[trade.entry_model] : null,
    plannedRisk: trade.requested_risk_percent !== null
      ? { text: formatPercent(trade.requested_risk_percent), tone: "neutral" }
      : { text: "—", tone: "muted", srText: planned ? (ended ? "No planned risk" : "No planned risk yet") : "No pre-trade plan recorded" },
    realizedR: trade.realized_r !== null
      ? { text: formatR(trade.realized_r), tone: signTone(trade.realized_r) }
      : { text: "—", tone: "muted", srText: closed ? "Realized R not available: no risk was recorded" : noResultText(trade.lifecycle), pending: !closed },
    pnl: trade.net_pnl !== null
      ? { text: formatSignedMoney(trade.net_pnl, trade.currency), tone: signTone(trade.net_pnl) }
      : { text: "—", tone: "muted", srText: noResultText(trade.lifecycle), pending: true },
    state: { label: row.state.label, tone: pillTone(row.state.tone) },
    origin: { label: row.state.originLabel, title: row.state.originTooltip ?? (trade.origin === "IMPORTED" ? "Imported from a platform execution." : null) },
    tags: trade.tags.slice(0, VISIBLE_TAGS),
    hiddenTagCount: Math.max(0, trade.tags.length - VISIBLE_TAGS),
    tagsText: trade.tags.join(", "),
    aiReviewed: row.ai.reviews > 0,
    thumbnail: row.thumbnail ? { src: row.thumbnail.thumbSrc, extra: Math.max(0, trade.evidence_count - 1) } : null,
    evidenceCount: trade.evidence_count,
  };
}

/** The days a page shares with the previous or the next page, whose trades the group header counts in full. */
export interface SplitDays {
  /** The first day of the page when the previous page ended on it (the cursor is the previous page's last trade). */
  first: string | null;
  /** The last day of the page when the next page starts on it (see `trimToPage`). */
  last: string | null;
}

export function splitDays(page: TradeListPage, cursor: string | null, lastDayContinues: boolean): SplitDays {
  const previous = decodeTradeCursor(cursor);
  const first = page.groups[0]?.day ?? null;
  return {
    first: previous !== null && first !== null && strategyDay(previous.t) === first ? first : null,
    last: lastDayContinues ? (page.groups[page.groups.length - 1]?.day ?? null) : null,
  };
}

/**
 * "12 trades", or for a day shared with another page "12 of 14 trades · more on the next page" when its exact count is
 * known; without the count only what the page itself proves ("12 trades · more on the next page").
 */
export function dayCountLabel(shown: number, total: number | undefined, before: boolean, after: boolean): string {
  if (total === undefined || total <= shown) return `${plural(shown, "trade")}${after ? " · more on the next page" : ""}`;
  const where = before && after ? "the previous and next pages" : after ? "the next page" : before ? "the previous page" : "other pages";
  return `${shown} of ${plural(total, "trade")} · more on ${where}`;
}

function groupViews(page: TradeListPage, input: JournalInput, today: string): TradeGroupView[] {
  const { context, display } = input;
  const yesterday = addDays(today, -1);
  const split = splitDays(page, input.cursor, input.lastDayContinues);
  // Days are always strategy days; when times show in another zone, each header names the zone of its day.
  const zone = display.mode === "strategy" ? null : STRATEGY_ZONE_LABEL;
  return page.groups.map((group, index) => {
    const after = index === page.groups.length - 1 && split.last === group.day;
    const before = index === 0 && split.first === group.day;
    return {
      day: group.day,
      relative: group.day === today ? "Today" : group.day === yesterday ? "Yesterday" : null,
      label: group.label,
      zone,
      countLabel: dayCountLabel(group.rows.length, before || after ? input.counts?.days.get(group.day) : undefined, before, after),
      rows: group.rows.map(row => rowView(row, context, display)),
    };
  });
}

/** "4 trades"; across pages "Showing 50 of 93 trades" with the exact total, else "50 trades on this page". */
export function resultSummary(shown: number, noun: string, paged: boolean, total: number | null | undefined): string {
  if (!paged) return plural(shown, noun);
  return total !== null && total !== undefined && total >= shown ? `Showing ${shown} of ${plural(total, noun)}` : `${plural(shown, noun)} on this page`;
}

// ---------------------------------------------------------------------------------------------------------
// Pagination, empty states, notices.
// ---------------------------------------------------------------------------------------------------------
function paginationView(filters: TradeFilters, page: TradeListPage | null, cursor: string | null, trail: readonly string[]): PaginationView | null {
  const nextCursor = page?.nextCursor ?? null;
  if (!nextCursor && !cursor) return null;
  const current = cursor ?? FIRST_PAGE_TOKEN;
  const olderTrail = [...trail, current].slice(-MAX_TRAIL);
  const previous = trail[trail.length - 1];
  const newerHref = previous !== undefined ? pageHref(filters, previous === FIRST_PAGE_TOKEN ? null : previous, trail.slice(0, -1)) : null;
  const knowsPage = cursor === null || trail[0] === FIRST_PAGE_TOKEN;
  return {
    newerHref,
    olderHref: nextCursor ? pageHref(filters, nextCursor, olderTrail) : null,
    newestHref: cursor && !newerHref ? href(filters) : null,
    summary: knowsPage ? `Page ${cursor === null ? 1 : trail.length + 1} · ${JOURNAL_PAGE_SIZE} per page` : `${JOURNAL_PAGE_SIZE} per page`,
  };
}

const PLAN_TRADE = { label: "Plan trade", href: "/trades/new" } as const;
const RECORD_LIVE = { label: "Record live trade", href: "/trades/live/new" } as const;

function emptyView(input: JournalInput, filtersActive: boolean, searchOnly: boolean): EmptyView {
  const { context, filters, cursor } = input;
  if (!context.hasAccounts) {
    return {
      kind: "no-accounts",
      title: "Create your first trading account.",
      description: "Trades belong to a trading account. Add your broker, prop-firm or demo account to start planning and journaling trades.",
      actions: [{ label: "Create trading account", href: "/accounts/new", variant: "primary" }],
    };
  }
  if (cursor) {
    return {
      kind: "end-of-list",
      title: "No more trades.",
      description: "You've reached the end of this list.",
      actions: [{ label: "Back to newest", href: href(filters), variant: "secondary" }],
    };
  }
  const allAccounts = context.mode === "account"
    ? [{ label: "Search All Accounts", href: journalHref(filters, { account: "all" }), variant: "secondary" as const, prefetch: false }]
    : [];
  if (filtersActive || filters.q) {
    if (searchOnly) {
      return {
        kind: "no-matches",
        title: `No trades match “${filters.q}”.`,
        description: "Search looks at instruments, tags and journal notes. Try a symbol such as EURUSD, a tag, or a word from a note.",
        actions: [{ label: "Clear search", href: JOURNAL_PATH, variant: "primary", clearsFilters: true }, ...allAccounts],
      };
    }
    return {
      kind: "no-matches",
      title: "No trades match these filters.",
      description: filters.q
        ? `Nothing matches “${filters.q}” with these filters. Remove a filter or broaden the date range.`
        : "Remove a filter or broaden the date range to see more trades.",
      actions: [{ label: "Clear all filters", href: JOURNAL_PATH, variant: "primary", clearsFilters: true }, ...allAccounts],
    };
  }
  const switchAll = context.mode === "account"
    ? [{ label: "View All Accounts", href: journalHref({}, { account: "all" }), variant: "secondary" as const, prefetch: false }]
    : [];
  return {
    kind: "no-trades",
    title: context.mode === "account" && context.accountName ? `No trades in ${context.accountName} yet.` : "No trades yet.",
    description: "Plan a trade before entry, or record one that's already live. Each trade and its journal appears here, grouped by day.",
    actions: [{ ...PLAN_TRADE, variant: "primary" }, { ...RECORD_LIVE, variant: "secondary" }, ...switchAll],
  };
}

/** A range whose start is after its end can match nothing; the page says so instead of loading. */
export function rangeErrors(filters: TradeFilters, today: string): string[] {
  const errors: string[] = [];
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.push(`The start date (${dayText(filters.from, today)}) is after the end date (${dayText(filters.to, today)}). Choose a start date on or before the end date.`);
  }
  if (filters.closedFrom && filters.closedTo && filters.closedFrom > filters.closedTo) {
    errors.push(`The closed-from date (${dayText(filters.closedFrom, today)}) is after the closed-to date (${dayText(filters.closedTo, today)}).`);
  }
  return errors;
}

function invalidNotice(invalid: readonly string[]): string | null {
  if (!invalid.length) return null;
  const names = [...new Set(invalid.map(key => FILTER_PARAM_NAMES[key] ?? "filter"))];
  // Worded for both sources of a bad value: a shared or bookmarked link, and a value typed into a filter.
  return `Some filters couldn't be read and were ignored (${names.join(", ")}).`;
}

/** What the list covers: the selected account, one account of All Accounts (read-only account filter), or All Accounts. */
function contextLabel(context: JournalContext, accountFilter: AccountFilterState): string {
  if (context.mode === "account" && context.accountName) return context.accountName;
  if (accountFilter.kind === "account") return `${accountFilter.account.name}${accountFilter.account.status === "ARCHIVED" ? " (archived)" : ""}`;
  return "All Accounts";
}

export function buildJournalView(input: JournalInput): JournalView {
  const { filters, context, display, now, page, cursor, trail } = input;
  const accountFilter = input.accountFilter ?? NO_ACCOUNT_FILTER;
  const today = strategyDay(now);
  const rows = page?.rows ?? [];
  const filterView = buildFilters(filters, today, rows, input.versionNames, accountFilter);
  const notices: JournalView["notices"] = [];
  const invalid = invalidNotice(input.invalid);
  if (invalid) notices.push({ tone: "warning", text: invalid });
  if (filters.accountFilter && accountFilter.kind !== "account") {
    notices.push({ tone: "warning", text: "That trading account isn't available, so no trade matches the account filter. Remove it to see every account." });
  }
  for (const error of rangeErrors(filters, today)) notices.push({ tone: "negative", text: error });
  const groups = page ? groupViews(page, input, today) : [];
  const filtersActive = filterView.activeCount > 0;
  const searchOnly = !filtersActive && Boolean(filters.q);
  const more = page?.nextCursor !== null && page?.nextCursor !== undefined;
  return {
    contextLabel: contextLabel(context, accountFilter),
    zoneLabel: zoneLabel(display),
    dateDefinition: page?.dateDefinition ?? TRADE_DATE_DEFINITION,
    dateNote: display.mode === "strategy" ? null : `Times are shown in ${zoneLabel(display)}. A time that falls on a different day there shows its date.`,
    filters: filterView,
    notices,
    groups,
    resultSummary: rows.length
      ? resultSummary(rows.length, filtersActive || filters.q ? "matching trade" : "trade", more || cursor !== null, input.counts?.total)
      : null,
    pagination: rows.length ? paginationView(filters, page, cursor, trail) : null,
    empty: rows.length ? null : emptyView(input, filtersActive, searchOnly),
  };
}
