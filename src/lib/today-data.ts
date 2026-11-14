import "server-only";
import Decimal from "decimal.js";
import { z } from "zod";
import type { LedgerTrade } from "@/domain/ledger";
import { type DayResult, dayResult, isClosed } from "@/domain/performance";
import type { DailyUsage } from "@/domain/risk";
import { nextBoundary, type Session, type SessionBoundary, strategyClock } from "@/domain/session";
import { compareInstants, strategyDay, strategyDayLabel } from "@/domain/time-display";
import type { JournalKind } from "@/domain/timeline";
import { type AccountContext, type ContextAccount, currentSession, type Db, getAccountContext } from "./account-context";
import { loadLedgerRows } from "./performance-data";
import {
  ACCOUNT_READ_CONCURRENCY, accountScopes, decorateTrades, inBatches, ledgerSelect, mapLimited, newestCreatedFirst, openLedgerRows, parseLedger, type TradeListRow,
  type TradeScope,
} from "./trades-data";
import { type AccountWorkspace, getWorkspace, loadDailyUsage } from "./workspace";

/**
 * Today (docs/V2_ARCHITECTURE.md §14.1): session and next boundary, the trading status of every account in the context
 * (All Accounts: one row per ACTIVE account), live trades with their last journal item, plans waiting (drafts by check
 * state, locked plans waiting for entry), today's closed trades, today's realized result in R and money per currency,
 * and today's losses as the daily loss limit counts them. Trades are read for the whole context, so in All Accounts the
 * trades an archived account still holds or closed today are listed and counted too (archiving leaves open positions to
 * be finished); only the status rows are limited to active accounts. Everything is computed for the strategy day (fixed
 * UTC−5) of the server time; money is never summed across currencies.
 *
 * Live trades, locked plans and drafts are read by separate queries with their own bounds, so piles of drafts (V1
 * proposals were carried over as drafts and drafts never expire) can never push a live position or a locked plan off
 * the page. A list that reaches its bound says so in `truncated`; the Journal lists every trade.
 */

/** Exact sums for any stored scale (the global Decimal rounds at 20 digits). */
const M = Decimal.clone({ precision: 100 });
/** Live trades listed at most, newest first by creation. */
export const TODAY_LIVE_LIMIT = 500;
/** Locked plans and drafts listed at most, each, newest first by creation. */
export const TODAY_WAITING_LIMIT = 200;
/** Journal rows read per request while finding each live trade's newest item. */
const JOURNAL_PAGE = 500;

/** Today's losses in one currency (an account's currency, or a currency of the context). */
export interface TodayLosses {
  currency: string;
  /** Losses of trades closed today, planned and live-first: Σ max(0, −net P&L). */
  realized: string;
  /** External losses entered for today (removed entries excluded). */
  external: string;
  /**
   * The loss total a V1 account-values entry reported for today (only on the day of the switch to V2), else null.
   * Per currency: the sum over the accounts that have one.
   */
  legacyReported: string | null;
  /**
   * Today's losses as the daily loss limit counts them (`usage.lossTotal`): realized + external, or the V1 reported
   * total when that is greater. Show this figure next to the limit, so the display never contradicts a block.
   */
  total: string;
}

export interface TodayAccountStatus {
  account: ContextAccount;
  workspace: AccountWorkspace;
  losses: TodayLosses;
}

export interface LastJournalItem {
  kind: JournalKind;
  body: string | null;
  details: Record<string, unknown>;
  recordedAt: string;
  /** V2 journal entry or a V1 plan note. */
  source: "JOURNAL" | "V1_NOTE";
}

export interface LiveTradeCard {
  row: TradeListRow;
  /** Entry time when known, else when the position was recorded. */
  liveSince: string;
  lastJournal: LastJournalItem | null;
}

export interface WaitingPlans {
  ready: TradeListRow[];
  blocked: TradeListRow[];
  /** Approved earlier or with changed account state: needs a new check before locking. */
  recheck: TradeListRow[];
  /** Saved but never checked. */
  unchecked: TradeListRow[];
  /** Locked plans waiting for entry. */
  locked: TradeListRow[];
}

