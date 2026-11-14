import "server-only";
import { z } from "zod";
import type { Lifecycle, LedgerTrade } from "@/domain/ledger";
import {
  type AccountContribution, accountContribution, type BreakdownGroup, type BreakdownKey, breakdown, type CalendarDay, type CalendarMode, type CalendarMonth,
  type CurvePoint, calendarMonth, type DailyPoint, type DistributionBin, type DistributionR, type DrawdownPoint, dailySeries, distributionR, drawdownSeries,
  equityCurveR, isEarlySample, type MoneyAmount, type MoneyTotal, moneyByCurrency, type RMetrics, rMetrics, sampleCaveat,
} from "@/domain/performance";
import { daysInMonth, strategyMonth } from "@/domain/time-display";
import { ALL_ACCOUNTS_VALUE, type AccountContext, type ContextAccount, type Db } from "./account-context";
import {
  ACCOUNT_READ_CONCURRENCY, accountScopes, applyLedgerFilters, filteredScope, inTradeDateRange, journalHref, ledgerSelect, MAX_ACCOUNT_READS, mapLimited,
  normalizeFilters, parseLedger, postFilter, resolveAccountFilter, searchSymbol, searchTradeIds, type TradeFilters, type TradeScope,
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
 * The scopes one ledger read pages through (`accountScopes`): the account, or in All Accounts each of the user's
 * accounts as RLS lists them. A keyset page of one account follows the trades' (user, account, id) index and stops after
 * `limit` rows; a page of the whole scope makes PostgreSQL compute every remaining trade of the user before it can sort
 * them by id (at 20,000 trades about 2 s per page, so the read grew with the square of the trades, and at 45,000 a page
 * passed the 8 s statement timeout).
 */
async function keysetScopes(db: Db, userId: string, reads: TradeScope): Promise<TradeScope[]> {
  if (reads.mode === "account") return [reads];
  const { data, error } = await db.from("accounts").select("id").eq("user_id", userId).order("id", { ascending: true }).limit(MAX_ACCOUNT_READS + 1);
  if (error) throw new Error("Trades are unavailable.");
  return accountScopes(reads, z.array(z.object({ id: z.uuid() })).parse(data ?? []));
}

/** One keyset read in id order within an id range; `rows[next]` is its next unread row. */
interface KeysetStream {
  scope: TradeScope;
  rows: LedgerTrade[];
  next: number;
  /** Exclusive lower bound (the last id read, or the range's start). */
  after: string | null;
  /** Exclusive upper bound of the range; null: the end of the id space. */
  before: string | null;
  done: boolean;
}

/** Rows of the requested lifecycles read first in one id-ordered pass; the rest of the id space is then read in parallel. */
const SEQUENTIAL_ROWS = 2_000;
/** Id ranges the rest of a large read is split into (trade ids are random v4 uuids, so the ranges hold similar shares). */
const PARALLEL_RANGES = 4;
const UUID_SPACE = 1n << 128n;

const uuidValue = (id: string) => BigInt(`0x${id.replaceAll("-", "")}`);
function uuidText(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `(after, end of id space)` split into `parts` consecutive ranges, as [exclusive lower, exclusive upper | null]. */
export function splitIdRange(after: string, parts: number): [string, string | null][] {
  const start = uuidValue(after) + 1n;
  const size = UUID_SPACE - start;
  if (size < BigInt(parts) * 2n) return [[after, null]];
  const bounds = Array.from({ length: parts - 1 }, (_, index) => start + (size * BigInt(index + 1)) / BigInt(parts));
  return [after, ...bounds.map(bound => uuidText(bound - 1n))].map((lower, index) => [lower, index < bounds.length ? uuidText(bounds[index]) : null]);
}

/** At most `max` tasks at once. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * Every ledger row of the scope matching the filters, in id order (keyset pagination by id avoids PostgREST's row cap
 * and shifting offsets). Trade-date range, session, weekday and R bounds are applied to the parsed rows. A read-only
 * account filter narrows an All Accounts scope to that account (`filteredScope`). The read keeps the first `maxRows`
 * rows of the requested lifecycles by id; it is `truncated` only when another such row matches (a scope of exactly
 * `maxRows` trades is read in full).
 *
 * All Accounts merges one keyset stream per account by id (`keysetScopes`). The first SEQUENTIAL_ROWS rows are read in
 * one pass; a larger scope's remaining id space is split into PARALLEL_RANGES ranges read at the same time (at most
 * ACCOUNT_READ_CONCURRENCY requests in flight), each up to the rows still needed, and joined in id order. The rows,
 * their order and `truncated` are those of a single pass (19,900 trades: 1.9 s instead of 5.2 s).
 *
 * `lifecycles` is applied to the parsed rows, never sent as a filter: the ledger derives `lifecycle` per row from a
 * dozen joins, so the planner cannot estimate a filter on it and computes every trade of the scope for each page (at
 * about 20,000 trades: 0.8 s per page and 27 s per account). Rows of other lifecycles (drafts, waiting, skipped,
 * cancelled and discarded plans) are read and dropped; they never count toward `maxRows`.
 */
export async function loadLedgerRows(db: Db, userId: string, scope: TradeScope, raw: TradeFilters, options: LoadLedgerOptions = {}): Promise<LedgerRows> {
  const filters = normalizeFilters(raw);
  const maxRows = options.maxRows ?? MAX_LEDGER_ROWS;
  const lifecycles = options.lifecycles?.length ? new Set<Lifecycle>(options.lifecycles) : null;
  const wanted = (trade: LedgerTrade) => lifecycles === null || lifecycles.has(trade.lifecycle);
  const searchIds = filters.q !== undefined ? await searchTradeIds(db, userId, filteredScope(scope, filters), filters.q) : null;
  if (filters.q !== undefined && !searchSymbol(filters.q) && !searchIds?.length) return { rows: [], truncated: false };
  const scopes = await keysetScopes(db, userId, filteredScope(scope, filters));
  const slot = limiter(ACCOUNT_READ_CONCURRENCY);
  const page = (stream: KeysetStream, limit: number) => slot(async () => {
    let query = applyLedgerFilters(ledgerSelect(db), stream.scope, filters, searchIds);
    if (options.closedOnly) query = query.not("exited_at", "is", null);
    if (stream.after !== null) query = query.gt("id", stream.after);
    const { data, error } = await query.order("id", { ascending: true }).limit(limit);
    if (error) throw new Error("Trades are unavailable.");
    return parseLedger(data);
  });
  // Reads the next page of an exhausted stream (`limit` rows); a range ends at the first id at or past its upper bound.
  const fill = async (stream: KeysetStream, limit: number): Promise<void> => {
    while (stream.next >= stream.rows.length && !stream.done) {
      const batch = await page(stream, limit);
      const before = stream.before;
      const end = before === null ? -1 : batch.findIndex(trade => trade.id >= before);
      stream.rows = end < 0 ? batch : batch.slice(0, end);
      stream.next = 0;
      stream.done = end >= 0 || batch.length < limit;
      if (stream.rows.length > 0) stream.after = stream.rows[stream.rows.length - 1].id;
    }
  };
  /**
   * The rows of the requested lifecycles in `(after, before)`, in id order, until `cap` are read (`complete` when the
   * range had no more). One stream per scope, merged by id; with `probe`, the row that proves `truncated` is read with a
   * one-row page when every lifecycle counts.
   */
  const readRange = async (after: string | null, before: string | null, cap: number, probe = true): Promise<{ rows: LedgerTrade[]; complete: boolean; last: string | null }> => {
    const streams: KeysetStream[] = scopes.map(reads => ({ scope: reads, rows: [], next: 0, after, before, done: false }));
    const rows: LedgerTrade[] = [];
    let last: string | null = after;
    while (rows.length < cap) {
      const limit = probe && cap - rows.length === 1 && lifecycles === null ? 1 : PAGE;
      await mapLimited(streams.filter(stream => stream.next >= stream.rows.length && !stream.done), ACCOUNT_READ_CONCURRENCY, stream => fill(stream, limit));
      let lowest: KeysetStream | null = null;
      for (const stream of streams) {
        if (stream.next < stream.rows.length && (lowest === null || stream.rows[stream.next].id < lowest.rows[lowest.next].id)) lowest = stream;
      }
      if (lowest === null) return { rows, complete: true, last };
      const trade = lowest.rows[lowest.next];
      lowest.next += 1;
      last = trade.id;
      if (wanted(trade)) rows.push(trade);
    }
    return { rows, complete: false, last };
  };
  // One more row than kept proves `truncated`.
  const needed = maxRows + 1;
  const first = await readRange(null, null, Math.min(needed, SEQUENTIAL_ROWS), needed <= SEQUENTIAL_ROWS);
  let read = first.rows;
  if (!first.complete && read.length < needed && first.last !== null) {
    const ranges = await Promise.all(splitIdRange(first.last, PARALLEL_RANGES).map(([after, before]) => readRange(after, before, needed - read.length)));
    read = [...read, ...ranges.flatMap(range => range.rows)];
  }
  const kept = read.slice(0, maxRows);
  return { rows: kept.filter(trade => inTradeDateRange(trade, filters) && postFilter(trade, filters)), truncated: read.length > maxRows };
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
    case "customModel": return { ...closed, customModel: value };
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

/**
 * Drill-downs into one account's history from All Accounts: the read-only account filter instead of a context switch.
 * For archived accounts, which can never be the working context (§9.2) but keep their history.
 */
export function accountHistoryDrill(accountId: string, base: TradeFilters = {}): DrillDown {
  return { base: { ...base, accountFilter: accountId }, account: ALL_ACCOUNTS_VALUE };
}

/** Every trade of one account in the Journal of All Accounts (read-only account filter; see `accountHistoryDrill`). */
export function accountHistoryJournalHref(accountId: string): string {
  const drill = accountHistoryDrill(accountId);
  return drillHref(drill.base, drill);
}

/** Journal link of a breakdown bar; the account breakdown switches the context to that account explicitly. */
export function breakdownHref(group: Pick<BreakdownGroup, "key" | "value">, drill: DrillDown): string | null {
  const filters = breakdownFilters(group.key, group.value, drill.base);
  if (!filters) return null;
  return group.key === "account" && group.value ? journalHref(filters, { account: group.value }) : drillHref(filters, drill);
}

/**
 * Trades closed on one strategy day (calendar cells, daily bars); with `currency`, only the trades of accounts in that
 * currency (a daily net P&L bar of one currency, which sums exactly those).
 */
export function closedOnHref(day: string, drill: DrillDown, currency?: string): string {
  return drillHref({ ...drill.base, states: CLOSED_STATES, closedFrom: day, closedTo: day, ...(currency ? { currency } : {}) }, drill);
}

/** Trades of one R-distribution bin ([from, to)). */
export function distributionBinHref(bin: Pick<DistributionBin, "from" | "to">, drill: DrillDown): string {
  return drillHref({ ...drill.base, states: CLOSED_STATES, ...(bin.from !== null ? { rFrom: bin.from } : {}), ...(bin.to !== null ? { rTo: bin.to } : {}) }, drill);
}

/** A point of the R curve or drawdown links to its trade. */
export function tradeHref(tradeId: string): string {
  return `/trades/${tradeId}`;
}

/**
 * Account contribution rows open that account's Journal: an active account becomes the context (switching it
 * explicitly); an archived one, which cannot be the context, opens in All Accounts with the read-only account filter.
 */
export function accountJournalHref(account: Pick<ContextAccount, "id" | "status">, base: TradeFilters): string {
  if (account.status === "ARCHIVED") {
    const drill = accountHistoryDrill(account.id, { ...base, states: CLOSED_STATES });
    return drillHref(drill.base, drill);
  }
  return journalHref({ ...base, states: CLOSED_STATES }, { account: account.id });
}

export interface LinkedBreakdownGroup extends BreakdownGroup {
  href: string | null;
}

/** One currency's net P&L of a day, with the Journal of exactly the trades it sums (that day's trades in that currency). */
export interface LinkedMoneyAmount extends MoneyAmount {
  href: string;
}

/** A day of the daily series: the Journal of all its trades (`href`), and of each currency's trades (`money[].href`). */
export interface LinkedDailyPoint extends DailyPoint {
  href: string;
  money: LinkedMoneyAmount[];
}

/**
 * The daily series with its drill-down links (`closedOnHref`). A currency's figure of a day links to that day's trades
 * in that currency (§9.3: money never mixes currencies); when every trade shares one currency, that is the day's link.
 */
export function linkedDailySeries(trades: readonly LedgerTrade[], drill: DrillDown): LinkedDailyPoint[] {
  const severalCurrencies = new Set(trades.map(trade => trade.currency)).size > 1;
  return dailySeries(trades).map(point => {
    const href = closedOnHref(point.day, drill);
    return { ...point, href, money: point.money.map(money => ({ ...money, href: severalCurrencies ? closedOnHref(point.day, drill, money.currency) : href })) };
  });
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
  daily: LinkedDailyPoint[];
  distribution: DistributionR & { bins: (DistributionBin & { href: string })[] };
  breakdowns: Partial<Record<BreakdownKey, LinkedBreakdownGroup[]>>;
  /**
   * All Accounts without the read-only account filter: each account's trades, net R, own-currency net P&L and share of
   * net R. Null for one account (an account context or the account filter).
   */
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

/**
 * Pure assembly of the EDGE view from closed ledger rows. The read-only account filter combines with All Accounts only
 * (`resolveAccountFilter`): in an account context, where the read already ignored it (`filteredScope`), the view and its
 * drill-down links drop it too, so a filter left in the URL by a context switch never travels on.
 */
export function buildPerformance(context: AccountContext, rows: LedgerRows, requested: TradeFilters, now: string, options: PerformanceOptions = {}): PerformanceView {
  const filters = resolveAccountFilter(requested, context).filters;
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
  const statuses = new Map(context.accounts.map(account => [account.id, account.status] as const));
  // Contribution compares the accounts of All Accounts; the read-only account filter narrows the page to one of them,
  // so, as in an account context, there is nothing to compare (and no other account to drill into).
  const contribution = context.selected.mode === "all" && !filters.accountFilter
    ? accountContribution(trades, context.accounts.map(account => ({ id: account.id, name: account.name, currency: account.currency })))
      .map(entry => ({ ...entry, href: accountJournalHref({ id: entry.accountId, status: statuses.get(entry.accountId) ?? "ACTIVE" }, filters) }))
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
    daily: linkedDailySeries(trades, drill),
    distribution: { ...distribution, bins: distribution.bins.map(bin => ({ ...bin, href: distributionBinHref(bin, drill) })) },
    breakdowns,
    contribution,
    calendar: linkedCalendar(trades, month, options.calendarMode ?? "NET_R", drill, options.currency),
    rLabel: R_LABEL,
    truncated: rows.truncated,
  };
}
