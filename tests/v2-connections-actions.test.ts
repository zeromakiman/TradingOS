import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalPosition, IngestDecision } from "@/domain/sync/contract";

const m = vi.hoisted(() => ({ requireUser: vi.fn(), trustedServer: vi.fn(), revalidatePath: vi.fn(), operationalFailure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("next/navigation", () => ({
  unstable_rethrow: (error: unknown) => {
    if (typeof error === "object" && error !== null && String((error as { digest?: unknown }).digest).startsWith("NEXT_")) throw error;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.requireUser }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: m.trustedServer }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.operationalFailure }));

import { createMockConnection, disconnectConnection, linkExecution, runMockSync, unlinkExecution } from "@/app/actions/connections";

// docs/V2_ARCHITECTURE.md §8.6, §12.2: src/app/actions/connections.ts over the real src/lib/sync-service.ts with mocked clients.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
interface RpcCall { name: string; args: Record<string, unknown> }

const USER = "10000000-0000-4000-8000-000000000001";
const FOREIGN_USER = "10000000-0000-4000-8000-000000000002";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const FORM_ACCOUNT = "20000000-0000-4000-8000-000000000009";
const CONNECTION = "50000000-0000-4000-8000-000000000001";
const TRADE = "30000000-0000-4000-8000-000000000001";
const EXECUTION = "70000000-0000-4000-8000-000000000001";
const KEY = "90000000-0000-4000-8000-000000000001";
const UNAVAILABLE = "Mock platform sync is not available in this deployment.";
const FAILED = "The connection change could not be saved. Refresh and try again.";

/** Minimal PostgREST stand-in: equality/IN filters only, rows returned in table order. */
function fakeClient(tables: Record<string, Row[]>, rpc: (name: string, args: Record<string, unknown>) => Result) {
  const rpcs: RpcCall[] = [];
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const run = (): Result => ({ data: (tables[table] ?? []).filter(row => filters.every(([column, value]) => Array.isArray(value) ? value.includes(row[column]) : row[column] === value)), error: null });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
        in: (column: string, value: unknown[]) => { filters.push([column, value]); return chain; },
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
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
  return { client, rpcs };
}

function session(rpc: (name: string, args: Record<string, unknown>) => Result, tables: Record<string, Row[]> = {}) {
  const fake = fakeClient(tables, rpc);
  m.requireUser.mockResolvedValue({ db: fake.client, user: { id: USER } });
  return fake;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const revalidated = () => m.revalidatePath.mock.calls.map(call => call[0]);

const overview: Row = {
  id: CONNECTION, account_id: ACCOUNT, provider: "MOCK", label: "Mock platform", external_account_ref: null, created_at: "2026-09-14T10:00:00+00:00",
  currency: "USD", status: "CONNECTED", status_message: null, status_at: "2026-09-14T10:00:00+00:00", synced_through: null, last_synced_at: null,
  warning_count: 0, last_warning_at: null, execution_count: 0, unmatched_count: 0,
};
/** One planned EURUSD long locked five minutes before MOCK-1001 entered: a unique automatic match. */
const candidate: Row = {
  id: TRADE, account_id: ACCOUNT, origin: "PLANNED", lifecycle: "LOCKED", symbol: "EURUSD", direction: "LONG", locked_at: "2026-09-15T07:00:00+00:00",
  planned_entry: "1.1", planned_stop: "1.098", instrument_version_id: "60000000-0000-4000-8000-000000000001",
};
const syncTables = { platform_connection_overview: [overview], trade_ledger: [candidate], instrument_versions: [{ id: candidate.instrument_version_id, tick_size: "0.00001" }], external_execution_status: [] };

/** Service-role client answering the service-only RPCs like the database for a fresh connection. */
function trustedClient(options: { failOn?: string } = {}) {
  let created = 0;
  return fakeClient({}, (name, args) => {
    if (name === "record_platform_sync_status") return { data: 1, error: null };
    const position = args.p_execution as ExternalPosition;
    const decision = args.p_decision as IngestDecision;
    if (position.externalId === options.failOn) return { data: null, error: { message: "INVALID_INPUT: internal detail" } };
    created += 1;
    const executionId = `70000000-0000-4000-8000-00000000000${created}`;
    if (decision.kind === "LINK") return { data: { outcome: "LINKED", executionId, tradeId: decision.tradeId }, error: null };
    if (decision.kind === "HOLD") return { data: { outcome: "HELD", executionId, tradeId: null }, error: null };
    return { data: { outcome: "CREATED", executionId, tradeId: `80000000-0000-4000-8000-00000000000${created}` }, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment gate", () => {
  it.each([undefined, "false", "1", "TRUE"])("refuses mock connections and mock sync when the flag is %s", async (flag) => {
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", flag);
    expect(await createMockConnection({}, form({ accountId: ACCOUNT, requestKey: KEY }))).toEqual({ error: UNAVAILABLE });
    expect(await runMockSync({}, form({ connectionId: CONNECTION }))).toEqual({ error: UNAVAILABLE });
    expect(m.requireUser).not.toHaveBeenCalled();
    expect(m.trustedServer).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps disconnecting and link changes available without the flag", async () => {
    vi.stubEnv("TRADING_OS_ENABLE_MOCK_SYNC", "false");
    session(() => ({ data: { connectionId: CONNECTION, accountId: ACCOUNT, status: "DISCONNECTED" }, error: null }));
    expect(await disconnectConnection({}, form({ connectionId: CONNECTION }))).toEqual({ success: "Disconnected. Imported trades and their history are kept." });
  });
});

describe("createMockConnection", () => {
  it("connects the MOCK provider with the validated input only", async () => {
    const fake = session(() => ({ data: CONNECTION, error: null }));
    const result = await createMockConnection({}, form({ accountId: ACCOUNT, label: "  Paper platform  ", requestKey: KEY, provider: "CTRADER", userId: FOREIGN_USER }));
    expect(result).toEqual({ success: "Mock platform connected. Use Simulate sync to import its sample positions." });
    expect(fake.rpcs).toEqual([{ name: "create_platform_connection", args: { p_account_id: ACCOUNT, p_provider: "MOCK", p_label: "Paper platform", p_request_key: KEY } }]);
    expect(revalidated()).toEqual(["/settings", `/accounts/${ACCOUNT}/manage`]);
  });

  it("uses the default label when none is given", async () => {
    const fake = session(() => ({ data: CONNECTION, error: null }));
    await createMockConnection({}, form({ accountId: ACCOUNT, label: "", requestKey: KEY }));
    expect(fake.rpcs[0].args.p_label).toBe("Mock platform");
  });

  it.each([
    ["a malformed account", { accountId: "account-1", requestKey: KEY }],
    ["a missing request key", { accountId: ACCOUNT }],
    ["a label over 60 characters", { accountId: ACCOUNT, requestKey: KEY, label: "x".repeat(61) }],
  ])("rejects %s before reaching the database", async (_name, values) => {
    expect(await createMockConnection({}, form(values))).toEqual({ error: "Choose a trading account and a label of up to 60 characters." });
    expect(m.requireUser).not.toHaveBeenCalled();
  });

  it("maps database refusals to copy and does not revalidate", async () => {
    session(() => ({ data: null, error: { message: "CONNECTION_EXISTS: This trading account already has an active connection" } }));
    expect(await createMockConnection({}, form({ accountId: ACCOUNT, requestKey: KEY }))).toEqual({ error: "This trading account already has an active connection. Disconnect it first." });
    session(() => ({ data: null, error: { message: "ACCOUNT_NOT_FOUND: Account not found" } }));
    expect(await createMockConnection({}, form({ accountId: ACCOUNT, requestKey: KEY }))).toEqual({ error: "That trading account isn't available." });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("disconnectConnection", () => {
  it("revalidates the account the database reports, not one from the form", async () => {
    const fake = session(() => ({ data: { connectionId: CONNECTION, accountId: ACCOUNT, status: "DISCONNECTED" }, error: null }));
    expect(await disconnectConnection({}, form({ connectionId: CONNECTION, accountId: FORM_ACCOUNT }))).toEqual({ success: "Disconnected. Imported trades and their history are kept." });
    expect(fake.rpcs).toEqual([{ name: "disconnect_platform_connection", args: { p_connection_id: CONNECTION } }]);
    expect(revalidated()).toEqual(["/settings", `/accounts/${ACCOUNT}/manage`]);
  });

  it("validates the id and maps refusals", async () => {
    expect(await disconnectConnection({}, form({ connectionId: "1 or 1=1" }))).toEqual({ error: "That connection isn't available." });
    expect(m.requireUser).not.toHaveBeenCalled();
    session(() => ({ data: null, error: { message: "CONNECTION_NOT_FOUND: Connection not found" } }));
    expect(await disconnectConnection({}, form({ connectionId: CONNECTION }))).toEqual({ error: "That connection isn't available." });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("runMockSync", () => {
  it("syncs the mock provider as the session user and revalidates every affected trade", async () => {
    const fake = session(() => ({ data: null, error: { message: "unexpected" } }), syncTables);
    const trusted = trustedClient();
    m.trustedServer.mockReturnValue(trusted.client);
    const result = await runMockSync({}, form({ connectionId: CONNECTION, userId: FOREIGN_USER }));
    expect(result).toEqual({ success: "Sync complete: 2 imported, 1 linked, 0 awaiting your confirmation." });
    expect(fake.rpcs).toEqual([]);
    expect(trusted.rpcs.map(call => [call.name, call.args.p_user_id, call.args.p_connection_id, (call.args.p_decision as IngestDecision | undefined)?.kind ?? call.args.p_status]))
      .toEqual([
        ["record_platform_sync_status", USER, CONNECTION, "SYNCING"],
        ["ingest_external_execution", USER, CONNECTION, "LINK"],
        ["ingest_external_execution", USER, CONNECTION, "CREATE"],
        ["ingest_external_execution", USER, CONNECTION, "CREATE"],
        ["record_platform_sync_status", USER, CONNECTION, "SYNCED"],
      ]);
    expect(revalidated()).toEqual([
      "/settings", `/accounts/${ACCOUNT}/manage`, `/trades/${TRADE}`,
      "/trades/80000000-0000-4000-8000-000000000002", "/trades/80000000-0000-4000-8000-000000000003",
    ]);
  });

  it("returns the stop message and still refreshes what was imported before a failure", async () => {
    session(() => ({ data: null, error: null }), syncTables);
    m.trustedServer.mockReturnValue(trustedClient({ failOn: "MOCK-1002" }).client);
    expect(await runMockSync({}, form({ connectionId: CONNECTION }))).toEqual({ error: "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue." });
    expect(revalidated()).toEqual(["/settings", `/accounts/${ACCOUNT}/manage`, `/trades/${TRADE}`]);
  });

  it("refuses unknown connections and malformed ids", async () => {
    expect(await runMockSync({}, form({ connectionId: "" }))).toEqual({ error: "That connection isn't available." });
    session(() => ({ data: null, error: null }), { platform_connection_overview: [] });
    expect(await runMockSync({}, form({ connectionId: CONNECTION }))).toEqual({ error: "That connection isn't available." });
    expect(m.trustedServer).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a missing service key as a failed run without details", async () => {
    session(() => ({ data: null, error: null }), syncTables);
    m.trustedServer.mockImplementation(() => { throw new Error("Server storage credentials are not configured. Add SUPABASE_SECRET_KEY"); });
    expect(await runMockSync({}, form({ connectionId: CONNECTION }))).toEqual({ error: "The sync could not run. Refresh and try again." });
    expect(m.operationalFailure).toHaveBeenCalledWith("database_write_failed");
  });
});

describe("linkExecution and unlinkExecution", () => {
  const envelope = (action: string) => ({ linkId: 7, tradeId: TRADE, executionId: EXECUTION, accountId: ACCOUNT, action, method: "USER", recordedAt: "2026-09-15T09:00:00+00:00", replayed: false });

  it("links and unlinks the chosen pair and refreshes the trade", async () => {
    const fake = session(name => ({ data: envelope(name === "link_external_execution" ? "LINK" : "UNLINK"), error: null }));
    expect(await linkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION, accountId: FORM_ACCOUNT }))).toEqual({ success: "Platform execution linked to this trade." });
    expect(await unlinkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION }))).toEqual({ success: "Platform execution unlinked. It is listed with the unmatched executions again." });
    expect(fake.rpcs).toEqual([
      { name: "link_external_execution", args: { p_trade_id: TRADE, p_execution_id: EXECUTION } },
      { name: "unlink_external_execution", args: { p_trade_id: TRADE, p_execution_id: EXECUTION } },
    ]);
    expect(revalidated()).toEqual(["/settings", `/accounts/${ACCOUNT}/manage`, `/trades/${TRADE}`, "/settings", `/accounts/${ACCOUNT}/manage`, `/trades/${TRADE}`]);
  });

  it("validates both ids and maps refusals", async () => {
    expect(await linkExecution({}, form({ tradeId: TRADE }))).toEqual({ error: "Choose a trade and a platform execution." });
    expect(await unlinkExecution({}, form({ tradeId: "x", executionId: EXECUTION }))).toEqual({ error: "Choose a trade and a platform execution." });
    expect(m.requireUser).not.toHaveBeenCalled();
    session(() => ({ data: null, error: { message: "LINK_MISMATCH: The execution is for GBPUSD but the trade is for EURUSD" } }));
    expect(await linkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION })))
      .toEqual({ error: "The platform execution doesn't match this trade's account, instrument, direction or lock time." });
    session(() => ({ data: null, error: { message: "LINK_NOT_REMOVABLE: An imported trade stays linked to the platform position it was created from" } }));
    expect(await unlinkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION }))).toEqual({ error: "An imported trade stays linked to the platform position it was created from." });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("unexpected failures", () => {
  it("rethrows framework control flow such as the sign-in redirect", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login?reason=session;307;" });
    m.requireUser.mockRejectedValue(redirect);
    await expect(createMockConnection({}, form({ accountId: ACCOUNT, requestKey: KEY }))).rejects.toBe(redirect);
    await expect(disconnectConnection({}, form({ connectionId: CONNECTION }))).rejects.toBe(redirect);
    await expect(runMockSync({}, form({ connectionId: CONNECTION }))).rejects.toBe(redirect);
    await expect(linkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION }))).rejects.toBe(redirect);
    await expect(unlinkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION }))).rejects.toBe(redirect);
    expect(m.operationalFailure).not.toHaveBeenCalled();
  });

  it("returns generic copy for other errors and malformed responses, never their text", async () => {
    m.requireUser.mockRejectedValue(new Error("connection string postgres://user:secret@db"));
    const result = await linkExecution({}, form({ tradeId: TRADE, executionId: EXECUTION }));
    expect(result).toEqual({ error: FAILED });
    session(() => ({ data: { connectionId: "not-a-uuid" }, error: null }));
    expect(await disconnectConnection({}, form({ connectionId: CONNECTION }))).toEqual({ error: FAILED });
    expect(m.operationalFailure.mock.calls).toEqual([["database_write_failed"], ["database_write_failed"]]);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});
