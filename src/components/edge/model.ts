import { ALL_ACCOUNTS_SCOPE, exportHref, TOO_MANY_TRADES } from "@/app/edge/export/contract";
import type { DrawdownPoint } from "@/components/charts/line-chart";
import type { ChartDatum, HistogramBin } from "@/components/charts/types";
import { evidenceHref } from "@/components/evidence/gallery-model";
import { SESSION_LABELS } from "@/components/shell/session-labels";
import type { StatusTone } from "@/components/ui/badge";
import { formatMoney, formatR, formatSignedMoney, formatSignedMoneyList, plural } from "@/domain/format";
import { ENTRY_MODELS, type EntryModel, type LedgerTrade, type TradeOrigin } from "@/domain/ledger";
import { type BreakdownKey, type DistributionBin, EARLY_SAMPLE_NOTE, groupEvidence, type RMetrics } from "@/domain/performance";
import { formatDay, strategyDay } from "@/domain/time-display";
import { deriveTradeState } from "@/domain/trade-state";
import type { AccountContext, ContextAccount } from "@/lib/account-context";
import { type LinkedBreakdownGroup, type PerformanceView, R_LABEL } from "@/lib/performance-data";
import { evidenceSource, journalHref, resolveAccountFilter } from "@/lib/trades-data";
import type { EdgeData } from "./edge-data";
import { formatDrawdownR, formatProfitFactor, formatRate, formatShare, type SignTone, sampleWords, signTone } from "./format";
import { type EdgeQuery, RANGE_LABELS } from "./query";

/**
 * Presentation model of EDGE (docs/V2_ARCHITECTURE.md §13.6–13.8, §14.6): every label pre-formatted with the domain
 * formatters, every chart mark with its sample and its drill-down link, and no ids, codes or enums in any text.
 * Pure (server side); the components only lay it out.
 */

export const MODEL_LABELS: Record<EntryModel, string> = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other model" };
export const ORIGIN_LABELS: Record<TradeOrigin, string> = { PLANNED: "Planned", LIVE_FIRST: "Live-first", IMPORTED: "Imported" };
export { SESSION_LABELS };
const DIRECTION_LABELS = { LONG: "Long", SHORT: "Short" } as const;
const isEntryModel = (value: string): value is EntryModel => (ENTRY_MODELS as readonly string[]).includes(value);

/** Comparisons need this many trades with R in every group before they are drawn (§13.8). */
export const COMPARISON_MINIMUM = 10;

// ---------------------------------------------------------------------------------------------------------
// Scope and period.
// ---------------------------------------------------------------------------------------------------------
export function isAllAccounts(context: AccountContext): boolean {
  return context.selected.mode === "all";
}

/**
 * "All Accounts · 3 trading accounts", "FTMO 100K · USD", or the one account the read-only account filter narrows All
 * Accounts to: "Personal 12K · EUR · archived" (an account the user cannot read leaves All Accounts; its chip says so).
 */
export function scopeLabel(context: AccountContext, query: Pick<EdgeQuery, "accountFilter"> = {}): string {
  if (context.selected.mode === "account") return `${context.selected.account.name} · ${context.selected.account.currency}`;
  const filter = resolveAccountFilter({ accountFilter: query.accountFilter }, context).state;
  if (filter.kind === "account") {
    const { name, currency, status } = filter.account;
    return [name, currency, ...(status === "ARCHIVED" ? ["archived"] : [])].join(" · ");
  }
  return `All Accounts · ${plural(context.accounts.length, "trading account")}`;
}

/** "Last 30 days · Sep 24 – Oct 23" (exit days, UTC−5); "All time · every closed trade" without a range. */
export function periodLabel(query: EdgeQuery, now: string): string {
  const name = RANGE_LABELS[query.range];
  const thisYear = strategyDay(now).slice(0, 4);
  const day = (value: string) => formatDay(value, undefined, { year: value.slice(0, 4) !== thisYear });
  if (query.closedFrom && query.closedTo) return `${name} · ${day(query.closedFrom)} – ${day(query.closedTo)}`;
  if (query.closedFrom) return `${name} · from ${day(query.closedFrom)}`;
  if (query.closedTo) return `${name} · through ${day(query.closedTo)}`;
  return `${name} · every closed trade`;
}

