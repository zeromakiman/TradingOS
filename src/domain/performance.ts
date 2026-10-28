import Decimal from "decimal.js";
import { formatPercent, formatR, formatSignedMoney, plural, stripZeros } from "./format";
import type { LedgerTrade } from "./ledger";
import { strategyClock } from "./session";
import { addDays, compareInstants, daysInMonth, strategyDay, toDate, WEEKDAY_NAMES, weekdayIndex } from "./time-display";

/**
 * Deterministic performance from ledger rows (spec §9.3–9.4, §13.6–13.8).
 * - R statistics port V1 `metrics()` exactly (same Decimal configuration, exit-time order with
 *   microsecond keys and id tie-break, same streak/drawdown/profit-factor semantics). R is
 *   per-trade risk units, so it aggregates across accounts; trades without a risk basis are
 *   excluded from R statistics and counted.
 * - Money is only ever summed within one currency (no FX).
 * Results are exact decimal strings; `value` fields on chart points are display-only numbers.
 */

/** V1 analytics configuration (precision 40, ROUND_HALF_UP): identical R arithmetic. */
const R = Decimal.clone({ precision: 40 });
/** Money sums stay exact for any stored scale. */
const M = Decimal.clone({ precision: 100 });

export type PerformanceTrade = Pick<LedgerTrade,
  | "id" | "account_id" | "origin" | "currency" | "symbol" | "direction" | "entry_model" | "entered_at" | "exited_at"
  | "realized_r" | "net_pnl" | "fees" | "outcome" | "requested_risk_percent"
  | "strategy_version_id" | "strategy_version" | "risk_plan_version_id" | "risk_plan_version">;

export type SampleBand = "NO DATA" | "VERY SMALL SAMPLE" | "SMALL SAMPLE" | "DEVELOPING SAMPLE" | "LARGER SAMPLE";

/** V1 bands: 0 · <10 · <30 · <100 · larger. */
export function sampleLabel(n: number): SampleBand {
  return n === 0 ? "NO DATA" : n < 10 ? "VERY SMALL SAMPLE" : n < 30 ? "SMALL SAMPLE" : n < 100 ? "DEVELOPING SAMPLE" : "LARGER SAMPLE";
}

export const EARLY_SAMPLE_NOTE = "Early sample — more data is needed before drawing strong conclusions.";

/** Win rate, profit factor and expectancy are de-emphasised below ten trades. */
export function isEarlySample(n: number): boolean {
  return n < 10;
}

/** The sample band in words (spec §13.8). */
export function sampleCaveat(n: number): string {
  const trades = plural(n, "completed trade");
  if (n === 0) return "No completed trades yet.";
  if (n < 10) return `${trades} — early sample; more data is needed before drawing conclusions.`;
  if (n < 30) return `${trades} — small sample; treat differences as emerging tendencies, not conclusions.`;
  if (n < 100) return `${trades} — developing sample; results can still change materially.`;
  return `${trades} — larger sample; figures describe the past and are not a forecast.`;
}

export type GroupEvidence = "INSUFFICIENT" | "EMERGING" | "SUFFICIENT";

/** Group comparisons never declare a winner below 30 trades per group (spec §13.8). */
export function groupEvidence(n: number): { evidence: GroupEvidence; label: string | null } {
  if (n < 10) return { evidence: "INSUFFICIENT", label: "Insufficient evidence" };
  if (n < 30) return { evidence: "EMERGING", label: "Emerging tendency" };
  return { evidence: "SUFFICIENT", label: null };
}

export function isClosed(trade: Pick<PerformanceTrade, "exited_at" | "outcome">): boolean {
  return trade.exited_at !== null && trade.outcome !== null;
}

