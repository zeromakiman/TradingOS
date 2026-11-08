import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An archived trading account takes no new activity (docs/V2_ARCHITECTURE.md §3.2, §9, §14.9). The database refuses
// with ACCOUNT_ARCHIVED (private.require_active_account; tests/v2-integrity-archived-accounts.test.ts), for example when
// the account was archived in another tab after the page loaded, or when a request skips the forms. Every server action
// that starts new activity then answers with one human sentence: never the SQL detail, never the generic failure, with
// no revalidation and nothing logged as an unexpected failure.

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
const m = vi.hoisted(() => ({
  revalidate: vi.fn(),
  rethrow: vi.fn(),
  log: vi.fn(),
  copy: vi.fn(),
  session: null as unknown,
  cookieSets: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ unstable_rethrow: m.rethrow }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: (name: string) => { m.cookieSets.push(name); }, delete: () => undefined }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => m.session }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.log }));
vi.mock("@/lib/evidence", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/evidence")>()), copyEvidenceForDuplicate: m.copy }));

import { addExternalLoss, confirmAccountValuesUnchanged, recordAccountValues } from "@/app/actions/accounts";
import { createMockConnection } from "@/app/actions/connections";
import { errorCode, idleState, rpcErrorCopy, SQL_ERROR_COPY } from "@/app/actions/state";
import { checkRisk, createPlannedTrade, duplicateDraft, lockPlan, recordLiveTrade, reviseDraft } from "@/app/actions/trades";
import { connectionErrorCode, connectionErrorMessage } from "@/lib/sync-service";

// ---------------------------------------------------------------------------------------------------------------------
class Chain {
  private readonly predicates: ((row: Row) => boolean)[] = [];
  private single = false;
  constructor(private readonly rows: Row[]) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.predicates.push(row => row[column] === value); return this; }
  in(column: string, values: unknown[]): this { this.predicates.push(row => values.includes(row[column])); return this; }
  lte(column: string, value: string): this { this.predicates.push(row => String(row[column]) <= value); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): this { this.single = true; return this; }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: unknown; error: null }) => A): Promise<A> {
    const rows = this.rows.filter(row => this.predicates.every(predicate => predicate(row)));
    return Promise.resolve({ data: this.single ? rows[0] ?? null : rows, error: null }).then(resolve);
  }
}

class ActionDb {
  readonly results: Record<string, (args: Row) => RpcResult> = { trading_os_schema: () => ({ data: "2.0", error: null }) };
  readonly rpc = vi.fn(async (fn: string, args: Row = {}) => this.results[fn]?.(args) ?? { data: null, error: { message: `unexpected rpc ${fn}` } });
  constructor(readonly tables: Record<string, Row[]> = {}) {}
  from(table: string): Chain { return new Chain(this.tables[table] ?? []); }
  writes(): string[] { return this.rpc.mock.calls.map(call => call[0]).filter(fn => fn !== "trading_os_schema"); }
}

const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const KEY = "70000000-0000-4000-8000-000000000001";
const RISK = "40000000-0000-4000-8000-000000000001";
const OBS = "60000000-0000-4000-8000-000000000001";
const INSTRUMENT = "30000000-0000-4000-8000-000000000001";
const PROPOSAL = {
  instrumentId: INSTRUMENT, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5",
  narrative: "Sweep of Asia low into H4 order block.", contractConfirmed: true, news: "CLEAR", contradiction: false,
};
/** What private.require_active_account raises. */
const ARCHIVED_SQL = "ACCOUNT_ARCHIVED: This trading account is archived; restore it to add new trades or records";
const ARCHIVED_COPY = "This trading account is archived, so it takes no new trades or records. Restore it in Manage account to use it again.";

/**
 * The account as the page saw it: still active, so the actions' own checks pass and the database is the one that
 * refuses (it was archived since, or the request came from elsewhere).
 */
