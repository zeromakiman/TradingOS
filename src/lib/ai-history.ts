import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";
import { analyzeSetupOutput } from "@/ai/analyze-setup-contract";
import { biasChallengeOutput } from "@/ai/bias-challenge-contract";
import { aiFailureAccountingMessage } from "@/ai/failure-accounting-message";
import { monthlyReviewOutput } from "@/ai/monthly-review-contract";
import { recentTradesOutput } from "@/ai/recent-trades-contract";
import { TIMELINE_REVIEW_REJECTIONS, tradeTimelineReviewOutput } from "@/ai/trade-timeline-review-contract";
import { tradeReviewOutput } from "@/ai/trade-review-contract";
import { weeklyReviewOutput } from "@/ai/weekly-review-contract";
import {
  type AiCostEstimate, type AiCostOperation, type AiSummaryCard, aiHistoryLabel, aiOperationLabel, aiStatusLabel, type EvidenceIndex, estimateAiCost,
  resolveSourceChip, type SourceChip, staleRevisionLabel, summarizeAnalyzeSetup, summarizeBiasChallenge, summarizeMonthlyReview,
  summarizeRecentTrades, summarizeTradeReview, summarizeTradeTimelineReview, summarizeWeeklyReview,
} from "@/domain/ai-summary";
import { addDays, compareInstants, formatDay, formatMonth, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import type { TimelineAiAnalysis } from "@/domain/timeline";

/**
 * Compact, UI-ready AI history (spec §11.1). Every result is parsed by the contract version stored with its request;
 * a result that no current parser understands degrades to a failed-style row instead of hiding the history. Raw
 * identifiers, versions and accounting values appear only in `technical`.
 */

export type UserDb = Awaited<ReturnType<typeof requireUser>>["db"];

export type AiHistoryOperation =
  | "ANALYZE_SETUP" | "CHALLENGE_BIAS" | "REVIEW_TRADE" | "REVIEW_TRADE_TIMELINE" | "WEEKLY_REVIEW" | "RECENT_TRADES_ANALYSIS" | "MONTHLY_REVIEW";
export type AiHistoryStatus = "COMPLETED" | "FAILED" | "IN_PROGRESS";

export interface AiHistoryTechnical {
  requestId: string;
  operation: AiHistoryOperation;
  operationVersion: string | null;
  contract: string | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  reservationId: string | null;
  reservedMicros: number | null;
  chargedMicros: number | null;
  disposition: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseId: string | null;
}

export interface AiHistoryRow {
  operation: AiHistoryOperation;
  operationLabel: string;
  status: AiHistoryStatus;
  statusLabel: string;
  requestedAt: string;
  completedAt: string | null;
  /** `Analyze Setup · Completed · 08:00` (strategy time). */
  label: string;
  /** First sentence of the result's headline field (completed rows only). */
  headline: string | null;
  /** Human reason for a failed row; null otherwise. */
  failureReason: string | null;
  /** Accounting outcome in plain words for failed rows. */
  accountingNote: string | null;
  technical: AiHistoryTechnical;
}

export interface RevisionMarker {
  number: number;
  currentNumber: number;
  isLatestRevision: boolean;
  /** "Based on draft revision n · current revision is m" for analyses of an earlier revision; null when current. */
  staleLabel: string | null;
}

export interface PreTradeHistoryRow extends AiHistoryRow {
  revision: RevisionMarker;
}

export type PeriodicScope =
  | { kind: "WEEK"; weekStart: string }
  | { kind: "RECENT"; requested: number; actual: number }
  | { kind: "MONTH"; month: string };

export interface PeriodicHistoryRow extends AiHistoryRow {
  scope: PeriodicScope;
  scopeLabel: string;
}

/** A summary card whose citations are resolved to friendly chips; raw ids stay in each chip's `technicalId`. */
export interface ResolvedAiCard extends Omit<AiSummaryCard, "headline" | "sections" | "full"> {
  headline: { text: string; sources: SourceChip[] };
  sections: ResolvedCardSection[];
  full: ResolvedCardSection[];
}
export interface ResolvedCardSection { id: string; title: string; items: { text: string; sources: SourceChip[] }[] }

// ---------------------------------------------------------------------------------------------
// Parsing by stored contract version
// ---------------------------------------------------------------------------------------------

/** Contract of each operation's first version, for request rows whose stored operation lacks one. */
const V1_CONTRACTS: Readonly<Record<AiHistoryOperation, string>> = Object.freeze({
  ANALYZE_SETUP: "ANALYZE_SETUP_V1", CHALLENGE_BIAS: "CHALLENGE_BIAS_V1", REVIEW_TRADE: "REVIEW_TRADE_V1", REVIEW_TRADE_TIMELINE: "REVIEW_TRADE_TIMELINE_V1",
  WEEKLY_REVIEW: "WEEKLY_REVIEW_V1", RECENT_TRADES_ANALYSIS: "RECENT_TRADES_V1", MONTHLY_REVIEW: "MONTHLY_REVIEW_V1",
});

function parsedCard<T>(schema: z.ZodType<T>, summarize: (output: T) => AiSummaryCard) {
  return (value: unknown): AiSummaryCard | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? summarize(parsed.data) : null;
  };
}

