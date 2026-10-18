import Decimal from "decimal.js";
import { formatAgainst, formatDecimal, formatMoney, formatMoneyAgainst, formatMoneyExact, formatQuantity, stripZeros } from "./format";
import type { RiskReport, RiskReportV12, StoredRiskReport } from "./risk-report";
import { formatDay } from "./time-display";

/**
 * Single source of display copy for Risk Engine findings (spec §6.5). The UI renders from
 * code + params (1.2) or from the stored report plus immutable lookup rows (1.1 / legacy); it
 * never shows rule codes, stored SQL wording for known codes, or zod paths.
 */

export type IssueSeverity = "BLOCK" | "WARN";
export type IssueParams = Record<string, string | number | null>;
export interface RiskIssueInput {
  code: string;
  severity: IssueSeverity;
  message: string;
  params?: IssueParams;
}

/**
 * Immutable rows loaded by `riskPlanVersionId` / `instrumentVersionId` to explain 1.1 and legacy reports.
 * Rows that carry their `id` are only used for the report of that version; a row of another risk plan
 * or instrument version is ignored, so a report is never explained with another version's numbers.
 */
export interface ExplainLookup {
  riskPlan?: {
    /** `risk_plan_versions.id`. */
    id?: string;
    maxRiskPercent: string; minRR: string; dailyRiskCap: string | null; dailyLossCap: string | null;
    rrPolicy: IssueSeverity; newsPolicy: IssueSeverity; maxDailyTrades: number;
  };
  instrument?: {
    /** `instrument_versions.id`. */
    id?: string;
    symbol: string; currency: string; tickSize: string; minimumQuantity: string; quantityUnit: string; quantityStep?: string;
  };
  /** The checked proposal, for values a legacy report does not carry. */
  proposal?: { direction?: "LONG" | "SHORT"; riskPercent?: string };
  /** Strategy version name, e.g. `ICT V1.0`. */
  strategy?: string;
  accountCurrency?: string;
}

export interface ExplainedIssue {
  code: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
}

export interface ExplainedReport {
  decision: "APPROVED" | "BLOCKED";
  /** BLOCK findings in engine order. */
  blocking: ExplainedIssue[];
  /** WARN findings in engine order, excluding notes. */
  warnings: ExplainedIssue[];
  /** Low-priority notes (costs, unconfigured caps), collapsed as "n notes" by default. */
  notes: ExplainedIssue[];
}

interface CopyEntry {
  title: string;
  /** Fixed sentence for codes without values. */
  sentence?: string;
  /** Collapsed into "n notes" by default. */
  note?: boolean;
}

const DEAD_POOL_SENTENCE = "Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.";

export const RISK_COPY = {
  RISK_LIMIT: { title: "Requested risk exceeds maximum" },
  MIN_RR: { title: "Planned RR below minimum" },
  MAX_TRADES: { title: "Daily trade limit reached" },
  DEAD_POOL: { title: "Dead Pool", sentence: DEAD_POOL_SENTENCE },
  OUTSIDE_ACTIVE: { title: "Outside the kill zone", sentence: "Outside the active kill zone (02:00–12:00 UTC−5)." },
  DAILY_RISK_LIMIT: { title: "Daily risk cap would be exceeded" },
  DAILY_LOSS_LIMIT: { title: "Daily loss limit would be exceeded" },
  STALE_EQUITY: { title: "Account values need confirming" },
  MINIMUM_QUANTITY: { title: "Risk budget below minimum size" },
  OFF_TICK: { title: "Prices off the tick size" },
  PRICE_GEOMETRY: { title: "Stop or target on the wrong side" },
  MISSING_STOP: { title: "Stop loss missing", sentence: "A stop loss is required." },
  CONTRACT_UNCONFIRMED: { title: "Contract values not confirmed" },
  INSTRUMENT_MISMATCH: { title: "Instrument currency mismatch" },
  DUPLICATE: { title: "Duplicate plan", sentence: "An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today." },
  STRATEGY_CONTRADICTION: { title: "Strategy contradiction flagged" },
  NEWS_RESTRICTED: { title: "Restricted news window" },
  NEWS_UNKNOWN: { title: "News not checked", sentence: "Economic news has not been checked." },
  DAILY_RISK_UNCONFIGURED: { title: "No daily risk cap", sentence: "No daily risk cap is configured.", note: true },
  DAILY_LOSS_UNCONFIGURED: { title: "No daily loss limit", sentence: "No daily loss limit is configured.", note: true },
  UNPLANNED_RISK_UNKNOWN: { title: "Live-first risk not recorded" },
  COSTS_UNKNOWN: { title: "Costs not included", sentence: "Sizing uses the stop distance only; fees, gaps and slippage are not included.", note: true },
  SIZING_INVARIANT: { title: "Sizing safety check failed", sentence: "Position sizing failed an internal safety check. Nothing was locked." },
  INVALID_INPUT: { title: "Trade details incomplete" },
  /** Legacy (report 1.1 and earlier) only; 1.2 always knows today's losses. */
  DAILY_LOSS_UNKNOWN: { title: "Daily losses not reported", sentence: "Your daily loss limit needs today's reported losses, which were not recorded." },
  /** TS preview only (legacy engine). */
  INVALID_CONTEXT: { title: "Account configuration invalid", sentence: "Account, instrument or risk configuration is invalid." },
} as const satisfies Record<string, CopyEntry>;

