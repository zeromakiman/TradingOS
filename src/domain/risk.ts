import Decimal from "decimal.js";
import { z } from "zod";
import { INVALID_INPUT_FIELD_COPY, unplannedRiskSentence } from "./risk-explain";
import { RISK_RULES, type RiskReportV12 } from "./risk-report";
import { type Session, strategyClock } from "./session";
import { isCalendarDay } from "./time-display";

/**
 * Risk Engine 1.1 / report 1.2 (V2 spec §6): the TypeScript mirror of `private.risk_report_v12`
 * (supabase/migrations/0016_risk_engine_usage.sql). For the same proposal JSON and the same context
 * both engines produce the same report, byte for byte, except `evaluatedAt`
 * (tests/v2-risk-engine-parity.test.ts). The SQL engine stays authoritative: a lock always
 * re-evaluates on the server.
 *
 * Exactness rules shared with SQL:
 * - decimal.js at 100 significant digits: every sum, product and integer quotient below is exact for
 *   database-valid inputs. The only quotients that may not terminate (prices off the tick grid, pip
 *   counts of odd pip sizes) are truncated to 20 decimals, the planned RR to 8 decimals
 *   (`div(reward × 10^8, distance) / 10^8`), money budgets to cents.
 * - Verdicts compare exact values: MIN_RR cross-multiplies, caps use a strict `>`.
 * - Every decimal in the report is canonical text (SQL `trim_scale`): no trailing zeros, never
 *   exponent notation. Integers stay JSON numbers.
 */

const V1 = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const decimalString = z.string().refine(v => /^\d{1,12}(\.\d{1,8})?$/.test(v) && new V1(v).gt(0), "Use a positive decimal, up to 8 decimal places.");
export const proposalSchema = z.object({
  instrumentId: z.string().uuid(), direction: z.enum(["LONG", "SHORT"]), model: z.enum(["OB_FIRST_TOUCH", "OTE"]),
  entry: decimalString, stop: decimalString.nullable(), target: decimalString,
  riskPercent: decimalString, narrative: z.string().trim().min(1).max(5000),
  contractConfirmed: z.boolean(), news: z.enum(["UNKNOWN", "CLEAR", "RESTRICTED"]),
  contradiction: z.boolean()
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;

/** Engine arithmetic: exact for every database-valid input (see the module comment). */
const E = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN, modulo: Decimal.ROUND_DOWN });
type Exact = InstanceType<typeof E>;

// ---------------------------------------------------------------------------------------------
// Daily usage (spec §6.2, §6.7): exactly the JSON of private.daily_usage / get_daily_risk_usage.
// ---------------------------------------------------------------------------------------------
const usageMoney = z.string().regex(/^\d+(\.\d+)?$/, "Expected a non-negative decimal string.");
const usageCount = z.number().int().nonnegative();

/** Spec §6.7. */
export interface DailyUsage {
  /** Strategy day `YYYY-MM-DD` the usage was computed for. */
  day: string;
  plannedSlots: number; plannedRisk: string;
  unplannedTrades: number; unplannedRisk: string; unplannedRiskUnknown: number;
  realizedLoss: string; externalLoss: string; legacyReportedLoss: string | null;
  openExposure: string; openRiskUnknown: number; riskUnknownTrades: number;
  /** greatest(coalesce(legacyReportedLoss, 0), realizedLoss + externalLoss). */
  lossTotal: string;
}

/**
 * `private.daily_usage` / `get_daily_risk_usage` (spec §6.2, §6.7): exactly these keys, computed for
 * the strategy day `day`. `riskUnknownTrades` counts distinct trades without a risk basis; the
 * per-day (`unplannedRiskUnknown`) and open (`openRiskUnknown`) counters overlap and are never summed.
 */
export const dailyUsageSchema = z.object({
  day: z.string().refine(isCalendarDay, "Expected a YYYY-MM-DD strategy day."),
  plannedSlots: usageCount,
  plannedRisk: usageMoney,
  unplannedTrades: usageCount,
  unplannedRisk: usageMoney,
  unplannedRiskUnknown: usageCount,
  realizedLoss: usageMoney,
  externalLoss: usageMoney,
  legacyReportedLoss: usageMoney.nullable(),
  openExposure: usageMoney,
  openRiskUnknown: usageCount,
  riskUnknownTrades: usageCount,
  lossTotal: usageMoney,
}).strict().superRefine((usage, ctx) => {
  const expected = E.max(usage.legacyReportedLoss ?? 0, new E(usage.realizedLoss).plus(usage.externalLoss));
  if (!expected.eq(usage.lossTotal)) ctx.addIssue({ code: "custom", message: "lossTotal must equal greatest(legacyReportedLoss, realizedLoss + externalLoss)." });
  if (usage.riskUnknownTrades < Math.max(usage.unplannedRiskUnknown, usage.openRiskUnknown) || usage.riskUnknownTrades > usage.unplannedRiskUnknown + usage.openRiskUnknown) {
    ctx.addIssue({ code: "custom", message: "riskUnknownTrades must count each trade without a risk basis once." });
  }
}) satisfies z.ZodType<DailyUsage>;

