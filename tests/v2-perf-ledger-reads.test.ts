import { describe, expect, it, vi } from "vitest";

// Ledger reads at scale (Wave 4c perf track, measured at 19,900 trades in one account and 3 × 15,000 in All Accounts).
// The ledger derives lifecycle, trade dates and results per row from a dozen joins, so PostgreSQL can bound a read only
// by the trades' own columns: a filter on `lifecycle` makes it compute every trade of the account for each keyset page,
// and an All Accounts read ordered by id or creation computes every trade of every account first (2-4.6 s per query,
// past the 8 s statement timeout at 45,000 trades). These reads filter lifecycles on the parsed rows, split All Accounts
// into one read per account and merge, and read the palette's newest trades by id; rows and flags stay the same.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn(), loadAccountWorkspace: vi.fn(), loadDailyUsage: vi.fn() }));

import type { ContextAccount } from "@/lib/account-context";
import type { LedgerTrade, Lifecycle } from "@/domain/ledger";
import { loadLedgerRows, splitIdRange } from "@/lib/performance-data";
import { loadToday } from "@/lib/today-data";
import { loadPaletteTrades, openTradeIds } from "@/lib/trades-data";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
interface Call { table: string; filters: string[]; orders: string[]; limit: number | null }

/** Instants by time, anything else (uuids) by text, as PostgreSQL orders timestamptz and uuid values. */
function compare(a: unknown, b: string): number {
  const [x, y] = [String(a), b];
  if (/^\d{4}-\d{2}-\d{2}T/.test(x) && /^\d{4}-\d{2}-\d{2}T/.test(y)) return Date.parse(x) - Date.parse(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** PostgREST double: evaluates eq / in / gt / is null / not null, orders by the given columns and records every call. */
class TableDb {
  readonly calls: Call[] = [];
  constructor(readonly tables: Record<string, Row[]>) {}
  from(table: string) {
    const call: Call = { table, filters: [], orders: [], limit: null };
    this.calls.push(call);
    const predicates: Predicate[] = [];
    const orders: [string, boolean][] = [];
    const rows = this.tables[table] ?? [];
    const add = (text: string, predicate: Predicate) => { call.filters.push(text); predicates.push(predicate); return query; };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => add(`eq:${column}:${value}`, row => row[column] === value),
      in: (column: string, values: unknown[]) => add(`in:${column}`, row => values.includes(row[column])),
      gt: (column: string, value: string) => add(`gt:${column}:${value}`, row => row[column] !== null && compare(row[column], value) > 0),
      gte: (column: string, value: string) => add(`gte:${column}:${value}`, row => row[column] !== null && compare(row[column], value) >= 0),
      lt: (column: string, value: string) => add(`lt:${column}:${value}`, row => row[column] !== null && compare(row[column], value) < 0),
      is: (column: string, _value: null) => add(`is:${column}:null`, row => row[column] === null),
      not: (column: string, _operator: "is", _value: null) => add(`not:${column}:is:null`, row => row[column] !== null),
      order(column: string, options: { ascending?: boolean } = {}) { call.orders.push(column); orders.push([column, options.ascending ?? true]); return query; },
      limit(count: number) { call.limit = count; return query; },
      // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
      then<A>(resolve: (value: { data: Row[]; error: null }) => A) {
        const data = rows.filter(row => predicates.every(predicate => predicate(row))).sort((a, b) => {
          for (const [column, ascending] of orders) {
            const [x, y] = [String(a[column]), String(b[column])];
            if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        }).slice(0, call.limit ?? undefined);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return query;
  }
  ledgerCalls(): Call[] { return this.calls.filter(call => call.table === "trade_ledger"); }
}

const USER = "10000000-0000-4000-8000-000000000001";
const A1 = "20000000-0000-4000-8000-000000000001";
const A2 = "20000000-0000-4000-8000-000000000002";
const A3 = "20000000-0000-4000-8000-000000000003";
const METRIC: readonly Lifecycle[] = ["LIVE", "CLOSED", "REVIEWED"];
const OTHERS: readonly Lifecycle[] = ["DRAFT", "LOCKED", "SKIPPED", "CANCELLED", "DISCARDED"];
/** Ids spread over the uuid space, so the accounts' id ranges interleave like random uuids. */
const tradeId = (n: number) => `${((n * 2654435761) % 0xffffffff).toString(16).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const created = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();

function trade(n: number, lifecycle: Lifecycle, accountId = A1): Row {
  const closed = lifecycle === "CLOSED" || lifecycle === "REVIEWED";
  const entered = closed || lifecycle === "LIVE";
  const planned = lifecycle !== "DRAFT" && lifecycle !== "DISCARDED";
  const row: LedgerTrade = {
    id: tradeId(n), account_id: accountId, origin: "PLANNED", created_at: created(n), duplicated_from: null, migrated_from: null, currency: "USD",
    revision_count: 1, latest_revision: 1, latest_proposal_id: `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`, latest_revision_at: created(n),
    latest_check_decision: null, latest_check_at: null, latest_check_evaluation_id: null,
    plan_id: planned ? `80000000-0000-4000-8000-${String(n).padStart(12, "0")}` : null, locked_at: planned ? created(n) : null, plan_trading_day: null,
    strategy_version_id: null, strategy_version: null, risk_plan_version_id: null, risk_plan_version: null,
    symbol: "EURUSD", instrument_version_id: null, direction: "LONG", entry_model: "OB_FIRST_TOUCH",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "50",
    entry_price: entered ? "1.1" : null, entered_at: entered ? created(n) : null, entry_time_known: entered, entry_recorded_at: entered ? created(n) : null,
    quantity: entered ? "0.25" : null, initial_stop: entered ? "1.098" : null, initial_risk: entered ? "50" : null, actual_initial_risk: entered ? "50" : null,
    oversize: entered ? false : null, exit_price: closed ? "1.106" : null, exited_at: closed ? created(n) : null, close_recorded_at: closed ? created(n) : null,
    fees: closed ? "0" : null, gross_pnl: closed ? "150" : null, net_pnl: closed ? "150" : null, realized_r: closed ? "3" : null, outcome: closed ? "WIN" : null,
    calculation_version: closed ? "FULL_CLOSE_V1" : null, pnl_source: closed ? "CALCULATED" : null,
    disposition: lifecycle === "SKIPPED" || lifecycle === "CANCELLED" ? lifecycle : null, disposition_reason: null, legacy_decision: null,
    discarded_at: lifecycle === "DISCARDED" ? created(n) : null,
    lifecycle, draft_check: lifecycle === "DRAFT" ? "UNCHECKED" : null, review_completed_at: lifecycle === "REVIEWED" ? created(n) : null,
    setup_grade: null, liquidity_context: null, mss_timeframe: null, tags: [], tag_source: null,
    evidence_count: 0, cover_evidence_id: null, cover_evidence_kind: null, journal_count: 0, ai_review_count: 0,
  };
  return { ...row };
}

function account(id: string): ContextAccount {
  return { id, name: `Account ${id.slice(-1)}`, currency: "USD", type: "DEMO", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "10000", createdAt: created(0), profile: "PROFILE" };
}

const accountsTable = (...ids: string[]) => ids.map(id => ({ id, user_id: USER }));
/** Plans and trades as the open-trade read sees them: embedded outcome or close present (closed) or null (open). */
const openTables = (rows: readonly Row[]) => ({
  trade_plans: rows.filter(row => row.plan_id !== null).map(row => ({
    id: row.plan_id, user_id: USER, account_id: row.account_id, trade_plan_links: [{ trade_id: row.id }], trade_outcomes: row.exited_at === null ? null : [{ id: row.id }],
    trade_dispositions: row.lifecycle === "SKIPPED" || row.lifecycle === "CANCELLED" ? [{ id: row.id }] : null,
  })),
  trades: rows.map(row => ({
    id: row.id, user_id: USER, account_id: row.account_id, origin: row.origin, created_at: row.created_at,
    trade_unplanned_closes: row.origin === "PLANNED" || row.exited_at === null ? null : [{ trade_id: row.id }],
  })),
});
const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : 1);
const unscoped = (call: Call) => !call.filters.some(filter => filter.startsWith("eq:account_id:") || filter.startsWith("in:id"));

describe("account metric reads at scale", () => {
  const metricRead = (db: TableDb, maxRows?: number) =>
    loadLedgerRows(db as never, USER, { mode: "account", accountId: A1 }, {}, { lifecycles: METRIC, ...(maxRows === undefined ? {} : { maxRows }) });

  it("never sends the derived lifecycle as a ledger filter, and keeps only the requested lifecycles", async () => {
    // 1,203 trades across three pages: every fifth one is a draft, waiting, skipped, cancelled or discarded plan.
    const rows = Array.from({ length: 1203 }, (_, index) => trade(index + 1, index % 5 === 4 ? OTHERS[index % OTHERS.length] : METRIC[index % 3]));
    const db = new TableDb({ trade_ledger: rows });
    const loaded = await metricRead(db);
    expect(db.ledgerCalls().some(call => call.filters.some(filter => filter.includes(":lifecycle")))).toBe(false);
    expect(db.ledgerCalls().every(call => call.filters.includes(`eq:account_id:${A1}`))).toBe(true);
    expect(loaded.truncated).toBe(false);
    expect(loaded.rows.map(row => row.id)).toEqual(rows.filter(row => METRIC.includes(row.lifecycle as Lifecycle)).sort(byId).map(row => row.id));
  });

  it("counts only requested lifecycles toward the read limit, and calls a read truncated only when one more of them follows", async () => {
    const metric = Array.from({ length: 1000 }, (_, index) => trade(index + 1, METRIC[index % 3]));
    const others = Array.from({ length: 1700 }, (_, index) => trade(2000 + index, index % 2 ? "DRAFT" : "DISCARDED"));
    const complete = await metricRead(new TableDb({ trade_ledger: [...metric, ...others] }), 1000);
    expect(complete.truncated).toBe(false);
    expect(complete.rows).toHaveLength(1000);
    const more = await metricRead(new TableDb({ trade_ledger: [...metric, ...others, trade(9000, "CLOSED")] }), 1000);
    expect(more.truncated).toBe(true);
    expect(more.rows).toHaveLength(1000);
  });
});

describe("large reads in parallel id ranges", () => {
  // 5,000 trades of one account, a tenth of them drafts or discarded: past the first 2,000 rows read in one pass.
  const rows = Array.from({ length: 5000 }, (_, index) => trade(index + 1, index % 10 === 9 ? OTHERS[index % 2 === 0 ? 0 : 4] : METRIC[index % 3]));
  const metric = rows.filter(row => METRIC.includes(row.lifecycle as Lifecycle)).sort(byId);
  const read = (db: TableDb, maxRows?: number) =>
    loadLedgerRows(db as never, USER, { mode: "account", accountId: A1 }, {}, { lifecycles: METRIC, ...(maxRows === undefined ? {} : { maxRows }) });

  it("splits the id space after the first pass into consecutive ranges that cover it exactly", () => {
    const after = "3fffffff-ffff-4fff-8fff-ffffffffffff";
    const ranges = splitIdRange(after, 4);
    expect(ranges).toHaveLength(4);
    expect(ranges[0][0]).toBe(after);
    expect(ranges[3][1]).toBeNull();
    const value = (id: string) => BigInt(`0x${id.replaceAll("-", "")}`);
    // Each range starts right where the previous one ends: (lower, upper) then (upper - 1, ...), so no id is skipped or read twice.
    for (let index = 1; index < 4; index += 1) expect(value(ranges[index][0])).toBe(value(ranges[index - 1][1] as string) - 1n);
    expect(splitIdRange("ffffffff-ffff-ffff-ffff-fffffffffffd", 4)).toEqual([["ffffffff-ffff-ffff-ffff-fffffffffffd", null]]);
  });

  it("reads the rest of a large account in parallel id ranges, with the rows and order of one pass", async () => {
    const db = new TableDb({ trade_ledger: rows });
    const loaded = await read(db);
    expect(loaded.truncated).toBe(false);
    expect(loaded.rows.map(row => row.id)).toEqual(metric.map(row => row.id));
    // After the first 2,000 rows, every range of the rest is read from its own start.
    const starts = splitIdRange(metric[1999].id as string, 4).map(([after]) => `gt:id:${after}`);
    expect(starts.every(start => db.ledgerCalls().some(call => call.filters.includes(start)))).toBe(true);
  });

  it("keeps exactly the first rows by id at a read limit inside the parallel ranges, and says more follow", async () => {
    const limited = await read(new TableDb({ trade_ledger: rows }), 3000);
    expect(limited.truncated).toBe(true);
    expect(limited.rows.map(row => row.id)).toEqual(metric.slice(0, 3000).map(row => row.id));
    const exact = await read(new TableDb({ trade_ledger: rows }), metric.length);
    expect(exact.truncated).toBe(false);
    expect(exact.rows).toHaveLength(metric.length);
  });
});

describe("All Accounts reads at scale", () => {
  const rows = [
    ...Array.from({ length: 700 }, (_, index) => trade(index + 1, "CLOSED", A1)),
    ...Array.from({ length: 450 }, (_, index) => trade(1000 + index, "REVIEWED", A2)),
    ...Array.from({ length: 30 }, (_, index) => trade(2000 + index, "CLOSED", A3)),
    ...Array.from({ length: 20 }, (_, index) => trade(3000 + index, "DRAFT", A2)),
  ];

  it("reads every account on its own and merges by id: the rows of one read of the whole scope", async () => {
    const db = new TableDb({ trade_ledger: rows, accounts: accountsTable(A1, A2, A3) });
    const loaded = await loadLedgerRows(db as never, USER, { mode: "all" }, {}, { closedOnly: true });
    expect(db.ledgerCalls().filter(unscoped)).toEqual([]);
    expect(loaded.truncated).toBe(false);
    expect(loaded.rows.map(row => row.id)).toEqual(rows.filter(row => row.exited_at !== null).sort(byId).map(row => row.id));
  });

  it("stops at exactly the read limit across accounts, in id order, and says when more trades follow", async () => {
    const closed = rows.filter(row => row.exited_at !== null).sort(byId);
    const db = new TableDb({ trade_ledger: rows, accounts: accountsTable(A1, A2, A3) });
    const limited = await loadLedgerRows(db as never, USER, { mode: "all" }, {}, { closedOnly: true, maxRows: 600 });
    expect(limited.truncated).toBe(true);
    expect(limited.rows.map(row => row.id)).toEqual(closed.slice(0, 600).map(row => row.id));
    const exact = await loadLedgerRows(new TableDb({ trade_ledger: rows, accounts: accountsTable(A1, A2, A3) }) as never, USER, { mode: "all" }, {}, { closedOnly: true, maxRows: closed.length });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.rows).toHaveLength(closed.length);
  });

  it("lists Today's live and waiting trades from the open trades' keys and drafts per account, newest first across accounts", async () => {
    const listed = [
      ...Array.from({ length: 6 }, (_, index) => trade(4000 + index, "LIVE", [A1, A2, A3][index % 3])),
      ...Array.from({ length: 5 }, (_, index) => trade(5000 + index, "LOCKED", [A1, A2][index % 2])),
      ...Array.from({ length: 4 }, (_, index) => trade(6000 + index, "DRAFT", [A3, A1][index % 2])),
    ];
    const db = new TableDb({ trade_ledger: [...rows, ...listed], ...openTables([...rows, ...listed]), accounts: accountsTable(A1, A2, A3), daily_contexts: [] });
    const context = { accounts: [account(A1), account(A2), account(A3)], selected: { mode: "all" } } as never;
    const today = await loadToday({ db: db as never, userId: USER, context, workspaces: [], now: "2026-10-23T14:00:00Z" });
    // No ledger read filters by the derived lifecycle over a whole scope: drafts are read per account with the plain
    // columns named, live and waiting trades by id after an anti-join of plans without an outcome and trades without a close.
    const lists = db.ledgerCalls().filter(call => call.filters.some(filter => filter.startsWith("eq:lifecycle:")));
    expect(lists.map(call => call.filters.find(filter => filter.startsWith("eq:lifecycle:")))).toEqual(["eq:lifecycle:DRAFT", "eq:lifecycle:DRAFT", "eq:lifecycle:DRAFT"]);
    expect(lists.every(call => call.filters.includes("eq:origin:PLANNED") && call.filters.includes("is:plan_id:null"))).toBe(true);
    expect(db.ledgerCalls().filter(unscoped)).toEqual([]);
    expect(db.calls.filter(call => call.table === "trade_plans").every(call => call.filters.includes("is:trade_outcomes:null") && call.filters.includes("is:trade_dispositions:null"))).toBe(true);
    expect(db.calls.filter(call => call.table === "trades").every(call => call.filters.includes("is:trade_unplanned_closes:null"))).toBe(true);
    const newest = (lifecycle: Lifecycle) => [...rows, ...listed].filter(row => row.lifecycle === lifecycle).sort((a, b) => (String(b.created_at) < String(a.created_at) ? -1 : 1)).map(row => row.id);
    expect(today.live.map(card => card.row.id).sort()).toEqual(newest("LIVE").sort());
    expect(today.plans.locked.map(row => row.id)).toEqual(newest("LOCKED"));
    expect(today.truncated).toMatchObject({ live: false, locked: false, drafts: false });
  });

  it("leaves skipped and cancelled plans out of the open trades, so their ledger rows are never read for live lists", async () => {
    const open = [trade(8000, "LIVE", A1), trade(8001, "LOCKED", A2)];
    const settled = [...Array.from({ length: 40 }, (_, index) => trade(8100 + index, "SKIPPED", A1)), ...Array.from({ length: 40 }, (_, index) => trade(8200 + index, "CANCELLED", A2))];
    const db = new TableDb({ ...openTables([...rows, ...open, ...settled]) });
    const ids = await openTradeIds(db as never, USER, { mode: "all" });
    expect(ids.sort()).toEqual(open.map(row => row.id).sort());
    expect(db.calls.filter(call => call.table === "trade_plans").every(call => call.filters.includes("is:trade_dispositions:null"))).toBe(true);
  });

  it("finds the palette's newest trades by id instead of ordering the ledger of every account by creation", async () => {
    const all = [...rows, trade(7000, "LIVE", A2)];
    const db = new TableDb({
      trade_ledger: all, ...openTables(all),
      accounts: accountsTable(A1, A2, A3),
    });
    const palette = await loadPaletteTrades({ db: db as never, userId: USER, scope: { mode: "all" }, accounts: [account(A1), account(A2), account(A3)], now: "2026-10-23T14:00:00Z", display: { mode: "strategy" } as never });
    expect(db.ledgerCalls().filter(unscoped)).toEqual([]);
    const newest = [...all].sort((a, b) => (String(b.created_at) < String(a.created_at) ? -1 : 1)).slice(0, 50).map(row => row.id);
    expect(palette.recentTrades.map(entry => entry.id)).toEqual(newest);
    expect(palette.liveTrades.map(entry => entry.id)).toEqual([tradeId(7000)]);
  });
});
