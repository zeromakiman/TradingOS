import Decimal from "decimal.js";
import type { PeriodicFacts } from "@/domain/ai-summary";
import { formatR, plural } from "@/domain/format";
import { sampleCaveat } from "@/domain/performance";
import type { AiFactModel } from "./model";

/**
 * Deterministic facts of a periodic review (docs/V2_ARCHITECTURE.md §11.1): sample size and net R come from the facts
 * Trading OS stored with the request, never from the AI's text.
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

/** Net R as exact text: stored facts keep it as a JSON number (metrics output) or, in newer facts, a decimal string. */
function netRText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Decimal(value).toFixed();
  if (typeof value === "string" && DECIMAL.test(value.trim())) return value.trim();
  return null;
}

/** Sample size and net R of stored weekly (`sample.count`), recent (`sample.actual`) or monthly facts; null when unreadable. */
export function storedPeriodicFacts(facts: unknown): PeriodicFacts | null {
  if (!isRecord(facts) || !isRecord(facts.sample)) return null;
  const { sample } = facts;
  const trades = typeof sample.count === "number" ? sample.count : typeof sample.actual === "number" ? sample.actual : null;
  if (trades === null || !Number.isSafeInteger(trades) || trades < 0) return null;
  return { trades, netR: isRecord(facts.edge) ? netRText(facts.edge.netR) : null };
}

/** "From Trading OS" strip: `Sample 8 trades · Net R +3.40R` with the small-sample caveat (§13.8). */
export function periodicFactModels(facts: PeriodicFacts): { facts: AiFactModel[]; note: string } {
  const list: AiFactModel[] = [{ label: "Sample", value: plural(facts.trades, "trade") }];
  if (facts.netR !== null && facts.trades > 0) list.push({ label: "Net R", value: formatR(facts.netR) });
  return { facts: list, note: sampleCaveat(facts.trades) };
}
