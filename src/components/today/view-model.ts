import Decimal from "decimal.js";
import { LIVE_TRADE_HREF, PLAN_TRADE_HREF } from "@/components/shell/navigation";
import { TRADE_TARGETS } from "@/components/trade/reveal";
import { ACCOUNT_TYPE_LABELS } from "@/domain/account-metrics";
import type { DailyReason, DailyStatus } from "@/domain/daily-status";
import {
  formatMoney,
  formatMoneyAgainst,
  formatMoneyExact,
  formatMoneyUp,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatR,
  formatSignedMoney,
  plural,
  stripZeros,
} from "@/domain/format";
import type { LedgerTrade } from "@/domain/ledger";
import { dayResult, isClosed } from "@/domain/performance";
import type { Instrument } from "@/domain/risk";
import {
  compareInstants, displayDay, formatDateTime, formatDay, formatRelative, formatTime, type Instant, strategyDay, type TimeDisplay, zoneLabel,
} from "@/domain/time-display";
import { buildTimeline } from "@/domain/timeline";
import type { TradeTone } from "@/domain/trade-state";
import type { ContextAccount } from "@/lib/account-context";
import type { LiveTradeCard, TodayAccountStatus, TodayData } from "@/lib/today-data";
import { journalHref, type TradeListRow } from "@/lib/trades-data";
import type { AccountWorkspace } from "@/lib/workspace";
import { NOT_RECORDED, RISK_NOT_RECORDED } from "./copy";
import type { LiveManagement, PartialClose, StopMove } from "./management";
import type {
  AccountStatusView, AccountValuesView, ClosedTradeView, DaySummaryView, LiveFactView, LiveTradeView, LossesView, NotesView, PillTone, PlanActionView,
  PlanReasonView, PlanRowView, PlansView, ReasonAction, ReasonView, StatView, TodayView, ValueText, ValueTone,
} from "./types";

/**
 * Builds the Today view (docs/V2_ARCHITECTURE.md §14.1) from the data layer's `TodayData` (src/lib/today-data.ts) plus
 * the exact instrument versions of the listed trades, the first blocking reason of each blocked draft and how each live
 * position was managed (stop moves, partial closes). Pure: every decimal is formatted through src/domain/format (never
 * through binary floating point), every time through the person's time display, and each verdict comes from the domain
 * (`dailyStatusV2`, `deriveTradeState`), so Today never invents a restriction or contradicts the Risk Engine.
 */

const D = Decimal.clone({ precision: 100 });
/** Active screenshots one trade can hold (`register_trade_evidence`). */
const SCREENSHOT_LIMIT = 24;
/** Drafts last touched before today that Today lists; the Journal lists every draft. */
export const OLDER_DRAFTS_SHOWN = 25;
/** Up to this many older drafts stay in view; more are folded so they never bury today's plans. */
export const OLDER_DRAFTS_INLINE = 5;

export interface TodayModelInput {
  data: TodayData;
  display: TimeDisplay;
  /** Exact instrument versions of the listed trades, by id (tick size, size step and unit for display). */
  instruments: ReadonlyMap<string, Instrument>;
  /** First blocking reason of each blocked draft (`explainReport(...).blocking[0].detail`), by trade id. */
  blockingReasons: ReadonlyMap<string, string>;
  /** Stop moves and partial closes of the live trades, by trade id (none when they could not be read). */
  management?: ReadonlyMap<string, LiveManagement>;
  /** Idempotency keys of the live journal composers. */
  requestKey: () => string;
}

export const NO_RISK_PLAN_HEADLINE = "Set up a risk plan to trade";
export const STRATEGY_MISSING_COPY = "This account has no ICT V1.0 strategy version, so its plans can't be checked.";
export const INSTRUMENTS_MISSING_COPY = "Add an instrument to this account before planning trades.";
export const RISK_PLAN_MISSING_COPY = "This account has no risk plan yet. Create one to check and lock plans.";

function signTone(value: string): ValueTone {
  const number = new D(value);
  return number.isZero() ? "neutral" : number.isNegative() ? "neg" : "pos";
}

/**
 * Money at risk (a plan's risk at the stop, a position's initial risk), rounded up to the cent as the trade page, the
 * plan preview and the engine's sentences show it (§6.6): the same plan never reads as risking less here.
 */
function riskMoney(value: string, currency: string): string {
  return formatMoneyUp(value, currency);
}

function pillTone(tone: TradeTone): PillTone {
  return tone === "danger" ? "negative" : tone;
}

/** "Evaluation · FTMO · USD". */
export function accountMeta(account: ContextAccount): string {
  return [ACCOUNT_TYPE_LABELS[account.type], account.broker, account.currency].filter(Boolean).join(" · ");
}

