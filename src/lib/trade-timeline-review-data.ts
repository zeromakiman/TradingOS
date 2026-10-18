import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";
import { accountAiAvailability } from "./ai-budget";
import {
  type AiHistoryRow, aiCostEstimate, aiRequestRow, historyRow, loadAccounting, loadResults, type ResolvedAiCard, resolvedCard,
} from "./ai-history";
import type { AiAvailability } from "@/ai/availability";
import { operationFor } from "@/ai/operations";
import { type AiEvidence, loadTradeEvidence } from "@/ai/trade-evidence";
import {
  isClosedTrade, type TimelineReviewCheck, type TimelineReviewInput, type TimelineReviewPositionFacts, V1_EVENT_TYPES,
} from "@/ai/trade-timeline-review-context";
import { type TradeTimelineReviewResult, tradeTimelineReviewOutput } from "@/ai/trade-timeline-review-contract";
import { type PlanStatus, TIMELINE_REVIEW_LIMITS } from "@/ai/trade-timeline-review-sources";
import type { AiCostEstimate, EvidenceIndex } from "@/domain/ai-summary";
import { LEDGER_COLUMNS, type LedgerTrade, ledgerRow } from "@/domain/ledger";
import { compareInstants } from "@/domain/time-display";
import { classifyTiming, inferStoredPhase, type Timing } from "@/domain/timeline";

/**
 * Owner-scoped data for the timeline-aware trade review (spec §11.4): the closed trade, every record its facts are
 * built from, the evidence that may be selected, and the review history parsed by each request's stored contract.
 */

const OPERATION = "REVIEW_TRADE_TIMELINE";
const PAGE_SIZE = 10;
/** Raw rows read per timeline source; more than this cannot fit a review, so it is reported, never truncated. */
const SOURCE_ROW_LIMIT = 200;

/** The trade has more records of one kind than a review can include; nothing was written or sent. */
export class TimelineSourceLimitError extends Error {}

/** The caller's trade from the ledger, read with the user's session and an explicit owner filter. */
export async function ownedTimelineTrade(tradeId: string) {
  const { db, user } = await requireUser();
  const id = z.uuid().parse(tradeId);
  const owned = await db.from("trades").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (owned.error || !owned.data) throw new Error("Trade unavailable");
  const ledger = await db.from("trade_ledger").select(LEDGER_COLUMNS.join(",")).eq("id", id).maybeSingle();
  if (ledger.error || !ledger.data) throw new Error("Trade unavailable");
  return { db, user, trade: ledgerRow.parse(ledger.data) };
}
export type OwnedTimelineTrade = Awaited<ReturnType<typeof ownedTimelineTrade>>;

const numeric = z.string().nullable();
const record = z.record(z.string(), z.unknown());
const revisionRow = z.object({ proposal_id: z.uuid(), revision: z.number().int().positive(), created_at: z.string() });
const proposalRow = z.object({ id: z.uuid(), proposal: record });
const planRow = z.object({ id: z.uuid(), proposal: record, risk_result: z.unknown(), nominal_risk: z.string(), locked_at: z.string(), trading_day: z.string() });
const strategyRow = z.object({ id: z.uuid(), version: z.string(), rules: record, created_at: z.string() });
const riskVersionRow = z.object({
  id: z.uuid(), version: z.string(), effective_day: z.string(), max_risk_percent: z.string(), default_risk_percent: numeric, max_daily_trades: z.number(),
  min_rr: z.string(), rr_policy: z.string(), news_policy: z.string(), daily_risk_cap: numeric, daily_loss_cap: numeric,
});
const checkRow = z.object({ id: z.number(), proposal_id: z.uuid(), risk: z.object({ id: z.uuid(), result: z.unknown(), recorded_at: z.string() }) });
const eventRow = z.object({ id: z.uuid(), event_type: z.enum(V1_EVENT_TYPES), payload: record, occurred_at: z.string(), recorded_at: z.string() });
const journalRow = z.object({
  id: z.uuid(), kind: z.enum(["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"]), body: z.string().nullable(),
  details: record, phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), recorded_at: z.string(),
});
const factsRow = z.object({
  id: z.uuid(), recorded_at: z.string(), source: z.enum(["USER", "IMPORT"]), symbol: z.string().nullable(), direction: z.string().nullable(),
  entry_model: z.string().nullable(), entry_price: numeric, entered_at: z.string().nullable(), quantity: numeric, initial_stop: numeric, risk_amount: numeric,
});