export type RiskCopyCode = keyof typeof RISK_COPY;

/** Field-level copy for INVALID_INPUT (`params.fields` = comma-separated proposal keys, or `params.field`). */
export const INVALID_INPUT_FIELD_COPY: Readonly<Record<string, string>> = Object.freeze({
  instrumentId: "Choose an instrument from this trading account.",
  direction: "Choose a direction: long or short.",
  model: "Choose an entry model.",
  entry: "Entry price must be a positive number with up to 8 decimals.",
  stop: "Stop loss must be a positive number with up to 8 decimals.",
  target: "Target price must be a positive number with up to 8 decimals.",
  riskPercent: "Risk per trade must be a positive percentage with up to 8 decimals.",
  narrative: "Add your thesis: why this trade, and what would invalidate it.",
  contractConfirmed: "Confirm whether the contract values match your broker.",
  news: "Choose the economic news status.",
  contradiction: "Answer whether the setup contradicts a strategy rule.",
});
const INVALID_INPUT_FALLBACK = "Some trade details are missing or invalid. Review the plan and try again.";
const UNKNOWN_FINDING_TITLE = "Risk Engine finding";
const UNKNOWN_FINDING_DETAIL = "The Risk Engine recorded a finding for this plan.";

const exact = Decimal.clone({ precision: 100 });
const NUMERIC_TEXT = /^[+-]?\d+(\.\d+)?$/;

function copyFor(code: string): CopyEntry | undefined {
  return Object.hasOwn(RISK_COPY, code) ? (RISK_COPY as Record<string, CopyEntry>)[code] : undefined;
}

function v12(report: StoredRiskReport): RiskReportV12 | null {
  return "reportVersion" in report && report.reportVersion === "1.2" ? report : null;
}

function v11(report: StoredRiskReport): RiskReport | null {
  return "reportVersion" in report && report.reportVersion === "1.1" ? report : null;
}

/** Resolves a value from issue params first, then the report, then the lookup rows. */
class Values {
  constructor(private readonly issue: RiskIssueInput, private readonly report: StoredRiskReport, private readonly lookup: ExplainLookup) {}

  private param(name: string): string | null {
    const value = this.issue.params?.[name];
    if (value === null || value === undefined) return null;
    return typeof value === "number" ? (Number.isFinite(value) ? String(value) : null) : value;
  }

  private decimalParam(name: string): string | null {
    const value = this.param(name);
    return value !== null && NUMERIC_TEXT.test(value.trim()) ? value.trim() : null;
  }

  /** First non-null decimal among the param and fallbacks. */
  decimal(name: string, ...fallbacks: (string | number | null | undefined)[]): string | null {
    const fromParam = this.decimalParam(name);
    if (fromParam !== null) return fromParam;
    for (const value of fallbacks) if (value !== null && value !== undefined && NUMERIC_TEXT.test(String(value))) return String(value);
    return null;
  }

