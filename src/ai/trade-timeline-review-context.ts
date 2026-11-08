import type { LedgerTrade } from "@/domain/ledger";
import { storedRiskSchema } from "@/domain/risk-report";
import { compareInstants } from "@/domain/time-display";
import {
  classifyTiming, type EvidenceLabel, inferStoredPhase, type JournalKind, type StoredPhase, type Timing, type TimingFlag, type TimingResult,
} from "@/domain/timeline";
import { operationFor } from "./operations";
import { estimateRequest } from "./request-estimate";
import {
  maxTimelineFactsBytes, type PlanStatus, TIMELINE_REVIEW_FACTS_VERSION, TIMELINE_REVIEW_LIMITS, withTimelineSources,
} from "./trade-timeline-review-sources";

/** A screenshot whose size is not read here counts at the maximum tile cost (src/ai/request-estimate.ts). */
const UNSIZED_IMAGE = "data:image/png;base64,AA==";

/**
 * REVIEW_TRADE_TIMELINE_FACTS_V1 (spec §11.4): an explicit allowlist of one closed trade's records, V1 decisions
 * included. Every timeline item and screenshot carries the timing from `classifyTiming` (spec §5.3), so after-close text
 * can never pose as pre-entry evidence; only the lock and the evaluation that authorised it are Before entry by
 * definition. No written strategy prompt, account history, balances, storage paths or earlier AI output.
 */

export type TimelineReviewTrade = Pick<LedgerTrade,
  | "id" | "account_id" | "origin" | "created_at" | "currency" | "lifecycle" | "plan_id" | "symbol" | "direction" | "entry_model"
  | "planned_quantity" | "planned_rr" | "entry_price" | "entered_at" | "entry_recorded_at" | "quantity" | "oversize"
  | "exit_price" | "exited_at" | "close_recorded_at" | "fees" | "net_pnl" | "realized_r" | "outcome" | "pnl_source">;

/** The locked plan (`trade_plans`); numerics are exact text. */
export interface TimelineReviewPlan {
  id: string;
  lockedAt: string;
  tradingDay: string;
  proposal: Record<string, unknown>;
  nominalRisk: string;
  riskResult: unknown;
  /**
   * The risk evaluation that authorised the lock (`trade_plans.risk_evaluation_id`). Written by the lock transaction a few
   * milliseconds after `lockedAt`, it is part of the lock: Before entry, placed right before it.
   */
  riskEvaluationId?: string | null;
}

export interface TimelineReviewStrategy { id: string; version: string; rules: Record<string, unknown> }

export interface TimelineReviewRiskVersion {
  id: string; version: string; effective_day: string; max_risk_percent: string; default_risk_percent: string | null;
  max_daily_trades: number; min_rr: string; rr_policy: string; news_policy: string; daily_risk_cap: string | null; daily_loss_cap: string | null;
}

/** A draft revision with its saved proposal. */
export interface TimelineReviewRevision { proposalId: string; revision: number; createdAt: string; proposal: Record<string, unknown> | null }

/** The latest risk evaluation of one revision, and how many checks that revision received. */
export interface TimelineReviewCheck { id: string; proposalId: string; recordedAt: string; result: unknown; checks: number }

/** V1 `trade_events` types (0001). */
export const V1_EVENT_TYPES = [
  "PLAN_LOCKED", "NOTE_ADDED", "STOP_MOVED", "TARGET_CHANGED", "PARTIAL_CLOSED", "SL_TO_BE", "TRADE_OPENED", "TRADE_CLOSED",
  "POSITION_ADDED", "MANUAL_OVERRIDE", "PLAN_CANCELLED",
] as const;
export type V1EventType = (typeof V1_EVENT_TYPES)[number];

export interface TimelineReviewLegacyEvent { id: string; eventType: V1EventType; payload: Record<string, unknown>; occurredAt: string; recordedAt: string }

/**
 * A V1 decision on one of the trade's revisions (`setup_human_decisions`): Taken or Skipped with the trader's reason and
 * the Risk Engine decision it was recorded against. `MANUAL_OVERRIDE`: taken while the Risk Engine or the AI blocked it.
 * The AI verdict of that time is earlier AI output and never part of the facts.
 */
export interface TimelineReviewDecision {
  id: string; decision: "TAKEN" | "SKIPPED"; eventType: "HUMAN_DECISION" | "MANUAL_OVERRIDE"; reason: string | null;
  riskDecision: "APPROVED" | "BLOCKED"; recordedAt: string;
}

