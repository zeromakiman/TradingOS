import { createHash } from "node:crypto";
import type { PeriodicJournalEntry, PeriodicTradeSource } from "@/ai/periodic-facts";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { evaluateRisk } from "@/domain/risk";
import { storedRiskSchema } from "@/domain/risk-report";
import { ids, plan as basePlan, risk as baseRisk, strategy as baseStrategy, trade as baseTrade } from "./trade-review";

/**
 * Synthetic closed planned trades for the V2 periodic facts: each trade has a locked plan, its V2 trade identity
 * (`trades.id`), V1 events (plan lock, entry, close and a note) and V2 journal entries in every timing band, plus V2 tag
 * sets. `periodicTables` lays the same records out as database rows for the loader tests.
 */
export { ids };
/**
 * A realistic engine 1.2 report a plan was locked with: approved, with its calculations, the "news not checked"
 * warning and the low-priority notes (unconfigured daily caps, costs).
 */
export const APPROVED_REPORT = storedRiskSchema.parse(evaluateRisk({ ...previewProposal, contractConfirmed: true, narrative: "Waited for the recorded model." }, previewContext));
const pad = (n: number) => String(n).padStart(12, "0");
export const planId = (i: number) => `30000000-0000-4000-8000-${pad(i + 1)}`;
export const tradeRecordId = (i: number) => `90000000-0000-4000-8000-${pad(i + 1)}`;
const eventId = (i: number, j: number) => `60000000-0000-4000-8${String(i).padStart(3, "0")}-${pad(j + 1)}`;
const journalId = (i: number, j: number) => `70000000-0000-4000-8${String(i).padStart(3, "0")}-${pad(j + 1)}`;
const minutes = (at: string, n: number) => new Date(Date.parse(at) + n * 60_000).toISOString();

export interface PeriodicFixtureOptions {
  /** Entry time of the first trade; each next trade enters `stepMinutes` later. */
  start: string;
  stepMinutes?: number;
  /** V2 journal entries per trade: before entry, while live, after close (cycled). */
  journal?: number;
  /** Text of every journal entry. */
  body?: string;
}

/** `count` closed planned trades with their sources, newest last. */
export function periodicSourcesV2(count: number, options: PeriodicFixtureOptions): PeriodicTradeSource[] {
  const step = options.stepMinutes ?? 120;
  return Array.from({ length: count }, (_, i) => {
    const entered = minutes(options.start, i * step);
    const exited = minutes(entered, 30);
    const locked = minutes(entered, -10);
    const id = planId(i);
    const plan = { ...structuredClone(basePlan), id, locked_at: locked, trading_day: entered.slice(0, 10), risk_result: structuredClone(APPROVED_REPORT) };
    const trade = { ...structuredClone(baseTrade), id, locked_at: locked, entered_at: entered, exited_at: exited };
    const journal: PeriodicJournalEntry[] = Array.from({ length: options.journal ?? 3 }, (_, j) => {
      const band = j % 3;
      return {
        id: journalId(i, j), kind: band === 2 ? "LESSON" : "NOTE", body: options.body ?? `Journal entry ${j + 1} of trade ${i + 1}.`, details: {},
        phase: band === 0 ? "PRE_ENTRY" : band === 1 ? "LIVE" : "POST_TRADE",
        recordedAt: band === 0 ? minutes(entered, -5) : band === 1 ? minutes(entered, 10 + j) : minutes(exited, 5 + j),
      };
    });
    return {
      plan, trade, tradeRecordId: tradeRecordId(i), entryRecordedAt: minutes(entered, 1), closeRecordedAt: minutes(exited, 1),
      strategy: { id: baseStrategy.id, version: baseStrategy.version, rules: baseStrategy.rules },
      risk: { ...baseRisk, rr_policy: baseRisk.rr_policy as "BLOCK" | "WARN", news_policy: baseRisk.news_policy as "BLOCK" | "WARN" },
      events: [{ id: eventId(i, 3), event_type: "NOTE_ADDED", payload: { note: `Waited for confirmation on trade ${i + 1}.` }, occurred_at: minutes(entered, 12), recorded_at: minutes(entered, 12) }],
      journal,
      tags: { setupGrade: "A", liquidityContext: "PDH", mssTimeframe: "M5", tags: ["london"], source: "V2", recordedAt: minutes(exited, 2) },
    };
  });
}

/** A 5,000-character journal text (shortened to its bound in the facts). */
export const MAXIMAL_TEXT = "Moved the stop under the swing low after the displacement candle closed; holding for the target. ".repeat(60).slice(0, 5000);
/** A thesis longer than the narrative bound that closes with its invalidation, as traders write them. */
export const LONG_THESIS = [
  "London swept the equal lows, then an M5 market structure shift with clear displacement left a bullish order block below the open.",
  "Entry on the first touch of the proximal edge, stop beyond the sweep, target at the Asian range high where resting liquidity sits.",
  "H1 is bullish, the fair value gap above the block is still open and the news calendar is clear until the New York open.",
  "Partial at 2R, then trail under the next M5 swing low.",
  "Invalidation: a second touch of the order block before entry, or an M5 close through the sweep extreme.",
].join(" ");

/** A deterministic random-looking (hex) v4 UUID, as the database generates them. */
function hexId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** An ISO instant as PostgREST returns timestamptz values. */
const postgres = (at: string) => at.replace(/(?:\.\d+)?Z$/, "+00:00");

