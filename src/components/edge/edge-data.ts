import "server-only";
import type { LedgerTrade } from "@/domain/ledger";
import type { BreakdownKey } from "@/domain/performance";
import { strategyDay, strategyMonth, type TimeDisplay } from "@/domain/time-display";
import { type AccountContext, currentSession, getAccountContext, getPreferences } from "@/lib/account-context";
import { buildPerformance, type LedgerRows, loadLedgerRows, type PerformanceView } from "@/lib/performance-data";
import type { FilterParams, TradeFilters, TradeScope } from "@/lib/trades-data";
import { type EdgeQuery, edgeFilters, parseEdgeQuery } from "./query";

/**
 * EDGE data (docs/V2_ARCHITECTURE.md §9.3, §14.6). One keyset read of the context's closed trades that match the
 * date range, model, session and origin; the instrument filter runs on those rows so the instrument picker can list
 * every instrument of the period. Everything after the read is pure (`assembleEdge`), so tests build the same view
 * from fixture rows.
 */

/** Breakdowns shown on EDGE (account contribution is added in All Accounts). */
export const EDGE_PAGE_BREAKDOWNS: readonly BreakdownKey[] = ["model", "session", "weekday", "origin", "riskPercent", "strategyVersion", "riskPlanVersion"];

export interface EdgeData {
  /** Server time of the request (presets, "today" on the calendar). */
  now: string;
  display: TimeDisplay;
  developerMode: boolean;
  context: AccountContext;
  query: EdgeQuery;
  /** Filters the statistics and drill-down links use. */
  filters: TradeFilters;
  /** Instruments of the context's closed trades in the period (the instrument picker), plus a selected one. */
  instruments: string[];
  /** Closed trades in the statistics (every filter applied). */
  rows: LedgerTrade[];
  /** Null when the user has no trading account yet. */
  view: PerformanceView | null;
  /** Calendar month shown. */
  month: string;
  truncated: boolean;
}

export interface AssembleInput {
  now: string;
  display: TimeDisplay;
  developerMode: boolean;
  context: AccountContext;
  query: EdgeQuery;
  /** Closed rows matching every filter except the instrument. */
  loaded: LedgerRows;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Calendar month: the one in the URL, else the month of the latest exit in the filtered trades, else the month the
 * date range ends in, else the current strategy month.
 */
export function defaultCalendarMonth(query: EdgeQuery, rows: readonly LedgerTrade[], now: string): string {
  if (query.month) return query.month;
  const latest = rows.reduce<string | null>((best, row) => {
    if (row.exited_at === null) return best;
    const day = strategyDay(row.exited_at);
    return best === null || day > best ? day : best;
  }, null);
  if (latest) return latest.slice(0, 7);
  if (query.closedTo) return query.closedTo.slice(0, 7);
  return strategyMonth(now);
}

/** Pure assembly of the EDGE view from the loaded rows. */
export function assembleEdge(input: AssembleInput): EdgeData {
  const { context, query, now } = input;
  const filters = edgeFilters(query);
  const symbols = new Set(input.loaded.rows.map(row => row.symbol).filter((symbol): symbol is string => symbol !== null));
  if (query.instrument) symbols.add(query.instrument);
  const rows = query.instrument ? input.loaded.rows.filter(row => row.symbol === query.instrument) : input.loaded.rows;
  const month = defaultCalendarMonth(query, rows, now);
  const view = context.accounts.length === 0
    ? null
    : // The calendar is built in Net R: its days then carry net R, money per currency and counts, which is every
      // value the client-side mode switch needs.
      buildPerformance(context, { rows, truncated: input.loaded.truncated }, filters, now, { month, calendarMode: "NET_R", breakdowns: EDGE_PAGE_BREAKDOWNS });
  return {
    now, display: input.display, developerMode: input.developerMode, context, query, filters,
    instruments: [...symbols].sort(compareText), rows, view, month, truncated: input.loaded.truncated,
  };
}

/** EDGE of the request's account context. */
export async function loadEdge(params: FilterParams): Promise<EdgeData> {
  const [{ db, user }, context, preferences] = await Promise.all([currentSession(), getAccountContext(), getPreferences()]);
  const now = new Date().toISOString();
  // The account filter applies in All Accounts only: a filter left in the URL by a context switch is dropped here.
  const query = parseEdgeQuery(params, now, context);
  const base = { now, display: preferences.timeDisplay, developerMode: preferences.developerMode, context, query };
  if (context.accounts.length === 0) return assembleEdge({ ...base, loaded: { rows: [], truncated: false } });
  const scope: TradeScope = context.selected.mode === "account" ? { mode: "account", accountId: context.selected.account.id } : { mode: "all" };
  const { instrument: _instrument, ...withoutInstrument } = edgeFilters(query);
  const loaded = await loadLedgerRows(db, user.id, scope, withoutInstrument, { closedOnly: true });
  return assembleEdge({ ...base, loaded });
}
