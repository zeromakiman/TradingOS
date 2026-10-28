import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionSyncProvider, ExternalPosition, IngestDecision } from "@/domain/sync/contract";
import { MOCK_POSITIONS, MockSyncProvider } from "@/domain/sync/mock-provider";
import { normalizeExternalPosition } from "@/domain/sync/normalize";

const m = vi.hoisted(() => ({ requireUser: vi.fn(), trustedServer: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.requireUser }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: m.trustedServer }));

import {
  accountConnectionStates, connectionErrorCode, connectionErrorMessage, connectMockPlatform, type Db, disconnectPlatform, isMockSyncEnabled,
  linkPlatformExecution, listConnections, listLinkCandidates, listLinkedExecutions, listUnmatchedExecutions, loadAccountConnectionStates, loadExecution,
  MOCK_SYNC_UNAVAILABLE, type PlatformConnection, platformOptions, SupabaseSyncStore, simulateMockSync, syncConnection, unlinkPlatformExecution,
} from "@/lib/sync-service";

// docs/V2_ARCHITECTURE.md §8.6 and §10.3: src/lib/sync-service.ts with mocked Supabase clients (no database, no network).

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
interface Query { table: string; columns: string; filters: [string, string, unknown][]; orders: [string, boolean][]; limit: number | null }
interface RpcCall { name: string; args: Record<string, unknown> }

const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "20000000-0000-4000-8000-000000000002";
const CONNECTION = "50000000-0000-4000-8000-000000000001";
const EURUSD = "60000000-0000-4000-8000-000000000001";
const GBPUSD = "60000000-0000-4000-8000-000000000002";
const id = (prefix: number, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const trade = (n: number) => id(3, n);

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a) < String(b) ? -1 : 1;
}

/** In-memory stand-in for the PostgREST client: filters, orders and limits rows; `select` projects columns (`x::text` → `x`). */
function fakeClient(tables: Record<string, Row[]> = {}, rpc: (name: string, args: Record<string, unknown>) => Result = () => ({ data: null, error: null })) {
  const queries: Query[] = [];
  const rpcs: RpcCall[] = [];
  const failing = new Set<string>();
  const client = {
    from(table: string) {
      const query: Query = { table, columns: "", filters: [], orders: [], limit: null };
      queries.push(query);
      const run = (): Result => {
        if (failing.has(table)) return { data: null, error: { message: `permission denied for table ${table}` } };
        let rows = (tables[table] ?? []).filter(row => query.filters.every(([op, column, value]) =>
          op === "eq" ? row[column] === value
            : op === "in" ? (value as unknown[]).includes(row[column])
              : op === "is" ? row[column] === value
                : op === "not.is" ? row[column] !== value && row[column] !== undefined
                  : compare(row[column], value) > 0));
        for (const [column, ascending] of [...query.orders].reverse()) rows = [...rows].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
        if (query.limit !== null) rows = rows.slice(0, query.limit);
        const columns = query.columns.split(",").map(column => column.split("::")[0]);
        return { data: rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), error: null };
      };
      const chain = {
        select: (columns: string) => { query.columns = columns; return chain; },
        eq: (column: string, value: unknown) => { query.filters.push(["eq", column, value]); return chain; },
        in: (column: string, value: unknown[]) => { query.filters.push(["in", column, value]); return chain; },
        is: (column: string, value: unknown) => { query.filters.push(["is", column, value]); return chain; },
        not: (column: string, operator: string, value: unknown) => {
          if (operator !== "is") throw new Error(`Unsupported not-filter ${operator}`);
          query.filters.push(["not.is", column, value]);
          return chain;
        },
        gt: (column: string, value: unknown) => { query.filters.push(["gt", column, value]); return chain; },
        order: (column: string, options?: { ascending?: boolean }) => { query.orders.push([column, options?.ascending !== false]); return chain; },
        limit: (count: number) => { query.limit = count; return chain; },
        // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
        then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
      rpcs.push({ name, args });
      return rpc(name, args);
    },
  };
  return { db: client as unknown as Db, queries, rpcs, failing, tables };
}

/** The trusted server's view of ingest_external_execution: dedup by external id, CLOSED for scripted platform closes. */
class FakePlatform {
  readonly executions = new Map<string, { id: string; payloadHash: string; tradeId: string | null; closedHash: string | null }>();
  readonly statuses: Row[] = [];
  readonly closes = new Map<string, string>();
  failIngestOf: string | null = null;
  failStatus: string | null = null;
  private sequence = 0;

