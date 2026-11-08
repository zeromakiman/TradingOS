import Decimal from "decimal.js";
import { isClosed, type PerformanceTrade, rMetrics } from "./performance";
import { formatDay, type Instant, strategyDay } from "./time-display";
import { deriveLifecycle, type LifecycleRow } from "./trade-state";

/**
 * Per-account metrics (spec §9.4). Everything shown is either recorded by the user or computed
 * from recorded trades; values that are not deterministically known carry a reason for the
 * "—" tooltip and are never estimated. "Balance from trades" is never called equity.
 */

const M = Decimal.clone({ precision: 100 });

export type AccountType = "DEMO" | "EVALUATION" | "FUNDED" | "PERSONAL" | "OTHER";
export type AccountPlatform = "MANUAL" | "CTRADER" | "MT5" | "MT4" | "TRADINGVIEW" | "OTHER";
export type AccountStatus = "ACTIVE" | "ARCHIVED";

export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = Object.freeze({ DEMO: "Demo", EVALUATION: "Evaluation", FUNDED: "Funded", PERSONAL: "Personal", OTHER: "Other" });
export const PLATFORM_LABELS: Readonly<Record<AccountPlatform, string>> = Object.freeze({ MANUAL: "Manual", CTRADER: "cTrader", MT5: "MetaTrader 5", MT4: "MetaTrader 4", TRADINGVIEW: "TradingView", OTHER: "Other" });
export const STATUS_LABELS: Readonly<Record<AccountStatus, string>> = Object.freeze({ ACTIVE: "Active", ARCHIVED: "Archived" });
export const BALANCE_FROM_TRADES_LABEL = "Starting balance + realized P&L recorded in Trading OS";

export const UNKNOWN_REASONS = Object.freeze({
  startingBalance: "No starting balance was recorded for this account.",
  accountValues: "No account values have been recorded yet.",
  balanceFromTrades: "Needs a starting balance; Trading OS does not estimate one.",
  rStatistics: "No closed trades with a recorded risk yet.",
  /** The account's trades could not all be read (the read stopped at its row limit). */
  tooManyTrades: "More trades than this page can add up; a partial total is never shown.",
  /** A currency total or the combined R of several accounts, one of which has such a reason. */
  tooManyTradesTotal: "Includes an account with more trades than this page can add up; a partial total is never shown.",
});

export type Known<T> = { value: T; unknownReason: null } | { value: null; unknownReason: string };

function known<T>(value: T): Known<T> {
  return { value, unknownReason: null };
}

function unknown<T>(reason: string): Known<T> {
  return { value: null, unknownReason: reason };
}

export interface AccountProfileInput {
  displayName: string;
  broker: string | null;
  platform: AccountPlatform;
  accountType: AccountType;
  startingBalance: string | null;
  status: AccountStatus;
}

export interface AccountObservationInput {
  balance: string;
  equity: string;
  /** Strategy day the values were recorded for. */
  tradingDay: string;
  recordedAt: string;
}

export type AccountMetricsTrade = PerformanceTrade & LifecycleRow;

export interface AccountMetricsInput {
  account: { id: string; currency: string };
  profile: AccountProfileInput;
  latestObservation: AccountObservationInput | null;
  /** Ledger rows; rows of other accounts are ignored. */
  trades: readonly AccountMetricsTrade[];
  /**
   * Whether `trades` holds every trade of the account. False when the read stopped at its row limit: every figure
   * computed from trades is then unknown (`UNKNOWN_REASONS.tooManyTrades`), never a sum over part of them.
   */
  tradesComplete: boolean;
  /** Server time: decides today's and this month's strategy-day buckets. */
  now: Instant;
}

export interface RecordedValue {
  amount: string;
  day: string;
  recordedAt: string;
  /** `Equity · recorded Oct 16`. */
  label: string;
}

/**
 * What the account's trades add up to: every figure known, or (when its trades could not all be read) every figure
 * null and `tradesUnknown` says why. Checking `tradesUnknown === null` makes all of them known.
 */
export type AccountTradeFigures =
  | {
      tradesUnknown: null;
      /** Σ net P&L of closed trades recorded in Trading OS ("0" when none). */
      realizedPnl: string;
      /** Net P&L of trades whose exit falls on today's strategy day. */
      todayPnl: string;
      /** Net P&L of trades whose exit falls in this strategy month. */
      monthPnl: string;
      /** Closed trades with a recorded risk (the R statistics' sample). */
      rTrades: number;
      /** Closed trades left out of the R statistics for lack of a recorded risk. */
      excludedNoRiskBasis: number;
      closedCount: number;
      openCount: number;
    }
  | {
      /** `UNKNOWN_REASONS.tooManyTrades`. */
      tradesUnknown: string;
      realizedPnl: null;
      todayPnl: null;
      monthPnl: null;
      rTrades: null;
      excludedNoRiskBasis: null;
      closedCount: null;
      openCount: null;
    };

export type AccountMetrics = AccountTradeFigures & {
  accountId: string;
  name: string;
  currency: string;
  type: { value: AccountType; label: string };
  broker: string | null;
  platform: { value: AccountPlatform; label: string };
  status: { value: AccountStatus; label: string };
  /** V2 has no live platform connections. */
  connection: { state: "MANUAL"; label: "Manual" };
  startingBalance: Known<string>;
  lastBalance: Known<RecordedValue>;
  lastEquity: Known<RecordedValue>;
  /** Starting balance + realized P&L; labelled with `BALANCE_FROM_TRADES_LABEL`. */
  balanceFromTrades: Known<string>;
  cumulativeR: Known<string>;
  maxDrawdownR: Known<string>;
};