function directory(context: AccountContext): Map<string, string> {
  return new Map(context.accounts.map(account => [account.id, account.name]));
}

function tradeTitle(trade: Pick<LedgerTrade, "symbol" | "direction">): string {
  const symbol = trade.symbol ?? "Instrument not recorded";
  return trade.direction ? `${symbol} · ${DIRECTION_LABELS[trade.direction]}` : symbol;
}

// ---------------------------------------------------------------------------------------------------------
// Headline.
// ---------------------------------------------------------------------------------------------------------
export interface HeadlineStat {
  key: string;
  label: string;
  value: string;
  /** Colour of a signed result (the sign is printed too); null for neutral figures. */
  tone: SignTone | null;
  hint: string;
  /** De-emphasised below ten trades (§13.8). */
  early: boolean;
  large?: boolean;
}

export interface HeadlineMoney {
  currency: string;
  label: string;
  tone: SignTone | null;
  detail: string;
}

export interface HeadlineModel {
  stats: HeadlineStat[];
  money: HeadlineMoney[];
  /** Sample caveat, excluded trades, All Accounts R label: full sentences. */
  notes: string[];
}

export function headlineModel(view: PerformanceView, allAccounts: boolean): HeadlineModel {
  const m = view.metrics;
  const early = view.earlySample;
  const excluded = m.excludedNoRiskBasis;
  const stats: HeadlineStat[] = [
    { key: "netR", label: "Net R", value: formatR(m.netR), tone: signTone(m.netR), hint: `${plural(m.completed, "trade")} with recorded risk`, early: false, large: true },
    { key: "expectancy", label: "Expectancy", value: formatR(m.expectancy), tone: early ? null : signTone(m.expectancy), hint: "Average R per trade", early },
    { key: "winRate", label: "Win rate", value: formatRate(m.winRate), tone: null, hint: `${m.wins} won · ${m.losses} lost · ${m.breakevens} break‑even` /* non-breaking hyphen */, early },
    { key: "profitFactor", label: "Profit factor", value: formatProfitFactor(m), tone: null, hint: "Gross win R ÷ gross loss R", early },
    { key: "maxDrawdown", label: "Max R drawdown", value: formatDrawdownR(m.maxDrawdown), tone: null, hint: "Largest fall from a peak", early: false },
    { key: "closed", label: "Closed trades", value: String(m.closed), tone: null, hint: excluded ? `${excluded} without recorded risk` : "All with recorded risk", early: false },
  ];
  const money = view.money.map(total => ({
    currency: total.currency,
    label: formatSignedMoney(total.netPnl, total.currency),
    tone: signTone(total.netPnl),
    detail: `${total.currency} · ${plural(total.closed, "trade")} · fees ${formatMoney(total.fees, total.currency)}`,
  }));
  const notes = [
    m.completed > 0 && m.completed < 10 ? `${plural(m.completed, "completed trade")}. ${EARLY_SAMPLE_NOTE}` : view.sampleCaveat,
    ...(excluded > 0 ? [`${plural(excluded, "closed trade")} without a recorded risk ${excluded === 1 ? "is" : "are"} excluded from R statistics.`] : []),
    ...(allAccounts ? [`${R_LABEL}.`] : []),
    ...(view.money.length > 1 ? ["Money is shown per currency and never converted or added across currencies."] : []),
  ];
  return { stats, money, notes };
}

// ---------------------------------------------------------------------------------------------------------
// Results over time.
// ---------------------------------------------------------------------------------------------------------
/** "38 trades with recorded risk · developing sample". */
export function rSampleLabel(view: PerformanceView, allAccounts: boolean): string {
  const m = view.metrics;
  return [
    `${plural(m.completed, "trade")} with recorded risk · ${sampleWords(m.completed)}`,
    ...(m.excludedNoRiskBasis ? [`${m.excludedNoRiskBasis} without risk excluded`] : []),
    ...(allAccounts ? ["R is per-trade risk units"] : []),
  ].join(" · ");
}