  handle = (name: string, args: Record<string, unknown>): Result => {
    if (args.p_user_id !== USER || args.p_connection_id !== CONNECTION) return { data: null, error: { message: "CONNECTION_NOT_FOUND: Connection not found" } };
    if (name === "record_platform_sync_status") {
      if (args.p_status === this.failStatus) return { data: null, error: { message: "CONNECTION_DISCONNECTED: The connection is disconnected" } };
      this.statuses.push({ status: args.p_status, message: args.p_message, syncedThrough: args.p_synced_through });
      return { data: this.statuses.length, error: null };
    }
    const position = args.p_execution as ExternalPosition;
    const decision = args.p_decision as IngestDecision;
    if (position.externalId === this.failIngestOf) return { data: null, error: { message: "INVALID_INPUT: secret detail from the database" } };
    const known = this.executions.get(position.externalId);
    if (known) {
      if (known.payloadHash === position.payloadHash || known.closedHash === position.payloadHash) return this.envelope("UNCHANGED", known.id, known.tradeId);
      if (this.closes.get(position.externalId) === position.payloadHash && known.closedHash === null) {
        known.closedHash = position.payloadHash;
        return this.envelope("CLOSED", known.id, known.tradeId);
      }
      return this.envelope("CHANGED", known.id, known.tradeId);
    }
    this.sequence += 1;
    const executionId = id(7, this.sequence);
    const tradeId = decision.kind === "LINK" ? decision.tradeId : decision.kind === "CREATE" ? id(8, this.sequence) : null;
    this.executions.set(position.externalId, { id: executionId, payloadHash: position.payloadHash, tradeId, closedHash: null });
    return this.envelope(decision.kind === "LINK" ? "LINKED" : decision.kind === "CREATE" ? "CREATED" : "HELD", executionId, tradeId);
  };

  private envelope(outcome: string, executionId: string, tradeId: string | null): Result {
    return { data: { outcome, executionId, tradeId }, error: null };
  }
}

const ledgerRow = (n: number, changes: Row = {}): Row => ({
  id: trade(n), account_id: ACCOUNT, origin: "PLANNED", lifecycle: "LOCKED", symbol: "EURUSD", direction: "LONG",
  locked_at: "2026-09-15T07:00:00+00:00", planned_entry: "1.1", planned_stop: "1.098", instrument_version_id: EURUSD, ...changes,
});
/** MOCK-1001 matches trade 1 uniquely, MOCK-1002 matches trades 2 and 3 (ambiguous), MOCK-1003 matches nothing. */
function ledgerTables(): Record<string, Row[]> {
  const gbp = { symbol: "GBPUSD", direction: "SHORT", locked_at: "2026-09-15T08:00:00+00:00", planned_entry: "1.2725", planned_stop: "1.2745", instrument_version_id: GBPUSD };
  return {
    trade_ledger: [
      ledgerRow(3, gbp), ledgerRow(1), ledgerRow(2, gbp),
      ledgerRow(4, { lifecycle: "DRAFT" }), ledgerRow(5, { origin: "LIVE_FIRST" }), ledgerRow(6, { account_id: OTHER_ACCOUNT }), ledgerRow(7, { lifecycle: "CLOSED" }),
    ],
    instrument_versions: [{ id: EURUSD, tick_size: "0.00001" }, { id: GBPUSD, tick_size: "0.00001" }],
    external_execution_status: [],
  };
}

function connection(changes: Partial<PlatformConnection> = {}): PlatformConnection {
  return {
    id: CONNECTION, accountId: ACCOUNT, provider: "MOCK", label: "Mock platform", externalAccountRef: null, createdAt: "2026-09-14T10:00:00+00:00",
    currency: "USD", status: "CONNECTED", statusMessage: null, statusAt: "2026-09-14T10:00:00+00:00", syncedThrough: null, lastSyncedAt: null,
    warningCount: 0, lastWarningAt: null, executionCount: 0, unmatchedCount: 0, ...changes,
  };
}

const NOW = "2026-10-01T12:00:00Z";
function syncSetup(tables: Record<string, Row[]> = ledgerTables()) {
  const platform = new FakePlatform();
  const user = fakeClient(tables);
  const admin = fakeClient({}, platform.handle);
  const sync = (options: { provider?: ExecutionSyncProvider; target?: PlatformConnection } = {}) => syncConnection({
    db: user.db, admin: admin.db, userId: USER, connection: options.target ?? connection(), provider: options.provider ?? new MockSyncProvider(), now: NOW,
  });
  return { platform, user, admin, sync };
}

class FixedProvider implements ExecutionSyncProvider {
  readonly id = "MOCK" as const;
  readonly readOnly = true as const;
  constructor(private readonly positions: readonly unknown[]) {}
  async fetchPositions(): Promise<readonly unknown[]> {
    return structuredClone([...this.positions]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment gate and platform choices", () => {
  it("enables the mock provider only for TRADING_OS_ENABLE_MOCK_SYNC=true", () => {
    expect(isMockSyncEnabled({ TRADING_OS_ENABLE_MOCK_SYNC: "true" })).toBe(true);
    for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) expect(isMockSyncEnabled({ TRADING_OS_ENABLE_MOCK_SYNC: value }), String(value)).toBe(false);
  });

  it("lists future providers as unavailable and never claims connectivity", () => {
    expect(platformOptions({})).toEqual([
      { provider: "CTRADER", name: "cTrader", available: false, note: "Read-only sync planned for V2.1" },
      { provider: "MT5", name: "MetaTrader 5", available: false, note: "Bridge planned for V2.2" },
    ]);
    expect(platformOptions({ TRADING_OS_ENABLE_MOCK_SYNC: "true" }).map(option => [option.provider, option.available])).toEqual([["CTRADER", false], ["MT5", false], ["MOCK", true]]);
  });
});

