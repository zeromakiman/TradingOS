import Decimal from "decimal.js";
import { formatR } from "@/domain/format";
import type { RMetrics } from "@/domain/performance";

/**
 * Display helpers for EDGE ratios (docs/V2_ARCHITECTURE.md §6.6, §13.8). Exact decimal strings in, words out; no
 * binary floating point. R values and money always go through src/domain/format (formatR, formatSignedMoney).
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** A fraction as a percentage with one decimal: `"0.5483"` → `54.8%`; `—` when unknown. */
export function formatRate(fraction: string | null): string {
  if (fraction === null) return "—";
  return `${new D(fraction).mul(100).toFixed(1)}%`;
}

/** Share of the combined net R: `"0.725"` → `73%`, never `-0%`. */
export function formatShare(fraction: string): string {
  const percent = new D(fraction).mul(100).toDecimalPlaces(0);
  return `${percent.isZero() ? "0" : percent.toFixed(0)}%`;
}

/** Profit factor to two decimals, or its state in words. */
export function formatProfitFactor(metrics: Pick<RMetrics, "profitFactor" | "profitFactorState">): string {
  switch (metrics.profitFactorState) {
    case "NO_DATA": return "—";
    case "NO_LOSSES": return "No losses";
    case "NO_GAINS_OR_LOSSES": return "No gains or losses";
    case "DEFINED": return metrics.profitFactor === null ? "—" : new D(metrics.profitFactor).toFixed(2);
  }
}

/** A drawdown distance (≥ 0) shown as the R given back: `"4.2"` → `-4.20R`, `"0"` → `0.00R`. */
export function formatDrawdownR(distance: string | null): string {
  if (distance === null) return "—";
  const value = new D(distance);
  return formatR(value.isZero() ? "0" : value.abs().neg().toFixed());
}

export type SignTone = "pos" | "neg" | "zero";

/** Sign of an exact decimal; null when unknown. */
export function signTone(value: string | null | undefined): SignTone | null {
  if (value === null || value === undefined) return null;
  const decimal = new D(value);
  return decimal.isZero() ? "zero" : decimal.isNegative() ? "neg" : "pos";
}

/** Text colour class for a signed result (the sign is always printed too). */
export function toneClass(tone: SignTone | null): string | undefined {
  return tone === "pos" ? "value-pos" : tone === "neg" ? "value-neg" : undefined;
}

/** The §13.8 sample band in words, for chart captions. */
export function sampleWords(n: number): string {
  if (n === 0) return "no data yet";
  if (n < 10) return "early sample";
  if (n < 30) return "small sample";
  if (n < 100) return "developing sample";
  return "larger sample";
}