/** Lists that reached their bound: more trades exist than Today shows (the Journal lists every one). */
export interface TodayTruncation {
  /** More than TODAY_LIVE_LIMIT live trades. */
  live: boolean;
  /** More than TODAY_WAITING_LIMIT locked plans. */
  locked: boolean;
  /** More than TODAY_WAITING_LIMIT drafts. */
  drafts: boolean;
  /** More trades closed today than the ledger loader reads (MAX_LEDGER_ROWS); `result` then covers the rows read. */
  closed: boolean;
}

export interface TodayData {
  now: string;
  /** Strategy day of `now`. */
  day: string;
  /** `Tue, Oct 14 (UTC−5)`. */
  dayLabel: string;
  session: Session;
  boundary: SessionBoundary;
  context: AccountContext;
  accounts: TodayAccountStatus[];
  /** Every live trade of the context (up to TODAY_LIVE_LIMIT), most recently opened first. */
  live: LiveTradeCard[];
  plans: WaitingPlans;
  /** Every trade closed today in the context (archived accounts' included in All Accounts), latest exit first. */
  closedToday: TradeListRow[];
  /** Net R of today's exits (R is per-trade risk units) and net P&L per currency, over `closedToday`. */
  result: DayResult;
  /**
   * Today's losses per currency, as each account's daily usage counts them (realized and external), over the accounts
   * `result` covers: those of `accounts` (the selected account, or every ACTIVE account), plus in All Accounts every
   * account without a status row that closed a trade today (an archived account finishing a position it held).
   */
  losses: TodayLosses[];
  /** Today's plan · notes (V1 daily context) of the selected account; null in All Accounts or when none. */
  dailyContext: { narrative: string; recordedAt: string } | null;
  truncated: TodayTruncation;
  /** Nothing live, waiting or closed today: the page shows the two large actions. */
  empty: boolean;
}

const journalItemRow = z.object({
  id: z.uuid(), trade_id: z.uuid(), kind: z.enum(["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"]), body: z.string().nullable(),
  details: z.record(z.string(), z.unknown()), recorded_at: z.string(),
});
const noteRow = z.object({ id: z.uuid(), plan_id: z.uuid(), payload: z.record(z.string(), z.unknown()), recorded_at: z.string() });

/** The text of a V1 plan note; null for tag changes, which V1 journaled as MANUAL notes and which are not journal text. */
function v1NoteText(payload: Record<string, unknown>): string | null {
  return typeof payload.note === "string" && payload.source !== "MANUAL" ? payload.note : null;
}

/** `items` cut into consecutive parts of the given sizes. */
function splitBySizes<T>(items: readonly T[], sizes: readonly number[]): T[][] {
  const parts: T[][] = [];
  let start = 0;
  for (const size of sizes) {
    parts.push(items.slice(start, start + size));
    start += size;
  }
  return parts;
}