const CARD_PARSERS: Readonly<Record<string, (value: unknown) => AiSummaryCard | null>> = Object.freeze({
  ANALYZE_SETUP_V1: parsedCard(analyzeSetupOutput, summarizeAnalyzeSetup),
  CHALLENGE_BIAS_V1: parsedCard(biasChallengeOutput, summarizeBiasChallenge),
  REVIEW_TRADE_V1: parsedCard(tradeReviewOutput, summarizeTradeReview),
  REVIEW_TRADE_TIMELINE_V1: parsedCard(tradeTimelineReviewOutput, summarizeTradeTimelineReview),
  WEEKLY_REVIEW_V1: parsedCard(weeklyReviewOutput, output => summarizeWeeklyReview(output)),
  RECENT_TRADES_V1: parsedCard(recentTradesOutput, output => summarizeRecentTrades(output)),
  MONTHLY_REVIEW_V1: parsedCard(monthlyReviewOutput, output => summarizeMonthlyReview(output)),
});

/** Summary card of a stored interpretation, parsed by its stored contract; null when no parser accepts it. */
export function interpretationCard(contract: string | null, interpretation: unknown): AiSummaryCard | null {
  return contract !== null && Object.hasOwn(CARD_PARSERS, contract) ? CARD_PARSERS[contract](interpretation) : null;
}

const FAILURE_COPY: Readonly<Record<string, string>> = Object.freeze({
  ...TIMELINE_REVIEW_REJECTIONS,
  ACCOUNTING_UNCERTAIN: "The provider's usage could not be confirmed, so the reserved amount stays held for review.",
  AI_ACCOUNTING_PERSISTENCE_FAILED: "The usage record could not be saved, so the reserved amount stays held for review.",
  AI_BUDGET_OR_PERMISSION_CHANGED: "AI was switched off or the budget changed before the request was sent.",
  PROPOSAL_OR_EVIDENCE_CHANGED: "The draft or its screenshots changed before the request was sent.",
  TRADE_OR_EVIDENCE_CHANGED: "The trade or its screenshots changed before the request was sent.",
  SCREENSHOT_UNAVAILABLE: "A selected screenshot could not be read. Nothing was sent to the AI provider.",
  SCREENSHOT_CHANGED: "A selected screenshot changed after it was selected. Nothing was sent to the AI provider.",
  NOT_DISPATCHED: "The request was cancelled before it was sent.",
  INPUT_LIMIT_EXCEEDED: "The request was larger than the reviewed limit.",
  INPUT_COUNT_UNAVAILABLE: "The request size could not be confirmed with the AI provider.",
  TIMEOUT_OR_NETWORK: "The AI provider did not respond in time.",
  RATE_LIMIT: "The AI provider was busy.",
  REFUSED: "The AI provider declined the request.",
  INCOMPLETE: "The AI provider returned an incomplete answer.",
  INVALID_JSON: "The AI response could not be read.",
  INVALID_RESPONSE: "The AI response could not be read.",
  INVALID_ANALYSIS_OUTPUT: "The AI response did not match the expected format.",
  INVALID_CHALLENGE_OUTPUT: "The AI response did not match the expected format.",
  INVALID_WEEKLY_OUTPUT: "The AI response did not match the expected format.",
  INVALID_RECENT_OUTPUT: "The AI response did not match the expected format.",
  INVALID_MONTHLY_OUTPUT: "The AI response did not match the expected format.",
  TIMED_OUT: "The request did not finish in time.",
  UNREADABLE_RESULT: "This result was saved in a format this version cannot display.",
});

