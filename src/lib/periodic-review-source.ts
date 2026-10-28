import "server-only";
import { z } from "zod";
import type { JournalTrade } from "@/domain/analytics";
import type { PeriodicJournalEntry, PeriodicTags, PeriodicTradeSource } from "@/ai/periodic-facts";
import { PLAN_SELECT, planRow, riskRow } from "./data";
import type { requireUser } from "./supabase/server";

/**
 * Shared loading of the V2 periodic facts (weekly, recent trades, monthly). Every query uses the signed-in user's
 * session (RLS) plus explicit account and owner filters, and only ids the caller's own sample produced. A scope with
 * more journal entries, events or tag changes than the bounds allow is refused as a whole: nothing is omitted. The
 * monthly deterministic summary counts the records of its scope instead of reading them (`countPeriodicRecords`).
 */

type Db = Awaited<ReturnType<typeof requireUser>>["db"];

/** Records of a trade that count for a review: up to the capture time (recent trades), or inside a period. */
export type RecordScope = { kind: "UP_TO"; at: string } | { kind: "WITHIN"; start: string; endExclusive: string };

/** The scope has more records than one review may include; the message is shown as is (nothing was sent). */
export class PeriodicRecordsLimitError extends Error {}

export const periodicAccountRow = z.object({ id: z.uuid(), name: z.string(), currency: z.string().regex(/^[A-Z]{3}$/) });

const eventRow = z.object({ id: z.uuid(), plan_id: z.uuid(), event_type: z.string(), payload: z.record(z.string(), z.unknown()), occurred_at: z.string(), recorded_at: z.string() });
const ledgerLink = z.object({ id: z.uuid(), plan_id: z.uuid(), entry_recorded_at: z.string().nullable(), close_recorded_at: z.string().nullable() });
const journalRow = z.object({
  id: z.uuid(), trade_id: z.uuid(), kind: z.enum(["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"]),
  body: z.string().nullable(), details: z.record(z.string(), z.unknown()), phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), recorded_at: z.string(),
});
const tagRow = z.object({
  id: z.number().int(), trade_id: z.uuid(), setup_grade: z.string().nullable(), liquidity_context: z.string().nullable(), mss_timeframe: z.string().nullable(),
  tags: z.array(z.string()), recorded_at: z.string(),
});
const strategyRow = z.object({ id: z.uuid(), version: z.string(), rules: z.record(z.string(), z.unknown()) });
const RISK_SELECT = "id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text";
/** V1 events the plan and execution facts already represent (spec §5.4 renders them the same way). */
export const REPRESENTED_EVENTS = ["PLAN_LOCKED", "TRADE_OPENED", "TRADE_CLOSED"] as const;
/** Tag changes read per review; a scope with more is refused rather than read partially. */
const TAG_ROWS = 1000;

function scoped<Q extends { lte(column: string, value: string): Q; gte(column: string, value: string): Q; lt(column: string, value: string): Q }>(query: Q, column: string, scope: RecordScope): Q {
  return scope.kind === "UP_TO" ? query.lte(column, scope.at) : query.gte(column, scope.start).lt(column, scope.endExclusive);
}

type Owner = Pick<PeriodicLoadInput, "db" | "userId" | "accountId" | "scope">;
/** Reading selects columns; counting selects nothing (an exact head count). Both share one filter, so a count is exactly what a read returns. */
type RecordSelect = { columns: string; count?: undefined } | { columns: "id"; count: "HEAD" };
const selection = (select: RecordSelect) => select.count === "HEAD" ? { count: "exact" as const, head: true } : undefined;

/** The trades' V1 events in scope; plan lock, entry and close events repeat the plan and execution facts each trade carries. */
function eventsInScope(owner: Owner, planIds: readonly string[], select: RecordSelect) {
  const owned = owner.db.from("trade_events").select(select.columns, selection(select)).eq("account_id", owner.accountId).eq("user_id", owner.userId)
    .in("plan_id", planIds).not("event_type", "in", `(${REPRESENTED_EVENTS.join(",")})`);
  return scoped(scoped(owned, "occurred_at", owner.scope), "recorded_at", owner.scope);
}

