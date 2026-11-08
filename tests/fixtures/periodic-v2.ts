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
 * A server-recorded instant as PostgREST returns it: `clock_timestamp()` carries microseconds. The seconds and fraction
 * are made up within the instant's minute (`seed` varies them), so the instant never moves to another minute.
 */
const micro = (at: string, seed: number) => `${at.slice(0, 17)}${String(10 + ((seed * 7) % 40)).padStart(2, "0")}.${String(400_001 + seed * 98_765).slice(-6)}+00:00`;

/** The structured rules of the default strategy (ICT V1.0, migration 0002), as a real snapshot carries them. */
export const ICT_RULES: Record<string, unknown> = {
  schema_version: 1, version: "ICT V1.0", utc_offset_minutes: -300, execution_models: ["OB_FIRST_TOUCH", "OTE"], minimum_rr: "3",
  context: ["Daily bias", "H4 context", "H1 context", "H4/H1 Fair Value Gaps", "Asian Range Liquidity", "Judas manipulation", "PDH", "PDL", "PWH", "PWL", "Kill Zone highs/lows", "internal liquidity", "external liquidity", "equal highs/lows", "previous-day 50%", "market structure", "displacement"],
  context_timeframes: ["D1", "H4", "H1"], execution_timeframes: ["M15", "M5", "M3"],
  sessions: { ACTIVE_KILL_ZONE: ["02:00", "12:00"], DEAD_POOL: ["12:00", "18:00"], ASIA: ["18:00", "01:00"], JUDAS: ["01:00", "02:00"] },
  rules: {
    OB_FIRST_TOUCH: "M5 Order Block first-touch mitigation after meaningful MSS/displacement. Bullish: bearish reversal candle that caused displacement, open/body down through lower unmitigated wick. Bearish: mirror using bullish reversal candle, open/body up through upper unmitigated wick. Exclude opposite/mitigated wick when appropriate. Entry is FIRST touch/mitigation of proximal edge. No additional confirmation inside OB or after valid first mitigation is required.",
    OTE: "Valid separate entry model, not strategy drift. Allowed when displacement leg is extended, OB too distant, OB inefficient, or OTE provides a better predefined execution location. Fibonacci thresholds and anchor conventions are not specified in this version.",
    MSS: "Evaluate meaningful broken structure, displacement quality, candle expansion, contextual importance of broken swing, preceding liquidity, and significance. A trivial crossed line is insufficient. Preserve ambiguity.",
    LIQUIDITY: "Record liquidity_swept, liquidity_target, liquidity_type, internal_or_external. ARL high/low, PDH/PDL, PWH/PWL, Kill Zone highs/lows, equal highs/lows, internal/external liquidity and prior major swing points. Equal highs/lows are not automatically a final external target.",
    TARGET: "Target must make contextual sense. ARL extremes, PDH/PDL, PWH/PWL, Kill Zone extremes, external liquidity, previous-day 50%, relevant structural liquidity.",
    SESSION: "Fixed UTC−5. Dead Pool normally blocks new discretionary trades. Judas is manipulation/fake-move window between Asia and London. Browser timezone never governs strategy sessions.",
    EVIDENCE: "Observed, user-reported and inferred evidence remain separate. Missing stays missing, uncertainty stays uncertain. Never invent levels, news or win probabilities.",
    PROCESS: "Written strategy is the source of truth. P&L never overrides process. AI cannot silently change definitions, risk or strategy versions.",
  },
  ote_parameters: null, grade_policy: null,
};

/**
 * The densest realistic sources the periodic bounds must admit: `count` trades with `records` journal entries and events
 * in all, database-shaped (random hex UUIDs, PostgREST timestamps with the microseconds of server-recorded times,
 * numerics at the precision `journal_analytics` returns), every thesis longer than its bound and closing with its
 * invalidation, every journal text and note at 5,000 characters, partial closes with full-precision details and
 * entries stored before entry but recorded after it. The trades alternate between two strategy versions with the full
 * ICT rules and two risk versions, so the snapshot defines four versions and every trade names its own. Synthetic
 * zero-padded ids, short timestamps and a single version would understate a real request.
 */