function rows<T>(schema: z.ZodType<T>, result: { data: unknown; error: unknown }, what: string): T[] {
  if (result.error) throw new Error(`${what} unavailable`);
  const parsed = z.array(schema).parse(result.data ?? []);
  if (parsed.length > SOURCE_ROW_LIMIT) throw new TimelineSourceLimitError(`This trade has more ${what.toLowerCase()} than a review can include. Nothing was sent.`);
  return parsed;
}

/** The latest risk evaluation of each revision (by check order) and the number of checks the revision received. */
function latestChecks(checks: readonly z.infer<typeof checkRow>[]): TimelineReviewCheck[] {
  const byProposal = new Map<string, { latest: z.infer<typeof checkRow>; count: number }>();
  for (const check of checks) {
    const seen = byProposal.get(check.proposal_id);
    byProposal.set(check.proposal_id, { latest: !seen || check.id > seen.latest.id ? check : seen.latest, count: (seen?.count ?? 0) + 1 });
  }
  return [...byProposal.values()].map(({ latest, count }) => ({
    id: latest.risk.id, proposalId: latest.proposal_id, recordedAt: latest.risk.recorded_at, result: latest.risk.result, checks: count,
  }));
}

/** Planned trades use the strategy version of their plan; others the account's version in force when they were recorded. */
function pickStrategy(strategies: readonly z.infer<typeof strategyRow>[], trade: LedgerTrade): z.infer<typeof strategyRow> {
  if (trade.strategy_version_id) {
    const recorded = strategies.find(row => row.id === trade.strategy_version_id);
    if (!recorded) throw new Error("Strategy version unavailable");
    return recorded;
  }
  if (trade.origin === "PLANNED") throw new Error("Strategy version unavailable");
  const inForce = strategies.filter(row => compareInstants(row.created_at, trade.created_at) <= 0).at(-1) ?? strategies[0];
  if (!inForce) throw new Error("Strategy version unavailable");
  return inForce;
}

export interface TimelineReviewSource {
  input: Omit<TimelineReviewInput, "evidence">;
  /** Evidence that may be selected: active V2 evidence of the trade and active legacy screenshots of its revisions. */
  evidence: AiEvidence[];
}

