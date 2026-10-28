import Decimal from "decimal.js";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EDGE's closed-trades CSV (GET /edge/export, docs/V2_ARCHITECTURE.md §1.2, §9.3, §14.6): every closed trade of the
// scope (planned, live-first and imported) with EDGE's filters, the V1 columns first, money per account currency.
// The route, the EDGE page loader and the export links run against one in-memory PostgREST double that evaluates
// the real filters and hides other users' rows (RLS), so the file is compared with what the page counts.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
const m = vi.hoisted(() => ({
  user: "10000000-0000-4000-8000-000000000001",
  db: null as unknown,
  cookies: new Map<string, string>(),
  truncate: false,
  push: (() => undefined) as (...args: unknown[]) => void,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (m.cookies.has(name) ? { name, value: m.cookies.get(name) } : undefined) }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => m.db, requireUser: async () => ({ db: m.db, user: { id: m.user } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/ai-history", () => ({ loadTradeAiHistory: vi.fn(), timelineAiAnalyses: () => [] }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: m.push, replace: m.push, refresh: m.push, prefetch: m.push, back: m.push, forward: m.push }),
}));
/** The real loader; `m.truncate` simulates more matching rows than one read may return. */
vi.mock("@/lib/performance-data", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/performance-data")>();
  return {
    ...actual,
    loadLedgerRows: async (...args: Parameters<typeof actual.loadLedgerRows>) => {
      const loaded = await actual.loadLedgerRows(...args);
      return m.truncate ? { ...loaded, truncated: true } : loaded;
    },
  };
});
/** Menus render open (inline), so the export items can be inspected in server markup. */
vi.mock("@/components/ui/dropdown-menu", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  const pass = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  return {
    ...actual,
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuItem: pass,
    DropdownMenuContent: ({ children, "aria-describedby": describedBy }: { children?: ReactNode; "aria-describedby"?: string }) =>
      createElement("div", { role: "menu", "aria-describedby": describedBy }, children),
    DropdownMenuLabel: ({ children, id }: { children?: ReactNode; id?: string }) => createElement("div", { "data-menu-label": "", id }, children),
  };
});

import {
  ADDED_COLUMNS, ALL_ACCOUNTS_SCOPE, BYTE_ORDER_MARK, byExit, CSV_COLUMNS, closedTradesCsv, dailySequences, exportFilename, exportHref, LAST_CLOSED, LEGACY_COLUMNS,
  legacySession, legacyWeekday, parseExportRequest, TOO_MANY_TRADES,
} from "@/app/edge/export/contract";
import { GET } from "@/app/edge/export/route";
import { type EdgeData, loadEdge } from "@/components/edge/edge-data";
import { EdgeScreen } from "@/components/edge/edge-screen";
import { EXPORT_LABEL, EXPORT_NOTE, ExportMenu } from "@/components/edge/export-menu";
import { exportLinks, exportUnavailable } from "@/components/edge/model";
import { edgeFilters, parseEdgeQuery } from "@/components/edge/query";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { compareInstants, isInstant } from "@/domain/time-display";

// ---------------------------------------------------------------------------------------------------------------------
// In-memory PostgREST double with RLS: rows of other users are invisible to the session user.
// ---------------------------------------------------------------------------------------------------------------------
type Predicate = (row: Row) => boolean;

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string" && isInstant(a) && isInstant(b)) return compareInstants(a, b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const present = (value: unknown) => value !== null && value !== undefined;

class FakeQuery implements PromiseLike<Result> {
  private readonly predicates: Predicate[] = [];
  private readonly orders: [string, boolean][] = [];
  private columns: string[] | null = null;
  private cap: number | null = null;
  private single = false;

  constructor(private readonly db: FakeDb, private readonly table: string) {
    db.reads.push(table);
  }

  private where(predicate: Predicate): this {
    this.predicates.push(predicate);
    return this;
  }

