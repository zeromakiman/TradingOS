import type { Metrics } from "@/domain/analytics";
import type { PeriodicTradeSource } from "./periodic-facts";

/**
 * Bounds of the compact V2 periodic facts (WEEKLY_REVIEW_FACTS_V2, RECENT_TRADES_FACTS_V2, MONTHLY_REVIEW_FACTS_V2).
 * `trades` and `records` (journal entries plus events) bound what one review reads: a period or sample above them is
 * refused as a whole, nothing is omitted. Whether a sample within them fits is decided by the conservative estimate of
 * the whole request (src/ai/request-estimate.ts) before anything is written or reserved: a sample that would not fit is
 * refused with its review's copy, and a month falls back to its deterministic summary. How much fits depends on the
 * trade count and on how much each trade records; with the densest realistic content (database ids and timestamps,
 * every text at its bound) the tests pin it at 95, 60 and 25 records for 10, 20 and 30 recent trades, 60 and 25 records
 * for a 10- and a 20-trade week, and 90 and 15 records for a detailed 10- and 30-trade month.
 * `bytes` is 4 × the operation's input limit: the facts alone can never be larger than the request may be.
 */
export const PERIODIC_V2_LIMITS = Object.freeze({
  WEEKLY_REVIEW: Object.freeze({ trades: 20, records: 70, bytes: 96_000 }),
  /** Recent trades: the more trades requested, the fewer journal entries and events are read beside them. */
  RECENT_TRADES_ANALYSIS: Object.freeze({ trades: 30, records: Object.freeze({ 10: 150, 20: 120, 30: 90 }), bytes: 128_000 }),
  /**
   * Detailed mode lists up to `detailedTrades` trades and `detailedRecords` records when the whole request fits;
   * otherwise the month is the explicit deterministic summary of up to `trades` trades. Only a month that may be
   * detailed has its records read (at most `detailedRecords`); the summary uses no record content, only their counts,
   * so no record bound applies to it.
   */
  MONTHLY_REVIEW: Object.freeze({ trades: 120, bytes: 128_000, detailedTrades: 30, detailedRecords: 90 }),
});

/** Journal entries and events of the given trades. */
export function periodicRecordCount(sources: readonly Pick<PeriodicTradeSource, "events" | "journal">[]): number {
  return sources.reduce((count, source) => count + source.events.length + source.journal.length, 0);
}

/** EDGE metrics (of the sample or of one breakdown group) without the per-trade equity curve: every trade carries its own realized R. */
export function compactEdge<T extends Pick<Metrics, "curve">>(metrics: T): Omit<T, "curve"> {
  const { curve: _curve, ...rest } = metrics;
  return rest;
}