/** Loads every record the review facts are built from, with the user's session (RLS) and explicit owner filters. */
export async function loadTimelineReviewSource(owned: OwnedTimelineTrade): Promise<TimelineReviewSource> {
  const { db, user, trade } = owned;
  const planned = trade.origin === "PLANNED";
  const limit = SOURCE_ROW_LIMIT + 1;
  const empty = { data: [], error: null };
  const none = { data: null, error: null };
  const [revisions, plan, strategies, risk, events, journal, positions, close, tagSet] = await Promise.all([
    db.from("trade_revisions").select("proposal_id,revision,created_at").eq("trade_id", trade.id).eq("user_id", user.id).order("revision").limit(limit),
    trade.plan_id
      ? db.from("trade_plans").select("id,proposal,risk_result,nominal_risk::text,locked_at,trading_day").eq("id", trade.plan_id).eq("user_id", user.id).maybeSingle()
      : none,
    db.from("strategy_versions").select("id,version,rules,created_at").eq("account_id", trade.account_id).eq("user_id", user.id).order("created_at").order("id"),
    trade.plan_id && trade.risk_plan_version_id
      ? db.from("risk_plan_versions")
        .select("id,version,effective_day,max_risk_percent::text,default_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text")
        .eq("id", trade.risk_plan_version_id).eq("user_id", user.id).maybeSingle()
      : none,
    trade.plan_id
      ? db.from("trade_events").select("id,event_type,payload,occurred_at,recorded_at").eq("plan_id", trade.plan_id).eq("user_id", user.id).order("sequence").limit(limit)
      : empty,
    db.from("trade_journal_entries").select("id,kind,body,details,phase,recorded_at").eq("trade_id", trade.id).eq("user_id", user.id).order("recorded_at").order("id").limit(limit),
    planned
      ? empty
      : db.from("trade_position_facts").select("id,recorded_at,source,symbol,direction,entry_model,entry_price::text,entered_at,quantity::text,initial_stop::text,risk_amount::text")
        .eq("trade_id", trade.id).eq("user_id", user.id).order("recorded_at").order("id").limit(limit),
    planned ? none : db.from("trade_unplanned_closes").select("risk_basis_source").eq("trade_id", trade.id).eq("user_id", user.id).maybeSingle(),
    trade.tag_source === "V2"
      ? db.from("trade_tag_sets").select("recorded_at").eq("trade_id", trade.id).eq("user_id", user.id).order("id", { ascending: false }).limit(1).maybeSingle()
      : trade.tag_source === "V1" && trade.plan_id
        ? db.from("trade_tag_revisions").select("recorded_at").eq("plan_id", trade.plan_id).eq("user_id", user.id).order("id", { ascending: false }).limit(1).maybeSingle()
        : none,
  ]);
  if (plan.error || strategies.error || risk.error || close.error || tagSet.error) throw new Error("Trade records unavailable");
  const revisionRows = rows(revisionRow, revisions, "Draft revisions");
  const proposalIds = revisionRows.map(row => row.proposal_id);
  const [proposals, checks, evidence] = await Promise.all([
    proposalIds.length ? db.from("setup_proposals").select("id,proposal").in("id", proposalIds).eq("user_id", user.id) : empty,
    proposalIds.length
      ? db.from("setup_risk_checks").select("id,proposal_id,risk:risk_evaluations(id,result,recorded_at)").in("proposal_id", proposalIds).eq("user_id", user.id).order("id").limit(limit)
      : empty,
    loadTradeEvidence(db, { userId: user.id, tradeId: trade.id, proposalIds }),
  ]);
  const proposalOf = new Map(rows(proposalRow, proposals, "Draft revisions").map(row => [row.id, row.proposal] as const));
  const lockedPlan = plan.data ? planRow.parse(plan.data) : null;
  if (planned && trade.plan_id && !lockedPlan) throw new Error("Locked plan unavailable");
  const strategy = pickStrategy(z.array(strategyRow).parse(strategies.data), trade);
  const positionFacts: TimelineReviewPositionFacts[] = rows(factsRow, positions, "Entry details").map(row => ({
    id: row.id, recordedAt: row.recorded_at, source: row.source, symbol: row.symbol, direction: row.direction, entryModel: row.entry_model,
    entryPrice: row.entry_price, enteredAt: row.entered_at, quantity: row.quantity, initialStop: row.initial_stop, riskAmount: row.risk_amount,
  }));
  const basis = close.data ? z.object({ risk_basis_source: z.enum(["USER_REPORTED", "DERIVED"]).nullable() }).parse(close.data).risk_basis_source : null;
  const tagRecordedAt = tagSet.data ? z.object({ recorded_at: z.string() }).parse(tagSet.data).recorded_at : null;
  return {
    input: {
      trade,
      plan: lockedPlan
        ? { id: lockedPlan.id, lockedAt: lockedPlan.locked_at, tradingDay: lockedPlan.trading_day, proposal: lockedPlan.proposal, nominalRisk: lockedPlan.nominal_risk, riskResult: lockedPlan.risk_result }
        : null,
      strategy: { id: strategy.id, version: strategy.version, rules: strategy.rules },
      riskVersion: risk.data ? riskVersionRow.parse(risk.data) : null,
      revisions: revisionRows.map(row => ({ proposalId: row.proposal_id, revision: row.revision, createdAt: row.created_at, proposal: proposalOf.get(row.proposal_id) ?? null })),
      riskChecks: latestChecks(rows(checkRow, checks, "Risk checks")),
      legacyEvents: rows(eventRow, events, "Trade events").map(row => ({ id: row.id, eventType: row.event_type, payload: row.payload, occurredAt: row.occurred_at, recordedAt: row.recorded_at })),
      journal: rows(journalRow, journal, "Journal entries").map(row => ({ id: row.id, kind: row.kind, body: row.body, details: row.details, phase: row.phase, recordedAt: row.recorded_at })),
      positionFacts,
      riskBasisSource: basis,
      tags: { setupGrade: trade.setup_grade, liquidityContext: trade.liquidity_context, mssTimeframe: trade.mss_timeframe, tags: trade.tags, source: trade.tag_source, recordedAt: tagRecordedAt },
    },
    evidence,
  };
}

/** Timing band of a piece of evidence relative to this trade (spec §5.3). */
export function evidenceTiming(trade: LedgerTrade, evidence: Pick<AiEvidence, "recordedAt" | "storedPhase">): Timing {
  const entryRecordedAt = trade.entry_recorded_at ?? (trade.origin === "PLANNED" ? null : trade.created_at);
  return classifyTiming({
    recordedAt: evidence.recordedAt,
    storedPhase: evidence.storedPhase ?? inferStoredPhase(evidence.recordedAt, entryRecordedAt, trade.close_recorded_at),
    origin: trade.origin, entryAt: trade.entered_at, entryRecordedAt, exitAt: trade.exited_at, tradeCreatedAt: trade.created_at,
  }).timing;
}

export interface TimelineEvidenceOption {
  id: string;
  source: AiEvidence["source"];
  label: AiEvidence["label"];
  timeframe: string | null;
  caption: string | null;
  timing: Timing;
  recordedAt: string;
}