  select(columns: string): this {
    this.columns = columns === "*" ? null : columns.split(",").map(column => column.trim().replace(/::text$/, ""));
    return this;
  }
  eq(column: string, value: unknown): this { return this.where(row => present(row[column]) && compareValues(row[column], value) === 0); }
  in(column: string, values: readonly unknown[]): this { return this.where(row => present(row[column]) && values.some(value => compareValues(row[column], value) === 0)); }
  gt(column: string, value: unknown): this { return this.where(row => present(row[column]) && compareValues(row[column], value) > 0); }
  gte(column: string, value: unknown): this { return this.where(row => present(row[column]) && compareValues(row[column], value) >= 0); }
  lt(column: string, value: unknown): this { return this.where(row => present(row[column]) && compareValues(row[column], value) < 0); }
  is(column: string, value: null): this {
    if (value !== null) throw new Error("Unsupported is-filter");
    return this.where(row => !present(row[column]));
  }
  not(column: string, operator: string, value: null): this {
    if (operator !== "is" || value !== null) throw new Error("Unsupported not-filter");
    return this.where(row => present(row[column]));
  }
  contains(column: string, values: readonly string[]): this {
    return this.where(row => Array.isArray(row[column]) && values.every(value => (row[column] as unknown[]).includes(value)));
  }
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push([column, options.ascending ?? true]);
    return this;
  }
  limit(count: number): this {
    this.cap = count;
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private run(): Result {
    if (this.db.failing.has(this.table)) return { data: null, error: { message: "permission denied for relation internal_42" } };
    const visible = (this.db.tables[this.table] ?? []).filter(row => row.user_id === this.db.user);
    let rows = visible.filter(row => this.predicates.every(predicate => predicate(row)));
    rows = [...rows].sort((a, b) => {
      for (const [column, ascending] of this.orders) {
        const order = compareValues(a[column], b[column]);
        if (order !== 0) return ascending ? order : -order;
      }
      return 0;
    });
    if (this.cap !== null) rows = rows.slice(0, this.cap);
    const columns = this.columns;
    const data = rows.map(row => (columns === null ? { ...row } : Object.fromEntries(columns.map(column => [column, row[column] ?? null]))));
    if (!this.single) return { data, error: null };
    return data.length > 1 ? { data: null, error: { message: "multiple rows" } } : { data: data[0] ?? null, error: null };
  }

  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A = Result, B = never>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  readonly reads: string[] = [];
  readonly failing = new Set<string>();
  readonly auth = { getUser: async () => ({ data: { user: { id: this.user } }, error: null }) };
  constructor(readonly tables: Record<string, Row[]>, readonly user: string) {}
  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures: three accounts of the trader (one archived, with a formula-like name) and another user's account.
// ---------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-23T15:00:00.000Z";
const USER = m.user;
const OTHER = "10000000-0000-4000-8000-000000000002";
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const OLD = "20000000-0000-4000-8000-000000000003";
const FOREIGN = "20000000-0000-4000-8000-000000000009";
const STRATEGY = "30000000-0000-4000-8000-000000000001";
const STRATEGY_OLD = "30000000-0000-4000-8000-000000000002";
const RISK = "40000000-0000-4000-8000-000000000001";
const RISK_OLD = "40000000-0000-4000-8000-000000000002";
const tid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The V1 file's header (`tradeCsv` of src/domain/analytics.ts at bc5441c): frozen. */
const V1_HEADER = [
  "instrument", "entry_model", "direction", "status", "strategy_version", "risk_plan_version", "planned_entry", "initial_stop", "entry_price", "quantity",
  "entered_at", "exit_price", "exited_at", "fees", "initial_risk", "risk_percent", "net_pnl", "realized_r", "outcome", "session", "weekday",
  "dailySequence", "setup_grade", "liquidity_context", "mss_timeframe", "tag_source",
];

function ledger(changes: Partial<LedgerTrade> & { id: string }, user = USER): Row {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null]));
  return {
    ...blank, account_id: FTMO, origin: "PLANNED", created_at: "2026-09-01T10:00:00Z", currency: "USD", revision_count: 0, entry_time_known: false,
    lifecycle: "DRAFT", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes, user_id: user,
  };
}

/** A closed trade; planned ones carry a locked plan with the current strategy and risk plan. */
function closed(n: number, changes: Partial<LedgerTrade> & { exited_at: string; net_pnl: string }, user = USER): Row {
  const planned = (changes.origin ?? "PLANNED") === "PLANNED";
  const net = new Decimal(changes.net_pnl);
  return ledger({
    id: tid(n), symbol: "EURUSD", direction: "LONG", entry_model: "OTE", entry_price: "1.1", quantity: "0.5", exit_price: "1.102", fees: "0",
    entry_time_known: changes.entered_at !== null, close_recorded_at: changes.exited_at, lifecycle: "CLOSED",
    outcome: net.gt(0) ? "WIN" : net.lt(0) ? "LOSS" : "BREAKEVEN",
    ...(planned
      ? {
          plan_id: pid(n), locked_at: "2026-09-01T11:00:00Z", strategy_version_id: STRATEGY, strategy_version: "ICT V1.0", risk_plan_version_id: RISK,
          risk_plan_version: "Risk Plan V1.0", planned_entry: "1.1", planned_stop: "1.098", initial_stop: "1.098", requested_risk_percent: "0.5", initial_risk: "100",
          calculation_version: "FULL_CLOSE_V1" as const, pnl_source: "CALCULATED" as const,
        }
      : { calculation_version: "UNPLANNED_CLOSE_V1" as const, pnl_source: "CALCULATED" as const }),
    ...changes,
  }, user);
}