  text(name: string, ...fallbacks: (string | null | undefined)[]): string | null {
    const fromParam = this.param(name);
    if (fromParam !== null && fromParam.trim() !== "") return fromParam;
    for (const value of fallbacks) if (value !== null && value !== undefined && value.trim() !== "") return value;
    return null;
  }

  get modern(): RiskReportV12 | null {
    return v12(this.report);
  }

  get v11(): RiskReport | null {
    return v11(this.report);
  }

  get calculations() {
    return this.report.calculations;
  }

  get tradingDay(): string {
    return this.report.tradingDay;
  }

  get symbol(): string | null {
    return this.text("symbol", this.modern?.instrument.symbol, this.lookup.instrument?.symbol);
  }

  /** Account currency for money. Pre-1.2 reports predate multi-currency accounts (V1 enforced USD). */
  get currency(): string {
    return this.modern?.snapshot.currency ?? this.v11?.snapshot.currency ?? this.lookup.accountCurrency ?? this.lookup.instrument?.currency ?? "USD";
  }
}

function moneyUp(value: string, currency: string): string {
  return formatMoneyExact(new exact(value).toDecimalPlaces(2, exact.ROUND_CEIL).toFixed(), currency);
}

function observationDayText(day: string, reference: string): string {
  return formatDay(day, undefined, { year: day.slice(0, 4) !== reference.slice(0, 4) });
}

function invalidInputDetail(values: Values): string {
  const listed = values.text("fields", values.text("field"));
  const sentences = (listed ?? "")
    .split(",")
    .map(field => field.trim())
    .filter(field => Object.hasOwn(INVALID_INPUT_FIELD_COPY, field))
    .map(field => INVALID_INPUT_FIELD_COPY[field]);
  return sentences.length ? [...new Set(sentences)].join(" ") : INVALID_INPUT_FALLBACK;
}

function riskLimitDetail(values: Values, lookup: ExplainLookup): string {
  const requested = values.decimal("requested", values.v11?.requestedRiskPercent ?? values.modern?.requestedRiskPercent, lookup.proposal?.riskPercent);
  const configured = values.decimal("maximum", values.modern?.limits.maxRiskPercent, lookup.riskPlan?.maxRiskPercent);
  // A maximum that the requested value does not exceed (mismatched lookup data) is never paired with it.
  const maximum = configured !== null && requested !== null && new exact(requested).lte(configured) ? null : configured;
  // The requested percent is a user input and is shown exactly (spec §6.6): it can never read as the maximum.
  const requestedText = requested === null ? "Requested risk" : `Requested risk ${formatDecimal(requested)}%`;
  return maximum === null
    ? `${requestedText} exceeds your configured maximum.`
    : `${requestedText} exceeds your configured maximum of ${formatDecimal(maximum)}%.`;
}

function minRrDetail(values: Values, severity: IssueSeverity, lookup: ExplainLookup): string {
  const configured = values.decimal("min", values.modern?.limits.minRR, lookup.riskPlan?.minRR);
  const rr = values.decimal("rr", values.calculations?.plannedRR);
  const min = configured !== null && rr !== null && new exact(rr).gte(configured) ? null : configured;
  // Without a minimum, truncation keeps the shown RR from ever rounding up.
  const shownRr = rr === null ? null : min === null ? formatDecimal(new exact(rr).toDecimalPlaces(2, exact.ROUND_FLOOR)) : formatAgainst(rr, min, "min", false);
  const rrText = shownRr === null ? "Planned RR" : `Planned RR ${shownRr}R`;
  if (severity === "WARN") {
    return min === null
      ? `${rrText} is below your minimum. Your risk plan allows it with a warning.`
      : `${rrText} is below your ${formatDecimal(min)}R minimum. Your risk plan allows it with a warning.`;
  }
  return min === null ? `${rrText} is below the required minimum.` : `${rrText} is below the required minimum of ${formatDecimal(min)}R.`;
}

