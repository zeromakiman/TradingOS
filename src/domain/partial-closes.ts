import Decimal from "decimal.js";
import { compareInstants } from "./time-display";
import type { TimelineItem } from "./timeline";

/**
 * Partial closes of an open position (docs/V2_ARCHITECTURE.md §3.6). They are journal records, not accounting events:
 * a close records one exit price for the whole position (FULL_CLOSE_V1 / UNPLANNED_CLOSE_V1). When the journal says
 * what each partial close took off and at what price, that one price follows from them and the exit of the rest: the
 * volume-weighted average of every leg, on the instrument's tick (a close accepts no other price). The trader then
 * enters only what Trading OS doesn't know yet, the exit of the rest, never an average worked out by hand (§60.17).
 *
 * A size is exact. A percent is a share of the position only on the first partial close, when nothing had been taken
 * off yet; a later percent may mean the original or the remaining size, so it is never guessed. Neither is a partial
 * close without a price or an amount: the trader then enters the average exit as before. Amounts are added in contract
 * units, exactly (Decimal.js, never floating point), and divided once, for the average. Pure: safe on server and client.
 */

const D = Decimal.clone({ precision: 60 });
/** The journal's decimals (`private.decimal_input`): positive, up to 12 integer digits and 8 decimals. */
const DECIMAL = /^\d{1,12}(\.\d{1,8})?$/;
/** A partial close's percent (`private.check_journal_details`): more than 0 and less than 100. */
const PERCENT = /^\d{1,2}(\.\d{1,8})?$/;
/** Exact decimal text of the ledger (`trim_scale`). */
const LEDGER_DECIMAL = /^\d+(\.\d+)?$/;

export interface PartialCloseRecord {
  id: string;
  recordedAt: string;
  /** Exit price of the partial close, when the journal gives one. */
  price: string | null;
  /** Size closed, in contract units, when given. */
  quantity: string | null;
  /** Percent of the position closed, when given (never together with a size). */
  percent: string | null;
}

/** A positive journal decimal (`details.price`, `details.quantity`), else null. */
export function journalDecimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) && new D(value).gt(0) ? value : null;
}

/** A partial close's percent (`details.percent`, 0 < p < 100), else null. */
export function journalPercent(value: unknown): string | null {
  return typeof value === "string" && PERCENT.test(value) && new D(value).gt(0) ? value : null;
}

/**
 * The partial closes the journal recorded while the trade was live, oldest first, from the trade's timeline. Only rows
 * stored in the LIVE phase count (§5.2), as on Today: on a trade that is still live those are exactly the While live
 * entries without the "Recorded after execution began" flag (a row stored before the entry carries it, or is Before
 * entry; a row stored after a close is After close).
 */