const tables = (): Record<string, Row[]> => ({
  accounts: [{ id: ACCOUNT, user_id: USER, name: "FTMO", currency: "USD", created_at: "2026-09-01T10:00:00.000Z" }],
  account_profiles: [{ id: 1, account_id: ACCOUNT, user_id: USER, display_name: "FTMO", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: null, status: "ACTIVE" }],
  trades: [{ id: TRADE, user_id: USER, account_id: ACCOUNT }],
  account_observations: [{ id: OBS, account_id: ACCOUNT, user_id: USER, balance: "10000", equity: "10000", gross_loss_today: null, trading_day: "2026-10-26", recorded_at: "2026-10-26T13:00:00.000Z" }],
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let db: ActionDb;
beforeEach(() => {
  vi.clearAllMocks();
  m.cookieSets.length = 0;
  db = new ActionDb(tables());
  m.session = { db, user: { id: USER, email: "trader@example.test" } };
  vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "true");
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------------------------------------------------
describe("ACCOUNT_ARCHIVED copy (§0.6)", () => {
  it("is one human sentence in every error table that maps the RPCs raising it, never the SQL detail", () => {
    expect(errorCode({ message: ARCHIVED_SQL })).toBe("ACCOUNT_ARCHIVED");
    expect(SQL_ERROR_COPY.ACCOUNT_ARCHIVED).toBe(ARCHIVED_COPY);
    expect(rpcErrorCopy({ message: ARCHIVED_SQL, code: "P0001" })).toBe(ARCHIVED_COPY);
    // Connections and imports map their errors in src/lib/sync-service.ts.
    expect(connectionErrorCode(ARCHIVED_SQL)).toBe("ACCOUNT_ARCHIVED");
    expect(connectionErrorMessage(ARCHIVED_SQL)).toBe(ARCHIVED_COPY);
    expect(ARCHIVED_COPY).not.toMatch(/ACCOUNT_ARCHIVED|add new trades or records/);
  });
});

describe("actions that start new activity on an archived account", () => {
  // [action, form, RPC that refuses]. Each form passes validation, so the RPC is reached.
  const cases: [string, (prev: never, data: FormData) => Promise<unknown>, () => FormData, string][] = [
    ["createPlannedTrade", createPlannedTrade,
      () => form({ accountId: ACCOUNT, requestKey: KEY, riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(PROPOSAL) }), "create_planned_trade"],
    ["reviseDraft", reviseDraft,
      () => form({ tradeId: TRADE, requestKey: KEY, expectedRevision: "1", riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(PROPOSAL) }), "revise_trade_draft"],
    ["duplicateDraft", duplicateDraft, () => form({ tradeId: TRADE, requestKey: KEY, riskPlanId: RISK, observationId: OBS }), "duplicate_trade_draft"],
    ["checkRisk", checkRisk, () => form({ tradeId: TRADE }), "check_trade_risk"],
    ["lockPlan", lockPlan, () => form({ tradeId: TRADE, expectedRevision: "1" }), "lock_trade"],
    ["recordLiveTrade", recordLiveTrade, () => form({ accountId: ACCOUNT, requestKey: KEY, symbol: "EURUSD", direction: "LONG" }), "record_live_trade"],
    ["addExternalLoss", addExternalLoss, () => form({ accountId: ACCOUNT, amount: "25", requestKey: KEY }), "add_external_loss"],
    ["recordAccountValues", recordAccountValues, () => form({ accountId: ACCOUNT, balance: "10000", equity: "9950" }), "record_account_values"],
    ["confirmAccountValuesUnchanged", confirmAccountValuesUnchanged, () => form({ accountId: ACCOUNT, observationId: OBS }), "record_account_values"],
  ];

  it.each(cases)("%s answers with the archived copy, without field errors, revalidation or a logged failure", async (_name, action, data, rpc) => {
    db.results[rpc] = () => ({ data: null, error: { message: ARCHIVED_SQL, code: "P0001" } });
    expect(await action(idleState as never, data())).toEqual({ status: "error", message: ARCHIVED_COPY });
    expect(db.writes()).toEqual([rpc]);
    expect(m.revalidate).not.toHaveBeenCalled();
    expect(m.cookieSets).toEqual([]);
    expect(m.log).not.toHaveBeenCalled();
    expect(m.copy).not.toHaveBeenCalled();
  });

  it("connecting a platform answers with the same copy", async () => {
    db.results.create_platform_connection = () => ({ data: null, error: { message: ARCHIVED_SQL, code: "P0001" } });
    expect(await createMockConnection({}, form({ accountId: ACCOUNT, label: "Mock platform", requestKey: KEY }))).toEqual({ error: ARCHIVED_COPY });
    expect(db.writes()).toEqual(["create_platform_connection"]);
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});