function byExit(a: PerformanceTrade, b: PerformanceTrade): number {
  return compareInstants(a.exited_at ?? "", b.exited_at ?? "") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Closed trades in exit order, split by whether they carry realized R. */
function closedTrades(trades: readonly PerformanceTrade[]) {
  const closed = trades.filter(isClosed).sort(byExit);
  const withR = closed.filter(trade => trade.realized_r !== null);
  return { closed, withR, excluded: closed.length - withR.length };
}

export interface RMetrics {
  /** All input rows (V1 `total`). */
  total: number;
  /** Closed trades, including those without a risk basis. */
  closed: number;
  /** Closed trades in the R statistics (V1 `completed`). */
  completed: number;
  /** Closed trades excluded from R statistics because no risk basis was recorded. */
  excludedNoRiskBasis: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: string | null;
  lossRate: string | null;
  avgWinner: string | null;
  avgLoser: string | null;
  averageR: string | null;
  netR: string | null;
  expectancy: string | null;
  profitFactor: string | null;
  profitFactorState: "NO_DATA" | "NO_LOSSES" | "NO_GAINS_OR_LOSSES" | "DEFINED";
  maxDrawdown: string | null;
  currentDrawdown: string | null;
  best: string | null;
  worst: string | null;
  currentStreak: number;
  maxWins: number;
  maxLosses: number;
  sample: SampleBand;
}

/** R statistics with the exact math of V1 `metrics()`. */
export function rMetrics(trades: readonly PerformanceTrade[]): RMetrics {
  const { closed, withR, excluded } = closedTrades(trades);
  const values = withR.map(trade => new R(trade.realized_r as string));
  const positives = values.filter(v => v.gt(0));
  const negatives = values.filter(v => v.lt(0));
  const sum = (xs: Decimal[]) => xs.reduce((total, x) => total.plus(x), new R(0));
  const n = values.length;
  const wins = positives.length;
  const losses = negatives.length;
  const positive = sum(positives);
  const negative = sum(negatives);
  const net = positive.plus(negative);
  let equity = new R(0);
  let peak = new R(0);
  let maxDrawdown = new R(0);
  let currentStreak = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const v of values) {
    equity = equity.plus(v);
    peak = R.max(peak, equity);
    maxDrawdown = R.max(maxDrawdown, peak.minus(equity));
    currentStreak = v.gt(0) ? Math.max(0, currentStreak) + 1 : v.lt(0) ? Math.min(0, currentStreak) - 1 : 0;
    maxWins = Math.max(maxWins, currentStreak);
    maxLosses = Math.max(maxLosses, -currentStreak);
  }
  const text = (value: Decimal | null) => (value === null ? null : value.toFixed());
  return {
    total: trades.length,
    closed: closed.length,
    completed: n,
    excludedNoRiskBasis: excluded,
    wins,
    losses,
    breakevens: n - wins - losses,
    winRate: n ? new R(wins).div(n).toFixed() : null,
    lossRate: n ? new R(losses).div(n).toFixed() : null,
    avgWinner: wins ? positive.div(wins).toFixed() : null,
    avgLoser: losses ? negative.div(losses).toFixed() : null,
    averageR: n ? net.div(n).toFixed() : null,
    netR: n ? net.toFixed() : null,
    expectancy: n ? positive.div(n).plus(negative.div(n)).toFixed() : null,
    profitFactor: losses ? positive.div(negative.abs()).toFixed() : null,
    profitFactorState: n === 0 ? "NO_DATA" : losses === 0 ? (wins ? "NO_LOSSES" : "NO_GAINS_OR_LOSSES") : "DEFINED",
    maxDrawdown: n ? maxDrawdown.toFixed() : null,
    currentDrawdown: n ? peak.minus(equity).toFixed() : null,
    best: text(n ? R.max(...values) : null),
    worst: text(n ? R.min(...values) : null),
    currentStreak,
    maxWins,
    maxLosses,
    sample: sampleLabel(n),
  };
}

export interface MoneyTotal {
  currency: string;
  closed: number;
  netPnl: string;
  grossProfit: string;
  /** Σ max(0, −net P&L): gross realized loss. */
  grossLoss: string;
  fees: string;
}