export function maximalPeriodicSources(count: number, records: number, start: string, stepMinutes = 60): PeriodicTradeSource[] {
  const perTrade = Math.max(0, Math.ceil((records - count) / count));
  const sources = periodicSourcesV2(count, { start, stepMinutes, journal: perTrade, body: MAXIMAL_TEXT });
  let excess = sources.reduce((n, s) => n + s.events.length + s.journal.length, 0) - records;
  for (const source of [...sources].reverse()) while (excess > 0 && source.journal.length) { source.journal.pop(); excess--; }
  for (const source of [...sources].reverse()) while (excess > 0 && source.events.length) { source.events.pop(); excess--; }
  const id = (value: string) => hexId(`maximal:${value}`);
  const strategies = [0, 1].map(k => ({ id: id(`strategy:${k}`), version: `ICT V1.${k}`, rules: { ...ICT_RULES, version: `ICT V1.${k}` } }));
  const risks = [0, 1].map(k => ({ id: id(`risk:${k}`), version: `Risk Plan V1.${k}`, daily_risk_cap: "2500.00", daily_loss_cap: "5000.00" }));
  return sources.map((source, i) => {
    const planId = id(source.plan.id);
    const entered = source.trade.entered_at ?? start;
    const strategy = strategies[i % 2];
    const risk = { ...source.risk, ...risks[i % 2] };
    const versions = { strategy_version_id: strategy.id, risk_plan_version_id: risk.id };
    return {
      ...source,
      strategy,
      risk,
      plan: { ...source.plan, ...versions, id: planId, locked_at: micro(source.plan.locked_at, i), proposal: { ...source.plan.proposal, narrative: LONG_THESIS } },
      trade: {
        ...source.trade, ...versions, strategy_version: strategy.version, risk_plan_version: risk.version,
        id: planId, locked_at: micro(source.trade.locked_at, i), entered_at: postgres(entered), exited_at: source.trade.exited_at && postgres(source.trade.exited_at),
        entry_price: "1.16258", quantity: "4.25000000", planned_quantity: "4.25", exit_price: "1.16649", fees: "25.50",
        net_pnl: `${1636 + i}.25000000000000000000000000000000`, realized_r: `3.0${i % 10}555555555555555555555555555556`,
      },
      tradeRecordId: id(source.tradeRecordId),
      entryRecordedAt: source.entryRecordedAt && postgres(source.entryRecordedAt),
      closeRecordedAt: source.closeRecordedAt && postgres(source.closeRecordedAt),
      events: source.events.map(event => ({ ...event, id: id(event.id), payload: { note: MAXIMAL_TEXT }, occurred_at: postgres(event.occurred_at), recorded_at: micro(event.recorded_at, i) })),
      journal: source.journal.map((entry, j) => ({
        ...entry, id: id(entry.id),
        ...(j % 3 === 1 ? { kind: "PARTIAL_CLOSE" as const, details: { price: "1.10123456", quantity: "0.12345678" } } : {}),
        ...(j % 3 === 0 ? { phase: "PRE_ENTRY" as const, recordedAt: micro(minutes(entered, 1), j) } : { recordedAt: micro(entry.recordedAt, j) }),
      })),
      tags: source.tags && { ...source.tags, tags: ["london", "liquidity-sweep", "a-plus"], recordedAt: source.tags.recordedAt && micro(source.tags.recordedAt, i) },
    };
  });
}