function maxTradesDetail(values: Values, lookup: ExplainLookup): string {
  const modern = values.modern;
  const used = values.decimal("used", modern?.snapshot.slotsUsed ?? values.v11?.snapshot.slotsUsed);
  const max = values.decimal("max", modern?.limits.maxDailyTrades ?? values.v11?.snapshot.maximumDailyTrades, lookup.riskPlan?.maxDailyTrades);
  const planned = values.decimal("planned", modern?.snapshot.plannedSlots);
  const unplanned = values.decimal("unplanned", modern?.snapshot.unplannedTrades);
  if (used === null || max === null) return max === null ? "Daily trade limit reached." : `Daily trade limit reached: all ${max} daily trades are already used.`;
  const breakdown = planned !== null && unplanned !== null ? ` (${planned} planned, ${unplanned} recorded live)` : "";
  return `Daily trade limit reached: ${used} of ${max} trades already used today${breakdown}.`;
}

function dailyRiskDetail(values: Values, lookup: ExplainLookup): string {
  const currency = values.currency;
  const cap = values.decimal("cap", values.modern?.limits.dailyRiskCap, lookup.riskPlan?.dailyRiskCap);
  const used = values.decimal("used", values.modern?.snapshot.riskConsumed ?? values.v11?.snapshot.riskConsumed);
  const nominal = values.decimal("nominal", values.calculations?.nominalRisk);
  const remainingValue = values.decimal("remaining", cap !== null && used !== null ? new exact(cap).minus(used).toFixed() : null);
  if (cap === null || nominal === null || remainingValue === null) return "This trade's risk would exceed your remaining daily risk cap.";
  const remaining = exact.max(remainingValue, 0);
  if (new exact(nominal).lte(remaining)) {
    // Only reachable with inconsistent inputs (e.g. a zero-size trade after the cap was already exceeded).
    return used === null
      ? `This trade would exceed your daily risk cap of ${formatMoneyExact(cap, currency)}.`
      : `Today's reserved risk ${moneyUp(used, currency)} plus this trade's ${moneyUp(nominal, currency)} would exceed your daily risk cap of ${formatMoneyExact(cap, currency)}.`;
  }
  const remainingText = remaining.toFixed();
  return `Remaining daily risk ${formatMoneyExact(remainingText, currency)} is insufficient for this trade's ${formatMoneyAgainst(nominal, remainingText, currency, "max", false)} risk (cap ${formatMoneyExact(cap, currency)}).`;
}

function dailyLossDetail(values: Values, lookup: ExplainLookup): string {
  const currency = values.currency;
  const modern = values.modern;
  const cap = values.decimal("cap", modern?.limits.dailyLossCap, lookup.riskPlan?.dailyLossCap);
  const loss = values.decimal("loss", modern?.snapshot.grossLoss ?? values.v11?.snapshot.grossLoss);
  // 1.1 counted every reservation of the day as exposure; 1.2 counts only positions still at risk.
  const open = values.decimal("open", modern ? modern.snapshot.openExposure : values.v11?.snapshot.riskConsumed);
  const nominal = values.decimal("nominal", values.calculations?.nominalRisk);
  if (cap === null || loss === null || open === null || nominal === null) {
    return cap === null ? "This trade would exceed your daily loss limit." : `This trade would exceed your daily loss limit of ${formatMoneyExact(cap, currency)}.`;
  }
  // Rounding each part up keeps the displayed sum above the displayed limit, matching the verdict.
  const parts = modern || values.decimal("open") !== null
    ? `Today's realized losses ${moneyUp(loss, currency)} plus open risk ${moneyUp(open, currency)}`
    : `Today's reported losses ${moneyUp(loss, currency)} plus reserved risk ${moneyUp(open, currency)}`;
  return `${parts} plus this trade's ${moneyUp(nominal, currency)} would exceed your daily loss limit of ${formatMoneyExact(cap, currency)}.`;
}

function staleEquityDetail(values: Values): string {
  const observed = values.text("observationDay", values.modern?.snapshot.observationDay ?? values.v11?.snapshot.observationDay);
  if (observed === null || !/^\d{4}-\d{2}-\d{2}$/.test(observed)) return "Confirm today's account balance before locking.";
  return `Confirm today's account balance before locking (last recorded ${observationDayText(observed, values.tradingDay)}).`;
}