/** Money per currency, never converted or summed across currencies. Sorted by currency code. */
export function moneyByCurrency(trades: readonly PerformanceTrade[]): MoneyTotal[] {
  const totals = new Map<string, { closed: number; net: Decimal; profit: Decimal; loss: Decimal; fees: Decimal }>();
  for (const trade of trades) {
    if (!isClosed(trade) || trade.net_pnl === null) continue;
    const entry = totals.get(trade.currency) ?? { closed: 0, net: new M(0), profit: new M(0), loss: new M(0), fees: new M(0) };
    const net = new M(trade.net_pnl);
    entry.closed += 1;
    entry.net = entry.net.plus(net);
    if (net.gt(0)) entry.profit = entry.profit.plus(net);
    if (net.lt(0)) entry.loss = entry.loss.minus(net);
    if (trade.fees !== null) entry.fees = entry.fees.plus(trade.fees);
    totals.set(trade.currency, entry);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, entry]) => ({
      currency, closed: entry.closed, netPnl: entry.net.toFixed(), grossProfit: entry.profit.toFixed(), grossLoss: entry.loss.toFixed(), fees: entry.fees.toFixed(),
    }));
}

export interface DayResult {
  /** Strategy day (fixed UTC−5) of the exits. */
  day: string;
  closed: number;
  rTrades: number;
  losingTrades: number;
  netR: string | null;
  money: MoneyTotal[];
  /** `+1.20R · +$120.00` (per currency, never converted); "—" without closed trades. */
  label: string;
}

/** Result of the trades closed on one strategy day (Today's result, account "today"). */
export function dayResult(trades: readonly PerformanceTrade[], day: string): DayResult {
  const closedThatDay = trades.filter(trade => isClosed(trade) && strategyDay(trade.exited_at as string) === day);
  const metrics = rMetrics(closedThatDay);
  const money = moneyByCurrency(closedThatDay);
  const parts = [...(metrics.netR === null ? [] : [formatR(metrics.netR)]), ...money.map(total => formatSignedMoney(total.netPnl, total.currency))];
  return {
    day, closed: closedThatDay.length, rTrades: metrics.completed, losingTrades: closedThatDay.filter(trade => trade.outcome === "LOSS").length,
    netR: metrics.netR, money, label: parts.length ? parts.join(" · ") : "—",
  };
}

export interface CurvePoint {
  sequence: number;
  tradeId: string | null;
  at: string | null;
  r: string | null;
  cumulativeR: string;
  peakR: string;
  /** Peak minus cumulative R (≥ 0), as in V1. */
  drawdownR: string;
  /** Display-only chart value (cumulative R). */
  value: number;
}

/** Cumulative R in exit order, starting at 0R (same points as the V1 curve). */
export function equityCurveR(trades: readonly PerformanceTrade[]): CurvePoint[] {
  const { withR } = closedTrades(trades);
  const points: CurvePoint[] = [{ sequence: 0, tradeId: null, at: null, r: null, cumulativeR: "0", peakR: "0", drawdownR: "0", value: 0 }];
  let equity = new R(0);
  let peak = new R(0);
  withR.forEach((trade, index) => {
    const r = new R(trade.realized_r as string);
    equity = equity.plus(r);
    peak = R.max(peak, equity);
    points.push({
      sequence: index + 1, tradeId: trade.id, at: trade.exited_at, r: r.toFixed(),
      cumulativeR: equity.toFixed(), peakR: peak.toFixed(), drawdownR: peak.minus(equity).toFixed(), value: equity.toNumber(),
    });
  });
  return points;
}

export interface DrawdownPoint {
  sequence: number;
  tradeId: string | null;
  at: string | null;
  /** Distance below the running peak (≥ 0). */
  drawdownR: string;
  /** Display-only chart value: the drawdown below zero (≤ 0). */
  value: number;
}