const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }) => compareInstants(b.at, a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

interface KeyedRow<T> {
  key: string;
  recordedAt: string;
  id: string;
  row: T;
}

/** Keyset position: rows strictly older than (`recordedAt`, `id`) in newest-first order. */
function olderThan(after: { recordedAt: string; id: string }): string {
  // Values are double-quoted so PostgREST never reads the timestamp's punctuation as filter syntax.
  return `recorded_at.lt."${after.recordedAt}",and(recorded_at.eq."${after.recordedAt}",id.lt."${after.id}")`;
}

/**
 * The newest accepted row of every key, exactly. Rows are read newest first in pages of JOURNAL_PAGE for at most
 * IN_FILTER_BATCH keys per request. While a page is full, the next one continues after its last row (keyset) for the
 * keys that still have no accepted row: every row newer than that position was on the page already, so nothing is
 * skipped, and no row is read twice.
 */
async function newestPerKey<T>(
  keys: readonly string[],
  page: (keys: string[], after: { recordedAt: string; id: string } | null) => Promise<KeyedRow<T>[]>,
  accept: (row: T) => boolean,
): Promise<Map<string, KeyedRow<T>>> {
  const found = new Map<string, KeyedRow<T>>();
  await Promise.all(inBatches([...new Set(keys)]).map(async batch => {
    let pending = batch;
    let after: { recordedAt: string; id: string } | null = null;
    while (pending.length) {
      const rows = await page(pending, after);
      for (const item of rows) if (!found.has(item.key) && accept(item.row)) found.set(item.key, item);
      if (rows.length < JOURNAL_PAGE) return;
      const last = rows[rows.length - 1];
      after = { recordedAt: last.recordedAt, id: last.id };
      pending = pending.filter(key => !found.has(key));
    }
  }));
  return found;
}

/** The newest V2 journal entry or V1 plan note of each live trade. */
async function lastJournalItems(db: Db, userId: string, live: readonly LedgerTrade[]): Promise<Map<string, LastJournalItem>> {
  const items = new Map<string, LastJournalItem>();
  if (!live.length) return items;
  const planOf = new Map(live.flatMap(trade => (trade.plan_id === null ? [] : [[trade.plan_id, trade.id] as const])));
  const [entries, notes] = await Promise.all([
    newestPerKey(live.map(trade => trade.id), async (tradeIds, after) => {
      let query = db.from("trade_journal_entries").select("id,trade_id,kind,body,details,recorded_at").eq("user_id", userId).in("trade_id", tradeIds);
      if (after) query = query.or(olderThan(after));
      const { data, error } = await query.order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(JOURNAL_PAGE);
      if (error) throw new Error("Journal entries are unavailable.");
      return z.array(journalItemRow).parse(data ?? []).map(row => ({ key: row.trade_id, recordedAt: row.recorded_at, id: row.id, row }));
    }, () => true),
    newestPerKey([...planOf.keys()], async (planIds, after) => {
      let query = db.from("trade_events").select("id,plan_id,payload,recorded_at").eq("user_id", userId).eq("event_type", "NOTE_ADDED").in("plan_id", planIds);
      if (after) query = query.or(olderThan(after));
      const { data, error } = await query.order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(JOURNAL_PAGE);
      if (error) throw new Error("Journal entries are unavailable.");
      return z.array(noteRow).parse(data ?? []).map(row => ({
        key: row.plan_id, recordedAt: row.recorded_at, id: row.id, row: { note: v1NoteText(row.payload), recordedAt: row.recorded_at },
      }));
    }, row => row.note !== null),
  ]);
  for (const [tradeId, { row }] of entries) {
    items.set(tradeId, { kind: row.kind, body: row.body, details: row.details, recordedAt: row.recorded_at, source: "JOURNAL" });
  }
  for (const [planId, { row }] of notes) {
    const tradeId = planOf.get(planId);
    if (!tradeId) continue;
    const current = items.get(tradeId);
    // A V1 note replaces a V2 entry only when it is strictly newer.
    if (!current || compareInstants(current.recordedAt, row.recordedAt) < 0) {
      items.set(tradeId, { kind: "NOTE", body: row.note, details: {}, recordedAt: row.recordedAt, source: "V1_NOTE" });
    }
  }
  return items;
}

/** One account's losses today, exactly as the engine counts them (spec §6.2). */
function lossesOfUsage(currency: string, usage: DailyUsage): TodayLosses {
  return { currency, realized: usage.realizedLoss, external: usage.externalLoss, legacyReported: usage.legacyReportedLoss, total: usage.lossTotal };
}

function lossesOf(workspace: AccountWorkspace): TodayLosses {
  return lossesOfUsage(workspace.account.currency, workspace.usage);
}

/**
 * All Accounts: today's losses of the accounts that have no status row but closed a trade `result` counts (an archived
 * account finishing a position it held, docs/V2_ARCHITECTURE.md §3.2), from the same daily usage as a row's, so the
 * summary's losses cover the same accounts as its result, external losses included. Usually there are none, and no
 * request is made.
 */
async function lossesWithoutRow(db: Db, context: AccountContext, rows: ReadonlyMap<string, AccountWorkspace>, closed: readonly LedgerTrade[], day: string): Promise<TodayLosses[]> {
  if (context.selected.mode !== "all") return [];
  const accounts = new Map(context.accounts.map(account => [account.id, account] as const));
  // `dayResult`'s own rule: closed, with the exit on the strategy day.
  const ids = new Set(closed.filter(trade => !rows.has(trade.account_id) && isClosed(trade) && strategyDay(trade.exited_at as string) === day).map(trade => trade.account_id));
  return Promise.all([...ids].flatMap(id => {
    const account = accounts.get(id);
    return account ? [loadDailyUsage(db, id).then(usage => lossesOfUsage(account.currency, usage))] : [];
  }));
}

/** Per-currency sums of account losses (never across currencies), ordered by currency. */
function lossesByCurrency(accounts: readonly TodayLosses[]): TodayLosses[] {
  const sums = new Map<string, { realized: Decimal; external: Decimal; legacy: Decimal | null; total: Decimal }>();
  for (const losses of accounts) {
    const sum = sums.get(losses.currency) ?? { realized: new M(0), external: new M(0), legacy: null, total: new M(0) };
    sum.realized = sum.realized.plus(losses.realized);
    sum.external = sum.external.plus(losses.external);
    if (losses.legacyReported !== null) sum.legacy = (sum.legacy ?? new M(0)).plus(losses.legacyReported);
    sum.total = sum.total.plus(losses.total);
    sums.set(losses.currency, sum);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, sum]) => ({
    currency, realized: sum.realized.toFixed(), external: sum.external.toFixed(), legacyReported: sum.legacy?.toFixed() ?? null, total: sum.total.toFixed(),
  }));
}