function tables(): Record<string, Row[]> {
  const trades = [
    // FTMO, Monday Oct 5: T1 planned (07:00 UTC−5), T5 open live-first (08:00), T2 live-first (09:30).
    closed(1, {
      entered_at: "2026-10-05T12:00:00Z", exited_at: "2026-10-05T15:00:00Z", net_pnl: "117.5", realized_r: "1.17499999999999999999999999999999", fees: "2.5",
      lifecycle: "REVIEWED", setup_grade: "A+", liquidity_context: "PDL", mss_timeframe: "M5", tags: ["patience", "london"], tag_source: "V2",
    }),
    closed(2, {
      origin: "LIVE_FIRST", symbol: "XAUUSD", entry_model: "OTHER", direction: "SHORT", entered_at: "2026-10-05T14:30:00Z", exited_at: "2026-10-05T16:00:00Z",
      net_pnl: "-55.5", realized_r: "-0.5", initial_risk: "111",
    }),
    ledger({ id: tid(5), origin: "LIVE_FIRST", symbol: "EURUSD", direction: "LONG", entered_at: "2026-10-05T13:00:00Z", entry_time_known: true, lifecycle: "LIVE" }),
    // Personal (EUR): T3 imported in Asia on Tuesday Oct 6 (exit 22:30 UTC−5: exit day Oct 6), T7 live-first without an entry time.
    closed(3, {
      account_id: PERSONAL, currency: "EUR", origin: "IMPORTED", symbol: "DE40", entry_model: null, entered_at: "2026-10-06T23:30:00Z", exited_at: "2026-10-07T03:30:00Z",
      net_pnl: "148.82", fees: "0.7", realized_r: null, initial_risk: null, pnl_source: "IMPORTED",
    }),
    closed(7, {
      account_id: PERSONAL, currency: "EUR", origin: "LIVE_FIRST", symbol: "US30", entry_model: null, entered_at: null, entry_price: null, quantity: null, exit_price: null,
      exited_at: "2026-10-08T15:00:00Z", net_pnl: "20", realized_r: null, pnl_source: "USER_REPORTED",
    }),
    // Archived account "=Old prop": a planned trade of an older strategy and risk plan, with V1 tags.
    closed(4, {
      account_id: OLD, symbol: "GBPUSD", entry_model: "OB_FIRST_TOUCH", direction: "SHORT", entered_at: "2026-09-14T12:00:00Z", exited_at: "2026-09-14T14:00:00Z",
      net_pnl: "-100", realized_r: "-1", strategy_version_id: STRATEGY_OLD, strategy_version: "ICT V0.9", risk_plan_version_id: RISK_OLD, setup_grade: "B", tag_source: "V1",
    }),
    // FTMO, Friday Oct 9: two trades with the same recorded entry time (no authoritative order).
    closed(9, { entry_model: "OB_FIRST_TOUCH", entered_at: "2026-10-09T12:00:00Z", exited_at: "2026-10-09T13:00:00Z", net_pnl: "50", realized_r: "0.5" }),
    closed(10, { origin: "LIVE_FIRST", symbol: "GBPUSD", entered_at: "2026-10-09T12:00:00Z", exited_at: "2026-10-09T14:00:00Z", net_pnl: "0", realized_r: "0", initial_risk: "80" }),
    // FTMO, Monday Sep 28 in the Dead Pool (13:00 UTC−5).
    closed(11, { entered_at: "2026-09-28T18:00:00Z", exited_at: "2026-09-28T19:00:00Z", net_pnl: "200", realized_r: "2" }),
    // Never exported: a draft, and another user's closed trade.
    ledger({ id: tid(6), lifecycle: "DRAFT", draft_check: "UNCHECKED", revision_count: 1, latest_revision: 1 }),
    closed(8, { account_id: FOREIGN, entered_at: "2026-10-05T12:30:00Z", exited_at: "2026-10-05T15:30:00Z", net_pnl: "777777" }, OTHER),
  ];
  const account = (id: string, user: string, name: string, currency: string) => ({ id, user_id: user, name, currency, created_at: `2026-01-0${id.slice(-1)}T00:00:00Z` });
  const profile = (id: number, accountId: string, name: string, status: string) => ({
    id, user_id: accountId === FOREIGN ? OTHER : USER, account_id: accountId, display_name: name, broker: null, platform: "MANUAL", account_type: "EVALUATION",
    starting_balance: "100000.00", status,
  });
  return {
    accounts: [account(FTMO, USER, "FTMO 100K", "USD"), account(PERSONAL, USER, "Personal 12K", "EUR"), account(OLD, USER, "Old prop", "USD"), account(FOREIGN, OTHER, "Theirs", "USD")],
    account_profiles: [profile(1, FTMO, "FTMO 100K", "ACTIVE"), profile(2, PERSONAL, "Personal 12K", "ACTIVE"), profile(3, OLD, "=Old prop", "ARCHIVED"), profile(4, FOREIGN, "Theirs", "ACTIVE")],
    trade_ledger: trades,
    journal_analytics: [
      { id: pid(1), user_id: USER, risk_percent: "0.50000000000000000000" },
      { id: pid(4), user_id: USER, risk_percent: "0.99810000000000000000" },
      { id: pid(9), user_id: USER, risk_percent: "0.49748241962172866100" },
      { id: pid(11), user_id: USER, risk_percent: "0.5" },
      { id: pid(8), user_id: OTHER, risk_percent: "0.5" },
    ],
  };
}

