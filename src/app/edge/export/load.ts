import "server-only";
import { z } from "zod";
import { stripZeros } from "@/domain/format";
import type { LedgerTrade } from "@/domain/ledger";
import { addDays, isInstant, strategyDay } from "@/domain/time-display";
import { type ContextAccount, type Db, loadAccount, loadAccounts, resolveAccountContext } from "@/lib/account-context";
import { loadLedgerRows } from "@/lib/performance-data";
import { RequestError } from "@/lib/route-security";
import { filteredScope, inBatches, type TradeFilters, type TradeScope } from "@/lib/trades-data";
import {
  closedTradesCsv, dailySequences, type EntryRecord, type ExportScope, exitOrder, exportFilename, parseExportRequest, TOO_MANY_TRADES,
} from "./contract";

/**
 * Reads EDGE's closed-trades CSV (./contract.ts) with the user's session: every read is RLS scoped, and the trades come
 * from the loader EDGE uses (`loadLedgerRows`, closed trades only), so the file holds exactly what the page counts.
 */

export const ACCOUNT_UNAVAILABLE = "That trading account isn't available.";

const PAGE = 500;
const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const entryRow = z.object({ id: z.uuid(), account_id: z.uuid(), entered_at: z.string().refine(isInstant) });
const riskRow = z.object({ id: z.uuid(), risk_percent: decimalText.nullable() });

export interface ClosedTradesFile {
  csv: string;
  filename: string;
}

interface ResolvedScope {
  scope: TradeScope;
  /** Trading accounts the file may name (the user's accounts, or the one requested). */
  accounts: readonly ContextAccount[];
}

/**
 * The accounts a request covers: an explicit account (archived ones too) must be one of the user's; without one, the
 * request's account context decides exactly as on EDGE (an unavailable stored account means All Accounts).
 */
async function resolveScope(db: Db, userId: string, scope: ExportScope, storedContext: string | undefined): Promise<ResolvedScope> {
  if (scope.mode === "account") {
    const account = await loadAccount(db, userId, scope.accountId);
    if (account === null) throw new RequestError(ACCOUNT_UNAVAILABLE, 404);
    return { scope: { mode: "account", accountId: account.id }, accounts: [account] };
  }
  const accounts = await loadAccounts(db, userId);
  if (scope.mode === "context") {
    const { selected } = resolveAccountContext({ accounts, stored: storedContext, lastAccount: null, proxyNotice: false });
    if (selected.mode === "account") return { scope: { mode: "account", accountId: selected.account.id }, accounts };
  }
  return { scope: { mode: "all" }, accounts };
}

/**
 * The account a file holds, which names it: the account of its scope or, in All Accounts, the one EDGE's read-only
 * account filter narrows the read to (`filteredScope`, as the loader applies it); null for every account. A filter
 * naming an account the user cannot read matches no trade, so that header-only file keeps the All Accounts name.
 */
function fileAccount({ scope, accounts }: ResolvedScope, filters: TradeFilters): ContextAccount | null {
  const reads = filteredScope(scope, filters);
  return reads.mode === "account" ? (accounts.find(account => account.id === reads.accountId) ?? null) : null;
}

/** First instant of a strategy day (UTC−5) and of the day after it. */
function dayStart(day: string): string {
  return `${day}T05:00:00Z`;
}

/**
 * Entry times of every executed trade (any origin, open or closed) of the given trades' accounts on the strategy days
 * they were entered: the input of the V1 dailySequence column.
 */
async function entryRecords(db: Db, trades: readonly LedgerTrade[]): Promise<EntryRecord[]> {
  const days = trades.flatMap(trade => (trade.entered_at === null ? [] : [strategyDay(trade.entered_at)])).sort();
  if (days.length === 0) return [];
  const accountIds = [...new Set(trades.filter(trade => trade.entered_at !== null).map(trade => trade.account_id))].sort();
  const records: EntryRecord[] = [];
  for (const ids of inBatches(accountIds)) {
    for (let after: string | null = null; ;) {
      let query = db.from("trade_ledger").select("id,account_id,entered_at").in("account_id", ids).is("trashed_at", null)
        .gte("entered_at", dayStart(days[0])).lt("entered_at", dayStart(addDays(days[days.length - 1], 1)));
      if (after !== null) query = query.gt("id", after);
      const { data, error } = await query.order("id", { ascending: true }).limit(PAGE);
      if (error) throw new Error("Trades are unavailable.");
      const page = z.array(entryRow).parse(data ?? []);
      records.push(...page.map(row => ({ id: row.id, accountId: row.account_id, enteredAt: row.entered_at })));
      if (page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
  }
  return records;
}

/** V1 risk_percent of each locked plan, exactly as `journal_analytics` computes it (canonical decimal text). */
async function riskPercents(db: Db, trades: readonly LedgerTrade[]): Promise<Map<string, string>> {
  const planIds = [...new Set(trades.flatMap(trade => (trade.plan_id === null ? [] : [trade.plan_id])))].sort();
  const percents = new Map<string, string>();
  for (const ids of inBatches(planIds)) {
    const { data, error } = await db.from("journal_analytics").select("id,risk_percent").in("id", ids);
    if (error) throw new Error("Trades are unavailable.");
    for (const row of z.array(riskRow).parse(data ?? [])) if (row.risk_percent !== null) percents.set(row.id, stripZeros(row.risk_percent));
  }
  return percents;
}

/**
 * The CSV a request asks for. `storedContext` is the request's `tos_account` cookie (used only without an explicit
 * account); `now` is the server time EDGE's presets and the file name's day are relative to.
 */
export async function closedTradesExport(db: Db, userId: string, params: URLSearchParams, storedContext: string | undefined, now: string): Promise<ClosedTradesFile> {
  const parsed = parseExportRequest(params, now);
  if (!parsed.ok) throw new RequestError(parsed.error, 400);
  const { scope: requested, filters, withoutEntryTime, last } = parsed.request;
  const resolved = await resolveScope(db, userId, requested, storedContext);
  const loaded = await loadLedgerRows(db, userId, resolved.scope, filters, { closedOnly: true });
  if (loaded.truncated) throw new RequestError(TOO_MANY_TRADES, 422);
  const matching = (withoutEntryTime ? loaded.rows.filter(trade => trade.entered_at === null) : loaded.rows).sort(exitOrder());
  const trades = last === null ? matching : matching.slice(-last);
  const [entries, percents] = await Promise.all([entryRecords(db, trades), riskPercents(db, trades)]);
  const csv = closedTradesCsv(trades, {
    accountNames: new Map(resolved.accounts.map(item => [item.id, item.name])),
    sequences: dailySequences(entries),
    riskPercents: percents,
  });
  return { csv, filename: exportFilename(fileAccount(resolved, filters)?.name ?? null, strategyDay(now)) };
}
