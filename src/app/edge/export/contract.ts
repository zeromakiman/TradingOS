import { type EdgeQuery, edgeFilters, parseEdgeQuery } from "@/components/edge/query";
import type { LedgerTrade } from "@/domain/ledger";
import { strategyClock } from "@/domain/session";
import { instantComparer, instantMicros, strategyDay, WEEKDAY_NAMES, weekdayIndex } from "@/domain/time-display";
import { csvCell } from "@/lib/export";
import { MAX_LEDGER_ROWS } from "@/lib/performance-data";
import { type TradeFilters, tradeFilterParams } from "@/lib/trades-data";

/**
 * EDGE's closed-trades CSV (`GET /edge/export`, docs/V2_ARCHITECTURE.md §1.2, §9.3, §14.6): the link EDGE builds, the
 * request contract and the file format. Pure; ./load.ts reads the rows with the user's session.
 *
 * What a file holds: every closed trade (planned, live-first and imported) of its scope that EDGE's filters select,
 * read with the page's own parser (`parseEdgeQuery`, `edgeFilters`) and loader, so the file and the page of one link
 * count the same trades.
 * - Scope `account`: `all` (every trading account, archived ones included, like All Accounts), one of the user's
 *   accounts by id (archived ones too: their history stays exportable), or absent (the request's account context).
 * - EDGE filters: `range` (presets relative to today's strategy day), `closedFrom`, `closedTo`, `model`, `session`,
 *   `origin`, `instrument`, the filters a link carries (`weekday`, `strategy`, `riskPlan`, `result`), the read-only
 *   `accountFilter`, and any filter EDGE adds later. EDGE's links carry the page's effective exit-day bounds, so a file
 *   downloaded after midnight still holds what the page showed. Calendar navigation (`month`, `day`, `view`,
 *   `currency`) never changes the file.
 * - V1 filters, read by the same parser with their V1 meanings, so links of the V1 EDGE page keep working: `from`/`to`
 *   (exit-day bounds: V1 dated closed trades by their exit), `session` with V1 names (`ASIAN_RANGE` = Asia, `OTHER` =
 *   no recorded entry time), `weekday`, `strategy` (strategy version id), `risk` (risk-plan version id), `outcome`,
 *   `period` (`month` | `last30`). Only the file applies `session=OTHER` and `period=last30` (the page says it does
 *   not); an inverted `from`/`to` is refused with V1's message (the page reads it the way it was meant).
 * Every filter narrows the result (bounds intersect). A value that cannot be read is refused by name, never ignored:
 * a file that silently dropped a filter would hold trades the trader did not ask for.
 *
 * Format: the V1 columns first, in V1 order and with V1 meanings, so existing spreadsheets keep working; the columns
 * V2 adds follow them. Money columns (fees, initial_risk, net_pnl) are in each trade's own account currency, named by
 * the `currency` column, and never converted. Decimals are the database's exact values in canonical form (trailing
 * zeros trimmed, as in `trade_ledger`). UTF-8 with a byte-order mark, like the data export's trades CSV: the `account`
 * column holds the trader's own account names, which spreadsheets opened without it would read with a legacy code
 * page. CRLF rows and no trailing newline (as in V1), the header alone when nothing matches, every cell quoted and
 * guarded against spreadsheet formulas.
 */

export const EXPORT_PATH = "/edge/export";

/** Scope value of every trading account (All Accounts). */
export const ALL_ACCOUNTS_SCOPE = "all";

/**
 * Why no file is offered or served: more closed trades match than one read returns (EDGE's own limit), so a file
 * could hold only part of them. The route refuses with it (422) and EDGE shows it instead of the download links.
 */
export const TOO_MANY_TRADES = `More than ${MAX_LEDGER_ROWS.toLocaleString("en-US")} closed trades match. Narrow the date range and export again.`;

/**
 * The CSV of an EDGE state: its scope (`all` or an account id) and exactly the ledger filters the page applies
 * (`edgeFilters`: effective exit-day bounds, the dimensions, the filters a link carried and the account filter), in
 * the page's own parameter names.
 */
