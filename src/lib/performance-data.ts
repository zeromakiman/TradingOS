import "server-only";
import { z } from "zod";
import type { Lifecycle, LedgerTrade } from "@/domain/ledger";
import {
  type AccountContribution, accountContribution, type BreakdownGroup, type BreakdownKey, breakdown, type CalendarDay, type CalendarMode, type CalendarMonth,
  type CurvePoint, calendarMonth, type DailyPoint, type DistributionBin, type DistributionR, type DrawdownPoint, dailySeries, distributionR, drawdownSeries,
  equityCurveR, isEarlySample, type MoneyTotal, moneyByCurrency, type RMetrics, rMetrics, sampleCaveat,
} from "@/domain/performance";
import { daysInMonth, strategyMonth } from "@/domain/time-display";
import { type AccountContext, currentSession, type Db, getAccountContext } from "./account-context";
import {
  applyLedgerFilters, inTradeDateRange, journalHref, ledgerSelect, normalizeFilters, parseLedger, postFilter, searchSymbol, searchTradeIds, type TradeFilters,
  type TradeScope,
} from "./trades-data";

/**
 * Performance data (docs/V2_ARCHITECTURE.md §9.3, §13.6–13.8, §14.6, §14.8): keyset-loads the ledger rows of a context
 * and filters, feeds the pure `src/domain/performance.ts` math (R across accounts, money only within one currency), and
 * builds the drill-down links of every chart into the Journal. Drill-downs keep the page's filters and add the
 * clicked dimension, so the Journal lists exactly the trades a mark summarises.
 */

const PAGE = 500;
/** Rows read per request at most; beyond it the view says `truncated` (never silently partial). */
export const MAX_LEDGER_ROWS = 20_000;
const CLOSED_STATES: Lifecycle[] = ["CLOSED", "REVIEWED"];

export interface LedgerRows {
  rows: LedgerTrade[];
  /** More rows matched than MAX_LEDGER_ROWS. */
  truncated: boolean;
}

export interface LoadLedgerOptions {
  /** Only trades with a recorded exit (performance is computed on closed trades). */
  closedOnly?: boolean;
  /** Restrict to some lifecycles (e.g. live and closed trades for account metrics). */
  lifecycles?: readonly Lifecycle[];
  maxRows?: number;
}

/**
 * Every ledger row of the scope matching the filters, in id order (keyset pagination by id avoids PostgREST's row cap
 * and shifting offsets). Trade-date range, session, weekday and R bounds are applied to the parsed rows.
 */