export interface TodayDeps {
  db: Db;
  userId: string;
  context: AccountContext;
  /** Workspaces of the accounts shown (selected account, or every ACTIVE account), at `now`. */
  workspaces: readonly AccountWorkspace[];
  now: string;
}

/** The first `limit` trades of a newest-first list; `truncated` when more exist. */
function bounded(trades: readonly LedgerTrade[], limit: number): { trades: LedgerTrade[]; truncated: boolean } {
  return { trades: trades.slice(0, limit), truncated: trades.length > limit };
}

/**
 * Drafts, newest first by creation, at most `limit`; `truncated` when more exist. Every draft is a planned trade without
 * a locked plan, so the read names the ledger's plain `origin` and `plan_id` columns next to `lifecycle`: PostgreSQL then
 * skips every other trade before it derives lifecycles (about 20 ms instead of 1.2 s per account of 15,000 trades), and
 * the result is the same. All Accounts reads each account on its own (`accountScopes`) and merges.
 */
async function draftsIn(db: Db, scope: TradeScope, accounts: readonly ContextAccount[], limit: number): Promise<{ trades: LedgerTrade[]; truncated: boolean }> {
  const reads = await mapLimited(accountScopes(scope, accounts), ACCOUNT_READ_CONCURRENCY, async reads => {
    let query = ledgerSelect(db).eq("lifecycle", "DRAFT").eq("origin", "PLANNED").is("plan_id", null).is("trashed_at", null);
    if (reads.mode === "account") query = query.eq("account_id", reads.accountId);
    const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (error) throw new Error("Today's trades are unavailable.");
    return parseLedger(data);
  });
  return bounded(reads.flat().sort(newestCreatedFirst), limit);
}

/**
 * Live trades and locked plans waiting for entry, newest first by creation: the ledger rows of the context's open trades
 * (`openLedgerRows`, found through the base tables' keys), so neither list costs a pass over every trade of the context.
 */
async function openIn(db: Db, userId: string, scope: TradeScope) {
  try {
    const open = await openLedgerRows(db, userId, scope, ["LIVE", "LOCKED"]);
    return {
      live: bounded(open.filter(trade => trade.lifecycle === "LIVE"), TODAY_LIVE_LIMIT),
      locked: bounded(open.filter(trade => trade.lifecycle === "LOCKED"), TODAY_WAITING_LIMIT),
    };
  } catch {
    throw new Error("Today's trades are unavailable.");
  }
}

