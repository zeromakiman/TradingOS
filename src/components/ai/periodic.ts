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

/**
 * True while a request of this period (or sample) has no result yet. The database runs one review of a period at a time
 * (one recent-trades analysis per account), so another request would only be refused.
 */
export function periodicRequestRunning(history: readonly { status: string }[]): boolean {
  return history.some(row => row.status === "IN_PROGRESS");
}

/** Why the run button waits: "A review of the week of Oct 6–12 is still running. Its result will appear in the history." */
export function periodicRunningReason(kind: "weekly" | "recent" | "monthly", runLabel: string): string {
  const subject = kind === "recent" ? `An analysis of the ${runLabel}` : kind === "weekly" ? `A review of the ${runLabel}` : `A review of ${runLabel}`;
  return `${subject} is still running. Its result will appear in the history.`;
}

/**
 * Why the Recent trades button waits while the account's analysis of another sample runs: the database runs one
 * recent-trades analysis per account, whatever its sample, and the result appears in that sample's history.
 */
export function recentRunningElsewhereReason(sample: number): string {
  return `An analysis of the last ${sample} trades is still running, and an account runs one recent-trades analysis at a time. Its result will appear under ${sample} trades.`;
}

/**
 * Why the run button waits, or undefined when nothing of this period is running: a running request in the period's own
 * history, or (Recent trades, whose lock covers the account) the account's running analysis of any sample.
 */
export function periodicRunningBlock(
  kind: "weekly" | "recent" | "monthly",
  runLabel: string,
  history: readonly { status: string }[],
  running: { sample: number; selected: number } | null = null,
): string | undefined {
  if (periodicRequestRunning(history)) return periodicRunningReason(kind, runLabel);
  if (kind !== "recent" || running === null) return undefined;
  return running.sample === running.selected ? periodicRunningReason(kind, runLabel) : recentRunningElsewhereReason(running.sample);
}

/** "From Trading OS" strip: `Sample 8 trades · Net R +3.40R` with the small-sample caveat (§13.8). */
export function periodicFactModels(facts: PeriodicFacts): { facts: AiFactModel[]; note: string } {
  const list: AiFactModel[] = [{ label: "Sample", value: plural(facts.trades, "trade") }];
  if (facts.netR !== null && facts.trades > 0) list.push({ label: "Net R", value: formatR(facts.netR) });
  return { facts: list, note: sampleCaveat(facts.trades) };
}