export function exportHref(query: EdgeQuery, account: string): string {
  const params = new URLSearchParams({ account });
  for (const [key, value] of tradeFilterParams(edgeFilters(query))) params.append(key, value);
  return `${EXPORT_PATH}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------------------
// Request contract.
// ---------------------------------------------------------------------------------------------------------
export type ExportScope = { mode: "context" } | { mode: "all" } | { mode: "account"; accountId: string };

export interface ExportRequest {
  scope: ExportScope;
  /** Ledger filters of the closed trades (EDGE semantics: exit-day bounds, entry session and weekday). */
  filters: TradeFilters;
  /** V1 `session=OTHER`: only trades without a recorded entry time. */
  withoutEntryTime: boolean;
  /** V1 `period=last30`: the last N closed trades in exit order, after every other filter. */
  last: number | null;
}

export type ParsedExportRequest = { ok: true; request: ExportRequest } | { ok: false; error: string };

/** EDGE parameters that only navigate the page (calendar month and mode, the day sheet): they never change the file. */
const NAVIGATION_KEYS: readonly string[] = ["month", "day", "view", "currency"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function readOne(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key).map(value => value.trim()).filter(Boolean);
  return values.length ? values[values.length - 1] : undefined;
}

/** The export a URL asks for; `now` is the server time EDGE's range presets and V1 `period=month` are relative to. */
export function parseExportRequest(params: URLSearchParams, now: string): ParsedExportRequest {
  const invalid: string[] = [];

  const account = readOne(params, "account")?.toLowerCase();
  let scope: ExportScope = { mode: "context" };
  if (account === ALL_ACCOUNTS_SCOPE) scope = { mode: "all" };
  else if (account !== undefined && UUID.test(account)) scope = { mode: "account", accountId: account };
  else if (account !== undefined) invalid.push("account");

  // EDGE's own parser reads every filter, V1 names included, exactly as the page reads the same link.
  const edge = new URLSearchParams(params);
  edge.delete("account");
  const query = parseEdgeQuery(edge, now);
  invalid.push(...query.invalid.filter(key => !NAVIGATION_KEYS.includes(key)));

  if (invalid.length) return { ok: false, error: `Some filters in this export link couldn't be read: ${[...new Set(invalid)].join(", ")}.` };
  // V1 refused an inverted range of exit days; the file still does (the page reads it the way it was meant).
  const from = readOne(params, "from");
  const to = readOne(params, "to");
  if (from !== undefined && to !== undefined && from > to) return { ok: false, error: "Start date must be on or before end date." };
  return { ok: true, request: { scope, filters: edgeFilters(query), withoutEntryTime: query.withoutEntryTime === true, last: query.lastClosed ?? null } };
}

// ---------------------------------------------------------------------------------------------------------
// File format.
// ---------------------------------------------------------------------------------------------------------
/** The V1 columns, in V1 order and with V1 meanings. */
export const LEGACY_COLUMNS = [
  "instrument", "entry_model", "direction", "status", "strategy_version", "risk_plan_version", "planned_entry", "initial_stop", "entry_price",
  "quantity", "entered_at", "exit_price", "exited_at", "fees", "initial_risk", "risk_percent", "net_pnl", "realized_r", "outcome", "session",
  "weekday", "dailySequence", "setup_grade", "liquidity_context", "mss_timeframe", "tag_source",
] as const;

/**
 * Columns V2 adds after the V1 ones: the trade's origin, its trading account and that account's currency (the
 * currency of every money column of the row), the strategy day of the exit (the day EDGE's date filters and calendar
 * use), the risk per trade the plan requested, where the net P&L came from (calculated by Trading OS, reported by the
 * trader or imported from the platform), whether the trader completed the review, and the trade's tags.
 */
export const ADDED_COLUMNS = ["origin", "account", "currency", "exit_day", "requested_risk_percent", "pnl_source", "lifecycle", "tags"] as const;

export const CSV_COLUMNS = [...LEGACY_COLUMNS, ...ADDED_COLUMNS] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export interface CsvContext {
  /** Display name of each trading account in the file, by account id. */
  accountNames: ReadonlyMap<string, string>;
  /** V1 dailySequence by trade id (see `dailySequences`). */
  sequences: ReadonlyMap<string, number | null>;
  /**
   * V1 risk_percent by plan id: the locked plan's nominal risk in percent of the equity it was checked against, as the
   * database computes it (`journal_analytics`). Trades without a locked plan have none.
   */
  riskPercents: ReadonlyMap<string, string>;
}

/** V1 entry session names: Asia was ASIAN_RANGE, and a trade without a recorded entry time had OTHER. */
export function legacySession(enteredAt: string | null): string {
  if (enteredAt === null) return "OTHER";
  const { session } = strategyClock(enteredAt);
  return session === "ASIA" ? "ASIAN_RANGE" : session;
}