/** The drawdown's sample (§13.6: every chart shows its sample size). */
export function drawdownSampleLabel(view: PerformanceView): string {
  return `${plural(view.metrics.completed, "trade")} with recorded risk · distance below the running peak`;
}

/** The trades behind the headline figures, in the Journal (the page's filters, closed and reviewed trades). */
export function resultsJournalLink(data: Pick<EdgeData, "filters" | "view">): { label: string; href: string } | null {
  const closed = data.view?.closedCount ?? 0;
  if (closed === 0) return null;
  return {
    label: closed === 1 ? "Open this trade in the Journal" : `Open these ${closed} trades in the Journal`,
    href: journalHref({ ...data.filters, states: ["CLOSED", "REVIEWED"] }),
  };
}

/** Filtered page without closed trades: what to change, naming the date range only when one is set. */
export function noMatchDescription(query: EdgeQuery, now: string): string {
  const dimensions = [query.model, query.session, query.origin, query.instrument].filter(Boolean).length;
  // All time (or a custom range without bounds): the date range excludes nothing.
  if (!query.closedFrom && !query.closedTo) return "Remove a filter to see results.";
  const period = periodLabel(query, now);
  return dimensions > 0 ? `${period}. Widen the date range or remove a filter to see results.` : `${period}. Widen the date range to see results.`;
}

export interface CurveData {
  cumulative: ChartDatum[];
  drawdown: DrawdownPoint[];
}

/** Cumulative R and drawdown in exit order; each point opens its trade. */
export function curveData(view: PerformanceView, rows: readonly LedgerTrade[], context: AccountContext): CurveData {
  const byId = new Map(rows.map(row => [row.id, row]));
  const names = directory(context);
  const multi = isAllAccounts(context) && context.accounts.length > 1;
  const cumulative: ChartDatum[] = [];
  const drawdown: DrawdownPoint[] = [];
  for (const point of view.curve) {
    const trade = point.tradeId ? byId.get(point.tradeId) : undefined;
    const label = trade?.exited_at ? formatDay(strategyDay(trade.exited_at)) : "Start";
    const detail = trade
      ? [`Trade ${point.sequence}`, tradeTitle(trade), ...(multi ? [names.get(trade.account_id) ?? "Trading account"] : []), `${formatR(point.r)} on the trade`].join(" · ")
      : "Before the first trade";
    const href = point.tradeId ? `/trades/${point.tradeId}` : undefined;
    const key = point.tradeId ?? "start";
    cumulative.push({ key, label, value: point.cumulativeR, valueLabel: formatR(point.cumulativeR), detail, ...(href ? { href } : {}) });
    drawdown.push({ key, label, value: point.drawdownR, detail, ...(href ? { href } : {}) });
  }
  return { cumulative, drawdown };
}

export interface DailyData {
  r: ChartDatum[];
  money: { currency: string; data: ChartDatum[] }[];
  days: number;
}

/** Daily net R and net P&L per currency (strategy day of the exit). */
export function dailyData(view: PerformanceView, rows: readonly LedgerTrade[]): DailyData {
  const byId = new Map(rows.map(row => [row.id, row]));
  const currencies = [...new Set(view.money.map(total => total.currency))];
  const r = view.daily.map(point => ({
    key: point.day,
    label: formatDay(point.day),
    value: point.netR,
    valueLabel: point.netR === null ? "No recorded risk" : formatR(point.netR),
    detail: [plural(point.closed, "trade"), ...(point.excluded ? [`${point.excluded} without risk`] : []), formatSignedMoneyList(point.money.map(money => ({ currency: money.currency, amount: money.netPnl })))].join(" · "),
    href: point.href,
  }));
  const money = currencies.map(currency => ({
    currency,
    data: view.daily.flatMap(point => {
      const amount = point.money.find(entry => entry.currency === currency);
      if (!amount) return [];
      const trades = point.tradeIds.map(id => byId.get(id)).filter(trade => trade?.currency === currency);
      const excluded = withoutRiskLabel(trades.filter(trade => trade?.realized_r === null).length);
      return [{
        key: point.day, label: formatDay(point.day), value: amount.netPnl, valueLabel: formatSignedMoney(amount.netPnl, currency),
        detail: [plural(trades.length, "trade"), ...(excluded ? [excluded] : []), ...(point.netR !== null ? [formatR(point.netR)] : [])].join(" · "), href: point.href,
      }];
    }),
  }));
  return { r, money, days: view.daily.length };
}