export function timelineEvidenceOption(trade: LedgerTrade, item: AiEvidence): TimelineEvidenceOption {
  return { id: item.id, source: item.source, label: item.label, timeframe: item.timeframe, caption: item.caption, timing: evidenceTiming(trade, item), recordedAt: item.recordedAt };
}

export interface TimelineReviewHistoryEntry extends AiHistoryRow {
  /** Parsed REVIEW_TRADE_TIMELINE_V1 output of a completed row. */
  review: TradeTimelineReviewResult | null;
  /** Concise card with friendly source chips (completed rows only). */
  card: ResolvedAiCard | null;
}

export interface TradeTimelineReviewPanel {
  closed: boolean;
  origin: LedgerTrade["origin"];
  planStatus: PlanStatus;
  availability: AiAvailability;
  /** Typical and maximum cost; null while AI pricing is unavailable. */
  estimate: AiCostEstimate | null;
  maxEvidence: number;
  evidence: TimelineEvidenceOption[];
  history: TimelineReviewHistoryEntry[];
  page: number;
  hasOlder: boolean;
  error: string | null;
}

/** Parses one stored review by its contract version; anything unreadable degrades to a failed-style row. */
export function timelineHistoryEntry(row: AiHistoryRow, interpretation: unknown, facts: unknown, evidenceIndex: EvidenceIndex): TimelineReviewHistoryEntry {
  const review = row.status === "COMPLETED" && row.technical.contract === "REVIEW_TRADE_TIMELINE_V1" ? tradeTimelineReviewOutput.safeParse(interpretation) : null;
  return { ...row, review: review?.success ? review.data : null, card: resolvedCard(row, interpretation, facts, evidenceIndex) };
}

const reviewRow = aiRequestRow.extend({ facts: record });

/** Availability, selectable evidence and paginated history (10 per page). Page loads never reach the provider. */
export async function loadTradeTimelineReviewPanel(tradeId: string, page = 0): Promise<TradeTimelineReviewPanel> {
  const { db, user, trade } = await ownedTimelineTrade(tradeId);
  const operation = operationFor(OPERATION);
  const safePage = Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 10_000) : 0;
  const base = {
    closed: isClosedTrade(trade), origin: trade.origin, planStatus: (trade.plan_id ? "LOCKED_PLAN" : "NO_PLAN_RECORDED") as PlanStatus,
    maxEvidence: Math.min(operation.maxImages, TIMELINE_REVIEW_LIMITS.evidence), page: safePage,
  };
  try {
    const availability = await accountAiAvailability(trade.account_id, OPERATION);
    const proposals = await db.from("trade_revisions").select("proposal_id").eq("trade_id", trade.id).eq("user_id", user.id);
    if (proposals.error) throw new Error("Evidence unavailable");
    const proposalIds = z.array(z.object({ proposal_id: z.uuid() })).parse(proposals.data).map(row => row.proposal_id);
    const evidence = await loadTradeEvidence(db, { userId: user.id, tradeId: trade.id, proposalIds });
    const q = await db.from("trade_timeline_reviews").select("id,facts,operation,created_at,deadline_at", { count: "exact" })
      .eq("trade_id", trade.id).eq("user_id", user.id).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE - 1);
    if (q.error) throw new Error("Review history unavailable");
    const requests = z.array(reviewRow).parse(q.data);
    const [results, accounting] = await Promise.all([
      loadResults(db, "trade_timeline_review_results", "review_id", requests),
      loadAccounting(db, user.id, requests.map(row => row.id)),
    ]);
    const evidenceIndex: EvidenceIndex = Object.fromEntries(evidence.map(item => [item.id, { label: item.label, timeframe: item.timeframe }]));
    const history = requests.map(request => {
      const result = results.get(request.id) ?? null;
      return timelineHistoryEntry(historyRow(OPERATION, request, result, accounting), result?.interpretation, request.facts, evidenceIndex);
    });
    return {
      ...base, availability, estimate: aiCostEstimate(OPERATION), history, hasOlder: (q.count ?? 0) > (safePage + 1) * PAGE_SIZE, error: null,
      evidence: evidence.map(item => timelineEvidenceOption(trade, item)),
    };
  } catch {
    return {
      ...base, estimate: null, evidence: [], history: [], hasOlder: false,
      availability: { status: "CONFIGURATION_ERROR", message: "Trade review is unavailable. Other trade workflows remain available.", deepEnabled: false },
      error: "Unable to load AI review history or configuration. Trade records are unaffected.",
    };
  }
}

