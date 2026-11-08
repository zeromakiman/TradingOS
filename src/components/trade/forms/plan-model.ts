import Decimal from "decimal.js";
import { formatAgainst, formatDecimal, formatMoney, formatMoneyExact, formatMoneyUp, formatPercent, formatQuantity, stripZeros } from "@/domain/format";
import { evaluateRisk, type Instrument, isDuplicatePlan, type Proposal, proposalSchema, type RiskContext } from "@/domain/risk";
import { type ExplainedIssue, explainReport } from "@/domain/risk-explain";
import type { RiskReportV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import { PLAN_FIELD_COPY } from "./copy";
import type { Direction, DraftPrefill, FormAccount, FormGap, FormRiskPlan, NewsStatus, PlanModel } from "./types";

/**
 * Pure model of Plan Trade and Edit Draft (docs/V2_ARCHITECTURE.md §6.5–6.6, §14.2): the form state, the risk presets,
 * the proposal the save action sends, field validation with the engine's sentences, price hints, and the live
 * deterministic preview. The preview runs the TypeScript engine 1.2 (`evaluateRisk`, byte parity with the SQL check) on
 * the server's risk context and today's usage, with `duplicate` decided by `isDuplicatePlan` against the account's plans
 * of the day, exactly like the server check does. Decimal strings are compared with decimal.js, never as numbers.
 */

const D = Decimal.clone({ precision: 60 });
const DECIMAL_TEXT = /^\d{1,12}(\.\d{1,8})?$/;
const NARRATIVE_LIMIT = 5000;

/** A positive decimal of at most 12 integer digits and 8 decimals (the proposal and column domain). */
export function isPositiveDecimal(value: string): boolean {
  const text = value.trim();
  return DECIMAL_TEXT.test(text) && new D(text).gt(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Form state.
// ---------------------------------------------------------------------------------------------------------------------
/** Risk per trade: one of the preset chips (its canonical value) or a custom value. */
export const CUSTOM_RISK = "custom";
/** Spec §14.2 presets: 0.25% 0.50% 0.75% 1.00%, filtered to the plan maximum. */
export const RISK_PRESETS: readonly string[] = Object.freeze(["0.25", "0.5", "0.75", "1"]);

export interface PlanDraft {
  accountId: string;
  instrumentId: string;
  direction: Direction | "";
  model: PlanModel | "";
  entry: string;
  stop: string;
  target: string;
  /** A preset (canonical decimal), `custom`, or empty when nothing is chosen. */
  riskChoice: string;
  customRisk: string;
  narrative: string;
  news: NewsStatus;
  contractConfirmed: boolean;
  contradiction: boolean;
}

export type PlanField = "accountId" | "instrumentId" | "direction" | "model" | "entry" | "stop" | "target" | "riskPercent" | "narrative";
export type PlanFieldErrors = Partial<Record<PlanField, string>>;

/** The risk-plan default (canonical): `defaultRiskPercent`, else the maximum (legacy versions, V1 behaviour). */
export function planDefaultRisk(plan: Pick<FormRiskPlan, "defaultRiskPercent" | "maxRiskPercent"> | null): string | null {
  return plan ? stripZeros(plan.defaultRiskPercent ?? plan.maxRiskPercent) : null;
}

/** Preset chips at or below the maximum, plus the plan default when it is not a preset; ascending and canonical. */
export function riskPresets(plan: Pick<FormRiskPlan, "defaultRiskPercent" | "maxRiskPercent"> | null): string[] {
  if (!plan) return [...RISK_PRESETS];
  const values = RISK_PRESETS.filter(preset => new D(preset).lte(plan.maxRiskPercent));
  const fallback = planDefaultRisk(plan);
  if (fallback !== null && !values.some(value => new D(value).eq(fallback))) values.push(fallback);
  return values.sort((a, b) => new D(a).cmp(b));
}

/** The chip a stored percent selects: the equal preset, else Custom with the value. */
export function riskChoiceFor(value: string | null, presets: readonly string[]): Pick<PlanDraft, "riskChoice" | "customRisk"> {
  if (value === null || value.trim() === "") return { riskChoice: "", customRisk: "" };
  const match = isPositiveDecimal(value) ? presets.find(preset => new D(preset).eq(value.trim())) : undefined;
  return match ? { riskChoice: match, customRisk: "" } : { riskChoice: CUSTOM_RISK, customRisk: value.trim() };
}

/** The requested risk percent the draft sends. */
export function riskPercentOf(draft: Pick<PlanDraft, "riskChoice" | "customRisk">): string {
  return draft.riskChoice === CUSTOM_RISK ? draft.customRisk.trim() : draft.riskChoice;
}

function defaultRiskOf(account: FormAccount | null): Pick<PlanDraft, "riskChoice" | "customRisk"> {
  const plan = account?.riskPlan ?? null;
  return riskChoiceFor(planDefaultRisk(plan), riskPresets(plan));
}

/** An empty plan for `account`: the risk-plan default preselected, its only instrument preselected. */
export function newPlanDraft(account: FormAccount | null): PlanDraft {
  return {
    accountId: account?.id ?? "",
    instrumentId: account?.instruments.length === 1 ? account.instruments[0].id : "",
    direction: "",
    model: "",
    entry: "",
    stop: "",
    target: "",
    ...defaultRiskOf(account),
    narrative: "",
    news: "UNKNOWN",
    contractConfirmed: false,
    contradiction: false,
  };
}

/**
 * The form state of a stored revision (Edit Draft). `instrumentId` must already be an instrument of the account (the
 * loader moves a superseded contract to the symbol's current version and clears `contractConfirmed`).
 */
export function draftFromRevision(prefill: DraftPrefill, account: FormAccount): PlanDraft {
  const instrument = account.instruments.find(item => item.id === prefill.instrumentId);
  const risk = prefill.riskPercent !== null ? riskChoiceFor(prefill.riskPercent, riskPresets(account.riskPlan)) : defaultRiskOf(account);
  return {
    accountId: account.id,
    instrumentId: instrument?.id ?? "",
    direction: prefill.direction ?? "",
    model: prefill.model ?? "",
    entry: prefill.entry ?? "",
    stop: prefill.stop ?? "",
    target: prefill.target ?? "",
    ...risk,
    narrative: prefill.narrative ?? "",
    news: prefill.news ?? "UNKNOWN",
    contractConfirmed: prefill.contractConfirmed === true && instrument !== undefined,
    contradiction: prefill.contradiction === true,
  };
}

/**
 * Moves a plan to another account: the same symbol stays selected when the account has it (its own contract version),
 * prices, thesis and checks stay; a preset above the new maximum falls back to the new default; the contract must be
 * confirmed again because the contract version changed.
 */
export function switchPlanAccount(draft: PlanDraft, next: FormAccount, accounts: readonly FormAccount[]): PlanDraft {
  const previous = accounts.find(account => account.id === draft.accountId);
  const symbol = previous?.instruments.find(item => item.id === draft.instrumentId)?.symbol;
  const sameSymbol = symbol ? next.instruments.find(item => item.symbol === symbol) : undefined;
  const instrumentId = sameSymbol?.id ?? (next.instruments.length === 1 ? next.instruments[0].id : "");
  const presets = riskPresets(next.riskPlan);
  const keepRisk = draft.riskChoice === CUSTOM_RISK || presets.includes(draft.riskChoice);
  return {
    ...draft,
    accountId: next.id,
    instrumentId,
    ...(keepRisk ? {} : defaultRiskOf(next)),
    contractConfirmed: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Proposal and validation.
// ---------------------------------------------------------------------------------------------------------------------
/** The 11 proposal keys from the form state; values may still be invalid (the engine and the schema judge them). */
export function rawProposal(draft: PlanDraft, narrative: string = draft.narrative): Record<string, unknown> {
  return {
    instrumentId: draft.instrumentId,
    direction: draft.direction,
    model: draft.model,
    entry: draft.entry.trim(),
    stop: draft.stop.trim() === "" ? null : draft.stop.trim(),
    target: draft.target.trim(),
    riskPercent: riskPercentOf(draft),
    narrative,
    contractConfirmed: draft.contractConfirmed,
    news: draft.news,
    contradiction: draft.contradiction,
  };
}

function thesisLength(text: string): number {
  return [...text.trim()].length;
}

/** Whether the thesis can be saved: 1 to 5,000 characters once trimmed. */
export function thesisValid(text: string): boolean {
  const length = thesisLength(text);
  return length >= 1 && length <= NARRATIVE_LIMIT;
}

/** Field errors of the plan as it would be saved (an empty stop is allowed: the check then blocks with MISSING_STOP). */
export function planFieldErrors(draft: PlanDraft, account: FormAccount | null): PlanFieldErrors {
  const errors: PlanFieldErrors = {};
  if (!account) errors.accountId = PLAN_FIELD_COPY.accountId;
  if (!account?.instruments.some(item => item.id === draft.instrumentId)) errors.instrumentId = PLAN_FIELD_COPY.instrumentId;
  if (draft.direction === "") errors.direction = PLAN_FIELD_COPY.direction;
  if (draft.model === "") errors.model = PLAN_FIELD_COPY.model;
  if (!isPositiveDecimal(draft.entry)) errors.entry = PLAN_FIELD_COPY.entry;
  if (draft.stop.trim() !== "" && !isPositiveDecimal(draft.stop)) errors.stop = PLAN_FIELD_COPY.stop;
  if (!isPositiveDecimal(draft.target)) errors.target = PLAN_FIELD_COPY.target;
  if (!isPositiveDecimal(riskPercentOf(draft))) errors.riskPercent = PLAN_FIELD_COPY.riskPercent;
  if (!thesisValid(draft.narrative)) errors.narrative = PLAN_FIELD_COPY.narrative;
  return errors;
}

/** The proposal to save, or the field errors that keep it from being saved. */
export function validatePlan(draft: PlanDraft, account: FormAccount | null): { ok: true; proposal: Proposal } | { ok: false; fieldErrors: PlanFieldErrors } {
  const fieldErrors = planFieldErrors(draft, account);
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };
  const parsed = proposalSchema.safeParse(rawProposal(draft));
  if (parsed.success) return { ok: true, proposal: parsed.data };
  const fallback: PlanFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "");
    const field: PlanField = key === "riskPercent" || key === "narrative" || key === "entry" || key === "stop" || key === "target" || key === "instrumentId" ? key : "narrative";
    fallback[field] = PLAN_FIELD_COPY[field];
  }
  return { ok: false, fieldErrors: fallback };
}

/** First field to focus among errors, in form order. */
export const PLAN_FIELD_ORDER: readonly PlanField[] = Object.freeze(["accountId", "instrumentId", "direction", "model", "entry", "stop", "target", "riskPercent", "narrative"]);

/** Server field errors (proposal keys or form fields) mapped onto the form's fields. */
export function planServerErrors(fieldErrors: Record<string, string> | undefined): PlanFieldErrors {
  const mapped: PlanFieldErrors = {};
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    if ((PLAN_FIELD_ORDER as readonly string[]).includes(key)) mapped[key as PlanField] = message;
  }
  return mapped;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hints.
// ---------------------------------------------------------------------------------------------------------------------
export interface FieldHint {
  text: string;
  /** A problem the check will report (wrong side, off tick); never shown in colour alone. */
  warning: boolean;
}

function plural(count: string, one: string, many: string): string {
  return `${count} ${new D(count).eq(1) ? one : many}`;
}

/** `12.3 pips` (with a pip size) or `123 ticks`; truncated, never rounded up. */
export function distanceText(distance: Decimal.Value, instrument: Pick<Instrument, "tickSize" | "pipSize">): string {
  const value = new D(distance).abs();
  if (instrument.pipSize !== null) return plural(stripZeros(value.div(instrument.pipSize).toDecimalPlaces(2, Decimal.ROUND_DOWN)), "pip", "pips");
  return plural(stripZeros(value.div(instrument.tickSize).toDecimalPlaces(2, Decimal.ROUND_DOWN)), "tick", "ticks");
}

/** `0.00000` for a tick of 0.00001: the decimals a price has on this contract. */
export function pricePlaceholder(tickSize: string): string {
  return new D(0).toFixed(new D(tickSize).decimalPlaces());
}

function onTick(price: string, tickSize: string): boolean {
  return new D(price).mod(tickSize).isZero();
}

function offTickHint(instrument: Instrument): FieldHint {
  return { text: `Not on the ${instrument.symbol} tick size of ${stripZeros(instrument.tickSize)}.`, warning: true };
}

/** `3.00R`: the reward/risk multiple, shown against the plan minimum without contradicting the engine's verdict. */
export function rrText(reward: Decimal.Value, risk: Decimal.Value, minRR: string | null): string {
  const exact = new D(reward).div(risk);
  if (minRR === null) return `${formatDecimal(exact.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed())}R`;
  const passes = new D(reward).gte(new D(risk).times(minRR));
  return `${formatAgainst(exact.toFixed(), minRR, "min", passes)}R`;
}

/** Live hints of the price fields: tick size, distance from entry, side and the planned RR. */
export function priceHints(draft: Pick<PlanDraft, "direction" | "entry" | "stop" | "target">, instrument: Instrument | null, minRR: string | null) {
  const hints: { entry: FieldHint | null; stop: FieldHint | null; target: FieldHint | null } = { entry: null, stop: null, target: null };
  if (!instrument) return hints;
  const tick: FieldHint = { text: `Tick size ${stripZeros(instrument.tickSize)}`, warning: false };
  const entryValid = isPositiveDecimal(draft.entry);
  const stopValid = isPositiveDecimal(draft.stop);
  const targetValid = isPositiveDecimal(draft.target);
  hints.entry = entryValid && !onTick(draft.entry, instrument.tickSize) ? offTickHint(instrument) : tick;
  hints.stop = draft.stop.trim() === "" ? { text: `${tick.text} · required to lock the plan`, warning: false } : tick;
  hints.target = tick;
  const long = draft.direction === "LONG";
  const side = (price: string, above: boolean) => (above ? new D(price).gt(draft.entry) : new D(price).lt(draft.entry));
  let stopOk = false;
  if (stopValid && entryValid && draft.direction !== "") {
    const correct = side(draft.stop, !long);
    stopOk = correct && onTick(draft.stop, instrument.tickSize);
    hints.stop = !correct
      ? { text: `For a ${long ? "long" : "short"} trade, the stop must be ${long ? "below" : "above"} entry.`, warning: true }
      : !onTick(draft.stop, instrument.tickSize)
        ? offTickHint(instrument)
        : { text: `${distanceText(new D(draft.entry).minus(draft.stop), instrument)} ${long ? "below" : "above"} entry`, warning: false };
  } else if (stopValid && !onTick(draft.stop, instrument.tickSize)) hints.stop = offTickHint(instrument);
  if (targetValid && entryValid && draft.direction !== "") {
    const correct = side(draft.target, long);
    if (!correct) hints.target = { text: `For a ${long ? "long" : "short"} trade, the target must be ${long ? "above" : "below"} entry.`, warning: true };
    else if (!onTick(draft.target, instrument.tickSize)) hints.target = offTickHint(instrument);
    else {
      const reward = new D(draft.target).minus(draft.entry).abs();
      const distance = `${distanceText(reward, instrument)} ${long ? "above" : "below"} entry`;
      hints.target = { text: stopOk ? `${distance} · ${rrText(reward, new D(draft.entry).minus(draft.stop).abs(), minRR)}` : distance, warning: false };
    }
  } else if (targetValid && !onTick(draft.target, instrument.tickSize)) hints.target = offTickHint(instrument);
  return hints;
}

/** `0.50% of $100,000.00 equity = $500.00 risk budget` (budget truncated to cents, as the engine sizes it). */
export function budgetHint(percent: string, account: Pick<FormAccount, "equity" | "currency" | "riskPlan">): FieldHint | null {
  if (!isPositiveDecimal(percent) || account.equity === null) return null;
  const budget = new D(account.equity).times(percent).times("0.01").toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const max = account.riskPlan?.maxRiskPercent;
  if (max !== undefined && new D(percent).gt(max)) {
    return { text: `Above your ${formatPercent(max)} maximum: the risk check will block this plan.`, warning: true };
  }
  return { text: `${formatPercent(percent)} of ${formatMoney(account.equity, account.currency)} equity = ${formatMoneyExact(budget.toFixed(), account.currency)} risk budget`, warning: false };
}

/** `Tick size 0.00001 · tick value $1.00 · size in lots (100,000 EUR), step 0.01, minimum 0.01`. */
export function contractSummary(instrument: Instrument): string {
  const tickValue = /^[A-Z]{3}$/.test(instrument.currency) ? formatMoneyExact(instrument.tickValue, instrument.currency) : stripZeros(instrument.tickValue);
  return `${instrument.symbol}: tick size ${stripZeros(instrument.tickSize)} · tick value ${tickValue} · size in ${instrument.quantityUnit}, step ${stripZeros(instrument.quantityStep)}, minimum ${stripZeros(instrument.minimumQuantity)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview (spec §14.2): the Risk Engine on the server context, with today's usage and duplicate detection.
// ---------------------------------------------------------------------------------------------------------------------
/** Inputs the engine needs to size a plan, in form order. */
export type PreviewInput = "account" | "instrument" | "direction" | "model" | "entry" | "stop" | "target" | "risk";

export const PREVIEW_INPUT_LABELS: Readonly<Record<PreviewInput, string>> = Object.freeze({
  account: "trading account", instrument: "instrument", direction: "direction", model: "model", entry: "entry", stop: "stop loss", target: "target",
  risk: "risk per trade",
});

export interface PreviewStats {
  /** `0.40` at the size step. */
  quantity: string;
  /** `lots (100,000 EUR)`: the contract's size unit. */
  unit: string;
  /** `lots`: the unit's first word, for one-line summaries. */
  unitWord: string;
  /** Money at the stop, rounded up to the cent (risk is never understated). */
  risk: string;
  /** Risk at stop as a percent of equity, never shown above the requested percent. */
  riskOfEquity: string;
  requestedRisk: string;
  /** Planned RR against the minimum (`formatAgainst`). */
  rr: string;
  /** `pass`, or how the risk plan treats an RR below its minimum (blocks or warns). */
  rrState: "pass" | "warn" | "block";
  minRR: string;
  /** `12.3 pips · 123 ticks`. */
  stopDistance: string;
  reward: string;
  budget: string;
}

export type PlanPreview =
  | { kind: "no-account" }
  | { kind: "unavailable"; gaps: FormGap[] }
  | { kind: "new-day" }
  | { kind: "incomplete"; missing: PreviewInput[]; blockers: ExplainedIssue[] }
  | {
    kind: "report";
    report: RiskReportV12;
    decision: "APPROVED" | "BLOCKED";
    blocking: ExplainedIssue[];
    warnings: ExplainedIssue[];
    notes: ExplainedIssue[];
    stats: PreviewStats | null;
    /** The thesis is still empty: the verdict assumes it will be written (saving needs it). */
    thesisMissing: boolean;
  };

/** Stand-in thesis while the field is empty, so size and RR show before the thesis is written. Never saved. */
const PREVIEW_THESIS = "Thesis not written yet.";

function contextFor(account: FormAccount, instrument: Instrument, proposal: unknown, now: string): RiskContext | null {
  if (!account.risk) return null;
  return { ...account.risk, now, instrument, duplicate: proposal !== null && isDuplicatePlan(proposal, account.todaysPlans) };
}

function missingInputs(draft: PlanDraft, instrument: Instrument | null): PreviewInput[] {
  const missing: PreviewInput[] = [];
  if (!instrument) missing.push("instrument");
  if (draft.direction === "") missing.push("direction");
  if (draft.model === "") missing.push("model");
  if (!isPositiveDecimal(draft.entry)) missing.push("entry");
  if (!isPositiveDecimal(draft.stop)) missing.push("stop");
  if (!isPositiveDecimal(draft.target)) missing.push("target");
  if (!isPositiveDecimal(riskPercentOf(draft))) missing.push("risk");
  return missing;
}

function stopDistanceText(calculations: NonNullable<RiskReportV12["calculations"]>): string {
  const ticks = stripZeros(new D(calculations.stopTicks).toDecimalPlaces(2, Decimal.ROUND_DOWN));
  const tickText = plural(ticks, "tick", "ticks");
  if (calculations.stopPips === null) return tickText;
  return `${plural(stripZeros(new D(calculations.stopPips).toDecimalPlaces(2, Decimal.ROUND_DOWN)), "pip", "pips")} · ${tickText}`;
}

/** `lots` of `lots (100,000 EUR)`: the first word of a size unit. */
export function unitWord(quantityUnit: string): string {
  return quantityUnit.trim().split(/[\s(]/)[0] || quantityUnit.trim();
}

function statsOf(report: RiskReportV12, instrument: Instrument, currency: string): PreviewStats | null {
  const calculations = report.calculations;
  if (!calculations) return null;
  const requested = report.requestedRiskPercent ?? "0";
  const nominal = new D(calculations.nominalRisk);
  const ofEquity = nominal.times(100).div(report.snapshot.equity);
  const minRrIssue = report.issues.find(issue => issue.code === "MIN_RR");
  const rrState = minRrIssue === undefined ? "pass" : minRrIssue.severity === "WARN" ? "warn" : "block";
  return {
    quantity: formatQuantity(calculations.quantity, instrument.quantityStep),
    unit: instrument.quantityUnit,
    unitWord: unitWord(instrument.quantityUnit),
    risk: formatMoneyUp(nominal, currency),
    riskOfEquity: `${formatAgainst(ofEquity.toFixed(), requested, "max", ofEquity.lte(requested))}%`,
    requestedRisk: formatPercent(requested),
    rr: `${formatAgainst(calculations.plannedRR, report.limits.minRR, "min", rrState === "pass")}R`,
    rrState,
    minRR: `${formatDecimal(report.limits.minRR)}R`,
    stopDistance: stopDistanceText(calculations),
    reward: formatMoney(calculations.plannedReward, currency),
    budget: formatMoneyExact(calculations.budget, currency),
  };
}

/**
 * The preview of the plan at `now` (server-anchored time). Until the engine has every sizing input it reports what is
 * missing, plus the blocks that apply to any plan right now (daily trade limit, Dead Pool, stale account values: the
 * engine evaluates those even for incomplete input). An empty thesis is replaced by a stand-in so the verdict shows
 * early; it is reported separately because saving needs it.
 */
export function previewPlan(draft: PlanDraft, account: FormAccount | null, now: string): PlanPreview {
  if (!account) return { kind: "no-account" };
  if (!account.risk || account.gaps.length > 0) return { kind: "unavailable", gaps: account.gaps.length ? account.gaps : ["UNAVAILABLE"] };
  if (account.risk.usage.day !== strategyClock(now).day) return { kind: "new-day" };
  const instrument = account.instruments.find(item => item.id === draft.instrumentId) ?? null;
  const missing = missingInputs(draft, instrument);
  if (missing.length > 0) {
    const anyInstrument = instrument ?? account.instruments[0];
    const context = anyInstrument ? contextFor(account, anyInstrument, null, now) : null;
    const blockers = context ? explainReport(evaluateRisk({}, context)).blocking.filter(issue => issue.code !== "INVALID_INPUT") : [];
    return { kind: "incomplete", missing, blockers };
  }
  const contract = instrument as Instrument;
  const thesisMissing = !thesisValid(draft.narrative);
  const proposal = rawProposal(draft, thesisMissing ? PREVIEW_THESIS : draft.narrative);
  const context = contextFor(account, contract, proposal, now);
  if (!context) return { kind: "unavailable", gaps: ["UNAVAILABLE"] };
  const report = evaluateRisk(proposal, context);
  const explained = explainReport(report);
  return {
    kind: "report",
    report,
    decision: explained.decision,
    blocking: explained.blocking,
    warnings: explained.warnings,
    notes: explained.notes,
    stats: statsOf(report, contract, account.currency),
    thesisMissing,
  };
}

/** `entry, stop loss and target`. */
export function listInputs(inputs: readonly PreviewInput[]): string {
  const words = inputs.map(input => PREVIEW_INPUT_LABELS[input]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export interface PreviewSummary {
  tone: "positive" | "negative" | "neutral" | "warning";
  /** `Approved`, `Blocked`, `Incomplete`. */
  label: string;
  /** One line: size and risk, the first reason, or what is missing. */
  detail: string;
}

/** The one-line verdict of the mobile action bar. */
export function previewSummary(preview: PlanPreview): PreviewSummary {
  switch (preview.kind) {
    case "no-account": return { tone: "neutral", label: "Incomplete", detail: "Choose a trading account" };
    case "unavailable": return { tone: "warning", label: "Not ready", detail: "Account setup needed" };
    case "new-day": return { tone: "warning", label: "Reload", detail: "A new trading day started" };
    case "incomplete":
      return preview.blockers.length
        ? { tone: "negative", label: "Blocked", detail: preview.blockers[0].title }
        : { tone: "neutral", label: "Incomplete", detail: `Add the ${listInputs(preview.missing.slice(0, 2))}${preview.missing.length > 2 ? "…" : ""}` };
    case "report":
      if (preview.decision === "BLOCKED") {
        const more = preview.blocking.length - 1;
        return { tone: "negative", label: "Blocked", detail: `${preview.blocking[0]?.title ?? "See reasons"}${more > 0 ? ` · +${more} more` : ""}` };
      }
      return {
        tone: "positive",
        label: "Approved",
        detail: preview.stats ? `${preview.stats.quantity} ${preview.stats.unitWord} · ${preview.stats.risk} risk · ${preview.stats.rr}` : "Ready to save",
      };
  }
}

/** The field a blocking reason points at, for its "fix" button. */
export const REASON_FIELDS: Readonly<Partial<Record<string, { field: PlanField | "contract" | "contradiction" | "news"; label: string }>>> = Object.freeze({
  RISK_LIMIT: { field: "riskPercent", label: "Change risk" },
  MINIMUM_QUANTITY: { field: "riskPercent", label: "Change risk" },
  MIN_RR: { field: "target", label: "Adjust target" },
  OFF_TICK: { field: "entry", label: "Check prices" },
  PRICE_GEOMETRY: { field: "stop", label: "Check stop" },
  MISSING_STOP: { field: "stop", label: "Add stop" },
  CONTRACT_UNCONFIRMED: { field: "contract", label: "Confirm contract" },
  STRATEGY_CONTRADICTION: { field: "contradiction", label: "Review flag" },
  NEWS_RESTRICTED: { field: "news", label: "Review news" },
  NEWS_UNKNOWN: { field: "news", label: "Set news" },
  DUPLICATE: { field: "entry", label: "Check prices" },
});