export interface TimelineReviewJournalEntry { id: string; kind: JournalKind; body: string | null; details: Record<string, unknown>; phase: StoredPhase; recordedAt: string }

/** One `trade_position_facts` row of a live-first or imported trade (numerics as exact text). */
export interface TimelineReviewPositionFacts {
  id: string; recordedAt: string; source: "USER" | "IMPORT"; symbol: string | null; direction: string | null; entryModel: string | null;
  entryPrice: string | null; enteredAt: string | null; quantity: string | null; initialStop: string | null; riskAmount: string | null;
}

export interface TimelineReviewTags {
  setupGrade: string | null; liquidityContext: string | null; mssTimeframe: string | null; tags: readonly string[];
  source: "V2" | "V1" | null; recordedAt: string | null;
}

/** Selected screenshot; `storedPhase` is null for legacy screenshots (classified from their upload time). */
export interface TimelineReviewEvidence {
  id: string; label: EvidenceLabel; timeframe: string | null; storedPhase: StoredPhase | null; recordedAt: string;
  sha256: string; mimeType: string; byteSize: number;
}

export type RiskBasisSource = "LOCKED_PLAN" | "USER_REPORTED" | "DERIVED";

export interface TimelineReviewInput {
  trade: TimelineReviewTrade;
  plan: TimelineReviewPlan | null;
  strategy: TimelineReviewStrategy;
  riskVersion: TimelineReviewRiskVersion | null;
  revisions: readonly TimelineReviewRevision[];
  riskChecks: readonly TimelineReviewCheck[];
  legacyEvents: readonly TimelineReviewLegacyEvent[];
  /** V1 decisions on the trade's revisions (none for trades recorded in V2). */
  legacyDecisions?: readonly TimelineReviewDecision[];
  journal: readonly TimelineReviewJournalEntry[];
  positionFacts: readonly TimelineReviewPositionFacts[];
  /** Unplanned close only: how the R denominator was established. */
  riskBasisSource: "USER_REPORTED" | "DERIVED" | null;
  tags: TimelineReviewTags;
  evidence: readonly TimelineReviewEvidence[];
}

export type TimelineFactsKind =
  | "DRAFT_REVISION" | "RISK_CHECK" | "PLAN_LOCKED" | "ENTRY" | "ENTRY_DETAILS" | "CLOSE" | JournalKind | V1EventType | TimelineReviewDecision["eventType"];

export interface TimelineFactsItem {
  sourceId: string;
  kind: TimelineFactsKind;
  timing: Timing;
  recordedAt: string;
  /** User-reported (or broker) time of the event when it differs from the server recording time; otherwise null. */
  occurredAt: string | null;
  flags: TimingFlag[];
  /** The user's own words for theses and notes; a short Trading OS description for system records. */
  text: string;
  details: Record<string, unknown>;
}

export interface TimelineFactsEvidence {
  id: string; label: EvidenceLabel; timeframe: string | null; timing: Timing; recordedAt: string; sha256: string; mimeType: string; bytes: number;
}

/** The trade is outside what one bounded review can cover; nothing was written or sent. */
export class TimelineReviewScopeError extends Error {}

const PROPOSAL_FIELDS = ["direction", "model", "entry", "stop", "target", "riskPercent", "news", "contractConfirmed", "contradiction"] as const;
const LEGACY_PAYLOAD_KEYS = ["entry", "entry_price", "quantity", "exit", "exit_price", "fees", "stop", "target", "price", "status", "realized_r", "outcome", "source"];
/** Rendered by the plan, entry and close items instead (spec §5.4). */
const RENDERED_LEGACY_EVENTS: ReadonlySet<V1EventType> = new Set(["PLAN_LOCKED", "TRADE_OPENED", "TRADE_CLOSED"]);
const TAG_KEYS = ["setup_grade", "liquidity_context", "mss_timeframe"];

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key) && value[key] !== null && value[key] !== undefined).map(key => [key, value[key]]));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function isClosedTrade(trade: Pick<LedgerTrade, "lifecycle" | "exited_at">): boolean {
  return (trade.lifecycle === "CLOSED" || trade.lifecycle === "REVIEWED") && trade.exited_at !== null;
}

/** Legacy V1 manual tag notes duplicate the tag set, which the facts carry separately. */
function isTagNote(event: TimelineReviewLegacyEvent): boolean {
  return event.eventType === "NOTE_ADDED" && event.payload.source === "MANUAL" && TAG_KEYS.some(key => key in event.payload);
}

