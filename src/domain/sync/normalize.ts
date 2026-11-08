import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { compareInstants, instantMicros, type Instant } from "../time-display";
import type { Direction, ExternalPosition } from "./contract";

/**
 * Validates one untrusted provider position into canonical form. Decimals keep their exact
 * value (numbers are read through their shortest decimal text, never re-rounded); NaN,
 * infinities, exponents in text, negative volumes/prices and sub-cent money are rejected.
 */

const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;
const DECIMAL_TEXT = /^[+-]?\d+(\.\d+)?$/;
const MAX_MAGNITUDE = new Decimal("1e12");
const PRICE_SCALE = 8;
const MONEY_SCALE = 2;

// Any JS number passes the shape check so non-finite values get a field-specific reason below.
const decimalInput = z.union([z.string(), z.custom<number>(value => typeof value === "number")]);
const rawPosition = z.object({
  externalId: z.string(),
  symbol: z.string(),
  direction: z.string(),
  volume: decimalInput,
  entryPrice: decimalInput,
  enteredAt: z.string(),
  exitPrice: decimalInput.nullish(),
  exitedAt: z.string().nullish(),
  commission: decimalInput.nullish(),
  swap: decimalInput.nullish(),
  realizedPnl: decimalInput.nullish(),
  currency: z.string(),
});

export type NormalizeResult = { ok: true; position: ExternalPosition } | { ok: false; externalId: string | null; error: string };

class Rejection extends Error {}

/** Upper-case, without spaces or `/` (`eur/usd` → `EURUSD`); broker suffixes are kept as given. */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[\s/]+/g, "");
}

function decimal(value: string | number, field: string, kind: "positive" | "money"): string {
  let number: Decimal;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Rejection(`${field} must be a finite number.`);
    number = new Decimal(value);
  } else {
    const text = value.trim();
    if (!DECIMAL_TEXT.test(text)) throw new Rejection(`${field} must be a plain decimal number.`);
    number = new Decimal(text);
  }
  if (number.abs().gte(MAX_MAGNITUDE)) throw new Rejection(`${field} is out of range.`);
  if (kind === "positive") {
    if (number.lte(0)) throw new Rejection(`${field} must be positive.`);
    if (number.decimalPlaces() > PRICE_SCALE) throw new Rejection(`${field} has more than ${PRICE_SCALE} decimals.`);
  } else if (number.decimalPlaces() > MONEY_SCALE) {
    throw new Rejection(`${field} has more than ${MONEY_SCALE} decimals.`);
  }
  return number.isZero() ? "0" : number.toFixed();
}

function optionalDecimal(value: string | number | null | undefined, field: string, kind: "positive" | "money"): string | null {
  return value === null || value === undefined ? null : decimal(value, field, kind);
}

/** `YYYY-MM-DDTHH:MM:SS.ffffffZ` for microseconds since the epoch. */
export function instantFromMicros(micros: bigint): string {
  const seconds = micros / 1_000_000n - (micros % 1_000_000n < 0n ? 1n : 0n);
  const fraction = micros - seconds * 1_000_000n;
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(fraction).padStart(6, "0")}Z`;
}

/** Canonical UTC text of an instant at microsecond precision. */
export function canonicalInstant(value: Instant): string {
  return instantFromMicros(instantMicros(value));
}

function instant(value: string, field: string): string {
  try {
    return canonicalInstant(value);
  } catch {
    throw new Rejection(`${field} must be a timestamp with an explicit timezone.`);
  }
}

function direction(value: string): Direction {
  const normalized = value.trim().toUpperCase();
  if (normalized === "LONG" || normalized === "BUY") return "LONG";
  if (normalized === "SHORT" || normalized === "SELL") return "SHORT";
  throw new Rejection("Direction must be long/buy or short/sell.");
}

/** sha256 over the canonical fields in a fixed order. */
export function positionHash(position: Omit<ExternalPosition, "payloadHash">): string {
  const canonical = JSON.stringify([
    position.externalId, position.symbol, position.direction, position.volume, position.entryPrice, position.enteredAt,
    position.exitPrice, position.exitedAt, position.commission, position.swap, position.realizedPnl, position.currency,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeExternalPosition(raw: unknown, options: { now?: Instant } = {}): NormalizeResult {
  const parsed = rawPosition.safeParse(raw);
  const rawId = typeof (raw as { externalId?: unknown } | null)?.externalId === "string" ? (raw as { externalId: string }).externalId.trim() : null;
  const externalId = rawId && rawId.length <= 120 ? rawId : null;
  if (!parsed.success) return { ok: false, externalId, error: "The platform position is missing required fields." };
  const input = parsed.data;
  try {
    const id = input.externalId.trim();
    if (id.length < 1 || id.length > 120) throw new Rejection("The platform position id must have 1–120 characters.");
    const symbol = normalizeSymbol(input.symbol);
    if (!SYMBOL.test(symbol)) throw new Rejection("Symbol is not a valid instrument code.");
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Rejection("Currency must be a three-letter code.");
    const enteredAt = instant(input.enteredAt, "Entry time");
    const exitedAt = input.exitedAt == null ? null : instant(input.exitedAt, "Exit time");
    const exitPrice = optionalDecimal(input.exitPrice, "Exit price", "positive");
    const realizedPnl = optionalDecimal(input.realizedPnl, "Realized P&L", "money");
    if (exitPrice !== null && exitedAt === null) throw new Rejection("An exit price requires an exit time.");
    if (exitedAt !== null && exitPrice === null && realizedPnl === null) throw new Rejection("A closed position needs an exit price or a realized P&L.");
    if (exitedAt !== null && compareInstants(exitedAt, enteredAt) < 0) throw new Rejection("Exit time is before the entry time.");
    if (options.now !== undefined) {
      if (compareInstants(enteredAt, options.now) > 0 || (exitedAt !== null && compareInstants(exitedAt, options.now) > 0)) throw new Rejection("Timestamps cannot be in the future.");
    }
    const position: Omit<ExternalPosition, "payloadHash"> = {
      externalId: id,
      symbol,
      direction: direction(input.direction),
      volume: decimal(input.volume, "Volume", "positive"),
      entryPrice: decimal(input.entryPrice, "Entry price", "positive"),
      enteredAt,
      exitPrice,
      exitedAt,
      commission: optionalDecimal(input.commission, "Commission", "money"),
      swap: optionalDecimal(input.swap, "Swap", "money"),
      realizedPnl,
      currency,
    };
    return { ok: true, position: { ...position, payloadHash: positionHash(position) } };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, externalId, error: error.message };
    throw error;
  }
}
