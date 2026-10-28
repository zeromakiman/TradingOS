import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { type AiAvailability, HELD_RESERVATION_MESSAGE } from "@/ai/availability";
import { monthlyPeriod } from "@/ai/monthly-period";
import { recentSample } from "@/ai/recent-trades-context";
import { weeklyPeriod } from "@/ai/weekly-period";
import { RISK_COPY } from "@/domain/risk-explain";
import { formatMonth, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import { getAccountContext, getPreferences } from "@/lib/account-context";
import { accountAiAvailability } from "@/lib/ai-budget";
import {
  aiCostEstimate, aiRequestRow, historyRow, loadAccounting, loadResults, type PeriodicHistoryRow, type PeriodicOperation, type PeriodicScope,
  type ResolvedAiCard, resolvedCard, weekLabel,
} from "@/lib/ai-history";
import { loadMonthlyFacts, MonthlyScopeError, ownedMonthlyAccount } from "@/lib/monthly-review-source";
import { loadRecentFacts, ownedRecentAccount, RecentScopeError } from "@/lib/recent-trades-source";
import { requireUser } from "@/lib/supabase/server";
import { loadWeeklyFacts, ownedWeeklyAccount, WeeklyScopeError } from "@/lib/weekly-review-source";
import { estimateModel } from "./estimate";
import type { AiEstimateModel, AiRiskLine } from "./model";

/**
 * Server-side data for the composite AI panels. Everything is read with the user's session (RLS plus explicit owner
 * filters in the loaders); nothing here sends an AI request. Next.js control flow (redirects) is always rethrown.
 */

/** Resolves to null when the load fails for any reason other than Next.js control flow. */
export async function optional<T>(load: Promise<T>): Promise<T | null> {
  try {
    return await load;
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/** The user's time display (strategy UTC−5 unless they chose UTC or local time). */
export async function displayPreference(): Promise<TimeDisplay> {
  return (await optional(getPreferences()))?.timeDisplay ?? STRATEGY_TIME;
}

/** Why a paid button is disabled, in the product's words. */
export function availabilityReason(availability: Pick<AiAvailability, "status" | "message">): string | undefined {
  switch (availability.status) {
    case "ENABLED":
      return undefined;
    case "ACCOUNT_OFF":
      return "AI is off for this trading account. Turn it on in Settings → AI.";
    case "BUDGET_REACHED":
      return "This month's AI budget can't cover another request. Review the limit in Settings → AI.";
    case "ACCOUNTING_REVIEW":
      return HELD_RESERVATION_MESSAGE;
    case "DISABLED":
      return "AI analysis is turned off for this deployment.";
    default:
      return "AI is unavailable right now. Other Trading OS workflows are unaffected.";
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-trade verdicts
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const RISK_TITLES: Readonly<Record<string, { title: string }>> = RISK_COPY;

/**
 * The Risk Engine verdict a pre-trade request was made with, from the facts stored with it (`facts.deterministic`:
 * the check the AI saw): `{BLOCKED, "Requested risk exceeds maximum"}`. History keeps the meaning it had when it was
 * written (§0.3), so an analysis of an earlier revision is never shown under today's verdict. Null when the facts
 * carry no readable verdict.
 */
export function storedRiskLine(facts: unknown): AiRiskLine | null {
  if (!isRecord(facts) || !isRecord(facts.deterministic)) return null;
  const { status, issues } = facts.deterministic;
  if (status === "RISK_APPROVED") return { decision: "APPROVED", text: "" };
  if (status !== "TRADE_BLOCKED") return null;
  const first = Array.isArray(issues) ? issues.find(issue => isRecord(issue) && issue.severity === "BLOCK" && typeof issue.code === "string") : undefined;
  const code = isRecord(first) && typeof first.code === "string" ? first.code : null;
  // Titles from the single message catalogue (§6.5); an unknown code shows the decision alone, never the code.
  return { decision: "BLOCKED", text: code !== null && Object.hasOwn(RISK_TITLES, code) ? RISK_TITLES[code].title : "" };
}

const storedFactsRow = z.object({ id: z.uuid(), facts: z.unknown() });

/**
 * The Risk Engine verdict stored with each given pre-trade request (Analyze Setup and Challenge My Bias both live in
 * `bias_challenges`), keyed by request id; requests without a readable verdict are left out. Read with the user's
 * session (RLS) and an explicit owner filter.
 */
export async function loadStoredRiskLines(requestIds: readonly string[]): Promise<Map<string, AiRiskLine>> {
  const ids = [...new Set(requestIds)];
  if (ids.length === 0) return new Map();
  const { db, user } = await requireUser();
  const query = await db.from("bias_challenges").select("id,facts").eq("user_id", user.id).in("id", ids);
  if (query.error) throw new Error("AI history unavailable");
  const lines = new Map<string, AiRiskLine>();
  for (const row of z.array(storedFactsRow).parse(query.data ?? [])) {
    const line = storedRiskLine(row.facts);
    if (line) lines.set(row.id, line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Periodic reviews
// ---------------------------------------------------------------------------------------------

export type PeriodicKind = "weekly" | "recent" | "monthly";

/** The requested period is not valid for the review; the message is shown as is. */
export class PeriodError extends Error {}

/** A periodic history row with its resolved card and the facts Trading OS stored with the request. */
export interface PeriodicHistoryEntry extends PeriodicHistoryRow {
  card: ResolvedAiCard | null;
  storedFacts: unknown;
}

export interface PeriodicAiData {
  kind: PeriodicKind;
  operation: PeriodicOperation;
  accountId: string;
  accountName: string;
  /** "Week of Oct 6–12", "Most recent 20 completed trades", "September 2026". */
  periodLabel: string;
  /** Period with its clock where it matters: "Week of Oct 6–12 (UTC−5)". */
  scopeLabel: string;
  /** Short period words for the run button: "week of Oct 6–12", "last 20 trades", "September 2026". */
  runLabel: string;
  /** Form fields of the action for this period. */
  payload: Record<string, string>;
  /** Completed trades the review would cover now; null when they could not be counted. */
  trades: number | null;
  /** Why this period cannot be reviewed now (incomplete period, size limits); null when it can. */
  scopeError: string | null;
  availability: AiAvailability;
  estimate: AiEstimateModel | null;
  /** This period's requests, newest first. */
  history: PeriodicHistoryEntry[];
  error: string | null;
}

const PERIODIC = {
  weekly: { operation: "WEEKLY_REVIEW", requests: "weekly_ai_reviews", results: "weekly_ai_review_results", column: "week_start" },
  recent: { operation: "RECENT_TRADES_ANALYSIS", requests: "recent_ai_analyses", results: "recent_ai_analysis_results", column: "requested_sample" },
  monthly: { operation: "MONTHLY_REVIEW", requests: "monthly_ai_reviews", results: "monthly_ai_review_results", column: "month_start" },
} as const satisfies Record<PeriodicKind, { operation: PeriodicOperation; requests: string; results: string; column: string }>;

const HISTORY_LIMIT = 10;
const UNAVAILABLE_SOURCE = "This period's trades could not be read. Nothing can be sent.";

interface ResolvedPeriod {
  filter: string | number;
  scope: PeriodicScope;
  periodLabel: string;
  scopeLabel: string;
  runLabel: string;
  payload: Record<string, string>;
}

function resolvePeriod(kind: PeriodicKind, accountId: string, period: string | number): ResolvedPeriod {
  try {
    if (kind === "weekly") {
      const { startDate } = weeklyPeriod(String(period));
      const label = weekLabel(startDate);
      return {
        filter: startDate, scope: { kind: "WEEK", weekStart: startDate }, periodLabel: label, scopeLabel: `${label} (UTC−5)`,
        runLabel: `${label.charAt(0).toLowerCase()}${label.slice(1)}`, payload: { accountId, week: startDate },
      };
    }
    if (kind === "recent") {
      const sample = recentSample(typeof period === "number" ? String(period) : period);
      const label = `Most recent ${sample} completed trades`;
      return {
        filter: sample, scope: { kind: "RECENT", requested: sample, actual: sample }, periodLabel: label, scopeLabel: label,
        runLabel: `last ${sample} trades`, payload: { accountId, sample: String(sample) },
      };
    }
    const { month, startDate } = monthlyPeriod(String(period));
    const label = formatMonth(month);
    return {
      filter: startDate, scope: { kind: "MONTH", month }, periodLabel: label, scopeLabel: `${label} (UTC−5)`, runLabel: label,
      payload: { accountId, month },
    };
  } catch {
    throw new PeriodError(kind === "weekly" ? "Choose a valid week." : kind === "recent" ? "Choose 10, 20 or 30 completed trades." : "Choose a valid month.");
  }
}

type Owner = Awaited<ReturnType<typeof ownedWeeklyAccount>>;

/** The owned account and the trades the review would cover now (or why it cannot run for this period). */
async function periodScope(kind: PeriodicKind, accountId: string, period: ResolvedPeriod): Promise<{ owner: Owner; trades: number | null; scopeError: string | null }> {
  if (kind === "weekly") {
    const owner = await ownedWeeklyAccount(accountId);
    try {
      return { owner, trades: (await loadWeeklyFacts(owner, String(period.filter))).sample.count, scopeError: null };
    } catch (error) {
      unstable_rethrow(error);
      return { owner, trades: null, scopeError: error instanceof WeeklyScopeError ? error.message : UNAVAILABLE_SOURCE };
    }
  }
  if (kind === "recent") {
    const owner = await ownedRecentAccount(accountId);
    try {
      return { owner, trades: (await loadRecentFacts(owner, period.filter)).facts.sample.actual, scopeError: null };
    } catch (error) {
      unstable_rethrow(error);
      return { owner, trades: null, scopeError: error instanceof RecentScopeError ? error.message : UNAVAILABLE_SOURCE };
    }
  }
  const owner = await ownedMonthlyAccount(accountId);
  try {
    return { owner, trades: (await loadMonthlyFacts(owner, period.payload.month)).sample.count, scopeError: null };
  } catch (error) {
    unstable_rethrow(error);
    return { owner, trades: null, scopeError: error instanceof MonthlyScopeError ? error.message : UNAVAILABLE_SOURCE };
  }
}

const periodicRequest = aiRequestRow.extend({
  facts: z.unknown(),
  requested_sample: z.number().int().optional(),
  actual_sample: z.number().int().optional(),
});

/** Recent-trades rows keep their own sample: fewer completed trades may have existed than were requested. */
function rowScope(period: ResolvedPeriod, request: z.infer<typeof periodicRequest>): { scope: PeriodicScope; scopeLabel: string } {
  if (period.scope.kind !== "RECENT" || request.requested_sample === undefined || request.actual_sample === undefined) {
    return { scope: period.scope, scopeLabel: period.periodLabel };
  }
  const { requested_sample: requested, actual_sample: actual } = request;
  return {
    scope: { kind: "RECENT", requested, actual },
    scopeLabel: actual < requested ? `Last ${actual} trades (${requested} requested)` : `Last ${actual} trades`,
  };
}

async function periodHistory(kind: PeriodicKind, owner: Owner, period: ResolvedPeriod): Promise<PeriodicHistoryEntry[]> {
  const table = PERIODIC[kind];
  const columns = kind === "recent" ? "id,facts,operation,created_at,deadline_at,requested_sample,actual_sample" : "id,facts,operation,created_at,deadline_at";
  const query = await owner.db.from(table.requests).select(columns)
    .eq("account_id", owner.account.id).eq("user_id", owner.user.id).eq(table.column, period.filter)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(HISTORY_LIMIT);
  if (query.error) throw new Error("AI history unavailable");
  const requests = z.array(periodicRequest).parse(query.data ?? []);
  const [results, accounting] = await Promise.all([
    loadResults(owner.db, table.results, "review_id", requests),
    loadAccounting(owner.db, owner.user.id, requests.map(request => request.id)),
  ]);
  return requests.map(request => {
    const result = results.get(request.id) ?? null;
    const row = historyRow(table.operation, request, result, accounting);
    return { ...row, ...rowScope(period, request), card: resolvedCard(row, result?.interpretation, request.facts), storedFacts: request.facts };
  });
}

async function accountName(accountId: string, fallback: string): Promise<string> {
  const context = await optional(getAccountContext());
  return context?.accounts.find(account => account.id === accountId)?.name ?? fallback;
}

/**
 * Scope, availability, estimate and this period's history for one account. Throws `PeriodError` for an invalid period
 * and an error for an account that is not the caller's; history failures degrade to `error`.
 */
export async function loadPeriodicAi(kind: PeriodicKind, accountId: string, period: string | number): Promise<PeriodicAiData> {
  const resolved = resolvePeriod(kind, accountId, period);
  const operation = PERIODIC[kind].operation;
  const { owner, trades, scopeError } = await periodScope(kind, accountId, resolved);
  const [availability, history, name] = await Promise.all([
    accountAiAvailability(owner.account.id, operation),
    periodHistory(kind, owner, resolved).then(
      rows => ({ rows, error: null }),
      (error: unknown) => {
        unstable_rethrow(error);
        return { rows: [] as PeriodicHistoryEntry[], error: "AI history is unavailable right now. Trading records are unaffected." };
      },
    ),
    accountName(owner.account.id, owner.account.name),
  ]);
  return {
    kind, operation, accountId: owner.account.id, accountName: name, periodLabel: resolved.periodLabel, scopeLabel: resolved.scopeLabel,
    runLabel: resolved.runLabel, payload: resolved.payload, trades, scopeError, availability, estimate: estimateModel(aiCostEstimate(operation)),
    history: history.rows, error: history.error,
  };
}