/** "Where am I giving profits back?" — R drawdown below zero on the exit-ordered sequence. */
export function drawdownSeries(trades: readonly PerformanceTrade[]): DrawdownPoint[] {
  return equityCurveR(trades).map(point => {
    const drawdown = new R(point.drawdownR);
    return { sequence: point.sequence, tradeId: point.tradeId, at: point.at, drawdownR: point.drawdownR, value: drawdown.isZero() ? 0 : drawdown.neg().toNumber() };
  });
}

export interface MoneyAmount {
  currency: string;
  netPnl: string;
  grossLoss: string;
}

interface DayBucket {
  closed: number;
  rTrades: number;
  netR: Decimal;
  money: Map<string, { net: Decimal; loss: Decimal }>;
  tradeIds: string[];
}

function bucketByExitDay(trades: readonly PerformanceTrade[]): Map<string, DayBucket> {
  const days = new Map<string, DayBucket>();
  for (const trade of closedTrades(trades).closed) {
    const day = strategyDay(trade.exited_at as string);
    const bucket: DayBucket = days.get(day) ?? { closed: 0, rTrades: 0, netR: new R(0), money: new Map(), tradeIds: [] };
    bucket.closed += 1;
    bucket.tradeIds.push(trade.id);
    if (trade.realized_r !== null) {
      bucket.rTrades += 1;
      bucket.netR = bucket.netR.plus(trade.realized_r);
    }
    if (trade.net_pnl !== null) {
      const net = new M(trade.net_pnl);
      const money = bucket.money.get(trade.currency) ?? { net: new M(0), loss: new M(0) };
      money.net = money.net.plus(net);
      if (net.lt(0)) money.loss = money.loss.minus(net);
      bucket.money.set(trade.currency, money);
    }
    days.set(day, bucket);
  }
  return days;
}

function moneyAmounts(bucket: DayBucket | undefined): MoneyAmount[] {
  if (!bucket) return [];
  return [...bucket.money.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, money]) => ({ currency, netPnl: money.net.toFixed(), grossLoss: money.loss.toFixed() }));
}

export interface DailyPoint {
  /** Strategy day (fixed UTC−5) of the exits. */
  day: string;
  closed: number;
  rTrades: number;
  excluded: number;
  netR: string | null;
  money: MoneyAmount[];
  tradeIds: string[];
}

/** "Which days drive results?" — closed trades grouped by the strategy day of exit, ascending. */
export function dailySeries(trades: readonly PerformanceTrade[]): DailyPoint[] {
  return [...bucketByExitDay(trades).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, bucket]) => ({
      day, closed: bucket.closed, rTrades: bucket.rTrades, excluded: bucket.closed - bucket.rTrades,
      netR: bucket.rTrades ? bucket.netR.toFixed() : null, money: moneyAmounts(bucket), tradeIds: bucket.tradeIds,
    }));
}

export type CalendarMode = "NET_R" | "NET_PNL" | "GROSS_LOSS" | "COUNT";

export interface CalendarDay {
  day: string;
  inMonth: boolean;
  closed: number;
  rTrades: number;
  /** Cell value for the mode; null when the day has no data for it. */
  value: string | null;
  money: MoneyAmount[];
  tradeIds: string[];
}

export interface CalendarMonth {
  month: string;
  mode: CalendarMode;
  /** Currency of money modes; null when several currencies exist and none was chosen. */
  currency: string | null;
  currencies: string[];
  /** Monday-first weeks covering the month; days outside it are blank. */
  weeks: CalendarDay[][];
  days: CalendarDay[];
  closed: number;
  total: string | null;
  extent: { min: string; max: string } | null;
}

/**
 * Month heatmap by strategy day (UTC−5) of exit. NET_PNL and GROSS_LOSS are per currency:
 * pass `currency` when trades span several currencies (money is never mixed).
 */