function minimumQuantityDetail(values: Values, lookup: ExplainLookup): string {
  const budget = values.decimal("budget", values.calculations?.budget);
  const minQty = values.decimal("minQty", values.modern?.instrument.minimumQuantity, lookup.instrument?.minimumQuantity);
  const unit = values.text("unit", values.modern?.instrument.quantityUnit, lookup.instrument?.quantityUnit);
  const step = values.modern?.instrument.quantityStep ?? lookup.instrument?.quantityStep ?? null;
  const budgetText = budget === null ? "Your risk budget" : `Your ${formatMoney(budget, values.currency)} risk budget`;
  if (minQty === null) return `${budgetText} is too small for the minimum position size at this stop.`;
  return `${budgetText} is too small for the minimum position size of ${formatQuantity(minQty, step)}${unit ? ` ${unit}` : ""} at this stop.`;
}

function offTickDetail(values: Values, lookup: ExplainLookup): string {
  const tick = values.decimal("tick", values.modern?.instrument.tickSize, lookup.instrument?.tickSize);
  const symbol = values.symbol;
  if (tick === null) return symbol ? `Prices must align to the ${symbol} tick size.` : "Prices must align to the instrument tick size.";
  return symbol ? `Prices must align to the ${symbol} tick size of ${stripZeros(tick)}.` : `Prices must align to the instrument tick size of ${stripZeros(tick)}.`;
}

function geometryDetail(values: Values, lookup: ExplainLookup): string {
  const direction = values.text("direction", lookup.proposal?.direction)?.toUpperCase();
  if (direction === "LONG") return "For a long trade, the stop must be below entry and the target above entry.";
  if (direction === "SHORT") return "For a short trade, the stop must be above entry and the target below entry.";
  return "The stop and the target must be on opposite sides of entry.";
}

function mismatchDetail(values: Values, lookup: ExplainLookup): string {
  const symbol = values.symbol;
  const instrumentCurrency = values.text("instrumentCurrency", values.modern?.instrument.currency, lookup.instrument?.currency);
  const accountCurrency = values.text("accountCurrency", values.modern?.snapshot.currency ?? values.v11?.snapshot.currency, lookup.accountCurrency);
  if (symbol && instrumentCurrency && accountCurrency && instrumentCurrency !== accountCurrency) {
    return `${symbol} is valued in ${instrumentCurrency}, but this account uses ${accountCurrency}.`;
  }
  return "This instrument does not belong to the selected trading account.";
}

/**
 * UNPLANNED_RISK_UNKNOWN sentence (spec §6.3) for `riskUnknownTrades`, the distinct count of trades
 * without a risk basis. The per-day and open counters overlap (a trade entered today and still open is
 * in both), so they are never summed for display. Generic when the count is unknown.
 */
export function unplannedRiskSentence(count: string | number | null | undefined): string {
  const text = typeof count === "number" ? (Number.isFinite(count) ? String(count) : null) : typeof count === "string" ? count.trim() : null;
  const n = text !== null && NUMERIC_TEXT.test(text) ? new exact(text) : null;
  if (n === null || !n.isInteger() || n.lt(1)) return "Live-first trades without recorded risk are not included in the daily risk totals.";
  return n.eq(1)
    ? "1 live-first trade without recorded risk is not included in the daily risk totals."
    : `${n.toFixed()} live-first trades without recorded risk are not included in the daily risk totals.`;
}

function unplannedRiskDetail(values: Values): string {
  return unplannedRiskSentence(values.decimal("n", values.modern?.snapshot.riskUnknownTrades));
}

