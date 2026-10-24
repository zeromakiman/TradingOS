import "server-only";
import { z } from "zod";
import { compareInstants, formatDay, formatMonth, isInstant, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import type { Db } from "@/lib/account-context";
import {
  type AiHistoryOperation, type AiHistoryRow, type AiResultRow, aiRequestRow, historyRow, loadAccounting, loadResults, type RevisionMarker,
  revisionMarker, weekLabel,
} from "@/lib/ai-history";
import { tradeDate } from "@/lib/trades-data";
import { encodeHistoryCursor, type HistoryCursor, type HistoryKind, type RecentSample, reviewHref } from "./params";

/**
 * Every AI analysis of the user's trading accounts in one compact, newest-first list (docs/V2_ARCHITECTURE.md §11.1,
 * §14.10): periodic reviews (weekly, recent trades, monthly) and trade-level analyses (Analyze Setup, Challenge My
 * Bias, trade reviews). Read with the user's session (RLS) plus an explicit owner filter, with keyset pagination over
 * (created_at, id) across all six request tables. Nothing here sends an AI request.
 */

export const HISTORY_PAGE_SIZE = 30;
export const HISTORY_UNAVAILABLE = "AI history is unavailable right now. Trading records are unaffected.";

type SourceKind = "periodic" | "trade";

interface Source {
  key: "weekly" | "recent" | "monthly" | "bias" | "review" | "timeline";
  kind: SourceKind;
  requests: string;
  results: string;
  resultKey: string;
  /** Columns beyond the shared request columns. */
  extra: string;
}

const SOURCES: readonly Source[] = [
  { key: "weekly", kind: "periodic", requests: "weekly_ai_reviews", results: "weekly_ai_review_results", resultKey: "review_id", extra: "week_start" },
  { key: "recent", kind: "periodic", requests: "recent_ai_analyses", results: "recent_ai_analysis_results", resultKey: "review_id", extra: "requested_sample,actual_sample" },
  { key: "monthly", kind: "periodic", requests: "monthly_ai_reviews", results: "monthly_ai_review_results", resultKey: "review_id", extra: "month_start" },
  { key: "bias", kind: "trade", requests: "bias_challenges", results: "bias_challenge_results", resultKey: "challenge_id", extra: "proposal_id" },
  { key: "review", kind: "trade", requests: "trade_ai_reviews", results: "trade_ai_review_results", resultKey: "review_id", extra: "plan_id" },
  { key: "timeline", kind: "trade", requests: "trade_timeline_reviews", results: "trade_timeline_review_results", resultKey: "review_id", extra: "trade_id" },
];

/** Analyze Setup and Challenge My Bias share `bias_challenges`; anything else stored there is not a V2 analysis. */
const PRE_TRADE_OPERATIONS = ["ANALYZE_SETUP", "CHALLENGE_BIAS"] as const;

const requestRow = aiRequestRow.extend({
  account_id: z.uuid(),
  week_start: z.string().optional(),
  month_start: z.string().optional(),
  requested_sample: z.number().int().optional(),
  actual_sample: z.number().int().optional(),
  proposal_id: z.uuid().optional(),
  plan_id: z.uuid().optional(),
  trade_id: z.uuid().optional(),
});
type RequestRow = z.infer<typeof requestRow>;

interface SourcedRow {
  source: Source;
  row: RequestRow;
}

const revisionRow = z.object({ proposal_id: z.uuid(), trade_id: z.uuid(), revision: z.number().int().positive() });
const tradeRevisionRow = z.object({ trade_id: z.uuid(), revision: z.number().int().positive() });
const planLinkRow = z.object({ plan_id: z.uuid(), trade_id: z.uuid() });
const tradeRow = z.object({
  id: z.uuid(),
  symbol: z.string().nullable(),
  direction: z.enum(["LONG", "SHORT"]).nullable(),
  entered_at: z.string().refine(isInstant).nullable(),
  locked_at: z.string().refine(isInstant).nullable(),
  created_at: z.string().refine(isInstant),
});
type TradeRow = z.infer<typeof tradeRow>;

export interface HistorySubject {
  /** "Week of Oct 12–18", "Last 20 trades", "September 2026", "EURUSD long · Oct 14". */
  label: string;
  /** The periodic review's tab for that period, or the trade page; null when the trade can't be read. */
  href: string | null;
  kind: "period" | "trade";
}

export interface HistoryEntry extends AiHistoryRow {
  accountId: string;
  subject: HistorySubject;
  /** Pre-trade analyses: the draft revision analysed, marked stale when the draft changed since. */
  revision: RevisionMarker | null;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Cursor of the next (older) page; null on the last page. */
  nextCursor: string | null;
  error: string | null;
}

export interface HistoryQuery {
  db: Db;
  userId: string;
  /** Restrict to one account; null lists every account of the user. */
  accountId: string | null;
  kind: HistoryKind;
  before: HistoryCursor | null;
  /** All Accounts: periodic subject links carry the row's account (the page's own picker, never the context). */
  linkAccounts: boolean;
  display?: TimeDisplay;
  limit?: number;
  now?: Date;
}

/** PostgREST logic-tree value: quoted, because timestamps contain reserved characters (`:`, `.`). */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** (created_at desc, id desc), microsecond exact: the order every source table was read in. */
function newestFirst(a: SourcedRow, b: SourcedRow): number {
  return compareInstants(b.row.created_at, a.row.created_at) || (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0);
}

async function readSource(query: HistoryQuery, source: Source, take: number): Promise<SourcedRow[]> {
  let request = query.db.from(source.requests).select(`id,account_id,operation,created_at,deadline_at,${source.extra}`).eq("user_id", query.userId);
  if (query.accountId) request = request.eq("account_id", query.accountId);
  if (source.key === "bias") request = request.in("operation->>id", [...PRE_TRADE_OPERATIONS]);
  if (query.before) {
    const at = quoted(query.before.t);
    request = request.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${query.before.id})`);
  }
  const { data, error } = await request.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(take);
  if (error) throw new Error("AI history unavailable");
  return z.array(requestRow).parse(data ?? []).map(row => ({ source, row }));
}

function operationOf({ source, row }: SourcedRow): AiHistoryOperation | null {
  switch (source.key) {
    case "weekly": return "WEEKLY_REVIEW";
    case "recent": return "RECENT_TRADES_ANALYSIS";
    case "monthly": return "MONTHLY_REVIEW";
    case "review": return "REVIEW_TRADE";
    case "timeline": return "REVIEW_TRADE_TIMELINE";
    case "bias": {
      const id = row.operation.id;
      return id === "ANALYZE_SETUP" || id === "CHALLENGE_BIAS" ? id : null;
    }
  }
}

/** `EURUSD long · Oct 14` (the trade date the Journal uses: entry, else lock, else creation). */
export function tradeLabel(trade: TradeRow | undefined, display: TimeDisplay = STRATEGY_TIME): string {
  if (!trade) return "Trade";
  const name = [trade.symbol, trade.direction?.toLowerCase()].filter(Boolean).join(" ") || "Trade";
  try {
    return `${name} · ${formatDay(tradeDate(trade).at, display)}`;
  } catch {
    return name;
  }
}

/** `Last 20 trades`, or `Last 12 trades (20 requested)` when fewer completed trades existed. */
export function recentScopeLabel(requested: number, actual: number): string {
  return actual < requested ? `Last ${actual} trades (${requested} requested)` : `Last ${actual} trades`;
}

function asSample(value: number | undefined): RecentSample | undefined {
  return value === 10 || value === 20 || value === 30 ? value : undefined;
}

interface TradeContext {
  tradeOfProposal: Map<string, { tradeId: string; revision: number }>;
  latestRevision: Map<string, number>;
  tradeOfPlan: Map<string, string>;
  trades: Map<string, TradeRow>;
}

async function tradeContext(db: Db, userId: string, rows: readonly SourcedRow[]): Promise<TradeContext> {
  const proposalIds = [...new Set(rows.flatMap(({ source, row }) => (source.key === "bias" && row.proposal_id ? [row.proposal_id] : [])))];
  const planIds = [...new Set(rows.flatMap(({ source, row }) => (source.key === "review" && row.plan_id ? [row.plan_id] : [])))];
  const [revisions, links] = await Promise.all([
    proposalIds.length ? db.from("trade_revisions").select("proposal_id,trade_id,revision").eq("user_id", userId).in("proposal_id", proposalIds) : { data: [], error: null },
    planIds.length ? db.from("trade_plan_links").select("plan_id,trade_id").eq("user_id", userId).in("plan_id", planIds) : { data: [], error: null },
  ]);
  if (revisions.error || links.error) throw new Error("Trade context unavailable");
  const tradeOfProposal = new Map(z.array(revisionRow).parse(revisions.data ?? []).map(row => [row.proposal_id, { tradeId: row.trade_id, revision: row.revision }] as const));
  const tradeOfPlan = new Map(z.array(planLinkRow).parse(links.data ?? []).map(row => [row.plan_id, row.trade_id] as const));
  const preTradeTrades = [...new Set([...tradeOfProposal.values()].map(value => value.tradeId))];
  const tradeIds = [
    ...new Set([
      ...preTradeTrades,
      ...tradeOfPlan.values(),
      ...rows.flatMap(({ source, row }) => (source.key === "timeline" && row.trade_id ? [row.trade_id] : [])),
    ]),
  ];
  const [latest, trades] = await Promise.all([
    preTradeTrades.length ? db.from("trade_revisions").select("trade_id,revision").eq("user_id", userId).in("trade_id", preTradeTrades) : { data: [], error: null },
    tradeIds.length ? db.from("trade_ledger").select("id,symbol,direction,entered_at,locked_at,created_at").in("id", tradeIds) : { data: [], error: null },
  ]);
  if (latest.error || trades.error) throw new Error("Trade context unavailable");
  const latestRevision = new Map<string, number>();
  for (const row of z.array(tradeRevisionRow).parse(latest.data ?? [])) latestRevision.set(row.trade_id, Math.max(latestRevision.get(row.trade_id) ?? 0, row.revision));
  return { tradeOfProposal, latestRevision, tradeOfPlan, trades: new Map(z.array(tradeRow).parse(trades.data ?? []).map(row => [row.id, row] as const)) };
}

function subjectOf(item: SourcedRow, context: TradeContext, query: HistoryQuery): { subject: HistorySubject; revision: RevisionMarker | null } {
  const { source, row } = item;
  const display = query.display ?? STRATEGY_TIME;
  const reviewAccount = query.linkAccounts ? row.account_id : null;
  const trade = (tradeId: string | undefined, revision: RevisionMarker | null = null) => ({
    subject: { label: tradeLabel(tradeId ? context.trades.get(tradeId) : undefined, display), href: tradeId ? `/trades/${tradeId}` : null, kind: "trade" as const },
    revision,
  });
  switch (source.key) {
    case "weekly": {
      const week = row.week_start ?? "";
      let label = "Weekly review";
      try {
        label = weekLabel(week);
      } catch {
        // An unreadable stored week keeps the neutral label.
      }
      return { subject: { label, href: reviewHref("weekly", { week, reviewAccount }), kind: "period" }, revision: null };
    }
    case "recent": {
      const requested = row.requested_sample ?? 0;
      const actual = row.actual_sample ?? requested;
      return {
        subject: { label: recentScopeLabel(requested, actual), href: reviewHref("recent", { sample: asSample(requested), reviewAccount }), kind: "period" },
        revision: null,
      };
    }
    case "monthly": {
      const month = (row.month_start ?? "").slice(0, 7);
      let label = "Monthly review";
      try {
        label = formatMonth(month);
      } catch {
        // An unreadable stored month keeps the neutral label.
      }
      return { subject: { label, href: reviewHref("monthly", { month, reviewAccount }), kind: "period" }, revision: null };
    }
    case "bias": {
      const link = row.proposal_id ? context.tradeOfProposal.get(row.proposal_id) : undefined;
      const latest = link ? context.latestRevision.get(link.tradeId) : undefined;
      return trade(link?.tradeId, link && latest !== undefined ? revisionMarker(link.revision, latest) : null);
    }
    case "review":
      return trade(row.plan_id ? context.tradeOfPlan.get(row.plan_id) : undefined);
    case "timeline":
      return trade(row.trade_id);
  }
}

/**
 * One page of the AI history, newest first. Analyses whose stored results no parser understands still appear (as
 * failed rows with a plain reason), so the history is never silently shortened. Failures degrade to `error`.
 */
export async function loadHistoryPage(query: HistoryQuery): Promise<HistoryPage> {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? HISTORY_PAGE_SIZE)), 100);
  try {
    const sources = SOURCES.filter(source => query.kind === "all" || source.kind === query.kind);
    const batches = await Promise.all(sources.map(source => readSource(query, source, limit + 1)));
    const merged = batches.flat().sort(newestFirst);
    const page = merged.slice(0, limit);
    const last = page.at(-1);
    const [results, accounting, context] = await Promise.all([
      Promise.all(
        sources.map(async source => {
          const rows = page.filter(item => item.source === source).map(item => item.row);
          return [source.key, await loadResults(query.db, source.results, source.resultKey, rows)] as const;
        }),
      ),
      loadAccounting(query.db, query.userId, page.map(item => item.row.id)),
      tradeContext(query.db, query.userId, page),
    ]);
    const resultsBySource = new Map<string, Map<string, AiResultRow>>(results);
    const now = query.now ?? new Date();
    const entries = page.flatMap(item => {
      const operation = operationOf(item);
      if (operation === null) return [];
      const result = resultsBySource.get(item.source.key)?.get(item.row.id) ?? null;
      const row = historyRow(operation, item.row, result, accounting, now);
      return [{ ...row, accountId: item.row.account_id, ...subjectOf(item, context, query) }];
    });
    return {
      entries,
      nextCursor: merged.length > limit && last ? encodeHistoryCursor({ t: last.row.created_at, id: last.row.id }) : null,
      error: null,
    };
  } catch {
    return { entries: [], nextCursor: null, error: HISTORY_UNAVAILABLE };
  }
}