/** V1 entry weekday (of the entry's strategy day); NO DATA without a recorded entry time. */
export function legacyWeekday(enteredAt: string | null): string {
  return enteredAt === null ? "NO DATA" : WEEKDAY_NAMES[weekdayIndex(strategyDay(enteredAt))];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Closed trades in exit order (microsecond exact), then by id, as V1 listed them. A comparer per sort: each exit time
 * is parsed once (`instantComparer`).
 */
export function exitOrder(): (a: Pick<LedgerTrade, "exited_at" | "id">, b: Pick<LedgerTrade, "exited_at" | "id">) => number {
  const compare = instantComparer();
  return (a, b) => {
    if (a.exited_at !== null && b.exited_at !== null) {
      const order = compare(a.exited_at, b.exited_at);
      if (order !== 0) return order;
    }
    return compareIds(a.id, b.id);
  };
}

export interface EntryRecord {
  id: string;
  accountId: string;
  enteredAt: string;
}

/**
 * V1 dailySequence: the position of each executed trade among its trading account's executed trades (every origin,
 * open or closed) entered on the same strategy day, by entry time. Trades with the same recorded entry time have no
 * authoritative order, so every trade of that day is unknown (null), as in V1.
 */
export function dailySequences(entries: readonly EntryRecord[]): Map<string, number | null> {
  const days = new Map<string, { id: string; micros: bigint }[]>();
  for (const entry of entries) {
    const key = `${entry.accountId}/${strategyDay(entry.enteredAt)}`;
    const day = days.get(key) ?? [];
    day.push({ id: entry.id, micros: instantMicros(entry.enteredAt) });
    days.set(key, day);
  }
  const sequences = new Map<string, number | null>();
  for (const day of days.values()) {
    day.sort((a, b) => (a.micros < b.micros ? -1 : a.micros > b.micros ? 1 : compareIds(a.id, b.id)));
    const ordered = new Set(day.map(entry => entry.micros)).size === day.length;
    for (const [index, entry] of day.entries()) sequences.set(entry.id, ordered ? index + 1 : null);
  }
  return sequences;
}

function rowValues(trade: LedgerTrade, context: CsvContext): Record<CsvColumn, unknown> {
  return {
    instrument: trade.symbol,
    entry_model: trade.entry_model,
    direction: trade.direction,
    // The file lists closed trades only (V1: status CLOSED); whether the review was completed is in `lifecycle`.
    status: "CLOSED",
    strategy_version: trade.strategy_version,
    risk_plan_version: trade.risk_plan_version,
    planned_entry: trade.planned_entry,
    initial_stop: trade.initial_stop,
    entry_price: trade.entry_price,
    quantity: trade.quantity,
    entered_at: trade.entered_at,
    exit_price: trade.exit_price,
    exited_at: trade.exited_at,
    fees: trade.fees,
    initial_risk: trade.initial_risk,
    risk_percent: trade.plan_id === null ? null : (context.riskPercents.get(trade.plan_id) ?? null),
    net_pnl: trade.net_pnl,
    realized_r: trade.realized_r,
    outcome: trade.outcome,
    session: legacySession(trade.entered_at),
    weekday: legacyWeekday(trade.entered_at),
    dailySequence: context.sequences.get(trade.id) ?? null,
    setup_grade: trade.setup_grade,
    liquidity_context: trade.liquidity_context,
    mss_timeframe: trade.mss_timeframe,
    // V1 named the source of its tag records (always MANUAL); V2 tags are recorded by the trader too.
    tag_source: trade.tag_source === null ? null : "MANUAL",
    origin: trade.origin,
    account: context.accountNames.get(trade.account_id) ?? null,
    currency: trade.currency,
    exit_day: trade.exited_at === null ? null : strategyDay(trade.exited_at),
    requested_risk_percent: trade.requested_risk_percent,
    pnl_source: trade.pnl_source,
    lifecycle: trade.lifecycle,
    tags: trade.tags,
  };
}

/** UTF-8 byte-order mark: spreadsheets read the file as UTF-8 instead of guessing a legacy code page. */
export const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The file: a byte-order mark, the header, then one row per trade in the given order (CRLF, no trailing newline). */
export function closedTradesCsv(trades: readonly LedgerTrade[], context: CsvContext): string {
  const lines = trades.map(trade => {
    const values = rowValues(trade, context);
    return CSV_COLUMNS.map(column => csvCell(values[column])).join(",");
  });
  return `${BYTE_ORDER_MARK}${[CSV_COLUMNS.join(","), ...lines].join("\r\n")}`;
}

/** `trading-os-closed-trades-<account | all-accounts>-<day>.csv`, ASCII only (safe in a Content-Disposition header). */
export function exportFilename(accountName: string | null, day: string): string {
  const slug = accountName === null
    ? "all-accounts"
    : accountName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "account";
  return `trading-os-closed-trades-${slug}-${day}.csv`;
}