/** A thesis of typical length (within the narrative bound) that closes with its invalidation, as the seeded traders write them. */
export const TYPICAL_THESIS = "London swept the equal lows, then an M5 MSS with clear displacement left a bullish order block. Entry 1.16258 on the first touch of the proximal edge, stop 1.16132 beyond the sweep, target 1.16649 at the Asian range high. EURUSD H1 is bullish and the FVG above the OB is still open. Invalidation: a second touch of the OB before entry or an M5 close through the sweep extreme.";
/** Journal entries of typical length (55–110 characters) in every timing band, as the seeded traders write them. */
const TYPICAL_ENTRIES: readonly Pick<PeriodicJournalEntry, "kind" | "phase" | "body" | "details">[] = [
  { kind: "DECISION", phase: "PRE_ENTRY", body: "Price is a few ticks from the OB — not chasing. Limit sits at the proximal edge.", details: {} },
  { kind: "NOTE", phase: "LIVE", body: "Clean displacement away from the OB. Holding to the PDH.", details: {} },
  { kind: "STOP_CHANGE", phase: "LIVE", body: "Stop to break-even after the M5 break of structure.", details: { price: "1.16258" } },
  { kind: "TARGET_CHANGE", phase: "LIVE", body: "Keeping the original target — no new information, just noting the urge to extend.", details: { price: "1.16649" } },
  { kind: "LESSON", phase: "POST_TRADE", body: "Exited before the target because momentum stalled under the H1 FVG. Note the reason before closing next time.", details: {} },
];

/**
 * Typically journaled closed planned trades, database-shaped like the seeded traders' (random hex UUIDs, PostgREST
 * timestamps, some recorded to the microsecond, numerics at the precision `journal_analytics` returns): `records` V2
 * journal entries spread evenly over `count` trades, a thesis of typical length, V2 tags and no V1 events.
 */
export function typicalPeriodicSources(count: number, records: number, start: string, stepMinutes = 600): PeriodicTradeSource[] {
  const id = (value: string) => hexId(`typical:${value}`);
  return periodicSourcesV2(count, { start, stepMinutes, journal: 0 }).map((source, i) => {
    const entered = source.trade.entered_at ?? start;
    const exited = source.trade.exited_at ?? start;
    const planId = id(source.plan.id);
    const entries = Math.floor(records / count) + (i < records % count ? 1 : 0);
    return {
      ...source,
      plan: { ...source.plan, id: planId, locked_at: postgres(source.plan.locked_at), proposal: { ...source.plan.proposal, narrative: TYPICAL_THESIS } },
      trade: {
        ...source.trade, id: planId, locked_at: postgres(source.trade.locked_at), entered_at: postgres(entered), exited_at: postgres(exited),
        entry_price: "1.16258", quantity: "4.25000000", planned_quantity: "4.25", exit_price: "1.16649", fees: "25.50",
        net_pnl: `${1636 + i}.25000000000000000000000000000000`, realized_r: `3.0${i % 10}555555555555555555555555555556`,
      },
      tradeRecordId: id(source.tradeRecordId),
      entryRecordedAt: source.entryRecordedAt && postgres(source.entryRecordedAt),
      closeRecordedAt: source.closeRecordedAt && postgres(source.closeRecordedAt),
      events: [],
      journal: Array.from({ length: entries }, (_, j): PeriodicJournalEntry => {
        const typical = TYPICAL_ENTRIES[(i + j) % TYPICAL_ENTRIES.length];
        const recordedAt = typical.phase === "PRE_ENTRY" ? postgres(minutes(entered, -2 - j))
          : typical.phase === "LIVE" ? postgres(minutes(entered, 3 + 4 * j))
          : `${minutes(exited, 20 + j).slice(0, 19)}.927844+00:00`;
        return { id: id(`${source.tradeRecordId}:journal:${j}`), ...typical, recordedAt };
      }),
      tags: { setupGrade: "A+", liquidityContext: "ARL_LOW", mssTimeframe: "M5", tags: ["london", "sweep", "a-setup"], source: "V2", recordedAt: postgres(minutes(exited, 2)) },
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
    strategy_versions: [...new Map(sources.map(source => [source.strategy.id, { ...source.strategy, ...owned }])).values()],
    risk_plan_versions: [...new Map(sources.map(source => [source.risk.id, { ...source.risk, ...owned }])).values()],
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