/**
 * The densest realistic sources the periodic bounds must admit: `count` trades with `records` journal entries and events
 * in all, database-shaped (random hex UUIDs, PostgREST timestamps, numerics at the precision `journal_analytics`
 * returns), every thesis longer than its bound and closing with its invalidation, every journal text and note at 5,000
 * characters, partial closes with full-precision details and entries stored before entry but recorded after it.
 * Synthetic zero-padded ids and short timestamps tokenize far more cheaply and would understate a real request.
 */
export function maximalPeriodicSources(count: number, records: number, start: string, stepMinutes = 60): PeriodicTradeSource[] {
  const perTrade = Math.max(0, Math.ceil((records - count) / count));
  const sources = periodicSourcesV2(count, { start, stepMinutes, journal: perTrade, body: MAXIMAL_TEXT });
  let excess = sources.reduce((n, s) => n + s.events.length + s.journal.length, 0) - records;
  for (const source of [...sources].reverse()) while (excess > 0 && source.journal.length) { source.journal.pop(); excess--; }
  for (const source of [...sources].reverse()) while (excess > 0 && source.events.length) { source.events.pop(); excess--; }
  const id = (value: string) => hexId(`maximal:${value}`);
  return sources.map((source, i) => {
    const planId = id(source.plan.id);
    const entered = source.trade.entered_at ?? start;
    return {
      ...source,
      plan: { ...source.plan, id: planId, locked_at: postgres(source.plan.locked_at), proposal: { ...source.plan.proposal, narrative: LONG_THESIS } },
      trade: {
        ...source.trade, id: planId, locked_at: postgres(source.trade.locked_at), entered_at: postgres(entered), exited_at: source.trade.exited_at && postgres(source.trade.exited_at),
        entry_price: "1.16258", quantity: "4.25000000", planned_quantity: "4.25", exit_price: "1.16649", fees: "25.50",
        net_pnl: `${1636 + i}.25000000000000000000000000000000`, realized_r: `3.0${i % 10}555555555555555555555555555556`,
      },
      tradeRecordId: id(source.tradeRecordId),
      entryRecordedAt: source.entryRecordedAt && postgres(source.entryRecordedAt),
      closeRecordedAt: source.closeRecordedAt && postgres(source.closeRecordedAt),
      events: source.events.map(event => ({ ...event, id: id(event.id), payload: { note: MAXIMAL_TEXT }, occurred_at: postgres(event.occurred_at), recorded_at: postgres(event.recorded_at) })),
      journal: source.journal.map((entry, j) => ({
        ...entry, id: id(entry.id),
        ...(j % 3 === 1 ? { kind: "PARTIAL_CLOSE" as const, details: { price: "1.10123456", quantity: "0.12345678" } } : {}),
        ...(j % 3 === 0 ? { phase: "PRE_ENTRY" as const, recordedAt: postgres(minutes(entered, 1)) } : { recordedAt: postgres(entry.recordedAt) }),
      })),
      tags: source.tags && { ...source.tags, tags: ["london", "liquidity-sweep", "a-plus"], recordedAt: source.tags.recordedAt && postgres(source.tags.recordedAt) },
    };
  });
}

/** Database rows of the sources (and of their V1 lock/entry/close events) for the query double. */
export function periodicTables(sources: readonly PeriodicTradeSource[], accountId = ids.account, userId = ids.user) {
  const owned = { account_id: accountId, user_id: userId };
  return {
    accounts: [{ id: accountId, name: "Synthetic", currency: "USD", user_id: userId }],
    journal_analytics: sources.map(source => ({ ...source.trade, account_id: accountId })),
    trade_plans: sources.map(source => ({ ...source.plan, ...owned })),
    strategy_versions: [{ ...sources[0]?.strategy, ...owned }].filter(row => row.id),
    risk_plan_versions: [{ ...sources[0]?.risk, ...owned }].filter(row => row.id),
    trade_events: sources.flatMap((source, i) => [
      { id: eventId(i, 0), plan_id: source.plan.id, event_type: "PLAN_LOCKED", payload: {}, occurred_at: source.plan.locked_at, recorded_at: source.plan.locked_at, sequence: i * 10, ...owned },
      { id: eventId(i, 1), plan_id: source.plan.id, event_type: "TRADE_OPENED", payload: { entry_price: "1.1" }, occurred_at: source.trade.entered_at, recorded_at: source.entryRecordedAt, sequence: i * 10 + 1, ...owned },
      ...source.events.map((event, k) => ({ ...event, plan_id: source.plan.id, sequence: i * 10 + 2 + k, ...owned })),
      { id: eventId(i, 2), plan_id: source.plan.id, event_type: "TRADE_CLOSED", payload: { exit_price: "1.106" }, occurred_at: source.trade.exited_at, recorded_at: source.closeRecordedAt, sequence: i * 10 + 9, ...owned },
    ]),
    trade_ledger: sources.map(source => ({ id: source.tradeRecordId, plan_id: source.plan.id, entry_recorded_at: source.entryRecordedAt, close_recorded_at: source.closeRecordedAt, account_id: accountId })),
    trade_journal_entries: sources.flatMap(source => source.journal.map(entry => ({
      id: entry.id, trade_id: source.tradeRecordId, kind: entry.kind, body: entry.body, details: entry.details, phase: entry.phase, recorded_at: entry.recordedAt, ...owned,
    }))),
    trade_tag_sets: sources.flatMap((source, i) => source.tags ? [{
      id: 1000 + i, trade_id: source.tradeRecordId, setup_grade: source.tags.setupGrade, liquidity_context: source.tags.liquidityContext,
      mss_timeframe: source.tags.mssTimeframe, tags: [...source.tags.tags], recorded_at: source.tags.recordedAt, ...owned,
    }] : []),
  };
}
