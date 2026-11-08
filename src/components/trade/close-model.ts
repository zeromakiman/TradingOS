import Decimal from "decimal.js";
import { type ClosePosition, type ClosePreview, calculatedClose, reportedClose } from "@/domain/close-preview";
import { formatMoney, formatMoneyUp, formatPrice, formatQuantity, formatR, formatSignedMoney, scaleOf, stripZeros } from "@/domain/format";
import {
  type AverageExit, type AverageReason, type CloseLegs, closeLegs, livePartialCloses, type PartialCloseRecord, type PartialLeg, type SplitClose,
} from "@/domain/partial-closes";
import { sizeComparison } from "@/domain/plan-vs-reality";
import { formatDateTime, type TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { OUTCOME_LABELS, unitWord } from "./copy";
import { type CloseDraft, type CloseField, type EntryDraft, type EntryFormField, validateClose, validateEntry } from "./form-model";
import { zoneTag } from "./time-input";

/**
 * Close trade and Record entry before they are recorded (docs/V2_ARCHITECTURE.md §3.4–3.6, §8.5; spec §57, §60.17).
 * Both records are immutable, so neither is sent from a key press or a click alone: the form first shows what will be
 * recorded, with the result of a close (net P&L, realized R and the outcome, worked out exactly as the database will),
 * and records only when the trader confirms. The close form also reads the partial closes the journal recorded while
 * the trade was live: when each has a price and an amount, the trader enters the exit of the rest and the one average
 * exit the close records is worked out here. Pure: safe on server and client (only types come from server modules).
 */

const D = Decimal.clone({ precision: 60 });

export type CloseFormMode = "planned" | "calculated" | "reported";

/** What the close form knows about the position beyond its fields (`closeFormContext`). */
export interface CloseFormContext {
  /** Entry facts the P&L is calculated from (planned trades, and live-first trades with every fact); null otherwise. */
  position: ClosePosition | null;
  /** The R denominator: the locked risk (planned) or the risk recorded after entry (live-first); null when none. */
  riskBasis: string | null;
  planned: boolean;
  quantityStep: string | null;
  /** Unit word of the contract's size (`lots`). */
  unit: string;
  /** What the journal's partial closes let the form work out (NONE when the trader reports the P&L). */
  legs: CloseLegs;
}

/**
 * The close form's context for a live trade: the Result section passes `context={closeFormContext(detail)}` to
 * `CloseTradeForm`. It is small and plain (the form is a client component), never the whole trade detail.
 */
export function closeFormContext(detail: TradeDetail): CloseFormContext {
  const ledger = detail.technical.ledger;
  const instrument = detail.instrument;
  const position: ClosePosition | null =
    instrument && ledger.direction && ledger.entry_price && ledger.quantity
      ? { direction: ledger.direction, entryPrice: ledger.entry_price, quantity: ledger.quantity, tickSize: instrument.tickSize, tickValue: instrument.tickValue }
      : null;
  // Partial closes only change the exit price; a reported close takes the net P&L from the platform instead.
  const legs = position ? closeLegs(livePartialCloses(detail.timeline), { quantity: ledger.quantity }, !detail.timelineTruncated) : ({ kind: "NONE" } as const);
  return {
    position, riskBasis: ledger.initial_risk, planned: detail.origin === "PLANNED", quantityStep: instrument?.quantityStep ?? null,
    unit: unitWord(instrument?.quantityUnit), legs,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------------------------------------------------

export const CLOSE_COPY = Object.freeze({
  /** Under the form when the confirmation shows the result first (`closeResultShown`). */
  recordedOnce: "Recorded once, after you check the result: the close can't be changed later.",
  /** Under the form when the result can't be worked out before the close: nothing claims a result is shown. */
  recordedOnceWithoutResult: "Recorded once, after you confirm it: the close can't be changed later.",
  dialogTitle: "Close this trade?",
  dialogDescription: "Check the result before it is recorded. The close can't be changed later.",
  dialogDescriptionWithoutResult: "Check the exit before it is recorded. The close can't be changed later.",
  confirm: "Close trade",
  pending: "Closing…",
  keepEditing: "Keep editing",
  recordedSection: "Recorded",
  resultSection: "Result",
  calculatedOnConfirm: "Calculated when you confirm",
  now: "Now",
  nowHint: "The server's time when you confirm.",
  noFees: "None",
  feesIncluded: "For your records: the net P&L already includes them.",
  noExit: "Not recorded",
  noR: "Not available",
  noRHint: "No risk is recorded for this trade.",
  reported: "Reported by you.",
  partialsTitle: "Partial closes in your journal",
  averagePending: "Enter the exit of the rest: the average exit of the whole position is worked out here.",
  useAverage: "Enter the average exit price yourself",
  useJournal: "Work it out from the journal",
  averageHint: "One price for the whole position, across all partial closes.",
});

/** Why the trader enters the average exit although the journal has partial closes. */
export const AVERAGE_REASON_COPY: Readonly<Record<AverageReason, string>> = Object.freeze({
  NO_PRICE: "A partial close has no price, so the average exit can't be worked out for you.",
  NO_AMOUNT: "A partial close has no size or percent, so the average exit can't be worked out for you.",
  LATER_PERCENT: "A percent recorded after an earlier partial close may be of the original or of the remaining size, so the average exit can't be worked out for you.",
  NO_SIZE: "The position's size isn't recorded, so the average exit can't be worked out for you.",
  WHOLE_POSITION: "These partial closes add up to the whole position: their average exit is filled in. Check it before you close.",
  BEYOND_POSITION: "These partial closes add up to more than the position, so the average exit can't be worked out for you.",
  UNREAD: "Not every journal entry could be read, so the average exit can't be worked out for you.",
});

export const ENTRY_COPY = Object.freeze({
  dialogTitle: "Record this entry?",
  dialogDescription: "Check the fill before it is recorded. It can't be changed later.",
  section: "Fill",
  confirm: "Record entry",
  pending: "Recording…",
  keepEditing: "Keep editing",
  atPlan: "At the planned entry",
  asPlanned: "As planned",
});

function sizeText(quantity: string, step: string | null, unit: string): string {
  return `${formatQuantity(quantity, step)}${unit ? ` ${unit}` : ""}`;
}

/** A size the journal implies (a percent of the position): exact when it is on the size step, else `≈` the nearest step. */
function impliedSize(quantity: string, step: string | null, unit: string): string {
  const value = new D(quantity);
  if (step === null || !/^\d+(\.\d+)?$/.test(step) || new D(step).lte(0) || value.mod(step).isZero()) return sizeText(quantity, step, unit);
  return `≈ ${sizeText(value.toNearest(step, Decimal.ROUND_HALF_UP).toFixed(), step, unit)}`;
}

/** `30% (≈ 1.57 lots) at 1.33291`, `1.50 lots at 1.33250`. */
export function legLabel(leg: PartialLeg, context: Pick<CloseFormContext, "quantityStep" | "unit">, tickSize: string | null): string {
  const amount = leg.percent !== null ? `${stripZeros(leg.percent)}% (${impliedSize(leg.quantity, context.quantityStep, context.unit)})` : sizeText(leg.quantity, context.quantityStep, context.unit);
  return `${amount} at ${formatPrice(leg.price, tickSize)}`;
}

/** A partial close as the journal recorded it, naming what is missing: `30% at 1.33291`, `1.00 lots · no price`. */
export function recordLabel(record: PartialCloseRecord, context: Pick<CloseFormContext, "quantityStep" | "unit">, tickSize: string | null): string {
  const amount = record.percent !== null ? `${stripZeros(record.percent)}%` : record.quantity !== null ? sizeText(record.quantity, context.quantityStep, context.unit) : null;
  const price = record.price !== null ? formatPrice(record.price, tickSize) : null;
  if (amount && price) return `${amount} at ${price}`;
  if (amount) return `${amount} · no price`;
  return price ? `At ${price} · no size or percent` : "No price, size or percent";
}

/** What is still open: `70% (≈ 3.66 lots)`, `3.73 lots`. */
export function remainingLabel(split: SplitClose, context: Pick<CloseFormContext, "quantityStep" | "unit">): string {
  const size = impliedSize(split.remaining, context.quantityStep, context.unit);
  return split.remainingPercent !== null ? `${stripZeros(split.remainingPercent)}% (${size})` : size;
}

/** Label of the price the trader enters when the journal's partial closes are known. */
export function restPriceLabel(split: SplitClose, context: Pick<CloseFormContext, "quantityStep" | "unit">): string {
  return `Exit price of the remaining ${remainingLabel(split, context)}`;
}

/** An exact value with at most `decimals` decimals, or `≈` it rounded there. */
function shortExact(value: string, decimals: number): string {
  const number = new D(value);
  return number.decimalPlaces() <= decimals ? number.toFixed() : `≈ ${number.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed()}`;
}

/**
 * The arithmetic of the average exit, in the amounts the journal recorded: `30% × 1.33291 + 70% × 1.33300 = 1.332973`
 * for a percent, `(1.50 × 1.33291 + 3.73 × 1.33300) ÷ 5.23 = 1.332959…` for sizes; then the price on the tick when
 * rounding changed it.
 */
export function averageFormula(split: SplitClose, restPrice: string, average: AverageExit, tickSize: string | null): string {
  const price = (value: string) => formatPrice(value, tickSize);
  const decimals = Math.max(tickSize ? scaleOf(tickSize) : 5, 2) + 2;
  const exact = shortExact(average.exact, decimals);
  const equals = exact.startsWith("≈") ? exact : `= ${exact}`;
  const terms =
    split.remainingPercent !== null
      ? `${stripZeros(split.legs[0].percent as string)}% × ${price(split.legs[0].price)} + ${stripZeros(split.remainingPercent)}% × ${price(restPrice)} ${equals}`
      : `(${[...split.legs.map(leg => `${stripZeros(leg.quantity)} × ${price(leg.price)}`), `${stripZeros(split.remaining)} × ${price(restPrice)}`].join(" + ")}) ÷ ${stripZeros(split.position)} ${equals}`;
  const rounded = !new D(average.exact).eq(average.price);
  return rounded && tickSize ? `${terms}, rounded to the ${stripZeros(tickSize)} tick.` : `${terms}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirmation summaries.
// ---------------------------------------------------------------------------------------------------------------------

export interface ReviewFact {
  label: string;
  value: string;
  hint?: string;
  tone?: "positive" | "negative" | "muted";
}

/** "Now" (the server's time when the trader confirms) or the reported instant in the person's display. */
function timeFact(label: string, value: string, display: TimeDisplay): ReviewFact {
  if (value === "now") return { label, value: CLOSE_COPY.now, hint: CLOSE_COPY.nowHint };
  return { label, value: `${formatDateTime(value, display)} ${zoneTag(display, value)}` };
}

function isPositive(value: string | undefined): value is string {
  return value !== undefined && /^\d+(\.\d+)?$/.test(value) && new D(value).gt(0);
}

export interface CloseReview {
  /** Exit price, exit time and fees, as they will be recorded. */
  recorded: ReviewFact[];
  /** Outcome, net P&L and realized R. */
  result: ReviewFact[];
  /** The result was worked out here (the net P&L at least); false when only the database can compute it. */
  previewed: boolean;
}

export interface CloseReviewInput {
  mode: CloseFormMode;
  /** The validated fields the close action receives (`validateClose`). */
  fields: Readonly<Record<string, string>>;
  /** The arithmetic of an average worked out from the journal's partial closes. */
  averageFormula?: string | null;
  context?: CloseFormContext | null;
  /** What realized R will be based on, in words (the form's line), for an R that can't be worked out here. */
  basis?: string | null;
  currency: string;
  tickSize: string | null;
  display: TimeDisplay;
}

const LATER: ReviewFact["tone"] = "muted";

/**
 * Whether the close confirmation can show the result before it is recorded: a reported close always shows the trader's
 * net P&L; a calculated one needs the position's facts (`closeFormContext`). Without them the form and its confirmation
 * never say the result is checked first.
 */
export function closeResultShown(mode: CloseFormMode, context: CloseFormContext | null | undefined): boolean {
  return mode === "reported" || Boolean(context?.position);
}

/** An R only the database can compute: said so, with its basis in words when the form knows it. */
function laterR(basis: string | null | undefined): ReviewFact {
  return { label: "Realized R", value: CLOSE_COPY.calculatedOnConfirm, tone: LATER, ...(basis ? { hint: basis } : {}) };
}

function resultFacts(preview: ClosePreview | null, input: CloseReviewInput): ReviewFact[] {
  const { context, currency } = input;
  if (!preview) return [{ label: "Net P&L", value: CLOSE_COPY.calculatedOnConfirm, tone: LATER }, laterR(input.basis)];
  const tone = preview.outcome === "WIN" ? "positive" : preview.outcome === "LOSS" ? "negative" : undefined;
  const fees = input.fields.fees;
  const pnlHint = preview.grossPnl === null ? CLOSE_COPY.reported : isPositive(fees) ? `Gross ${formatSignedMoney(preview.grossPnl, currency)} − fees ${formatMoney(fees, currency)}.` : undefined;
  const basis = context?.riskBasis ?? null;
  let r: ReviewFact;
  if (preview.realizedR !== null && basis !== null) {
    r = { label: "Realized R", value: formatR(preview.realizedR), tone, hint: `Net P&L ÷ ${formatMoneyUp(basis, currency)}, ${context?.planned ? "the locked risk" : "the risk recorded after entry"}.` };
  } else if (!context) {
    // Without the trade's facts the R basis is unknown here; the database still computes it.
    r = laterR(input.basis);
  } else {
    r = { label: "Realized R", value: CLOSE_COPY.noR, hint: CLOSE_COPY.noRHint, tone: LATER };
  }
  return [
    { label: "Outcome", value: OUTCOME_LABELS[preview.outcome], tone },
    { label: "Net P&L", value: formatSignedMoney(preview.netPnl, currency), tone, ...(pnlHint ? { hint: pnlHint } : {}) },
    r,
  ];
}

/** What the close confirmation shows: what is recorded, and the result the database will compute from it. */
export function closeReview(input: CloseReviewInput): CloseReview {
  const { mode, fields, context, currency, tickSize, display } = input;
  const exit = mode === "planned" ? fields.exit : fields.exitPrice;
  const recorded: ReviewFact[] = [
    exit
      ? { label: "Exit price", value: formatPrice(exit, tickSize), ...(input.averageFormula ? { hint: `Average of every partial close and the rest: ${input.averageFormula}` } : {}) }
      : { label: "Exit price", value: CLOSE_COPY.noExit, tone: "muted" },
    timeFact("Exit time", fields.exitedAt ?? "now", display),
    isPositive(fields.fees)
      ? { label: "Fees", value: formatMoney(fields.fees, currency), ...(mode === "reported" ? { hint: CLOSE_COPY.feesIncluded } : {}) }
      : { label: "Fees", value: CLOSE_COPY.noFees },
  ];
  let preview: ClosePreview | null = null;
  if (mode === "reported") preview = fields.netPnl !== undefined ? reportedClose(fields.netPnl, context?.riskBasis ?? null) : null;
  else if (context?.position && exit) preview = calculatedClose(context.position, exit, fields.fees ?? "0", context.riskBasis);
  return { recorded, result: resultFacts(preview, input), previewed: preview !== null };
}

export interface EntryReviewInput {
  /** The validated fields the record-entry action receives (`validateEntry`). */
  fields: Readonly<Record<string, string>>;
  /** The plan's entry (any exact text) and exact size. */
  planned: { entry: string | null; quantity: string | null };
  contract: { tickSize: string | null; quantityStep: string | null; unit: string };
  display: TimeDisplay;
}

export interface EntryReview {
  facts: ReviewFact[];
  /**
   * Something the trader typed differs from the prefilled plan (price or size) or from Now (an earlier time): such an
   * entry is confirmed before it is recorded. An entry at the plan's values, now, is recorded at once.
   */
  confirm: boolean;
}

/** `12 ticks above the plan's 1.10000`, or the price difference when the tick is unknown. */
function entryDifference(entry: string, planned: string, tickSize: string | null): string {
  const difference = new D(entry).minus(planned);
  const side = difference.gt(0) ? "above" : "below";
  const ticks = tickSize && /^\d+(\.\d+)?$/.test(tickSize) && new D(tickSize).gt(0) ? difference.abs().div(tickSize) : null;
  const amount = ticks?.isInteger() ? `${ticks.toFixed()} ${ticks.eq(1) ? "tick" : "ticks"}` : difference.abs().toFixed();
  return `${amount} ${side} the plan's ${formatPrice(planned, tickSize)}`;
}

/** What the record-entry confirmation shows, and whether the entry needs it. */
export function entryReview(input: EntryReviewInput): EntryReview {
  const { fields, planned, contract, display } = input;
  const { tickSize, quantityStep, unit } = contract;
  const entry = fields.entry;
  const quantity = fields.quantity;
  const entryDiffers = planned.entry !== null && !new D(entry).eq(planned.entry);
  const sizeDiffers = planned.quantity !== null && !new D(quantity).eq(planned.quantity);
  const size = planned.quantity !== null && sizeDiffers ? sizeComparison(planned.quantity, quantity, quantityStep) : null;
  const facts: ReviewFact[] = [
    {
      label: "Entry price", value: formatPrice(entry, tickSize),
      ...(planned.entry !== null ? { hint: entryDiffers ? entryDifference(entry, planned.entry, tickSize) : ENTRY_COPY.atPlan } : {}),
    },
    {
      label: "Size", value: sizeText(quantity, quantityStep, unit),
      ...(planned.quantity !== null
        ? { hint: size ? `${size.ratio}× the plan's ${sizeText(planned.quantity, quantityStep, unit)}${size.oversized ? ". Recorded as a size deviation." : ""}` : ENTRY_COPY.asPlanned }
        : {}),
    },
    timeFact("Entry time", fields.enteredAt ?? "now", display),
  ];
  return { facts, confirm: entryDiffers || sizeDiffers || (fields.enteredAt ?? "now") !== "now" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Submitting the forms.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What submitting the close form does (the button, Enter or Ctrl/⌘+Enter): show the fields' errors, or open the
 * confirmation with what will be recorded. There is no third outcome: the close is sent only from the confirmation.
 */
export type CloseSubmission =
  | { kind: "invalid"; fieldErrors: Partial<Record<CloseField, string>> }
  | { kind: "confirm"; fields: Record<string, string>; review: CloseReview };

export interface CloseSubmissionInput {
  mode: CloseFormMode;
  tickSize: string | null;
  currency: string;
  display: TimeDisplay;
  /** The exit can't be earlier than the entry: its instant and its time in words. */
  entered: { at: string; label: string } | null;
  /** The journal's partial closes, when the form asks for the exit of the rest. */
  split: SplitClose | null;
  context?: CloseFormContext | null;
  /** What realized R will be based on, in words (the form's line). */
  basis?: string | null;
}

export function closeSubmission(draft: CloseDraft, input: CloseSubmissionInput): CloseSubmission {
  const { mode, tickSize, currency, display, entered, split, context, basis } = input;
  const checked = validateClose(draft, {
    mode, tickSize, display, split,
    enteredAt: entered ? { instant: entered.at, message: `The exit time must be after the entry (${entered.label}).` } : null,
  });
  if (!checked.ok) return { kind: "invalid", fieldErrors: checked.fieldErrors };
  const formula = split && checked.average ? averageFormula(split, (draft.rest ?? "").trim(), checked.average, tickSize) : null;
  return {
    kind: "confirm", fields: checked.fields,
    review: closeReview({ mode, fields: checked.fields, averageFormula: formula, context, basis, currency, tickSize, display }),
  };
}

/**
 * What submitting the record-entry form does: show the fields' errors, record an entry at the plan's price and size
 * now at once (`send`), or confirm anything the trader typed first (`confirm`).
 */
export type EntrySubmission =
  | { kind: "invalid"; fieldErrors: Partial<Record<EntryFormField, string>> }
  | { kind: "send"; fields: Record<string, string> }
  | { kind: "confirm"; fields: Record<string, string>; facts: ReviewFact[] };

export interface EntrySubmissionInput {
  /** The plan's entry (formatted or exact) and exact size. */
  planned: { entry: string | null; quantity: string | null };
  contract: { tickSize: string | null; quantityStep: string | null; unit: string };
  display: TimeDisplay;
  /** The entry can't be earlier than the lock: its instant and its time in words. */
  locked: { at: string; label: string } | null;
}

export function entrySubmission(draft: EntryDraft, input: EntrySubmissionInput): EntrySubmission {
  const { planned, contract, display, locked } = input;
  const checked = validateEntry(draft, {
    tickSize: contract.tickSize, quantityStep: contract.quantityStep, plannedQuantity: planned.quantity, display,
    lockedAt: locked ? { instant: locked.at, message: `The entry time must be after the plan was locked (${locked.label}).` } : null,
  });
  if (!checked.ok) return { kind: "invalid", fieldErrors: checked.fieldErrors };
  const review = entryReview({ fields: checked.fields, planned, contract, display });
  return review.confirm ? { kind: "confirm", fields: checked.fields, facts: review.facts } : { kind: "send", fields: checked.fields };
}
