import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

// V2 data layer (docs/V2_ARCHITECTURE.md §2, §5.4, §6.7, §9, §13.10, §14): account context without a fake All Accounts
// record, the schema gate, per-account workspaces, the Journal list (strict ledger parsing, filters, keyset pagination
// over the computed trade date), the trade detail view model, Today, Accounts and EDGE loaders. Every query runs on an
// in-memory PostgREST double that evaluates the real filters, so ordering, pagination and filter semantics are tested.

const m = vi.hoisted(() => ({
  session: null as unknown,
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  loadHistory: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (m.cookies.has(name) ? { name, value: m.cookies.get(name) } : undefined) }),
  headers: async () => ({ get: (name: string) => m.headers.get(name) ?? null }),
}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => m.session }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/ai-history", () => ({
  loadTradeAiHistory: m.loadHistory,
  timelineAiAnalyses: (rows: { technical: { requestId: string }; operation: string; status: string; completedAt: string | null; requestedAt: string; headline: string | null }[]) =>
    rows.map(row => ({ id: row.technical.requestId, operation: row.operation, status: row.status, recordedAt: row.completedAt ?? row.requestedAt, summary: row.headline })),
}));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability }));

import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { evaluateRisk, type DailyUsage } from "@/domain/risk";
import {
  ACCOUNT_UNAVAILABLE_NOTICE, type ContextAccount, contextAccount, getAccountContext, loadAccounts, resolveAccountContext, resolvePreferences,
} from "@/lib/account-context";
import { balanceCurve, loadAccountManage, loadAccountsOverview, minimumRrWarning, riskPlanTimeline } from "@/lib/accounts-data";
import {
  accountHistoryDrill, accountHistoryJournalHref, accountJournalHref, buildPerformance, breakdownHref, closedOnHref, distributionBinHref, loadLedgerRows, shiftMonth,
} from "@/lib/performance-data";
import { checkSchema, SCHEMA_OUTDATED_MESSAGE, schemaStatusFromRpc, SchemaUnavailableError, writableSession } from "@/lib/schema-gate";
import { loadToday, TODAY_LIVE_LIMIT, TODAY_WAITING_LIMIT } from "@/lib/today-data";
import {
  accountFilterLabel, countLedgerTrades, decodeTradeCursor, encodeTradeCursor, filteredScope, journalHref, loadLedgerPage, loadPaletteTrades, loadTradeDetail,
  loadTradeList, MAX_COUNT_SCAN, parseTradeFilters, resolveAccountFilter, tradeFilterParams, type TradeFilters,
} from "@/lib/trades-data";
import { type AccountWorkspace, isCheckCurrent, latestInstrumentVersions, loadAccountWorkspace, parseInstrumentRows, riskContextFor } from "@/lib/workspace";

// ---------------------------------------------------------------------------------------------------------------------
// In-memory PostgREST double.
// ---------------------------------------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
interface Call { table: string; select: string; filters: string[]; orders: string[]; limit: number | null; count: "exact" | null; head: boolean }
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

function columnValue(row: Row, column: string): unknown {
  const [base, key] = column.split("->>");
  const value = row[base];
  return key === undefined ? value : value && typeof value === "object" ? (value as Row)[key] : undefined;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string" && INSTANT.test(a) && INSTANT.test(b)) {
    const micros = (text: string) => {
      const [main, fraction = ""] = text.replace(/(Z|[+-]\d{2}:\d{2})$/, "").split(".");
      return BigInt(Date.parse(`${main}${text.match(/(Z|[+-]\d{2}:\d{2})$/)?.[0] ?? "Z"}`)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3, 6) || "0");
    };
    const x = micros(a);
    const y = micros(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if ((typeof a === "number" || (typeof a === "string" && NUMERIC.test(a))) && (typeof b === "number" || (typeof b === "string" && NUMERIC.test(b)))) {
    return new Decimal(a).comparedTo(b);
  }
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function likeRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) source += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (character === "%" || character === "*") source += ".*";
    else if (character === "_") source += ".";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "is");
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (character === "(") depth++;
    if (character === ")") depth--;
    current += character;
  }
  return [...parts, current];
}

function condition(term: string): Predicate {
  if (term.startsWith("and(")) {
    const inner = splitTop(term.slice(4, -1)).map(condition);
    return row => inner.every(predicate => predicate(row));
  }
  const first = term.indexOf(".");
  const second = term.indexOf(".", first + 1);
  const column = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const rawValue = term.slice(second + 1);
  const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
  switch (op) {
    case "eq": return row => compare(columnValue(row, column), value) === 0;
    case "lt": return row => columnValue(row, column) !== null && compare(columnValue(row, column), value) < 0;
    case "gt": return row => columnValue(row, column) !== null && compare(columnValue(row, column), value) > 0;
    case "ilike": return row => typeof columnValue(row, column) === "string" && likeRegExp(value).test(columnValue(row, column) as string);
    case "in": {
      const values = value.slice(1, -1).split(",");
      return row => values.includes(String(columnValue(row, column)));
    }
    default: throw new Error(`Unsupported or-filter ${term}`);
  }
}

type Result = { data: unknown; error: { message: string } | null; count: number | null };

class Query implements PromiseLike<Result> {
  private readonly predicates: Predicate[] = [];
  private readonly orders: [string, boolean][] = [];
  private cap: number | null = null;
  private mode: "many" | "maybe" | "single" = "many";
  private columns = "*";
  readonly call: Call;

  constructor(private readonly db: FakeDb, private readonly table: string) {
    this.call = { table, select: "*", filters: [], orders: [], limit: null, count: null, head: false };
    db.calls.push(this.call);
  }

  private add(text: string, predicate: Predicate): this {
    this.call.filters.push(text);
    this.predicates.push(predicate);
    return this;
  }

  /** PostgREST's `count=exact` counts every matching row (before `limit`); `head` returns the count without rows. */
  select(columns = "*", options: { count?: "exact"; head?: boolean } = {}): this {
    this.columns = columns;
    this.call.select = columns;
    this.call.count = options.count ?? null;
    this.call.head = options.head ?? false;
    return this;
  }
  eq(column: string, value: unknown): this { return this.add(`eq:${column}:${value}`, row => compare(columnValue(row, column), value) === 0); }
  neq(column: string, value: unknown): this { return this.add(`neq:${column}:${value}`, row => compare(columnValue(row, column), value) !== 0); }
  gt(column: string, value: unknown): this { return this.add(`gt:${column}:${value}`, row => columnValue(row, column) !== null && compare(columnValue(row, column), value) > 0); }
  gte(column: string, value: unknown): this { return this.add(`gte:${column}:${value}`, row => columnValue(row, column) !== null && compare(columnValue(row, column), value) >= 0); }
  lt(column: string, value: unknown): this { return this.add(`lt:${column}:${value}`, row => columnValue(row, column) !== null && compare(columnValue(row, column), value) < 0); }
  lte(column: string, value: unknown): this { return this.add(`lte:${column}:${value}`, row => columnValue(row, column) !== null && compare(columnValue(row, column), value) <= 0); }
  in(column: string, values: readonly unknown[]): this { return this.add(`in:${column}:${values.join("|")}`, row => values.some(value => compare(columnValue(row, column), value) === 0)); }
  is(column: string, value: null): this { return this.add(`is:${column}:${value}`, row => columnValue(row, column) === null || columnValue(row, column) === undefined); }
  not(column: string, operator: string, value: null): this {
    if (operator !== "is" || value !== null) throw new Error("Unsupported not-filter");
    return this.add(`not:${column}:is:null`, row => columnValue(row, column) !== null && columnValue(row, column) !== undefined);
  }
  contains(column: string, values: readonly string[]): this { return this.add(`cs:${column}:${values.join("|")}`, row => Array.isArray(row[column]) && values.every(value => (row[column] as unknown[]).includes(value))); }
  ilike(column: string, pattern: string): this { return this.add(`ilike:${column}:${pattern}`, row => typeof columnValue(row, column) === "string" && likeRegExp(pattern).test(columnValue(row, column) as string)); }
  or(filters: string): this {
    const terms = splitTop(filters).map(condition);
    return this.add(`or:${filters}`, row => terms.some(predicate => predicate(row)));
  }
  order(column: string, options: { ascending?: boolean } = {}): this {
    const ascending = options.ascending ?? true;
    this.call.orders.push(`${column}:${ascending ? "asc" : "desc"}`);
    this.orders.push([column, ascending]);
    return this;
  }
  limit(count: number): this { this.cap = count; this.call.limit = count; return this; }
  maybeSingle(): this { this.mode = "maybe"; return this; }
  single(): this { this.mode = "single"; return this; }

  private project(row: Row): Row {
    if (this.db.passthrough.has(this.table) || this.columns === "*") return { ...row };
    const out: Row = {};
    for (const field of splitTop(this.columns)) {
      const name = field.includes(":") && field.includes("(") ? field.slice(0, field.indexOf(":")) : field.replace(/::text$/, "");
      if (Object.hasOwn(row, name)) out[name] = row[name];
    }
    return out;
  }

  private run(): Result {
    if (this.db.failing.has(this.table)) return { data: null, error: { message: "permission denied for internal_relation_42" }, count: null };
    let rows = (this.db.tables[this.table] ?? []).filter(row => this.predicates.every(predicate => predicate(row)));
    const count = this.call.count === "exact" ? rows.length : null;
    if (this.call.head) return { data: null, error: null, count };
    rows = [...rows].sort((a, b) => {
      for (const [column, ascending] of this.orders) {
        const x = columnValue(a, column);
        const y = columnValue(b, column);
        if (x === y) continue;
        if (x === null || x === undefined) return ascending ? 1 : -1;
        if (y === null || y === undefined) return ascending ? -1 : 1;
        const order = compare(x, y);
        if (order !== 0) return ascending ? order : -order;
      }
      return 0;
    });
    if (this.cap !== null) rows = rows.slice(0, this.cap);
    const data = rows.map(row => this.project(row));
    if (this.mode === "many") return { data, error: null, count };
    if (data.length > 1) return { data: null, error: { message: "multiple rows" }, count: null };
    return { data: data[0] ?? null, error: null, count };
  }

  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A = Result, B = never>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  readonly calls: Call[] = [];
  readonly rpcCalls: { fn: string; args: unknown }[] = [];
  readonly failing = new Set<string>();
  readonly passthrough = new Set<string>();
  readonly auth = { getUser: async () => ({ data: { user: { id: USER, email: "trader@example.test" } }, error: null }) };
  constructor(readonly tables: Record<string, Row[]> = {}, readonly rpcs: Record<string, (args: Row) => { data: unknown; error: { message: string; code?: string } | null }> = {}) {}
  from(table: string): Query { return new Query(this, table); }
  async rpc(fn: string, args: Row = {}) {
    this.rpcCalls.push({ fn, args });
    const handler = this.rpcs[fn];
    return handler ? handler(args) : { data: null, error: { message: `missing rpc ${fn}`, code: "PGRST202" } };
  }
  ledgerCalls(): Call[] { return this.calls.filter(call => call.table === "trade_ledger"); }
}

const asDb = (db: FakeDb) => db as never;

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------------------------------
const USER = "10000000-0000-4000-8000-000000000001";
const A1 = "20000000-0000-4000-8000-000000000001";
const A2 = "20000000-0000-4000-8000-000000000002";
const A3 = "20000000-0000-4000-8000-000000000003";
const I1 = "30000000-0000-4000-8000-000000000001";
const I1_OLD = "30000000-0000-4000-8000-000000000009";
const R1 = "40000000-0000-4000-8000-000000000001";
const S1 = "50000000-0000-4000-8000-000000000001";
const O1 = "60000000-0000-4000-8000-000000000001";
const NOW = "2026-10-14T14:00:00.000Z";
const DAY = "2026-10-14";
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tradeId = (n: number) => uuid("a", n);

function account(id: string, overrides: Partial<ContextAccount> = {}): ContextAccount {
  return {
    id, name: `Account ${id.slice(-1)}`, currency: "USD", type: "DEMO", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "10000",
    createdAt: "2026-09-01T10:00:00.000Z", profile: "PROFILE", ...overrides,
  };
}

function ledger(id: string, overrides: Partial<LedgerTrade> = {}): LedgerTrade {
  const base: LedgerTrade = {
    id, account_id: A1, origin: "PLANNED", created_at: "2026-10-10T10:00:00.000Z", duplicated_from: null, migrated_from: null, currency: "USD",
    revision_count: 1, latest_revision: 1, latest_proposal_id: uuid("7", Number.parseInt(id.slice(-4), 10)), latest_revision_at: "2026-10-10T10:00:00.000Z",
    latest_check_decision: null, latest_check_at: null, latest_check_evaluation_id: null,
    plan_id: null, locked_at: null, plan_trading_day: null, strategy_version_id: null, strategy_version: null, risk_plan_version_id: null, risk_plan_version: null,
    symbol: "EURUSD", instrument_version_id: I1, direction: "LONG", entry_model: "OB_FIRST_TOUCH",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "50",
    entry_price: null, entered_at: null, entry_time_known: false, entry_recorded_at: null, quantity: null, initial_stop: null, initial_risk: null, actual_initial_risk: null, oversize: null,
    exit_price: null, exited_at: null, close_recorded_at: null, fees: null, gross_pnl: null, net_pnl: null, realized_r: null, outcome: null, calculation_version: null, pnl_source: null,
    disposition: null, disposition_reason: null, legacy_decision: null, discarded_at: null,
    lifecycle: "DRAFT", draft_check: "UNCHECKED", review_completed_at: null,
    setup_grade: null, liquidity_context: null, mss_timeframe: null, tags: [], tag_source: null,
    evidence_count: 0, cover_evidence_id: null, cover_evidence_kind: null, journal_count: 0, ai_review_count: 0,
  };
  return { ...base, ...overrides };
}

function closed(id: string, exitedAt: string, r: string | null, net: string, overrides: Partial<LedgerTrade> = {}): LedgerTrade {
  const enteredAt = overrides.entered_at ?? "2026-10-10T13:00:00.000Z";
  return ledger(id, {
    plan_id: uuid("8", Number.parseInt(id.slice(-4), 10)), locked_at: "2026-10-10T12:00:00.000Z", entry_price: "1.1", entered_at: enteredAt, entry_time_known: true,
    entry_recorded_at: enteredAt, quantity: "0.25", initial_stop: "1.098", initial_risk: "50", actual_initial_risk: "50", oversize: false, exit_price: "1.106",
    exited_at: exitedAt, close_recorded_at: exitedAt, fees: "0", gross_pnl: net, net_pnl: net, realized_r: r, outcome: new Decimal(net).gt(0) ? "WIN" : new Decimal(net).lt(0) ? "LOSS" : "BREAKEVEN",
    calculation_version: "FULL_CLOSE_V1", pnl_source: "CALCULATED", lifecycle: "CLOSED", draft_check: null, ...overrides,
  });
}

const ledgerRow = (trade: LedgerTrade): Row => ({ ...trade });

function usage(overrides: Partial<DailyUsage> = {}): DailyUsage {
  return {
    day: DAY, plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0",
    legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0", ...overrides,
  };
}