// ---------------------------------------------------------------------------------------------
// Context (spec §6.7).
// ---------------------------------------------------------------------------------------------
export interface RiskPlan {
  id: string; version: string; maxRiskPercent: string; defaultRiskPercent: string | null;
  maxDailyTrades: number; minRR: string; rrPolicy: "BLOCK" | "WARN"; newsPolicy: "BLOCK" | "WARN";
  dailyRiskCap: string | null; dailyLossCap: string | null;
}
export interface Instrument {
  id: string; symbol: string; currency: string; quantityUnit: string; tickSize: string; pipSize: string | null;
  tickValue: string; quantityStep: string; minimumQuantity: string;
}
export interface RiskContext {
  /** Server time, ISO 8601 with an explicit zone. Never the browser clock. */
  now: string;
  strategyVersionId: string; strategyVersion: string;
  observationId: string; observationDay: string; equity: string; currency: string;
  plan: RiskPlan; instrument: Instrument;
  /** Daily usage of the strategy day of `now` (as `get_daily_risk_usage` returns it). */
  usage: DailyUsage;
  /** Whether the evaluated proposal repeats a plan locked today: `isDuplicatePlan(proposal, today's plans)`. */
  duplicate: boolean;
}

export type RiskIssueV12 = RiskReportV12["issues"][number];
export type RiskRuleResult = RiskReportV12["ruleResults"][number];
export type RiskCalculations = NonNullable<RiskReportV12["calculations"]>;
export type RiskRule = (typeof RISK_RULES)[number];
export interface RiskIssue { code: string; severity: "BLOCK" | "WARN"; message: string }
/** The shape every engine version shares (1.0 legacy, 1.1 and 1.2 reports). */
export interface RiskResult {
  engineVersion: "1.0" | "1.1"; evaluatedAt: string; tradingDay: string; session: Session;
  strategyVersionId: string; riskPlanVersionId: string; status: "RISK_APPROVED" | "TRADE_BLOCKED";
  issues: RiskIssue[];
  calculations: null | { budget: string; permittedRisk: string; stopDistance: string; stopTicks: string; stopPips: string | null; plannedRR: string; quantity: string; nominalRisk: string; plannedReward: string };
}

export const ENGINE_VERSION = "1.1";
export const REPORT_VERSION = "1.2";

// ---------------------------------------------------------------------------------------------
// Message catalogue shared with SQL (report 1.2 stores these sentences in `message` for audit;
// the UI renders from code + params through risk-explain.ts). Values are exact: percentages, RR and
// money are canonical and padded to at least 2 decimals, money carries the account currency code.
// ---------------------------------------------------------------------------------------------
/** Concise on purpose: rule results travel inside every AI facts package; the 1.2 limits say why (e.g. no cap). */
const NOT_EVALUATED = "Not evaluated.";
const CHECK_PASSED = "Check passed.";
const NO_CONTRADICTION = "No contradiction reported; qualitative setup is not evaluated.";
const INVALID_INPUT_FALLBACK = "Some trade details are missing or invalid. Review the plan and try again.";
const INVALID_CONTEXT_MESSAGE = "Account, instrument or risk configuration is invalid.";
const MESSAGES = {
  DEAD_POOL: "Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.",
  OUTSIDE_ACTIVE: "Outside the active kill zone (02:00–12:00 UTC−5).",
  MISSING_STOP: "A stop loss is required.",
  DUPLICATE: "An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today.",
  NEWS_UNKNOWN: "Economic news has not been checked.",
  DAILY_RISK_UNCONFIGURED: "No daily risk cap is configured.",
  DAILY_LOSS_UNCONFIGURED: "No daily loss limit is configured.",
  COSTS_UNKNOWN: "Sizing uses the stop distance only; fees, gaps and slippage are not included.",
  SIZING_INVARIANT: "Position sizing failed an internal safety check. Nothing was locked.",
} as const;

/** Canonical decimal text (SQL `trim_scale(x)::text`). */
function canonical(value: Exact): string {
  const text = value.toFixed();
  return text === "-0" ? "0" : text;
}
/** Exact value padded to at least 2 decimals (`0.5` → `0.50`, `0.504` → `0.504`). */
function padded(value: Exact): string {
  return value.decimalPlaces() < 2 ? value.toFixed(2) : canonical(value);
}
function money(value: Exact, currency: string): string {
  return `${padded(value)} ${currency}`;
}
/** Truncation of a / b to `places` decimals (exact integer division, as SQL `div(a × 10^k, b) × 10^-k`). */
function truncatedQuotient(a: Exact, b: Exact, places: number): Exact {
  const scale = new E(10).pow(places);
  return a.times(scale).dividedToIntegerBy(b).div(scale);
}

// ---------------------------------------------------------------------------------------------
// Proposal validation (identical to SQL): an object with exactly the 11 keys of proposalSchema.
// ---------------------------------------------------------------------------------------------
const PROPOSAL_FIELDS = ["instrumentId", "direction", "model", "entry", "stop", "target", "riskPercent", "narrative", "contractConfirmed", "news", "contradiction"] as const;
type ProposalField = (typeof PROPOSAL_FIELDS)[number];
const PRICE_TEXT = /^[0-9]{1,12}(\.[0-9]{1,8})?$/;
const UUID_TEXT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/**
 * Characters trimmed from both ends of the narrative: ECMAScript white space and line terminators.
 * SQL trims exactly the same set (btrim with an explicit character list), so a blank-looking
 * thesis such as "\n\t" is invalid in both engines (precision finding C15).
 */
export const NARRATIVE_BLANK_CHARACTERS = "\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