/** `/today?account=<id>`: switches the context to one account (the proxy stores it; never prefetch it). */
export function focusHref(accountId: string): string {
  return `/today?account=${encodeURIComponent(accountId)}`;
}

function manageHref(accountId: string, tab?: "account-values" | "external-losses" | "risk-policy" | "instruments"): string {
  const base = `/accounts/${encodeURIComponent(accountId)}/manage`;
  return tab ? `${base}?tab=${tab}` : base;
}

/** A place on the trade page (the trade workspace's section anchors). */
function tradeTarget(href: string, target: string): string {
  return `${href}#${target}`;
}

/** "Long" / "Short". */
function directionLabel(direction: LedgerTrade["direction"]): string | null {
  return direction === "LONG" ? "Long" : direction === "SHORT" ? "Short" : null;
}

function tradeTitle(trade: LedgerTrade): string {
  const direction = directionLabel(trade.direction);
  const symbol = trade.symbol ?? "Unknown instrument";
  return direction ? `${symbol} · ${direction}` : symbol;
}

/** "lots" of "lots (100,000 EUR)". */
function unitWord(unit: string | null | undefined): string {
  return unit?.split(" (")[0]?.trim() ?? "";
}

interface Formatter {
  display: TimeDisplay;
  now: string;
  /** "14:20" today (in the display's calendar), else "Oct 22, 14:20". */
  when(instant: Instant): string;
  /** "14:20" today, else just the day ("Oct 22") where space is tight. */
  short(instant: Instant): string;
}