/**
 * 0.5R bins, each opening the Journal on its trades. The bin starting at 0R also holds the break-even trades (exactly
 * 0R); its count says how many, so the words never read as profit for them.
 */
export function distributionBins(view: PerformanceView, rows: readonly LedgerTrade[]): HistogramBin[] {
  const realized = new Map(rows.map(row => [row.id, row.realized_r]));
  const bins: readonly (DistributionBin & { href: string })[] = view.distribution.bins;
  return bins.map(bin => {
    const breakEven = signTone(bin.from) === "zero" ? bin.tradeIds.filter(id => signTone(realized.get(id)) === "zero").length : 0;
    return {
      key: `${bin.from ?? "open"}:${bin.to ?? "open"}`, label: bin.label, from: bin.from, to: bin.to, count: bin.count,
      countLabel: breakEven ? `${plural(bin.count, "trade")} · ${breakEven} break-even (0R)` : plural(bin.count, "trade"), href: bin.href,
      breakEven,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Breakdowns ("Which conditions perform?").
// ---------------------------------------------------------------------------------------------------------
export interface BreakdownSection {
  key: BreakdownKey;
  title: string;
  question: string;
  categoryLabel: string;
  data: ChartDatum[];
  sample: string;
  /** Replaces the bars, for example when a comparison lacks evidence. */
  empty?: { title: string; description: string; links: { label: string; href: string }[] };
}

const BREAKDOWN_COPY: Record<Exclude<BreakdownKey, "instrument" | "direction" | "account">, { title: string; category: string }> = {
  model: { title: "Net R by model", category: "Model" },
  session: { title: "Net R by entry session", category: "Session" },
  weekday: { title: "Net R by entry weekday", category: "Weekday" },
  origin: { title: "Planned vs Live-first", category: "Origin" },
  riskPercent: { title: "Net R by planned risk", category: "Planned risk" },
  strategyVersion: { title: "Net R by strategy version", category: "Strategy version" },
  riskPlanVersion: { title: "Net R by risk plan version", category: "Risk plan version" },
};

const NULL_LABELS: Partial<Record<BreakdownKey, string>> = {
  model: "Model not recorded",
  session: "Entry time unknown",
  weekday: "Entry time unknown",
  strategyVersion: "No locked plan",
  riskPlanVersion: "No locked plan",
};

const QUESTION = "Which conditions perform?";

/** "5 without risk": closed trades of a group that are not in its N (no recorded risk, so no R); null when none. */
export function withoutRiskLabel(excluded: number): string | null {
  return excluded > 0 ? `${excluded} without risk` : null;
}

/**
 * "N = 12 · Emerging tendency", or "N = 10 · 5 without risk · Emerging tendency": every group carries its own sample
 * (§13.8), and the closed trades its N leaves out for lack of a recorded risk are counted where it is shown (§9.3).
 */
export function groupDetail(group: Pick<LinkedBreakdownGroup, "metrics" | "evidenceLabel">): string {
  const excluded = withoutRiskLabel(group.metrics.excludedNoRiskBasis);
  return [`N = ${group.metrics.completed}`, ...(excluded ? [excluded] : []), ...(group.evidenceLabel ? [group.evidenceLabel] : [])].join(" · ");
}

/** A breakdown card's sample: its closed trades, and what N counts when some of them have no recorded risk. */
export function breakdownSample(metrics: Pick<RMetrics, "closed" | "excludedNoRiskBasis">): string {
  const closed = plural(metrics.closed, "closed trade");
  return metrics.excludedNoRiskBasis > 0 ? `${closed} · N counts trades with recorded risk` : closed;
}

/** "Live-first: 10 of 15 trades with recorded risk" (every closed trade counted, the excluded ones visibly). */
function originCount(group: LinkedBreakdownGroup): string {
  const { completed, closed } = group.metrics;
  return completed === closed ? `${group.label}: ${plural(completed, "trade")} with recorded risk` : `${group.label}: ${completed} of ${closed} trades with recorded risk`;
}

function groupLabel(group: LinkedBreakdownGroup, accountOf: (tradeId: string) => string | null): string {
  if (group.value === null) return NULL_LABELS[group.key] ?? group.label;
  // The same words as the model filter.
  if (group.key === "model") return isEntryModel(group.value) ? MODEL_LABELS[group.value] : group.label;
  if (group.key === "strategyVersion" || group.key === "riskPlanVersion") {
    // The chart title already says "risk plan version": "V1.1 · FTMO 100K" keeps the account visible in narrow rows.
    const name = group.key === "riskPlanVersion" ? group.label.replace(/^Risk Plan\s+/i, "") : group.label;
    const account = group.tradeIds.length ? accountOf(group.tradeIds[0]) : null;
    return account ? `${name} · ${account}` : name;
  }
  return group.label;
}

function groupDatum(group: LinkedBreakdownGroup, label: string): ChartDatum {
  return {
    key: `${group.key}:${group.value ?? "none"}`, label, value: group.metrics.netR,
    valueLabel: group.metrics.netR === null ? "No recorded risk" : formatR(group.metrics.netR), detail: groupDetail(group),
    ...(group.href ? { href: group.href } : {}),
  };
}

/**
 * Planned vs Live-first is drawn only when every origin present has at least ten trades with recorded risk;
 * otherwise it says "Insufficient evidence" with each group's count (§13.8, §14.6).
 */
export function originSection(groups: readonly LinkedBreakdownGroup[], metrics: Pick<RMetrics, "closed" | "excludedNoRiskBasis">, originFilter?: OriginFilter): BreakdownSection {
  const copy = BREAKDOWN_COPY.origin;
  const base = { key: "origin" as const, title: copy.title, question: "Does planning before entry change results?", categoryLabel: copy.category, sample: breakdownSample(metrics) };
  const counts = groups.map(originCount).join(" · ");
  const links = groups.flatMap(group => (group.href ? [{ label: `Open ${group.label} trades in the Journal`, href: group.href }] : []));
  if (originFilter) {
    return {
      ...base, data: [],
      empty: {
        title: `Showing ${originFilter.label} trades only`,
        description: "The origin filter leaves one group, so there is nothing to compare. Remove it to compare planned and live-first trades.",
        links: [{ label: "Remove the origin filter", href: originFilter.clearHref }],
      },
    };
  }
  if (groups.length < 2) {
    return {
      ...base, data: [],
      empty: {
        title: "Nothing to compare yet",
        description: `${counts || "No closed trades"}. The comparison appears once planned and live-first trades both have at least ${COMPARISON_MINIMUM} closed trades with recorded risk.`,
        links,
      },
    };
  }
  if (groups.some(group => groupEvidence(group.metrics.completed).evidence === "INSUFFICIENT")) {
    return {
      ...base, data: [],
      empty: {
        title: "Insufficient evidence",
        description: `${counts}. Each group needs at least ${COMPARISON_MINIMUM} closed trades with recorded risk before they are compared.`,
        links,
      },
    };
  }
  return { ...base, data: groups.map(group => groupDatum(group, group.label)) };
}

/** The page's origin filter: the comparison cannot be drawn while it is set. */
export interface OriginFilter {
  label: string;
  /** The page without the origin filter. */
  clearHref: string;
}

/** Every breakdown of the page in display order, with account contribution in All Accounts. */
export function breakdownSections(view: PerformanceView, rows: readonly LedgerTrade[], context: AccountContext, originFilter?: OriginFilter): BreakdownSection[] {
  const names = directory(context);
  const accountByTrade = new Map(rows.map(row => [row.id, row.account_id]));
  const multi = isAllAccounts(context) && new Set(rows.map(row => row.account_id)).size > 1;
  const accountOf = (tradeId: string) => {
    if (!multi) return null;
    const accountId = accountByTrade.get(tradeId);
    return accountId ? (names.get(accountId) ?? "Trading account") : null;
  };
  const sections: BreakdownSection[] = [];
  for (const key of ["model", "session", "weekday", "origin", "riskPercent", "strategyVersion", "riskPlanVersion"] as const) {
    const groups = view.breakdowns[key] ?? [];
    if (key === "origin") {
      sections.push(originSection(groups, view.metrics, originFilter));
      if (view.contribution) sections.push(contributionSection(view));
      continue;
    }
    const copy = BREAKDOWN_COPY[key];
    sections.push({
      key, title: copy.title, question: QUESTION, categoryLabel: copy.category, sample: breakdownSample(view.metrics),
      data: groups.map(group => groupDatum(group, groupLabel(group, accountOf))),
    });
  }
  return sections;
}

/** All Accounts: each account's net R, own-currency net P&L and share of the combined net R. */
export function contributionSection(view: PerformanceView): BreakdownSection {
  const entries = view.contribution ?? [];
  // Shares read as parts of a whole only when no account subtracts from it (otherwise one could exceed 100%).
  const shares = entries.some(entry => entry.shareOfNetR !== null) && entries.every(entry => signTone(entry.netR) !== "neg");
  return {
    key: "account",
    title: "Account contribution",
    question: "Which account contributes most?",
    categoryLabel: "Trading account",
    sample: shares ? `Net R and share of the combined net R · ${R_LABEL}` : `Net R per account · ${R_LABEL}`,
    data: entries.map(entry => {
      const valueLabel = entry.netR === null ? "No recorded risk" : formatR(entry.netR);
      const money = entry.netPnl !== null && entry.currency ? formatSignedMoney(entry.netPnl, entry.currency) : null;
      // The P&L covers every closed trade of the account, N only those with a recorded risk: both counts are shown.
      const excluded = withoutRiskLabel(entry.excludedNoRiskBasis);
      return {
        key: `account:${entry.accountId}`,
        label: entry.name ?? "Trading account",
        value: entry.netR,
        valueLabel: shares && entry.shareOfNetR !== null ? `${valueLabel} · ${formatShare(entry.shareOfNetR)}` : valueLabel,
        detail: entry.closed === 0 ? "No closed trades" : [`N = ${entry.rTrades}`, ...(excluded ? [excluded] : []), ...(money ? [money] : [])].join(" · "),
        href: entry.href,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Calendar (client component props: plain, serialisable data).
// ---------------------------------------------------------------------------------------------------------
export interface CalendarTrade {
  id: string;
  href: string;
  title: string;
  /** Account name in All Accounts; null in a single account. */
  account: string | null;
  model: string | null;
  origin: string;
  originNote: string | null;
  state: { label: string; tone: StatusTone };
  /** Exit instant; the client formats it with the time display. */
  exitedAt: string;
  rLabel: string;
  rTone: SignTone | null;
  pnlLabel: string;
  pnlTone: SignTone | null;
  evidenceCount: number;
  /** Opens the trade's evidence viewer on the cover screenshot. */
  evidenceHref: string | null;
  thumbSrc: string | null;
}

export interface CalendarMoney {
  currency: string;
  net: string;
  netLabel: string;
  loss: string;
  lossLabel: string;
}

export interface CalendarDayModel {
  day: string;
  /** "Wed, Oct 14". */
  label: string;
  closed: number;
  /** Closed trades with a recorded risk: the ones `netR` sums. */
  rTrades: number;
  netR: string | null;
  /** "-1.05R"; null when no trade of the day has a recorded risk. */
  rLabel: string | null;
  /** The day's R with its coverage: "-1.05R", "-1.05R (1 of 2 with risk)" or "No recorded risk". */
  rDetail: string;
  money: CalendarMoney[];
  /** "2 trades". */
  countLabel: string;
  /** "1 without risk" when some of the day's trades have no R; null otherwise. */
  withoutRisk: string | null;
  journalHref: string | null;
  trades: CalendarTrade[];
}

/** "-1.05R (1 of 2 with risk)": the R of a day or group never reads as covering trades it leaves out. */
export function rCoverage(netR: string | null, rTrades: number, closed: number): string {
  if (netR === null || rTrades === 0) return "No recorded risk";
  return rTrades < closed ? `${formatR(netR)} (${rTrades} of ${closed} with risk)` : formatR(netR);
}

export interface CalendarModel {
  month: string;
  previousMonth: string;
  nextMonth: string;
  /** Strategy day of the server time. */
  today: string;
  days: CalendarDayModel[];
  currencies: string[];
  /** Currency of the money modes by default: the one with the most closed trades this month. */
  defaultCurrency: string | null;
  closed: number;
  /** Filter parameters the calendar's month and mode links extend. */
  baseQuery: string;
  multiAccount: boolean;
  /** The selected date range (exit days): days outside it are dimmed, since their trades are filtered out. */
  rangeFrom: string | null;
  rangeTo: string | null;
}

function calendarTrade(trade: LedgerTrade, now: string, names: Map<string, string>, multi: boolean): CalendarTrade {
  const state = deriveTradeState(trade, { now, checkCurrent: false });
  const cover = trade.cover_evidence_id && trade.cover_evidence_kind ? trade.cover_evidence_id : null;
  return {
    id: trade.id,
    href: `/trades/${trade.id}`,
    title: tradeTitle(trade),
    account: multi ? (names.get(trade.account_id) ?? "Trading account") : null,
    model: trade.entry_model ? MODEL_LABELS[trade.entry_model] : null,
    origin: state.originLabel,
    originNote: state.originTooltip,
    state: { label: state.label, tone: state.tone },
    exitedAt: trade.exited_at as string,
    rLabel: trade.realized_r === null ? "No R · risk not recorded" : formatR(trade.realized_r),
    rTone: signTone(trade.realized_r),
    pnlLabel: trade.net_pnl === null ? "—" : formatSignedMoney(trade.net_pnl, trade.currency),
    pnlTone: signTone(trade.net_pnl),
    evidenceCount: trade.evidence_count,
    evidenceHref: cover ? `/trades/${trade.id}${evidenceHref(cover)}` : null,
    thumbSrc: cover && trade.cover_evidence_kind ? evidenceSource(trade.cover_evidence_kind, cover).thumbSrc : null,
  };
}

export function calendarModel(data: EdgeData, baseQuery: string): CalendarModel | null {
  const { view, rows, context, query, now } = data;
  if (!view) return null;
  const names = directory(context);
  const multi = isAllAccounts(context) && context.accounts.length > 1;
  const byId = new Map(rows.map(row => [row.id, row]));
  const days = view.calendar.days.filter(day => day.closed > 0).map(day => {
    const trades = day.tradeIds
      .map(id => byId.get(id))
      .filter((trade): trade is LedgerTrade => trade !== undefined && trade.exited_at !== null)
      .sort((a, b) => (a.exited_at as string) < (b.exited_at as string) ? -1 : (a.exited_at as string) > (b.exited_at as string) ? 1 : 0)
      .map(trade => calendarTrade(trade, now, names, multi));
    return {
      day: day.day,
      label: formatDay(day.day, undefined, { weekday: true }),
      closed: day.closed,
      rTrades: day.rTrades,
      netR: day.value,
      rLabel: day.value === null ? null : formatR(day.value),
      rDetail: rCoverage(day.value, day.rTrades, day.closed),
      money: day.money.map(money => ({
        currency: money.currency, net: money.netPnl, netLabel: formatSignedMoney(money.netPnl, money.currency),
        loss: money.grossLoss, lossLabel: formatMoney(money.grossLoss, money.currency),
      })),
      countLabel: plural(day.closed, "trade"),
      withoutRisk: withoutRiskLabel(day.closed - day.rTrades),
      journalHref: day.href,
      trades,
    };
  });
  const perCurrency = new Map<string, number>();
  for (const day of view.calendar.days) for (const id of day.tradeIds) {
    const currency = byId.get(id)?.currency;
    if (currency) perCurrency.set(currency, (perCurrency.get(currency) ?? 0) + 1);
  }
  const defaultCurrency = view.calendar.currencies.reduce<string | null>(
    (best, currency) => (best === null || (perCurrency.get(currency) ?? 0) > (perCurrency.get(best) ?? 0) ? currency : best),
    null,
  );
  return {
    month: view.calendar.month,
    previousMonth: view.calendar.previousMonth,
    nextMonth: view.calendar.nextMonth,
    today: strategyDay(now),
    days,
    currencies: view.calendar.currencies,
    defaultCurrency,
    closed: view.calendar.closed,
    baseQuery,
    multiAccount: multi,
    rangeFrom: query.closedFrom ?? null,
    rangeTo: query.closedTo ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------------------------------------
export interface ExportLink {
  label: string;
  detail: string;
  href: string;
}

/** "12 trades · USD, EUR": what a file holds (money columns stay in each trade's account currency). */
function exportDetail(trades: readonly LedgerTrade[]): string {
  return `${plural(trades.length, "trade")} · ${[...new Set(trades.map(trade => trade.currency))].sort().join(", ")}`;
}

/** The trading account a file holds, as the account filter names it: "Personal 12K", "Old prop · archived". */
function exportAccountLabel(account: Pick<ContextAccount, "name" | "status">): string {
  return account.status === "ARCHIVED" ? `${account.name} · archived` : account.name;
}

/**
 * CSV links (`GET /edge/export`): the file of exactly what the page counts (every origin, the page's filters with its
 * effective exit days, the selected account or All Accounts) and, in All Accounts with trades in several accounts, one
 * file per account that has trades on the page. Every file is labelled with what it holds: when the read-only account
 * filter narrows All Accounts to one account, the page's file is that account's (the link keeps the page's filter).
 * A filter naming an account the user cannot read matches no trade, so no file is offered.
 */
export function exportLinks(data: Pick<EdgeData, "context" | "query" | "rows">): ExportLink[] {
  const { context, query, rows } = data;
  if (context.selected.mode === "account") {
    const { account } = context.selected;
    return [{ label: exportAccountLabel(account), detail: exportDetail(rows), href: exportHref(query, account.id) }];
  }
  const filter = resolveAccountFilter({ accountFilter: query.accountFilter }, context).state;
  if (filter.kind === "unavailable") return [];
  const page: ExportLink = {
    label: filter.kind === "account" ? exportAccountLabel(filter.account) : "All Accounts",
    detail: exportDetail(rows),
    href: exportHref(query, ALL_ACCOUNTS_SCOPE),
  };
  const perAccount = context.accounts
    .map(account => ({ account, trades: rows.filter(row => row.account_id === account.id) }))
    .filter(entry => entry.trades.length > 0);
  if (perAccount.length < 2) return [page];
  return [page, ...perAccount.map(({ account, trades }) => ({ label: exportAccountLabel(account), detail: exportDetail(trades), href: exportHref(query, account.id) }))];
}

/**
 * Why EDGE offers no file: its read stopped at the row limit (`truncated`), so the page counts only part of the
 * matching trades and the export refuses a partial file. Undefined when the files are offered.
 */
export function exportUnavailable(data: Pick<EdgeData, "truncated">): string | undefined {
  return data.truncated ? TOO_MANY_TRADES : undefined;
}