export function aiFailureReason(errorCode: string | null): string {
  return errorCode !== null && Object.hasOwn(FAILURE_COPY, errorCode) ? FAILURE_COPY[errorCode] : "The request did not complete.";
}

const operationColumn = z.object({
  id: z.string().optional(), version: z.string().optional(), contract: z.string().optional(), provider: z.string().optional(), model: z.string().optional(),
}).loose();
export const aiRequestRow = z.object({ id: z.uuid(), operation: operationColumn, created_at: z.string(), deadline_at: z.string() });
const resultRow = z.object({ status: z.enum(["COMPLETED", "FAILED"]), interpretation: z.unknown(), error_code: z.string().nullable(), reservation_id: z.uuid().nullable(), created_at: z.string() });
const holdRow = z.object({ id: z.uuid(), operation_id: z.uuid(), reserved_micros: z.number() });
const usageRow = z.object({
  reservation_id: z.uuid(), charged_micros: z.number(), disposition: z.string(),
  input_tokens: z.number().nullable().optional(), output_tokens: z.number().nullable().optional(), response_id: z.string().nullable().optional(),
});
export type AiRequestRow = z.infer<typeof aiRequestRow>;
export type AiResultRow = z.infer<typeof resultRow>;

export interface AiAccounting {
  holds: readonly z.infer<typeof holdRow>[];
  usage: readonly z.infer<typeof usageRow>[];
}