export function calendarMonth(trades: readonly PerformanceTrade[], month: string, mode: CalendarMode, options: { currency?: string } = {}): CalendarMonth {
  const dayCount = daysInMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(dayCount).padStart(2, "0")}`;
  const buckets = bucketByExitDay(trades.filter(trade => isClosed(trade) && strategyDay(trade.exited_at as string).startsWith(`${month}-`)));
  const currencies = [...new Set([...buckets.values()].flatMap(bucket => [...bucket.money.keys()]))].sort();
  const currency = options.currency ?? (currencies.length === 1 ? currencies[0] : null);
  const cellValue = (bucket: DayBucket | undefined): Decimal | null => {
    if (!bucket) return null;
    if (mode === "COUNT") return new M(bucket.closed);
    if (mode === "NET_R") return bucket.rTrades ? new M(bucket.netR) : null;
    const money = currency === null ? undefined : bucket.money.get(currency);
    if (!money) return null;
    return mode === "NET_PNL" ? money.net : money.loss;
  };
  const cell = (day: string): CalendarDay => {
    const inMonth = day >= first && day <= last;
    const bucket = inMonth ? buckets.get(day) : undefined;
    const value = cellValue(bucket);
    return {
      day, inMonth, closed: bucket?.closed ?? 0, rTrades: bucket?.rTrades ?? 0, value: value === null ? null : value.toFixed(),
      money: moneyAmounts(bucket), tradeIds: bucket ? [...bucket.tradeIds] : [],
    };
  };
  const start = addDays(first, -weekdayIndex(first));
  const end = addDays(last, 6 - weekdayIndex(last));
  const weeks: CalendarDay[][] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (weekdayIndex(day) === 0) weeks.push([]);
    weeks[weeks.length - 1].push(cell(day));
  }
  const days = weeks.flat().filter(day => day.inMonth);
  const values = days.map(day => day.value).filter((value): value is string => value !== null).map(value => new M(value));
  return {
    month, mode, currency, currencies, weeks, days,
    closed: days.reduce((total, day) => total + day.closed, 0),
    total: values.length ? values.reduce((total, value) => total.plus(value), new M(0)).toFixed() : null,
    extent: values.length ? { min: M.min(...values).toFixed(), max: M.max(...values).toFixed() } : null,
  };
}

export interface DistributionBin {
  /** Inclusive lower bound in R; null for the open-ended lowest bin. */
  from: string | null;
  /** Exclusive upper bound in R; null for the open-ended highest bin. */
  to: string | null;
  label: string;
  count: number;
  /**
   * Trades exactly at 0R (break-even) among `count`; non-zero only in the bin that starts at 0R. Charts and tables
   * treat them as neither profit nor loss.
   */
  breakEven: number;
  tradeIds: string[];
}

export interface DistributionR {
  bins: DistributionBin[];
  count: number;
  excludedNoRiskBasis: number;
}

const BIN_WIDTH = new R("0.5");
/** Bins span −10R … +10R; outliers collect in open-ended edge bins. */
const LOWEST_BIN = -20;
const HIGHEST_BIN = 19;

function signedR(value: Decimal): string {
  return `${value.gt(0) ? "+" : ""}${value.toFixed(1)}R`;
}

/** "How are outcomes distributed?" — 0.5R bins [k·0.5, (k+1)·0.5), contiguous between the extremes. */
export function distributionR(trades: readonly PerformanceTrade[]): DistributionR {
  const { withR, excluded } = closedTrades(trades);
  const keyed = withR.map(trade => {
    const r = new R(trade.realized_r as string);
    return { trade, bin: r.div(BIN_WIDTH).floor().toNumber(), breakEven: r.isZero() };
  });
  if (!keyed.length) return { bins: [], count: 0, excludedNoRiskBasis: excluded };
  const clamped = keyed.map(entry => Math.min(Math.max(entry.bin, LOWEST_BIN - 1), HIGHEST_BIN + 1));
  const low = Math.min(...clamped);
  const high = Math.max(...clamped);
  const bins: DistributionBin[] = [];
  for (let bin = low; bin <= high; bin++) {
    const entries = keyed.filter((_, index) => clamped[index] === bin);
    const members = entries.map(entry => entry.trade.id);
    const breakEven = entries.filter(entry => entry.breakEven).length;
    const from = new R(bin).mul(BIN_WIDTH);
    const to = from.plus(BIN_WIDTH);
    const shared = { count: members.length, breakEven, tradeIds: members };
    if (bin < LOWEST_BIN) bins.push({ from: null, to: to.toFixed(), label: `Below ${signedR(to)}`, ...shared });
    else if (bin > HIGHEST_BIN) bins.push({ from: from.toFixed(), to: null, label: `${signedR(from)} and above`, ...shared });
    else bins.push({ from: from.toFixed(), to: to.toFixed(), label: `${signedR(from)} to ${signedR(to)}`, ...shared });
  }
  return { bins, count: withR.length, excludedNoRiskBasis: excluded };
}

export type BreakdownKey = "model" | "session" | "weekday" | "origin" | "account" | "riskPercent" | "strategyVersion" | "riskPlanVersion" | "instrument" | "direction";

export interface BreakdownGroup {
  key: BreakdownKey;
  /** Raw group value for drill-down filters; null for "unknown". */
  value: string | null;
  label: string;
  closed: number;
  metrics: RMetrics;
  money: MoneyTotal[];
  sample: SampleBand;
  evidence: GroupEvidence;
  /** "Insufficient evidence" (< 10) or "Emerging tendency" (10–29); null at 30+. */
  evidenceLabel: string | null;
  tradeIds: string[];
}

const MODEL_LABELS: Record<string, string> = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other" };
const SESSION_LABELS: Record<string, string> = { ASIA: "Asia", JUDAS: "Judas", ACTIVE_KILL_ZONE: "Kill zone", DEAD_POOL: "Dead Pool" };
const ORIGIN_LABELS: Record<string, string> = { PLANNED: "Planned", LIVE_FIRST: "Live-first", IMPORTED: "Imported" };
const DIRECTION_LABELS: Record<string, string> = { LONG: "Long", SHORT: "Short" };
const FIXED_ORDER: Partial<Record<BreakdownKey, readonly string[]>> = {
  model: ["OB_FIRST_TOUCH", "OTE", "OTHER"],
  session: ["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL"],
  weekday: WEEKDAY_NAMES,
  origin: ["PLANNED", "LIVE_FIRST", "IMPORTED"],
  direction: ["LONG", "SHORT"],
};

export interface BreakdownOptions {
  /** Display names for the account breakdown. */
  accountNames?: Readonly<Record<string, string>>;
}

function groupValue(trade: PerformanceTrade, key: BreakdownKey): string | null {
  switch (key) {
    case "model": return trade.entry_model;
    case "session": return trade.entered_at === null ? null : strategyClock(toDate(trade.entered_at)).session;
    case "weekday": return trade.entered_at === null ? null : WEEKDAY_NAMES[weekdayIndex(strategyDay(trade.entered_at))];
    case "origin": return trade.origin;
    case "account": return trade.account_id;
    case "riskPercent": return trade.requested_risk_percent === null ? null : stripZeros(trade.requested_risk_percent);
    case "strategyVersion": return trade.strategy_version_id;
    case "riskPlanVersion": return trade.risk_plan_version_id;
    case "instrument": return trade.symbol;
    case "direction": return trade.direction;
  }
}

function groupLabel(key: BreakdownKey, value: string | null, sampleTrade: PerformanceTrade, options: BreakdownOptions): string {
  if (value === null) return key === "riskPercent" ? "No planned risk" : "Unknown";
  switch (key) {
    case "model": return MODEL_LABELS[value] ?? value;
    case "session": return SESSION_LABELS[value] ?? value;
    case "origin": return ORIGIN_LABELS[value] ?? value;
    case "direction": return DIRECTION_LABELS[value] ?? value;
    case "account": return options.accountNames?.[value] ?? "Trading account";
    case "riskPercent": return formatPercent(value);
    case "strategyVersion": return sampleTrade.strategy_version ?? "Strategy version";
    case "riskPlanVersion": return sampleTrade.risk_plan_version ?? "Risk plan version";
    default: return value;
  }
}

function compareGroups(key: BreakdownKey, a: BreakdownGroup, b: BreakdownGroup): number {
  if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? 1 : -1;
  const order = FIXED_ORDER[key];
  if (order) {
    const x = order.indexOf(a.value);
    const y = order.indexOf(b.value);
    if (x !== y) return (x === -1 ? order.length : x) - (y === -1 ? order.length : y);
  }
  if (key === "riskPercent") return new M(a.value).comparedTo(b.value);
  return a.label < b.label ? -1 : a.label > b.label ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/** "Which conditions perform?" — closed trades grouped by one dimension, each group with its own N. */
export function breakdown(trades: readonly PerformanceTrade[], key: BreakdownKey, options: BreakdownOptions = {}): BreakdownGroup[] {
  const groups = new Map<string, PerformanceTrade[]>();
  for (const trade of trades.filter(isClosed)) {
    const value = groupValue(trade, key);
    const groupKey = value === null ? "\u0000unknown" : value;
    const members = groups.get(groupKey) ?? [];
    members.push(trade);
    groups.set(groupKey, members);
  }
  return [...groups.values()]
    .map(members => {
      const value = groupValue(members[0], key);
      const metrics = rMetrics(members);
      const { evidence, label: evidenceLabel } = groupEvidence(metrics.completed);
      return {
        key, value, label: groupLabel(key, value, members[0], options), closed: members.length, metrics,
        money: moneyByCurrency(members), sample: metrics.sample, evidence, evidenceLabel,
        tradeIds: [...members].sort(byExit).map(trade => trade.id),
      };
    })
    .sort((a, b) => compareGroups(key, a, b));
}

export interface AccountContribution {
  accountId: string;
  name: string | null;
  currency: string | null;
  closed: number;
  rTrades: number;
  excludedNoRiskBasis: number;
  netR: string | null;
  /** Net P&L in the account's own currency. */
  netPnl: string | null;
  /** Fraction of the combined net R (e.g. "0.25"); only defined when the combined net R is positive. */
  shareOfNetR: string | null;
  sample: SampleBand;
}

/** "Which account contributes most?" — per account trades, net R, own-currency net P&L and share of net R. */
export function accountContribution(trades: readonly PerformanceTrade[], accounts: readonly { id: string; name?: string | null; currency?: string | null }[] = []): AccountContribution[] {
  const byAccount = new Map<string, PerformanceTrade[]>(accounts.map(account => [account.id, []]));
  for (const trade of trades.filter(isClosed)) {
    const members = byAccount.get(trade.account_id) ?? [];
    members.push(trade);
    byAccount.set(trade.account_id, members);
  }
  const combined = rMetrics(trades);
  const combinedNet = combined.netR === null ? null : new R(combined.netR);
  return [...byAccount.entries()].map(([accountId, members]) => {
    const account = accounts.find(entry => entry.id === accountId);
    const metrics = rMetrics(members);
    const money = moneyByCurrency(members);
    const share = metrics.netR !== null && combinedNet?.gt(0) ? new R(metrics.netR).div(combinedNet).toFixed() : null;
    return {
      accountId,
      name: account?.name ?? null,
      currency: account?.currency ?? money[0]?.currency ?? null,
      closed: metrics.closed,
      rTrades: metrics.completed,
      excludedNoRiskBasis: metrics.excludedNoRiskBasis,
      netR: metrics.netR,
      netPnl: money.length === 1 ? money[0].netPnl : null,
      shareOfNetR: share,
      sample: metrics.sample,
    };
  });
}