/** The V2 journal entries of the given V2 trades recorded in scope. */
function journalInScope(owner: Owner, tradeIds: readonly string[], select: RecordSelect) {
  const owned = owner.db.from("trade_journal_entries").select(select.columns, selection(select)).eq("account_id", owner.accountId).eq("user_id", owner.userId)
    .in("trade_id", tradeIds);
  return scoped(owned, "recorded_at", owner.scope);
}

export interface PeriodicLoadInput {
  db: Db;
  userId: string;
  accountId: string;
  /** The sample's closed planned trades from `journal_analytics`, already ordered and bounded by the caller. */
  trades: readonly JournalTrade[];
  scope: RecordScope;
  /** Most journal entries plus events the review may include. */
  maxRecords: number;
  /** Legacy V1 tags (no recording time) may stand in when a trade has no V2 tag set (recent trades only). */
  legacyTags: boolean;
  /** Copy for a scope above `maxRecords`. */
  recordsMessage: string;
}

/** Every included trade's plan, versions, V2 identity, records and tags; throws when any original record is missing. */
export async function loadPeriodicSources(input: PeriodicLoadInput): Promise<PeriodicTradeSource[]> {
  const { db, userId, accountId, trades, scope } = input;
  if (!trades.length) return [];
  const ids = trades.map(trade => trade.id);
  const strategyIds = [...new Set(trades.map(trade => trade.strategy_version_id))];
  const riskIds = [...new Set(trades.map(trade => trade.risk_plan_version_id))];
  const [plansQuery, strategiesQuery, risksQuery, eventsQuery, linksQuery] = await Promise.all([
    db.from("trade_plans").select(PLAN_SELECT).eq("account_id", accountId).eq("user_id", userId).in("id", ids),
    db.from("strategy_versions").select("id,version,rules").eq("account_id", accountId).eq("user_id", userId).in("id", strategyIds),
    db.from("risk_plan_versions").select(RISK_SELECT).eq("account_id", accountId).eq("user_id", userId).in("id", riskIds),
    eventsInScope(input, ids, { columns: "id,plan_id,event_type,payload,occurred_at,recorded_at" }).order("sequence").limit(input.maxRecords + 1),
    db.from("trade_ledger").select("id,plan_id,entry_recorded_at,close_recorded_at").eq("account_id", accountId).in("plan_id", ids),
  ]);
  if ([plansQuery, strategiesQuery, risksQuery, eventsQuery, linksQuery].some(query => query.error)) throw new Error("Periodic context unavailable");
  const plans = z.array(planRow).parse(plansQuery.data);
  const strategies = z.array(strategyRow).parse(strategiesQuery.data);
  const risks = z.array(riskRow).parse(risksQuery.data);
  const events = z.array(eventRow).parse(eventsQuery.data);
  const links = z.array(ledgerLink).parse(linksQuery.data);
  if (events.length > input.maxRecords) throw new PeriodicRecordsLimitError(input.recordsMessage);
  const tradeIds = links.map(link => link.id);
  const [journalQuery, tagsQuery] = await Promise.all([
    tradeIds.length
      ? journalInScope(input, tradeIds, { columns: "id,trade_id,kind,body,details,phase,recorded_at" })
        .order("recorded_at").order("id").limit(input.maxRecords - events.length + 1)
      : Promise.resolve({ data: [], error: null }),
    tradeIds.length
      ? scoped(db.from("trade_tag_sets").select("id,trade_id,setup_grade,liquidity_context,mss_timeframe,tags,recorded_at").eq("account_id", accountId).eq("user_id", userId).in("trade_id", tradeIds), "recorded_at", scope)
        .order("id", { ascending: false }).limit(TAG_ROWS + 1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (journalQuery.error || tagsQuery.error) throw new Error("Periodic context unavailable");
  const journal = z.array(journalRow).parse(journalQuery.data);
  const tagSets = z.array(tagRow).parse(tagsQuery.data);
  if (events.length + journal.length > input.maxRecords || tagSets.length > TAG_ROWS) throw new PeriodicRecordsLimitError(input.recordsMessage);
  return trades.map(trade => {
    const plan = plans.find(row => row.id === trade.id);
    const strategy = strategies.find(row => row.id === trade.strategy_version_id);
    const risk = risks.find(row => row.id === trade.risk_plan_version_id);
    const link = links.find(row => row.plan_id === trade.id);
    if (!plan || !strategy || !risk || !link) throw new Error("Original periodic records unavailable");
    // Latest V2 tag set in scope (the identity order is the recording order); legacy V1 tags only where allowed.
    const tagSet = tagSets.find(row => row.trade_id === link.id);
    const tags: PeriodicTags | null = tagSet
      ? { setupGrade: tagSet.setup_grade, liquidityContext: tagSet.liquidity_context, mssTimeframe: tagSet.mss_timeframe, tags: tagSet.tags, source: "V2", recordedAt: tagSet.recorded_at }
      : input.legacyTags && (trade.setup_grade || trade.liquidity_context || trade.mss_timeframe)
        ? { setupGrade: trade.setup_grade, liquidityContext: trade.liquidity_context, mssTimeframe: trade.mss_timeframe, tags: [], source: "V1", recordedAt: null }
        : null;
    const entries: PeriodicJournalEntry[] = journal.filter(row => row.trade_id === link.id)
      .map(row => ({ id: row.id, kind: row.kind, body: row.body, details: row.details, phase: row.phase, recordedAt: row.recorded_at }));
    return {
      plan, trade, tradeRecordId: link.id, entryRecordedAt: link.entry_recorded_at, closeRecordedAt: link.close_recorded_at,
      strategy, risk, events: events.filter(row => row.plan_id === trade.id).map(({ plan_id: _plan, ...event }) => event), journal: entries, tags,
    };
  });
}

/** Journal entries and events of a scope, counted. */
export interface PeriodicRecordCounts {
  journalEntries: number;
  events: number;
}
const recordCount = z.number().int().nonnegative();

/**
 * How many journal entries and events of the trades are in scope, with the same filters `loadPeriodicSources` reads
 * them with but without reading any of them (exact head counts): what a deterministic summary states it leaves out.
 * Throws when a trade has no V2 trade identity or a count is unavailable.
 */
export async function countPeriodicRecords(input: Pick<PeriodicLoadInput, "db" | "userId" | "accountId" | "trades" | "scope">): Promise<PeriodicRecordCounts> {
  const { db, accountId, trades } = input;
  if (!trades.length) return { journalEntries: 0, events: 0 };
  const ids = trades.map(trade => trade.id);
  const [eventsQuery, linksQuery] = await Promise.all([
    eventsInScope(input, ids, { columns: "id", count: "HEAD" }),
    db.from("trade_ledger").select("id,plan_id").eq("account_id", accountId).in("plan_id", ids),
  ]);
  if (eventsQuery.error || linksQuery.error) throw new Error("Periodic context unavailable");
  const links = z.array(ledgerLink.pick({ id: true, plan_id: true })).parse(linksQuery.data);
  if (trades.some(trade => !links.some(link => link.plan_id === trade.id))) throw new Error("Original periodic records unavailable");
  const journalQuery = await journalInScope(input, links.map(link => link.id), { columns: "id", count: "HEAD" });
  if (journalQuery.error) throw new Error("Periodic context unavailable");
  const journalEntries = recordCount.safeParse(journalQuery.count);
  const events = recordCount.safeParse(eventsQuery.count);
  if (!journalEntries.success || !events.success) throw new Error("Periodic context unavailable");
  return { journalEntries: journalEntries.data, events: events.data };
}
