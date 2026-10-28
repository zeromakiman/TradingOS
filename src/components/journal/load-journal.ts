import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { strategyDay, type TimeDisplay } from "@/domain/time-display";
import { currentSession, getAccountContext, getPreferences } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import {
  countTrades, decodeTradeCursor, encodeTradeCursor, groupByTradeDay, JOURNAL_PAGE_SIZE, listTrades, parseTradeFilters, resolveAccountFilter,
  type TradeCounts, type TradeFilters, type TradeListPage,
} from "@/lib/trades-data";
import type { JournalView } from "./types";
import { buildJournalView, FIRST_PAGE_TOKEN, type JournalInput, MAX_TRAIL, rangeErrors, splitDays } from "./view-model";

/**
 * Loads the Journal (docs/V2_ARCHITECTURE.md §14.5) for one request: URL filters (`parseTradeFilters`, so EDGE,
 * calendar and Accounts drill-downs keep working), the account context of the shell (§9.2) and the read-only account
 * filter it may combine with, the display preferences, one keyset page of `listTrades` (read one trade past the page,
 * see `trimToPage`), the exact counts its paging copy states (`journalCounts`), and the names of version filters that
 * drill-down links carry as ids.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

function single(params: SearchParams, key: string): string | null {
  const value = params[key];
  const text = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

/** The keyset position of this page: only cursors `listTrades` wrote are accepted. */
export function readCursor(params: SearchParams): string | null {
  const cursor = single(params, "cursor");
  return cursor && decodeTradeCursor(cursor) ? cursor : null;
}

/** The way back to the newest page; an unreadable trail is dropped (the page then offers "Back to newest"). */
export function readTrail(params: SearchParams): string[] {
  const raw = single(params, "back");
  if (!raw) return [];
  const trail = raw.split(",").slice(-MAX_TRAIL);
  return trail.every(token => token === FIRST_PAGE_TOKEN || decodeTradeCursor(token) !== null) ? trail : [];
}

/**
 * One Journal page from a read of `JOURNAL_PAGE_SIZE + 1` trades. The extra trade is not shown: it proves that older
 * trades exist (the next page starts right after the last shown trade) and whether the last day continues there. A
 * read that returns at most a page keeps `listTrades`' own cursor, which is set only when its scan limit cut the read
 * short; whether that day continues is then unknown, so it is not claimed.
 */
export function trimToPage(fetched: TradeListPage, now: string, display: TimeDisplay): { page: TradeListPage; lastDayContinues: boolean } {
  if (fetched.rows.length <= JOURNAL_PAGE_SIZE) return { page: fetched, lastDayContinues: false };
  const rows = fetched.rows.slice(0, JOURNAL_PAGE_SIZE);
  const last = rows[rows.length - 1];
  const peek = fetched.rows[JOURNAL_PAGE_SIZE];
  return {
    page: { ...fetched, rows, groups: groupByTradeDay(rows, now, display), nextCursor: encodeTradeCursor({ t: last.tradeAt, id: last.id }) },
    lastDayContinues: peek.tradeDay === last.tradeDay,
  };
}

const versionRow = z.object({ id: z.uuid(), version: z.string().min(1) });

/** Names of the strategy and risk-plan versions named by id in a drill-down link (RLS session, owner filter). */
async function versionNames(filters: TradeFilters, page: TradeListPage | null): Promise<JournalInput["versionNames"]> {
  const fromRows = (pick: (row: TradeListPage["rows"][number]) => string | null) => {
    const name = page?.rows.map(pick).find(value => value !== null);
    return name ?? null;
  };
  let strategy = filters.strategyVersionId ? fromRows(row => (row.trade.strategy_version_id === filters.strategyVersionId ? row.trade.strategy_version : null)) : null;
  let riskPlan = filters.riskPlanVersionId ? fromRows(row => (row.trade.risk_plan_version_id === filters.riskPlanVersionId ? row.trade.risk_plan_version : null)) : null;
  const needStrategy = filters.strategyVersionId !== undefined && strategy === null;
  const needRiskPlan = filters.riskPlanVersionId !== undefined && riskPlan === null;
  if (!needStrategy && !needRiskPlan) return { strategy, riskPlan };
  const { db, user } = await currentSession();
  const [strategies, riskPlans] = await Promise.all([
    needStrategy ? db.from("strategy_versions").select("id,version").eq("user_id", user.id).eq("id", filters.strategyVersionId as string).limit(1) : null,
    needRiskPlan ? db.from("risk_plan_versions").select("id,version").eq("user_id", user.id).eq("id", filters.riskPlanVersionId as string).limit(1) : null,
  ]);
  // A name is a nicety: when it cannot be read the chip says "selected version".
  if (strategies && !strategies.error) strategy = z.array(versionRow).safeParse(strategies.data).data?.[0]?.version ?? null;
  if (riskPlans && !riskPlans.error) riskPlan = z.array(versionRow).safeParse(riskPlans.data).data?.[0]?.version ?? null;
  return { strategy, riskPlan };
}

/**
 * Exact counts for the paging copy of a list that spans pages: the total, and each trade day the page shares with the
 * previous or next page. A single page needs no count (it shows every trade). Counts only improve the wording, so a
 * count that cannot be read leaves the page as it is, without one.
 */
export async function journalCounts(filters: TradeFilters, page: TradeListPage, cursor: string | null, lastDayContinues: boolean): Promise<TradeCounts | null> {
  if (cursor === null && page.nextCursor === null) return null;
  const split = splitDays(page, cursor, lastDayContinues);
  try {
    return await countTrades(filters, [split.first, split.last].filter((day): day is string => day !== null));
  } catch (error) {
    unstable_rethrow(error);
    operationalFailure("data_read_failed");
    return null;
  }
}

export async function loadJournal(params: SearchParams): Promise<JournalView> {
  const parsed = parseTradeFilters(params);
  const [context, preferences] = await Promise.all([getAccountContext(), getPreferences()]);
  const { filters, state: accountFilter } = resolveAccountFilter(parsed.filters, context);
  const invalid = parsed.invalid;
  const now = new Date().toISOString();
  const cursor = readCursor(params);
  const trail = cursor ? readTrail(params) : [];
  const hasAccounts = context.accounts.length > 0;
  const impossible = rangeErrors(filters, strategyDay(now)).length > 0;
  const display = preferences.timeDisplay;
  const loaded = hasAccounts && !impossible ? trimToPage(await listTrades(filters, cursor, JOURNAL_PAGE_SIZE + 1), now, display) : null;
  const page = loaded?.page ?? null;
  const lastDayContinues = loaded?.lastDayContinues ?? false;
  const [counts, names] = await Promise.all([page ? journalCounts(filters, page, cursor, lastDayContinues) : null, versionNames(filters, page)]);
  return buildJournalView({
    filters,
    invalid,
    context: {
      mode: context.selected.mode,
      accountName: context.selected.mode === "account" ? context.selected.account.name : null,
      hasAccounts,
    },
    accountFilter,
    display,
    now,
    page,
    lastDayContinues,
    counts,
    cursor,
    trail,
    versionNames: names,
  });
}