function formatter(display: TimeDisplay, now: string): Formatter {
  const today = displayDay(now, display);
  const isToday = (instant: Instant) => displayDay(instant, display) === today;
  return {
    display,
    now,
    when: instant => (isToday(instant) ? formatTime(instant, display) : formatDateTime(instant, display)),
    short: instant => (isToday(instant) ? formatTime(instant, display) : formatDay(instant, display)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Trading status.
// ---------------------------------------------------------------------------------------------------------------------
function tradesHint(trades: { used: number; planned: number; unplanned: number }): string {
  if (trades.used === 0) return "None used yet today";
  return `${trades.used} used: ${trades.planned} planned, ${trades.unplanned} recorded live`;
}

function riskStat(status: Extract<DailyStatus, { stale: false }>, currency: string): StatView {
  const risk = status.stats.risk;
  const used = new D(risk.used);
  if (risk.cap === null || risk.left === null) {
    return { label: "Risk left", values: [{ text: "No daily cap", tone: "muted" }], hint: used.isZero() ? "Nothing reserved yet" : `${formatMoney(risk.used, currency)} reserved today` };
  }
  const reached = used.gte(risk.cap);
  // Remaining risk rounds down (as in `dailyStatusV2`), so the card never promises more room than the engine allows;
  // reserved risk rounds toward the side the verdict is on, so it never reads as reaching the cap while trading is
  // still allowed (or the reverse).
  const left = formatMoneyExact(new D(risk.left).toDecimalPlaces(2, D.ROUND_FLOOR).toFixed(), currency);
  const reserved = formatMoneyAgainst(risk.used, risk.cap, currency, "min", reached);
  return {
    label: "Risk left",
    values: [{ text: left, tone: reached ? "neg" : "neutral" }],
    hint: `${reserved} of ${formatMoneyExact(risk.cap, currency)} cap reserved`,
  };
}

function resultStat(trades: readonly LedgerTrade[], day: string, label = "Today's result"): StatView & { losing: number } {
  const result = dayResult(trades, day);
  if (result.closed === 0) return { label, values: [{ text: "—", tone: "muted" }], hint: "No trades closed today", losing: 0 };
  const values: ValueText[] = [
    ...(result.netR === null ? [] : [{ text: formatR(result.netR), tone: signTone(result.netR) }]),
    ...result.money.map(total => ({ text: formatSignedMoney(total.netPnl, total.currency), tone: signTone(total.netPnl) })),
  ];
  const withoutR = result.closed - result.rTrades;
  return {
    label,
    values: values.length ? values : [{ text: "—", tone: "muted" }],
    hint: `${plural(result.closed, "closed trade")}${withoutR > 0 ? ` · ${withoutR} without R` : ""}`,
    losing: result.losingTrades,
  };
}

/**
 * Losses shown beside the daily loss limit: money rounded half up to the cent, as the day's result, the All Accounts
 * summary and the account dashboard show the same losses, unless that rounding would put the figure on the other side
 * of the limit (§6.6). Only then does it round toward its own side, with the decimals that keep it there
 * (`formatMoneyAgainst`): a loss just under the limit never reads as reaching it, one that reaches it never reads as below.
 */
function besideLimit(value: Decimal.Value, cap: string | null, currency: string): string {
  const amount = new D(value);
  const text = formatMoney(amount.toFixed(), currency);
  if (cap === null) return text;
  const reaches = amount.gte(cap);
  // `formatMoney` rounds half away from zero (Intl "halfExpand"), as ROUND_HALF_UP does.
  if (amount.toDecimalPlaces(2, D.ROUND_HALF_UP).gte(cap) === reaches) return text;
  return formatMoneyAgainst(amount.toFixed(), cap, currency, "min", reaches);
}

function lossesView(entry: TodayAccountStatus, losing: number): LossesView {
  const { losses, account, workspace } = entry;
  const currency = account.currency;
  const known = new D(losses.realized).plus(losses.external);
  const external = new D(losses.external);
  const cap = workspace.riskPlan?.dailyLossCap ?? null;
  const againstLimit = (value: Decimal.Value) => besideLimit(value, cap, currency);
  return {
    realized: againstLimit(losses.realized),
    combined: againstLimit(known),
    external: external.gt(0) ? `+ ${formatMoney(losses.external, currency)} external` : null,
    externalAmount: losses.external,
    detail: losing === 0 ? "No losing trades closed" : plural(losing, "losing trade"),
    counted: losses.legacyReported !== null && new D(losses.total).gt(known)
      ? `Counted toward the limit: ${againstLimit(losses.total)}, from an earlier manual entry.`
      : null,
    limit: cap === null ? "No daily loss limit" : `Daily loss limit ${formatMoneyExact(cap, currency)}`,
    externalSummary: `External realized losses today: ${formatMoney(losses.external, currency)}`,
  };
}

function valuesView(workspace: AccountWorkspace, status: Extract<DailyStatus, { stale: false }> | null, display: TimeDisplay): AccountValuesView {
  const observation = workspace.observation;
  if (!observation) {
    return { confirmedToday: false, label: "No account values yet", values: null, lines: [], recorded: null, observationId: null, balance: null, equity: null };
  }
  const currency = workspace.account.currency;
  const confirmedToday = status?.stats.accountValues.confirmedToday ?? observation.tradingDay === workspace.day;
  const year = observation.tradingDay.slice(0, 4) !== workspace.day.slice(0, 4);
  const lines = [`Balance ${formatMoney(observation.balance, currency)}`, `Equity ${formatMoney(observation.equity, currency)}`];
  return {
    confirmedToday,
    label: confirmedToday ? "Balance confirmed today" : "Confirm today's balance",
    values: lines.join(" · "),
    lines,
    recorded: confirmedToday ? null : `Recorded ${formatDay(observation.tradingDay, display, { year })}`,
    observationId: observation.id,
    balance: observation.balance,
    equity: observation.equity,
  };
}

function reasonAction(reason: DailyReason, workspace: AccountWorkspace, liveRows: readonly TradeListRow[]): ReasonAction | null {
  switch (reason.action?.kind) {
    case "CONFIRM_ACCOUNT_VALUES":
      return workspace.observation ? { kind: "confirm-values" } : { kind: "record-values" };
    case "REFRESH":
      return { kind: "refresh", label: reason.action.label };
    case "ADD_ENTRY_DETAILS": {
      // Only open positions can still take their missing details; a closed trade without risk keeps its gap.
      const missing = liveRows.filter(row => row.trade.account_id === workspace.account.id && row.trade.origin !== "PLANNED" && row.trade.initial_risk === null);
      if (missing.length === 1) return { kind: "link", label: reason.action.label, href: tradeTarget(missing[0].href, TRADE_TARGETS.entryDetails) };
      if (missing.length > 1) {
        return { kind: "link", label: "Review live trades", href: journalHref({ states: ["LIVE"] }, { account: workspace.account.id }), prefetch: false };
      }
      return null;
    }
    default:
      return null;
  }
}

function gapReasons(workspace: AccountWorkspace): ReasonView[] {
  const reasons: ReasonView[] = [];
  const id = workspace.account.id;
  if (workspace.gaps.includes("STRATEGY")) reasons.push({ severity: "WARN", message: STRATEGY_MISSING_COPY, action: null });
  if (workspace.gaps.includes("INSTRUMENTS")) {
    reasons.push({ severity: "WARN", message: INSTRUMENTS_MISSING_COPY, action: { kind: "link", label: "Add instrument", href: manageHref(id, "instruments") } });
  }
  return reasons;
}

function statusView(entry: TodayAccountStatus, closedRows: readonly TradeListRow[], liveRows: readonly TradeListRow[], day: string, display: TimeDisplay): AccountStatusView {
  const { account, workspace, losses } = entry;
  const status = workspace.status;
  const current = status !== null && !status.stale ? status : null;
  const base = {
    accountId: account.id,
    name: account.name,
    meta: accountMeta(account),
    currency: account.currency,
    focusHref: focusHref(account.id),
    manageHref: manageHref(account.id),
    values: valuesView(workspace, current, display),
    canAddExternalLoss: account.status === "ACTIVE",
    externalAmount: losses.external,
    externalSummary: `External realized losses today: ${formatMoney(losses.external, account.currency)}`,
  };
  if (status === null) {
    return {
      ...base, headline: NO_RISK_PLAN_HEADLINE, tone: "warning", allowed: false, stale: false, stats: null,
      reasons: [
        { severity: "WARN", message: RISK_PLAN_MISSING_COPY, action: { kind: "link", label: "Create risk plan", href: manageHref(account.id, "risk-policy") } },
        ...gapReasons(workspace),
      ],
    };
  }
  if (status.stale) {
    return {
      ...base, headline: status.headline, tone: status.tone, allowed: false, stale: true, stats: null,
      reasons: status.reasons.map(reason => ({ severity: reason.severity, message: reason.message, action: reasonAction(reason, workspace, liveRows) })),
    };
  }
  const trades = closedRows.filter(row => row.trade.account_id === account.id).map(row => row.trade);
  const result = resultStat(trades, day);
  const tradesStat = status.stats.trades;
  return {
    ...base,
    headline: status.headline,
    tone: status.tone,
    allowed: status.allowed,
    stale: false,
    reasons: [
      ...status.reasons.map(reason => ({ severity: reason.severity, message: reason.message, action: reasonAction(reason, workspace, liveRows) })),
      ...gapReasons(workspace),
    ],
    stats: {
      trades: { label: "Trades left", values: [{ text: tradesStat.label, tone: tradesStat.left === 0 ? "neg" : "neutral" }], hint: tradesHint(tradesStat), exhausted: tradesStat.left === 0 },
      risk: riskStat(status, account.currency),
      result: { label: result.label, values: result.values, hint: result.hint },
      losses: lossesView(entry, result.losing),
      values: base.values,
    },
  };
}

/**
 * The trades `result` counts (closed, with the exit on the strategy day: `dayResult`'s own rule) on accounts without a
 * status row. In All Accounts the status rows are the active accounts, so these are the trades an archived account
 * closed today: an archived account still finishes the trades it holds (docs/V2_ARCHITECTURE.md §3.2).
 */
function closedWithoutStatusRow(data: TodayData): TradeListRow[] {
  const withRow = new Set(data.accounts.map(entry => entry.account.id));
  return data.closedToday.filter(row => !withRow.has(row.trade.account_id) && isClosed(row.trade) && strategyDay(row.trade.exited_at as string) === data.day);
}

/**
 * All Accounts: today's result over every trade closed today in the context (R across accounts is labelled; money stays
 * per currency) and the realized + external losses of the same accounts, per currency (never converted), from their
 * daily usage (`TodayData.losses`, which includes an archived account that closed a trade today). Trades an archived
 * account closed today count in both, and the detail line says how many, since only active accounts have a row below.
 */
function summaryView(data: TodayData): DaySummaryView {
  const result = data.result;
  const withoutR = result.closed - result.rTrades;
  const outside = closedWithoutStatusRow(data);
  const archivedAccounts = new Set(outside.map(row => row.trade.account_id)).size;
  const archivedNote = outside.length > 0 ? ` · ${outside.length} on ${archivedAccounts > 1 ? "archived accounts" : "an archived account"}` : "";
  const detail = result.closed === 0
    ? "No trades closed today"
    : `${plural(result.closed, "trade")} closed today${withoutR > 0 ? ` · ${withoutR} without R` : ""}${archivedNote}`;
  return {
    r: result.netR === null ? null : { text: formatR(result.netR), tone: signTone(result.netR) },
    money: result.money.map(total => ({ text: formatSignedMoney(total.netPnl, total.currency), tone: signTone(total.netPnl) })),
    detail,
    losses: data.losses.length ? data.losses.map(entry => formatMoney(new D(entry.realized).plus(entry.external).toFixed(), entry.currency)).join(" · ") : "—",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live trades.
// ---------------------------------------------------------------------------------------------------------------------
function instrumentLookup(data: TodayData, instruments: ReadonlyMap<string, Instrument>) {
  const workspaces = new Map(data.accounts.map(entry => [entry.account.id, entry.workspace] as const));
  return (trade: LedgerTrade): Instrument | null => {
    const exact = trade.instrument_version_id ? instruments.get(trade.instrument_version_id) : undefined;
    if (exact) return exact;
    // Same symbol in the account's current list: the tick scale only pads zeros, it never rounds a price.
    return workspaces.get(trade.account_id)?.instruments.find(instrument => instrument.symbol === trade.symbol) ?? null;
  };
}

function lastJournalTitle(card: LiveTradeCard, instrument: Instrument | null): string {
  const last = card.lastJournal;
  if (!last) return "";
  const items = buildTimeline({
    trade: card.row.trade,
    instrument: instrument ? { tickSize: instrument.tickSize, quantityStep: instrument.quantityStep, quantityUnit: instrument.quantityUnit } : null,
    journal: [{ id: "last", kind: last.kind, body: last.body, details: last.details, phase: "LIVE", recordedAt: last.recordedAt }],
  });
  return items.find(item => item.kind === "JOURNAL")?.title ?? "Note";
}

function recordedFact(label: string, value: string | null, hints: string[] = []): LiveFactView {
  return value === null ? { label, value: NOT_RECORDED, tone: "muted", hints } : { label, value, tone: "default", hints };
}

/** "30% closed", "1.50 lots closed", "2 partial closes": what the journal says was taken off the position. */
function partialsHint(partials: readonly PartialClose[], step: string | null, unit: string): string | null {
  if (partials.length === 0) return null;
  const size = (quantity: string) => `${formatQuantity(quantity, step)}${unit ? ` ${unit}` : ""}`;
  if (partials.length === 1) {
    const [only] = partials;
    if (only.percent !== null) return `${stripZeros(only.percent)}% closed`;
    return only.quantity !== null ? `${size(only.quantity)} closed` : "Partly closed";
  }
  // Sizes add up exactly; percentages are never added (each may refer to what was left at the time).
  if (partials.every(partial => partial.quantity !== null)) {
    return `${size(partials.reduce((total, partial) => total.plus(partial.quantity as string), new D(0)).toFixed())} closed`;
  }
  return `${partials.length} partial closes`;
}

/** The stop as managed: the newest stop move from the journal (with the initial stop), else the initial stop. */
function stopFact(trade: LedgerTrade, move: StopMove | null, tick: string | null, format: Formatter): LiveFactView {
  const initial = trade.initial_stop !== null ? formatPrice(trade.initial_stop, tick) : null;
  if (move === null) return recordedFact("Initial stop", initial);
  const atEntry = trade.entry_price !== null && new D(move.price).eq(trade.entry_price);
  return {
    label: "Stop",
    value: formatPrice(move.price, tick),
    tone: "default",
    hints: [...(atEntry ? ["At entry"] : []), `Moved ${format.short(move.recordedAt)}`, ...(initial !== null ? [`Initial ${initial}`] : [])],
  };
}

/** The money at risk at entry: the R denominator, which a moved stop or a partial close never changes. */
function riskFact(trade: LedgerTrade, currency: string): LiveFactView {
  if (trade.initial_risk === null) return { label: "Initial risk", value: RISK_NOT_RECORDED, tone: "warning", hints: [] };
  const planned = trade.origin === "PLANNED" && trade.requested_risk_percent !== null ? ` · ${formatPercent(trade.requested_risk_percent)} planned` : "";
  return { label: "Initial risk", value: riskMoney(trade.initial_risk, currency), tone: "default", hints: [`1R${planned}`] };
}

function liveView(card: LiveTradeCard, instrument: Instrument | null, management: LiveManagement | null, format: Formatter, requestKey: string): LiveTradeView {
  const { row } = card;
  const trade = row.trade;
  const tick = instrument?.tickSize ?? null;
  const step = instrument?.quantityStep ?? null;
  const unit = unitWord(instrument?.quantityUnit);
  const last = card.lastJournal;
  const partials = partialsHint(management?.partials ?? [], step, unit);
  return {
    id: row.id,
    href: row.href,
    closeHref: tradeTarget(row.href, TRADE_TARGETS.closeTrade),
    symbol: trade.symbol ?? "Unknown instrument",
    direction: directionLabel(trade.direction),
    title: tradeTitle(trade),
    origin: { label: row.state.originLabel, tooltip: row.state.originTooltip },
    accountName: row.account.name,
    facts: [
      recordedFact("Entry", trade.entry_price !== null ? formatPrice(trade.entry_price, tick) : null),
      recordedFact("Size", trade.quantity !== null ? `${formatQuantity(trade.quantity, step)}${unit ? ` ${unit}` : ""}` : null, partials ? [partials] : []),
      stopFact(trade, management?.stop ?? null, tick, format),
      riskFact(trade, row.account.currency),
    ],
    riskRecorded: trade.initial_risk !== null,
    oversize: trade.oversize === true,
    since: card.liveSince,
    sinceLabel: trade.entered_at !== null ? `Entered ${format.when(trade.entered_at)}` : `Recorded ${format.when(card.liveSince)} · entry time not recorded`,
    lastJournal: last
      ? { title: lastJournalTitle(card, instrument), body: last.body, time: format.when(last.recordedAt), relative: formatRelative(last.recordedAt, format.now, format.display) }
      : null,
    addDetailsHref: row.state.editable.entry === "complete" ? tradeTarget(row.href, TRADE_TARGETS.entryDetails) : null,
    screenshotCapacity: Math.max(0, SCREENSHOT_LIMIT - trade.evidence_count),
    screenshots: trade.evidence_count > 0 ? plural(trade.evidence_count, "screenshot") : null,
    instrument: instrument ? { tickSize: instrument.tickSize, quantityStep: instrument.quantityStep } : null,
    requestKey,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans waiting and today's closed trades.
// ---------------------------------------------------------------------------------------------------------------------
type PlanGroup = "locked" | "ready" | "recheck" | "blocked" | "unchecked";

function priceParts(trade: LedgerTrade, instrument: Instrument | null): string[] {
  const tick = instrument?.tickSize ?? null;
  const parts: string[] = [];
  if (trade.planned_entry !== null) parts.push(`Entry ${formatPrice(trade.planned_entry, tick)}`);
  if (trade.planned_stop !== null) parts.push(`Stop ${formatPrice(trade.planned_stop, tick)}`);
  if (trade.planned_target !== null) parts.push(`Target ${formatPrice(trade.planned_target, tick)}`);
  if (trade.requested_risk_percent !== null) {
    const money = trade.planned_risk !== null ? ` (${riskMoney(trade.planned_risk, trade.currency)})` : "";
    parts.push(`Risk ${formatPercent(trade.requested_risk_percent)}${money}`);
  }
  return parts;
}

function revisionPart(trade: LedgerTrade): string[] {
  return trade.latest_revision !== null && trade.latest_revision > 1 ? [`revision ${trade.latest_revision}`] : [];
}

function planMeta(group: PlanGroup, trade: LedgerTrade, instrument: Instrument | null, format: Formatter): string {
  const prices = priceParts(trade, instrument);
  const checkedAt = trade.latest_check_at;
  const lead = (() => {
    switch (group) {
      case "locked": return trade.locked_at ? [`Locked ${format.when(trade.locked_at)}`] : [];
      case "ready": return checkedAt ? [`Approved ${format.when(checkedAt)}`] : [];
      case "recheck": return checkedAt ? [`Last approved ${format.when(checkedAt)}`] : [];
      case "blocked": return [...(checkedAt ? [`Checked ${format.when(checkedAt)}`] : []), ...revisionPart(trade)];
      case "unchecked": return [`Drafted ${format.when(trade.latest_revision_at ?? trade.created_at)}`, ...revisionPart(trade), "not checked yet"];
    }
  })();
  return [...lead, ...prices].join(" · ");
}

function planAction(row: TradeListRow): PlanActionView | null {
  const next = row.state.nextAction;
  if (!next) return null;
  switch (next.kind) {
    case "CHECK_RISK":
    case "RECHECK_RISK":
      return { kind: "check", label: next.label, tradeId: row.id };
    case "LOCK_PLAN":
      return { kind: "link", label: next.label, href: row.href, variant: "primary" };
    case "RECORD_ENTRY":
      return { kind: "link", label: next.label, href: tradeTarget(row.href, TRADE_TARGETS.recordEntry), variant: "primary" };
    case "EDIT_DRAFT":
      return { kind: "link", label: next.label, href: `${row.href}/edit`, variant: "secondary" };
    case "CONFIRM_VALUES":
      // Today's account values are confirmed on the account's Manage screen, as from the trade page.
      return { kind: "link", label: next.label, href: manageHref(row.account.id, "account-values"), variant: "secondary" };
    default:
      return { kind: "link", label: "Open", href: row.href, variant: "secondary" };
  }
}

/** Strategy day a plan was locked on (its trading day; the lock time's day for rows without one). */
function lockedDay(trade: LedgerTrade): string | null {
  return trade.plan_trading_day ?? (trade.locked_at !== null ? strategyDay(trade.locked_at) : null);
}

/** A plan locked before today: its slot and risk count on that day, and entering it today uses neither of today's limits. */
function lockedBefore(trade: LedgerTrade, day: string): boolean {
  const locked = lockedDay(trade);
  return locked !== null && locked < day;
}

/** "Oct 23" when the latest check ran on another strategy day than today, else null. */
function checkedOn(trade: LedgerTrade, day: string): string | null {
  if (trade.latest_check_at === null) return null;
  const checked = strategyDay(trade.latest_check_at);
  return checked === day ? null : formatDay(checked, undefined, { year: checked.slice(0, 4) !== day.slice(0, 4) });
}

function planActions(group: PlanGroup, row: TradeListRow, day: string): PlanActionView[] {
  const trade = row.trade;
  // A block found on an earlier day says nothing certain about today (trade slots, risk used, session, account values
  // and the risk plan in effect can all differ): the shared trade state makes the free check its next action, like a
  // stale approval's "Recheck needed" (`deriveTradeState`, the trade page, Journal and palette agree). Edit draft stays
  // beside it for a reason the trader already knows to change. A draft blocked today only by what no edit clears
  // (`withBlockingFindings`) leads the same way with the step that does, as its trade page does: the recheck once the
  // session, the day or the open positions change, or confirming today's account values. A draft of an archived account
  // gets none of these: the database refuses its checks and revisions, and its state offers nothing but Discard.
  const next = row.state.nextAction?.kind;
  if (group === "blocked" && (next === "RECHECK_RISK" || next === "CONFIRM_VALUES")) {
    const main = planAction(row);
    return [
      ...(row.state.editable.plan ? [{ kind: "link", label: "Edit draft", href: `${row.href}/edit`, variant: "ghost" } as const] : []),
      ...(main ? [main] : []),
    ];
  }
  if (group === "locked" && lockedBefore(trade, day)) {
    const locked = lockedDay(trade) as string;
    return [
      { kind: "skip", label: "Skip…", tradeId: row.id, lockedOn: formatDay(locked, undefined, { year: locked.slice(0, 4) !== day.slice(0, 4) }) },
      { kind: "link", label: "Record entry", href: tradeTarget(row.href, TRADE_TARGETS.recordEntry), variant: "secondary" },
    ];
  }
  const action = planAction(row);
  return action ? [action] : [];
}

function planReason(group: PlanGroup, row: TradeListRow, reasons: ReadonlyMap<string, string>, day: string): PlanReasonView | null {
  const text = group === "blocked" ? reasons.get(row.id) : undefined;
  return text === undefined ? null : { text, checkedOn: checkedOn(row.trade, day) };
}

function planRow(group: PlanGroup, row: TradeListRow, instrument: Instrument | null, reasons: ReadonlyMap<string, string>, format: Formatter, day: string): PlanRowView {
  return {
    id: row.id,
    href: row.href,
    title: tradeTitle(row.trade),
    accountName: row.account.name,
    state: { label: row.state.label, tone: pillTone(row.state.tone) },
    meta: planMeta(group, row.trade, instrument, format),
    reason: planReason(group, row, reasons, day),
    actions: planActions(group, row, day),
  };
}

/** The last time a draft was worked on: revised, checked or created (microsecond-exact comparison). */
function lastTouched(trade: LedgerTrade): string {
  const instants = [trade.latest_revision_at, trade.latest_check_at].filter((value): value is string => value !== null);
  return instants.reduce((latest, value) => (compareInstants(value, latest) > 0 ? value : latest), trade.created_at);
}

function plansSummary(counts: { locked: number; lockedEarlier: number; current: number; older: number }): string {
  const parts = [
    ...(counts.locked > 0 ? [`${counts.locked} locked`] : []),
    ...(counts.lockedEarlier > 0 ? [`${counts.lockedEarlier} locked earlier`] : []),
    ...(counts.current > 0 ? [`${plural(counts.current, "draft")} today`] : []),
    ...(counts.older > 0 ? [`${plural(counts.older, "older draft")}`] : []),
  ];
  return parts.length ? parts.join(" · ") : "Nothing waiting";
}

function plansView(data: TodayData, instrumentOf: (trade: LedgerTrade) => Instrument | null, reasons: ReadonlyMap<string, string>, format: Formatter): PlansView {
  const { plans, day } = data;
  const view = (group: PlanGroup) => (row: TradeListRow) => ({ row, view: planRow(group, row, instrumentOf(row.trade), reasons, format, day) });
  const locked = plans.locked.map(view("locked"));
  const lockedToday = locked.filter(entry => !lockedBefore(entry.row.trade, day));
  const lockedEarlier = locked.filter(entry => lockedBefore(entry.row.trade, day));
  const drafts = [
    ...plans.ready.map(view("ready")),
    ...plans.recheck.map(view("recheck")),
    ...plans.blocked.map(view("blocked")),
    ...plans.unchecked.map(view("unchecked")),
  ];
  // Ready to lock is current by definition (an approval from an earlier day is never current).
  const isCurrent = (entry: { row: TradeListRow }) =>
    (entry.row.state.draftCheck === "APPROVED" && entry.row.state.checkCurrent) || strategyDay(lastTouched(entry.row.trade)) === day;
  const currentDrafts = drafts.filter(isCurrent);
  const older = drafts.filter(entry => !isCurrent(entry));
  return {
    current: [...lockedToday, ...currentDrafts].map(entry => entry.view),
    earlierLocked: lockedEarlier.map(entry => entry.view),
    foldEarlierLocked: lockedEarlier.length > OLDER_DRAFTS_INLINE,
    older: older.slice(0, OLDER_DRAFTS_SHOWN).map(entry => entry.view),
    olderHidden: Math.max(0, older.length - OLDER_DRAFTS_SHOWN),
    foldOlder: older.length > OLDER_DRAFTS_INLINE,
    summary: plansSummary({ locked: lockedToday.length, lockedEarlier: lockedEarlier.length, current: currentDrafts.length, older: older.length }),
    total: plans.locked.length + drafts.length,
    truncated: data.truncated.drafts || data.truncated.locked,
    journalHref: journalHref({ states: ["DRAFT", "LOCKED"] }),
  };
}

function closedView(row: TradeListRow, format: Formatter): ClosedTradeView {
  const trade = row.trade;
  return {
    id: row.id,
    href: row.href,
    title: tradeTitle(trade),
    origin: { label: row.state.originLabel, tooltip: row.state.originTooltip },
    accountName: row.account.name,
    exit: trade.exited_at ? `Exit ${format.when(trade.exited_at)}` : "Exit time not recorded",
    r: trade.realized_r !== null ? { text: formatR(trade.realized_r), tone: signTone(trade.realized_r) } : null,
    pnl: trade.net_pnl !== null ? { text: formatSignedMoney(trade.net_pnl, row.account.currency), tone: signTone(trade.net_pnl) } : null,
    state: { label: row.state.label, tone: pillTone(row.state.tone) },
    action: row.state.lifecycle === "CLOSED" ? { label: row.state.nextAction?.label ?? "Write review", href: tradeTarget(row.href, TRADE_TARGETS.review) } : null,
  };
}

function notesView(data: TodayData, format: Formatter): NotesView {
  const selected = data.context.selected;
  if (selected.mode === "account") {
    const saved = data.dailyContext;
    return {
      mode: "account", accountId: selected.account.id, accountName: selected.account.name, narrative: saved?.narrative ?? "",
      savedLabel: saved ? `Saved ${format.when(saved.recordedAt)}` : null, archived: selected.account.status === "ARCHIVED",
    };
  }
  return { mode: "all", accounts: data.context.active.map(account => ({ label: account.name, href: focusHref(account.id), prefetch: false })) };
}

export function buildTodayView({ data, display, instruments, blockingReasons, management = new Map(), requestKey }: TodayModelInput): TodayView {
  const format = formatter(display, data.now);
  const instrumentOf = instrumentLookup(data, instruments);
  const selected = data.context.selected;
  const liveRows = data.live.map(card => card.row);
  return {
    now: data.now,
    day: data.day,
    dayLabel: data.dayLabel,
    display,
    zoneNote: `Times in ${zoneLabel(display, data.now)}`,
    context: selected.mode === "account"
      ? { mode: "account", label: selected.account.name, detail: accountMeta(selected.account) }
      : { mode: "all", label: "All Accounts", detail: plural(data.context.active.length, "active trading account") },
    showAccount: selected.mode === "all",
    status: data.accounts.map(entry => statusView(entry, data.closedToday, liveRows, data.day, display)),
    summary: selected.mode === "all" ? summaryView(data) : null,
    live: data.live.map(card => liveView(card, instrumentOf(card.row.trade), management.get(card.row.id) ?? null, format, requestKey())),
    liveTruncated: data.truncated.live,
    liveJournalHref: journalHref({ states: ["LIVE"] }),
    plans: plansView(data, instrumentOf, blockingReasons, format),
    closed: data.closedToday.map(row => closedView(row, format)),
    closedJournalHref: journalHref({ closedFrom: data.day, closedTo: data.day }),
    closedTruncated: data.truncated.closed,
    notes: notesView(data, format),
    empty: data.empty,
    newTradeHrefs: { plan: PLAN_TRADE_HREF, live: LIVE_TRADE_HREF },
  };
}