describe("error contract", () => {
  it("maps stable SQL prefixes to human copy and never echoes database text", () => {
    expect(connectionErrorCode("LINK_MISMATCH: The execution is for GBPUSD but the trade is for EURUSD")).toBe("LINK_MISMATCH");
    expect(connectionErrorMessage("LINK_MISMATCH: The execution is for GBPUSD but the trade is for EURUSD"))
      .toBe("The platform execution doesn't match this trade's account, instrument, direction or lock time.");
    expect(connectionErrorMessage("PROVIDER_NOT_AVAILABLE: CTRADER sync is not available in this version"))
      .toBe("This platform isn't available yet. Trades are recorded manually in this version.");
    for (const raw of ["duplicate key value violates unique constraint \"x\"", "UNKNOWN_CODE: detail", "toString: x", null, undefined]) {
      expect(connectionErrorMessage(raw)).toBe("The connection change could not be saved. Refresh and try again.");
    }
    expect(connectionErrorCode("permission denied for function ingest_external_execution")).toBeNull();
  });
});

describe("read models (RLS client)", () => {
  const overviewRow = (changes: Row = {}): Row => ({
    id: CONNECTION, account_id: ACCOUNT, provider: "MOCK", label: "Mock platform", external_account_ref: null, created_at: "2026-09-14T10:00:00+00:00",
    currency: "USD", status: "SYNCED", status_message: "Sync complete: 1 imported, 0 linked, 0 awaiting your confirmation.", status_at: "2026-09-16T14:06:00+00:00",
    synced_through: "2026-09-16T14:05:00+00:00", last_synced_at: "2026-09-16T14:06:00+00:00", warning_count: 1, last_warning_at: "2026-09-16T14:06:00+00:00",
    execution_count: 3, unmatched_count: 1, ...changes,
  });

  it("lists connections of the trader, optionally per account, and maps them", async () => {
    const other = overviewRow({ id: id(5, 2), account_id: OTHER_ACCOUNT, provider: "CTRADER", status: null, status_at: null, created_at: "2026-09-13T10:00:00+00:00" });
    const { db, queries } = fakeClient({ platform_connection_overview: [overviewRow(), other] });
    const all = await listConnections(db);
    expect(all.map(c => [c.id, c.status])).toEqual([[id(5, 2), "PENDING"], [CONNECTION, "SYNCED"]]);
    expect(all[1]).toMatchObject({ accountId: ACCOUNT, syncedThrough: "2026-09-16T14:05:00+00:00", warningCount: 1, executionCount: 3, unmatchedCount: 1 });
    expect(await listConnections(db, { accountId: ACCOUNT })).toHaveLength(1);
    expect(queries.map(q => [q.table, q.filters, q.orders])).toEqual([
      ["platform_connection_overview", [], [["created_at", true], ["id", true]]],
      ["platform_connection_overview", [["eq", "account_id", ACCOUNT]], [["created_at", true], ["id", true]]],
    ]);
  });

  it("fails closed on unreadable or malformed rows without exposing database text", async () => {
    const broken = fakeClient({ platform_connection_overview: [overviewRow({ synced_through: "2026-09-16 14:05" })] });
    await expect(listConnections(broken.db)).rejects.toThrow();
    const denied = fakeClient({ platform_connection_overview: [overviewRow()] });
    denied.failing.add("platform_connection_overview");
    await expect(listConnections(denied.db)).rejects.toThrow(/^Connections are unavailable\.$/);
  });

  it("derives one state per account: Manual without an active connection, errors with their message", () => {
    const accounts = [ACCOUNT, OTHER_ACCOUNT, id(2, 3)];
    const states = accountConnectionStates(accounts, [
      connection({ accountId: OTHER_ACCOUNT, status: "DISCONNECTED" }),
      connection({ status: "ERROR", statusMessage: "The platform did not return positions. Nothing was imported.", lastSyncedAt: "2026-09-16T14:06:00+00:00" }),
      connection({ accountId: id(2, 9), status: "SYNCED" }),
      connection({ accountId: id(2, 3), status: "SYNCED", lastSyncedAt: "2026-09-16T14:06:00+00:00" }),
    ]);
    expect([...states.keys()]).toEqual(accounts);
    expect(states.get(ACCOUNT)).toMatchObject({ mode: "ERROR", message: "The platform did not return positions. Nothing was imported.", lastSyncedAt: "2026-09-16T14:06:00+00:00" });
    expect(states.get(OTHER_ACCOUNT)).toEqual({ mode: "MANUAL", connection: null, lastSyncedAt: null, message: null });
    expect(states.get(id(2, 3))).toMatchObject({ mode: "SYNCED", message: null, lastSyncedAt: "2026-09-16T14:06:00+00:00" });
  });

  it("loads account states with one read, and none for no accounts", async () => {
    const { db, queries } = fakeClient({ platform_connection_overview: [overviewRow()] });
    expect((await loadAccountConnectionStates(db, [ACCOUNT])).get(ACCOUNT)?.mode).toBe("SYNCED");
    expect((await loadAccountConnectionStates(db, [])).size).toBe(0);
    expect(queries).toHaveLength(1);
  });

  const executionRow = (n: number, changes: Row = {}): Row => ({
    id: id(7, n), account_id: ACCOUNT, connection_id: CONNECTION, provider: "MOCK", connection_label: "Mock platform", external_id: `MOCK-${n}`,
    symbol: "EURUSD", direction: "LONG", volume: "0.25", entry_price: "1.10012", entered_at: `2026-09-15T07:0${n}:00+00:00`, exit_price: null, exited_at: null,
    commission: null, swap: null, realized_pnl: null, currency: "USD", payload_hash: "a".repeat(64), received_at: "2026-09-15T08:00:00+00:00",
    close_received_at: null, linked_trade_id: null, link_method: null, linked_at: null, warning_count: 0, last_warning_message: null, last_warning_at: null, ...changes,
  });

  it("lists unmatched executions newest first with a bounded page size", async () => {
    const rows = [executionRow(1), executionRow(2, { linked_trade_id: trade(1), link_method: "USER", linked_at: "2026-09-15T09:00:00+00:00" }), executionRow(3, {
      exit_price: "1.10612", exited_at: "2026-09-15T09:40:00+00:00", realized_pnl: "148.25", close_received_at: "2026-09-15T10:00:00+00:00", warning_count: 1,
      last_warning_message: "EURUSD long position MOCK-3 changed on the platform after import; the recorded version was kept.",
    })];
    const { db, queries } = fakeClient({ external_execution_status: rows });
    const unmatched = await listUnmatchedExecutions(db, { accountId: ACCOUNT });
    expect(unmatched.map(e => e.externalId)).toEqual(["MOCK-3", "MOCK-1"]);
    expect(unmatched[0]).toMatchObject({ exitPrice: "1.10612", realizedPnl: "148.25", closeReceivedAt: "2026-09-15T10:00:00+00:00", warningCount: 1, linkedTradeId: null });
    expect(queries[0]).toMatchObject({ table: "external_execution_status", filters: [["is", "linked_trade_id", null], ["eq", "account_id", ACCOUNT]], orders: [["entered_at", false], ["id", true]], limit: 100 });
    await listUnmatchedExecutions(db, { limit: 0 });
    await listUnmatchedExecutions(db, { limit: 10_000 });
    expect(queries.slice(1).map(q => q.limit)).toEqual([1, 500]);
    expect((await loadExecution(db, id(7, 2)))?.linkMethod).toBe("USER");
    expect(await loadExecution(db, id(7, 99))).toBeNull();
  });

  it("lists linked executions newest first (automatic, trader and import links), never unlinked ones, with a bounded page size", async () => {
    const rows = [
      executionRow(1),
      executionRow(2, { linked_trade_id: trade(1), link_method: "USER", linked_at: "2026-09-15T09:00:00+00:00" }),
      executionRow(3, { linked_trade_id: trade(2), link_method: "IMPORT_CREATED", linked_at: "2026-09-15T08:00:00+00:00", exit_price: "1.10612", exited_at: "2026-09-15T09:40:00+00:00", realized_pnl: "148.25" }),
      executionRow(4, { account_id: OTHER_ACCOUNT, linked_trade_id: trade(6), link_method: "AUTO_MATCH", linked_at: "2026-09-15T08:00:00+00:00" }),
    ];
    const { db, queries } = fakeClient({ external_execution_status: rows });
    const linked = await listLinkedExecutions(db, { accountId: ACCOUNT });
    expect(linked.map(e => [e.externalId, e.linkedTradeId, e.linkMethod])).toEqual([["MOCK-3", trade(2), "IMPORT_CREATED"], ["MOCK-2", trade(1), "USER"]]);
    expect(linked[0]).toMatchObject({ exitPrice: "1.10612", realizedPnl: "148.25", linkedAt: "2026-09-15T08:00:00+00:00" });
    expect(queries[0]).toMatchObject({
      table: "external_execution_status", filters: [["not.is", "linked_trade_id", null], ["eq", "account_id", ACCOUNT]], orders: [["entered_at", false], ["id", true]], limit: 100,
    });
    expect((await listLinkedExecutions(db)).map(e => e.externalId)).toEqual(["MOCK-4", "MOCK-3", "MOCK-2"]);
    await listLinkedExecutions(db, { limit: 0 });
    await listLinkedExecutions(db, { limit: 10_000 });
    expect(queries.slice(2).map(q => q.limit)).toEqual([1, 500]);
    const denied = fakeClient({ external_execution_status: rows });
    denied.failing.add("external_execution_status");
    await expect(listLinkedExecutions(denied.db, { accountId: ACCOUNT })).rejects.toThrow(/^Platform executions are unavailable\.$/);
    await expect(listLinkedExecutions(fakeClient({ external_execution_status: [executionRow(5, { linked_trade_id: trade(1), link_method: "SOMEHOW" })] }).db)).rejects.toThrow();
  });

  it("offers link candidates under the database rules, suggested matches first", async () => {
    const tables = ledgerTables();
    tables.trade_ledger.push(
      ledgerRow(8, { locked_at: "2026-09-15T06:00:00+00:00", planned_entry: "1.2" }),
      ledgerRow(9, { locked_at: "2026-09-15T07:10:00+00:00" }),
      ledgerRow(10, { lifecycle: "LIVE", symbol: "eur/usd", locked_at: "2026-09-15T06:50:00+00:00" }),
      ledgerRow(11, { direction: "SHORT" }),
    );
    tables.external_execution_status = [executionRow(1, { linked_trade_id: trade(10) })];
    const { db } = fakeClient(tables);
    const execution = (await loadExecution(fakeClient({ external_execution_status: [executionRow(5, { entered_at: "2026-09-15T07:05:00+00:00" })] }).db, id(7, 5)));
    if (execution === null) throw new Error("fixture");
    const candidates = await listLinkCandidates(db, execution);
    // Trade 1 is an automatic match; 7 is closed (trader links only); 8 was locked too early to match; 9 was locked after the entry;
    // 10 is already linked; 11 is short; drafts, live-first trades and other accounts are never offered.
    expect(candidates.map(c => [c.tradeId, c.suggested])).toEqual([[trade(1), true], [trade(7), false], [trade(8), false]]);
  });
});