/** One history row from a request, its optional result and the reservation/usage linked to the request id. */
export function historyRow(operation: AiHistoryOperation, request: AiRequestRow, result: AiResultRow | null, accounting: AiAccounting, now: Date = new Date()): AiHistoryRow {
  const contract = request.operation.contract ?? V1_CONTRACTS[operation];
  const hold = accounting.holds.find(row => row.operation_id === request.id) ?? null;
  const reservationId = result?.reservation_id ?? hold?.id ?? null;
  const usage = reservationId ? accounting.usage.find(row => row.reservation_id === reservationId) ?? null : null;
  const card = result?.status === "COMPLETED" ? interpretationCard(contract, result.interpretation) : null;
  const status: AiHistoryStatus = result === null
    ? (Date.parse(request.deadline_at) > now.getTime() ? "IN_PROGRESS" : "FAILED")
    : result.status === "COMPLETED" && card ? "COMPLETED" : "FAILED";
  const errorCode = result === null ? (status === "FAILED" ? "TIMED_OUT" : null) : result.status === "COMPLETED" ? (card ? null : "UNREADABLE_RESULT") : result.error_code;
  let label: string;
  try {
    label = aiHistoryLabel(operation, status, result?.created_at ?? request.created_at);
  } catch {
    label = `${aiOperationLabel(operation)} · ${aiStatusLabel(status)}`;
  }
  return {
    operation,
    operationLabel: aiOperationLabel(operation),
    status,
    statusLabel: aiStatusLabel(status),
    requestedAt: request.created_at,
    completedAt: result?.created_at ?? null,
    label,
    headline: card?.headline.text ?? null,
    failureReason: status === "FAILED" ? aiFailureReason(errorCode) : null,
    accountingNote: status === "FAILED" ? aiFailureAccountingMessage(hold ? { usage } : null) : null,
    technical: {
      requestId: request.id, operation, operationVersion: request.operation.version ?? null, contract, provider: request.operation.provider ?? null,
      model: request.operation.model ?? null, errorCode, reservationId, reservedMicros: hold?.reserved_micros ?? null,
      chargedMicros: usage?.charged_micros ?? null, disposition: usage?.disposition ?? null,
      inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, responseId: usage?.response_id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Source chips
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export function resolveCardSources(card: AiSummaryCard, facts: unknown, manifest: unknown, evidenceIndex: EvidenceIndex = {}, display: TimeDisplay = STRATEGY_TIME): ResolvedAiCard {
  const chip = (ref: string): SourceChip => resolveSourceChip(ref, facts, manifest, evidenceIndex, display);
  const sections = (list: AiSummaryCard["sections"]): ResolvedCardSection[] => list.map(section => ({
    id: section.id, title: section.title, items: section.items.map(item => ({ text: item.text, sources: item.sourceRefs.map(chip) })),
  }));
  return { ...card, headline: { text: card.headline.text, sources: card.headline.sourceRefs.map(chip) }, sections: sections(card.sections), full: sections(card.full) };
}

/** Card of a completed history row, resolved against the facts stored with its request; null for other rows. */
export function resolvedCard(row: AiHistoryRow, interpretation: unknown, facts: unknown, evidenceIndex: EvidenceIndex = {}): ResolvedAiCard | null {
  if (row.status !== "COMPLETED") return null;
  const card = interpretationCard(row.technical.contract, interpretation);
  if (!card) return null;
  const manifest = isRecord(facts) ? facts.sourceManifest : undefined;
  return resolveCardSources(card, facts, manifest, evidenceIndex);
}

/** Rows for `buildTimeline` (spec §5.4 "AI analyses (compact)"). */
export function timelineAiAnalyses(rows: readonly AiHistoryRow[]): TimelineAiAnalysis[] {
  return rows.map(row => ({ id: row.technical.requestId, operation: row.operation, status: row.status, recordedAt: row.completedAt ?? row.requestedAt, summary: row.headline }));
}

/** `≈ €0.02` estimate inputs; null while the operation's pricing profile is expired or unknown (no request can run then). */
export function aiCostEstimate(operation: AiCostOperation, now: Date = new Date()): AiCostEstimate | null {
  try {
    return estimateAiCost(operation, now);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

const EMPTY = { data: [], error: null };

/** Results of the given requests keyed by request id (`resultKey` is the result table's request column). */
export async function loadResults(db: UserDb, table: string, resultKey: string, requests: readonly AiRequestRow[]): Promise<Map<string, AiResultRow>> {
  const ids = requests.map(row => row.id);
  const results = ids.length ? await db.from(table).select(`${resultKey},status,interpretation,error_code,reservation_id,created_at`).in(resultKey, ids) : EMPTY;
  if (results.error) throw new Error("AI history unavailable");
  const keyed = z.array(z.record(z.string(), z.unknown())).parse(results.data);
  return new Map(keyed.map(row => [String(row[resultKey]), resultRow.parse(row)] as const));
}

/** Reservations held for the given request ids and their usage records (owner-scoped). */
export async function loadAccounting(db: UserDb, userId: string, requestIds: readonly string[]): Promise<AiAccounting> {
  if (!requestIds.length) return { holds: [], usage: [] };
  const reservations = await db.from("ai_request_reservations").select("id,operation_id,reserved_micros").eq("user_id", userId).in("operation_id", [...requestIds]);
  if (reservations.error) throw new Error("AI accounting unavailable");
  const holds = z.array(holdRow).parse(reservations.data);
  const usage = holds.length
    ? await db.from("ai_usage_records").select("reservation_id,charged_micros,disposition,input_tokens,output_tokens,response_id").eq("user_id", userId).in("reservation_id", holds.map(row => row.id))
    : EMPTY;
  if (usage.error) throw new Error("AI accounting unavailable");
  return { holds, usage: z.array(usageRow).parse(usage.data) };
}

function newestFirst(a: AiHistoryRow, b: AiHistoryRow): number {
  return compareInstants(b.requestedAt, a.requestedAt) || (a.technical.requestId < b.technical.requestId ? 1 : a.technical.requestId > b.technical.requestId ? -1 : 0);
}

export function revisionMarker(revision: number, latestRevision: number): RevisionMarker {
  return { number: revision, currentNumber: latestRevision, isLatestRevision: revision === latestRevision, staleLabel: staleRevisionLabel(revision, latestRevision) };
}

const HISTORY_LIMIT = 50;

export interface PreTradeRevisionHistory extends RevisionMarker {
  rows: PreTradeHistoryRow[];
}

export interface TradeAiHistory {
  latestRevision: number | null;
  /** Analyze Setup / Challenge My Bias, grouped by draft revision, newest revision first. */
  preTrade: PreTradeRevisionHistory[];
  /** Trade reviews (V1 and timeline-aware), newest first. */
  reviews: AiHistoryRow[];
  error: string | null;
}

/** Per-trade AI history with the user's session. Throws when the trade is not the caller's; AI data errors degrade. */
export async function loadTradeAiHistory(tradeId: string): Promise<TradeAiHistory> {
  const { db, user } = await requireUser();
  const owned = await db.from("trades").select("id").eq("id", z.uuid().parse(tradeId)).eq("user_id", user.id).maybeSingle();
  if (owned.error || !owned.data) throw new Error("Trade unavailable");
  const id = z.object({ id: z.uuid() }).parse(owned.data).id;
  try {
    const [revisions, link] = await Promise.all([
      db.from("trade_revisions").select("proposal_id,revision").eq("trade_id", id).eq("user_id", user.id).order("revision"),
      db.from("trade_plan_links").select("plan_id").eq("trade_id", id).eq("user_id", user.id).maybeSingle(),
    ]);
    if (revisions.error || link.error) throw new Error("Trade history unavailable");
    const revisionRows = z.array(z.object({ proposal_id: z.uuid(), revision: z.number().int().positive() })).parse(revisions.data);
    const planId = link.data ? z.object({ plan_id: z.uuid() }).parse(link.data).plan_id : null;
    const proposalIds = revisionRows.map(row => row.proposal_id);
    const select = "id,operation,created_at,deadline_at";
    const [challenges, legacyReviews, timelineReviews] = await Promise.all([
      proposalIds.length
        ? db.from("bias_challenges").select(`${select},proposal_id`).in("proposal_id", proposalIds).eq("user_id", user.id).order("created_at", { ascending: false }).limit(HISTORY_LIMIT)
        : EMPTY,
      planId ? db.from("trade_ai_reviews").select(select).eq("plan_id", planId).eq("user_id", user.id).order("created_at", { ascending: false }).limit(HISTORY_LIMIT) : EMPTY,
      db.from("trade_timeline_reviews").select(select).eq("trade_id", id).eq("user_id", user.id).order("created_at", { ascending: false }).limit(HISTORY_LIMIT),
    ]);
    if (challenges.error || legacyReviews.error || timelineReviews.error) throw new Error("AI history unavailable");
    const challengeRows = z.array(aiRequestRow.extend({ proposal_id: z.uuid() })).parse(challenges.data);
    const legacyRows = z.array(aiRequestRow).parse(legacyReviews.data);
    const timelineRows = z.array(aiRequestRow).parse(timelineReviews.data);
    const [challengeResults, legacyResults, timelineResults, accounting] = await Promise.all([
      loadResults(db, "bias_challenge_results", "challenge_id", challengeRows),
      loadResults(db, "trade_ai_review_results", "review_id", legacyRows),
      loadResults(db, "trade_timeline_review_results", "review_id", timelineRows),
      loadAccounting(db, user.id, [...challengeRows, ...legacyRows, ...timelineRows].map(row => row.id)),
    ]);
    const latestRevision = revisionRows.at(-1)?.revision ?? null;
    const revisionOf = new Map(revisionRows.map(row => [row.proposal_id, row.revision] as const));
    const preTradeRows: PreTradeHistoryRow[] = challengeRows.flatMap(row => {
      const operation = row.operation.id === "ANALYZE_SETUP" || row.operation.id === "CHALLENGE_BIAS" ? row.operation.id : null;
      const revision = revisionOf.get(row.proposal_id);
      if (!operation || revision === undefined || latestRevision === null) return [];
      return [{ ...historyRow(operation, row, challengeResults.get(row.id) ?? null, accounting), revision: revisionMarker(revision, latestRevision) }];
    });
    const preTrade = [...new Set(preTradeRows.map(row => row.revision.number))].sort((a, b) => b - a).map(number => ({
      ...revisionMarker(number, latestRevision ?? number),
      rows: preTradeRows.filter(row => row.revision.number === number).sort(newestFirst),
    }));
    const reviews = [
      ...legacyRows.map(row => historyRow("REVIEW_TRADE", row, legacyResults.get(row.id) ?? null, accounting)),
      ...timelineRows.map(row => historyRow("REVIEW_TRADE_TIMELINE", row, timelineResults.get(row.id) ?? null, accounting)),
    ].sort(newestFirst);
    return { latestRevision, preTrade, reviews, error: null };
  } catch {
    return { latestRevision: null, preTrade: [], reviews: [], error: "AI history is unavailable right now. Trade records are unaffected." };
  }
}

export type PeriodicOperation = "WEEKLY_REVIEW" | "RECENT_TRADES_ANALYSIS" | "MONTHLY_REVIEW";
const PERIODIC_OPERATIONS: readonly PeriodicOperation[] = ["WEEKLY_REVIEW", "RECENT_TRADES_ANALYSIS", "MONTHLY_REVIEW"];

export interface AccountAiHistory {
  rows: PeriodicHistoryRow[];
  error: string | null;
}

/** `Week of Oct 6–12` (or `Week of Sep 29–Oct 5` across months) for a Monday `YYYY-MM-DD`. */
export function weekLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.slice(0, 7) === end.slice(0, 7);
  return `Week of ${formatDay(weekStart)}–${sameMonth ? Number(end.slice(8, 10)) : formatDay(end)}`;
}

/** Weekly, recent-trades and monthly AI history of one trading account, newest first. */
export async function loadAccountAiHistory(accountId: string, options: { operations?: readonly PeriodicOperation[]; limit?: number } = {}): Promise<AccountAiHistory> {
  const { db, user } = await requireUser();
  const owned = await db.from("accounts").select("id").eq("id", z.uuid().parse(accountId)).eq("user_id", user.id).maybeSingle();
  if (owned.error || !owned.data) throw new Error("Account unavailable");
  const id = z.object({ id: z.uuid() }).parse(owned.data).id;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 20)), HISTORY_LIMIT);
  const wanted = new Set(options.operations ?? PERIODIC_OPERATIONS);
  try {
    const select = "id,operation,created_at,deadline_at";
    const recentFirst = { ascending: false } as const;
    const [weekly, recent, monthly] = await Promise.all([
      wanted.has("WEEKLY_REVIEW") ? db.from("weekly_ai_reviews").select(`${select},week_start`).eq("account_id", id).eq("user_id", user.id).order("created_at", recentFirst).limit(limit) : EMPTY,
      wanted.has("RECENT_TRADES_ANALYSIS") ? db.from("recent_ai_analyses").select(`${select},requested_sample,actual_sample`).eq("account_id", id).eq("user_id", user.id).order("created_at", recentFirst).limit(limit) : EMPTY,
      wanted.has("MONTHLY_REVIEW") ? db.from("monthly_ai_reviews").select(`${select},month_start`).eq("account_id", id).eq("user_id", user.id).order("created_at", recentFirst).limit(limit) : EMPTY,
    ]);
    if (weekly.error || recent.error || monthly.error) throw new Error("AI history unavailable");
    const weeklyRows = z.array(aiRequestRow.extend({ week_start: z.string() })).parse(weekly.data);
    const recentRows = z.array(aiRequestRow.extend({ requested_sample: z.number().int(), actual_sample: z.number().int() })).parse(recent.data);
    const monthlyRows = z.array(aiRequestRow.extend({ month_start: z.string() })).parse(monthly.data);
    const [weeklyResults, recentResults, monthlyResults, accounting] = await Promise.all([
      loadResults(db, "weekly_ai_review_results", "review_id", weeklyRows),
      loadResults(db, "recent_ai_analysis_results", "review_id", recentRows),
      loadResults(db, "monthly_ai_review_results", "review_id", monthlyRows),
      loadAccounting(db, user.id, [...weeklyRows, ...recentRows, ...monthlyRows].map(row => row.id)),
    ]);
    const rows: PeriodicHistoryRow[] = [
      ...weeklyRows.map(row => ({
        ...historyRow("WEEKLY_REVIEW", row, weeklyResults.get(row.id) ?? null, accounting),
        scope: { kind: "WEEK" as const, weekStart: row.week_start }, scopeLabel: weekLabel(row.week_start),
      })),
      ...recentRows.map(row => ({
        ...historyRow("RECENT_TRADES_ANALYSIS", row, recentResults.get(row.id) ?? null, accounting),
        scope: { kind: "RECENT" as const, requested: row.requested_sample, actual: row.actual_sample },
        scopeLabel: row.actual_sample < row.requested_sample ? `Last ${row.actual_sample} trades (${row.requested_sample} requested)` : `Last ${row.actual_sample} trades`,
      })),
      ...monthlyRows.map(row => ({
        ...historyRow("MONTHLY_REVIEW", row, monthlyResults.get(row.id) ?? null, accounting),
        scope: { kind: "MONTH" as const, month: row.month_start.slice(0, 7) }, scopeLabel: formatMonth(row.month_start.slice(0, 7)),
      })),
    ].sort(newestFirst).slice(0, limit);
    return { rows, error: null };
  } catch {
    return { rows: [], error: "AI history is unavailable right now. Trading records are unaffected." };
  }
}