/** What a V1 decision recorded, for a decision saved without the trader's reason. */
function decisionDescription(decision: TimelineReviewDecision): string {
  if (decision.eventType === "MANUAL_OVERRIDE") return "Recorded as taken despite a block";
  return decision.decision === "TAKEN" ? "Recorded as taken" : "Recorded as skipped";
}

interface AddOptions {
  storedPhase?: StoredPhase | null;
  timing?: TimingResult;
  orderAt?: string;
  rank?: number;
}

/** Timing of the records of the lock, which precede every entry (`add` copies the flags). */
const BEFORE_ENTRY: TimingResult = { timing: "BEFORE_ENTRY", flags: [] };

export function tradeTimelineReviewContext(input: TimelineReviewInput, capturedAt: string = new Date().toISOString()) {
  const { trade, plan } = input;
  if (!isClosedTrade(trade)) throw new Error("A timeline review needs a closed trade");
  if (trade.origin === "PLANNED" ? plan === null || plan.id !== trade.plan_id || input.riskVersion === null : plan !== null) {
    throw new Error("Trade plan facts are inconsistent with the trade origin");
  }
  if (input.evidence.length > TIMELINE_REVIEW_LIMITS.evidence) throw new TimelineReviewScopeError("Select at most four screenshots for a trade review.");
  const planStatus: PlanStatus = plan ? "LOCKED_PLAN" : "NO_PLAN_RECORDED";
  const riskBasisSource: RiskBasisSource | null = trade.origin === "PLANNED" ? "LOCKED_PLAN" : input.riskBasisSource;
  // A live-first or imported position was already open when it was first recorded (spec §5.3).
  const entryRecordedAt = trade.entry_recorded_at ?? (trade.origin === "PLANNED" ? null : trade.created_at);

  const timingOf = (recordedAt: string, storedPhase?: StoredPhase | null) => classifyTiming({
    recordedAt,
    // Records without a stored phase get the one private.trade_phase would have stored, from server times only.
    storedPhase: storedPhase ?? inferStoredPhase(recordedAt, entryRecordedAt, trade.close_recorded_at),
    origin: trade.origin,
    entryAt: trade.entered_at,
    entryRecordedAt,
    exitAt: trade.exited_at,
    tradeCreatedAt: trade.created_at,
  });
  const placed: { item: TimelineFactsItem; orderAt: string; rank: number }[] = [];
  /**
   * `storedPhase` is the record's own phase (otherwise inferred); `timing` replaces the classification of records that
   * precede the entry by definition. `orderAt` and `rank` place a record of the lock at the lock (causal order, spec
   * §5.4) without changing any time it carries; by default a record sits at its occurred, else recorded, time.
   */
  const add = (item: Omit<TimelineFactsItem, "timing" | "flags">, options: AddOptions = {}) => {
    const { timing, flags } = options.timing ?? timingOf(item.recordedAt, options.storedPhase);
    placed.push({ item: { ...item, timing, flags: [...flags] }, orderAt: options.orderAt ?? item.occurredAt ?? item.recordedAt, rank: options.rank ?? 0 });
  };

  const lockedThesis = plan ? text(plan.proposal.narrative) : null;
  for (const revision of input.revisions) {
    const thesis = revision.proposal ? text(revision.proposal.narrative) : null;
    const matchesLockedPlan = lockedThesis !== null && thesis === lockedThesis;
    add({
      sourceId: `revision:${revision.proposalId}`, kind: "DRAFT_REVISION", recordedAt: revision.createdAt, occurredAt: null,
      // The locked thesis is already in the plan facts; identical revisions refer to it instead of repeating it.
      text: matchesLockedPlan ? "Thesis identical to the locked plan." : thesis ?? "No thesis recorded in this revision.",
      details: { revision: revision.revision, thesisMatchesLockedPlan: matchesLockedPlan, ...pick(revision.proposal ?? {}, PROPOSAL_FIELDS) },
    });
  }
  for (const check of input.riskChecks) {
    const report = storedRiskSchema.safeParse(check.result);
    const blocked = report.success && report.data.status === "TRADE_BLOCKED";
    const issues = report.success ? report.data.issues : [];
    // The lock transaction stamps the lock, then writes the evaluation that authorised it a few milliseconds later. That
    // evaluation is part of the lock, which precedes any entry (an entry is never earlier than the lock): Before entry
    // like the lock, also for an entry reported at the lock instant, and placed right before it.
    const lock = plan !== null && plan.riskEvaluationId != null && check.id === plan.riskEvaluationId ? plan : null;
    add({
      sourceId: `check:${check.id}`, kind: "RISK_CHECK", recordedAt: check.recordedAt, occurredAt: null,
      text: report.success ? `Risk check of this revision: ${blocked ? "blocked" : "approved"}` : "Risk check recorded",
      details: {
        revision: input.revisions.find(revision => revision.proposalId === check.proposalId)?.revision ?? null,
        checksOfRevision: check.checks,
        decision: report.success ? (blocked ? "BLOCKED" : "APPROVED") : null,
        blocking: issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code),
        warnings: issues.filter(issue => issue.severity === "WARN").map(issue => issue.code),
      },
    }, lock ? { timing: BEFORE_ENTRY, ...(compareInstants(check.recordedAt, lock.lockedAt) >= 0 ? { orderAt: lock.lockedAt, rank: -1 } : {}) } : {});
  }
  if (plan) {
    add({ sourceId: `plan:${plan.id}`, kind: "PLAN_LOCKED", recordedAt: plan.lockedAt, occurredAt: null, text: "Plan locked", details: {} }, { timing: BEFORE_ENTRY });
  }
  if (trade.origin === "PLANNED" && entryRecordedAt !== null) {
    add({
      sourceId: `execution:${trade.id}`, kind: "ENTRY", recordedAt: entryRecordedAt, occurredAt: trade.entered_at, text: "Trade opened",
      details: pick({ entryPrice: trade.entry_price, quantity: trade.quantity, plannedQuantity: trade.planned_quantity, oversize: trade.oversize },
        ["entryPrice", "quantity", "plannedQuantity", "oversize"]),
    });
  }
  input.positionFacts.forEach((row, index) => {
    add({
      sourceId: `position:${row.id}`, kind: "ENTRY_DETAILS", recordedAt: row.recordedAt, occurredAt: index === 0 ? row.enteredAt : null,
      text: index === 0 ? "Position recorded" : "Missing entry details completed",
      details: { ...pick({ ...row }, ["source", "symbol", "direction", "entryModel", "entryPrice", "enteredAt", "quantity", "initialStop", "riskAmount"]),
        ...(row.riskAmount !== null ? { currency: trade.currency } : {}) },
    });
  });
  for (const event of input.legacyEvents) {
    if (RENDERED_LEGACY_EVENTS.has(event.eventType) || isTagNote(event)) continue;
    add({
      sourceId: `event:${event.id}`, kind: event.eventType, recordedAt: event.recordedAt,
      occurredAt: compareInstants(event.occurredAt, event.recordedAt) === 0 ? null : event.occurredAt,
      text: text(event.payload.note) ?? text(event.payload.reason) ?? "",
      details: pick(event.payload, LEGACY_PAYLOAD_KEYS),
    });
  }
  // V1 decisions are V1 records like the trade events above: their citation ids share the `event:` prefix.
  for (const decision of input.legacyDecisions ?? []) {
    add({
      sourceId: `event:${decision.id}`, kind: decision.eventType, recordedAt: decision.recordedAt, occurredAt: null,
      text: text(decision.reason) ?? decisionDescription(decision),
      details: { decision: decision.decision, riskDecision: decision.riskDecision },
    });
  }
  for (const entry of input.journal) {
    add({ sourceId: `journal:${entry.id}`, kind: entry.kind, recordedAt: entry.recordedAt, occurredAt: null, text: entry.body ?? "", details: { ...entry.details } }, { storedPhase: entry.phase });
  }
  if (trade.exited_at !== null) {
    add({
      sourceId: `close:${trade.id}`, kind: "CLOSE", recordedAt: trade.close_recorded_at ?? trade.exited_at, occurredAt: trade.exited_at, text: "Trade closed",
      details: pick({ exitPrice: trade.exit_price, outcome: trade.outcome, realizedR: trade.realized_r, netPnl: trade.net_pnl, currency: trade.currency },
        ["exitPrice", "outcome", "realizedR", "netPnl", "currency"]),
    }, { storedPhase: "POST_TRADE" });
  }
  if (placed.length > TIMELINE_REVIEW_LIMITS.timelineItems) {
    throw new TimelineReviewScopeError(`This trade has ${placed.length} timeline records; a trade review covers at most ${TIMELINE_REVIEW_LIMITS.timelineItems}. Nothing was sent and no record was left out silently.`);
  }
  const timeline = placed
    .sort((a, b) => compareInstants(a.orderAt, b.orderAt) || a.rank - b.rank || compareInstants(a.item.recordedAt, b.item.recordedAt)
      || (a.item.sourceId < b.item.sourceId ? -1 : a.item.sourceId > b.item.sourceId ? 1 : 0))
    .map(entry => entry.item);

  const evidence: TimelineFactsEvidence[] = input.evidence.map(item => ({
    id: item.id, label: item.label, timeframe: item.timeframe, timing: timingOf(item.recordedAt, item.storedPhase).timing,
    recordedAt: item.recordedAt, sha256: item.sha256, mimeType: item.mimeType, bytes: item.byteSize,
  }));
  const proposal = plan?.proposal ?? {};
  const report = plan ? storedRiskSchema.parse(plan.riskResult) : null;
  const risk = input.riskVersion;
  const facts = withTimelineSources({
    version: TIMELINE_REVIEW_FACTS_VERSION,
    tradeId: trade.id,
    capturedAt,
    origin: trade.origin,
    planStatus,
    plan: plan ? {
      lockedAt: plan.lockedAt, tradingDay: plan.tradingDay, instrument: trade.symbol, direction: proposal.direction ?? null,
      entryModel: proposal.model ?? null, entry: proposal.entry ?? null, stop: proposal.stop ?? null, target: proposal.target ?? null,
      riskPercent: proposal.riskPercent ?? null, news: proposal.news ?? null, contractConfirmed: proposal.contractConfirmed ?? null,
      strategyContradiction: proposal.contradiction ?? null, thesis: lockedThesis, nominalRisk: plan.nominalRisk,
      plannedQuantity: trade.planned_quantity, plannedRR: trade.planned_rr, currency: trade.currency,
    } : null,
    strategy: { version: input.strategy.version, rules: input.strategy.rules },
    riskVersion: plan && risk ? {
      version: risk.version, effectiveDay: risk.effective_day, maxRiskPercent: risk.max_risk_percent, defaultRiskPercent: risk.default_risk_percent,
      maxDailyTrades: risk.max_daily_trades, minRR: risk.min_rr, rrPolicy: risk.rr_policy, newsPolicy: risk.news_policy,
      dailyRiskCap: risk.daily_risk_cap, dailyLossCap: risk.daily_loss_cap, currency: trade.currency,
    } : null,
    deterministic: report ? {
      engineVersion: report.engineVersion, evaluatedAt: report.evaluatedAt, tradingDay: report.tradingDay, session: report.session, status: report.status,
      issues: report.issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      calculations: report.calculations, currency: trade.currency,
    } : null,
    execution: {
      entryAt: trade.entered_at, entryRecordedAt, entryPrice: trade.entry_price, quantity: trade.quantity,
      plannedQuantity: trade.planned_quantity, oversize: trade.oversize, exitAt: trade.exited_at, exitPrice: trade.exit_price,
      fees: trade.fees, netPnl: trade.net_pnl, currency: trade.currency, realizedR: trade.realized_r,
      riskBasisSource,
      outcome: trade.outcome, pnlSource: trade.pnl_source,
    },
    timeline,
    evidence,
    tags: {
      setupGrade: input.tags.setupGrade, liquidityContext: input.tags.liquidityContext, mssTimeframe: input.tags.mssTimeframe,
      tags: [...input.tags.tags], source: input.tags.source, recordedAt: input.tags.recordedAt,
      timing: input.tags.recordedAt ? timingOf(input.tags.recordedAt).timing : null,
    },
  });
  // The facts bound first, then the whole request (prompt, schema, facts and every selected screenshot at its maximum
  // tile cost) by the conservative estimate the request gate applies, so a dense trade is refused before anything is written.
  const operation = operationFor("REVIEW_TRADE_TIMELINE");
  const screenshots = evidence.map(item => ({ sourceId: `evidence:${item.id}`, role: item.timeframe ?? item.label, dataUrl: UNSIZED_IMAGE }));
  if (Buffer.byteLength(JSON.stringify(facts)) > maxTimelineFactsBytes(evidence.length)
    || estimateRequest(operation, { context: facts, images: screenshots, prior: [] }).tokens > operation.maxInputTokens) {
    throw new TimelineReviewScopeError(evidence.length
      ? "This trade's records and the selected screenshots exceed the bounded review size. Select fewer screenshots. Nothing was sent."
      : "This trade's records exceed the bounded review size. Nothing was sent and no record was left out silently.");
  }
  return facts;
}

export type TradeTimelineFacts = ReturnType<typeof tradeTimelineReviewContext>;
