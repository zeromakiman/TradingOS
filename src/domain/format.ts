import Decimal from "decimal.js";

/**
 * Number display rules (V2 spec §6.6). Every function accepts exact decimal strings (including
 * 32-dp SQL scale) and never routes them through binary floating point. Display rounding must
 * never contradict a deterministic verdict.
 */

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
export type DecimalLike = string | number | Decimal;
type RoundingMode = "halfExpand" | "trunc";
type SignDisplay = "negative" | "exceptZero";

const DECIMAL_TEXT = /^[+-]?\d+(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MONEY_LOCALE = "en-US";
/** Thresholds with more decimals than this are shown exactly; values are never padded beyond it. */
const MAX_AGAINST_DECIMALS = 8;

function toDecimal(value: DecimalLike): Decimal {
  if (typeof value === "string") {
    const text = value.trim();
    if (!DECIMAL_TEXT.test(text)) throw new TypeError("Invalid decimal value.");
    return new D(text);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Invalid decimal value.");
    return new D(value);
  }
  if (!Decimal.isDecimal(value) || !value.isFinite()) throw new TypeError("Invalid decimal value.");
  return new D(value);
}

/** Exact text of a decimal without trailing zeros and never in exponent notation (`"50.000"` → `"50"`). */
export function stripZeros(value: DecimalLike): string {
  return toDecimal(value).toFixed();
}

/** Number of decimals after trailing zeros are removed (`"0.50000000"` → 1). */
export function scaleOf(value: DecimalLike): number {
  return toDecimal(value).decimalPlaces();
}

/** Policy and user-input values: exact, trailing zeros stripped, padded to `minDecimals` (`0.5` → `0.50`, `0.504` → `0.504`). */
export function formatDecimal(value: DecimalLike, minDecimals = 2): string {
  const number = toDecimal(value);
  return number.toFixed(Math.max(minDecimals, number.decimalPlaces()));
}

/** Percent of account as entered or configured: `0.50%`, `0.504%`, `0.004%`. */
export function formatPercent(value: DecimalLike): string {
  return `${formatDecimal(value)}%`;
}

function scaledExact(value: DecimalLike, scaleSource: DecimalLike | null | undefined): string {
  const number = toDecimal(value);
  const scale = scaleSource === null || scaleSource === undefined ? 0 : scaleOf(scaleSource);
  return number.toFixed(Math.max(number.decimalPlaces(), scale));
}

/** Prices at the instrument tick scale (`1.1` with tick `0.00001` → `1.10000`); off-tick prices keep every digit. */
export function formatPrice(value: DecimalLike, tickSize?: DecimalLike | null): string {
  return scaledExact(value, tickSize);
}

/** Quantities at the instrument step scale (`1` with step `0.01` → `1.00`), never rounded. */
export function formatQuantity(value: DecimalLike, quantityStep?: DecimalLike | null): string {
  return scaledExact(value, quantityStep);
}

/**
 * Realized R everywhere (summary, tables, charts, AI facts): `+1.01R`, `-1.00R`, `0.00R`.
 * Non-zero magnitudes below 0.005R show up to 4 decimals (`+0.003R`, `-0.0002R`); magnitudes too
 * small even for that show one significant digit, so a non-zero R never reads `0.00R` or `-0.00R`.
 */
export function formatR(value: DecimalLike | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const r = toDecimal(value);
  if (r.isZero()) return "0.00R";
  const magnitude = r.abs();
  let digits: string;
  if (magnitude.gte("0.005")) {
    digits = magnitude.toFixed(2, D.ROUND_HALF_UP);
  } else {
    const fourDecimals = magnitude.toDecimalPlaces(4, D.ROUND_HALF_UP);
    digits = fourDecimals.isZero() ? magnitude.toSignificantDigits(1, D.ROUND_HALF_UP).toFixed() : fourDecimals.toFixed();
  }
  return `${r.isNegative() ? "-" : "+"}${digits}R`;
}

/**
 * A value compared with a threshold (spec §6.6): start at max(2, scale(threshold)) decimals and
 * round toward the side that preserves the verdict — down for minimum rules (RR), up for maximum
 * rules (risk %, money vs cap) — adding decimals (≤ 8) until the displayed comparison agrees with
 * `passes`. Exact equality displays equal and passes. If no rounding can agree (inputs that
 * contradict the verdict), the exact value is shown rather than a misleading one.
 * Show the threshold itself with `formatDecimal` (exact), which this function assumes.
 */
export function formatAgainst(value: DecimalLike, threshold: DecimalLike, rule: "min" | "max", passes: boolean): string {
  const number = toDecimal(value);
  const limit = toDecimal(threshold);
  const start = Math.max(2, limit.decimalPlaces());
  const direction = rule === "min" ? D.ROUND_FLOOR : D.ROUND_CEIL;
  for (let decimals = start; decimals <= Math.max(start, MAX_AGAINST_DECIMALS); decimals++) {
    const shown = number.toDecimalPlaces(decimals, direction);
    const shownPasses = rule === "min" ? shown.gte(limit) : shown.lte(limit);
    if (shownPasses === passes) return shown.toFixed(decimals);
  }
  return number.toFixed(Math.max(start, number.decimalPlaces()));
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, decimals: number, rounding: RoundingMode, sign: SignDisplay): Intl.NumberFormat {
  if (!CURRENCY_CODE.test(currency)) throw new RangeError("Invalid currency code.");
  const key = `${currency}|${decimals}|${rounding}|${sign}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(MONEY_LOCALE, {
      style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      roundingMode: rounding, signDisplay: sign,
    });
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

/** Intl formats numeric strings exactly (no binary floating point), so pass canonical text. */
function exactText(value: DecimalLike): `${number}` {
  return toDecimal(value).toFixed() as `${number}`;
}

/** Money: Intl currency style, 2 dp, half-up for display only (`"98.00000000000000000000000000000000"` → `$98.00`). */
export function formatMoney(value: DecimalLike, currency: string): string {
  return moneyFormatter(currency, 2, "halfExpand", "negative").format(exactText(value));
}

/** Signed money for results: `+$1,420.00`, `-$50.00`, `$0.00`. */
export function formatSignedMoney(value: DecimalLike, currency: string): string {
  return moneyFormatter(currency, 2, "halfExpand", "exceptZero").format(exactText(value));
}

/** Money shown exactly, padded to 2 dp (thresholds such as caps or remaining amounts). */
export function formatMoneyExact(value: DecimalLike, currency: string): string {
  return moneyFormatter(currency, Math.max(2, scaleOf(value)), "trunc", "negative").format(exactText(value));
}

/** Money compared with a threshold, with `formatAgainst` decimals and rounding direction. */
export function formatMoneyAgainst(value: DecimalLike, threshold: DecimalLike, currency: string, rule: "min" | "max", passes: boolean): string {
  const digits = formatAgainst(value, threshold, rule, passes);
  const decimals = digits.includes(".") ? digits.length - digits.indexOf(".") - 1 : 0;
  return moneyFormatter(currency, decimals, "trunc", "negative").format(digits as `${number}`);
}

/** Per-currency money, never converted: `+$1,420.00 · +€380.00` (`—` when empty). */
export function formatSignedMoneyList(entries: readonly { currency: string; amount: DecimalLike }[]): string {
  return entries.length ? entries.map(entry => formatSignedMoney(entry.amount, entry.currency)).join(" · ") : "—";
}

/** `1 trade`, `2 trades`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
