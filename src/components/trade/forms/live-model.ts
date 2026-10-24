import Decimal from "decimal.js";
import { formatMoneyExact, stripZeros } from "@/domain/format";
import type { Instrument } from "@/domain/risk";
import { strategyClock } from "@/domain/session";
import { compareInstants, isInstant } from "@/domain/time-display";
import { LIVE_FIELD_COPY } from "./copy";
import { isPositiveDecimal } from "./plan-model";
import type { Direction, FormAccount, LiveModel } from "./types";

/**
 * Pure model of Record Live Trade (docs/V2_ARCHITECTURE.md §3.5, §8.2, §14.3): the minimal live-first form, its checks
 * (the same rules record_live_trade enforces: a known instrument aligns prices to its tick and the size to its step and
 * minimum; the stop sits on the losing side of the entry) and the action fields. Entry time is "now" (resolved by the
 * server), a strategy-time (UTC−5) wall time the trader typed, or unknown (§5.3: nothing is sent, and the trade page's
 * "Add entry details" records it later); the browser clock never supplies a time.
 */

const D = Decimal.clone({ precision: 60 });
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** Instrument select value of "Other symbol". */
export const OTHER_SYMBOL = "other";

/** When the position was entered: at save time, at a time the trader types, or not known yet (no time is recorded). */
export type EntryTiming = "now" | "earlier" | "unknown";
export const ENTRY_TIMINGS: readonly EntryTiming[] = Object.freeze(["now", "earlier", "unknown"]);

export interface LiveDraft {
  accountId: string;
  /** An instrument id of the account, `OTHER_SYMBOL`, or empty. */
  instrumentId: string;
  symbol: string;
  direction: Direction | "";
  entryPrice: string;
  /** "Already open — add price later": the entry price is completed on the trade page. */
  priceLater: boolean;
  timing: EntryTiming;
  /** `YYYY-MM-DDTHH:mm` in strategy time (UTC−5), when `timing` is `earlier`. */
  enteredAt: string;
  quantity: string;
  initialStop: string;
  riskAmount: string;
  entryModel: LiveModel | "";
}

export type LiveField = "accountId" | "instrumentId" | "symbol" | "direction" | "entryPrice" | "enteredAt" | "quantity" | "initialStop" | "riskAmount" | "entryModel";
export type LiveFieldErrors = Partial<Record<LiveField, string>>;
export const LIVE_FIELD_ORDER: readonly LiveField[] = Object.freeze([
  "accountId", "instrumentId", "symbol", "direction", "entryPrice", "enteredAt", "quantity", "initialStop", "riskAmount", "entryModel",
]);

export function newLiveDraft(account: FormAccount | null): LiveDraft {
  return {
    accountId: account?.id ?? "",
    instrumentId: account ? (account.instruments.length === 1 ? account.instruments[0].id : account.instruments.length === 0 ? OTHER_SYMBOL : "") : "",
    symbol: "",
    direction: "",
    entryPrice: "",
    priceLater: false,
    timing: "now",
    enteredAt: "",
    quantity: "",
    initialStop: "",
    riskAmount: "",
    entryModel: "",
  };
}

/** Moves the form to another account, keeping the symbol (as that account's instrument, or as "Other symbol"). */
export function switchLiveAccount(draft: LiveDraft, next: FormAccount, accounts: readonly FormAccount[]): LiveDraft {
  const previous = accounts.find(account => account.id === draft.accountId);
  const symbol = draft.instrumentId === OTHER_SYMBOL ? draft.symbol.trim().toUpperCase() : previous?.instruments.find(item => item.id === draft.instrumentId)?.symbol ?? "";
  const match = symbol ? next.instruments.find(item => item.symbol === symbol) : undefined;
  if (match) return { ...draft, accountId: next.id, instrumentId: match.id, symbol: "" };
  if (symbol) return { ...draft, accountId: next.id, instrumentId: OTHER_SYMBOL, symbol };
  return { ...draft, accountId: next.id, instrumentId: newLiveDraft(next).instrumentId, symbol: "" };
}

/**
 * Ticks or clears "Already open — add price later". A position that was already open did not start at save time, so
 * ticking it moves an untouched "Now" to "Not sure" (nothing is recorded; the trade page adds the time once known); a
 * time the trader chose stays. Clearing it changes no timing: "Now" would stamp a time nobody confirmed, and an entry
 * time can never be corrected once recorded (§3.5).
 */
export function withPriceLater(draft: LiveDraft, priceLater: boolean): LiveDraft {
  return { ...draft, priceLater, timing: priceLater && draft.timing === "now" ? "unknown" : draft.timing };
}

/** The account instrument the draft names, or null for "Other symbol" and no choice. */
export function liveInstrument(draft: Pick<LiveDraft, "instrumentId">, account: FormAccount | null): Instrument | null {
  return account?.instruments.find(item => item.id === draft.instrumentId) ?? null;
}

/** `YYYY-MM-DDTHH:mm` of an instant in strategy time (fixed UTC−5), for the Earlier field's limit and default. */
export function strategyWallTime(instant: string): string {
  const clock = strategyClock(instant);
  return `${clock.day}T${clock.time}`;
}

/** The instant of a strategy-time wall time (`2026-10-23T09:42` → `2026-10-23T09:42:00-05:00`), or null when invalid. */
export function wallTimeToInstant(value: string): string | null {
  const match = WALL_TIME.exec(value.trim());
  if (!match) return null;
  const instant = `${match[1]}T${match[2]}:${match[3]}:00-05:00`;
  return isInstant(instant) ? instant : null;
}

function alignedTo(value: string, step: string): boolean {
  return new D(value).mod(step).isZero();
}