export async function loadLedgerRows(db: Db, userId: string, scope: TradeScope, raw: TradeFilters, options: LoadLedgerOptions = {}): Promise<LedgerRows> {
  const filters = normalizeFilters(raw);
  const maxRows = options.maxRows ?? MAX_LEDGER_ROWS;
  const searchIds = filters.q !== undefined ? await searchTradeIds(db, userId, scope, filters.q) : null;
  if (filters.q !== undefined && !searchSymbol(filters.q) && !searchIds?.length) return { rows: [], truncated: false };
  const rows: LedgerTrade[] = [];
  let read = 0;
  let after: string | null = null;
  for (;;) {
    let query = applyLedgerFilters(ledgerSelect(db), scope, filters, searchIds);
    if (options.closedOnly) query = query.not("exited_at", "is", null);
    if (options.lifecycles?.length) query = query.in("lifecycle", [...options.lifecycles]);
    if (after !== null) query = query.gt("id", after);
    const { data, error } = await query.order("id", { ascending: true }).limit(PAGE);
    if (error) throw new Error("Trades are unavailable.");
    const batch = parseLedger(data);
    read += batch.length;
    for (const trade of batch) if (inTradeDateRange(trade, filters) && postFilter(trade, filters)) rows.push(trade);
    if (batch.length < PAGE) return { rows, truncated: false };
    if (read >= maxRows) return { rows, truncated: true };
    after = batch[batch.length - 1].id;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Drill-down links (spec §13.6, §14.6): `/journal?…` with the page filters plus the clicked dimension.
// ---------------------------------------------------------------------------------------------------------
/** Breakdown group → Journal filters; null for the "Unknown" group (no filter can select missing values). */
export function breakdownFilters(key: BreakdownKey, value: string | null, base: TradeFilters): TradeFilters | null {
  if (value === null) return null;
  const closed: TradeFilters = { ...base, states: CLOSED_STATES };
  switch (key) {
    case "model": return { ...closed, model: value as TradeFilters["model"] };
    case "session": return { ...closed, session: value as TradeFilters["session"] };
    case "weekday": return { ...closed, weekday: value as TradeFilters["weekday"] };
    case "origin": return { ...closed, origin: value as TradeFilters["origin"] };
    case "direction": return { ...closed, direction: value as TradeFilters["direction"] };
    case "instrument": return { ...closed, instrument: value };
    case "riskPercent": return { ...closed, riskPercent: value };
    case "strategyVersion": return { ...closed, strategyVersionId: value };
    case "riskPlanVersion": return { ...closed, riskPlanVersionId: value };
    case "account": return closed;
  }
}

/**
 * Where drill-down links point: the page's filters, plus `account` when the page belongs to one account that may not
 * be the current context (an account dashboard opened from All Accounts), so the link switches the context to it.
 */
export interface DrillDown {
  base: TradeFilters;
  account?: string;
}

function drillHref(filters: TradeFilters, drill: DrillDown): string {
  return journalHref(filters, drill.account ? { account: drill.account } : {});
}

/** Journal link of a breakdown bar; the account breakdown switches the context to that account explicitly. */
export function breakdownHref(group: Pick<BreakdownGroup, "key" | "value">, drill: DrillDown): string | null {
  const filters = breakdownFilters(group.key, group.value, drill.base);
  if (!filters) return null;
  return group.key === "account" && group.value ? journalHref(filters, { account: group.value }) : drillHref(filters, drill);
}

/** Trades closed on one strategy day (calendar cells, daily bars). */
export function closedOnHref(day: string, drill: DrillDown): string {
  return drillHref({ ...drill.base, states: CLOSED_STATES, closedFrom: day, closedTo: day }, drill);
}

/** Trades of one R-distribution bin ([from, to)). */
export function distributionBinHref(bin: Pick<DistributionBin, "from" | "to">, drill: DrillDown): string {
  return drillHref({ ...drill.base, states: CLOSED_STATES, ...(bin.from !== null ? { rFrom: bin.from } : {}), ...(bin.to !== null ? { rTo: bin.to } : {}) }, drill);
}

/** A point of the R curve or drawdown links to its trade. */
export function tradeHref(tradeId: string): string {
  return `/trades/${tradeId}`;
}

/** Account contribution rows open that account's Journal (switching the context explicitly). */
export function accountJournalHref(accountId: string, base: TradeFilters): string {
  return journalHref({ ...base, states: CLOSED_STATES }, { account: accountId });
}

export interface LinkedBreakdownGroup extends BreakdownGroup {
  href: string | null;
}

export interface LinkedCalendarDay extends CalendarDay {
  href: string | null;
}

export interface LinkedCalendar extends Omit<CalendarMonth, "weeks" | "days"> {
  weeks: LinkedCalendarDay[][];
  days: LinkedCalendarDay[];
  previousMonth: string;
  nextMonth: string;
}

/** `YYYY-MM` shifted by whole months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(part => Number.parseInt(part, 10));
  const total = year * 12 + (index - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** A valid `YYYY-MM`, else the fallback. */
export function parseMonth(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return fallback;
  try {
    daysInMonth(value);
    return value;
  } catch {
    return fallback;
  }
}

export const CALENDAR_MODES = ["NET_R", "NET_PNL", "GROSS_LOSS", "COUNT"] as const satisfies readonly CalendarMode[];

/** The month heatmap with a Journal link on every day that has closed trades. */
export function linkedCalendar(trades: readonly LedgerTrade[], month: string, mode: CalendarMode, drill: DrillDown, currency?: string): LinkedCalendar {
  const calendar = calendarMonth(trades, month, mode, currency ? { currency } : {});
  const link = (day: CalendarDay): LinkedCalendarDay => ({ ...day, href: day.inMonth && day.closed > 0 ? closedOnHref(day.day, drill) : null });
  return {
    ...calendar, weeks: calendar.weeks.map(week => week.map(link)), days: calendar.days.map(link),
    previousMonth: shiftMonth(month, -1), nextMonth: shiftMonth(month, 1),
  };
}

export const EDGE_BREAKDOWNS: readonly BreakdownKey[] = ["model", "session", "weekday", "origin", "instrument", "direction", "riskPercent", "strategyVersion", "riskPlanVersion"];

export interface PerformanceView {
  filters: TradeFilters;
  /** Closed trades in the statistics (including those without a risk basis). */
  closedCount: number;
  metrics: RMetrics;
  /** Per currency, never converted. */
  money: MoneyTotal[];
  /** Spec §13.8 words: "3 completed trades — early sample; …". */
  sampleCaveat: string;
  /** Win rate, profit factor and expectancy are de-emphasised below ten trades. */
  earlySample: boolean;
  curve: CurvePoint[];
  drawdown: DrawdownPoint[];
  daily: (DailyPoint & { href: string })[];
  distribution: DistributionR & { bins: (DistributionBin & { href: string })[] };
  breakdowns: Partial<Record<BreakdownKey, LinkedBreakdownGroup[]>>;
  /** All Accounts: each account's trades, net R, own-currency net P&L and share of net R. */
  contribution: (AccountContribution & { href: string })[] | null;
  calendar: LinkedCalendar;
  /** "R is per-trade risk units, not money" (All Accounts R label, §9.3). */
  rLabel: string;
  truncated: boolean;
}

export interface PerformanceOptions {
  /** `YYYY-MM` of the calendar; the strategy month of `now` by default. */
  month?: string;
  calendarMode?: CalendarMode;
  /** Money calendar modes when the trades span several currencies. */
  currency?: string;
  breakdowns?: readonly BreakdownKey[];
}

export const R_LABEL = "R is per-trade risk units, not money";

/** Pure assembly of the EDGE view from closed ledger rows. */
export function buildPerformance(context: AccountContext, rows: LedgerRows, filters: TradeFilters, now: string, options: PerformanceOptions = {}): PerformanceView {
  const trades = rows.rows;
  const drill: DrillDown = { base: filters };
  const metrics = rMetrics(trades);
  const names = Object.fromEntries(context.accounts.map(account => [account.id, account.name]));
  const keys = options.breakdowns ?? EDGE_BREAKDOWNS;
  const breakdowns: Partial<Record<BreakdownKey, LinkedBreakdownGroup[]>> = {};
  for (const key of keys) {
    breakdowns[key] = breakdown(trades, key, { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) }));
  }
  const distribution = distributionR(trades);
  const month = parseMonth(options.month, strategyMonth(now));
  const contribution = context.selected.mode === "all"
    ? accountContribution(trades, context.accounts.map(account => ({ id: account.id, name: account.name, currency: account.currency })))
      .map(entry => ({ ...entry, href: accountJournalHref(entry.accountId, filters) }))
    : null;
  return {
    filters,
    closedCount: metrics.closed,
    metrics,
    money: moneyByCurrency(trades),
    sampleCaveat: sampleCaveat(metrics.completed),
    earlySample: isEarlySample(metrics.completed),
    curve: equityCurveR(trades),
    drawdown: drawdownSeries(trades),
    daily: dailySeries(trades).map(point => ({ ...point, href: closedOnHref(point.day, drill) })),
    distribution: { ...distribution, bins: distribution.bins.map(bin => ({ ...bin, href: distributionBinHref(bin, drill) })) },
    breakdowns,
    contribution,
    calendar: linkedCalendar(trades, month, options.calendarMode ?? "NET_R", drill, options.currency),
    rLabel: R_LABEL,
    truncated: rows.truncated,
  };
}