function detailFor(issue: RiskIssueInput, values: Values, lookup: ExplainLookup): string {
  switch (issue.code) {
    case "RISK_LIMIT": return riskLimitDetail(values, lookup);
    case "MIN_RR": return minRrDetail(values, issue.severity, lookup);
    case "MAX_TRADES": return maxTradesDetail(values, lookup);
    case "DAILY_RISK_LIMIT": return dailyRiskDetail(values, lookup);
    case "DAILY_LOSS_LIMIT": return dailyLossDetail(values, lookup);
    case "STALE_EQUITY": return staleEquityDetail(values);
    case "MINIMUM_QUANTITY": return minimumQuantityDetail(values, lookup);
    case "OFF_TICK": return offTickDetail(values, lookup);
    case "PRICE_GEOMETRY": return geometryDetail(values, lookup);
    case "CONTRACT_UNCONFIRMED": {
      const symbol = values.symbol;
      return symbol ? `Confirm that the ${symbol} contract values match your broker.` : "Confirm that the contract values match your broker.";
    }
    case "INSTRUMENT_MISMATCH": return mismatchDetail(values, lookup);
    case "STRATEGY_CONTRADICTION": {
      const strategy = values.text("strategy", lookup.strategy);
      return `Blocked because you flagged a contradiction with your ${strategy ? `${strategy} ` : "strategy "}rules.`;
    }
    case "NEWS_RESTRICTED":
      return `You reported a restricted news window. Your risk plan ${issue.severity === "BLOCK" ? "blocks" : "warns about"} trading in restricted news.`;
    case "UNPLANNED_RISK_UNKNOWN": return unplannedRiskDetail(values);
    case "INVALID_INPUT": return invalidInputDetail(values);
    default: {
      const sentence = copyFor(issue.code)?.sentence;
      if (sentence) return sentence;
      // Unknown future codes: stored engine wording is human text; never echo the code itself.
      return issue.message.trim() || UNKNOWN_FINDING_DETAIL;
    }
  }
}

/** Drops lookup rows that identify another risk plan or instrument version than the report's. */
function rowsOfReport(report: StoredRiskReport, lookup: ExplainLookup): ExplainLookup {
  const instrumentId = "snapshot" in report ? report.snapshot.instrumentVersionId : null;
  const foreignPlan = lookup.riskPlan?.id !== undefined && lookup.riskPlan.id !== report.riskPlanVersionId;
  const foreignInstrument = lookup.instrument?.id !== undefined && instrumentId !== null && lookup.instrument.id !== instrumentId;
  if (!foreignPlan && !foreignInstrument) return lookup;
  return { ...lookup, riskPlan: foreignPlan ? undefined : lookup.riskPlan, instrument: foreignInstrument ? undefined : lookup.instrument };
}

/** One finding as `{code, severity, title, detail}`; `detail` is the exact sentence of spec §6.5. */
export function explainIssue(issue: RiskIssueInput, report: StoredRiskReport, lookup: ExplainLookup = {}): ExplainedIssue {
  const rows = rowsOfReport(report, lookup);
  const values = new Values(issue, report, rows);
  return {
    code: issue.code,
    severity: issue.severity,
    title: copyFor(issue.code)?.title ?? UNKNOWN_FINDING_TITLE,
    detail: detailFor(issue, values, rows),
  };
}

export function reportDecision(report: StoredRiskReport): "APPROVED" | "BLOCKED" {
  return "decision" in report ? report.decision : report.status === "TRADE_BLOCKED" ? "BLOCKED" : "APPROVED";
}

/** Display order: every BLOCK first (engine order), then WARN; costs and unconfigured caps become notes. */
export function explainReport(report: StoredRiskReport, lookup: ExplainLookup = {}): ExplainedReport {
  const explained = report.issues.map(issue => explainIssue(issue, report, lookup));
  const isNote = (issue: ExplainedIssue) => issue.severity === "WARN" && copyFor(issue.code)?.note === true;
  return {
    decision: reportDecision(report),
    blocking: explained.filter(issue => issue.severity === "BLOCK"),
    warnings: explained.filter(issue => issue.severity === "WARN" && !isNote(issue)),
    notes: explained.filter(isNote),
  };
}

/** Leading line of pre-trade AI cards: `Risk Engine · Blocked — Requested risk exceeds maximum`. */
export function riskStatusLine(report: StoredRiskReport, lookup: ExplainLookup = {}): string {
  const { decision, blocking } = explainReport(report, lookup);
  return decision === "BLOCKED" ? `Risk Engine · Blocked — ${blocking[0]?.title ?? "See reasons"}` : "Risk Engine · Approved";
}