function trimBlank(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && NARRATIVE_BLANK_CHARACTERS.includes(text[start])) start++;
  while (end > start && NARRATIVE_BLANK_CHARACTERS.includes(text[end - 1])) end--;
  return text.slice(start, end);
}
/** Characters as PostgreSQL counts them (code points, not UTF-16 units). */
function characterCount(text: string): number {
  return [...text].length;
}
function isPositivePrice(value: unknown): value is string {
  return typeof value === "string" && PRICE_TEXT.test(value) && new E(value).gt(0);
}
const FIELD_VALID: Readonly<Record<ProposalField, (value: unknown) => boolean>> = {
  instrumentId: value => typeof value === "string" && UUID_TEXT.test(value),
  direction: value => value === "LONG" || value === "SHORT",
  model: value => value === "OB_FIRST_TOUCH" || value === "OTE",
  entry: isPositivePrice,
  stop: value => value === null || isPositivePrice(value),
  target: isPositivePrice,
  riskPercent: isPositivePrice,
  narrative: value => {
    if (typeof value !== "string") return false;
    const length = characterCount(trimBlank(value));
    return length >= 1 && length <= 5000;
  },
  contractConfirmed: value => typeof value === "boolean",
  news: value => value === "UNKNOWN" || value === "CLEAR" || value === "RESTRICTED",
  contradiction: value => typeof value === "boolean",
};