function accountTables(accountId: string, options: { currency?: string } = {}): Record<string, Row[]> {
  return {
    account_observations: [
      { id: O1, account_id: accountId, user_id: USER, balance: "10000.00", equity: "10000.00", gross_loss_today: null, trading_day: DAY, recorded_at: "2026-10-14T12:00:00.000Z" },
      { id: uuid("6", 2), account_id: accountId, user_id: USER, balance: "9500.00", equity: "9500.00", gross_loss_today: null, trading_day: "2026-10-01", recorded_at: "2026-10-01T12:00:00.000Z" },
    ],
    risk_plan_versions: [
      { id: R1, account_id: accountId, user_id: USER, version: "Risk Plan V1.0", effective_day: "2026-10-01", created_at: "2026-10-01T10:00:00.000Z", max_risk_percent: "0.50000000", default_risk_percent: null, max_daily_trades: 2, min_rr: "3.00000000", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: null, override_reason: null },
    ],
    strategy_versions: [{ id: S1, account_id: accountId, user_id: USER, version: "ICT V1.0", rules: { version: "ICT V1.0", minimum_rr: "3" } }],
    instrument_versions: [
      { id: I1, account_id: accountId, user_id: USER, symbol: "EURUSD", currency: options.currency ?? "USD", quantity_unit: "lots (100,000 EUR)", tick_size: "0.00001000", pip_size: "0.00010000", tick_value: "1.00000000", quantity_step: "0.01000000", minimum_quantity: "0.01000000", created_at: "2026-10-02T10:00:00.000Z" },
      { id: I1_OLD, account_id: accountId, user_id: USER, symbol: "EURUSD", currency: options.currency ?? "USD", quantity_unit: "lots", tick_size: "0.00010000", pip_size: null, tick_value: "10.00000000", quantity_step: "0.10000000", minimum_quantity: "0.10000000", created_at: "2026-09-02T10:00:00.000Z" },
    ],
  };
}