/** EDGE of the request's account context (closed trades only). */
export async function getPerformance(filters: TradeFilters, options: PerformanceOptions = {}): Promise<PerformanceView> {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  const scope: TradeScope = context.selected.mode === "account" ? { mode: "account", accountId: context.selected.account.id } : { mode: "all" };
  const rows = await loadLedgerRows(db, user.id, scope, filters, { closedOnly: true });
  return buildPerformance(context, rows, filters, new Date().toISOString(), options);
}

/** Calendar month only (month navigation and mode switches re-read just the month's exits). */
export async function getCalendar(month: string, mode: CalendarMode, filters: TradeFilters, currency?: string): Promise<LinkedCalendar> {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  const scope: TradeScope = context.selected.mode === "account" ? { mode: "account", accountId: context.selected.account.id } : { mode: "all" };
  const valid = parseMonth(month, strategyMonth(new Date().toISOString()));
  const last = `${valid}-${String(daysInMonth(valid)).padStart(2, "0")}`;
  const monthFilters: TradeFilters = { ...filters, closedFrom: maxDay(filters.closedFrom, `${valid}-01`), closedTo: minDay(filters.closedTo, last) };
  const rows = await loadLedgerRows(db, user.id, scope, monthFilters, { closedOnly: true });
  return linkedCalendar(rows.rows, valid, mode, { base: filters }, currency);
}

function maxDay(a: string | undefined, b: string): string {
  return a !== undefined && a > b ? a : b;
}

function minDay(a: string | undefined, b: string): string {
  return a !== undefined && a < b ? a : b;
}

export const calendarModeSchema = z.enum(CALENDAR_MODES);
