import Decimal from "decimal.js";
import { stripZeros } from "@/domain/format";
import { sizeDeviationWarning } from "@/domain/plan-vs-reality";
import { compareInstants, type Instant, instantMicros, type TimeDisplay } from "@/domain/time-display";
import { instantOfWallClock } from "./time-input";

/**
 * Client checks of the trade page's forms (docs/V2_ARCHITECTURE.md §3.4–3.5, §5.1, §8.5): record entry, close trade,
 * live-first entry details and tags. They reject exactly what the §12.2 actions and the database would reject, with the
 * same field copy, so a refusal never needs a round trip; the server still validates everything (tick and step
 * alignment of unknown contracts, times against its own clock). Decimals stay strings and are compared with
 * Decimal.js only. Pure: safe on server and client.
 */

const D = Decimal.clone({ precision: 60 });

/** `private.decimal_input`: 1–12 integer digits, up to 8 decimals. */
const POSITIVE = /^\d{1,12}(\.\d{1,8})?$/;
/** Money: up to 2 decimals. */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const TAG = /^[a-z0-9][a-z0-9 _-]{0,31}$/;
export const MAX_TAGS = 12;

export const FORM_COPY = Object.freeze({
  entry: "Entry price must be a positive number with up to 8 decimals.",
  entryRequired: "Enter the entry price.",
  exit: "Exit price must be a positive number with up to 8 decimals.",
  exitRequired: "Enter the average exit price.",
  quantity: "Size must be a positive number with up to 8 decimals.",
  quantityRequired: "Enter the size.",
  stop: "Stop must be a positive number with up to 8 decimals.",
  fees: "Fees must be zero or a positive amount with up to 2 decimals.",
  riskAmount: "Risk must be a positive amount with up to 2 decimals.",
  netPnl: "Enter the net P&L as an amount with up to 2 decimals, without a sign: Profit or Loss sets it.",
  netPnlRequired: "Enter the net P&L amount: it can't be calculated from the recorded entry details.",
  netPnlZero: "Enter an amount above zero, or choose Breakeven.",
  pnlKind: "Choose Profit, Loss or Breakeven.",
  time: "Enter the date and time.",
  oversize: "Confirm the size deviation to record this entry.",
  nothing: "Add at least one missing entry detail.",
  tag: "Tags use 1 to 32 characters: a–z, 0–9, space, _ or -.",
  tagLimit: `Use at most ${MAX_TAGS} tags.`,
});

export function isPositiveDecimal(value: string): boolean {
  return POSITIVE.test(value) && new D(value).gt(0);
}

export function isMoney(value: string): boolean {
  return MONEY.test(value);
}

export function isPositiveMoney(value: string): boolean {
  return MONEY.test(value) && new D(value).gt(0);
}


/** True when `value` is a whole number of `increment`s, or when the increment is unknown (the server decides). */
export function isAligned(value: string, increment: string | null | undefined): boolean {
  if (!increment || !/^\d+(\.\d+)?$/.test(increment) || new D(increment).lte(0) || !POSITIVE.test(value)) return true;
  return new D(value).mod(increment).isZero();
}

export function tickCopy(tickSize: string): string {
  return `Prices must be a multiple of the ${stripZeros(tickSize)} tick size.`;
}