export function livePartialCloses(timeline: readonly TimelineItem[]): PartialCloseRecord[] {
  return timeline
    .filter(item => item.kind === "JOURNAL" && item.journalKind === "PARTIAL_CLOSE" && item.timing === "WHILE_LIVE" && !item.flags.includes("RECORDED_AFTER_EXECUTION_BEGAN"))
    .map(item => ({
      id: item.id,
      recordedAt: item.recordedAt,
      price: journalDecimal(item.details?.price),
      quantity: journalDecimal(item.details?.quantity),
      percent: journalPercent(item.details?.percent),
    }))
    .sort((a, b) => compareInstants(a.recordedAt, b.recordedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PartialLeg {
  id: string;
  recordedAt: string;
  price: string;
  /** Size closed: as recorded, or the position × percent ÷ 100 for a percent. */
  quantity: string;
  /** The percent the journal recorded (the first partial close only); null for a recorded size. */
  percent: string | null;
}

/** Why the average exit can't be worked out from the journal (the trader enters it). */
export type AverageReason =
  | "NO_PRICE"
  | "NO_AMOUNT"
  /** A percent recorded after an earlier partial close: of the original or of the remaining size? */
  | "LATER_PERCENT"
  /** The position's size isn't recorded. */
  | "NO_SIZE"
  /** The partial closes add up to the whole position: `average` is theirs. */
  | "WHOLE_POSITION"
  | "BEYOND_POSITION"
  /** Not every journal entry could be read. */
  | "UNREAD";

export type SplitClose = {
  kind: "SPLIT";
  legs: PartialLeg[];
  /** The position's size. */
  position: string;
  /** Size still open: the position less every leg, exact. */
  remaining: string;
  /** Percent of the position still open, when the only partial close was given as a percent. */
  remainingPercent: string | null;
};

export type CloseLegs =
  /** No partial close was journaled while the trade was live. */
  | { kind: "NONE" }
  /** Every partial close has a price and an amount: the rest of the position closes at the exit the trader enters. */
  | SplitClose
  /** The trader enters the average exit; `average` is the legs' exact average when they close the whole position. */
  | { kind: "AVERAGE"; records: PartialCloseRecord[]; reason: AverageReason; average: string | null };

/**
 * What the close can work out from the journal's partial closes (`records`, oldest first) for a position of
 * `position.quantity`. `complete` is false when the journal could not be read in full.
 */
export function closeLegs(records: readonly PartialCloseRecord[], position: { quantity: string | null }, complete = true): CloseLegs {
  if (records.length === 0) return { kind: "NONE" };
  const average = (reason: AverageReason, value: string | null = null): CloseLegs => ({ kind: "AVERAGE", records: [...records], reason, average: value });
  if (!complete) return average("UNREAD");
  const size = position.quantity !== null && LEDGER_DECIMAL.test(position.quantity) && new D(position.quantity).gt(0) ? new D(position.quantity) : null;
  const legs: PartialLeg[] = [];
  for (const [index, record] of records.entries()) {
    if (record.price === null) return average("NO_PRICE");
    if (record.quantity === null && record.percent === null) return average("NO_AMOUNT");
    if (record.percent !== null && index > 0) return average("LATER_PERCENT");
    if (size === null) return average("NO_SIZE");
    const quantity = record.quantity !== null ? new D(record.quantity) : size.times(record.percent as string).div(100);
    legs.push({ id: record.id, recordedAt: record.recordedAt, price: record.price, quantity: quantity.toFixed(), percent: record.quantity !== null ? null : record.percent });
  }
  // Every leg was validated above, so the position's size is known here.
  const total = size as Decimal;
  const closed = legs.reduce((sum, leg) => sum.plus(leg.quantity), new D(0));
  if (closed.gt(total)) return average("BEYOND_POSITION");
  if (closed.eq(total)) return average("WHOLE_POSITION", weighted(legs, total).toFixed());
  const remaining = total.minus(closed);
  const onlyPercent = legs.length === 1 && legs[0].percent !== null;
  return {
    kind: "SPLIT", legs, position: total.toFixed(), remaining: remaining.toFixed(),
    remainingPercent: onlyPercent ? new D(100).minus(legs[0].percent as string).toFixed() : null,
  };
}

/** Σ size × price ÷ position, plus the rest at `restPrice` when given. */
function weighted(legs: readonly PartialLeg[], position: Decimal, rest?: { quantity: string; price: string }): Decimal {
  const sum = legs.reduce((total, leg) => total.plus(new D(leg.quantity).times(leg.price)), new D(0));
  return (rest ? sum.plus(new D(rest.quantity).times(rest.price)) : sum).div(position);
}

/**
 * `value` on the instrument's tick, as a close records it: the nearest multiple of the tick (halves up), or 8 decimals
 * at most when the tick is unknown. Null when that is not a positive price.
 */
export function onTick(value: string, tickSize: string | null): string | null {
  if (!LEDGER_DECIMAL.test(value)) return null;
  const tick = tickSize !== null && LEDGER_DECIMAL.test(tickSize) && new D(tickSize).gt(0) ? new D(tickSize) : null;
  const price = tick ? new D(value).toNearest(tick, Decimal.ROUND_HALF_UP) : new D(value).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
  return price.gt(0) && DECIMAL.test(price.toFixed()) ? price.toFixed() : null;
}

export interface AverageExit {
  /** Exact volume-weighted average of every leg. */
  exact: string;
  /** The exit the close records: the average on the instrument's tick (`onTick`). */
  price: string;
}

/** The average exit of the whole position when the rest closes at `restPrice`; null when `restPrice` is not a price. */
export function averageExit(split: SplitClose, restPrice: string, tickSize: string | null): AverageExit | null {
  if (!DECIMAL.test(restPrice) || !new D(restPrice).gt(0)) return null;
  const exact = weighted(split.legs, new D(split.position), { quantity: split.remaining, price: restPrice }).toFixed();
  const price = onTick(exact, tickSize);
  return price === null ? null : { exact, price };
}
