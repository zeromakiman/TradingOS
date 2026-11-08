import Decimal from "decimal.js";
import { PERIODIC_V2_LIMITS } from "@/ai/periodic-limits";
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

/**
 * The stored facts of a periodic review as its card states them. `summary`: a month reviewed as its deterministic
 * summary (V1 and V2 facts, `mode: "DETERMINISTIC SUMMARY"`), whose plans, journal entries and tags were not sent.
 */
export type StoredPeriodicFacts = PeriodicFacts & { summary?: true };

/** What a monthly review sent as its summary left out, said on its card (the facts said it to the model). */
export const MONTHLY_SUMMARY_NOTE = "Summary review: every trade counts in the results and metrics, but plans, journal entries and tags were not sent.";

/**
 * What a month that will be reviewed as its deterministic summary leaves out, said before the review runs: every trade
 * counts in the results and metrics, but no plan, journal entry, event or tag is sent. Null for a detailed month.
 */
export function monthlySummaryNotice(facts: { mode?: unknown; sample: { count: number } }): string | null {
  if (facts.mode !== "DETERMINISTIC SUMMARY") return null;
  const { detailedTrades, detailedRecords } = PERIODIC_V2_LIMITS.MONTHLY_REVIEW;
  return `This month is larger than one detailed review (at most ${detailedTrades} trades and ${detailedRecords} journal entries and events, when they fit), so it is reviewed as a summary: all ${plural(facts.sample.count, "trade")} count in the results and metrics, but plans, journal entries and tags are not sent.`;
}

/** Sample size and net R of stored weekly (`sample.count`), recent (`sample.actual`) or monthly facts; null when unreadable. */
export function storedPeriodicFacts(facts: unknown): StoredPeriodicFacts | null {
  if (!isRecord(facts) || !isRecord(facts.sample)) return null;
  const { sample } = facts;
  const trades = typeof sample.count === "number" ? sample.count : typeof sample.actual === "number" ? sample.actual : null;
  if (trades === null || !Number.isSafeInteger(trades) || trades < 0) return null;
  const stored: StoredPeriodicFacts = { trades, netR: isRecord(facts.edge) ? netRText(facts.edge.netR) : null };
  return facts.mode === "DETERMINISTIC SUMMARY" ? { ...stored, summary: true } : stored;
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

/**
 * "From Trading OS" strip: `Sample 8 trades · Net R +3.40R` with the small-sample caveat (§13.8), and for a month
 * reviewed as its summary, what the review did not see.
 */
export function periodicFactModels(facts: StoredPeriodicFacts): { facts: AiFactModel[]; note: string } {
  const list: AiFactModel[] = [{ label: "Sample", value: plural(facts.trades, "trade") }];
  if (facts.netR !== null && facts.trades > 0) list.push({ label: "Net R", value: formatR(facts.netR) });
  const caveat = sampleCaveat(facts.trades);
  return { facts: list, note: facts.summary ? `${caveat} ${MONTHLY_SUMMARY_NOTE}` : caveat };
}