const PROPOSAL = {
  instrumentId: I1, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5",
  narrative: "Sweep of Asia low into H4 order block.", contractConfirmed: true, news: "CLEAR", contradiction: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.cookies.clear();
  m.headers.clear();
  m.loadHistory.mockResolvedValue(null);
  m.availability.mockResolvedValue({ status: "DISABLED", message: "", deepEnabled: false });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("schema gate (§3.11, §13.10)", () => {
  it.each([
    ["2.0", true, undefined],
    ["2.1", true, undefined],
    ["10.0", true, undefined],
    ["1.9", false, "OUTDATED"],
    ["two", false, "UNRECOGNIZED"],
    [null, false, "UNRECOGNIZED"],
  ] as const)("marker %s → ready %s", (data, ready, reason) => {
    const status = schemaStatusFromRpc({ data, error: null });
    expect(status.ready).toBe(ready);
    if (!status.ready) expect(status.reason).toBe(reason);
  });

  it.each(["PGRST202", "42883"])("a missing marker function (%s) is MISSING, never a crash", code => {
    expect(schemaStatusFromRpc({ data: null, error: { code, message: "function does not exist" } })).toEqual({ ready: false, reason: "MISSING", version: null });
  });

  it("any other error is unavailable (no write may assume either answer)", () => {
    expect(() => schemaStatusFromRpc({ data: null, error: { code: "08006", message: "connection failure" } })).toThrow(SchemaUnavailableError);
  });

  it("reads the marker through the user's session and gates writes", async () => {
    const db = new FakeDb({}, { trading_os_schema: () => ({ data: "2.0", error: null }) });
    m.session = { db, user: { id: USER } };
    expect(await checkSchema(asDb(db))).toEqual({ ready: true, version: "2.0" });
    expect(db.rpcCalls).toEqual([{ fn: "trading_os_schema", args: {} }]);
    expect(await writableSession()).toEqual({ db, user: { id: USER } });
    const outdated = new FakeDb({}, { trading_os_schema: () => ({ data: "1.0", error: null }) });
    m.session = { db: outdated, user: { id: USER } };
    expect(await writableSession()).toBeNull();
    expect(SCHEMA_OUTDATED_MESSAGE).toBe("Database update required — this deployment expects Trading OS database version 2.0. No changes were made.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("account context (§9.1–9.2)", () => {
  const active = account(A1, { name: "FTMO 100K" });
  const second = account(A2, { name: "Personal", currency: "EUR" });
  const archived = account(A3, { name: "Old demo", status: "ARCHIVED" });
  const accounts = [active, second, archived];

  it("defaults to All Accounts without inventing an account record", () => {
    const context = resolveAccountContext({ accounts, stored: undefined, lastAccount: undefined, proxyNotice: false });
    expect(context.selected).toEqual({ mode: "all" });
    expect(context.accounts).toEqual(accounts);
    expect(context.notice).toBeNull();
    expect(context.scopeAccountIds).toEqual([A1, A2, A3]);
    expect(JSON.stringify(context)).not.toMatch(/All Accounts"|"id":"all"/);
  });

  it("selects an active account from the cookie (ids compare case-insensitively)", () => {
    const context = resolveAccountContext({ accounts, stored: A2.toUpperCase(), lastAccount: undefined, proxyNotice: false });
    expect(context.selected).toEqual({ mode: "account", account: second });
    expect(context.scopeAccountIds).toEqual([A2]);
    expect(context.formDefaultAccountId).toBe(A2);
  });

  it.each([
    ["an archived account", A3],
    ["a foreign or unknown account", "20000000-0000-4000-8000-0000000000ff"],
  ])("resolves %s to All Accounts with ACCOUNT_UNAVAILABLE, never to the first account", (_label, stored) => {
    const context = resolveAccountContext({ accounts, stored, lastAccount: undefined, proxyNotice: false });
    expect(context.selected).toEqual({ mode: "all" });
    expect(context.notice).toBe("ACCOUNT_UNAVAILABLE");
    expect(context.noticeText).toBe(ACCOUNT_UNAVAILABLE_NOTICE);
    expect(context.noticeText).toBe("That trading account isn't available. Showing All Accounts.");
  });

  it("ignores malformed cookie values silently and shows the proxy's one-time notice", () => {
    expect(resolveAccountContext({ accounts, stored: "nonsense", lastAccount: undefined, proxyNotice: false }).notice).toBeNull();
    expect(resolveAccountContext({ accounts, stored: "all", lastAccount: undefined, proxyNotice: true }).notice).toBe("ACCOUNT_UNAVAILABLE");
  });

  it("defaults forms to the last used active account, else the only active account, else nothing", () => {
    expect(resolveAccountContext({ accounts, stored: "all", lastAccount: A2, proxyNotice: false }).formDefaultAccountId).toBe(A2);
    expect(resolveAccountContext({ accounts, stored: "all", lastAccount: A3, proxyNotice: false }).formDefaultAccountId).toBeNull();
    expect(resolveAccountContext({ accounts: [active, archived], stored: "all", lastAccount: undefined, proxyNotice: false }).formDefaultAccountId).toBe(A1);
    expect(resolveAccountContext({ accounts, stored: "all", lastAccount: undefined, proxyNotice: false }).formDefaultAccountId).toBeNull();
  });

  it("uses the latest profile revision and implicit defaults for an account without a profile", async () => {
    const row = { id: A1, name: "Bootstrap", currency: "USD", created_at: "2026-09-01T10:00:00.000Z" };
    expect(contextAccount(row, [])).toMatchObject({ name: "Bootstrap", platform: "MANUAL", type: "DEMO", status: "ACTIVE", startingBalance: null, profile: "DEFAULT" });
    const profiles = [
      { id: 1, account_id: A1, display_name: "Old", broker: null, platform: "MANUAL" as const, account_type: "DEMO" as const, starting_balance: "1000.00", status: "ACTIVE" as const },
      { id: 7, account_id: A1, display_name: "FTMO 100K", broker: "FTMO", platform: "MT5" as const, account_type: "EVALUATION" as const, starting_balance: "100000.00", status: "ARCHIVED" as const },
    ];
    expect(contextAccount(row, profiles)).toMatchObject({ name: "FTMO 100K", platform: "MT5", type: "EVALUATION", status: "ARCHIVED", startingBalance: "100000", profile: "PROFILE" });
    const db = new FakeDb({
      accounts: [{ ...row, user_id: USER }, { id: A2, name: "Second", currency: "EUR", created_at: "2026-09-02T10:00:00.000Z", user_id: USER }],
      account_profiles: profiles.map(profile => ({ ...profile, user_id: USER })),
    });
    const loaded = await loadAccounts(asDb(db), USER);
    expect(loaded.map(item => [item.name, item.profile])).toEqual([["FTMO 100K", "PROFILE"], ["Second", "DEFAULT"]]);
    expect(db.calls.every(call => call.filters.includes(`eq:user_id:${USER}`))).toBe(true);
  });

  it("reads the cookie and the proxy's notice header for the request", async () => {
    const db = new FakeDb({ accounts: [{ id: A1, name: "One", currency: "USD", created_at: "2026-09-01T10:00:00.000Z", user_id: USER }], account_profiles: [] });
    m.session = { db, user: { id: USER } };
    m.cookies.set("tos_account", A1);
    expect((await getAccountContext()).selected).toMatchObject({ mode: "account" });
    m.headers.set("x-tos-account-notice", "ACCOUNT_UNAVAILABLE");
    m.cookies.set("tos_account", "all");
    expect((await getAccountContext()).noticeText).toBe(ACCOUNT_UNAVAILABLE_NOTICE);
  });

  it("parses display preferences strictly", () => {
    const cookies = new Map([["tos_theme", "dark"], ["tos_time", "local"], ["tos_tz", "Europe/Berlin"], ["tos_dev", "1"], ["tos_sidebar", "collapsed"]]);
    expect(resolvePreferences(name => cookies.get(name))).toEqual({ theme: "dark", timeDisplay: { mode: "local", zone: "Europe/Berlin" }, developerMode: true, sidebarCollapsed: true });
    expect(resolvePreferences(name => ({ tos_theme: "neon", tos_time: "local", tos_tz: "Mars/Base" } as Record<string, string>)[name]))
      .toEqual({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("account workspace (§6.7)", () => {
  async function workspace(tables: Record<string, Row[]> = accountTables(A1), dailyUsage: DailyUsage = usage()): Promise<{ db: FakeDb; workspace: AccountWorkspace }> {
    const db = new FakeDb(tables, { get_daily_risk_usage: () => ({ data: dailyUsage, error: null }) });
    return { db, workspace: await loadAccountWorkspace(asDb(db), USER, account(A1), NOW) };
  }

  it("builds the engine context from the latest values, the active plan, the latest instrument versions and usage", async () => {
    const { db, workspace: w } = await workspace();
    expect(w.observation).toMatchObject({ id: O1, balance: "10000", equity: "10000", tradingDay: DAY });
    expect(w.riskPlan).toMatchObject({ id: R1, maxRiskPercent: "0.5", minRR: "3", defaultRiskPercent: null, maxDailyTrades: 2 });
    expect(w.instruments.map(instrument => instrument.id)).toEqual([I1]);
    expect(w.instruments[0]).toMatchObject({ tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01" });
    expect(w.status).toMatchObject({ allowed: true, headline: "You can trade" });
    expect(w.gaps).toEqual([]);
    expect(db.rpcCalls).toEqual([{ fn: "get_daily_risk_usage", args: { p_account_id: A1 } }]);
    const plan = db.calls.find(call => call.table === "risk_plan_versions");
    expect(plan?.filters).toEqual(expect.arrayContaining([`eq:account_id:${A1}`, `eq:user_id:${USER}`, `lte:effective_day:${DAY}`]));
    expect(plan?.orders).toEqual(["created_at:desc", "id:desc"]);
    const context = riskContextFor(w, I1);
    expect(context).toMatchObject({ now: NOW, observationId: O1, equity: "10000", currency: "USD", strategyVersionId: S1, usage: usage() });
  });

  it("applies the C9 precedence: an immediate tightening beats an earlier-created next-day loosening", async () => {
    const tables = accountTables(A1);
    const R2 = "40000000-0000-4000-8000-000000000002";
    const R3 = "40000000-0000-4000-8000-000000000003";
    tables.risk_plan_versions.push(
      { ...tables.risk_plan_versions[0], id: R2, version: "Risk Plan V1.1", effective_day: "2026-10-14", created_at: "2026-10-13T10:00:00.000Z", max_risk_percent: "1.00000000" },
      { ...tables.risk_plan_versions[0], id: R3, version: "Risk Plan V1.2", effective_day: "2026-10-13", created_at: "2026-10-13T11:00:00.000Z", max_risk_percent: "0.25000000" },
    );
    expect((await workspace(tables)).workspace.riskPlan?.id).toBe(R3);
  });

  it("reports what an account lacks and never judges a plan-less status", async () => {
    const { workspace: w } = await workspace({ account_observations: [], risk_plan_versions: [], strategy_versions: [], instrument_versions: [] });
    expect(w.gaps).toEqual(["ACCOUNT_VALUES", "RISK_PLAN", "STRATEGY", "INSTRUMENTS"]);
    expect(w.status).toBeNull();
    expect(riskContextFor(w, I1)).toBeNull();
  });

  it("rejects usage that is not the exact §6.7 contract", async () => {
    const db = new FakeDb(accountTables(A1), { get_daily_risk_usage: () => ({ data: { ...usage(), extra: 1 }, error: null }) });
    await expect(loadAccountWorkspace(asDb(db), USER, account(A1), NOW)).rejects.toThrow();
  });

  it("judges an approval current only while every component still matches (server time)", async () => {
    const { workspace: w } = await workspace();
    const context = riskContextFor(w, I1);
    if (!context) throw new Error("context expected");
    const report = evaluateRisk(PROPOSAL, context);
    expect(report.decision).toBe("APPROVED");
    expect(isCheckCurrent(w, report)).toBe(true);
    const changed = (await workspace(accountTables(A1), usage({ plannedSlots: 1, plannedRisk: "50", openExposure: "50" }))).workspace;
    expect(isCheckCurrent(changed, report)).toBe(false);
    const superseded = { ...w, instruments: [] };
    expect(isCheckCurrent(superseded, report)).toBe(true);
    const nextDay = { ...w, now: "2026-10-15T14:00:00.000Z" };
    expect(isCheckCurrent(nextDay, report)).toBe(false);
  });

  it("keeps the newest version of each symbol", () => {
    expect(latestInstrumentVersions(parseInstrumentRows(accountTables(A1).instrument_versions)).map(item => item.id)).toEqual([I1]);
  });

  // §6.1 C6/C7, §6.3: the preview must cover every rule the server check applies, DUPLICATE included.
  const plan = (n: number, accountId: string, day: string, proposal: Record<string, unknown>) => ({
    id: uuid("8", n), account_id: accountId, user_id: USER, trading_day: day, locked_at: `${day}T13:0${n}:00.000Z`, instrument_version_id: I1, proposal,
  });

  it("loads the account's plans of the usage day; a preview of an identical proposal is blocked as DUPLICATE", async () => {
    const tables = accountTables(A1);
    tables.trade_plans = [
      plan(1, A1, DAY, PROPOSAL),
      plan(2, A1, "2026-10-13", { ...PROPOSAL, entry: "1.09000" }),
      plan(3, A2, DAY, { ...PROPOSAL, entry: "1.08000" }),
    ];
    const { db, workspace: w } = await workspace(tables, usage({ plannedSlots: 1, plannedRisk: "50", openExposure: "50" }));
    expect(w.todaysPlans).toEqual([{ instrumentVersionId: I1, proposal: PROPOSAL }]);
    const read = db.calls.find(call => call.table === "trade_plans");
    expect(read?.filters).toEqual([`eq:account_id:${A1}`, `eq:user_id:${USER}`, `eq:trading_day:${DAY}`]);
    expect(read?.orders).toEqual(["locked_at:asc", "id:asc"]);

    const context = riskContextFor(w, I1, PROPOSAL);
    if (!context) throw new Error("context expected");
    expect(context.duplicate).toBe(true);
    const report = evaluateRisk(PROPOSAL, context);
    expect(report.decision).toBe("BLOCKED");
    expect(report.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code)).toEqual(["DUPLICATE"]);
    // The same prices written differently are the same plan; yesterday's plan and another account's plan are not today's.
    expect(riskContextFor(w, I1, { ...PROPOSAL, entry: "1.1", stop: "1.098", target: "1.106", riskPercent: "0.25" })?.duplicate).toBe(true);
    expect(riskContextFor(w, I1, { ...PROPOSAL, entry: "1.09000" })?.duplicate).toBe(false);
    expect(riskContextFor(w, I1, { ...PROPOSAL, entry: "1.08000" })?.duplicate).toBe(false);
    expect(riskContextFor(w, I1, { ...PROPOSAL, model: "OTE" })?.duplicate).toBe(false);
    // A context built only to judge whether a stored check is current never claims a duplicate.
    expect(riskContextFor(w, I1)?.duplicate).toBe(false);
  });

  it("reads the plans of the database's strategy day when the request straddles 00:00 UTC−5", async () => {
    const tables = accountTables(A1);
    tables.trade_plans = [plan(1, A1, "2026-10-15", PROPOSAL), plan(2, A1, DAY, { ...PROPOSAL, entry: "1.09000" })];
    const { db, workspace: w } = await workspace(tables, usage({ day: "2026-10-15" }));
    expect(w.todaysPlans).toEqual([{ instrumentVersionId: I1, proposal: PROPOSAL }]);
    const days = db.calls.filter(call => call.table === "trade_plans").map(call => call.filters.find(filter => filter.startsWith("eq:trading_day:")));
    expect(days).toEqual([`eq:trading_day:${DAY}`, "eq:trading_day:2026-10-15"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("journal filters and cursor (§14.5)", () => {
  it("round-trips URL state and names what it could not read", () => {
    const params = new URLSearchParams("from=2026-10-01&to=2026-10-14&result=win&state=live,closed&origin=live-first&model=ote&session=ACTIVE_KILL_ZONE&weekday=tuesday&direction=long&reviewed=no&ai=yes&tag=FOMO%20Trade&tag=a%2B&instrument=eurusd&risk=0.50&rFrom=-1&rTo=0.5&q=eur");
    const { filters, invalid } = parseTradeFilters(params);
    expect(filters).toEqual({
      from: "2026-10-01", to: "2026-10-14", result: "WIN", states: ["LIVE", "CLOSED"], origin: "LIVE_FIRST", model: "OTE", session: "ACTIVE_KILL_ZONE", weekday: "Tuesday",
      direction: "LONG", reviewed: false, aiReviewed: true, instrument: "EURUSD", riskPercent: "0.5", rFrom: "-1", rTo: "0.5", q: "eur",
    });
    expect(invalid).toEqual(["tag"]);
    const roundTrip = parseTradeFilters(tradeFilterParams(filters));
    expect(roundTrip.filters).toEqual(filters);
    expect(parseTradeFilters({ from: "2026-02-30", state: "open", strategy: "x" }).invalid).toEqual(["from", "state", "strategy"]);
    expect(journalHref({ model: "OTE" }, { account: A1 })).toBe(`/journal?model=OTE&account=${A1}`);
    expect(journalHref({})).toBe("/journal");
  });

  it("reads the read-only account filter as an id, writes it first, and keeps it only with All Accounts", () => {
    expect(parseTradeFilters({ accountFilter: A2.toUpperCase(), model: "OTE" })).toEqual({ filters: { accountFilter: A2, model: "OTE" }, invalid: [] });
    expect(parseTradeFilters({ accountFilter: "Personal 12K" })).toEqual({ filters: {}, invalid: ["accountFilter"] });
    expect(tradeFilterParams({ model: "OTE", accountFilter: A2 }).toString()).toBe(`accountFilter=${A2}&model=OTE`);
    expect(parseTradeFilters(tradeFilterParams({ accountFilter: A2, states: ["CLOSED"] })).filters).toEqual({ accountFilter: A2, states: ["CLOSED"] });
    expect(journalHref({ accountFilter: A2, model: "OTE" }, { account: "all" })).toBe(`/journal?accountFilter=${A2}&model=OTE&account=all`);
    expect(journalHref({ accountFilter: A2 })).toBe(`/journal?accountFilter=${A2}`);
    // A link that switches to one account leaves the filter out: it combines with All Accounts only.
    expect(journalHref({ accountFilter: A2, model: "OTE" }, { account: A1 })).toBe(`/journal?model=OTE&account=${A1}`);
  });

  it("reads V1 Journal bookmarks (bc5441c status and outcome) where the V2 names are absent, and names a V1 value it cannot read", () => {
    // V1 page and proposals (offset paging, the setup list) have no V2 meaning: not filters, never named.
    expect(parseTradeFilters({ status: "CLOSED", outcome: "WIN", page: "2", proposals: "1" })).toEqual({ filters: { states: ["CLOSED", "REVIEWED"], result: "WIN" }, invalid: [] });
    expect(["LOCKED", "TAKEN", "SKIPPED", "CANCELLED", "taken"].map(status => parseTradeFilters({ status }).filters.states)).toEqual([
      ["LOCKED"], ["LIVE"], ["SKIPPED"], ["CANCELLED"], ["LIVE"],
    ]);
    expect(["LOSS", "BREAKEVEN"].map(outcome => parseTradeFilters({ outcome }).filters.result)).toEqual(["LOSS", "BREAKEVEN"]);
    // The V2 names win when a link carries both; a value outside V1's vocabulary is named as the filter it would set.
    expect(parseTradeFilters({ state: "live", status: "CLOSED", result: "loss", outcome: "WIN" })).toEqual({ filters: { states: ["LIVE"], result: "LOSS" }, invalid: [] });
    expect(parseTradeFilters({ status: "OPEN", outcome: "OPEN" })).toEqual({ filters: {}, invalid: ["outcome", "status"] });
    // Links written back use the V2 names only.
    expect(tradeFilterParams(parseTradeFilters({ status: "CLOSED", outcome: "BREAKEVEN" }).filters).toString()).toBe("result=breakeven&state=closed%2Creviewed");
  });

  it("reads one currency's trades (EDGE's daily net P&L of a currency), writes it after the account filter, and reads only that currency", async () => {
    expect(parseTradeFilters({ currency: "eur", model: "OTE" })).toEqual({ filters: { currency: "EUR", model: "OTE" }, invalid: [] });
    expect(parseTradeFilters({ currency: "euro" })).toEqual({ filters: {}, invalid: ["currency"] });
    expect(tradeFilterParams({ model: "OTE", currency: "EUR", accountFilter: A2 }).toString()).toBe(`accountFilter=${A2}&currency=EUR&model=OTE`);
    const rows = [
      closed(tradeId(1), "2026-10-13T15:00:00.000Z", "1", "50"),
      closed(tradeId(2), "2026-10-13T16:00:00.000Z", "-1", "-30", { account_id: A2, currency: "EUR" }),
    ];
    const db = new FakeDb({ trade_ledger: rows.map(ledgerRow) });
    const loaded = await loadLedgerRows(asDb(db), USER, { mode: "all" }, { currency: "EUR" }, { closedOnly: true });
    expect(loaded.rows.map(row => row.id)).toEqual([tradeId(2)]);
    expect(db.ledgerCalls()[0].filters).toContain("eq:currency:EUR");
    const page = await loadLedgerPage(asDb(db), USER, { mode: "all" }, { currency: "USD" }, null);
    expect(page.rows.map(row => row.id)).toEqual([tradeId(1)]);
  });

  it("only accepts cursors it wrote", () => {
    const cursor = encodeTradeCursor({ t: "2026-10-14T09:00:00.123456+00:00", id: tradeId(1) });
    expect(decodeTradeCursor(cursor)).toEqual({ t: "2026-10-14T09:00:00.123456+00:00", id: tradeId(1) });
    expect(decodeTradeCursor("not-a-cursor")).toBeNull();
    expect(decodeTradeCursor(Buffer.from(JSON.stringify({ t: "yesterday", id: tradeId(1) })).toString("base64url"))).toBeNull();
    expect(decodeTradeCursor(Buffer.from(JSON.stringify({ t: NOW, id: tradeId(1), extra: true })).toString("base64url"))).toBeNull();
  });
});

describe("journal list (§14.5)", () => {
  // Trade dates: entry time if executed, else lock time, else creation time; deliberately interleaved across the three.
  const trades = [
    closed(tradeId(1), "2026-10-13T16:00:00.000Z", "2", "100", { entered_at: "2026-10-13T13:00:00.000Z", created_at: "2026-10-01T09:00:00.000Z" }),
    ledger(tradeId(2), { created_at: "2026-10-13T15:00:00.000Z" }),
    ledger(tradeId(3), { plan_id: uuid("8", 3), locked_at: "2026-10-12T15:00:00.000Z", lifecycle: "LOCKED", draft_check: null, created_at: "2026-10-12T14:00:00.000Z" }),
    closed(tradeId(4), "2026-10-12T18:00:00.000Z", "-1", "-50", { entered_at: "2026-10-12T16:30:00.000Z", account_id: A2, currency: "EUR", entry_model: "OTE", tags: ["fomo"] }),
    ledger(tradeId(5), { origin: "LIVE_FIRST", lifecycle: "LIVE", draft_check: null, created_at: "2026-10-12T16:00:00.000Z", entered_at: null, revision_count: 0, latest_revision: null, latest_proposal_id: null, planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null }),
    closed(tradeId(6), "2026-10-11T09:00:00.000Z", null, "-20", { entered_at: "2026-10-11T08:00:00.000Z", origin: "LIVE_FIRST", ai_review_count: 1 }),
    ledger(tradeId(7), { created_at: "2026-10-11T07:00:00.000Z", discarded_at: "2026-10-11T07:30:00.000Z", lifecycle: "DISCARDED", draft_check: null }),
  ];
  // T2 (created 13th 15:00) · T1 (entered 13th 13:00) · T4 (entered 12th 16:30) · T5 (recorded 12th 16:00) · T3 (locked 12th 15:00) · T6 · T7
  const expectedOrder = [2, 1, 4, 5, 3, 6, 7].map(tradeId);
  const db = () => new FakeDb({
    trade_ledger: trades.map(ledgerRow),
    trade_ai_activity: [{ trade_id: tradeId(6), account_id: A1, pre_trade_analysis_count: 0, trade_review_count: 1, timeline_review_count: 0, last_completed_at: "2026-10-11T10:00:00.000Z" }],
    trade_journal_entries: [{ trade_id: tradeId(5), account_id: A1, user_id: USER, body: "Moved stop after the FOMC candle", recorded_at: "2026-10-12T17:00:00.000Z" }],
    trade_events: [], trade_plan_links: [],
  });
  const deps = (fake: FakeDb) => ({ db: asDb(fake), userId: USER, scope: { mode: "all" as const }, accounts: [account(A1), account(A2, { currency: "EUR" })], now: NOW, display: { mode: "strategy" as const } });

  it("orders by trade date across entry, lock and creation times and pages without gaps or repeats", async () => {
    const fake = db();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await loadLedgerPage(asDb(fake), USER, { mode: "all" }, {}, cursor, 2);
      seen.push(...result.rows.map(row => row.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(expectedOrder);
    const one = await loadLedgerPage(asDb(db()), USER, { mode: "all" }, {}, null, 50);
    expect(one.rows.map(row => row.id)).toEqual(expectedOrder);
    expect(one.nextCursor).toBeNull();
  });

  it("keeps pages stable when newer trades arrive (keyset, not offsets)", async () => {
    const fake = db();
    const first = await loadLedgerPage(asDb(fake), USER, { mode: "all" }, {}, null, 3);
    fake.tables.trade_ledger.push(ledgerRow(ledger(tradeId(99), { created_at: "2026-10-14T13:59:00.000Z" })));
    const second = await loadLedgerPage(asDb(fake), USER, { mode: "all" }, {}, first.nextCursor, 3);
    expect([...first.rows, ...second.rows].map(row => row.id)).toEqual(expectedOrder.slice(0, 6));
  });

  it("parses every row strictly: a column added to or missing from the view fails loudly", async () => {
    const drift = db();
    drift.passthrough.add("trade_ledger");
    drift.tables.trade_ledger = [{ ...ledgerRow(trades[1]), surprise_column: 1 }];
    await expect(loadLedgerPage(asDb(drift), USER, { mode: "all" }, {}, null, 10)).rejects.toThrow();
    const missing = db();
    const { ai_review_count: _dropped, ...partial } = ledgerRow(trades[1]);
    missing.tables.trade_ledger = [partial];
    await expect(loadLedgerPage(asDb(missing), USER, { mode: "all" }, {}, null, 10)).rejects.toThrow();
    const select = db();
    await loadLedgerPage(asDb(select), USER, { mode: "all" }, {}, null, 10);
    expect(select.ledgerCalls()[0].select).toBe(LEDGER_COLUMNS.join(","));
  });

  const cases: [string, TradeFilters, number[]][] = [
    ["trade-date range (entry, lock or creation day)", { from: "2026-10-12", to: "2026-10-12" }, [4, 5, 3]],
    ["exit-day range", { closedFrom: "2026-10-12", closedTo: "2026-10-13" }, [1, 4]],
    ["result win", { result: "WIN" }, [1]],
    ["result open = live", { result: "OPEN" }, [5]],
    ["states", { states: ["LOCKED", "DISCARDED"] }, [3, 7]],
    ["origin", { origin: "LIVE_FIRST" }, [5, 6]],
    ["model", { model: "OTE" }, [4]],
    ["session of the entry (executed trades only)", { session: "ACTIVE_KILL_ZONE" }, [1, 4, 6]],
    ["session without matches", { session: "DEAD_POOL" }, []],
    ["weekday of the entry", { weekday: "Sunday" }, [6]],
    ["reviewed no = closed, review pending", { reviewed: false }, [1, 4, 6]],
    ["AI-reviewed", { aiReviewed: true }, [6]],
    ["tags", { tags: ["fomo"] }, [4]],
    ["instrument", { instrument: "EURUSD" }, [2, 1, 4, 5, 3, 6, 7]],
    ["R bin [−1, 0)", { rFrom: "-1", rTo: "0" }, [4]],
    ["search: journal text", { q: "fomc" }, [5]],
    ["search: tag", { q: "FOMO" }, [4]],
    ["search: nothing", { q: "%%%" }, []],
  ];
  it.each(cases)("filters by %s", async (_label, filters, expected) => {
    const result = await loadLedgerPage(asDb(db()), USER, { mode: "all" }, filters, null, 50);
    expect(result.rows.map(row => row.id)).toEqual(expected.map(tradeId));
  });

  it("treats a blank search as no search", async () => {
    const result = await loadLedgerPage(asDb(db()), USER, { mode: "all" }, { q: "   " }, null, 50);
    expect(result.rows.map(row => row.id)).toEqual(expectedOrder);
  });

  it("scopes to the selected account and adds labels, state, thumbnail and AI activity", async () => {
    const fake = db();
    fake.tables.trade_ledger[0] = { ...fake.tables.trade_ledger[0], cover_evidence_id: uuid("e", 1), cover_evidence_kind: "V2" };
    fake.tables.trade_ledger[5] = { ...fake.tables.trade_ledger[5], cover_evidence_id: uuid("e", 2), cover_evidence_kind: "LEGACY" };
    const page = await loadTradeList({ ...deps(fake), scope: { mode: "account", accountId: A1 } }, {}, null);
    expect(page.rows.map(row => row.id)).toEqual([2, 1, 5, 3, 6, 7].map(tradeId));
    expect(fake.ledgerCalls().every(call => call.filters.includes(`eq:account_id:${A1}`))).toBe(true);
    const byId = new Map(page.rows.map(row => [row.id, row]));
    const first = byId.get(tradeId(1));
    expect(first?.thumbnail).toEqual({ kind: "V2", src: `/api/evidence/${uuid("e", 1)}`, thumbSrc: `/api/evidence/${uuid("e", 1)}?variant=thumb` });
    expect(byId.get(tradeId(6))?.thumbnail?.thumbSrc).toBe(`/api/screenshots/${uuid("e", 2)}?variant=thumb`);
    expect(byId.get(tradeId(6))?.ai).toEqual({ reviews: 1, preTradeAnalyses: 0, lastCompletedAt: "2026-10-11T10:00:00.000Z" });
    expect(byId.get(tradeId(2))?.ai).toEqual({ reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null });
    expect(first?.state.label).toBe("Closed · review pending");
    expect(first?.tradeDateSource).toBe("ENTRY");
    expect(byId.get(tradeId(3))?.tradeDateSource).toBe("LOCK");
    expect(byId.get(tradeId(2))?.tradeDateSource).toBe("CREATED");
    expect(first?.account).toEqual({ id: A1, name: "Account 1", currency: "USD", status: "ACTIVE" });
    expect(page.groups.map(group => [group.day, group.rows.length])).toEqual([["2026-10-13", 2], ["2026-10-12", 2], ["2026-10-11", 2]]);
    expect(page.groups[0].label).toBe("Tue, Oct 13");
  });

  it("derives the state of an archived account's trades: drafts can only be discarded, open trades finish (§3.2, §9)", async () => {
    const page = await loadTradeList({ ...deps(db()), accounts: [account(A1, { status: "ARCHIVED" }), account(A2, { currency: "EUR" })] }, {}, null);
    const byId = new Map(page.rows.map(row => [row.id, row]));
    expect(byId.get(tradeId(2))?.account.status).toBe("ARCHIVED");
    expect(byId.get(tradeId(2))?.state).toMatchObject({ lifecycle: "DRAFT", draftCheck: "UNCHECKED", label: "Account archived", nextAction: null, canDuplicate: false });
    expect(byId.get(tradeId(2))?.state.secondaryActions.map(action => action.kind)).toEqual(["DISCARD"]);
    expect(byId.get(tradeId(3))?.state).toMatchObject({ lifecycle: "LOCKED", nextAction: { kind: "RECORD_ENTRY" }, canDuplicate: false });
    // A trade of an active account is unaffected.
    expect(byId.get(tradeId(4))?.state.canDuplicate).toBe(true);
  });

  it("narrows All Accounts to the read-only account filter in every read, and never broadens one", async () => {
    // One account of All Accounts: the page, the search behind it and the performance rows.
    expect((await loadLedgerPage(asDb(db()), USER, { mode: "all" }, { accountFilter: A2 }, null, 50)).rows.map(row => row.id)).toEqual([tradeId(4)]);
    const filtered = db();
    expect((await loadLedgerRows(asDb(filtered), USER, { mode: "all" }, { accountFilter: A2 })).rows.map(row => row.id)).toEqual([tradeId(4)]);
    expect(filtered.ledgerCalls().every(call => call.filters.includes(`eq:account_id:${A2}`))).toBe(true);
    const search = db();
    expect((await loadLedgerPage(asDb(search), USER, { mode: "all" }, { accountFilter: A1, q: "fomc" }, null, 50)).rows.map(row => row.id)).toEqual([tradeId(5)]);
    expect(search.calls.find(call => call.table === "trade_journal_entries")?.filters).toContain(`eq:account_id:${A1}`);
    expect((await loadLedgerPage(asDb(db()), USER, { mode: "all" }, { accountFilter: A2, q: "fomc" }, null, 50)).rows).toEqual([]);
    // An id that is not one of the user's accounts matches nothing (RLS bounds the read; the filter only narrows it).
    expect((await loadLedgerPage(asDb(db()), USER, { mode: "all" }, { accountFilter: A3 }, null, 50)).rows).toEqual([]);
    // An account context already names one account: the filter has no effect there.
    expect((await loadLedgerPage(asDb(db()), USER, { mode: "account", accountId: A1 }, { accountFilter: A2 }, null, 50)).rows.map(row => row.id))
      .toEqual([2, 1, 5, 3, 6, 7].map(tradeId));
    expect(filteredScope({ mode: "all" }, { accountFilter: A2 })).toEqual({ mode: "account", accountId: A2 });
    expect(filteredScope({ mode: "account", accountId: A1 }, { accountFilter: A2 })).toEqual({ mode: "account", accountId: A1 });
    expect(filteredScope({ mode: "all" }, {})).toEqual({ mode: "all" });
  });

  it("resolves the account filter against the user's accounts: names it in words, drops it in an account context", () => {
    const old = account(A3, { name: "Old challenge", status: "ARCHIVED" });
    const all = resolveAccountContext({ accounts: [account(A1), old], stored: "all", lastAccount: undefined, proxyNotice: false });
    const archived = resolveAccountFilter({ accountFilter: A3, model: "OTE" }, all);
    expect(archived).toEqual({ filters: { accountFilter: A3, model: "OTE" }, state: { kind: "account", account: old } });
    expect(accountFilterLabel(archived.state)).toBe("Account: Old challenge · archived");
    expect(accountFilterLabel(resolveAccountFilter({ accountFilter: A1 }, all).state)).toBe("Account: Account 1");
    // Not one of the user's accounts: still applied (it matches nothing) and shown as unavailable, never as an id.
    const foreign = resolveAccountFilter({ accountFilter: A2 }, all);
    expect(foreign).toEqual({ filters: { accountFilter: A2 }, state: { kind: "unavailable" } });
    expect(accountFilterLabel(foreign.state)).toBe("Account: not available");
    const one = resolveAccountContext({ accounts: [account(A1), old], stored: A1, lastAccount: undefined, proxyNotice: false });
    expect(resolveAccountFilter({ accountFilter: A3, model: "OTE" }, one)).toEqual({ filters: { model: "OTE" }, state: { kind: "none" } });
    expect(accountFilterLabel({ kind: "none" })).toBeNull();
  });

  // Every trade the list holds, counted the way the list reads them: the count equals the rows of all pages.
  async function everyPage(filters: TradeFilters, scope: { mode: "all" } | { mode: "account"; accountId: string } = { mode: "all" }): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result = await loadLedgerPage(asDb(db()), USER, scope, filters, cursor, 2);
      ids.push(...result.rows.map(row => row.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return ids;
  }
  it.each([...cases, ["no filter", {}, expectedOrder.map(id => Number(id.slice(-4)))] as [string, TradeFilters, number[]],
    ["account filter", { accountFilter: A2 }, [4]] as [string, TradeFilters, number[]], ["date range and account filter", { from: "2026-10-12", to: "2026-10-13", accountFilter: A1 }, [2, 1, 5, 3]] as [string, TradeFilters, number[]]])(
    "counts exactly the trades the list pages through: %s", async (_label, filters, expected) => {
      const counts = await countLedgerTrades(asDb(db()), USER, { mode: "all" }, filters);
      expect(counts?.total).toBe(expected.length);
      expect(await everyPage(filters)).toHaveLength(expected.length);
    },
  );

  it("counts in the database where it can and reads light rows only for session, weekday and R bounds", async () => {
    const plain = db();
    expect(await countLedgerTrades(asDb(plain), USER, { mode: "all" }, { model: "OB_FIRST_TOUCH" })).toEqual({ total: 6, days: new Map() });
    expect(plain.ledgerCalls()).toEqual([expect.objectContaining({ select: "id", count: "exact", head: true })]);
    // A trade-date range filters each stream's own column: one count per stream, still without rows.
    const dated = db();
    expect((await countLedgerTrades(asDb(dated), USER, { mode: "all" }, { from: "2026-10-12", to: "2026-10-12" }))?.total).toBe(3);
    expect(dated.ledgerCalls()).toHaveLength(3);
    expect(dated.ledgerCalls().every(call => call.head && call.count === "exact")).toBe(true);
    const checked = db();
    expect((await countLedgerTrades(asDb(checked), USER, { mode: "all" }, { session: "ACTIVE_KILL_ZONE" }))?.total).toBe(3);
    expect(checked.ledgerCalls().map(call => call.select)).toEqual(["id,entered_at,realized_r"]);
    // A search that can match nothing needs no count at all.
    const nothing = db();
    expect(await countLedgerTrades(asDb(nothing), USER, { mode: "all" }, { q: "%%%" })).toEqual({ total: 0, days: new Map() });
    expect(nothing.ledgerCalls().filter(call => call.count !== null)).toEqual([]);
    // The scope narrows the count like the list: an account context, or the account filter of All Accounts.
    expect((await countLedgerTrades(asDb(db()), USER, { mode: "account", accountId: A2 }, {}))?.total).toBe(1);
    expect((await countLedgerTrades(asDb(db()), USER, { mode: "all" }, { accountFilter: A3 }))?.total).toBe(0);
  });

  it("counts each trade date a page shares with another page, within the list's own filters", async () => {
    const counts = await countLedgerTrades(asDb(db()), USER, { mode: "all" }, {}, ["2026-10-13", "2026-10-12", "2026-10-12"]);
    expect(counts).toEqual({ total: 7, days: new Map([["2026-10-12", 3], ["2026-10-13", 2]]) });
    const sessions = await countLedgerTrades(asDb(db()), USER, { mode: "all" }, { session: "ACTIVE_KILL_ZONE" }, ["2026-10-12", "2026-10-11"]);
    expect(sessions).toEqual({ total: 3, days: new Map([["2026-10-11", 1], ["2026-10-12", 1]]) });
    // A day outside the filters' own range holds none of the list's trades.
    expect((await countLedgerTrades(asDb(db()), USER, { mode: "all" }, { from: "2026-10-13" }, ["2026-10-12"]))?.days.get("2026-10-12")).toBe(0);
  });

  it("states no count rather than an estimate when a row check would read more than its bound", async () => {
    const many = Array.from({ length: MAX_COUNT_SCAN + 1 }, (_, index) =>
      ledgerRow(closed(uuid("c", index + 1), "2026-10-13T16:00:00.000Z", "1", "10", { entered_at: "2026-10-13T13:00:00.000Z" })));
    const huge = new FakeDb({ trade_ledger: many, trade_journal_entries: [], trade_events: [], trade_plan_links: [] });
    expect(await countLedgerTrades(asDb(huge), USER, { mode: "all" }, { session: "ACTIVE_KILL_ZONE" })).toBeNull();
    // Counted by the database, the same rows have an exact total.
    expect((await countLedgerTrades(asDb(huge), USER, { mode: "all" }, {}))?.total).toBe(MAX_COUNT_SCAN + 1);
  });

  it("builds the palette index with pre-formatted labels", async () => {
    const result = await loadPaletteTrades(deps(db()));
    expect(result.liveTrades.map(trade => trade.id)).toEqual([tradeId(5)]);
    expect(result.recentTrades[0]).toMatchObject({ id: tradeId(2), symbol: "EURUSD", direction: "LONG", accountName: "Account 1", stateLabel: "Draft", dateLabel: "Oct 13" });
    expect(result.recentTrades.find(trade => trade.id === tradeId(1))?.resultLabel).toBe("+2.00R");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("trade detail (§5.4, §7.5, §8.5, §14.4)", () => {
  const TRADE = tradeId(10);
  const PLAN = uuid("8", 10);
  const PROP1 = uuid("7", 1);
  const PROP2 = uuid("7", 2);
  const EVAL1 = uuid("9", 1);
  const EVAL2 = uuid("9", 2);
  const EV_PRE = uuid("e", 11);
  const EV_LIVE = uuid("e", 12);
  const EV_REMOVED = uuid("e", 13);
  const LEGACY = uuid("e", 14);
  const SHA = "ab".repeat(32);

  function plannedTables(): Record<string, Row[]> {
    const base = accountTables(A1);
    const report = { ...evaluateRisk(PROPOSAL, { now: "2026-10-12T13:00:00.000Z", strategyVersionId: S1, strategyVersion: "ICT V1.0", observationId: O1, observationDay: "2026-10-12", equity: "10000", currency: "USD", plan: { id: R1, version: "Risk Plan V1.0", maxRiskPercent: "0.5", defaultRiskPercent: null, maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null }, instrument: { id: I1, symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" }, usage: usage({ day: "2026-10-12" }), duplicate: false }) };
    const blocked = { ...evaluateRisk({ ...PROPOSAL, riskPercent: "0.504" }, { now: "2026-10-12T12:00:00.000Z", strategyVersionId: S1, strategyVersion: "ICT V1.0", observationId: O1, observationDay: "2026-10-12", equity: "10000", currency: "USD", plan: { id: R1, version: "Risk Plan V1.0", maxRiskPercent: "0.5", defaultRiskPercent: null, maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null }, instrument: { id: I1, symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" }, usage: usage({ day: "2026-10-12" }), duplicate: false }) };
    expect(blocked.decision).toBe("BLOCKED");
    return {
      ...base,
      trades: [{ id: TRADE, user_id: USER, account_id: A1 }],
      trade_ledger: [ledgerRow(closed(TRADE, "2026-10-12T17:00:00.000Z", "2.5", "125", {
        plan_id: PLAN, locked_at: "2026-10-12T13:05:00.000Z", entered_at: "2026-10-12T14:00:00.000Z", entry_recorded_at: "2026-10-12T14:20:00.000Z",
        created_at: "2026-10-12T11:00:00.000Z", revision_count: 2, latest_revision: 2, latest_proposal_id: PROP2, latest_check_decision: "APPROVED",
        latest_check_at: "2026-10-12T13:00:00.000Z", latest_check_evaluation_id: EVAL2, strategy_version_id: S1, strategy_version: "ICT V1.0",
        risk_plan_version_id: R1, risk_plan_version: "Risk Plan V1.0", quantity: "0.5", oversize: true, actual_initial_risk: "100", setup_grade: "A", tags: ["fomo"], tag_source: "V2",
      }))],
      trade_revisions: [
        { proposal_id: PROP1, trade_id: TRADE, user_id: USER, revision: 1, created_at: "2026-10-12T11:00:00.000Z" },
        { proposal_id: PROP2, trade_id: TRADE, user_id: USER, revision: 2, created_at: "2026-10-12T12:30:00.000Z" },
      ],
      setup_proposals: [
        { id: PROP1, user_id: USER, proposal: { ...PROPOSAL, riskPercent: "0.504" }, created_at: "2026-10-12T11:00:00.000Z", instrument_version_id: I1 },
        { id: PROP2, user_id: USER, proposal: PROPOSAL, created_at: "2026-10-12T12:30:00.000Z", instrument_version_id: I1 },
      ],
      setup_risk_checks: [
        { id: 1, user_id: USER, proposal_id: PROP1, risk: { id: EVAL1, result: blocked, recorded_at: "2026-10-12T12:00:00.000Z", risk_plan_version_id: R1, instrument_version_id: I1, strategy_version_id: S1 } },
        { id: 2, user_id: USER, proposal_id: PROP2, risk: { id: EVAL2, result: report, recorded_at: "2026-10-12T13:00:00.000Z", risk_plan_version_id: R1, instrument_version_id: I1, strategy_version_id: S1 } },
      ],
      trade_plans: [{ id: PLAN, user_id: USER, proposal: PROPOSAL, risk_result: report, nominal_risk: "50.0000", locked_at: "2026-10-12T13:05:00.000Z", trading_day: "2026-10-12", account_observation_id: O1, risk_plan_version_id: R1, strategy_version_id: S1, instrument_version_id: I1, risk_evaluation_id: EVAL2 }],
      trade_events: [
        { id: uuid("b", 1), plan_id: PLAN, user_id: USER, sequence: 1, event_type: "PLAN_LOCKED", payload: {}, occurred_at: "2026-10-12T13:05:00.000Z", recorded_at: "2026-10-12T13:05:00.000Z" },
        { id: uuid("b", 2), plan_id: PLAN, user_id: USER, sequence: 2, event_type: "NOTE_ADDED", payload: { note: "Waiting for London open" }, occurred_at: "2026-10-12T13:30:00.000Z", recorded_at: "2026-10-12T13:30:00.000Z" },
      ],
      trade_dispositions: [],
      trade_journal_entries: [
        { id: uuid("c", 1), trade_id: TRADE, user_id: USER, kind: "STOP_CHANGE", body: null, details: { price: "1.1" }, phase: "LIVE", state_at_creation: "LIVE", source: "USER", recorded_at: "2026-10-12T15:00:00.000Z" },
        { id: uuid("c", 2), trade_id: TRADE, user_id: USER, kind: "LESSON", body: "Waited for confirmation.", details: {}, phase: "POST_TRADE", state_at_creation: "CLOSED", source: "USER", recorded_at: "2026-10-12T18:00:00.000Z" },
      ],
      trade_evidence: [
        { id: EV_PRE, trade_id: TRADE, user_id: USER, storage_path: `${USER}/${TRADE}/${EV_PRE}`, label: "HTF", timeframe: "H4", caption: null, original_filename: "h4.png", mime_type: "image/png", byte_size: 100, sha256: SHA, width: 800, height: 600, phase: "PRE_ENTRY", state_at_creation: "DRAFT", capture_method: "DUPLICATE", copied_from: LEGACY, recorded_at: "2026-10-12T11:30:00.000Z" },
        { id: EV_LIVE, trade_id: TRADE, user_id: USER, storage_path: `${USER}/${TRADE}/${EV_LIVE}`, label: "MANAGEMENT", timeframe: null, caption: "Partial", original_filename: "m5.png", mime_type: "image/png", byte_size: 100, sha256: SHA, width: 800, height: 600, phase: "LIVE", state_at_creation: "LIVE", capture_method: "PASTE", copied_from: null, recorded_at: "2026-10-12T15:30:00.000Z" },
        { id: EV_REMOVED, trade_id: TRADE, user_id: USER, storage_path: `${USER}/${TRADE}/${EV_REMOVED}`, label: "OTHER", timeframe: null, caption: null, original_filename: "x.png", mime_type: "image/png", byte_size: 100, sha256: SHA, width: 800, height: 600, phase: "PRE_ENTRY", state_at_creation: "DRAFT", capture_method: "FILE", copied_from: null, recorded_at: "2026-10-12T11:40:00.000Z" },
      ],
      trade_evidence_labels: [{ id: 1, evidence_id: EV_LIVE, trade_id: TRADE, user_id: USER, label: "EXIT", timeframe: "M5", caption: "Exit chart", recorded_at: "2026-10-12T16:00:00.000Z" }],
      trade_evidence_removals: [{ evidence_id: EV_REMOVED, trade_id: TRADE, user_id: USER, recorded_at: "2026-10-12T12:00:00.000Z" }],
      setup_screenshots: [{ id: LEGACY, proposal_id: PROP1, user_id: USER, role: "M15", storage_path: `${USER}/${PROP1}/${LEGACY}`, original_filename: "m15.png", mime_type: "image/png", byte_size: 100, sha256: SHA, width: 640, height: 480, uploaded_at: "2026-10-12T11:10:00.000Z" }],
      setup_screenshot_removals: [],
      trade_tag_sets: [{ id: 1, trade_id: TRADE, user_id: USER, setup_grade: "A", liquidity_context: "PDH", mss_timeframe: "M5", tags: ["fomo"], recorded_at: "2026-10-12T18:10:00.000Z" }],
      trade_tag_revisions: [{ id: 1, plan_id: PLAN, user_id: USER, setup_grade: "B", liquidity_context: null, mss_timeframe: null, recorded_at: "2026-10-12T13:40:00.000Z" }],
      trade_lifecycle_events: [],
      trade_ai_activity: [{ trade_id: TRADE, account_id: A1, pre_trade_analysis_count: 1, trade_review_count: 0, timeline_review_count: 1, last_completed_at: "2026-10-12T19:00:00.000Z" }],
      risk_evaluations: [],
    };
  }

  const detailDeps = (db: FakeDb) => ({
    db: asDb(db), userId: USER, accounts: [account(A1, { name: "FTMO 100K" })], now: NOW, display: { mode: "strategy" as const },
    aiAvailable: async () => true, aiHistory: async () => null,
  });

  it("returns null for a trade the user does not own (pages call notFound)", async () => {
    const db = new FakeDb({ ...plannedTables(), trades: [] });
    expect(await loadTradeDetail(detailDeps(db), TRADE)).toBeNull();
    expect(await loadTradeDetail(detailDeps(db), "not-a-uuid")).toBeNull();
  });

  it("carries the minimum RR each check compared the planned RR with: its report's limits, else its own risk plan version (§6.6)", async () => {
    const tables = plannedTables();
    // The risk plan version's minimum is 2.995R; a V1-migrated report (engine 1.0) states no limits of its own.
    tables.risk_plan_versions = tables.risk_plan_versions.map(row => ({ ...row, min_rr: "2.99500000" }));
    const toLegacy = (report: Row) => ({
      engineVersion: "1.0", evaluatedAt: report.evaluatedAt, tradingDay: report.tradingDay, session: report.session, strategyVersionId: report.strategyVersionId,
      riskPlanVersionId: report.riskPlanVersionId, status: report.status, calculations: report.calculations,
      issues: (report.issues as Row[]).map(({ code, severity, message }) => ({ code, severity, message })),
    });
    const [blockedRow, approvedRow] = tables.setup_risk_checks;
    const blockedRisk = blockedRow.risk as Row;
    tables.setup_risk_checks = [{ ...blockedRow, risk: { ...blockedRisk, result: toLegacy(blockedRisk.result as Row) } }, approvedRow];
    tables.trade_plans = tables.trade_plans.map(row => ({ ...row, risk_result: toLegacy(row.risk_result as Row) }));
    const detail = await loadTradeDetail(detailDeps(new FakeDb(tables)), TRADE);
    if (!detail) throw new Error("detail expected");
    // Report 1.2 states the minimum it applied (3R); the older reports read their risk plan version's (2.995R).
    expect(detail.checks.map(check => [check.revision, check.minRR])).toEqual([[1, "2.995"], [2, "3"]]);
    expect(detail.plan?.check?.minRR).toBe("2.995");
  });

  it("assembles every timeline source, the plan view and plan vs reality", async () => {
    const db = new FakeDb(plannedTables());
    const detail = await loadTradeDetail(detailDeps(db), TRADE);
    if (!detail) throw new Error("detail expected");
    expect(detail.title).toBe("EURUSD · Long");
    expect(detail.account).toEqual({ id: A1, name: "FTMO 100K", currency: "USD", status: "ACTIVE" });
    expect(detail.state).toMatchObject({ lifecycle: "CLOSED", label: "Closed · review pending" });
    const kinds = detail.timeline.map(item => item.kind);
    for (const kind of ["DRAFT_REVISION", "RISK_CHECK", "PLAN_LOCKED", "NOTE", "ENTRY", "SIZE_DEVIATION", "JOURNAL", "EVIDENCE_ADDED", "EVIDENCE_REMOVED", "TAGS", "CLOSE"]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(detail.timeline.filter(item => item.kind === "PLAN_LOCKED")).toHaveLength(1);
    const blockedCheck = detail.timeline.find(item => item.kind === "RISK_CHECK" && item.title === "Risk check: Blocked");
    expect(blockedCheck?.body).toBe("Requested risk 0.504% exceeds your configured maximum of 0.50%.");
    expect(detail.timeline.find(item => item.kind === "ENTRY")?.timeLabel).toBe("09:00 · recorded 09:20");
    expect(detail.timelineGroups.map(group => group.label)).toEqual(["Before entry", "While live", "After close"]);
    expect(detail.timelineGroups[2].items.some(item => item.title === "Lesson")).toBe(true);
    expect(detail.plan).toMatchObject({ lockedAt: "2026-10-12T13:05:00.000Z", riskPlanVersion: "Risk Plan V1.0", strategyVersion: "ICT V1.0", nominalRisk: "50" });
    expect(detail.plan?.check?.decision).toBe("APPROVED");
    expect(detail.checks.map(check => [check.revision, check.decision])).toEqual([[1, "BLOCKED"], [2, "APPROVED"]]);
    expect(detail.planVsReality.kind).toBe("PLANNED");
    expect(detail.close?.basisLabel).toBe("R based on locked risk");
    expect(detail.tags).toEqual({ grade: "A", liquidity: null, mss: null, tags: ["fomo"], source: "V2" });
    expect(detail.ai.activity).toEqual({ reviews: 1, preTradeAnalyses: 1, lastCompletedAt: "2026-10-12T19:00:00.000Z" });
  });

  it("builds the gallery by timing band: removed items leave the gallery, legacy items are not relabelable", async () => {
    const detail = await loadTradeDetail(detailDeps(new FakeDb(plannedTables())), TRADE);
    if (!detail) throw new Error("detail expected");
    const byId = new Map(detail.evidence.items.map(item => [item.id, item]));
    expect(byId.get(EV_PRE)).toMatchObject({ timing: "BEFORE_ENTRY", name: "H4 chart", copied: true, copiedFromRecordedAt: "2026-10-12T11:10:00.000Z", relabelable: true });
    expect(byId.get(EV_LIVE)).toMatchObject({ timing: "WHILE_LIVE", label: "EXIT", timeframe: "M5", caption: "Exit chart", thumbSrc: `/api/evidence/${EV_LIVE}?variant=thumb` });
    expect(byId.get(LEGACY)).toMatchObject({ kind: "LEGACY", timing: "BEFORE_ENTRY", label: "OTHER", timeframe: "M15", relabelable: false, removable: true, src: `/api/screenshots/${LEGACY}` });
    expect(byId.get(EV_REMOVED)).toMatchObject({ removedAt: "2026-10-12T12:00:00.000Z", removable: false });
    expect(detail.evidence.activeCount).toBe(3);
    expect(detail.evidence.groups.map(group => group.items.map(item => item.id))).toEqual([[LEGACY, EV_PRE], [EV_LIVE], []]);
    expect(detail.evidenceIndex[EV_LIVE]).toEqual({ label: "EXIT", timeframe: "M5" });
  });

  it("keeps ids, hashes, storage paths and raw reports inside `technical` only", async () => {
    const detail = await loadTradeDetail(detailDeps(new FakeDb(plannedTables())), TRADE);
    if (!detail) throw new Error("detail expected");
    const { technical, timeline, timelineGroups, ...visible } = detail;
    const text = JSON.stringify(visible);
    for (const secret of [PLAN, EVAL1, EVAL2, R1, S1, O1, SHA, `${USER}/${TRADE}`]) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(/"(planId|proposalId|evaluationId|storagePath|sha256)"/);
    expect(technical).toMatchObject({ planId: PLAN, latestCheckEvaluationId: EVAL2, riskPlanVersionId: R1, strategyVersionId: S1 });
    expect(technical.evidence.find(item => item.id === EV_PRE)).toMatchObject({ sha256: SHA, captureMethod: "DUPLICATE", copiedFrom: LEGACY });
    expect(technical.checks.map(check => check.evaluationId)).toEqual([EVAL1, EVAL2]);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timelineGroups).toHaveLength(3);
  });

  it("shows a live-first trade without fabricated plan values", async () => {
    const LIVE = tradeId(30);
    const db = new FakeDb({
      ...accountTables(A1),
      trades: [{ id: LIVE, user_id: USER, account_id: A1 }],
      trade_ledger: [ledgerRow(closed(LIVE, "2026-10-14T13:00:00.000Z", "-0.5", "-25", {
        origin: "LIVE_FIRST", plan_id: null, locked_at: null, revision_count: 0, latest_revision: null, latest_proposal_id: null, created_at: "2026-10-14T12:10:00.000Z",
        entered_at: "2026-10-14T12:00:00.000Z", entry_recorded_at: "2026-10-14T12:10:00.000Z", planned_entry: null, planned_stop: null, planned_target: null,
        requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null, pnl_source: "USER_REPORTED", calculation_version: "UNPLANNED_CLOSE_V1",
      }))],
      trade_position_facts: [
        { id: uuid("d", 1), trade_id: LIVE, user_id: USER, recorded_at: "2026-10-14T12:10:00.000Z", source: "USER", instrument_version_id: I1, symbol: "EURUSD", direction: "LONG", entry_model: null, entry_price: "1.1", entered_at: "2026-10-14T12:00:00.000Z", quantity: null, initial_stop: null, risk_amount: null },
        { id: uuid("d", 2), trade_id: LIVE, user_id: USER, recorded_at: "2026-10-14T12:20:00.000Z", source: "USER", instrument_version_id: null, symbol: null, direction: null, entry_model: null, entry_price: null, entered_at: null, quantity: "0.5", initial_stop: null, risk_amount: "50.00" },
      ],
      trade_unplanned_closes: [{ trade_id: LIVE, user_id: USER, risk_basis: "50", risk_basis_source: "USER_REPORTED" }],
      trade_ai_activity: [],
    });
    const detail = await loadTradeDetail(detailDeps(db), LIVE);
    expect(detail?.state).toMatchObject({ origin: "LIVE_FIRST", banner: "No pre-trade plan was recorded before execution.", step: null });
    expect(detail?.planVsReality).toMatchObject({ kind: "NO_PLAN", message: "No pre-trade plan recorded" });
    expect(detail?.plan).toBeNull();
    expect(detail?.draft).toBeNull();
    expect(detail?.positionFacts).toEqual([
      { recordedAt: "2026-10-14T12:10:00.000Z", source: "USER", facts: ["Instrument EURUSD", "Long", "Entry 1.1", "Entry time"] },
      { recordedAt: "2026-10-14T12:20:00.000Z", source: "USER", facts: ["Size 0.5", "Risk 50"] },
    ]);
    expect(detail?.close).toMatchObject({ basisLabel: "R based on risk recorded after entry", riskBasisSource: "USER_REPORTED", pnlSource: "USER_REPORTED" });
    expect(detail?.timeline.some(item => item.timing === "BEFORE_ENTRY")).toBe(false);
  });

  it("dates the end of a skipped plan and classifies what was recorded after it as After close (§5.3)", async () => {
    const SKIPPED = tradeId(40);
    const PLAN_S = uuid("8", 40);
    const PROP_S = uuid("7", 40);
    const EVAL_SAVE = uuid("9", 41);
    const EVAL_LOCK = uuid("9", 42);
    const [NOTE_BEFORE, NOTE_AFTER, NOTE_STALE] = [uuid("c", 41), uuid("c", 42), uuid("c", 43)];
    const [EV_AFTER, EV_STALE, SHOT_AFTER] = [uuid("e", 41), uuid("e", 42), uuid("e", 43)];
    const evidence = (id: string, phase: string, recordedAt: string) => ({
      id, trade_id: SKIPPED, user_id: USER, storage_path: `${USER}/${SKIPPED}/${id}`, label: "OTHER", timeframe: "M15", caption: null, original_filename: "late.png",
      mime_type: "image/png", byte_size: 100, sha256: SHA, width: 800, height: 600, phase, state_at_creation: "SKIPPED", capture_method: "PASTE", copied_from: null, recorded_at: recordedAt,
    });
    const tables = {
      ...accountTables(A1),
      trades: [{ id: SKIPPED, user_id: USER, account_id: A1 }],
      trade_ledger: [ledgerRow(ledger(SKIPPED, {
        lifecycle: "SKIPPED", draft_check: null, plan_id: PLAN_S, locked_at: "2026-10-13T13:05:00.008000Z", plan_trading_day: "2026-10-13", latest_proposal_id: PROP_S,
        latest_check_decision: "APPROVED", latest_check_at: "2026-10-13T13:05:00.025000Z", latest_check_evaluation_id: EVAL_LOCK, created_at: "2026-10-13T13:00:00.010000Z",
        disposition: "SKIPPED", disposition_reason: "No retest",
      }))],
      // The save wrote its check ~10 ms before the revision row; the lock stamped locked_at ~17 ms before its evaluation row.
      trade_revisions: [{ proposal_id: PROP_S, trade_id: SKIPPED, user_id: USER, revision: 1, created_at: "2026-10-13T13:00:00.010000Z" }],
      setup_proposals: [{ id: PROP_S, user_id: USER, proposal: PROPOSAL, created_at: "2026-10-13T13:00:00.005000Z", instrument_version_id: I1 }],
      setup_risk_checks: [
        { id: 1, user_id: USER, proposal_id: PROP_S, risk: { id: EVAL_SAVE, result: { decision: "APPROVED" }, recorded_at: "2026-10-13T13:00:00.000000Z", risk_plan_version_id: R1, instrument_version_id: I1, strategy_version_id: S1 } },
        { id: 2, user_id: USER, proposal_id: PROP_S, risk: { id: EVAL_LOCK, result: { decision: "APPROVED" }, recorded_at: "2026-10-13T13:05:00.025000Z", risk_plan_version_id: R1, instrument_version_id: I1, strategy_version_id: S1 } },
      ],
      trade_plans: [{ id: PLAN_S, user_id: USER, proposal: PROPOSAL, risk_result: { decision: "APPROVED" }, nominal_risk: "50", locked_at: "2026-10-13T13:05:00.008000Z", trading_day: "2026-10-13", account_observation_id: O1, risk_plan_version_id: R1, strategy_version_id: S1, instrument_version_id: I1, risk_evaluation_id: EVAL_LOCK }],
      trade_events: [],
      trade_dispositions: [{ plan_id: PLAN_S, user_id: USER, status: "SKIPPED", reason: "No retest", recorded_at: "2026-10-13T14:00:00.000000Z" }],
      trade_journal_entries: [
        { id: NOTE_BEFORE, trade_id: SKIPPED, user_id: USER, kind: "NOTE", body: "Waiting for the retest.", details: {}, phase: "PRE_ENTRY", state_at_creation: "LOCKED", source: "USER", recorded_at: "2026-10-13T13:30:00.000000Z" },
        { id: NOTE_AFTER, trade_id: SKIPPED, user_id: USER, kind: "LESSON", body: "The skip cost a winner.", details: {}, phase: "POST_TRADE", state_at_creation: "SKIPPED", source: "USER", recorded_at: "2026-10-13T15:00:00.000000Z" },
        { id: NOTE_STALE, trade_id: SKIPPED, user_id: USER, kind: "NOTE", body: "Where price went.", details: {}, phase: "PRE_ENTRY", state_at_creation: "SKIPPED", source: "USER", recorded_at: "2026-10-13T15:10:00.000000Z" },
      ],
      trade_evidence: [evidence(EV_AFTER, "POST_TRADE", "2026-10-13T15:01:00.000000Z"), evidence(EV_STALE, "PRE_ENTRY", "2026-10-13T15:02:00.000000Z")],
      trade_evidence_labels: [], trade_evidence_removals: [],
      setup_screenshots: [{ id: SHOT_AFTER, proposal_id: PROP_S, user_id: USER, role: "M15", storage_path: `${USER}/${PROP_S}/${SHOT_AFTER}`, original_filename: "m15.png", mime_type: "image/png", byte_size: 100, sha256: SHA, width: 640, height: 480, uploaded_at: "2026-10-13T15:03:00.000000Z" }],
      setup_screenshot_removals: [], trade_tag_sets: [], trade_tag_revisions: [], trade_lifecycle_events: [], trade_ai_activity: [], risk_evaluations: [], setup_human_decisions: [],
    };
    const db = new FakeDb(tables);
    const detail = await loadTradeDetail(detailDeps(db), SKIPPED);
    if (!detail) throw new Error("detail expected");
    expect(detail.planEndedAt).toBe("2026-10-13T14:00:00.000000Z");
    // No V1 decision to date: the ledger names none, so none is read.
    expect(db.calls.some(call => call.table === "setup_human_decisions")).toBe(false);
    const timing = (id: string) => {
      const item = detail.timeline.find(entry => entry.id === id);
      return item ? [item.timing, item.flags] : null;
    };
    expect(timing(`journal:${NOTE_BEFORE}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`disposition:${SKIPPED}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`journal:${NOTE_AFTER}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(`journal:${NOTE_STALE}`)).toEqual(["AFTER_CLOSE", ["RECORDED_AFTER_PLAN_ENDED"]]);
    expect(timing(`evidence-added:${SHOT_AFTER}`)).toEqual(["AFTER_CLOSE", []]);
    const items = new Map(detail.evidence.items.map(item => [item.id, item]));
    expect(items.get(EV_AFTER)).toMatchObject({ timing: "AFTER_CLOSE", timingLabel: "After close", flags: [] });
    expect(items.get(EV_STALE)).toMatchObject({ timing: "AFTER_CLOSE", flags: ["Recorded after the plan ended"] });
    expect(items.get(SHOT_AFTER)).toMatchObject({ timing: "AFTER_CLOSE", flags: [] });
    expect(detail.evidence.groups.map(group => group.items.length)).toEqual([0, 0, 3]);
    // The decision history reads causally: the revision, its check, the lock's evaluation, the lock.
    expect(detail.timeline.slice(0, 4).map(item => item.id)).toEqual([`revision:${PROP_S}`, `check:${EVAL_SAVE}`, `check:${EVAL_LOCK}`, `plan:${PLAN_S}`]);
    expect(db.calls.find(call => call.table === "trade_plans")?.select).toContain("risk_evaluation_id");
  });

  it("dates a skip recorded in V1 by its decision (the latest decision of the trade's revisions)", async () => {
    const V1 = tradeId(41);
    const PROP_V1 = uuid("7", 41);
    const db = new FakeDb({
      ...accountTables(A1),
      trades: [{ id: V1, user_id: USER, account_id: A1 }],
      trade_ledger: [ledgerRow(ledger(V1, { lifecycle: "SKIPPED", draft_check: null, legacy_decision: "SKIPPED", latest_proposal_id: PROP_V1, migrated_from: "V1_PROPOSAL" }))],
      trade_revisions: [{ proposal_id: PROP_V1, trade_id: V1, user_id: USER, revision: 1, created_at: "2026-10-10T10:00:00.000Z" }],
      setup_proposals: [{ id: PROP_V1, user_id: USER, proposal: PROPOSAL, created_at: "2026-10-10T10:00:00.000Z", instrument_version_id: I1 }],
      setup_human_decisions: [
        {
          id: uuid("f", 1), proposal_id: PROP_V1, user_id: USER, decision: "TAKEN", event_type: "MANUAL_OVERRIDE", reason: "Took it anyway: news was priced in.",
          risk_decision: "BLOCKED", ai_decision: "NOT_EVALUATED", recorded_at: "2026-10-10T10:30:00.000Z",
        },
        {
          id: uuid("f", 2), proposal_id: PROP_V1, user_id: USER, decision: "SKIPPED", event_type: "HUMAN_DECISION", reason: "Spread widened to 3 pips at the London open.",
          risk_decision: "BLOCKED", ai_decision: "NOT_EVALUATED", recorded_at: "2026-10-10T11:00:00.000Z",
        },
      ],
      trade_journal_entries: [
        { id: uuid("c", 51), trade_id: V1, user_id: USER, kind: "NOTE", body: "Later.", details: {}, phase: "POST_TRADE", state_at_creation: "SKIPPED", source: "USER", recorded_at: "2026-10-11T09:00:00.000Z" },
      ],
      trade_ai_activity: [],
    });
    const detail = await loadTradeDetail(detailDeps(db), V1);
    expect(detail?.planEndedAt).toBe("2026-10-10T11:00:00.000Z");
    // Every V1 decision of the trade's revisions, newest first (the ledger's order), with the trader's reason.
    expect(db.calls.find(call => call.table === "setup_human_decisions")).toMatchObject({
      select: "id,decision,event_type,reason,risk_decision,ai_decision,recorded_at", filters: [`eq:user_id:${USER}`, `in:proposal_id:${PROP_V1}`],
      orders: ["recorded_at:desc", "id:desc"], limit: 1000,
    });
    expect(detail?.timeline.filter(item => item.kind === "LEGACY_DECISION").map(item => [item.title, item.body, item.timing])).toEqual([
      ["Taken despite a block", "Took it anyway: news was priced in.", "BEFORE_ENTRY"],
      ["Decision: Skipped", "Spread widened to 3 pips at the London open.", "BEFORE_ENTRY"],
    ]);
    expect(detail?.timeline.find(item => item.kind === "JOURNAL")).toMatchObject({ timing: "AFTER_CLOSE", flags: [] });
  });

  it("marks an approved draft ready to lock only while the check is current at server time", async () => {
    const tables = accountTables(A1);
    const workspaceDb = new FakeDb(tables, { get_daily_risk_usage: () => ({ data: usage(), error: null }) });
    const w = await loadAccountWorkspace(asDb(workspaceDb), USER, account(A1), NOW);
    const report = evaluateRisk(PROPOSAL, riskContextFor(w, I1) as NonNullable<ReturnType<typeof riskContextFor>>);
    const DRAFT = tradeId(20);
    const draftTables = (dailyUsage: DailyUsage) => new FakeDb({
      ...tables,
      trades: [{ id: DRAFT, user_id: USER, account_id: A1 }],
      trade_ledger: [ledgerRow(ledger(DRAFT, { latest_proposal_id: PROP1, latest_check_decision: "APPROVED", latest_check_at: "2026-10-14T13:59:00.000Z", latest_check_evaluation_id: EVAL1, created_at: "2026-10-14T13:00:00.000Z", draft_check: "APPROVED" }))],
      trade_revisions: [{ proposal_id: PROP1, trade_id: DRAFT, user_id: USER, revision: 1, created_at: "2026-10-14T13:00:00.000Z" }],
      setup_proposals: [{ id: PROP1, user_id: USER, proposal: PROPOSAL, created_at: "2026-10-14T13:00:00.000Z", instrument_version_id: I1 }],
      setup_risk_checks: [{ id: 1, user_id: USER, proposal_id: PROP1, risk: { id: EVAL1, result: report, recorded_at: "2026-10-14T13:59:00.000Z", risk_plan_version_id: R1, instrument_version_id: I1, strategy_version_id: S1 } }],
      risk_evaluations: [{ id: EVAL1, user_id: USER, result: report }],
      trade_ai_activity: [],
    }, { get_daily_risk_usage: () => ({ data: dailyUsage, error: null }) });
    const ready = await loadTradeDetail(detailDeps(draftTables(usage())), DRAFT);
    expect(ready?.state).toMatchObject({ lifecycle: "DRAFT", label: "Ready to lock", nextAction: { kind: "LOCK_PLAN" } });
    expect(ready?.draft).toMatchObject({ revision: 1, expectedRevision: 1, checkCurrent: true, proposal: { entry: "1.10000", narrative: PROPOSAL.narrative, instrumentVersionId: I1 } });
    const stale = await loadTradeDetail(detailDeps(draftTables(usage({ plannedSlots: 1, plannedRisk: "50", openExposure: "50" }))), DRAFT);
    expect(stale?.state).toMatchObject({ label: "Recheck needed", nextAction: { kind: "RECHECK_RISK" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("Today (§14.1)", () => {
  async function today(selected: "all" | "account", extraNotes: Row[] = []) {
    const tables = accountTables(A1);
    const workspaceDb = new FakeDb(tables, { get_daily_risk_usage: () => ({ data: usage({ realizedLoss: "50", lossTotal: "55", externalLoss: "5" }), error: null }) });
    const w1 = await loadAccountWorkspace(asDb(workspaceDb), USER, account(A1), NOW);
    const w2 = { ...w1, account: account(A2, { currency: "EUR" }), usage: usage({ realizedLoss: "10", lossTotal: "10" }) };
    const trades = [
      ledger(tradeId(1), { lifecycle: "LIVE", draft_check: null, plan_id: uuid("8", 1), locked_at: "2026-10-14T12:00:00.000Z", entered_at: "2026-10-14T12:30:00.000Z", entry_recorded_at: "2026-10-14T12:31:00.000Z", entry_price: "1.1", quantity: "0.25" }),
      ledger(tradeId(2), { origin: "LIVE_FIRST", lifecycle: "LIVE", draft_check: null, created_at: "2026-10-14T13:00:00.000Z", account_id: A2, currency: "EUR" }),
      ledger(tradeId(3), { latest_check_decision: "BLOCKED", latest_check_at: "2026-10-14T11:00:00.000Z", draft_check: "BLOCKED" }),
      ledger(tradeId(4), { latest_check_decision: "APPROVED", latest_check_at: "2026-10-13T11:00:00.000Z", draft_check: "APPROVED" }),
      ledger(tradeId(5)),
      ledger(tradeId(6), { lifecycle: "LOCKED", draft_check: null, plan_id: uuid("8", 6), locked_at: "2026-10-14T10:00:00.000Z" }),
      closed(tradeId(7), "2026-10-14T13:00:00.000Z", "1.5", "75"),
      closed(tradeId(8), "2026-10-14T13:30:00.000Z", "-1", "-40", { account_id: A2, currency: "EUR" }),
      closed(tradeId(9), "2026-10-13T13:30:00.000Z", "3", "150"),
    ];
    const db = new FakeDb({
      trade_ledger: trades.map(ledgerRow),
      trade_ai_activity: [],
      trade_journal_entries: [
        { trade_id: tradeId(1), user_id: USER, kind: "NOTE", body: "First", details: {}, recorded_at: "2026-10-14T12:40:00.000Z", id: uuid("c", 1) },
        { trade_id: tradeId(1), user_id: USER, kind: "STOP_CHANGE", body: null, details: { price: "1.1" }, recorded_at: "2026-10-14T13:10:00.000Z", id: uuid("c", 2) },
      ],
      trade_events: [
        { id: uuid("b", 1), plan_id: uuid("8", 1), user_id: USER, event_type: "NOTE_ADDED", payload: { note: "Tags", source: "MANUAL" }, recorded_at: "2026-10-14T13:50:00.000Z" },
        { id: uuid("b", 2), plan_id: uuid("8", 1), user_id: USER, event_type: "NOTE_ADDED", payload: { note: "Older V1 note" }, recorded_at: "2026-10-14T12:35:00.000Z" },
        ...extraNotes,
      ],
      daily_contexts: [{ account_id: A1, user_id: USER, trading_day: DAY, narrative: "Bias long above PDL", recorded_at: "2026-10-14T11:00:00.000Z", id: uuid("d", 1) }],
      risk_evaluations: [],
    });
    const context = resolveAccountContext({ accounts: [account(A1), account(A2, { currency: "EUR" })], stored: selected === "all" ? "all" : A1, lastAccount: undefined, proxyNotice: false });
    return loadToday({ db: asDb(db), userId: USER, context, workspaces: selected === "all" ? [w1, w2] : [w1], now: NOW });
  }

  it("groups live trades, plans waiting and today's closed trades", async () => {
    const data = await today("all");
    expect(data).toMatchObject({ day: DAY, dayLabel: "Wed, Oct 14 (UTC−5)", session: "ACTIVE_KILL_ZONE", boundary: { session: "DEAD_POOL", time: "12:00" } });
    expect(data.live.map(card => card.row.id)).toEqual([tradeId(2), tradeId(1)]);
    expect(data.live.find(card => card.row.id === tradeId(1))?.lastJournal).toMatchObject({ kind: "STOP_CHANGE", source: "JOURNAL", recordedAt: "2026-10-14T13:10:00.000Z" });
    expect(data.plans.blocked.map(row => row.id)).toEqual([tradeId(3)]);
    expect(data.plans.recheck.map(row => row.id)).toEqual([tradeId(4)]);
    expect(data.plans.unchecked.map(row => row.id)).toEqual([tradeId(5)]);
    expect(data.plans.locked.map(row => row.id)).toEqual([tradeId(6)]);
    expect(data.closedToday.map(row => row.id)).toEqual([tradeId(8), tradeId(7)]);
    expect(data.result).toMatchObject({ closed: 2, netR: "0.5", label: "+0.50R · -€40.00 · +$75.00" });
    expect(data.losses).toEqual([
      { currency: "EUR", realized: "10", external: "0", legacyReported: null, total: "10" },
      { currency: "USD", realized: "50", external: "5", legacyReported: null, total: "55" },
    ]);
    expect(data.accounts).toHaveLength(2);
    expect(data.dailyContext).toBeNull();
    expect(data.truncated).toEqual({ live: false, locked: false, drafts: false, closed: false });
    expect(data.empty).toBe(false);
  });

  it("shows the selected account's daily context and a V1 note when it is the newest journal item", async () => {
    const data = await today("account", [{ id: uuid("b", 3), plan_id: uuid("8", 1), user_id: USER, event_type: "NOTE_ADDED", payload: { note: "Trailing behind H1 swing" }, recorded_at: "2026-10-14T13:20:00.000Z" }]);
    expect(data.dailyContext).toEqual({ narrative: "Bias long above PDL", recordedAt: "2026-10-14T11:00:00.000Z" });
    expect(data.accounts).toHaveLength(1);
    expect(data.live.find(card => card.row.id === tradeId(1))?.lastJournal).toEqual({
      kind: "NOTE", body: "Trailing behind H1 swing", details: {}, recordedAt: "2026-10-14T13:20:00.000Z", source: "V1_NOTE",
    });
  });

  /** Today of one account (or All Accounts over A1 and A2) over the given ledger rows and tables. */
  async function todayOf(trades: readonly LedgerTrade[], extra: Record<string, Row[]> = {}, usages: DailyUsage[] = [usage()]) {
    const workspaceDb = new FakeDb(accountTables(A1), { get_daily_risk_usage: () => ({ data: usages[0], error: null }) });
    const w1 = await loadAccountWorkspace(asDb(workspaceDb), USER, account(A1), NOW);
    const workspaces = usages.map((dailyUsage, index) => (index === 0 ? w1 : { ...w1, account: account(A2), usage: dailyUsage }));
    const db = new FakeDb({
      trade_ledger: trades.map(ledgerRow), trade_ai_activity: [], trade_journal_entries: [], trade_events: [], daily_contexts: [], risk_evaluations: [], ...extra,
    });
    const accounts = usages.length === 1 ? [account(A1)] : [account(A1), account(A2)];
    const context = resolveAccountContext({ accounts, stored: usages.length === 1 ? A1 : "all", lastAccount: undefined, proxyNotice: false });
    return { db, data: await loadToday({ db: asDb(db), userId: USER, context, workspaces, now: NOW }) };
  }
  const at = (base: string, seconds: number) => new Date(Date.parse(base) + seconds * 1000).toISOString();

  it("never lets newer drafts push a live trade or a locked plan off Today, and says which list was cut", async () => {
    const LIVE = tradeId(1);
    const LOCKED = tradeId(2);
    const trades = [
      // A swing position opened weeks ago and a plan locked last week, then 205 newer drafts (V1 proposals carried over).
      ledger(LIVE, { origin: "LIVE_FIRST", lifecycle: "LIVE", draft_check: null, created_at: "2026-09-01T10:00:00.000Z", entered_at: "2026-09-01T09:30:00.000Z" }),
      ledger(LOCKED, { lifecycle: "LOCKED", draft_check: null, plan_id: uuid("8", 2), locked_at: "2026-10-07T12:00:00.000Z", created_at: "2026-10-07T11:00:00.000Z" }),
      ...Array.from({ length: TODAY_WAITING_LIMIT + 5 }, (_, index) => ledger(tradeId(100 + index), { created_at: at("2026-10-13T00:00:00.000Z", index * 60) })),
    ];
    const { db, data } = await todayOf(trades);
    expect(data.live.map(card => card.row.id)).toEqual([LIVE]);
    expect(data.live[0].liveSince).toBe("2026-09-01T09:30:00.000Z");
    expect(data.plans.locked.map(row => row.id)).toEqual([LOCKED]);
    // The newest drafts are listed; the five oldest are left to the Journal.
    expect(data.plans.unchecked).toHaveLength(TODAY_WAITING_LIMIT);
    expect(data.plans.unchecked[0].id).toBe(tradeId(100 + TODAY_WAITING_LIMIT + 4));
    expect(data.plans.unchecked.map(row => row.id)).not.toContain(tradeId(104));
    expect(data.truncated).toEqual({ live: false, locked: false, drafts: true, closed: false });
    expect(data.empty).toBe(false);
    // One bounded query per list; none of them mixes lifecycles.
    const lists = db.ledgerCalls().filter(call => call.filters.some(filter => filter.startsWith("eq:lifecycle:")));
    expect(lists.map(call => [call.filters.find(filter => filter.startsWith("eq:lifecycle:")), call.limit])).toEqual([
      ["eq:lifecycle:LIVE", TODAY_LIVE_LIMIT + 1], ["eq:lifecycle:LOCKED", TODAY_WAITING_LIMIT + 1], ["eq:lifecycle:DRAFT", TODAY_WAITING_LIMIT + 1],
    ]);
    expect(lists.every(call => call.filters.includes(`eq:account_id:${A1}`))).toBe(true);
    // AI activity of the 202 listed trades is read 100 ids at a time.
    const activity = db.calls.filter(call => call.table === "trade_ai_activity").map(call => (call.filters[0] ?? "").split("|").length);
    expect(activity).toEqual([100, 100, 2]);
  });

  it("lists every live trade up to its own bound and flags the rest", async () => {
    const trades = Array.from({ length: TODAY_LIVE_LIMIT + 1 }, (_, index) =>
      ledger(tradeId(index + 1), { origin: "LIVE_FIRST", lifecycle: "LIVE", draft_check: null, created_at: at("2026-08-01T00:00:00.000Z", index * 3600) }));
    const { data } = await todayOf(trades);
    expect(data.live).toHaveLength(TODAY_LIVE_LIMIT);
    expect(data.live[0].row.id).toBe(tradeId(TODAY_LIVE_LIMIT + 1));
    expect(data.truncated.live).toBe(true);
  });

  it("finds each live trade's newest journal item exactly, beyond a full page and 100 trades per request", async () => {
    const live = Array.from({ length: 150 }, (_, index) =>
      ledger(tradeId(index + 1), { origin: "LIVE_FIRST", lifecycle: "LIVE", draft_check: null, created_at: at("2026-10-14T10:00:00.000Z", -index * 60) }));
    // Trade 1 has 600 entries, all newer than trade 2's only entry (same request batch); trade 120 is in the second batch.
    const entries = [
      ...Array.from({ length: 600 }, (_, index) => ({
        id: uuid("c", index + 1), trade_id: tradeId(1), user_id: USER, kind: "NOTE", body: `Note ${index + 1}`, details: {}, recorded_at: at("2026-10-14T13:00:00.000Z", index),
      })),
      { id: uuid("c", 900), trade_id: tradeId(2), user_id: USER, kind: "DECISION", body: "Hold through London", details: {}, recorded_at: "2026-10-14T11:00:00.000Z" },
      { id: uuid("c", 901), trade_id: tradeId(120), user_id: USER, kind: "STOP_CHANGE", body: null, details: { price: "1.1" }, recorded_at: "2026-10-14T12:00:00.000Z" },
    ];
    const { db, data } = await todayOf(live, { trade_journal_entries: entries });
    const last = new Map(data.live.map(card => [card.row.id, card.lastJournal]));
    expect(last.get(tradeId(1))).toMatchObject({ body: "Note 600", source: "JOURNAL" });
    expect(last.get(tradeId(2))).toMatchObject({ kind: "DECISION", body: "Hold through London" });
    expect(last.get(tradeId(120))).toMatchObject({ kind: "STOP_CHANGE", details: { price: "1.1" } });
    expect(last.get(tradeId(3))).toBeNull();
    const reads = db.calls.filter(call => call.table === "trade_journal_entries");
    expect(reads.map(call => (call.filters.find(filter => filter.startsWith("in:trade_id:")) ?? "").split("|").length)).toEqual([100, 50, 99]);
    // The third read continues after the last row of the full first page, for the trades still without an item.
    expect(reads[2].filters.some(filter => filter.startsWith("or:recorded_at.lt."))).toBe(true);
  });

  it("lists every trade closed today and computes today's result from all of them", async () => {
    const trades = Array.from({ length: 230 }, (_, index) => closed(tradeId(index + 1), at("2026-10-14T05:00:00.000Z", index * 60), "1", "10"));
    const { data } = await todayOf([...trades, closed(tradeId(999), "2026-10-14T04:59:59.000Z", "5", "50")]);
    expect(data.closedToday).toHaveLength(230);
    expect(data.closedToday[0].id).toBe(tradeId(230));
    expect(data.result).toMatchObject({ closed: 230, netR: "230" });
    expect(data.truncated.closed).toBe(false);
  });

  it("shows today's losses as the daily loss limit counts them, including a V1 reported total on the switch day", async () => {
    const switchDay = usage({ realizedLoss: "50", externalLoss: "5", legacyReportedLoss: "300", lossTotal: "300" });
    const { data } = await todayOf([], {}, [switchDay, usage({ realizedLoss: "20", lossTotal: "20" })]);
    expect(data.accounts.map(status => status.losses)).toEqual([
      { currency: "USD", realized: "50", external: "5", legacyReported: "300", total: "300" },
      { currency: "USD", realized: "20", external: "0", legacyReported: null, total: "20" },
    ]);
    // The same figure the trading status card and the engine's DAILY_LOSS_LIMIT use.
    expect(data.accounts[0].workspace.status?.stats?.losses.total).toBe("300");
    expect(data.losses).toEqual([{ currency: "USD", realized: "70", external: "5", legacyReported: "300", total: "320" }]);
    expect(data.empty).toBe(true);
  });

  it("judges more than 100 drafts approved today, reading their checks 100 at a time", async () => {
    const workspaceDb = new FakeDb(accountTables(A1), { get_daily_risk_usage: () => ({ data: usage(), error: null }) });
    const context = riskContextFor(await loadAccountWorkspace(asDb(workspaceDb), USER, account(A1), NOW), I1, PROPOSAL);
    if (!context) throw new Error("context expected");
    const report = evaluateRisk(PROPOSAL, context);
    expect(report.decision).toBe("APPROVED");
    const drafts = Array.from({ length: 101 }, (_, index) => ledger(tradeId(index + 1), {
      created_at: at("2026-10-14T12:00:00.000Z", index), latest_check_decision: "APPROVED", latest_check_at: "2026-10-14T13:59:00.000Z",
      latest_check_evaluation_id: uuid("9", index + 1), draft_check: "APPROVED",
    }));
    const { db, data } = await todayOf(drafts, {
      risk_evaluations: drafts.map((_, index) => ({ id: uuid("9", index + 1), user_id: USER, result: report })),
      instrument_versions: accountTables(A1).instrument_versions,
    });
    expect(data.plans.ready).toHaveLength(101);
    const reads = db.calls.filter(call => call.table === "risk_evaluations").map(call => (call.filters.find(filter => filter.startsWith("in:id:")) ?? "").split("|").length);
    expect(reads).toEqual([100, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("accounts (§9.4, §14.7–14.9)", () => {
  it("labels risk-plan versions with the active-plan precedence (C9)", () => {
    const plan = (id: string, effectiveDay: string, createdAt: string) => ({
      id, version: id, effectiveDay, createdAt, maxRiskPercent: "0.5", defaultRiskPercent: null, maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK" as const,
      newsPolicy: "WARN" as const, dailyRiskCap: null, dailyLossCap: null, overrideReason: null,
    });
    const timeline = riskPlanTimeline([
      plan("V1.0", "2026-10-01", "2026-10-01T10:00:00.000Z"),
      plan("V1.1 loosening", "2026-10-15", "2026-10-14T09:00:00.000Z"),
      plan("V1.2 tightening", "2026-10-14", "2026-10-14T10:00:00.000Z"),
      plan("V1.3 later", "2026-10-20", "2026-10-14T11:00:00.000Z"),
    ], DAY);
    expect(timeline.map(item => [item.version, item.status, item.statusLabel])).toEqual([
      ["V1.3 later", "SCHEDULED", "Starts Oct 20"],
      ["V1.2 tightening", "ACTIVE", "Active"],
      ["V1.1 loosening", "NEVER_EFFECTIVE", "Replaced before it started"],
      ["V1.0", "SUPERSEDED", "Replaced"],
    ]);
    expect(riskPlanTimeline([plan("Next", "2026-10-15", "2026-10-14T09:00:00.000Z"), plan("Now", "2026-10-01", "2026-10-01T09:00:00.000Z")], DAY)[0].statusLabel).toBe("Starts tomorrow");
  });

  it("builds the balance-from-trades line only from a known starting balance, in exit order", () => {
    const trades = [closed(tradeId(2), "2026-10-13T10:00:00.000Z", "-1", "-50"), closed(tradeId(1), "2026-10-12T10:00:00.000Z", "2", "100.25")];
    expect(balanceCurve("10000", trades)?.map(point => point.balance)).toEqual(["10000", "10100.25", "10050.25"]);
    expect(balanceCurve(null, trades)).toBeNull();
  });

  it("warns when the risk plan accepts a lower RR than the strategy documents", () => {
    expect(minimumRrWarning("2.5", "3")).toBe("Your risk plan's minimum RR of 2.50R is below the strategy's documented 3.00R.");
    expect(minimumRrWarning("3", "3")).toBeNull();
  });

  it("summarises every account with metrics, connection state and per-currency totals of active accounts", async () => {
    const db = new FakeDb({
      ...accountTables(A1),
      account_observations: [
        { id: O1, account_id: A1, user_id: USER, balance: "10200.00", equity: "10150.00", gross_loss_today: null, trading_day: DAY, recorded_at: "2026-10-14T12:00:00.000Z" },
        { id: uuid("6", 3), account_id: A2, user_id: USER, balance: "5000.00", equity: "5000.00", gross_loss_today: null, trading_day: "2026-10-01", recorded_at: "2026-10-01T12:00:00.000Z" },
      ],
      trade_ledger: [closed(tradeId(1), "2026-10-14T10:00:00.000Z", "2", "100"), closed(tradeId(2), "2026-10-13T10:00:00.000Z", "-1", "-25", { account_id: A2, currency: "EUR" })].map(ledgerRow),
      platform_connection_overview: [],
    });
    const context = resolveAccountContext({ accounts: [account(A1), account(A2, { currency: "EUR", profile: "DEFAULT", startingBalance: null }), account(A3, { status: "ARCHIVED" })], stored: "all", lastAccount: undefined, proxyNotice: false });
    const overview = await loadAccountsOverview(asDb(db), USER, context, NOW);
    expect(overview.active.map(summary => summary.account.id)).toEqual([A1, A2]);
    expect(overview.archived.map(summary => summary.account.id)).toEqual([A3]);
    expect(overview.active[0].metrics).toMatchObject({ realizedPnl: "100", todayPnl: "100", balanceFromTrades: { value: "10100" }, lastBalance: { value: { amount: "10200" } } });
    expect(overview.active[1].metrics.startingBalance).toEqual({ value: "5000", unknownReason: null });
    expect(overview.active[0].connection.mode).toBe("MANUAL");
    expect(overview.totals).toEqual([
      { currency: "EUR", accounts: 1, realizedPnl: "-25", todayPnl: "0", monthPnl: "-25" },
      { currency: "USD", accounts: 1, realizedPnl: "100", todayPnl: "100", monthPnl: "100" },
    ]);
  });

  it("loads the manage page: values, today's external losses with removals, versions and instruments", async () => {
    const tables = accountTables(A1);
    const db = new FakeDb({
      ...tables,
      account_profiles: [{ id: 2, account_id: A1, user_id: USER, display_name: "FTMO", broker: "FTMO", platform: "MT5", account_type: "EVALUATION", starting_balance: "100000.00", status: "ACTIVE", source: "USER", recorded_at: "2026-10-02T10:00:00.000Z" }],
      external_loss_entries: [
        { id: uuid("f", 1), account_id: A1, user_id: USER, trading_day: DAY, amount: "12.50", note: "cTrader scalp", recorded_at: "2026-10-14T13:00:00.000Z" },
        { id: uuid("f", 2), account_id: A1, user_id: USER, trading_day: DAY, amount: "5.00", note: null, recorded_at: "2026-10-14T12:00:00.000Z" },
        { id: uuid("f", 3), account_id: A1, user_id: USER, trading_day: "2026-10-13", amount: "7.00", note: null, recorded_at: "2026-10-13T12:00:00.000Z" },
      ],
      external_loss_removals: [{ entry_id: uuid("f", 2), user_id: USER, reason: "Typed twice", recorded_at: "2026-10-14T12:05:00.000Z" }],
      platform_connection_overview: [],
    });
    const manage = await loadAccountManage(asDb(db), USER, account(A1, { startingBalance: "100000" }), NOW);
    expect(manage.values).toMatchObject({ confirmedToday: true, latest: { id: O1 } });
    expect(manage.externalLosses.today.map(loss => [loss.amount, loss.removedAt !== null])).toEqual([["12.5", false], ["5", true]]);
    expect(manage.externalLosses.todayTotal).toBe("12.5");
    expect(manage.instruments.map(item => [item.id, item.current])).toEqual([[I1, true], [I1_OLD, false]]);
    expect(manage.activeRiskPlan?.id).toBe(R1);
    expect(manage.strategy).toEqual({ version: "ICT V1.0", minimumRR: "3", warning: null });
    expect(manage.profileHistory[0]).toMatchObject({ name: "FTMO", platform: "MT5", startingBalance: "100000" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("performance (§9.3, §13.6, §14.6)", () => {
  it("keyset-loads every row in id order, beyond one page", async () => {
    const rows = Array.from({ length: 1203 }, (_, index) => ledgerRow(closed(tradeId(index + 1), "2026-10-13T10:00:00.000Z", "1", "10")));
    const db = new FakeDb({ trade_ledger: rows });
    const loaded = await loadLedgerRows(asDb(db), USER, { mode: "all" }, {}, { closedOnly: true });
    expect(loaded.rows).toHaveLength(1203);
    expect(loaded.truncated).toBe(false);
    const calls = db.ledgerCalls();
    expect(calls).toHaveLength(3);
    expect(calls[1].filters).toContain(`gt:id:${tradeId(500)}`);
    expect(calls.every(call => call.filters.includes("not:exited_at:is:null") && call.orders[0] === "id:asc")).toBe(true);
  });

  it("reads a scope of exactly the read limit in full, and calls it truncated only when one more row matches", async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ledgerRow(closed(tradeId(index + 1), "2026-10-13T10:00:00.000Z", "1", "10")));
    // 1,000 rows at a limit of 1,000: two full pages, then a one-row probe that finds nothing.
    const exact = new FakeDb({ trade_ledger: rows(1000) });
    const complete = await loadLedgerRows(asDb(exact), USER, { mode: "all" }, {}, { closedOnly: true, maxRows: 1000 });
    expect(complete).toMatchObject({ truncated: false });
    expect(complete.rows).toHaveLength(1000);
    const probe = exact.ledgerCalls()[2];
    expect(probe).toMatchObject({ limit: 1 });
    expect(probe.filters).toEqual(expect.arrayContaining([`gt:id:${tradeId(1000)}`, "not:exited_at:is:null"]));
    // One more row: the first 1,000 are read and the result says it is incomplete.
    const more = await loadLedgerRows(asDb(new FakeDb({ trade_ledger: rows(1001) })), USER, { mode: "all" }, {}, { closedOnly: true, maxRows: 1000 });
    expect(more).toMatchObject({ truncated: true });
    expect(more.rows).toHaveLength(1000);
  });

  it("builds drill-down links that list exactly the trades of a mark", async () => {
    const base: TradeFilters = { closedFrom: "2026-10-01", closedTo: "2026-10-31", origin: "PLANNED" };
    expect(breakdownHref({ key: "model", value: "OTE" }, { base })).toBe("/journal?closedFrom=2026-10-01&closedTo=2026-10-31&state=closed,reviewed&origin=planned&model=OTE".replace(",", "%2C"));
    expect(breakdownHref({ key: "model", value: null }, { base })).toBeNull();
    expect(breakdownHref({ key: "account", value: A2 }, { base })).toContain(`account=${A2}`);
    expect(closedOnHref("2026-10-14", { base: {}, account: A1 })).toBe(`/journal?closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed&account=${A1}`);
    expect(distributionBinHref({ from: "-1", to: "-0.5" }, { base: {} })).toBe("/journal?state=closed%2Creviewed&rFrom=-1&rTo=-0.5");
    const parsed = parseTradeFilters(new URL(`http://x${breakdownHref({ key: "weekday", value: "Tuesday" }, { base }) as string}`).searchParams).filters;
    expect(parsed).toMatchObject({ weekday: "Tuesday", states: ["CLOSED", "REVIEWED"], origin: "PLANNED" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("opens an archived account's history in All Accounts with the account filter, never as a switch to it", () => {
    expect(accountHistoryJournalHref(A3)).toBe(`/journal?accountFilter=${A3}&account=all`);
    expect(closedOnHref("2026-10-14", accountHistoryDrill(A3)))
      .toBe(`/journal?accountFilter=${A3}&closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed&account=all`);
    expect(breakdownHref({ key: "session", value: "ASIA" }, accountHistoryDrill(A3))).toBe(`/journal?accountFilter=${A3}&state=closed%2Creviewed&session=ASIA&account=all`);
    expect(accountJournalHref({ id: A3, status: "ARCHIVED" }, { closedFrom: "2026-10-01" }))
      .toBe(`/journal?accountFilter=${A3}&closedFrom=2026-10-01&state=closed%2Creviewed&account=all`);
    expect(accountJournalHref({ id: A1, status: "ACTIVE" }, {})).toBe(`/journal?state=closed%2Creviewed&account=${A1}`);
    const trades = [
      closed(tradeId(1), "2026-10-13T10:00:00.000Z", "2", "100"),
      closed(tradeId(2), "2026-10-14T10:00:00.000Z", "-1", "-20", { account_id: A3 }),
    ];
    const all = resolveAccountContext({ accounts: [account(A1), account(A3, { status: "ARCHIVED" })], stored: "all", lastAccount: undefined, proxyNotice: false });
    const contribution = buildPerformance(all, { rows: trades, truncated: false }, {}, NOW).contribution ?? [];
    expect(contribution.find(entry => entry.accountId === A1)?.href).toBe(`/journal?state=closed%2Creviewed&account=${A1}`);
    expect(contribution.find(entry => entry.accountId === A3)?.href).toBe(`/journal?accountFilter=${A3}&state=closed%2Creviewed&account=all`);
    // EDGE filtered to the archived account: every drill-down keeps the filter.
    const filtered = buildPerformance(all, { rows: [trades[1]], truncated: false }, { accountFilter: A3 }, NOW, { month: "2026-10" });
    expect(filtered.calendar.days.find(day => day.day === "2026-10-14")?.href).toBe(`/journal?accountFilter=${A3}&closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed`);
    expect(filtered.daily.map(point => point.href)).toEqual([`/journal?accountFilter=${A3}&closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed`]);
    // One account of All Accounts: like an account context, nothing to compare in an account contribution.
    expect(filtered.contribution).toBeNull();
    // An account context ignores a filter left in the URL by a context switch: its read did (`filteredScope`), and its
    // view and drill-down links drop it, so it never travels on into the Journal.
    const one = resolveAccountContext({ accounts: [account(A1), account(A3, { status: "ARCHIVED" })], stored: A1, lastAccount: undefined, proxyNotice: false });
    const stale = buildPerformance(one, { rows: [trades[0]], truncated: false }, { accountFilter: A3, model: "OB_FIRST_TOUCH" }, NOW, { month: "2026-10" });
    expect(stale.filters).toEqual({ model: "OB_FIRST_TOUCH" });
    const bins: readonly { href: string }[] = stale.distribution.bins;
    const links = [
      ...stale.daily.map(point => point.href), ...bins.map(bin => bin.href),
      ...stale.calendar.days.flatMap(day => (day.href ? [day.href] : [])), ...Object.values(stale.breakdowns).flat().flatMap(group => (group?.href ? [group.href] : [])),
    ];
    expect(links.length).toBeGreaterThan(3);
    expect(links.filter(href => href.includes("accountFilter"))).toEqual([]);
    expect(stale.daily.map(point => point.href)).toEqual(["/journal?closedFrom=2026-10-13&closedTo=2026-10-13&state=closed%2Creviewed&model=OB_FIRST_TOUCH"]);
  });

  it("drills a day into all its trades and each currency's net P&L of the day into exactly the trades it sums (§9.3)", async () => {
    // Sep 2: a EUR trade and a USD trade; Oct 8: a EUR trade without a recorded risk and a USD trade; Oct 14: USD only.
    const eur = { account_id: A2, currency: "EUR" } as const;
    const trades = [
      closed(tradeId(1), "2026-09-02T15:00:00.000Z", "-1.03", "-62.4", { ...eur, entered_at: "2026-09-02T13:00:00.000Z" }),
      closed(tradeId(2), "2026-09-02T16:00:00.000Z", "1.29", "645", { entered_at: "2026-09-02T13:30:00.000Z" }),
      closed(tradeId(3), "2026-10-08T15:00:00.000Z", null, "-50.26", { ...eur, entered_at: "2026-10-08T13:00:00.000Z", origin: "LIVE_FIRST" }),
      closed(tradeId(4), "2026-10-08T16:00:00.000Z", "4.17", "2089.25", { entered_at: "2026-10-08T13:30:00.000Z" }),
      closed(tradeId(5), "2026-10-14T16:00:00.000Z", "-1", "-500", { entered_at: "2026-10-14T13:30:00.000Z" }),
    ];
    const db = new FakeDb({ trade_ledger: trades.map(ledgerRow) });
    /** The trades the Journal lists for a drill-down link (its own parser and its own ledger read). */
    const listed = async (href: string) => {
      const { filters, invalid } = parseTradeFilters(new URL(href, "http://x").searchParams);
      expect(invalid).toEqual([]);
      return (await loadLedgerPage(asDb(db), USER, { mode: "all" }, filters, null)).rows.map(row => row.id).sort();
    };
    const all = resolveAccountContext({ accounts: [account(A1), account(A2, { currency: "EUR" })], stored: "all", lastAccount: undefined, proxyNotice: false });
    const view = buildPerformance(all, { rows: trades, truncated: false }, {}, NOW);
    expect(view.daily.map(point => [point.day, point.money.map(money => money.currency)])).toEqual([
      ["2026-09-02", ["EUR", "USD"]], ["2026-10-08", ["EUR", "USD"]], ["2026-10-14", ["USD"]],
    ]);
    for (const point of view.daily) {
      expect(await listed(point.href)).toEqual([...point.tradeIds].sort());
      for (const money of point.money) {
        const own = trades.filter(trade => point.tradeIds.includes(trade.id) && trade.currency === money.currency).map(trade => trade.id).sort();
        expect(await listed(money.href)).toEqual(own);
      }
    }
    // One currency on the page: a currency's figure is the whole day, so it opens the day's own link.
    const usd = resolveAccountContext({ accounts: [account(A1), account(A2, { currency: "EUR" })], stored: A1, lastAccount: undefined, proxyNotice: false });
    const single = buildPerformance(usd, { rows: trades.filter(trade => trade.currency === "USD"), truncated: false }, {}, NOW);
    expect(single.daily.flatMap(point => point.money.map(money => money.href === point.href))).toEqual([true, true, true]);
  });

  it("aggregates R across accounts, money per currency, and adds account contribution only in All Accounts", () => {
    const trades = [
      closed(tradeId(1), "2026-10-13T10:00:00.000Z", "2", "100"),
      closed(tradeId(2), "2026-10-14T10:00:00.000Z", "-1", "-20", { account_id: A2, currency: "EUR", entry_model: "OTE" }),
      closed(tradeId(3), "2026-10-14T11:00:00.000Z", null, "-5", { origin: "LIVE_FIRST" }),
    ];
    const all = resolveAccountContext({ accounts: [account(A1), account(A2, { currency: "EUR" })], stored: "all", lastAccount: undefined, proxyNotice: false });
    const view = buildPerformance(all, { rows: trades, truncated: false }, {}, NOW, { month: "2026-10" });
    expect(view.metrics).toMatchObject({ closed: 3, completed: 2, excludedNoRiskBasis: 1, netR: "1" });
    expect(view.money.map(total => [total.currency, total.netPnl])).toEqual([["EUR", "-20"], ["USD", "95"]]);
    expect(view.contribution?.map(entry => [entry.accountId, entry.netR, entry.href])).toEqual([
      [A1, "2", `/journal?state=closed%2Creviewed&account=${A1}`],
      [A2, "-1", `/journal?state=closed%2Creviewed&account=${A2}`],
    ]);
    expect(view.calendar.days.find(day => day.day === "2026-10-14")?.href).toBe("/journal?closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed");
    expect(view.calendar.previousMonth).toBe("2026-09");
    expect(view.breakdowns.model?.map(group => [group.label, group.href])).toEqual([
      ["OB first touch", "/journal?state=closed%2Creviewed&model=OB_FIRST_TOUCH"],
      ["OTE", "/journal?state=closed%2Creviewed&model=OTE"],
    ]);
    expect(view.rLabel).toBe("R is per-trade risk units, not money");
    const one = resolveAccountContext({ accounts: [account(A1)], stored: A1, lastAccount: undefined, proxyNotice: false });
    expect(buildPerformance(one, { rows: [trades[0]], truncated: false }, {}, NOW).contribution).toBeNull();
  });
});