/** Exit times of the CSV's rows identify its trades (every fixture trade exits at a distinct instant). */
const EXIT: Record<number, string> = {
  1: "2026-10-05T15:00:00Z", 2: "2026-10-05T16:00:00Z", 3: "2026-10-07T03:30:00Z", 4: "2026-09-14T14:00:00Z", 7: "2026-10-08T15:00:00Z",
  9: "2026-10-09T13:00:00Z", 10: "2026-10-09T14:00:00Z", 11: "2026-09-28T19:00:00Z",
};
const exits = (...trades: number[]) => trades.map(n => EXIT[n]);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else cell += character;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function records(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows.map(cells => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

/** The UTF-8 byte-order mark, as the file's first bytes. */
const BOM_BYTES = [0xef, 0xbb, 0xbf];

let db: FakeDb;
/**
 * Downloads a file. `text` is the body decoded as strict UTF-8 without the byte-order mark (as spreadsheets read it,
 * and as `Response.text()` would); `bytes` keeps the body exactly as sent.
 */
async function download(query: string): Promise<{ response: Response; text: string; bytes: Uint8Array; rows: Record<string, string>[] }> {
  const response = await GET(new Request(`http://localhost/edge/export${query.startsWith("?") || query === "" ? query : `?${query}`}`));
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { response, text, bytes, rows: response.status === 200 ? records(text) : [] };
}
const fetchHref = (href: string) => download(href.slice("/edge/export".length));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb(tables(), USER);
  m.db = db;
  m.cookies.clear();
  m.truncate = false;
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("file contents", () => {
  it("holds every closed trade of All Accounts (planned, live-first, imported; archived accounts too) in exit order", async () => {
    const { response, text, bytes, rows } = await download("?account=all");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="trading-os-closed-trades-all-accounts-2026-10-23.csv"');
    expect(rows.map(row => row.exited_at)).toEqual(exits(4, 11, 1, 2, 3, 7, 9, 10));
    expect(rows.map(row => row.origin)).toEqual(["PLANNED", "PLANNED", "PLANNED", "LIVE_FIRST", "IMPORTED", "LIVE_FIRST", "PLANNED", "LIVE_FIRST"]);
    // Drafts, open trades and other users' trades never appear, and no identifier (trade, plan, account, user) does.
    expect(text).not.toContain("777777");
    expect(text).not.toContain("Theirs");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toContain("account_id");
    expect(rows.every(row => row.status === "CLOSED")).toBe(true);
    // A UTF-8 byte-order mark, then the V1 header; CRLF rows and no trailing newline (as in V1).
    expect([...bytes.subarray(0, 3)]).toEqual(BOM_BYTES);
    expect(text.startsWith("instrument,entry_model,direction,status,")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(false);
    expect(text.split("\r\n")).toHaveLength(9);
  });

  it("is UTF-8 with a byte-order mark, so spreadsheets show non-ASCII account names as the trader typed them", async () => {
    // A newer profile revision renames Personal (display names are checked for length only, any Unicode is valid).
    db.tables.account_profiles.push({ ...db.tables.account_profiles[1], id: 5, display_name: "Persönlich – €12K" });
    const { response, bytes, rows } = await download(`?account=${PERSONAL}`);
    expect(response.status).toBe(200);
    expect([...bytes.subarray(0, 3)]).toEqual(BOM_BYTES);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, 14))).toBe(`${BYTE_ORDER_MARK}instrument,`);
    expect(rows.map(row => row.account)).toEqual(["Persönlich – €12K", "Persönlich – €12K"]);
    // The name's UTF-8 bytes exactly (ö C3 B6, – E2 80 93, € E2 82 AC), never a legacy code page.
    expect(Buffer.from(bytes).includes(Buffer.from('"Persönlich – €12K"', "utf8"))).toBe(true);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="trading-os-closed-trades-personlich-12k-2026-10-23.csv"');
  });

  it("keeps the V1 columns first, in V1 order, and appends the V2 columns after them", async () => {
    const { text } = await download("?account=all");
    const header = text.split("\r\n")[0].split(",");
    expect(LEGACY_COLUMNS).toEqual(V1_HEADER);
    expect(header.slice(0, V1_HEADER.length)).toEqual(V1_HEADER);
    expect(header.slice(V1_HEADER.length)).toEqual(["origin", "account", "currency", "exit_day", "requested_risk_percent", "pnl_source", "lifecycle", "tags"]);
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(ADDED_COLUMNS).toContain("currency");
  });

  it("never mixes currencies in a money column without naming the currency of each row", async () => {
    const { rows } = await download("?account=all");
    const byAccount = Object.fromEntries(rows.map(row => [row.account, row.currency]));
    expect(byAccount).toEqual({ "FTMO 100K": "USD", "Personal 12K": "EUR", "'=Old prop": "USD" });
    const imported = rows.find(row => row.origin === "IMPORTED");
    expect(imported).toMatchObject({ currency: "EUR", net_pnl: "148.82", fees: "0.7", pnl_source: "IMPORTED", realized_r: "", initial_risk: "" });
  });

  it("fills the V1 columns with their V1 meanings for every origin, decimals exact", async () => {
    const { rows } = await download("?account=all");
    const row = (n: number) => rows.find(item => item.exited_at === EXIT[n]) ?? {};
    expect(row(1)).toMatchObject({
      instrument: "EURUSD", entry_model: "OTE", direction: "LONG", status: "CLOSED", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0",
      planned_entry: "1.1", initial_stop: "1.098", entry_price: "1.1", quantity: "0.5", entered_at: "2026-10-05T12:00:00Z", fees: "2.5", initial_risk: "100",
      risk_percent: "0.5", net_pnl: "117.5", realized_r: "1.17499999999999999999999999999999", outcome: "WIN", session: "ACTIVE_KILL_ZONE", weekday: "Monday",
      dailySequence: "1", setup_grade: "A+", liquidity_context: "PDL", mss_timeframe: "M5", tag_source: "MANUAL",
      origin: "PLANNED", account: "FTMO 100K", exit_day: "2026-10-05", requested_risk_percent: "0.5", pnl_source: "CALCULATED", lifecycle: "REVIEWED", tags: "patience; london",
    });
    // Live-first: no plan, so nothing planned is fabricated; its own risk basis is the R denominator.
    expect(row(2)).toMatchObject({
      strategy_version: "", risk_plan_version: "", planned_entry: "", risk_percent: "", requested_risk_percent: "", initial_risk: "111", realized_r: "-0.5",
      outcome: "LOSS", dailySequence: "3", tag_source: "", tags: "", lifecycle: "CLOSED",
    });
    // Imported in Asia (ASIAN_RANGE in V1 words), exited at 22:30 UTC−5: the exit day is the strategy day.
    expect(row(3)).toMatchObject({ session: "ASIAN_RANGE", weekday: "Tuesday", exit_day: "2026-10-06", dailySequence: "1", entry_model: "" });
    // No recorded entry time: V1's OTHER session and NO DATA weekday, no daily sequence.
    expect(row(7)).toMatchObject({ entered_at: "", session: "OTHER", weekday: "NO DATA", dailySequence: "", pnl_source: "USER_REPORTED", entry_price: "" });
    // Same recorded entry time: no authoritative order, so the whole day is unknown (V1 rule).
    expect([row(9).dailySequence, row(10).dailySequence]).toEqual(["", ""]);
    expect(row(9).risk_percent).toBe("0.497482419621728661");
    expect(row(4)).toMatchObject({ tag_source: "MANUAL", setup_grade: "B", risk_percent: "0.9981", strategy_version: "ICT V0.9" });
    expect(row(11)).toMatchObject({ session: "DEAD_POOL", weekday: "Monday", dailySequence: "1" });
  });

  it("counts every executed trade of the day in dailySequence, including open ones and trades outside the file", async () => {
    const { rows } = await download(`?account=${FTMO}&origin=live-first`);
    expect(rows.map(row => [row.exited_at, row.dailySequence])).toEqual([[EXIT[2], "3"], [EXIT[10], ""]]);
  });

  it("guards every cell against spreadsheet formulas, like the V1 file", async () => {
    const { text } = await download(`?account=${OLD}`);
    expect(text).toContain(`"'=Old prop"`);
    expect(text).toContain(`"-100"`);
  });

  it("refuses a file that would be partial instead of truncating it", async () => {
    m.truncate = true;
    const { response, text } = await download("?account=all");
    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toEqual({ error: TOO_MANY_TRADES });
    expect(TOO_MANY_TRADES).toBe("More than 20,000 closed trades match. Narrow the date range and export again.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("scope: account, All Accounts and the account context", () => {
  it("exports one account by id, archived ones included (their history stays exportable)", async () => {
    const ftmo = await download(`?account=${FTMO}`);
    expect(ftmo.rows.map(row => row.exited_at)).toEqual(exits(11, 1, 2, 9, 10));
    expect(ftmo.response.headers.get("content-disposition")).toBe('attachment; filename="trading-os-closed-trades-ftmo-100k-2026-10-23.csv"');
    const personal = await download(`?account=${PERSONAL.toUpperCase()}`);
    expect(personal.rows.map(row => row.exited_at)).toEqual(exits(3, 7));
    const archived = await download(`?account=${OLD}`);
    expect(archived.rows.map(row => row.exited_at)).toEqual(exits(4));
    expect(archived.response.headers.get("content-disposition")).toContain("trading-os-closed-trades-old-prop-2026-10-23.csv");
  });

  it.each([["another user's account", FOREIGN], ["an unknown account", "20000000-0000-4000-8000-000000000077"]])(
    "refuses %s (404) without reading any trade, and never falls back to another account",
    async (_label, id) => {
      const { response, text } = await download(`?account=${id}`);
      expect(response.status).toBe(404);
      expect(JSON.parse(text)).toEqual({ error: "That trading account isn't available." });
      expect(db.reads).not.toContain("trade_ledger");
    },
  );

  it.each([
    ["the selected account", FTMO, exits(11, 1, 2, 9, 10)],
    ["All Accounts", "all", exits(4, 11, 1, 2, 3, 7, 9, 10)],
    ["an archived account (resolves to All Accounts, as on EDGE)", OLD, exits(4, 11, 1, 2, 3, 7, 9, 10)],
    ["another user's account (resolves to All Accounts)", FOREIGN, exits(4, 11, 1, 2, 3, 7, 9, 10)],
    ["no stored context", null, exits(4, 11, 1, 2, 3, 7, 9, 10)],
  ])("follows the request's account context without an explicit account: %s", async (_label, stored, expected) => {
    if (stored !== null) m.cookies.set("tos_account", stored);
    const { rows } = await download("");
    expect(rows.map(row => row.exited_at)).toEqual(expected);
  });

  it("ignores the stored context when the link names its account", async () => {
    m.cookies.set("tos_account", FTMO);
    expect((await download(`?account=${PERSONAL}`)).rows.map(row => row.exited_at)).toEqual(exits(3, 7));
  });

  it.each([
    ["an active account", PERSONAL, exits(3, 7), "personal-12k"],
    ["an archived account", OLD, exits(4), "old-prop"],
  ])("narrows All Accounts with EDGE's read-only account filter (%s) and names the file after that account", async (_label, id, expected, slug) => {
    m.cookies.set("tos_account", "all");
    for (const query of [`?account=all&accountFilter=${id}`, `?accountFilter=${id.toUpperCase()}`]) {
      const { response, rows } = await download(query);
      expect(rows.map(row => row.exited_at)).toEqual(expected);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="trading-os-closed-trades-${slug}-2026-10-23.csv"`);
    }
  });

  it("applies the account filter as EDGE does: an account context wins, and an account the user cannot read matches nothing", async () => {
    const explicit = await download(`?account=${FTMO}&accountFilter=${PERSONAL}`);
    expect(explicit.rows.map(row => row.exited_at)).toEqual(exits(11, 1, 2, 9, 10));
    expect(explicit.response.headers.get("content-disposition")).toContain('filename="trading-os-closed-trades-ftmo-100k-2026-10-23.csv"');
    m.cookies.set("tos_account", FTMO);
    expect((await download(`?accountFilter=${PERSONAL}`)).rows.map(row => row.exited_at)).toEqual(exits(11, 1, 2, 9, 10));
    // Another user's account only ever narrows the read: the file is the header alone, never a broader one.
    const foreign = await download(`?account=all&accountFilter=${FOREIGN}`);
    expect(foreign.response.status).toBe(200);
    expect(foreign.text).toBe(CSV_COLUMNS.join(","));
    expect(foreign.response.headers.get("content-disposition")).toContain('filename="trading-os-closed-trades-all-accounts-2026-10-23.csv"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("filters", () => {
  it.each([
    ["origin=live-first", exits(2, 7, 10)],
    ["origin=imported", exits(3)],
    ["origin=planned", exits(4, 11, 1, 9)],
    ["model=OTE", exits(11, 1, 10)],
    ["session=ASIA", exits(3)],
    ["session=DEAD_POOL", exits(11)],
    ["instrument=eurusd", exits(11, 1, 9)],
    ["closedFrom=2026-10-05&closedTo=2026-10-06", exits(1, 2, 3)],
    ["closedFrom=2026-10-06&closedTo=2026-10-05", exits(1, 2, 3)],
    ["range=month", exits(1, 2, 3, 7, 9, 10)],
    ["range=30d", exits(11, 1, 2, 3, 7, 9, 10)],
    ["range=last-month", exits(4, 11)],
    ["range=month&origin=live-first&session=ACTIVE_KILL_ZONE", exits(2, 10)],
  ])("EDGE filter %s", async (query, expected) => {
    expect((await download(`?account=all&${query}`)).rows.map(row => row.exited_at)).toEqual(expected);
  });

  it.each([
    ["from=2026-10-06&to=2026-10-08 (V1 exit-day bounds)", exits(3, 7)],
    ["session=ASIAN_RANGE", exits(3)],
    ["session=OTHER (no recorded entry time)", exits(7)],
    ["weekday=monday", exits(4, 11, 1, 2)],
    [`strategy=${STRATEGY}`, exits(11, 1, 9)],
    [`risk=${RISK_OLD}`, exits(4)],
    ["outcome=LOSS", exits(4, 2)],
    ["period=month", exits(1, 2, 3, 7, 9, 10)],
    ["from=2026-09-01&closedFrom=2026-10-01&to=2026-10-06 (bounds intersect)", exits(1, 2, 3)],
    ["model=OB_FIRST_TOUCH&weekday=Friday", exits(9)],
  ])("V1 link %s", async (query, expected) => {
    expect((await download(`?account=all&${query.split(" ")[0]}`)).rows.map(row => row.exited_at)).toEqual(expected);
  });

  it("keeps V1's period=last30: the last 30 closed trades in exit order, after every other filter", async () => {
    // 31 more FTMO trades, one per day of August: 36 closed FTMO trades in all.
    const august = Array.from({ length: 31 }, (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`);
    db.tables.trade_ledger.push(...august.map((day, index) => closed(100 + index, { entered_at: `${day}T12:00:00Z`, exited_at: `${day}T13:00:00Z`, net_pnl: "1" })));
    const { rows } = await download(`?account=${FTMO}&period=last30`);
    expect(rows).toHaveLength(LAST_CLOSED);
    expect(rows[0].exited_at).toBe("2026-08-07T13:00:00Z");
    expect(rows.at(-1)?.exited_at).toBe(EXIT[10]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EDGE: the export matches what the page shows", () => {
  const PAGES: [string, string, Record<string, string>][] = [
    ["All Accounts, every filter off", "all", {}],
    ["All Accounts, live-first trades only", "all", { origin: "live-first" }],
    ["All Accounts, imported trades only", "all", { origin: "imported" }],
    ["All Accounts, this month, kill zone", "all", { range: "month", session: "ACTIVE_KILL_ZONE" }],
    ["FTMO, last 30 days, OTE", FTMO, { range: "30d", model: "OTE" }],
    ["FTMO, custom exit days, one instrument", FTMO, { closedFrom: "2026-09-01", closedTo: "2026-10-09", instrument: "EURUSD" }],
    ["Personal, every filter off", PERSONAL, {}],
    ["All Accounts narrowed to Personal by the account filter", "all", { accountFilter: PERSONAL }],
    ["All Accounts narrowed to Personal by the account filter, imported trades only", "all", { accountFilter: PERSONAL, origin: "imported" }],
    ["All Accounts narrowed to the archived account by the account filter", "all", { accountFilter: OLD }],
  ];

  it.each(PAGES)("%s: each offered file holds exactly the trades the page counts", async (_label, context, params) => {
    m.cookies.set("tos_account", context);
    const edge = await loadEdge(params);
    const links = exportLinks(edge);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const scoped = link.href.includes(`account=${ALL_ACCOUNTS_SCOPE}&`) || link.href.endsWith(`account=${ALL_ACCOUNTS_SCOPE}`)
        ? edge.rows
        : edge.rows.filter(row => link.href.includes(`account=${row.account_id}`));
      const expected = [...scoped].sort(byExit).map(row => row.exited_at);
      const { response, rows } = await fetchHref(link.href);
      expect(response.status).toBe(200);
      expect(rows.map(row => row.exited_at)).toEqual(expected);
      expect(link.detail.startsWith(`${expected.length} ${expected.length === 1 ? "trade" : "trades"} · `)).toBe(true);
    }
  });

  it("offers All Accounts first, then one file per account with trades on the page, each with its count and currency", async () => {
    m.cookies.set("tos_account", "all");
    const edge = await loadEdge({});
    expect(exportLinks(edge).map(link => [link.label, link.detail])).toEqual([
      ["All Accounts", "8 trades · EUR, USD"], ["FTMO 100K", "5 trades · USD"], ["Personal 12K", "2 trades · EUR"], ["=Old prop · archived", "1 trade · USD"],
    ]);
    // One account with trades on the page: its file is the All Accounts file, offered once.
    const asia = await loadEdge({ session: "ASIA" });
    expect(exportLinks(asia).map(link => link.label)).toEqual(["All Accounts"]);
    m.cookies.set("tos_account", FTMO);
    const one = await loadEdge({ range: "month", model: "OTE", origin: "live-first" });
    expect(exportLinks(one)).toEqual([
      { label: "FTMO 100K", detail: "1 trade · USD", href: `/edge/export?account=${FTMO}&closedFrom=2026-10-01&closedTo=2026-10-23&origin=live-first&model=OTE` },
    ]);
  });

  it("labels the file of a page narrowed by the account filter with that account (archived ones marked) and names the file after it", async () => {
    m.cookies.set("tos_account", "all");
    const cases: [string, string, string, string][] = [
      [PERSONAL, "Personal 12K", "2 trades · EUR", "personal-12k"],
      [OLD, "=Old prop · archived", "1 trade · USD", "old-prop"],
    ];
    for (const [id, label, detail, slug] of cases) {
      const edge = await loadEdge({ accountFilter: id });
      const links = exportLinks(edge);
      expect(links).toEqual([{ label, detail, href: `/edge/export?account=all&accountFilter=${id}` }]);
      const { response } = await fetchHref(links[0].href);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="trading-os-closed-trades-${slug}-2026-10-23.csv"`);
      // The menu as the page renders it: one file, named by its account, never "All Accounts".
      const html = renderToStaticMarkup(createElement(EdgeScreen, { data: edge }));
      expect(html).toContain(`<a href="/edge/export?account=all&amp;accountFilter=${id}" download="">`);
      expect(html).not.toMatch(/<span class="min-w-0 flex-1 truncate">All Accounts<\/span>/);
    }
    // An account the user cannot read: the page shows no trade, and no file is offered.
    const foreign = await loadEdge({ accountFilter: FOREIGN });
    expect(foreign.rows).toEqual([]);
    expect(exportLinks(foreign)).toEqual([]);
  });

  it("offers no file while the page's read is incomplete, and says why next to the unavailable action", async () => {
    m.cookies.set("tos_account", "all");
    m.truncate = true;
    const edge = await loadEdge({});
    expect(edge.truncated).toBe(true);
    expect(exportUnavailable(edge)).toBe(TOO_MANY_TRADES);
    const html = renderToStaticMarkup(createElement(EdgeScreen, { data: edge }));
    // No download link at all: the server refuses that file (422), and a refused download fails without a word.
    expect(html).not.toContain("/edge/export");
    expect((await download("?account=all")).response.status).toBe(422);
    const trigger = /<button([^>]*)>(?:(?!<\/button>).)*Export closed trades \(CSV\)/.exec(html)?.[1] ?? "";
    expect(trigger).toContain('disabled=""');
    const describedBy = /aria-describedby="([^"]+)"/.exec(trigger)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<p id="${describedBy}" class="t-caption md:text-right">${TOO_MANY_TRADES}</p>`);
    m.truncate = false;
    expect(exportUnavailable(await loadEdge({}))).toBeUndefined();
  });

  it("links carry the page's effective exit days, so a file downloaded after midnight still holds what the page showed", async () => {
    m.cookies.set("tos_account", FTMO);
    const edge = await loadEdge({ range: "month" });
    const [link] = exportLinks(edge);
    vi.setSystemTime(new Date("2026-11-02T15:00:00.000Z"));
    const { rows } = await fetchHref(link.href);
    expect(rows.map(row => row.exited_at)).toEqual(exits(1, 2, 9, 10));
  });

  it("offers the export under a live-first or imported origin filter (no planned-only restriction)", async () => {
    m.cookies.set("tos_account", "all");
    for (const origin of ["live-first", "imported"]) {
      const edge: EdgeData = await loadEdge({ origin });
      const html = renderToStaticMarkup(createElement(EdgeScreen, { data: edge }));
      // The trigger itself: the button whose content holds the label is enabled.
      const trigger = /<button([^>]*)>(?:(?!<\/button>).)*Export closed trades \(CSV\)/.exec(html);
      expect(trigger).not.toBeNull();
      expect(trigger?.[1]).not.toContain("disabled");
      expect(html).not.toContain("planned trades only");
      expect(html).not.toContain("to export");
      expect(html).toContain(`href="/edge/export?account=all&amp;origin=${origin}"`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("export menu", () => {
  it("says what the file holds before any download, and offers plain download links", () => {
    expect(EXPORT_LABEL).toBe("Export closed trades (CSV)");
    expect(EXPORT_NOTE).toContain("planned, live-first and imported");
    expect(EXPORT_NOTE).toContain("never converted");
    const html = renderToStaticMarkup(createElement(ExportMenu, {
      links: [
        { label: "All Accounts", detail: "8 trades · EUR, USD", href: "/edge/export?account=all&origin=live-first" },
        { label: "FTMO 100K", detail: "5 trades · USD", href: `/edge/export?account=${FTMO}&origin=live-first` },
      ],
    }));
    expect(html).toContain(EXPORT_NOTE.replace(/'/g, "&#x27;"));
    // Screen readers hear the note as the menu's description.
    const describedBy = /role="menu" aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<div data-menu-label="" id="${describedBy}">${EXPORT_NOTE.replace(/'/g, "&#x27;")}</div>`);
    expect(html).toContain('<a href="/edge/export?account=all&amp;origin=live-first" download="">');
    expect(html).toContain("8 trades · EUR, USD");
    expect(html).not.toContain("disabled");
    expect(renderToStaticMarkup(createElement(ExportMenu, { links: [] }))).toBe("");
  });

  it("shows the action unavailable, with its reason in visible words linked to it, instead of links the server would refuse", () => {
    const html = renderToStaticMarkup(createElement(ExportMenu, {
      links: [{ label: "All Accounts", detail: "8 trades · EUR, USD", href: "/edge/export?account=all" }],
      unavailable: TOO_MANY_TRADES,
    }));
    expect(html).not.toContain("/edge/export");
    expect(html).not.toContain('role="menu"');
    const trigger = /<button([^>]*)>/.exec(html)?.[1] ?? "";
    expect(trigger).toContain('disabled=""');
    const describedBy = /aria-describedby="([^"]+)"/.exec(trigger)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<p id="${describedBy}" class="t-caption md:text-right">${TOO_MANY_TRADES}</p>`);
    expect(html).toContain(EXPORT_LABEL);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("request contract", () => {
  it("round-trips EDGE states: the link parses back to exactly the filters the page applies", () => {
    const states = [
      {}, { range: "month", model: "OTE" }, { range: "30d", origin: "imported", session: "ASIA" }, { closedFrom: "2026-10-09", closedTo: "2026-10-01", instrument: "de40" },
      { range: "ytd", origin: "live-first", model: "OB_FIRST_TOUCH", session: "DEAD_POOL", instrument: "XAUUSD" }, { accountFilter: OLD.toUpperCase(), range: "90d" },
    ];
    for (const params of states) {
      const query = parseEdgeQuery(params, NOW);
      for (const account of [ALL_ACCOUNTS_SCOPE, FTMO]) {
        const parsed = parseExportRequest(new URLSearchParams(exportHref(query, account).split("?")[1]), NOW);
        expect(parsed).toEqual({
          ok: true,
          request: { scope: account === ALL_ACCOUNTS_SCOPE ? { mode: "all" } : { mode: "account", accountId: FTMO }, filters: edgeFilters(query), withoutEntryTime: false, last: null },
        });
      }
    }
  });

  it("names every unreadable value and refuses V1 inverted dates with the V1 message", () => {
    expect(parseExportRequest(new URLSearchParams("account=first&model=SCALP&weekday=Funday&strategy=1&risk=0.5&outcome=OPEN&period=week&from=2026-13-01"), NOW))
      .toEqual({ ok: false, error: "Some filters in this export link couldn't be read: account, model, from, period, weekday, strategy, risk, outcome." });
    expect(parseExportRequest(new URLSearchParams("from=2026-10-09&to=2026-10-01"), NOW)).toEqual({ ok: false, error: "Start date must be on or before end date." });
    expect(parseExportRequest(new URLSearchParams(""), NOW)).toEqual({ ok: true, request: { scope: { mode: "context" }, filters: {}, withoutEntryTime: false, last: null } });
  });

  it("ignores calendar navigation and unknown parameters, which never change what the page counts", () => {
    const navigation = parseExportRequest(new URLSearchParams("account=all&model=OTE&month=2026-13&view=pie&day=someday&currency=dollars&tab=x"), NOW);
    expect(navigation).toEqual({ ok: true, request: { scope: { mode: "all" }, filters: { model: "OTE" }, withoutEntryTime: false, last: null } });
  });

  it("reads V1 names with their V1 meanings, never the Journal's (risk is a risk-plan version, from/to are exit days)", () => {
    const parsed = parseExportRequest(new URLSearchParams(`from=2026-10-01&to=2026-10-09&risk=${RISK}&strategy=${STRATEGY}&weekday=friday&outcome=win`), NOW);
    expect(parsed).toEqual({
      ok: true,
      request: {
        scope: { mode: "context" }, withoutEntryTime: false, last: null,
        filters: { closedFrom: "2026-10-01", closedTo: "2026-10-09", riskPlanVersionId: RISK, strategyVersionId: STRATEGY, weekday: "Friday", result: "WIN" },
      },
    });
  });

  it("derives V1 session, weekday and daily sequence words", () => {
    expect([legacySession("2026-10-06T23:30:00Z"), legacySession("2026-10-05T06:30:00Z"), legacySession("2026-10-05T12:00:00Z"), legacySession("2026-10-05T18:00:00Z"), legacySession(null)])
      .toEqual(["ASIAN_RANGE", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL", "OTHER"]);
    expect([legacyWeekday("2026-10-07T03:30:00Z"), legacyWeekday(null)]).toEqual(["Tuesday", "NO DATA"]);
    const sequences = dailySequences([
      { id: tid(1), accountId: FTMO, enteredAt: "2026-10-05T12:00:00.000001Z" },
      { id: tid(2), accountId: FTMO, enteredAt: "2026-10-05T12:00:00Z" },
      { id: tid(3), accountId: PERSONAL, enteredAt: "2026-10-05T12:00:00Z" },
      { id: tid(4), accountId: FTMO, enteredAt: "2026-10-06T04:59:59Z" },
    ]);
    // Microseconds order; accounts and strategy days are separate (04:59:59Z is still Oct 5 at UTC−5).
    expect(Object.fromEntries(sequences)).toEqual({ [tid(2)]: 1, [tid(1)]: 2, [tid(4)]: 3, [tid(3)]: 1 });
  });

  it("writes CSV cells exactly: quoted, formula-guarded, tags joined, empty values blank", () => {
    const trade = { ...(closed(1, { exited_at: "2026-10-05T15:00:00Z", net_pnl: "-5", tags: ["a", "b"], symbol: "+X" }) as unknown as LedgerTrade) };
    const text = closedTradesCsv([trade], { accountNames: new Map([[FTMO, 'Say "hi"']]), sequences: new Map(), riskPercents: new Map() });
    const [, line] = text.split("\r\n");
    expect(line.startsWith(`"'+X","OTE","LONG","CLOSED",`)).toBe(true);
    expect(line).toContain(`"Say ""hi"""`);
    expect(line).toContain(`"a; b"`);
    expect(line).toContain(`"-5"`);
    expect(text.startsWith(`${BYTE_ORDER_MARK}instrument,`)).toBe(true);
    expect(closedTradesCsv([], { accountNames: new Map(), sequences: new Map(), riskPercents: new Map() })).toBe(`${BYTE_ORDER_MARK}${CSV_COLUMNS.join(",")}`);
    expect([BYTE_ORDER_MARK.length, BYTE_ORDER_MARK.charCodeAt(0)]).toEqual([1, 0xfeff]);
  });

  it("names files in ASCII", () => {
    expect(exportFilename("Démo Ünïcode 12K", "2026-10-23")).toBe("trading-os-closed-trades-demo-unicode-12k-2026-10-23.csv");
    expect(exportFilename("日本", "2026-10-23")).toBe("trading-os-closed-trades-account-2026-10-23.csv");
    expect(exportFilename(null, "2026-10-23")).toBe("trading-os-closed-trades-all-accounts-2026-10-23.csv");
  });
});