describe("sync store and orchestration", () => {
  it("links a unique match, holds an ambiguous one and imports the rest, ingesting as the session user", async () => {
    const { platform, user, admin, sync } = syncSetup();
    const result = await sync();
    expect(result).toMatchObject({ ok: true, accountId: ACCOUNT, closed: 0, message: "Sync complete: 1 imported, 1 linked, 1 awaiting your confirmation." });
    if (!result.ok) throw new Error(result.error);
    expect(result.report.decisions).toEqual([
      { externalId: "MOCK-1001", decision: { kind: "LINK", tradeId: trade(1) }, outcome: "LINKED" },
      { externalId: "MOCK-1002", decision: { kind: "HOLD" }, outcome: "HELD" },
      { externalId: "MOCK-1003", decision: { kind: "CREATE" }, outcome: "CREATED" },
    ]);
    expect(result.tradeIds).toEqual([trade(1), platform.executions.get("MOCK-1003")?.tradeId].sort());
    // Candidates come from the trader's RLS client; only the service-role client calls the service-only RPCs.
    expect(user.rpcs).toEqual([]);
    expect(admin.queries).toEqual([]);
    expect(user.queries.map(q => q.table)).toEqual(["trade_ledger", "instrument_versions", "external_execution_status"]);
    expect(user.queries[0]).toMatchObject({
      columns: "id,account_id,origin,lifecycle,symbol,direction,locked_at,planned_entry,planned_stop,instrument_version_id",
      filters: [["eq", "account_id", ACCOUNT], ["eq", "origin", "PLANNED"], ["in", "lifecycle", ["LOCKED", "LIVE"]]],
    });
    expect(admin.rpcs.map(call => [call.name, call.args.p_user_id, call.args.p_connection_id])).toEqual([
      ["record_platform_sync_status", USER, CONNECTION], ["ingest_external_execution", USER, CONNECTION], ["ingest_external_execution", USER, CONNECTION],
      ["ingest_external_execution", USER, CONNECTION], ["record_platform_sync_status", USER, CONNECTION],
    ]);
    const first = normalizeExternalPosition(MOCK_POSITIONS[0]);
    if (!first.ok) throw new Error(first.error);
    expect(admin.rpcs[1].args).toEqual({ p_user_id: USER, p_connection_id: CONNECTION, p_execution: first.position, p_decision: { kind: "LINK", tradeId: trade(1) } });
    expect(platform.statuses).toEqual([
      { status: "SYNCING", message: null, syncedThrough: null },
      { status: "SYNCED", message: "Sync complete: 1 imported, 1 linked, 1 awaiting your confirmation.", syncedThrough: "2026-09-16T14:05:00.000000Z" },
    ]);
  });

  it("is deterministic regardless of provider and candidate order", async () => {
    const forward = syncSetup();
    const reversedTables = ledgerTables();
    reversedTables.trade_ledger.reverse();
    const backward = syncSetup(reversedTables);
    const a = await forward.sync({ provider: new FixedProvider(MOCK_POSITIONS) });
    const b = await backward.sync({ provider: new FixedProvider([...MOCK_POSITIONS].reverse()) });
    expect(b).toEqual(a);
    expect(backward.admin.rpcs).toEqual(forward.admin.rpcs);
  });

  it("is idempotent: a repeated run changes nothing", async () => {
    const { platform, sync } = syncSetup();
    await sync();
    const again = await sync();
    expect(again).toMatchObject({ ok: true, tradeIds: [], closed: 0, report: { created: 0, linked: 0, held: 0, unchanged: 3, changed: 0 } });
    expect(platform.executions.size).toBe(3);
    expect(platform.statuses.at(-1)).toMatchObject({ status: "SYNCED", message: "Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation." });
  });

  it("never links a candidate that is already linked", async () => {
    const tables = ledgerTables();
    tables.external_execution_status = [{ linked_trade_id: trade(1) }];
    const { sync } = syncSetup(tables);
    const result = await sync();
    expect(result.ok && result.report.decisions[0]).toEqual({ externalId: "MOCK-1001", decision: { kind: "CREATE" }, outcome: "CREATED" });
  });

  it("reports platform closes of stored positions as closed and records the domain summary", async () => {
    const open = { ...MOCK_POSITIONS[1] };
    const closed = { ...open, exitPrice: "1.27150", exitedAt: "2026-09-17T09:00:00Z", commission: "-0.70", swap: "0", realizedPnl: "9.30" };
    const { platform, sync } = syncSetup();
    await sync({ provider: new FixedProvider([open]) });
    const normalized = normalizeExternalPosition(closed);
    if (!normalized.ok) throw new Error(normalized.error);
    platform.closes.set(open.externalId, normalized.position.payloadHash);
    const result = await sync({ provider: new FixedProvider([closed, { ...open, externalId: "MOCK-BAD", volume: "-1" }]) });
    if (!result.ok) throw new Error(result.error);
    const message = "Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 1 closed, 1 rejected.";
    expect(result.report).toMatchObject({
      message, closed: 1, changed: 0, unchanged: 0, decisions: [{ externalId: "MOCK-1002", decision: { kind: "HOLD" }, outcome: "CLOSED" }],
    });
    expect(result).toMatchObject({ message, closed: 1, tradeIds: [] });
    expect(platform.statuses.at(-1)).toEqual({ status: "SYNCED", message, syncedThrough: "2026-09-17T09:00:00.000000Z" });
    // A close of an imported trade refreshes that trade.
    const imported = syncSetup({ trade_ledger: [], instrument_versions: [], external_execution_status: [] });
    await imported.sync({ provider: new FixedProvider([open]) });
    const importedTrade = imported.platform.executions.get(open.externalId)?.tradeId;
    imported.platform.closes.set(open.externalId, normalized.position.payloadHash);
    const closing = await imported.sync({ provider: new FixedProvider([closed]) });
    expect(closing).toMatchObject({ ok: true, closed: 1, tradeIds: [importedTrade], report: { closed: 1, changed: 0 } });
    expect(imported.platform.statuses.at(-1)).toMatchObject({ status: "SYNCED", message: "Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 1 closed." });
  });

  it("stops on a database error with a fixed message, records ERROR and keeps the cursor", async () => {
    const { platform, sync } = syncSetup();
    platform.failIngestOf = "MOCK-1003";
    const result = await sync({ target: connection({ syncedThrough: "2026-09-01T00:00:00+00:00" }) });
    expect(result).toMatchObject({ ok: true, message: "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue." });
    expect(result.ok && result.report).toMatchObject({ status: "ERROR", linked: 1, held: 1, syncedThrough: "2026-09-01T00:00:00+00:00" });
    expect(result.ok && result.tradeIds).toEqual([trade(1)]);
    expect(platform.statuses.at(-1)).toEqual({ status: "ERROR", message: "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue.", syncedThrough: null });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("treats unreadable candidates as a store failure", async () => {
    const { user, platform, sync } = syncSetup();
    user.failing.add("trade_ledger");
    const result = await sync();
    expect(result.ok && result.report).toMatchObject({ status: "ERROR", created: 0, linked: 0, held: 0 });
    expect(platform.executions.size).toBe(0);
    expect(platform.statuses.map(s => s.status)).toEqual(["SYNCING", "ERROR"]);
  });

  it("refuses disconnected connections and maps status failures", async () => {
    const disconnected = syncSetup();
    expect(await disconnected.sync({ target: connection({ status: "DISCONNECTED" }) }))
      .toEqual({ ok: false, code: "CONNECTION_DISCONNECTED", error: "This connection is disconnected. Connect it again before syncing." });
    expect(disconnected.admin.rpcs).toEqual([]);

    const raced = syncSetup();
    raced.platform.failStatus = "SYNCING";
    expect(await raced.sync()).toEqual({ ok: false, code: "CONNECTION_DISCONNECTED", error: "This connection is disconnected. Connect it again before syncing." });
    expect(raced.admin.rpcs.map(call => call.name)).toEqual(["record_platform_sync_status"]);

    const unsaved = syncSetup();
    unsaved.platform.failStatus = "SYNCED";
    expect(await unsaved.sync()).toEqual({ ok: false, code: "CONNECTION_DISCONNECTED", error: "The sync result could not be saved. Imported positions are kept; run the sync again." });
  });

  it("loads every candidate page and chunks the lookups", async () => {
    const tables = ledgerTables();
    for (let n = 100; n < 701; n += 1) tables.trade_ledger.push(ledgerRow(n, { instrument_version_id: id(6, n), symbol: "XAUUSD" }));
    tables.instrument_versions.push(...Array.from({ length: 601 }, (_, i) => ({ id: id(6, 100 + i), tick_size: "0.01" })));
    const { user, sync } = syncSetup(tables);
    const result = await sync();
    expect(result.ok && result.report.decisions.map(d => d.decision.kind)).toEqual(["LINK", "HOLD", "CREATE"]);
    // 604 candidates: a full page of 500 ordered by id, then the rest after the last id of that page.
    const ledgerQueries = user.queries.filter(q => q.table === "trade_ledger");
    expect(ledgerQueries.map(q => [q.limit, q.orders, q.filters.find(f => f[0] === "gt")?.[2] ?? null])).toEqual([[500, [["id", true]], null], [500, [["id", true]], trade(596)]]);
    const lookups = user.queries.filter(q => q.table !== "trade_ledger");
    expect(lookups.every(q => (q.filters[0][2] as unknown[]).length <= 100)).toBe(true);
    expect(lookups.filter(q => q.table === "instrument_versions")).toHaveLength(7);
    expect(lookups.filter(q => q.table === "external_execution_status")).toHaveLength(7);
  });

  it("passes every database outcome through to the domain and tracks affected trades in a sorted list", async () => {
    const platform = new FakePlatform();
    const target = { id: CONNECTION, accountId: ACCOUNT, accountCurrency: "USD", provider: "MOCK" as const, syncedThrough: null };
    const store = (admin: Db = fakeClient({}, platform.handle).db) => new SupabaseSyncStore({ db: fakeClient().db, admin, userId: USER, connection: target });
    const normalize = (fixture: unknown) => {
      const result = normalizeExternalPosition(fixture);
      if (!result.ok) throw new Error(result.error);
      return result.position;
    };
    const [winner, open, loser] = MOCK_POSITIONS.map(normalize);
    const first = store();
    expect(await first.ingest(loser, { kind: "CREATE" })).toBe("CREATED");
    expect(await first.ingest(winner, { kind: "LINK", tradeId: trade(1) })).toBe("LINKED");
    expect(await first.ingest(open, { kind: "HOLD" })).toBe("HELD");
    const imported = normalize({ ...MOCK_POSITIONS[1], externalId: "MOCK-OPEN" });
    expect(await first.ingest(imported, { kind: "CREATE" })).toBe("CREATED");
    expect(first.affectedTradeIds).toEqual([trade(1), id(8, 1), id(8, 4)].sort());

    // A later run: repeats, conflicting versions and platform closes.
    const closed = normalize({ ...MOCK_POSITIONS[1], externalId: "MOCK-OPEN", exitPrice: "1.27150", exitedAt: "2026-09-17T09:00:00Z", realizedPnl: "9.30" });
    platform.closes.set("MOCK-OPEN", closed.payloadHash);
    const second = store();
    expect(await second.ingest(open, { kind: "HOLD" })).toBe("UNCHANGED");
    expect(await second.ingest(normalize({ ...MOCK_POSITIONS[1], volume: "0.20" }), { kind: "HOLD" })).toBe("CHANGED");
    expect(await second.ingest(closed, { kind: "CREATE" })).toBe("CLOSED");
    expect(second.affectedTradeIds).toEqual([id(8, 4)]);

    // Anything else from the database is a store failure, never a guessed outcome.
    const unknown = store(fakeClient({}, () => ({ data: { outcome: "MERGED", executionId: id(7, 9), tradeId: null }, error: null })).db);
    await expect(unknown.ingest(open, { kind: "HOLD" })).rejects.toThrow();
  });
});

describe("commands take the user from the verified session", () => {
  function session(tables: Record<string, Row[]> = {}, rpc?: (name: string, args: Record<string, unknown>) => Result) {
    const client = fakeClient(tables, rpc);
    m.requireUser.mockResolvedValue({ db: client.db, user: { id: USER } });
    return client;
  }

  it("connects the mock platform only when enabled", async () => {
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "false");
    const client = session({}, () => ({ data: CONNECTION, error: null }));
    expect(await connectMockPlatform({ accountId: ACCOUNT, label: "Mock platform", requestKey: id(9, 1) })).toEqual({ ok: false, code: "PROVIDER_NOT_AVAILABLE", error: MOCK_SYNC_UNAVAILABLE });
    expect(m.requireUser).not.toHaveBeenCalled();
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "true");
    expect(await connectMockPlatform({ accountId: ACCOUNT, label: "Mock platform", requestKey: id(9, 1) })).toEqual({ ok: true, connectionId: CONNECTION });
    expect(client.rpcs).toEqual([{ name: "create_platform_connection", args: { p_account_id: ACCOUNT, p_provider: "MOCK", p_label: "Mock platform", p_request_key: id(9, 1) } }]);
  });

  it("maps database refusals of connection commands to copy", async () => {
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "true");
    session({}, () => ({ data: null, error: { message: "CONNECTION_EXISTS: This trading account already has an active connection" } }));
    expect(await connectMockPlatform({ accountId: ACCOUNT, label: "x", requestKey: id(9, 1) }))
      .toEqual({ ok: false, code: "CONNECTION_EXISTS", error: "This trading account already has an active connection. Disconnect it first." });
    const client = session({}, () => ({ data: { connectionId: CONNECTION, accountId: ACCOUNT, status: "DISCONNECTED" }, error: null }));
    expect(await disconnectPlatform(CONNECTION)).toEqual({ ok: true, connectionId: CONNECTION, accountId: ACCOUNT });
    expect(client.rpcs).toEqual([{ name: "disconnect_platform_connection", args: { p_connection_id: CONNECTION } }]);
  });

  it("links and unlinks through the trader's client and reports replays", async () => {
    const envelope = { linkId: 4, tradeId: trade(1), executionId: id(7, 1), accountId: ACCOUNT, action: "LINK", method: "USER", recordedAt: "2026-09-15T09:00:00+00:00", replayed: true };
    const client = session({}, (name) => ({ data: { ...envelope, action: name === "link_external_execution" ? "LINK" : "UNLINK" }, error: null }));
    expect(await linkPlatformExecution(trade(1), id(7, 1))).toEqual({ ok: true, tradeId: trade(1), executionId: id(7, 1), accountId: ACCOUNT, replayed: true });
    expect(await unlinkPlatformExecution(trade(1), id(7, 1))).toMatchObject({ ok: true, tradeId: trade(1) });
    expect(client.rpcs).toEqual([
      { name: "link_external_execution", args: { p_trade_id: trade(1), p_execution_id: id(7, 1) } },
      { name: "unlink_external_execution", args: { p_trade_id: trade(1), p_execution_id: id(7, 1) } },
    ]);
    session({}, () => ({ data: null, error: { message: "LINK_NOT_REMOVABLE: An imported trade stays linked to the platform position it was created from" } }));
    expect(await unlinkPlatformExecution(trade(1), id(7, 1))).toEqual({ ok: false, code: "LINK_NOT_REMOVABLE", error: "An imported trade stays linked to the platform position it was created from." });
  });

  it("simulates a sync only for the trader's own mock connection, ingesting with the session user", async () => {
    const overview = (provider: string) => [{
      id: CONNECTION, account_id: ACCOUNT, provider, label: "Mock platform", external_account_ref: null, created_at: "2026-09-14T10:00:00+00:00", currency: "USD",
      status: "CONNECTED", status_message: null, status_at: "2026-09-14T10:00:00+00:00", synced_through: null, last_synced_at: null, warning_count: 0,
      last_warning_at: null, execution_count: 0, unmatched_count: 0,
    }];
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "false");
    expect(await simulateMockSync(CONNECTION)).toEqual({ ok: false, code: "PROVIDER_NOT_AVAILABLE", error: MOCK_SYNC_UNAVAILABLE });
    expect(m.requireUser).not.toHaveBeenCalled();
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "true");
    session({ platform_connection_overview: [] });
    expect(await simulateMockSync(CONNECTION)).toEqual({ ok: false, code: "CONNECTION_NOT_FOUND", error: "That connection isn't available." });
    session({ platform_connection_overview: overview("CTRADER") });
    expect(await simulateMockSync(CONNECTION)).toMatchObject({ ok: false, code: "PROVIDER_NOT_AVAILABLE" });
    expect(m.trustedServer).not.toHaveBeenCalled();

    const platform = new FakePlatform();
    const admin = fakeClient({}, platform.handle);
    m.trustedServer.mockReturnValue(admin.db);
    const client = session({ ...ledgerTables(), platform_connection_overview: overview("MOCK") });
    const result = await simulateMockSync(CONNECTION);
    expect(result).toMatchObject({ ok: true, accountId: ACCOUNT, tradeIds: expect.arrayContaining([trade(1)]) });
    expect(client.queries[0]).toMatchObject({ table: "platform_connection_overview", filters: [["eq", "id", CONNECTION]] });
    expect(admin.rpcs.every(call => call.args.p_user_id === USER)).toBe(true);
    expect(client.rpcs).toEqual([]);
  });
});