function tickMessage(instrument: Instrument): string {
  return `Prices must align to the ${instrument.symbol} tick size of ${stripZeros(instrument.tickSize)}.`;
}

/** The action fields of a valid draft, or the field errors. `now` is server-anchored time (Earlier can't be later). */
export function validateLive(
  draft: LiveDraft, account: FormAccount | null, now: string,
): { ok: true; fields: Record<string, string> } | { ok: false; fieldErrors: LiveFieldErrors } {
  const errors: LiveFieldErrors = {};
  const fields: Record<string, string> = {};
  if (!account) errors.accountId = LIVE_FIELD_COPY.accountId;
  else fields.accountId = account.id;
  const instrument = liveInstrument(draft, account);
  if (instrument) fields.instrumentId = instrument.id;
  else if (draft.instrumentId === OTHER_SYMBOL) {
    const symbol = draft.symbol.trim().toUpperCase();
    if (SYMBOL.test(symbol)) fields.symbol = symbol;
    else errors.symbol = symbol === "" ? LIVE_FIELD_COPY.instrumentId : LIVE_FIELD_COPY.symbol;
  } else if (account) errors.instrumentId = LIVE_FIELD_COPY.instrumentId;
  if (draft.direction === "") errors.direction = LIVE_FIELD_COPY.direction;
  else fields.direction = draft.direction;
  if (draft.entryModel !== "") fields.entryModel = draft.entryModel;

  const entryKnown = !draft.priceLater && isPositiveDecimal(draft.entryPrice);
  if (!draft.priceLater) {
    if (!isPositiveDecimal(draft.entryPrice)) errors.entryPrice = LIVE_FIELD_COPY.entryPrice;
    else if (instrument && !alignedTo(draft.entryPrice, instrument.tickSize)) errors.entryPrice = tickMessage(instrument);
    else fields.entryPrice = draft.entryPrice.trim();
  }

  // "Not sure" sends no entry time: record_live_trade keeps it unknown until "Add entry details" records it.
  if (draft.timing === "now") fields.enteredAt = "now";
  else if (draft.timing === "earlier") {
    const instant = wallTimeToInstant(draft.enteredAt);
    if (instant === null) errors.enteredAt = LIVE_FIELD_COPY.enteredAt;
    else if (compareInstants(instant, now) > 0) errors.enteredAt = LIVE_FIELD_COPY.enteredAtFuture;
    else fields.enteredAt = instant;
  }

  const quantity = draft.quantity.trim();
  if (quantity !== "") {
    if (!isPositiveDecimal(quantity)) errors.quantity = LIVE_FIELD_COPY.quantity;
    else if (instrument && !alignedTo(quantity, instrument.quantityStep)) errors.quantity = `Size must be a multiple of the ${instrument.symbol} size step of ${stripZeros(instrument.quantityStep)}.`;
    else if (instrument && new D(quantity).lt(instrument.minimumQuantity)) errors.quantity = `The minimum ${instrument.symbol} size is ${stripZeros(instrument.minimumQuantity)}.`;
    else fields.quantity = quantity;
  }

  const stop = draft.initialStop.trim();
  if (stop !== "") {
    if (!isPositiveDecimal(stop)) errors.initialStop = LIVE_FIELD_COPY.initialStop;
    else if (instrument && !alignedTo(stop, instrument.tickSize)) errors.initialStop = tickMessage(instrument);
    else if (entryKnown && draft.direction !== "" && (draft.direction === "LONG" ? !new D(stop).lt(draft.entryPrice) : !new D(stop).gt(draft.entryPrice))) {
      errors.initialStop = `For a ${draft.direction === "LONG" ? "long" : "short"} trade, the stop must be ${draft.direction === "LONG" ? "below" : "above"} the entry.`;
    } else fields.initialStop = stop;
  }

  const risk = draft.riskAmount.trim();
  if (risk !== "") {
    if (MONEY.test(risk) && new D(risk).gt(0)) fields.riskAmount = risk;
    else errors.riskAmount = LIVE_FIELD_COPY.riskAmount;
  }
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, fields };
}

/** Server field errors mapped onto the live form's fields. */
export function liveServerErrors(fieldErrors: Record<string, string> | undefined): LiveFieldErrors {
  const mapped: LiveFieldErrors = {};
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    if ((LIVE_FIELD_ORDER as readonly string[]).includes(key)) mapped[key as LiveField] = message;
  }
  return mapped;
}

/**
 * The risk basis Trading OS will derive when no risk amount is reported (UNPLANNED_CLOSE_V1): |entry − stop| / tick ×
 * tick value × size, rounded up to the cent for display. Null unless entry, stop and size are valid for the contract.
 */
export function derivedLiveRisk(draft: LiveDraft, instrument: Instrument | null): string | null {
  if (!instrument || draft.priceLater || draft.direction === "") return null;
  const values = [draft.entryPrice, draft.initialStop, draft.quantity].map(value => value.trim());
  if (!values.every(isPositiveDecimal)) return null;
  const [entry, stop, quantity] = values;
  if (!alignedTo(entry, instrument.tickSize) || !alignedTo(stop, instrument.tickSize) || !alignedTo(quantity, instrument.quantityStep)) return null;
  if (draft.direction === "LONG" ? !new D(stop).lt(entry) : !new D(stop).gt(entry)) return null;
  const risk = new D(entry).minus(stop).abs().div(instrument.tickSize).times(instrument.tickValue).times(quantity);
  return formatMoneyExact(risk.toDecimalPlaces(2, Decimal.ROUND_CEIL).toFixed(), instrument.currency);
}

/** FormData of recordLiveTrade from validated fields and the request key. */
export function liveTradeForm(fields: Record<string, string>, requestKey: string): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("requestKey", requestKey);
  return form;
}
