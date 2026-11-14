import Decimal from "decimal.js";
import { isClosed, type PerformanceTrade, rMetrics } from "./performance";
import { addDays, compareInstants, strategyDay, weekdayIndex } from "./time-display";

/**
 * All Accounts overview of Today (V2.1): what every trading account of the user closed in one strategy-calendar period
 * (exit day, fixed UTC−5). Pure module.
 * - Money is never added across currencies: P&L, the chart and recorded balances are per currency.
 * - R, win rate and trade counts combine every account (R is per-trade risk units, not money). Trades without a
 *   recorded risk count as trades and are named as excluded from R.
 * - Every per-account row adds up to the cards: Σ trades = trades, Σ net R = total R, Σ P&L of one currency = its card.
 * - A period whose trades could not all be read (more than the read limit) shows no figure at all ("—" with the
 *   reason), never one computed from part of the trades.
 */

const M = Decimal.clone({ precision: 100 });

export const OVERVIEW_RANGES = ["d", "w", "m", "y", "all"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const DEFAULT_OVERVIEW_RANGE: OverviewRange = "d";

export const OVERVIEW_RANGE_LABELS: Readonly<Record<OverviewRange, { short: string; long: string }>> = Object.freeze({
  d: { short: "D", long: "Today" },
  w: { short: "W", long: "This week" },
  m: { short: "M", long: "This month" },
  y: { short: "Y", long: "This year" },
  all: { short: "All", long: "All time" },
});

export const OVERVIEW_TRUNCATED_REASON = "Too many trades in this period to compute every figure exactly (more than 20,000).";

/** `?range=`; anything unreadable is today. */
export function parseOverviewRange(value: string | string[] | undefined): OverviewRange {
  const text = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return (OVERVIEW_RANGES as readonly string[]).includes(text ?? "") ? (text as OverviewRange) : DEFAULT_OVERVIEW_RANGE;
}

/** First and last strategy day of the period that contains `today` (inclusive); `from` is null for all time. */
export function overviewBounds(range: OverviewRange, today: string): { from: string | null; to: string } {
  switch (range) {
    case "d": return { from: today, to: today };
    case "w": return { from: addDays(today, -weekdayIndex(today)), to: today };
    case "m": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "y": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "all": return { from: null, to: today };
  }
}

export interface OverviewAccount {
  id: string;
  name: string;
  currency: string;
  status: "ACTIVE" | "ARCHIVED";
}

/** The latest recorded account values of an active account (balance as recorded, not live equity). */
export interface RecordedBalance {
  accountId: string;
  currency: string;
  balance: string;
  /** Strategy day the values were recorded for. */
  day: string;
}

export interface OverviewInput {
  range: OverviewRange;
  /** Strategy day of the request. */
  today: string;
  /** Closed ledger rows of every account of the user exiting in the period (trashed trades never reach it). */
  trades: readonly PerformanceTrade[];
  /** Every account of the context: active accounts always get a row, archived ones when they closed a trade. */
  accounts: readonly OverviewAccount[];
  /** Not every trade of the period could be read. */
  truncated: boolean;
  balances: readonly RecordedBalance[];
}

/** One currency's net P&L; null when a closed trade of it has no recorded P&L (the sum would be partial). */
export interface CurrencyPnl {
  currency: string;
  netPnl: string | null;
  trades: number;
}

export interface BalanceTotal {
  currency: string;
  total: string;
  accounts: number;
  /** Earliest and latest strategy day of the summed values. */
  firstDay: string;
  lastDay: string;
}

/** A point of a cumulative P&L line: the start (0), each exit (day range) or each strategy day. */
export interface PnlPoint {
  key: string;
  /** The exit instant (today) or the strategy day; null for the starting point. */
  at: string | null;
  kind: "start" | "trade" | "day";
  cumulative: string;
  /** Trades the point adds. */
  trades: number;
  tradeId?: string;
}

export interface PnlSeries {
  currency: string;
  points: PnlPoint[];
  /** A closed trade without recorded P&L: the line would be wrong, so none is drawn. */
  incomplete: boolean;
}

export interface OverviewRow {
  account: OverviewAccount;
  trades: number;
  /** Net P&L in the account's currency; null when one of its trades has no recorded P&L. */
  netPnl: string | null;
  netR: string | null;
  /** Trades with a recorded risk (the N of net R and win rate). */
  rTrades: number;
  wins: number;
  losses: number;
  winRate: string | null;
}

export interface OverviewFigures {
  range: OverviewRange;
  from: string | null;
  to: string;
  /** Null when every figure is known; otherwise why none is shown. */
  unknownReason: string | null;
  pnl: CurrencyPnl[];
  totalR: string | null;
  averageR: string | null;
  winRate: string | null;
  wins: number;
  losses: number;
  trades: number;
  rTrades: number;
  excludedNoRiskBasis: number;
  balances: BalanceTotal[];
  series: PnlSeries[];
  rows: OverviewRow[];
}

function sortByCurrency<T extends { currency: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

function exitOrder(a: PerformanceTrade, b: PerformanceTrade): number {
  return compareInstants(a.exited_at as string, b.exited_at as string) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Sums of each currency's net P&L; a trade without P&L makes its currency unknown. */
function pnlByCurrency(trades: readonly PerformanceTrade[]): CurrencyPnl[] {
  const totals = new Map<string, { net: Decimal | null; trades: number }>();
  for (const trade of trades) {
    const entry = totals.get(trade.currency) ?? { net: new M(0), trades: 0 };
    entry.trades += 1;
    entry.net = entry.net === null || trade.net_pnl === null ? null : entry.net.plus(trade.net_pnl);
    totals.set(trade.currency, entry);
  }
  return sortByCurrency([...totals.entries()].map(([currency, entry]) => ({ currency, netPnl: entry.net === null ? null : entry.net.toFixed(), trades: entry.trades })));
}

/** Cumulative P&L per currency: one point per exit for a single day, one per strategy day otherwise, from 0. */
export function pnlSeries(trades: readonly PerformanceTrade[], range: OverviewRange): PnlSeries[] {
  const byCurrency = new Map<string, PerformanceTrade[]>();
  for (const trade of [...trades].sort(exitOrder)) {
    const members = byCurrency.get(trade.currency) ?? [];
    members.push(trade);
    byCurrency.set(trade.currency, members);
  }
  return sortByCurrency([...byCurrency.entries()].map(([currency, members]) => {
    const start: PnlPoint = { key: "start", at: null, kind: "start", cumulative: "0", trades: 0 };
    if (members.some(trade => trade.net_pnl === null)) return { currency, points: [], incomplete: true };
    let running = new M(0);
    if (range === "d") {
      const points = members.map((trade): PnlPoint => {
        running = running.plus(trade.net_pnl as string);
        return { key: trade.id, at: trade.exited_at as string, kind: "trade", cumulative: running.toFixed(), trades: 1, tradeId: trade.id };
      });
      return { currency, points: [start, ...points], incomplete: false };
    }
    const days = new Map<string, { net: Decimal; trades: number }>();
    for (const trade of members) {
      const day = strategyDay(trade.exited_at as string);
      const entry = days.get(day) ?? { net: new M(0), trades: 0 };
      entry.net = entry.net.plus(trade.net_pnl as string);
      entry.trades += 1;
      days.set(day, entry);
    }
    const points = [...days.entries()].map(([day, entry]): PnlPoint => {
      running = running.plus(entry.net);
      return { key: day, at: day, kind: "day", cumulative: running.toFixed(), trades: entry.trades };
    });
    return { currency, points: [start, ...points], incomplete: false };
  }));
}

/** Latest recorded balances of the active accounts, summed per currency (never across currencies). */
export function balanceTotals(balances: readonly RecordedBalance[]): BalanceTotal[] {
  const totals = new Map<string, BalanceTotal>();
  for (const entry of balances) {
    const current = totals.get(entry.currency);
    totals.set(entry.currency, current
      ? {
        currency: entry.currency, total: new M(current.total).plus(entry.balance).toFixed(), accounts: current.accounts + 1,
        firstDay: entry.day < current.firstDay ? entry.day : current.firstDay, lastDay: entry.day > current.lastDay ? entry.day : current.lastDay,
      }
      : { currency: entry.currency, total: new M(entry.balance).toFixed(), accounts: 1, firstDay: entry.day, lastDay: entry.day });
  }
  return sortByCurrency([...totals.values()]);
}

export function allAccountsOverview(input: OverviewInput): OverviewFigures {
  const { from, to } = overviewBounds(input.range, input.today);
  const balances = balanceTotals(input.balances);
  // Only closed trades exiting inside the period count, whatever the read returned.
  const inRange = input.trades.filter(trade => {
    if (!isClosed(trade)) return false;
    const day = strategyDay(trade.exited_at as string);
    return (from === null || day >= from) && day <= to;
  });
  const base = { range: input.range, from, to, balances };
  if (input.truncated) {
    return {
      ...base, unknownReason: OVERVIEW_TRUNCATED_REASON, pnl: [], totalR: null, averageR: null, winRate: null, wins: 0, losses: 0, trades: 0, rTrades: 0,
      excludedNoRiskBasis: 0, series: [],
      rows: input.accounts.filter(account => account.status === "ACTIVE").map(account => ({
        account, trades: 0, netPnl: null, netR: null, rTrades: 0, wins: 0, losses: 0, winRate: null,
      })),
    };
  }
  const metrics = rMetrics(inRange);
  const byAccount = new Map<string, PerformanceTrade[]>();
  for (const trade of inRange) byAccount.set(trade.account_id, [...(byAccount.get(trade.account_id) ?? []), trade]);
  const known = new Map(input.accounts.map(account => [account.id, account]));
  const listed = [
    ...input.accounts.filter(account => account.status === "ACTIVE" || byAccount.has(account.id)),
    // A trade of an account the context does not list (should not happen) still counts, under a neutral name.
    ...[...byAccount.keys()].filter(id => !known.has(id)).map((id): OverviewAccount => ({
      id, name: "Trading account", currency: byAccount.get(id)?.[0]?.currency ?? "USD", status: "ARCHIVED",
    })),
  ];
  const rows = listed.map((account): OverviewRow => {
    const members = byAccount.get(account.id) ?? [];
    const own = rMetrics(members);
    const money = pnlByCurrency(members);
    return {
      account, trades: members.length,
      netPnl: members.length === 0 ? "0" : money.length === 1 ? money[0].netPnl : null,
      netR: members.length === 0 ? "0" : own.netR, rTrades: own.completed, wins: own.wins, losses: own.losses, winRate: own.winRate,
    };
  });
  return {
    ...base, unknownReason: null, pnl: pnlByCurrency(inRange),
    totalR: metrics.netR ?? (inRange.length === 0 ? "0" : null), averageR: metrics.averageR, winRate: metrics.winRate,
    wins: metrics.wins, losses: metrics.losses, trades: inRange.length, rTrades: metrics.completed, excludedNoRiskBasis: metrics.excludedNoRiskBasis,
    series: pnlSeries(inRange, input.range), rows,
  };
}