export function stepCopy(step: string): string {
  return `Size must be a multiple of the ${stripZeros(step)} size step.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Times: "Now" is resolved by the server; "Earlier" is a wall-clock time in the person's display.
// ---------------------------------------------------------------------------------------------------------------------

export type TimeChoice = { mode: "now" } | { mode: "earlier"; wall: string };

export interface TimeBound {
  instant: Instant;
  /** Error when the time falls on the wrong side of the bound. */
  message: string;
}

const MINUTE_MICROS = 60_000_000n;

function instantText(instant: Instant): string {
  return typeof instant === "string" ? instant : instant.toISOString();
}

/**
 * The value an action receives: "now", or an ISO 8601 instant of the wall-clock time; a field error otherwise.
 * `notBefore`/`notAfter` repeat the database's own time rules with dates in words.
 *
 * Times are typed to the minute while the bounds keep their seconds: an entry typed in the same minute as the lock
 * (09:15 for a plan locked at 09:15:27) names a moment after the lock, so it is sent as the bound itself, the earliest
 * instant of that minute the rule allows, instead of being refused.
 */
export function resolveTime(choice: TimeChoice, display: TimeDisplay, bounds: { notBefore?: TimeBound; notAfter?: TimeBound } = {}): { ok: true; value: string } | { ok: false; error: string } {
  if (choice.mode === "now") return { ok: true, value: "now" };
  const instant = instantOfWallClock(choice.wall, display);
  if (instant === null) return { ok: false, error: FORM_COPY.time };
  let value = instant;
  if (bounds.notBefore && compareInstants(instant, bounds.notBefore.instant) < 0) {
    const sameMinute = instantMicros(instant) + MINUTE_MICROS > instantMicros(bounds.notBefore.instant);
    if (!sameMinute) return { ok: false, error: bounds.notBefore.message };
    value = instantText(bounds.notBefore.instant);
  }
  if (bounds.notAfter && compareInstants(value, bounds.notAfter.instant) > 0) return { ok: false, error: bounds.notAfter.message };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------------
// Record entry (planned trades, §8.5).
// ---------------------------------------------------------------------------------------------------------------------

export interface EntryContract {
  tickSize: string | null;
  quantityStep: string | null;
}

export interface EntryDraft {
  entry: string;
  quantity: string;
  time: TimeChoice;
  confirmOversize: boolean;
}

export type EntryFormField = "entry" | "quantity" | "enteredAt" | "confirmOversize";

/** The §8.5 confirmation copy when the size exceeds the plan; null when it doesn't (or the size isn't valid yet). */
export function oversizeWarning(quantity: string, plannedQuantity: string | null, quantityStep: string | null): string | null {
  const value = quantity.trim();
  if (!plannedQuantity || !isPositiveDecimal(value)) return null;
  return sizeDeviationWarning(value, plannedQuantity, quantityStep);
}

export function validateEntry(
  draft: EntryDraft, context: EntryContract & { plannedQuantity: string | null; display: TimeDisplay; lockedAt: TimeBound | null },
): { ok: true; fields: Record<string, string> } | { ok: false; fieldErrors: Partial<Record<EntryFormField, string>> } {
  const errors: Partial<Record<EntryFormField, string>> = {};
  const entry = draft.entry.trim();
  const quantity = draft.quantity.trim();
  if (!entry) errors.entry = FORM_COPY.entryRequired;
  else if (!isPositiveDecimal(entry)) errors.entry = FORM_COPY.entry;
  else if (!isAligned(entry, context.tickSize)) errors.entry = tickCopy(context.tickSize ?? "");
  if (!quantity) errors.quantity = FORM_COPY.quantityRequired;
  else if (!isPositiveDecimal(quantity)) errors.quantity = FORM_COPY.quantity;
  else if (!isAligned(quantity, context.quantityStep)) errors.quantity = stepCopy(context.quantityStep ?? "");
  const time = resolveTime(draft.time, context.display, context.lockedAt ? { notBefore: context.lockedAt } : {});
  if (!time.ok) errors.enteredAt = time.error;
  const warning = errors.quantity ? null : oversizeWarning(quantity, context.plannedQuantity, context.quantityStep);
  if (warning && !draft.confirmOversize) errors.confirmOversize = FORM_COPY.oversize;
  if (Object.keys(errors).length || !time.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, fields: { entry, quantity, enteredAt: time.value, ...(warning ? { confirmOversize: "on" } : {}) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Close trade: planned (FULL_CLOSE_V1) or live-first (UNPLANNED_CLOSE_V1, §3.5).
// ---------------------------------------------------------------------------------------------------------------------

/** Sign of a reported net P&L: chosen explicitly, so a loss is never recorded as a profit by default. */
export type PnlKind = "profit" | "loss" | "breakeven";

export interface CloseDraft {
  exit: string;
  /** Reported net P&L amount without its sign (the sign is `pnlKind`). */
  netPnl: string;
  pnlKind: PnlKind | null;
  fees: string;
  time: TimeChoice;
}

export type CloseField = "exit" | "netPnl" | "pnlKind" | "fees" | "exitedAt";

/** The signed net P&L of a reported close (`-295.5`), from its kind and amount. */
export function signedPnl(kind: PnlKind, amount: string): string {
  if (kind === "breakeven") return "0";
  return kind === "loss" ? `-${amount}` : amount;
}

export function validateClose(
  draft: CloseDraft, context: { mode: "planned" | "calculated" | "reported"; tickSize: string | null; display: TimeDisplay; enteredAt: TimeBound | null },
): { ok: true; fields: Record<string, string> } | { ok: false; fieldErrors: Partial<Record<CloseField, string>> } {
  const errors: Partial<Record<CloseField, string>> = {};
  const exit = draft.exit.trim();
  const netPnl = draft.netPnl.trim();
  const fees = draft.fees.trim();
  const exitRequired = context.mode !== "reported";
  if (!exit) {
    if (exitRequired) errors.exit = FORM_COPY.exitRequired;
  } else if (!isPositiveDecimal(exit)) errors.exit = FORM_COPY.exit;
  else if (!isAligned(exit, context.tickSize)) errors.exit = tickCopy(context.tickSize ?? "");
  if (context.mode === "reported") {
    if (draft.pnlKind === null) errors.pnlKind = FORM_COPY.pnlKind;
    else if (draft.pnlKind !== "breakeven") {
      if (!netPnl) errors.netPnl = FORM_COPY.netPnlRequired;
      else if (!isPositiveMoney(netPnl)) errors.netPnl = MONEY.test(netPnl) ? FORM_COPY.netPnlZero : FORM_COPY.netPnl;
    }
  }
  if (fees && !isMoney(fees)) errors.fees = FORM_COPY.fees;
  const time = resolveTime(draft.time, context.display, context.enteredAt ? { notBefore: context.enteredAt } : {});
  if (!time.ok) errors.exitedAt = time.error;
  if (Object.keys(errors).length || !time.ok) return { ok: false, fieldErrors: errors };
  const fields: Record<string, string> = { exitedAt: time.value };
  if (context.mode === "planned") {
    fields.exit = exit;
    fields.fees = fees || "0";
  } else {
    if (exit) fields.exitPrice = exit;
    if (fees) fields.fees = fees;
    if (context.mode === "reported" && draft.pnlKind) fields.netPnl = signedPnl(draft.pnlKind, netPnl);
  }
  return { ok: true, fields };
}

/** Field names of the close actions and of the client checks → the form's fields. */
export function closeFieldOf(field: string): CloseField | null {
  if (field === "exit" || field === "exitPrice") return "exit";
  if (field === "netPnl" || field === "pnlKind" || field === "fees" || field === "exitedAt") return field;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Live-first entry details (complete_live_entry: each missing detail once).
// ---------------------------------------------------------------------------------------------------------------------

export type DetailField = "instrumentId" | "entryModel" | "entryPrice" | "enteredAt" | "quantity" | "initialStop" | "riskAmount";
export type DetailsDraft = Record<DetailField, string>;

export const EMPTY_DETAILS: DetailsDraft = Object.freeze({ instrumentId: "", entryModel: "", entryPrice: "", enteredAt: "", quantity: "", initialStop: "", riskAmount: "" });

export function validateEntryDetails(
  draft: DetailsDraft,
  context: { fields: readonly DetailField[]; tickSize: string | null; quantityStep: string | null; display: TimeDisplay; recordedAt: TimeBound | null },
): { ok: true; fields: Record<string, string> } | { ok: false; fieldErrors: Partial<Record<DetailField, string>>; message?: string } {
  const errors: Partial<Record<DetailField, string>> = {};
  const fields: Record<string, string> = {};
  const offered = new Set(context.fields);
  const text = (field: DetailField) => (offered.has(field) ? draft[field].trim() : "");
  const price = (field: "entryPrice" | "initialStop", copy: string) => {
    const value = text(field);
    if (!value) return;
    if (!isPositiveDecimal(value)) errors[field] = copy;
    else if (!isAligned(value, context.tickSize)) errors[field] = tickCopy(context.tickSize ?? "");
    else fields[field] = value;
  };
  const instrumentId = text("instrumentId");
  if (instrumentId) fields.instrumentId = instrumentId;
  const model = text("entryModel");
  if (model) fields.entryModel = model;
  price("entryPrice", FORM_COPY.entry);
  price("initialStop", FORM_COPY.stop);
  const quantity = text("quantity");
  if (quantity) {
    if (!isPositiveDecimal(quantity)) errors.quantity = FORM_COPY.quantity;
    else if (!isAligned(quantity, context.quantityStep)) errors.quantity = stepCopy(context.quantityStep ?? "");
    else fields.quantity = quantity;
  }
  const risk = text("riskAmount");
  if (risk) {
    if (!isPositiveMoney(risk)) errors.riskAmount = FORM_COPY.riskAmount;
    else fields.riskAmount = risk;
  }
  const wall = text("enteredAt");
  if (wall) {
    const time = resolveTime({ mode: "earlier", wall }, context.display, context.recordedAt ? { notAfter: context.recordedAt } : {});
    if (time.ok) fields.enteredAt = time.value;
    else errors.enteredAt = time.error;
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  if (!Object.keys(fields).length) return { ok: false, fieldErrors: {}, message: FORM_COPY.nothing };
  return { ok: true, fields };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tags (§3.8): ≤ 12 unique tags, each ^[a-z0-9][a-z0-9 _-]{0,31}$ after normalising.
// ---------------------------------------------------------------------------------------------------------------------

/** Canonical tag text: trimmed, lowercase, single spaces (same as the server). */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Adds the tags typed in `input` (comma-separated); returns the new list or the reason nothing was added. */
export function addTags(current: readonly string[], input: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  const incoming = input.split(",").map(normalizeTag).filter(Boolean);
  if (!incoming.length) return { ok: true, tags: [...current] };
  if (incoming.some(tag => !TAG.test(tag))) return { ok: false, error: FORM_COPY.tag };
  const next = [...new Set([...current, ...incoming])];
  if (next.length > MAX_TAGS) return { ok: false, error: FORM_COPY.tagLimit };
  return { ok: true, tags: next };
}

export interface TagValues {
  grade: string | null;
  liquidity: string | null;
  mss: string | null;
  tags: readonly string[];
}

/** True when two tag sets say the same thing (tag order does not matter). */
export function sameTags(a: TagValues, b: TagValues): boolean {
  const left = [...a.tags].sort();
  const right = [...b.tags].sort();
  return a.grade === b.grade && a.liquidity === b.liquidity && a.mss === b.mss && left.length === right.length && left.every((tag, index) => tag === right[index]);
}
