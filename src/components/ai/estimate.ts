import Decimal from "decimal.js";
import { type AiCostEstimate, type AiCostOperation, estimateAiCost } from "@/domain/ai-summary";
import { formatMoney } from "@/domain/format";
import type { AiEstimateModel } from "./model";

/**
 * Cost estimates for paid buttons (docs/V2_ARCHITECTURE.md §11.2), computed on the server with the server clock and
 * passed to client buttons as plain strings. `estimateAiCost` throws while a pricing profile is expired or the
 * operation is unknown; every helper here turns that into `null`, which disables the paid button instead of failing
 * the page.
 */

function euros(micros: number, rounding: Decimal.Rounding): string {
  return formatMoney(new Decimal(micros).div(1_000_000).toDecimalPlaces(2, rounding).toFixed(), "EUR");
}

/** Typical cost rounded half-up to the cent; the reserved maximum rounded up so "at most" stays true. */
export function estimateModel(estimate: AiCostEstimate | null | undefined): AiEstimateModel | null {
  if (!estimate || !Number.isSafeInteger(estimate.typicalMicros) || !Number.isSafeInteger(estimate.maxMicros)) return null;
  if (estimate.typicalMicros < 0 || estimate.maxMicros < 0) return null;
  return { typical: euros(estimate.typicalMicros, Decimal.ROUND_HALF_UP), max: euros(estimate.maxMicros, Decimal.ROUND_UP) };
}

/** Estimate of one request now, or null when pricing is expired, unknown or otherwise unusable (never throws). */
export function aiEstimate(operation: AiCostOperation, now: Date = new Date()): AiEstimateModel | null {
  try {
    return estimateModel(estimateAiCost(operation, now));
  } catch {
    return null;
  }
}
