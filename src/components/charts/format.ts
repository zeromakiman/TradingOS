import type { Dec } from "./scale";
import { toDecimal } from "./scale";
import type { TickFormatter } from "./types";

// Same sign glyphs as the domain formatters (formatR, formatSignedMoney), so axes and values match.
const withSign = (negative: boolean, text: string, plus: boolean) => (negative ? `-${text}` : plus ? `+${text}` : text);

/** Plain axis number: "0", "1.5", "-2". */
export const formatTickNumber: TickFormatter = (value) => {
  const decimal = toDecimal(value);
  if (!decimal) return value;
  return withSign(decimal.isNegative() && !decimal.isZero(), decimal.abs().toFixed(), false);
};

/** R axis: "+1.5R", "0R", "-1R" (R is per-trade risk units). */
export const formatTickR: TickFormatter = (value) => {
  const decimal = toDecimal(value);
  if (!decimal) return value;
  if (decimal.isZero()) return "0R";
  return `${withSign(decimal.isNegative(), decimal.abs().toFixed(), true)}R`;
};

/** Power of ten that compact notation divides by: 1e3 for thousands (K) up to 1e12 (T). */
function compactUnit(magnitude: Dec) {
  return `1e${Math.min(12, Math.floor(magnitude.e / 3) * 3)}`;
}

/**
 * Money axis in one currency, with exact labels so neighbouring ticks never print the same
 * text: steps of 1,000 and more use compact notation with as many decimals as the step needs
 * in that unit ("$98K", "$102.5K", "$1.25M"); finer steps print the full amount ("$100,050",
 * "$12.50"). Without a step the value's own precision is used. Exact decimal input, no float
 * conversion.
 */
export function formatTickMoney(currency: string): TickFormatter {
  const minorDigits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const formats = new Map<string, Intl.NumberFormat>();
  const formatFor = (notation: "compact" | "standard", digits: number) => {
    const key = `${notation}:${digits}`;
    const cached = formats.get(key);
    if (cached) return cached;
    const created = new Intl.NumberFormat("en-US", { style: "currency", currency, notation, minimumFractionDigits: digits, maximumFractionDigits: digits });
    formats.set(key, created);
    return created;
  };
  return (value, step) => {
    const decimal = toDecimal(value);
    if (!decimal) return value;
    const magnitude = decimal.abs();
    const spacing = toDecimal(step)?.abs() ?? magnitude;
    let text: string;
    if (magnitude.gte(1000) && spacing.gte(1000)) {
      // Ticks are multiples of the step, so the step's decimals in this unit keep every label exact.
      text = formatFor("compact", spacing.div(compactUnit(magnitude)).decimalPlaces()).format(magnitude.toFixed() as `${number}`);
    } else {
      const places = spacing.decimalPlaces();
      text = formatFor("standard", places === 0 ? 0 : Math.max(places, minorDigits)).format(magnitude.toFixed() as `${number}`);
    }
    return withSign(decimal.isNegative() && !decimal.isZero(), text, false);
  };
}

/** Whole-number axis for counts. */
export const formatTickCount: TickFormatter = formatTickNumber;