interface EngineProposal {
  instrumentId: string; direction: "LONG" | "SHORT"; model: "OB_FIRST_TOUCH" | "OTE";
  entry: Exact; stop: Exact | null; target: Exact; riskPercent: Exact;
  contractConfirmed: boolean; news: "UNKNOWN" | "CLEAR" | "RESTRICTED"; contradiction: boolean;
}
type ProposalReading = { valid: true; proposal: EngineProposal } | { valid: false; fields: ProposalField[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON semantics: a key whose value is `undefined` is absent (JSON.stringify drops it). */
function readProposal(raw: unknown): ProposalReading {
  if (!isPlainObject(raw)) return { valid: false, fields: [] };
  const known: readonly string[] = PROPOSAL_FIELDS;
  const unknownKey = Object.keys(raw).some(key => raw[key] !== undefined && !known.includes(key));
  const fields = PROPOSAL_FIELDS.filter(field => raw[field] === undefined || !Object.hasOwn(raw, field) || !FIELD_VALID[field](raw[field]));
  if (unknownKey || fields.length > 0) return { valid: false, fields };
  const value = raw as Record<ProposalField, unknown>;
  return {
    valid: true,
    proposal: {
      instrumentId: value.instrumentId as string,
      direction: value.direction as EngineProposal["direction"],
      model: value.model as EngineProposal["model"],
      entry: new E(value.entry as string),
      stop: value.stop === null ? null : new E(value.stop as string),
      target: new E(value.target as string),
      riskPercent: new E(value.riskPercent as string),
      contractConfirmed: value.contractConfirmed as boolean,
      news: value.news as EngineProposal["news"],
      contradiction: value.contradiction as boolean,
    },
  };
}

function invalidInputMessage(fields: readonly ProposalField[]): string {
  return fields.length ? fields.map(field => INVALID_INPUT_FIELD_COPY[field]).join(" ") : INVALID_INPUT_FALLBACK;
}

// ---------------------------------------------------------------------------------------------
// DUPLICATE input (spec §6.3): the rule private.assess_plan applies before it evaluates, so that a
// preview computes `RiskContext.duplicate` exactly as the server check will.
// ---------------------------------------------------------------------------------------------
/** A plan the account locked on the strategy day of the check: one `trade_plans` row. */
export interface DuplicateCandidate {
  /** `trade_plans.instrument_version_id`. */
  instrumentVersionId: string;
  /** `trade_plans.proposal`: the locked proposal JSON. */
  proposal: unknown;
}

function isPriceText(value: unknown): value is string {
  return typeof value === "string" && PRICE_TEXT.test(value);
}

/**
 * `RiskContext.duplicate` for `proposal`, decided exactly like private.assess_plan: true when one of `todaysPlans`
 * has the proposal's instrument version (identifiers compare in lowercase), the same direction and model, and a
 * numerically equal entry, stop and target ("1.1" equals "1.10000"); risk, thesis, news and flags do not matter.
 * `todaysPlans` are the account's plans whose `trading_day` is the strategy day of the check (`usage.day`), read with
 * the user's session; a recheck of a locked plan leaves that plan out, as private.check_proposal_risk does.
 * Only a proposal whose entry, stop and target are price strings (at most 12 digits and 8 decimals) can be a
 * duplicate: any other proposal is INVALID_INPUT, which the engine reports before DUPLICATE is evaluated.
 */
export function isDuplicatePlan(proposal: unknown, todaysPlans: readonly DuplicateCandidate[]): boolean {
  if (!isPlainObject(proposal)) return false;
  const { instrumentId, direction, model, entry, stop, target } = proposal;
  if (typeof instrumentId !== "string" || !isPriceText(entry) || !isPriceText(stop) || !isPriceText(target)) return false;
  const instrument = instrumentId.toLowerCase();
  const samePrice = (locked: unknown, price: string) => isPriceText(locked) && new E(locked).eq(price);
  return todaysPlans.some(plan => {
    const locked = plan.proposal;
    return isPlainObject(locked) && plan.instrumentVersionId.toLowerCase() === instrument
      && typeof locked.direction === "string" && locked.direction === direction
      && typeof locked.model === "string" && locked.model === model
      && samePrice(locked.entry, entry) && samePrice(locked.stop, stop) && samePrice(locked.target, target);
  });
}

// ---------------------------------------------------------------------------------------------
// Context normalisation (precision findings C11, C14): long SQL-scale strings are accepted and made
// canonical; identifiers compare in lowercase. Values outside the database's domains are refused
// as INVALID_CONTEXT (TypeScript only: SQL reads typed columns).
// ---------------------------------------------------------------------------------------------
/** Database column domain of plan, instrument and equity values (numeric(20,8) or narrower). */
const COLUMN_DECIMAL = /^\d{1,12}(\.\d{1,8})?$/;
/** Daily usage sums (trim_scale text of numeric sums). */
const USAGE_DECIMAL = /^\d{1,30}(\.\d{1,40})?$/;
const CURRENCY = /^[A-Z]{3}$/;

interface NormalizedUsage {
  day: string;
  plannedSlots: number; plannedRisk: Exact; unplannedTrades: number; unplannedRisk: Exact; unplannedRiskUnknown: number;
  realizedLoss: Exact; externalLoss: Exact; legacyReportedLoss: Exact | null; openExposure: Exact; openRiskUnknown: number;
  riskUnknownTrades: number; lossTotal: Exact;
}
interface NormalizedContext {
  strategyVersionId: string; strategyVersion: string; observationId: string; observationDay: string;
  equity: Exact; currency: string; duplicate: boolean;
  plan: {
    id: string; version: string; maxRiskPercent: Exact; defaultRiskPercent: Exact | null; maxDailyTrades: number;
    minRR: Exact; rrPolicy: "BLOCK" | "WARN"; newsPolicy: "BLOCK" | "WARN"; dailyRiskCap: Exact | null; dailyLossCap: Exact | null;
  };
  instrument: {
    id: string; symbol: string; currency: string; quantityUnit: string; tickSize: Exact; pipSize: Exact | null;
    tickValue: Exact; quantityStep: Exact; minimumQuantity: Exact;
  };
  usage: NormalizedUsage;
}

class InvalidContext extends Error {}

function positive(value: unknown): Exact {
  if (typeof value !== "string" || !COLUMN_DECIMAL.test(value)) throw new InvalidContext();
  const number = new E(value);
  if (!number.gt(0)) throw new InvalidContext();
  return number;
}
function optionalPositive(value: unknown): Exact | null {
  return value === null ? null : positive(value);
}
function usageDecimal(value: unknown): Exact {
  if (typeof value !== "string" || !USAGE_DECIMAL.test(value)) throw new InvalidContext();
  return new E(value);
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new InvalidContext();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new InvalidContext();
  return value;
}
function policy(value: unknown): "BLOCK" | "WARN" {
  if (value !== "BLOCK" && value !== "WARN") throw new InvalidContext();
  return value;
}

function normalizeUsage(usage: DailyUsage): NormalizedUsage {
  if (typeof usage !== "object" || usage === null || typeof usage.day !== "string" || !isCalendarDay(usage.day)) throw new InvalidContext();
  const normalized: NormalizedUsage = {
    day: usage.day,
    plannedSlots: count(usage.plannedSlots), plannedRisk: usageDecimal(usage.plannedRisk),
    unplannedTrades: count(usage.unplannedTrades), unplannedRisk: usageDecimal(usage.unplannedRisk), unplannedRiskUnknown: count(usage.unplannedRiskUnknown),
    realizedLoss: usageDecimal(usage.realizedLoss), externalLoss: usageDecimal(usage.externalLoss),
    legacyReportedLoss: usage.legacyReportedLoss === null ? null : usageDecimal(usage.legacyReportedLoss),
    openExposure: usageDecimal(usage.openExposure), openRiskUnknown: count(usage.openRiskUnknown),
    riskUnknownTrades: count(usage.riskUnknownTrades), lossTotal: usageDecimal(usage.lossTotal),
  };
  const expected = E.max(normalized.legacyReportedLoss ?? 0, normalized.realizedLoss.plus(normalized.externalLoss));
  const unknown = normalized.riskUnknownTrades;
  if (!expected.eq(normalized.lossTotal)
    || unknown < Math.max(normalized.unplannedRiskUnknown, normalized.openRiskUnknown)
    || unknown > normalized.unplannedRiskUnknown + normalized.openRiskUnknown) throw new InvalidContext();
  return normalized;
}

/** Null when any value is outside its domain (or the context is structurally incomplete). */
function normalizeContext(ctx: RiskContext): NormalizedContext | null {
  try {
    const { plan, instrument } = ctx;
    const maxRiskPercent = positive(plan.maxRiskPercent);
    const minRR = positive(plan.minRR);
    const defaultRiskPercent = optionalPositive(plan.defaultRiskPercent);
    if (maxRiskPercent.gt(100) || minRR.gt(100) || defaultRiskPercent?.gt(maxRiskPercent)) throw new InvalidContext();
    if (!Number.isInteger(plan.maxDailyTrades) || plan.maxDailyTrades < 1 || plan.maxDailyTrades > 100) throw new InvalidContext();
    if (typeof ctx.observationDay !== "string" || !isCalendarDay(ctx.observationDay)) throw new InvalidContext();
    if (typeof ctx.currency !== "string" || !CURRENCY.test(ctx.currency) || typeof instrument.currency !== "string" || !CURRENCY.test(instrument.currency)) throw new InvalidContext();
    if (typeof instrument.quantityUnit !== "string" || typeof ctx.duplicate !== "boolean") throw new InvalidContext();
    return {
      strategyVersionId: text(ctx.strategyVersionId).toLowerCase(),
      strategyVersion: text(ctx.strategyVersion),
      observationId: text(ctx.observationId).toLowerCase(),
      observationDay: ctx.observationDay,
      equity: positive(ctx.equity),
      currency: ctx.currency,
      duplicate: ctx.duplicate,
      plan: {
        id: text(plan.id).toLowerCase(), version: text(plan.version), maxRiskPercent, defaultRiskPercent, maxDailyTrades: plan.maxDailyTrades,
        minRR, rrPolicy: policy(plan.rrPolicy), newsPolicy: policy(plan.newsPolicy),
        dailyRiskCap: optionalPositive(plan.dailyRiskCap), dailyLossCap: optionalPositive(plan.dailyLossCap),
      },
      instrument: {
        id: text(instrument.id).toLowerCase(), symbol: text(instrument.symbol), currency: instrument.currency, quantityUnit: instrument.quantityUnit,
        tickSize: positive(instrument.tickSize), pipSize: optionalPositive(instrument.pipSize), tickValue: positive(instrument.tickValue),
        quantityStep: positive(instrument.quantityStep), minimumQuantity: positive(instrument.minimumQuantity),
      },
      usage: normalizeUsage(ctx.usage),
    };
  } catch (error) {
    // A missing nested object (TypeError) is as unreadable as a value outside its domain.
    if (error instanceof InvalidContext || error instanceof TypeError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Engine core (SQL private.evaluate_risk_v12).
// ---------------------------------------------------------------------------------------------
interface CoreResult {
  issues: RiskIssueV12[];
  calculations: RiskCalculations | null;
  proposal: EngineProposal | null;
}

function evaluateCore(raw: unknown, c: NormalizedContext, day: string, session: Session): CoreResult {
  const issues: RiskIssueV12[] = [];
  const add = (code: string, severity: "BLOCK" | "WARN", message: string, params: RiskIssueV12["params"] = {}) => {
    issues.push({ code, severity, message, params });
  };
  const has = (code: string) => issues.some(issue => issue.code === code);
  const { plan, instrument, usage } = c;
  const slotsUsed = usage.plannedSlots + usage.unplannedTrades;
  const stale = c.observationDay !== day;
  const result: CoreResult = { issues, calculations: null, proposal: null };

  // MAX_TRADES, DEAD_POOL and STALE_EQUITY are always evaluated, even when sizing stops early (§6.3).
  const coverage = () => {
    if (slotsUsed >= plan.maxDailyTrades && !has("MAX_TRADES")) addMaxTrades();
    if (session === "DEAD_POOL" && !has("DEAD_POOL")) add("DEAD_POOL", "BLOCK", MESSAGES.DEAD_POOL);
    if (stale && !has("STALE_EQUITY")) addStaleEquity();
    return result;
  };
  const addMaxTrades = () => add("MAX_TRADES", "BLOCK",
    `Daily trade limit reached: ${slotsUsed} of ${plan.maxDailyTrades} trades already used today (${usage.plannedSlots} planned, ${usage.unplannedTrades} recorded live).`,
    { used: slotsUsed, max: plan.maxDailyTrades, planned: usage.plannedSlots, unplanned: usage.unplannedTrades });
  const addStaleEquity = () => add("STALE_EQUITY", "BLOCK",
    `Confirm today's account balance before locking (last recorded ${c.observationDay}).`, { observationDay: c.observationDay });

  const reading = readProposal(raw);
  if (!reading.valid) {
    add("INVALID_INPUT", "BLOCK", invalidInputMessage(reading.fields), { fields: reading.fields.join(",") });
    return coverage();
  }
  const p = reading.proposal;
  result.proposal = p;
  if (p.instrumentId.toLowerCase() !== instrument.id || instrument.currency !== c.currency) {
    add("INSTRUMENT_MISMATCH", "BLOCK",
      instrument.currency !== c.currency
        ? `${instrument.symbol} is valued in ${instrument.currency}, but this account uses ${c.currency}.`
        : "This instrument does not belong to the selected trading account.",
      { symbol: instrument.symbol, instrumentCurrency: instrument.currency, accountCurrency: c.currency });
  }
  if (!p.contractConfirmed) {
    add("CONTRACT_UNCONFIRMED", "BLOCK", `Confirm that the ${instrument.symbol} contract values match your broker.`, { symbol: instrument.symbol });
  }
  if (p.stop === null) {
    add("MISSING_STOP", "BLOCK", MESSAGES.MISSING_STOP);
    return coverage();
  }
  const { entry, stop, target } = p;
  const long = p.direction === "LONG";
  if (!(long ? stop.lt(entry) && target.gt(entry) : stop.gt(entry) && target.lt(entry))) {
    add("PRICE_GEOMETRY", "BLOCK",
      long ? "For a long trade, the stop must be below entry and the target above entry." : "For a short trade, the stop must be above entry and the target below entry.",
      { direction: p.direction });
    return coverage();
  }
  const tick = instrument.tickSize;
  if ([entry, stop, target].some(price => !price.mod(tick).isZero())) {
    add("OFF_TICK", "BLOCK", `Prices must align to the ${instrument.symbol} tick size of ${canonical(tick)}.`, { symbol: instrument.symbol, tick: canonical(tick) });
  }

  // Sizing: budget truncated to cents; quantity = floor(budget × tick / (distance × tick value × step)) × step.
  const distance = entry.minus(stop).abs();
  const reward = target.minus(entry).abs();
  const budget = c.equity.times(p.riskPercent).times("0.01").toDecimalPlaces(2, E.ROUND_DOWN);
  const permitted = c.equity.times(plan.maxRiskPercent).times("0.01").toDecimalPlaces(2, E.ROUND_DOWN);
  const quantity = budget.times(tick).dividedToIntegerBy(distance.times(instrument.tickValue).times(instrument.quantityStep)).times(instrument.quantityStep);
  const stopTicks = truncatedQuotient(distance, tick, 20);
  const nominal = quantity.times(stopTicks).times(instrument.tickValue);
  if (nominal.gt(budget)) {
    add("SIZING_INVARIANT", "BLOCK", MESSAGES.SIZING_INVARIANT);
    return coverage();
  }
  const plannedRR = truncatedQuotient(reward, distance, 8);
  result.calculations = {
    budget: canonical(budget),
    permittedRisk: canonical(permitted),
    stopDistance: canonical(distance),
    stopTicks: canonical(stopTicks),
    stopPips: instrument.pipSize === null ? null : canonical(truncatedQuotient(distance, instrument.pipSize, 20)),
    plannedRR: canonical(plannedRR),
    quantity: canonical(quantity),
    nominalRisk: canonical(nominal),
    plannedReward: canonical(truncatedQuotient(reward, tick, 20).times(instrument.tickValue).times(quantity)),
  };

  if (p.riskPercent.gt(plan.maxRiskPercent)) {
    add("RISK_LIMIT", "BLOCK", `Requested risk ${padded(p.riskPercent)}% exceeds your configured maximum of ${padded(plan.maxRiskPercent)}%.`,
      { requested: canonical(p.riskPercent), maximum: canonical(plan.maxRiskPercent) });
  }
  if (quantity.lt(instrument.minimumQuantity)) {
    add("MINIMUM_QUANTITY", "BLOCK",
      `Your ${money(budget, c.currency)} risk budget is too small for the minimum position size of ${canonical(instrument.minimumQuantity)} ${instrument.quantityUnit} at this stop.`,
      { budget: canonical(budget), minQty: canonical(instrument.minimumQuantity), unit: instrument.quantityUnit });
  }
  // Cross multiplication: the verdict never depends on a rounded quotient.
  if (reward.lt(distance.times(plan.minRR))) {
    add("MIN_RR", plan.rrPolicy,
      plan.rrPolicy === "BLOCK"
        ? `Planned RR ${padded(plannedRR)}R is below the required minimum of ${padded(plan.minRR)}R.`
        : `Planned RR ${padded(plannedRR)}R is below your ${padded(plan.minRR)}R minimum. Your risk plan allows it with a warning.`,
      { rr: canonical(plannedRR), min: canonical(plan.minRR) });
  }
  if (slotsUsed >= plan.maxDailyTrades) addMaxTrades();
  if (session === "DEAD_POOL") add("DEAD_POOL", "BLOCK", MESSAGES.DEAD_POOL);
  else if (session !== "ACTIVE_KILL_ZONE") add("OUTSIDE_ACTIVE", "WARN", MESSAGES.OUTSIDE_ACTIVE);
  if (c.duplicate) add("DUPLICATE", "BLOCK", MESSAGES.DUPLICATE);
  if (stale) addStaleEquity();
  if (p.contradiction) {
    add("STRATEGY_CONTRADICTION", "BLOCK", `Blocked because you flagged a contradiction with your ${c.strategyVersion} rules.`, { strategy: c.strategyVersion });
  }
  if (p.news === "RESTRICTED") {
    add("NEWS_RESTRICTED", plan.newsPolicy,
      `You reported a restricted news window. Your risk plan ${plan.newsPolicy === "BLOCK" ? "blocks" : "warns about"} trading in restricted news.`);
  }
  if (p.news === "UNKNOWN") add("NEWS_UNKNOWN", "WARN", MESSAGES.NEWS_UNKNOWN);
  const riskUsed = usage.plannedRisk.plus(usage.unplannedRisk);
  if (plan.dailyRiskCap === null) add("DAILY_RISK_UNCONFIGURED", "WARN", MESSAGES.DAILY_RISK_UNCONFIGURED);
  else if (riskUsed.plus(nominal).gt(plan.dailyRiskCap)) {
    const remaining = E.max(plan.dailyRiskCap.minus(riskUsed), 0);
    // A nominal within the remaining risk only occurs for a zero-size trade once the reserved risk already exceeds the
    // cap (e.g. after an immediate tightening): the sentence then names the reserved risk, as risk-explain renders it.
    add("DAILY_RISK_LIMIT", "BLOCK",
      nominal.lte(remaining)
        ? `Today's reserved risk ${money(riskUsed, c.currency)} plus this trade's ${money(nominal, c.currency)} would exceed your daily risk cap of ${money(plan.dailyRiskCap, c.currency)}.`
        : `Remaining daily risk ${money(remaining, c.currency)} is insufficient for this trade's ${money(nominal, c.currency)} risk (cap ${money(plan.dailyRiskCap, c.currency)}).`,
      { remaining: canonical(remaining), nominal: canonical(nominal), cap: canonical(plan.dailyRiskCap), used: canonical(riskUsed) });
  }
  if (plan.dailyLossCap === null) add("DAILY_LOSS_UNCONFIGURED", "WARN", MESSAGES.DAILY_LOSS_UNCONFIGURED);
  else if (usage.lossTotal.plus(usage.openExposure).plus(nominal).gt(plan.dailyLossCap)) {
    add("DAILY_LOSS_LIMIT", "BLOCK",
      `Today's realized losses ${money(usage.lossTotal, c.currency)} plus open risk ${money(usage.openExposure, c.currency)} plus this trade's ${money(nominal, c.currency)} would exceed your daily loss limit of ${money(plan.dailyLossCap, c.currency)}.`,
      { loss: canonical(usage.lossTotal), open: canonical(usage.openExposure), nominal: canonical(nominal), cap: canonical(plan.dailyLossCap) });
  }
  if (usage.riskUnknownTrades > 0) {
    add("UNPLANNED_RISK_UNKNOWN", "WARN", unplannedRiskSentence(usage.riskUnknownTrades), { n: usage.riskUnknownTrades });
  }
  add("COSTS_UNKNOWN", "WARN", MESSAGES.COSTS_UNKNOWN);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Report 1.2 (SQL private.risk_report_v12).
// ---------------------------------------------------------------------------------------------
interface Stages { parsed: boolean; stopKnown: boolean; geometryOk: boolean; sized: boolean; newsKnown: boolean; riskCap: boolean; lossCap: boolean }

/** Whether a rule without a finding was evaluated (and passed) or could not be evaluated. */
function ruleEvaluated(rule: RiskRule, s: Stages): boolean {
  switch (rule) {
    case "INVALID_INPUT": case "MAX_TRADES": case "DEAD_POOL": case "STALE_EQUITY": return true;
    case "INSTRUMENT_MISMATCH": case "CONTRACT_UNCONFIRMED": case "MISSING_STOP": return s.parsed;
    case "PRICE_GEOMETRY": return s.stopKnown;
    case "OFF_TICK": case "SIZING_INVARIANT": return s.geometryOk;
    case "NEWS_RESTRICTED": return s.sized && s.newsKnown;
    case "DAILY_RISK_LIMIT": return s.sized && s.riskCap;
    case "DAILY_LOSS_LIMIT": return s.sized && s.lossCap;
    default: return s.sized;
  }
}

function ruleResults(issues: readonly RiskIssueV12[], stages: Stages | null): RiskRuleResult[] {
  return RISK_RULES.map((rule): RiskRuleResult => {
    const finding = issues.find(issue => issue.code === rule);
    if (finding) return { rule, outcome: finding.severity, message: finding.message };
    if (stages === null || !ruleEvaluated(rule, stages)) return { rule, outcome: "NOT_EVALUATED", message: NOT_EVALUATED };
    return { rule, outcome: "PASS", message: rule === "STRATEGY_CONTRADICTION" ? NO_CONTRADICTION : CHECK_PASSED };
  });
}

function limitsOf(c: NormalizedContext): RiskReportV12["limits"] {
  const { plan } = c;
  return {
    maxRiskPercent: canonical(plan.maxRiskPercent),
    defaultRiskPercent: plan.defaultRiskPercent === null ? null : canonical(plan.defaultRiskPercent),
    minRR: canonical(plan.minRR), rrPolicy: plan.rrPolicy, newsPolicy: plan.newsPolicy, maxDailyTrades: plan.maxDailyTrades,
    dailyRiskCap: plan.dailyRiskCap === null ? null : canonical(plan.dailyRiskCap),
    dailyLossCap: plan.dailyLossCap === null ? null : canonical(plan.dailyLossCap),
    riskPlanVersion: plan.version,
  };
}

function instrumentOf(c: NormalizedContext): RiskReportV12["instrument"] {
  const { instrument } = c;
  return {
    symbol: instrument.symbol, currency: instrument.currency, tickSize: canonical(instrument.tickSize),
    pipSize: instrument.pipSize === null ? null : canonical(instrument.pipSize), tickValue: canonical(instrument.tickValue),
    quantityStep: canonical(instrument.quantityStep), minimumQuantity: canonical(instrument.minimumQuantity), quantityUnit: instrument.quantityUnit,
  };
}

function snapshotOf(c: NormalizedContext): RiskReportV12["snapshot"] {
  const u = c.usage;
  return {
    accountObservationId: c.observationId, observationDay: c.observationDay, equity: canonical(c.equity), currency: c.currency,
    instrumentVersionId: c.instrument.id,
    slotsUsed: u.plannedSlots + u.unplannedTrades, executedTrades: u.unplannedTrades, maximumDailyTrades: c.plan.maxDailyTrades,
    riskConsumed: canonical(u.plannedRisk.plus(u.unplannedRisk)), grossLoss: canonical(u.lossTotal),
    plannedSlots: u.plannedSlots, unplannedTrades: u.unplannedTrades, plannedRisk: canonical(u.plannedRisk), unplannedRisk: canonical(u.unplannedRisk),
    unplannedRiskUnknown: u.unplannedRiskUnknown, realizedLoss: canonical(u.realizedLoss), externalLoss: canonical(u.externalLoss),
    legacyReportedLoss: u.legacyReportedLoss === null ? null : canonical(u.legacyReportedLoss), openExposure: canonical(u.openExposure),
    openRiskUnknown: u.openRiskUnknown, riskUnknownTrades: u.riskUnknownTrades,
  };
}

/**
 * Report of a context the engine cannot read (TypeScript only; SQL reads typed columns): always
 * BLOCKED, nothing evaluated, values echoed as given (it is not a valid stored 1.2 report).
 */
function invalidContextReport(ctx: RiskContext, day: string, session: Session): RiskReportV12 {
  const issues: RiskIssueV12[] = [{ code: "INVALID_CONTEXT", severity: "BLOCK", message: INVALID_CONTEXT_MESSAGE, params: {} }];
  const part = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
  const given = (value: unknown): string => (typeof value === "string" ? value : "");
  const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const tally = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : 0);
  const plan = part(ctx.plan);
  const instrument = part(ctx.instrument);
  const usage = part(ctx.usage);
  return {
    engineVersion: ENGINE_VERSION, reportVersion: REPORT_VERSION, evaluatedAt: ctx.now, tradingDay: day, session,
    strategyVersionId: given(ctx.strategyVersionId).toLowerCase(), riskPlanVersionId: given(plan.id).toLowerCase(),
    decision: "BLOCKED", status: "TRADE_BLOCKED", issues, ruleResults: ruleResults(issues, null),
    requestedRiskPercent: null, targetDistance: null, sessionEligible: session !== "DEAD_POOL", calculations: null,
    limits: {
      maxRiskPercent: given(plan.maxRiskPercent), defaultRiskPercent: optional(plan.defaultRiskPercent), minRR: given(plan.minRR),
      rrPolicy: plan.rrPolicy === "WARN" ? "WARN" : "BLOCK", newsPolicy: plan.newsPolicy === "WARN" ? "WARN" : "BLOCK",
      maxDailyTrades: tally(plan.maxDailyTrades), dailyRiskCap: optional(plan.dailyRiskCap), dailyLossCap: optional(plan.dailyLossCap),
      riskPlanVersion: given(plan.version),
    },
    instrument: {
      symbol: given(instrument.symbol), currency: given(instrument.currency), tickSize: given(instrument.tickSize),
      pipSize: optional(instrument.pipSize), tickValue: given(instrument.tickValue), quantityStep: given(instrument.quantityStep),
      minimumQuantity: given(instrument.minimumQuantity), quantityUnit: given(instrument.quantityUnit),
    },
    snapshot: {
      accountObservationId: given(ctx.observationId).toLowerCase(), observationDay: given(ctx.observationDay), equity: given(ctx.equity),
      currency: given(ctx.currency), instrumentVersionId: given(instrument.id).toLowerCase(),
      slotsUsed: tally(usage.plannedSlots) + tally(usage.unplannedTrades), executedTrades: tally(usage.unplannedTrades),
      maximumDailyTrades: tally(plan.maxDailyTrades), riskConsumed: given(usage.plannedRisk), grossLoss: given(usage.lossTotal),
      plannedSlots: tally(usage.plannedSlots), unplannedTrades: tally(usage.unplannedTrades), plannedRisk: given(usage.plannedRisk),
      unplannedRisk: given(usage.unplannedRisk), unplannedRiskUnknown: tally(usage.unplannedRiskUnknown), realizedLoss: given(usage.realizedLoss),
      externalLoss: given(usage.externalLoss), legacyReportedLoss: optional(usage.legacyReportedLoss), openExposure: given(usage.openExposure),
      openRiskUnknown: tally(usage.openRiskUnknown), riskUnknownTrades: tally(usage.riskUnknownTrades),
    },
  };
}

/**
 * Evaluates a proposal (raw JSON, validated here exactly like SQL) against a server context and
 * returns report 1.2. Throws only when `ctx.now` is not an instant with an explicit zone. The usage
 * must be the usage of the strategy day of `ctx.now`, as the server computes it.
 */
export function evaluateRisk(raw: unknown, ctx: RiskContext): RiskReportV12 {
  const clock = strategyClock(ctx.now);
  const c = normalizeContext(ctx);
  if (c === null) return invalidContextReport(ctx, clock.day, clock.session);
  const core = evaluateCore(raw, c, clock.day, clock.session);
  const p = core.proposal;
  const parsed = p !== null;
  const stopKnown = p !== null && p.stop !== null;
  const stages: Stages = {
    parsed, stopKnown,
    geometryOk: stopKnown && !core.issues.some(issue => issue.code === "PRICE_GEOMETRY"),
    sized: core.calculations !== null,
    newsKnown: p !== null && p.news !== "UNKNOWN",
    riskCap: c.plan.dailyRiskCap !== null,
    lossCap: c.plan.dailyLossCap !== null,
  };
  const blocked = core.issues.some(issue => issue.severity === "BLOCK");
  return {
    engineVersion: ENGINE_VERSION, reportVersion: REPORT_VERSION, evaluatedAt: ctx.now, tradingDay: clock.day, session: clock.session,
    strategyVersionId: c.strategyVersionId, riskPlanVersionId: c.plan.id,
    decision: blocked ? "BLOCKED" : "APPROVED", status: blocked ? "TRADE_BLOCKED" : "RISK_APPROVED",
    issues: core.issues, ruleResults: ruleResults(core.issues, stages),
    requestedRiskPercent: p === null ? null : canonical(p.riskPercent),
    targetDistance: p === null || core.calculations === null ? null : canonical(p.target.minus(p.entry).abs()),
    sessionEligible: clock.session !== "DEAD_POOL",
    calculations: core.calculations,
    limits: limitsOf(c), instrument: instrumentOf(c), snapshot: snapshotOf(c),
  };
}