export async function loadToday(deps: TodayDeps): Promise<TodayData> {
  const { db, userId, context, now } = deps;
  const clock = strategyClock(now);
  const day = clock.day;
  const scope: TradeScope = context.selected.mode === "account" ? { mode: "account", accountId: context.selected.account.id } : { mode: "all" };
  const [{ live, locked }, drafts, closed, dailyContext] = await Promise.all([
    openIn(db, userId, scope),
    draftsIn(db, scope, context.accounts, TODAY_WAITING_LIMIT),
    // Every exit of the strategy day: today's result must never be computed from part of the day.
    loadLedgerRows(db, userId, scope, { closedFrom: day, closedTo: day }, { closedOnly: true }),
    scope.mode === "account"
      ? db.from("daily_contexts").select("narrative,recorded_at").eq("account_id", scope.accountId).eq("user_id", userId).eq("trading_day", day)
        .order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dailyContext.error) throw new Error("Today's trades are unavailable.");
  // closedOnly rows always carry an exit time.
  const closedTrades = [...closed.rows].sort((a, b) => newestFirst({ at: a.exited_at ?? a.created_at, id: a.id }, { at: b.exited_at ?? b.created_at, id: b.id }));
  const workspaces = new Map(deps.workspaces.map(workspace => [workspace.account.id, workspace] as const));
  const groups = [live.trades, locked.trades, drafts.trades, closedTrades];
  const [rows, journal, outsideLosses] = await Promise.all([
    decorateTrades({ db, userId, accounts: context.accounts, now, workspaces }, groups.flat()),
    lastJournalItems(db, userId, live.trades),
    lossesWithoutRow(db, context, workspaces, closedTrades, day),
  ]);
  const [liveRows, lockedRows, draftRows, closedToday] = splitBySizes(rows, groups.map(group => group.length));

  const liveCards = liveRows.map(row => ({
    row, liveSince: row.trade.entered_at ?? row.trade.entry_recorded_at ?? row.trade.created_at, lastJournal: journal.get(row.id) ?? null,
  })).sort((a, b) => newestFirst({ at: a.liveSince, id: a.row.id }, { at: b.liveSince, id: b.row.id }));
  const plans: WaitingPlans = {
    ready: draftRows.filter(row => row.state.draftCheck === "APPROVED" && row.state.checkCurrent),
    blocked: draftRows.filter(row => row.state.draftCheck === "BLOCKED"),
    recheck: draftRows.filter(row => row.state.draftCheck === "APPROVED" && !row.state.checkCurrent),
    unchecked: draftRows.filter(row => row.state.draftCheck === "UNCHECKED"),
    locked: lockedRows,
  };

  const accounts = deps.workspaces.map(workspace => ({ account: workspace.account, workspace, losses: lossesOf(workspace) }));
  const contextRow = z.array(z.object({ narrative: z.string(), recorded_at: z.string() })).parse(dailyContext.data ?? [])[0];
  return {
    now,
    day,
    dayLabel: strategyDayLabel(day),
    session: clock.session,
    boundary: nextBoundary(now),
    context,
    accounts,
    live: liveCards,
    plans,
    closedToday,
    result: dayResult(closedTrades, day),
    losses: lossesByCurrency([...accounts.map(status => status.losses), ...outsideLosses]),
    dailyContext: contextRow ? { narrative: contextRow.narrative, recordedAt: contextRow.recorded_at } : null,
    truncated: { live: live.truncated, locked: locked.truncated, drafts: drafts.truncated, closed: closed.truncated },
    empty: liveCards.length === 0 && lockedRows.length === 0 && draftRows.length === 0 && closedToday.length === 0,
  };
}

/** Today of the request's account context. */
export async function getToday(): Promise<TodayData> {
  const [{ db, user }, context, view] = await Promise.all([currentSession(), getAccountContext(), getWorkspace()]);
  const workspaces = view.mode === "account" ? [view.workspace] : view.workspaces;
  return loadToday({ db, userId: user.id, context, workspaces, now: view.now });
}