function recordedValue(kind: "Balance" | "Equity", amount: string, observation: AccountObservationInput, nowDay: string): RecordedValue {
  const day = formatDay(observation.tradingDay, undefined, { year: observation.tradingDay.slice(0, 4) !== nowDay.slice(0, 4) });
  return { amount, day: observation.tradingDay, recordedAt: observation.recordedAt, label: `${kind} · recorded ${day}` };
}

type TradeResults = AccountTradeFigures & Pick<AccountMetrics, "balanceFromTrades" | "cumulativeR" | "maxDrawdownR">;

/** Every figure computed from the account's trades, or all of them unknown when they could not all be read. */
function tradeResults(input: AccountMetricsInput, today: string): TradeResults {
  const startingBalance = input.profile.startingBalance;
  if (!input.tradesComplete) {
    const reason = UNKNOWN_REASONS.tooManyTrades;
    return {
      tradesUnknown: reason, realizedPnl: null, todayPnl: null, monthPnl: null, rTrades: null, excludedNoRiskBasis: null, closedCount: null, openCount: null,
      balanceFromTrades: unknown(startingBalance === null ? UNKNOWN_REASONS.balanceFromTrades : reason),
      cumulativeR: unknown(reason),
      maxDrawdownR: unknown(reason),
    };
  }
  const trades = input.trades.filter(trade => trade.account_id === input.account.id);
  const month = today.slice(0, 7);
  let realized = new M(0);
  let todayPnl = new M(0);
  let monthPnl = new M(0);
  for (const trade of trades) {
    if (!isClosed(trade) || trade.net_pnl === null) continue;
    const exitDay = strategyDay(trade.exited_at as string);
    realized = realized.plus(trade.net_pnl);
    if (exitDay === today) todayPnl = todayPnl.plus(trade.net_pnl);
    if (exitDay.startsWith(`${month}-`)) monthPnl = monthPnl.plus(trade.net_pnl);
  }
  const metrics = rMetrics(trades);
  return {
    tradesUnknown: null,
    realizedPnl: realized.toFixed(),
    todayPnl: todayPnl.toFixed(),
    monthPnl: monthPnl.toFixed(),
    rTrades: metrics.completed,
    excludedNoRiskBasis: metrics.excludedNoRiskBasis,
    closedCount: metrics.closed,
    openCount: trades.filter(trade => deriveLifecycle(trade) === "LIVE").length,
    balanceFromTrades: startingBalance === null ? unknown(UNKNOWN_REASONS.balanceFromTrades) : known(new M(startingBalance).plus(realized).toFixed()),
    cumulativeR: metrics.netR === null ? unknown(UNKNOWN_REASONS.rStatistics) : known(metrics.netR),
    maxDrawdownR: metrics.maxDrawdown === null ? unknown(UNKNOWN_REASONS.rStatistics) : known(metrics.maxDrawdown),
  };
}

export function accountMetrics(input: AccountMetricsInput): AccountMetrics {
  const { account, profile, latestObservation: observation } = input;
  const today = strategyDay(input.now);
  return {
    accountId: account.id,
    name: profile.displayName,
    currency: account.currency,
    type: { value: profile.accountType, label: ACCOUNT_TYPE_LABELS[profile.accountType] },
    broker: profile.broker,
    platform: { value: profile.platform, label: PLATFORM_LABELS[profile.platform] },
    status: { value: profile.status, label: STATUS_LABELS[profile.status] },
    connection: { state: "MANUAL", label: "Manual" },
    startingBalance: profile.startingBalance === null ? unknown(UNKNOWN_REASONS.startingBalance) : known(new M(profile.startingBalance).toFixed()),
    lastBalance: observation ? known(recordedValue("Balance", observation.balance, observation, today)) : unknown(UNKNOWN_REASONS.accountValues),
    lastEquity: observation ? known(recordedValue("Equity", observation.equity, observation, today)) : unknown(UNKNOWN_REASONS.accountValues),
    ...tradeResults(input, today),
  };
}

/**
 * Money of the accounts that share one currency (never converted). Every total is null while one of those accounts'
 * trades could not all be read (`UNKNOWN_REASONS.tooManyTradesTotal`): a total never adds up part of the trades.
 */
export type CurrencyTotals = { currency: string; accounts: number } & (
  | { realizedPnl: string; todayPnl: string; monthPnl: string }
  | { realizedPnl: null; todayPnl: null; monthPnl: null }
);

/** Accounts-page totals: money only within one currency (never converted). */
export function accountCurrencyTotals(accounts: readonly AccountMetrics[]): CurrencyTotals[] {
  const byCurrency = new Map<string, AccountMetrics[]>();
  for (const account of accounts) byCurrency.set(account.currency, [...(byCurrency.get(account.currency) ?? []), account]);
  return [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, members]): CurrencyTotals => {
      let realized = new M(0);
      let today = new M(0);
      let month = new M(0);
      for (const member of members) {
        if (member.tradesUnknown !== null) return { currency, accounts: members.length, realizedPnl: null, todayPnl: null, monthPnl: null };
        realized = realized.plus(member.realizedPnl);
        today = today.plus(member.todayPnl);
        month = month.plus(member.monthPnl);
      }
      return { currency, accounts: members.length, realizedPnl: realized.toFixed(), todayPnl: today.toFixed(), monthPnl: month.toFixed() };
    });
}
