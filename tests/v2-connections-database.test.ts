import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerRow } from "@/domain/ledger";
import type { ExternalPosition, IngestDecision } from "@/domain/sync/contract";
import { MOCK_POSITIONS } from "@/domain/sync/mock-provider";
import { normalizeExternalPosition } from "@/domain/sync/normalize";
import { classifyTiming, type StoredPhase } from "@/domain/timeline";
import { type BootstrappedAccount, createTestDatabase, migrationFiles, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §8.6 (0017_platform_connections.sql) over all migrations present at run time.

type Json = Record<string, unknown>;
interface IngestEnvelope { outcome: string; executionId: string; tradeId: string | null }
interface LinkEnvelope { linkId: number; tradeId: string; executionId: string; accountId: string; action: string; method: string; replayed: boolean }

const TABLES = ["platform_connections", "external_executions", "external_execution_closes", "platform_connection_events", "trade_execution_links"];
const VIEWS = ["platform_connection_overview", "external_execution_status"];
const USER_RPCS: Record<string, string[]> = {
  create_platform_connection: ["uuid", "text", "text", "uuid"],
  disconnect_platform_connection: ["uuid"],
  link_external_execution: ["uuid", "uuid"],
  unlink_external_execution: ["uuid", "uuid"],
};
const SERVICE_RPCS: Record<string, string[]> = {
  ingest_external_execution: ["uuid", "uuid", "jsonb", "jsonb"],
  record_platform_sync_status: ["uuid", "uuid", "text", "text", "timestamptz"],
};
const PRIVATE_FUNCTIONS = ["connection_status", "active_execution_link", "active_trade_link", "normalized_symbol", "external_execution_hash",
  "external_execution_input", "execution_label", "execution_warning", "close_imported_trade", "check_execution_link", "guard_execution_links", "link_envelope"];
const nullCall = (name: string, types: string[]) => `select public.${name}(${types.map((t) => `null::${t}`).join(", ")})`;

let db: TestDatabase;

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return value<number>(`select count(*)::int as value from (${sql}) x`, params);
}
async function rows(sql: string, params: unknown[] = []): Promise<Json[]> {
  return (await db.query<Json>(sql, params)).rows;
}

const raw = MOCK_POSITIONS[0];
/** A normalized platform position (the exact payload sync-service sends) with its TypeScript payload hash. */
function position(changes: Json = {}): ExternalPosition {
  const result = normalizeExternalPosition({ ...raw, ...changes });
  if (!result.ok) throw new Error(result.error);
  return result.position;
}
const openPosition = (changes: Json = {}) => position({ exitPrice: null, exitedAt: null, commission: null, swap: null, realizedPnl: null, ...changes });
/** The same position reported closed by the platform (MOCK-1001 close: +600 ticks on 0.25 lots, $1.75 commission). */
const closedLater = (open: ExternalPosition, changes: Json = {}) => position({ externalId: open.externalId, enteredAt: open.enteredAt, exitedAt: ago(10), ...changes });

async function connect(a: BootstrappedAccount, label = "Mock platform", key: string = randomUUID(), user = OWNER): Promise<string> {
  await db.actor(user);
  return value<string>("select public.create_platform_connection($1, 'MOCK', $2, $3) as value", [a.accountId, label, key]);
}
/** The trusted server's secret key carries no user id: auth.uid() is null inside the service-only functions. */
async function trustedServer(): Promise<void> {
  await db.actor("", "service_role");
}
async function ingest(connectionId: string, payload: unknown, decision: IngestDecision | Json = { kind: "CREATE" }, user = OWNER): Promise<IngestEnvelope> {
  await trustedServer();
  return value<IngestEnvelope>("select public.ingest_external_execution($1, $2, $3::jsonb, $4::jsonb) as value",
    [user, connectionId, JSON.stringify(payload), JSON.stringify(decision)]);
}
async function syncStatus(connectionId: string, status: string, message: string | null = null, syncedThrough: string | null = null, user = OWNER): Promise<number> {
  await trustedServer();
  return Number(await value<number>("select public.record_platform_sync_status($1, $2, $3, $4, $5::timestamptz) as value", [user, connectionId, status, message, syncedThrough]));
}
async function link(tradeId: string, executionId: string, user = OWNER): Promise<LinkEnvelope> {
  await db.actor(user);
  return value<LinkEnvelope>("select public.link_external_execution($1, $2) as value", [tradeId, executionId]);
}
async function unlink(tradeId: string, executionId: string, user = OWNER): Promise<LinkEnvelope> {
  await db.actor(user);
  return value<LinkEnvelope>("select public.unlink_external_execution($1, $2) as value", [tradeId, executionId]);
}
async function overview(connectionId: string): Promise<Json> {
  await db.actor(OWNER);
  return (await rows("select * from public.platform_connection_overview where id = $1", [connectionId]))[0];
}
async function executionStatus(executionId: string): Promise<Json> {
  await db.actor(OWNER);
  return (await rows("select external_id, linked_trade_id, link_method from public.external_execution_status where id = $1", [executionId]))[0];
}
async function warnings(connectionId: string): Promise<Json[]> {
  await db.actor(OWNER);
  return rows("select message, external_execution_id, payload_hash from public.platform_connection_events where connection_id = $1 and status = 'WARNING' order by id", [connectionId]);
}
async function platformCloses(executionId: string): Promise<Json[]> {
  await db.actor(OWNER);
  return rows(`select trim_scale(exit_price)::text as exit_price, exited_at, trim_scale(commission)::text as commission, trim_scale(swap)::text as swap,
      trim_scale(realized_pnl)::text as realized_pnl, payload_hash from public.external_execution_closes where external_execution_id = $1`, [executionId]);
}
/** The ledger row exactly as PostgREST serializes it, validated against the domain contract. */
async function ledger(tradeId: string) {
  await db.actor(OWNER);
  return ledgerRow.parse(await value<Json>("select to_jsonb(l) as value from public.trade_ledger l where l.id = $1", [tradeId]));
}
async function closeLiveTrade(tradeId: string, input: Json): Promise<void> {
  await db.actor(OWNER);
  await db.query("select public.close_live_trade($1, $2::jsonb)", [tradeId, JSON.stringify(input)]);
}

const proposal = (a: BootstrappedAccount, changes: Json = {}) => ({
  instrumentId: a.instrumentId, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600",
  riskPercent: "0.5", narrative: "Synthetic connection test plan", contractConfirmed: true, news: "CLEAR", contradiction: false, ...changes,
});
async function draft(a: BootstrappedAccount, changes: Json = {}, user = OWNER): Promise<string> {
  await db.actor(user);
  const envelope = await value<{ tradeId: string }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, JSON.stringify(proposal(a, changes)), randomUUID(), a.riskId, a.observationId]);
  return envelope.tradeId;
}
/** A locked plan and its lock instant as PostgreSQL text (microseconds kept). */
async function lockedTrade(a: BootstrappedAccount, changes: Json = {}, user = OWNER): Promise<{ tradeId: string; lockedAt: string }> {
  const tradeId = await draft(a, changes, user);
  const locked = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [tradeId]);
  expect(locked.planId).toBeTruthy();
  return { tradeId, lockedAt: await value<string>("select locked_at::text as value from public.trade_ledger where id = $1", [tradeId]) };
}
async function liveFirst(a: BootstrappedAccount): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.record_live_trade($1, '{\"symbol\":\"EURUSD\",\"direction\":\"LONG\"}'::jsonb, $2) as value", [a.accountId, randomUUID()]);
}
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
/** The database clock with microseconds: an exit time that is never before a lock recorded just earlier. */
async function dbNow(): Promise<string> {
  await db.admin();
  return value<string>("select clock_timestamp()::text as value");
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // Deterministic eligible session for lock scenarios; production RPCs keep clock_timestamp().
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

describe("schema (§0.5, §10.1)", () => {
  it("adds the connection migration before the erasure migration", () => {
    const files = migrationFiles();
    expect(files).toContain("0017_platform_connections.sql");
    expect(files.filter((name) => name.startsWith("0017_"))).toEqual(["0017_platform_connections.sql"]);
    const erasure = files.findIndex((name) => name.startsWith("0019_"));
    if (erasure >= 0) expect(files.indexOf("0017_platform_connections.sql")).toBeLessThan(erasure);
  });

  it("protects every new table with RLS, one owner read policy, select-only grants and immutability", async () => {
    await db.admin();
    const tables = await rows(`
      select c.relname as name, c.relrowsecurity as rls,
             (select array_agg(p.policyname::text order by p.policyname) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
             (select array_agg(distinct r.role order by r.role) from unnest(array['anon','authenticated','service_role']) r(role)
               where has_table_privilege(r.role, c.oid, 'INSERT') or has_table_privilege(r.role, c.oid, 'UPDATE')
                  or has_table_privilege(r.role, c.oid, 'DELETE') or has_table_privilege(r.role, c.oid, 'TRUNCATE')) as writers,
             has_table_privilege('authenticated', c.oid, 'SELECT') as owner_read, has_table_privilege('anon', c.oid, 'SELECT') as anon_read,
             has_table_privilege('service_role', c.oid, 'SELECT') as service_read,
             exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgfoid = 'private.reject_mutation()'::regprocedure
                       and t.tgtype & 2 = 2 and t.tgtype & 8 = 8 and t.tgtype & 16 = 16) as immutable,
             exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'f'
                       and k.conkey @> array[(select attnum from pg_attribute where attrelid = c.oid and attname = 'user_id'),
                                             (select attnum from pg_attribute where attrelid = c.oid and attname = 'account_id')]) as scoped_key
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [TABLES]);
    expect(tables).toEqual([...TABLES].sort().map((name) => ({
      name, rls: true, policies: ["read_own"], writers: null, owner_read: true, anon_read: false, service_read: false, immutable: true, scoped_key: true,
    })));
    const views = await rows(`select relname as name, reloptions as options, has_table_privilege('authenticated', oid, 'SELECT') as owner_read,
        has_table_privilege('anon', oid, 'SELECT') as anon_read, has_table_privilege('service_role', oid, 'SELECT') as service_read
        from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by relname`, [VIEWS]);
    expect(views).toEqual([...VIEWS].sort().map((name) => ({ name, options: ["security_invoker=true"], owner_read: true, anon_read: false, service_read: false })));
    expect(await count(`select 1 from pg_class c cross join unnest(array['anon','authenticated','service_role']) r(role)
        where c.relkind = 'S' and c.relname in ('platform_connection_events_id_seq', 'trade_execution_links_id_seq')
          and (has_sequence_privilege(r.role, c.oid, 'USAGE') or has_sequence_privilege(r.role, c.oid, 'SELECT') or has_sequence_privilege(r.role, c.oid, 'UPDATE'))`)).toBe(0);
  });

  it("keeps the sealed-secret table private and unused", async () => {
    await db.admin();
    expect(await rows(`select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
        where a.attrelid = 'private.platform_connection_secrets'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`))
      .toEqual([{ name: "connection_id", type: "uuid" }, { name: "sealed", type: "bytea" }, { name: "created_at", type: "timestamp with time zone" }]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(await value<boolean>("select has_table_privilege($1, 'private.platform_connection_secrets', $2) as value", [role, privilege]), `${role} ${privilege}`).toBe(false);
      }
    }
    expect(await count("select 1 from private.platform_connection_secrets")).toBe(0);
  });

  it("defines every function with an empty search_path and exact grants", async () => {
    await db.admin();
    const functions = await rows(`
      select p.proname::text as name, n.nspname::text as schema, p.prosecdef as definer, coalesce(p.proconfig, '{}') as config,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') as public_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname = any($1)) or (n.nspname = 'private' and p.proname = any($2)) order by 2, 1`,
      [[...Object.keys(USER_RPCS), ...Object.keys(SERVICE_RPCS)], PRIVATE_FUNCTIONS]);
    expect(functions).toHaveLength(Object.keys(USER_RPCS).length + Object.keys(SERVICE_RPCS).length + PRIVATE_FUNCTIONS.length);
    for (const fn of functions) {
      expect(fn.config, String(fn.name)).toContain('search_path=""');
      expect(fn.anon || fn.public_execute, String(fn.name)).toBe(false);
      if (fn.schema === "private") expect([fn.authenticated, fn.service], String(fn.name)).toEqual([false, false]);
      else expect([fn.definer, fn.authenticated, fn.service], String(fn.name)).toEqual([true, String(fn.name) in USER_RPCS, String(fn.name) in SERVICE_RPCS]);
    }
  });

  it.each(Object.entries(USER_RPCS))("denies anon and service_role execution of %s", async (name, types) => {
    for (const role of ["anon", "service_role"] as const) {
      await db.actor("", role);
      await expect(db.query(nullCall(name, types)), role).rejects.toThrow(/permission denied for function/);
    }
  });

  it.each(Object.entries(SERVICE_RPCS))("keeps %s service-only (never authenticated or anon)", async (name, types) => {
    for (const role of ["anon", "authenticated"] as const) {
      await db.actor(role === "anon" ? "" : OWNER, role);
      await expect(db.query(nullCall(name, types)), role).rejects.toThrow(/permission denied for function/);
    }
  });
});

describe("connections", () => {
  it("connects only the MOCK provider, replays the request key and validates input", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const id = await connect(a, "  Mock platform  ", key);
    expect(await connect(a, "Mock platform", key)).toBe(id);
    await expect(connect(a, "Renamed", key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    for (const providerName of ["CTRADER", "MT5"]) {
      await expect(db.query("select public.create_platform_connection($1, $2, 'x', $3)", [a.accountId, providerName, randomUUID()])).rejects.toThrow(/^PROVIDER_NOT_AVAILABLE:/);
    }
    await expect(db.query("select public.create_platform_connection($1, 'FTX', 'x', $2)", [a.accountId, randomUUID()])).rejects.toThrow(/^INVALID_INPUT: provider/);
    await expect(db.query("select public.create_platform_connection($1, 'MOCK', '   ', $2)", [a.accountId, randomUUID()])).rejects.toThrow(/^INVALID_INPUT: label/);
    await expect(db.query("select public.create_platform_connection($1, 'MOCK', $2, $3)", [a.accountId, "x".repeat(61), randomUUID()])).rejects.toThrow(/^INVALID_INPUT: label/);
    await expect(db.query("select public.create_platform_connection($1, 'MOCK', 'x', null)", [a.accountId])).rejects.toThrow(/^INVALID_INPUT: A request key/);
    expect(await overview(id)).toMatchObject({
      account_id: a.accountId, provider: "MOCK", label: "Mock platform", external_account_ref: null, currency: "USD", status: "CONNECTED",
      status_message: null, synced_through: null, last_synced_at: null, warning_count: 0, execution_count: 0, unmatched_count: 0,
    });
    expect(await rows("select request_key from public.platform_connections where id = $1", [id])).toEqual([{ request_key: key }]);
  });

  it("keeps one connection per account and provider: connecting again returns it and resumes it after a disconnect", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await connect(a);
    expect(await connect(a, "Second label")).toBe(id);
    await db.actor(OWNER);
    const disconnected = await value<Json>("select public.disconnect_platform_connection($1) as value", [id]);
    expect(disconnected).toEqual({ connectionId: id, accountId: a.accountId, status: "DISCONNECTED" });
    expect(await value<Json>("select public.disconnect_platform_connection($1) as value", [id])).toEqual(disconnected);
    expect((await overview(id)).status).toBe("DISCONNECTED");
    await expect(ingest(id, position())).rejects.toThrow(/^CONNECTION_DISCONNECTED:/);
    await expect(syncStatus(id, "SYNCING")).rejects.toThrow(/^CONNECTION_DISCONNECTED:/);
    expect(await connect(a, "Mock again")).toBe(id);
    expect(await rows("select status from public.platform_connection_events where connection_id = $1 order by id", [id]))
      .toEqual([{ status: "CONNECTED" }, { status: "DISCONNECTED" }, { status: "CONNECTED" }]);
    expect(await overview(id)).toMatchObject({ status: "CONNECTED", label: "Mock platform" });
  });

  it("allows one active connection per trading account across providers", async () => {
    const a = await db.bootstrapAccount(OWNER);
    // A future provider's connection, written as the migration owner (only MOCK can be created in V2).
    await db.admin();
    const ctrader = await value<string>("insert into public.platform_connections(user_id, account_id, provider, label, external_account_ref) values ($1, $2, 'CTRADER', 'cTrader', '••••4821') returning id as value", [OWNER, a.accountId]);
    await db.query("insert into public.platform_connection_events(connection_id, user_id, account_id, status) values ($1, $2, $3, 'CONNECTED')", [ctrader, OWNER, a.accountId]);
    await expect(connect(a)).rejects.toThrow(/^CONNECTION_EXISTS:/);
    await db.actor(OWNER);
    await db.query("select public.disconnect_platform_connection($1)", [ctrader]);
    const mock = await connect(a);
    expect(mock).not.toBe(ctrader);
    expect(await overview(ctrader)).toMatchObject({ provider: "CTRADER", external_account_ref: "••••4821", status: "DISCONNECTED" });
  });

  it("scopes connections to their owner", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await connect(a);
    await db.bootstrapAccount(OTHER);
    await expect(connect(a, "Mine now", randomUUID(), OTHER)).rejects.toThrow(/^ACCOUNT_NOT_FOUND:/);
    await expect(db.query("select public.disconnect_platform_connection($1)", [id])).rejects.toThrow(/^CONNECTION_NOT_FOUND:/);
    for (const name of [...TABLES, ...VIEWS]) expect(await count(`select 1 from public.${name} where account_id = $1`, [a.accountId]), name).toBe(0);
    await expect(ingest(id, position(), { kind: "CREATE" }, OTHER)).rejects.toThrow(/^CONNECTION_NOT_FOUND:/);
    await expect(syncStatus(id, "SYNCING", null, null, OTHER)).rejects.toThrow(/^CONNECTION_NOT_FOUND:/);
    await db.anon();
    for (const name of [...TABLES, ...VIEWS]) await expect(db.query(`select 1 from public.${name}`), name).rejects.toThrow(/permission denied/);
  });
});

describe("ingest_external_execution (§8.6)", () => {
  it("imports a closed position as an IMPORTED trade with facts, an IMPORTED close and an IMPORT_CREATED link", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const payload = position();
    const created = await ingest(connection, payload);
    expect(created).toMatchObject({ outcome: "CREATED" });
    const tradeId = String(created.tradeId);
    await db.actor(OWNER);
    expect(await rows("select origin, request_key, duplicated_from, migrated_from from public.trades where id = $1", [tradeId]))
      .toEqual([{ origin: "IMPORTED", request_key: null, duplicated_from: null, migrated_from: null }]);
    expect(await rows(`select instrument_version_id, symbol, direction, entry_model, entry_price::text, entered_at = $2::timestamptz as entered, quantity::text,
        initial_stop, risk_amount, source from public.trade_position_facts where trade_id = $1`, [tradeId, payload.enteredAt]))
      .toEqual([{ instrument_version_id: a.instrumentId, symbol: "EURUSD", direction: "LONG", entry_model: null, entry_price: "1.10012", entered: true, quantity: "0.25", initial_stop: null, risk_amount: null, source: "IMPORT" }]);
    expect(await rows(`select exit_price::text, fees::text, gross_pnl::text, net_pnl::text, pnl_source, risk_basis, risk_basis_source, realized_r, outcome, calculation_version
        from public.trade_unplanned_closes where trade_id = $1`, [tradeId]))
      .toEqual([{ exit_price: "1.10612", fees: "1.75", gross_pnl: "150", net_pnl: "148.25", pnl_source: "IMPORTED", risk_basis: null, risk_basis_source: null, realized_r: null, outcome: "WIN", calculation_version: "UNPLANNED_CLOSE_V1" }]);
    expect(await rows("select trade_id, action, method from public.trade_execution_links where external_execution_id = $1", [created.executionId]))
      .toEqual([{ trade_id: tradeId, action: "LINK", method: "IMPORT_CREATED" }]);
    expect(await rows(`select external_id, symbol, direction, volume::text, entry_price::text, exit_price::text, commission::text, swap::text, realized_pnl::text, currency, payload_hash
        from public.external_executions where id = $1`, [created.executionId]))
      .toEqual([{ external_id: "MOCK-1001", symbol: "EURUSD", direction: "LONG", volume: "0.25", entry_price: "1.10012", exit_price: "1.10612", commission: "-1.75", swap: "0.00", realized_pnl: "148.25", currency: "USD", payload_hash: payload.payloadHash }]);
    expect(await platformCloses(created.executionId)).toEqual([]);
    const row = await ledger(tradeId);
    expect(row).toMatchObject({
      origin: "IMPORTED", lifecycle: "CLOSED", account_id: a.accountId, currency: "USD", symbol: "EURUSD", direction: "LONG", instrument_version_id: a.instrumentId,
      entry_price: "1.10012", entry_time_known: true, quantity: "0.25", initial_stop: null, initial_risk: null, actual_initial_risk: null, oversize: null,
      exit_price: "1.10612", fees: "1.75", gross_pnl: "150", net_pnl: "148.25", realized_r: null, outcome: "WIN", pnl_source: "IMPORTED", calculation_version: "UNPLANNED_CLOSE_V1",
      planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null,
      plan_id: null, locked_at: null, revision_count: 0, latest_revision: null, draft_check: null, strategy_version_id: null, risk_plan_version_id: null,
    });
    expect(Date.parse(String(row.entered_at))).toBe(Date.parse(payload.enteredAt));
    expect(Date.parse(String(row.exited_at))).toBe(Date.parse(String(payload.exitedAt)));
    expect(await executionStatus(created.executionId)).toEqual({ external_id: "MOCK-1001", linked_trade_id: tradeId, link_method: "IMPORT_CREATED" });
    expect(await overview(connection)).toMatchObject({ execution_count: 1, unmatched_count: 0, warning_count: 0 });
  });

  it("splits platform costs into fees only when they are known costs", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const cases: [Json, Json][] = [
      // A swap credit larger than the commission: the gross/fee split is unknown.
      [{ externalId: "MOCK-CREDIT", commission: "-1.75", swap: "2.10", realizedPnl: "150.35" }, { fees: "0", gross_pnl: null, net_pnl: "150.35", outcome: "WIN" }],
      // No cost reported at all.
      [{ externalId: "MOCK-NOCOST", commission: null, swap: null, realizedPnl: "-20" }, { fees: "0", gross_pnl: null, net_pnl: "-20", outcome: "LOSS" }],
      [{ externalId: "MOCK-FLAT", commission: "0", swap: null, realizedPnl: "0" }, { fees: "0", gross_pnl: "0", net_pnl: "0", outcome: "BREAKEVEN" }],
    ];
    for (const [changes, expected] of cases) {
      const created = await ingest(connection, position(changes));
      await db.actor(OWNER);
      expect(await rows("select trim_scale(fees)::text as fees, gross_pnl::text, net_pnl::text, outcome, pnl_source from public.trade_unplanned_closes where trade_id = $1", [created.tradeId]), String(changes.externalId))
        .toEqual([{ ...expected, pnl_source: "IMPORTED" }]);
    }
  });

  it("imports an open position as a LIVE trade whose records are never pre-entry", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const payload = openPosition({ externalId: "MOCK-OPEN", symbol: "GBPUSD", direction: "SELL", volume: "0.10", entryPrice: "1.27250", enteredAt: ago(45) });
    const created = await ingest(connection, payload);
    const tradeId = String(created.tradeId);
    expect(await ledger(tradeId)).toMatchObject({ origin: "IMPORTED", lifecycle: "LIVE", symbol: "GBPUSD", direction: "SHORT", quantity: "0.1", exited_at: null, net_pnl: null, pnl_source: null });
    await db.actor(OWNER);
    const live = await value<string>("select public.add_journal_entry($1, 'NOTE', 'Managing the imported position', '{}'::jsonb, $2) as value", [tradeId, randomUUID()]);
    await trustedServer();
    const evidence = await value<{ phase: string }>("select public.register_trade_evidence($1, $2::jsonb) as value", [OWNER, JSON.stringify({
      id: randomUUID(), tradeId, label: "MANAGEMENT", originalFilename: "chart.png", mimeType: "image/png", byteSize: 2048, sha256: "a".repeat(64), width: 1280, height: 720, captureMethod: "PASTE",
    })]);
    expect(evidence.phase).toBe("LIVE");
    await closeLiveTrade(tradeId, { exitPrice: "1.27150", exitedAt: ago(1), fees: "0.70" });
    const closed = await ledger(tradeId);
    expect(closed).toMatchObject({ lifecycle: "CLOSED", gross_pnl: "10", net_pnl: "9.3", pnl_source: "CALCULATED", realized_r: null });
    const after = await value<string>("select public.add_journal_entry($1, 'LESSON', 'Took profit early', '{}'::jsonb, $2) as value", [tradeId, randomUUID()]);
    const records = await rows("select id, phase, state_at_creation, recorded_at::text as recorded_at from public.trade_journal_entries where trade_id = $1 order by recorded_at, id", [tradeId]);
    expect(records.map((r) => [r.id, r.phase, r.state_at_creation])).toEqual([[live, "LIVE", "LIVE"], [after, "POST_TRADE", "CLOSED"]]);
    for (const record of records) {
      const timing = classifyTiming({
        recordedAt: String(record.recorded_at), storedPhase: record.phase as StoredPhase, origin: "IMPORTED", entryAt: closed.entered_at,
        entryRecordedAt: closed.entry_recorded_at, exitAt: closed.exited_at, tradeCreatedAt: closed.created_at,
      });
      expect(timing.timing).not.toBe("BEFORE_ENTRY");
    }
    expect(await count("select 1 from public.trade_journal_entries where trade_id = $1 and phase = 'PRE_ENTRY' union all select 1 from public.trade_evidence where trade_id = $1 and phase = 'PRE_ENTRY'", [tradeId])).toBe(0);
  });

  it("is a no-op for an identical payload and records any other change once as a warning without overwriting", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const open = openPosition({ externalId: "MOCK-2001", enteredAt: ago(90) });
    const created = await ingest(connection, open);
    const snapshot = async () => {
      await db.actor(OWNER);
      return {
        trades: await count("select 1 from public.trades where account_id = $1", [a.accountId]),
        executions: await rows("select id, volume, exit_price, exited_at, payload_hash, received_at from public.external_executions where account_id = $1", [a.accountId]),
        links: await count("select 1 from public.trade_execution_links where account_id = $1", [a.accountId]),
        closes: await count("select 1 from public.trade_unplanned_closes where account_id = $1 union all select 1 from public.external_execution_closes where account_id = $1", [a.accountId]),
      };
    };
    const before = await snapshot();
    expect(await ingest(connection, open, { kind: "HOLD" })).toEqual({ outcome: "UNCHANGED", executionId: created.executionId, tradeId: created.tradeId });
    // Formatting differences normalize to the same canonical payload.
    expect((await ingest(connection, openPosition({ externalId: "MOCK-2001", enteredAt: open.enteredAt, volume: 0.25, entryPrice: "1.100120" }))).outcome).toBe("UNCHANGED");
    expect(await snapshot()).toEqual(before);

    const resized = openPosition({ externalId: "MOCK-2001", enteredAt: open.enteredAt, volume: "0.3" });
    expect(await ingest(connection, resized)).toEqual({ outcome: "CHANGED", executionId: created.executionId, tradeId: created.tradeId });
    expect(await ingest(connection, resized)).toEqual({ outcome: "CHANGED", executionId: created.executionId, tradeId: created.tradeId });
    // A close whose identity also changed is not a close of the stored position.
    const closedResized = closedLater(open, { volume: "0.3" });
    expect((await ingest(connection, closedResized)).outcome).toBe("CHANGED");
    expect(await snapshot()).toEqual(before);
    expect(await warnings(connection)).toEqual([
      { message: "EURUSD long position MOCK-2001 changed on the platform after import; the recorded version was kept.", external_execution_id: created.executionId, payload_hash: resized.payloadHash },
      { message: "EURUSD long position MOCK-2001 changed on the platform after import; the recorded version was kept.", external_execution_id: created.executionId, payload_hash: closedResized.payloadHash },
    ]);
    expect(await overview(connection)).toMatchObject({ status: "CONNECTED", warning_count: 2, execution_count: 1 });
    expect((await ledger(String(created.tradeId))).lifecycle).toBe("LIVE");
  });

  it("verifies the payload hash against the canonical position (parity with positionHash)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    for (const fixture of MOCK_POSITIONS) {
      const result = normalizeExternalPosition(fixture);
      if (!result.ok) throw new Error(result.error);
      expect((await ingest(connection, result.position, { kind: "HOLD" })).outcome).toBe("HELD");
    }
    const unicode = position({ externalId: "Tické \"7\" \\ 9", enteredAt: ago(120), exitedAt: ago(100), exitPrice: "1.1", realizedPnl: "-0.5" });
    expect((await ingest(connection, unicode, { kind: "HOLD" })).outcome).toBe("HELD");
    const { payloadHash, ...withoutHash } = position({ externalId: "MOCK-NOHASH" });
    expect((await ingest(connection, withoutHash, { kind: "HOLD" })).outcome).toBe("HELD");
    await db.actor(OWNER);
    expect(await value<string>("select payload_hash as value from public.external_executions where external_id = 'MOCK-NOHASH' and account_id = $1", [a.accountId])).toBe(payloadHash);
    await expect(ingest(connection, { ...position({ externalId: "MOCK-TAMPERED" }), payloadHash: "0".repeat(64) })).rejects.toThrow(/^INVALID_INPUT: payloadHash/);
    await expect(ingest(connection, { ...position({ externalId: "MOCK-TAMPERED" }), volume: "0.26" })).rejects.toThrow(/^INVALID_INPUT: payloadHash/);
  });

  it.each([
    ["an unknown field", { leverage: "100" }, /^INVALID_INPUT: unknown field "leverage"/],
    ["a numeric volume", { volume: 0.25 }, /^INVALID_INPUT: volume must be a string/],
    ["NaN", { entryPrice: "NaN" }, /^INVALID_INPUT: entryPrice/],
    ["a negative volume", { volume: "-1" }, /^INVALID_INPUT: volume/],
    ["sub-cent money", { commission: "-1.755" }, /^INVALID_INPUT: commission/],
    ["a lower-case symbol", { symbol: "eurusd" }, /^INVALID_INPUT: symbol/],
    ["a padded external id", { externalId: " MOCK-1 " }, /^INVALID_INPUT: externalId/],
    ["an unknown direction", { direction: "BUY" }, /^INVALID_INPUT: direction/],
    ["another currency", { currency: "EUR" }, /^CURRENCY_MISMATCH:/],
    ["a future entry", { enteredAt: new Date(Date.now() + 3_600_000).toISOString(), exitPrice: null, exitedAt: null, realizedPnl: null }, /^INVALID_TIME:/],
    ["an exit before the entry", { exitedAt: "2026-09-15T07:04:59.999999Z" }, /^INVALID_TIME:/],
    ["an exit price without an exit time", { exitedAt: null }, /^INVALID_INPUT: exitPrice requires exitedAt/],
    ["a close without price or P&L", { exitPrice: null, realizedPnl: null }, /^INVALID_INPUT: A closed position/],
    ["a local timestamp", { enteredAt: "2026-09-15 07:05" }, /^INVALID_INPUT: enteredAt/],
  ])("rejects %s without storing anything", async (_name, changes, error) => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const { payloadHash: _hash, ...payload } = position();
    await expect(ingest(connection, { ...payload, ...changes })).rejects.toThrow(error);
    await db.actor(OWNER);
    expect(await count("select 1 from public.external_executions where account_id = $1 union all select 1 from public.trades where account_id = $1", [a.accountId])).toBe(0);
  });

  it.each([
    [{ kind: "IMPORT" }, /^INVALID_INPUT: decision kind/],
    [{ kind: "LINK" }, /^INVALID_INPUT: tradeId is required for LINK/],
    [{ kind: "CREATE", tradeId: randomUUID() }, /^INVALID_INPUT: tradeId is required for LINK/],
    [{ kind: "HOLD", reason: "x" }, /^INVALID_INPUT: unknown field "reason"/],
    [{ kind: "LINK", tradeId: "not-a-uuid" }, /^INVALID_INPUT: tradeId must be a UUID/],
  ])("validates the decision %#", async (decision, error) => {
    const a = await db.bootstrapAccount(OWNER);
    await expect(ingest(await connect(a), position(), decision)).rejects.toThrow(error);
  });

  it("holds ambiguous executions unlinked, without a trade or a warning", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const held = await ingest(connection, position({ externalId: "MOCK-HOLD" }), { kind: "HOLD" });
    expect(held).toMatchObject({ outcome: "HELD", tradeId: null });
    // Closed without a platform P&L: still the trader's choice of plan.
    const unvalued = await ingest(connection, position({ externalId: "MOCK-HOLD-NOPNL", realizedPnl: null }), { kind: "HOLD" });
    expect(unvalued).toMatchObject({ outcome: "HELD", tradeId: null });
    await db.actor(OWNER);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(0);
    expect(await count("select 1 from public.trade_execution_links where account_id = $1", [a.accountId])).toBe(0);
    expect(await warnings(connection)).toEqual([]);
    expect(await executionStatus(held.executionId)).toEqual({ external_id: "MOCK-HOLD", linked_trade_id: null, link_method: null });
    expect(await overview(connection)).toMatchObject({ execution_count: 2, unmatched_count: 2, warning_count: 0, status: "CONNECTED" });
  });

  it("imports a position closed without a platform P&L as a live trade and asks the trader to record the close", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const unvalued = position({ externalId: "MOCK-NOPNL", realizedPnl: null });
    const created = await ingest(connection, unvalued);
    expect(created).toMatchObject({ outcome: "CREATED" });
    const tradeId = String(created.tradeId);
    expect(await ledger(tradeId)).toMatchObject({
      origin: "IMPORTED", lifecycle: "LIVE", instrument_version_id: a.instrumentId, quantity: "0.25", exit_price: null, net_pnl: null, pnl_source: null,
    });
    expect(await executionStatus(created.executionId)).toEqual({ external_id: "MOCK-NOPNL", linked_trade_id: tradeId, link_method: "IMPORT_CREATED" });
    const warning = {
      message: "EURUSD long position MOCK-NOPNL was closed on the platform without a realized P&L; record the close on the trade.",
      external_execution_id: created.executionId, payload_hash: unvalued.payloadHash,
    };
    expect(await warnings(connection)).toEqual([warning]);
    expect(await ingest(connection, unvalued)).toEqual({ outcome: "UNCHANGED", executionId: created.executionId, tradeId });
    expect(await warnings(connection)).toEqual([warning]);

    // The trader records the platform's close; with the attached contract the P&L is calculated.
    await closeLiveTrade(tradeId, { exitPrice: "1.10612", exitedAt: unvalued.exitedAt, fees: "1.75" });
    expect(await ledger(tradeId)).toMatchObject({ lifecycle: "CLOSED", gross_pnl: "150", net_pnl: "148.25", pnl_source: "CALCULATED" });
    // A later platform version with a P&L is a warning only; the recorded close stays.
    expect(await ingest(connection, position({ externalId: "MOCK-NOPNL" }))).toEqual({ outcome: "CHANGED", executionId: created.executionId, tradeId });
    expect((await ledger(tradeId)).net_pnl).toBe("148.25");
    expect(await overview(connection)).toMatchObject({ execution_count: 1, unmatched_count: 0, warning_count: 2, status: "CONNECTED" });
  });

  it("attaches the account's latest contract only to positions on its tick and size grid", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const contract = async (input: Json) => {
      await db.actor(OWNER);
      return value<string>("select public.create_instrument_version($1, $2::jsonb) as value", [a.accountId, JSON.stringify({ quantityUnit: "lots", ...input })]);
    };
    const gold = await contract({ symbol: "XAUUSD", tickSize: "0.01", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.1" });
    const importOpen = async (changes: Json) => {
      const open = openPosition({ enteredAt: ago(120), ...changes });
      const created = await ingest(connection, open);
      expect(created.outcome).toBe("CREATED");
      return { open, tradeId: String(created.tradeId) };
    };
    // EURUSD (bootstrap contract): tick 0.00001, size step 0.01, minimum 0.01.
    const cases: [Json, string | null][] = [
      [{ externalId: "GRID-ON" }, a.instrumentId],
      [{ externalId: "GRID-STEP", volume: "0.015" }, null],
      [{ externalId: "GRID-TICK", entryPrice: "1.100125" }, null],
      [{ externalId: "GRID-MINIMUM", symbol: "XAUUSD", entryPrice: "2650.10", volume: "0.05" }, null],
      [{ externalId: "GRID-GOLD", symbol: "XAUUSD", entryPrice: "2650.10", volume: "0.1" }, gold],
      [{ externalId: "GRID-UNKNOWN", symbol: "USDJPY", entryPrice: "149.123" }, null],
    ];
    const completeEntry = async (tradeId: string, details: Json) => {
      await db.actor(OWNER);
      await db.query("select public.complete_live_entry($1, $2::jsonb, $3)", [tradeId, JSON.stringify(details), randomUUID()]);
    };
    const imported = new Map<string, { open: ExternalPosition; tradeId: string }>();
    for (const [changes, instrument] of cases) {
      const trade = await importOpen(changes);
      imported.set(String(changes.externalId), trade);
      expect((await ledger(trade.tradeId)).instrument_version_id, String(changes.externalId)).toBe(instrument);
      // Entry details can always be completed, so the trader can record what was at risk.
      await completeEntry(trade.tradeId, { riskAmount: "50", entryModel: "OTE" });
    }
    const step = imported.get("GRID-STEP");
    if (step === undefined) throw new Error("fixture");
    await completeEntry(step.tradeId, { initialStop: "1.09812" });
    // The platform close of an off-grid position gets a realized R from the reported risk.
    expect((await ingest(connection, closedLater(step.open, { volume: "0.015" }))).outcome).toBe("CLOSED");
    expect(await ledger(step.tradeId)).toMatchObject({ lifecycle: "CLOSED", net_pnl: "148.25", realized_r: "2.965", instrument_version_id: null });
    // A newer contract version supersedes the old one for later imports; its grid decides.
    const fine = await contract({ symbol: "EURUSD", tickSize: "0.00001", tickValue: "1", quantityStep: "0.001", minimumQuantity: "0.001" });
    expect((await ledger((await importOpen({ externalId: "GRID-FINE", volume: "0.015" })).tradeId)).instrument_version_id).toBe(fine);
    expect((await ledger((await importOpen({ externalId: "GRID-FINE-ON", volume: "0.25" })).tradeId)).instrument_version_id).toBe(fine);
  });

  it("links to a locked or live planned trade after re-validating it, without touching the plan", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const before = await ledger(plan.tradeId);
    const linked = await ingest(connection, openPosition({ externalId: "MOCK-LINK", enteredAt: plan.lockedAt, entryPrice: "1.10005" }), { kind: "LINK", tradeId: plan.tradeId });
    expect(linked).toMatchObject({ outcome: "LINKED", tradeId: plan.tradeId });
    await db.actor(OWNER);
    expect(await rows("select trade_id, action, method from public.trade_execution_links where external_execution_id = $1", [linked.executionId]))
      .toEqual([{ trade_id: plan.tradeId, action: "LINK", method: "AUTO_MATCH" }]);
    expect(await ledger(plan.tradeId)).toEqual(before);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(1);
    // A live planned trade can be linked as well.
    const live = await lockedTrade(a, { target: "1.10601" });
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [live.tradeId]);
    expect((await ledger(live.tradeId)).lifecycle).toBe("LIVE");
    expect((await ingest(connection, openPosition({ externalId: "MOCK-LINK-2", enteredAt: live.lockedAt }), { kind: "LINK", tradeId: live.tradeId })).outcome).toBe("LINKED");
  });

  it("refuses links that break the rules and stores nothing", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const b = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const otherAccount = await lockedTrade(b);
    const theirs = await lockedTrade(await db.bootstrapAccount(OTHER), {}, OTHER);
    const draftTrade = await draft(a, { target: "1.10601" });
    const closedPlan = await lockedTrade(a, { target: "1.10602" });
    await db.actor(OWNER);
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [closedPlan.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.101', clock_timestamp(), '0')", [closedPlan.tradeId]);
    // Recorded after both locks: Risk Engine 1.2 counts live-first trades toward the 2-trade daily limit (§6.3).
    const liveFirstTrade = await liveFirst(a);
    const entered = openPosition({ externalId: "MOCK-BAD", enteredAt: plan.lockedAt });
    const attempts: [string, ExternalPosition, RegExp][] = [
      [otherAccount.tradeId, entered, /^LINK_MISMATCH: The trade belongs to another trading account/],
      [theirs.tradeId, entered, /^TRADE_NOT_FOUND:/],
      [randomUUID(), entered, /^TRADE_NOT_FOUND:/],
      [plan.tradeId, openPosition({ externalId: "MOCK-BAD", enteredAt: ago(0), symbol: "GBPUSD" }), /^LINK_MISMATCH: The execution is for GBPUSD but the trade is for EURUSD/],
      [plan.tradeId, openPosition({ externalId: "MOCK-BAD", enteredAt: ago(0), direction: "SELL" }), /^LINK_MISMATCH: The execution is short but the trade is long/],
      [plan.tradeId, openPosition({ externalId: "MOCK-BAD", enteredAt: ago(240) }), /^LINK_MISMATCH: The execution was entered before the plan was locked/],
      [draftTrade, entered, /^LINK_NOT_ALLOWED: A draft trade/],
      [liveFirstTrade, entered, /^LINK_NOT_ALLOWED: Only planned trades/],
      [closedPlan.tradeId, entered, /^LINK_NOT_ALLOWED: A closed trade/],
    ];
    for (const [tradeId, payload, error] of attempts) {
      await expect(ingest(connection, payload, { kind: "LINK", tradeId }), String(error)).rejects.toThrow(error);
    }
    await db.actor(OWNER);
    expect(await count("select 1 from public.external_executions where connection_id = $1", [connection])).toBe(0);
    await ingest(connection, openPosition({ externalId: "MOCK-FIRST", enteredAt: plan.lockedAt }), { kind: "LINK", tradeId: plan.tradeId });
    await expect(ingest(connection, entered, { kind: "LINK", tradeId: plan.tradeId })).rejects.toThrow(/^TRADE_ALREADY_LINKED:/);
    await db.actor(OWNER);
    expect(await count("select 1 from public.external_executions where connection_id = $1", [connection])).toBe(1);
  });

  it("re-checks the user id against the connection owner", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    await expect(ingest(connection, position(), { kind: "CREATE" }, OTHER)).rejects.toThrow(/^CONNECTION_NOT_FOUND:/);
    await expect(ingest(randomUUID(), position())).rejects.toThrow(/^CONNECTION_NOT_FOUND:/);
    await trustedServer();
    await expect(db.query("select public.ingest_external_execution(null, $1, '{}'::jsonb, '{\"kind\":\"HOLD\"}'::jsonb)", [connection])).rejects.toThrow(/^INVALID_INPUT: user and connection/);
  });
});

describe("positions first seen open and later closed (§8.6)", () => {
  it("appends the platform close and closes the imported trade with the platform P&L", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const open = openPosition({ externalId: "MOCK-3001", enteredAt: ago(120) });
    const created = await ingest(connection, open);
    const tradeId = String(created.tradeId);
    expect((await ledger(tradeId)).lifecycle).toBe("LIVE");
    await db.actor(OWNER);
    const note = await value<string>("select public.add_journal_entry($1, 'NOTE', 'Holding for the target', '{}'::jsonb, $2) as value", [tradeId, randomUUID()]);

    const closed = closedLater(open);
    // The decision is irrelevant for a stored position.
    expect(await ingest(connection, closed, { kind: "HOLD" })).toEqual({ outcome: "CLOSED", executionId: created.executionId, tradeId });
    expect(await platformCloses(created.executionId)).toEqual([{
      exit_price: "1.10612", exited_at: new Date(String(closed.exitedAt)), commission: "-1.75", swap: "0", realized_pnl: "148.25", payload_hash: closed.payloadHash,
    }]);
    await db.actor(OWNER);
    // The first version is never overwritten.
    expect(await rows("select exit_price, exited_at, realized_pnl, payload_hash from public.external_executions where id = $1", [created.executionId]))
      .toEqual([{ exit_price: null, exited_at: null, realized_pnl: null, payload_hash: open.payloadHash }]);
    const row = await ledger(tradeId);
    expect(row).toMatchObject({
      origin: "IMPORTED", lifecycle: "CLOSED", exit_price: "1.10612", fees: "1.75", gross_pnl: "150", net_pnl: "148.25", pnl_source: "IMPORTED",
      realized_r: null, initial_risk: null, outcome: "WIN", calculation_version: "UNPLANNED_CLOSE_V1",
    });
    expect(Date.parse(String(row.exited_at))).toBe(Date.parse(String(closed.exitedAt)));
    // A note recorded after the platform exit but before the sync reads as After close; nothing is ever Before entry.
    const recorded = await value<string>("select recorded_at::text as value from public.trade_journal_entries where id = $1", [note]);
    expect(classifyTiming({ recordedAt: recorded, storedPhase: "LIVE", origin: "IMPORTED", entryAt: row.entered_at, exitAt: row.exited_at, tradeCreatedAt: row.created_at }).timing)
      .toBe("AFTER_CLOSE");
    expect(await warnings(connection)).toEqual([]);

    // Both versions are known now: receiving either again is a no-op.
    expect((await ingest(connection, closed)).outcome).toBe("UNCHANGED");
    expect((await ingest(connection, open)).outcome).toBe("UNCHANGED");
    // A later correction of the close is a warning; the recorded close stays.
    const corrected = closedLater(open, { exitedAt: closed.exitedAt, realizedPnl: "148.26" });
    expect(await ingest(connection, corrected)).toEqual({ outcome: "CHANGED", executionId: created.executionId, tradeId });
    expect(await warnings(connection)).toEqual([{
      message: "EURUSD long position MOCK-3001 changed on the platform after import; the recorded version was kept.", external_execution_id: created.executionId, payload_hash: corrected.payloadHash,
    }]);
    expect((await ledger(tradeId)).net_pnl).toBe("148.25");
    expect(await platformCloses(created.executionId)).toHaveLength(1);
    await db.actor(OWNER);
    expect(await rows(`select exit_price, realized_pnl, commission, payload_hash, close_received_at is not null as close_received, linked_trade_id,
        warning_count, last_warning_message from public.external_execution_status where id = $1`, [created.executionId])).toEqual([{
      exit_price: "1.10612", realized_pnl: "148.25", commission: "-1.75", payload_hash: closed.payloadHash, close_received: true, linked_trade_id: tradeId,
      warning_count: 1, last_warning_message: "EURUSD long position MOCK-3001 changed on the platform after import; the recorded version was kept.",
    }]);
  });

  it("derives realized R only from a risk basis the trader recorded", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const cases: [string, Json, Json][] = [
      // |1.10012 - 1.09812| = 200 ticks x $1 x 0.25 lots = $50 at risk: 148.25 / 50.
      ["MOCK-4001", { initialStop: "1.09812" }, { risk_basis: "50", risk_basis_source: "DERIVED", realized_r: "2.965" }],
      ["MOCK-4002", { riskAmount: "100" }, { risk_basis: "100", risk_basis_source: "USER_REPORTED", realized_r: "1.4825" }],
      ["MOCK-4003", { entryModel: "OTE" }, { risk_basis: null, risk_basis_source: null, realized_r: null }],
    ];
    for (const [externalId, details, expected] of cases) {
      const open = openPosition({ externalId, enteredAt: ago(120) });
      const created = await ingest(connection, open);
      await db.actor(OWNER);
      await db.query("select public.complete_live_entry($1, $2::jsonb, $3)", [created.tradeId, JSON.stringify(details), randomUUID()]);
      expect((await ingest(connection, closedLater(open))).outcome).toBe("CLOSED");
      await db.actor(OWNER);
      expect(await rows("select risk_basis::text, risk_basis_source, realized_r::text, pnl_source from public.trade_unplanned_closes where trade_id = $1", [created.tradeId]), externalId)
        .toEqual([{ ...expected, pnl_source: "IMPORTED" }]);
      expect((await ledger(String(created.tradeId))).realized_r).toBe(expected.realized_r);
    }
  });

  it("keeps a close recorded in Trading OS and warns only when the platform's close differs", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const exitedAt = ago(15);
    const same = openPosition({ externalId: "MOCK-5001", enteredAt: ago(120) });
    const sameTrade = String((await ingest(connection, same)).tradeId);
    await closeLiveTrade(sameTrade, { exitPrice: "1.10612", exitedAt, fees: "1.75" });
    expect(await ingest(connection, closedLater(same, { exitedAt }))).toMatchObject({ outcome: "CLOSED", tradeId: sameTrade });
    expect(await warnings(connection)).toEqual([]);

    const differs = openPosition({ externalId: "MOCK-5002", enteredAt: ago(120) });
    const differsTrade = await ingest(connection, differs);
    await closeLiveTrade(String(differsTrade.tradeId), { exitPrice: "1.10600", exitedAt, fees: "1.75" });
    const platform = closedLater(differs, { exitedAt });
    expect(await ingest(connection, platform)).toMatchObject({ outcome: "CLOSED", tradeId: differsTrade.tradeId });
    expect(await warnings(connection)).toEqual([{
      message: "EURUSD long position MOCK-5002 was closed on the platform with values that differ from the close recorded in Trading OS; the recorded close was kept.",
      external_execution_id: differsTrade.executionId, payload_hash: platform.payloadHash,
    }]);
    for (const [tradeId, net] of [[sameTrade, "148.25"], [String(differsTrade.tradeId), "145.25"]]) {
      expect(await ledger(tradeId)).toMatchObject({ lifecycle: "CLOSED", pnl_source: "CALCULATED", net_pnl: net });
    }
    expect(await platformCloses(differsTrade.executionId)).toHaveLength(1);
  });

  it("leaves the imported trade open when the platform close has no realized P&L", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const open = openPosition({ externalId: "MOCK-6001", enteredAt: ago(120) });
    const created = await ingest(connection, open);
    const closed = closedLater(open, { realizedPnl: null });
    expect(await ingest(connection, closed)).toMatchObject({ outcome: "CLOSED", tradeId: created.tradeId });
    expect(await platformCloses(created.executionId)).toMatchObject([{ exit_price: "1.10612", realized_pnl: null }]);
    expect((await ledger(String(created.tradeId))).lifecycle).toBe("LIVE");
    expect(await warnings(connection)).toEqual([{
      message: "EURUSD long position MOCK-6001 was closed on the platform without a realized P&L; record the close on the trade.",
      external_execution_id: created.executionId, payload_hash: closed.payloadHash,
    }]);
    expect((await ingest(connection, closed)).outcome).toBe("UNCHANGED");
    await closeLiveTrade(String(created.tradeId), { exitPrice: "1.10612", exitedAt: closed.exitedAt, fees: "1.75" });
    expect(await ledger(String(created.tradeId))).toMatchObject({ lifecycle: "CLOSED", pnl_source: "CALCULATED", net_pnl: "148.25" });
  });

  it("appends the close of a linked planned trade or a held execution without closing any trade", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const before = await ledger(plan.tradeId);
    const linkedOpen = openPosition({ externalId: "MOCK-7001", enteredAt: plan.lockedAt });
    const linked = await ingest(connection, linkedOpen, { kind: "LINK", tradeId: plan.tradeId });
    expect(await ingest(connection, closedLater(linkedOpen, { exitedAt: await dbNow() }))).toEqual({ outcome: "CLOSED", executionId: linked.executionId, tradeId: plan.tradeId });
    expect(await ledger(plan.tradeId)).toEqual(before);
    expect(await platformCloses(linked.executionId)).toHaveLength(1);

    const heldOpen = openPosition({ externalId: "MOCK-7002", enteredAt: ago(60) });
    const held = await ingest(connection, heldOpen, { kind: "HOLD" });
    expect(await ingest(connection, closedLater(heldOpen))).toEqual({ outcome: "CLOSED", executionId: held.executionId, tradeId: null });
    expect(await platformCloses(held.executionId)).toHaveLength(1);
    await db.actor(OWNER);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(1);
    expect(await count("select 1 from public.trade_unplanned_closes where account_id = $1", [a.accountId])).toBe(0);
    expect(await warnings(connection)).toEqual([]);
    expect(await overview(connection)).toMatchObject({ execution_count: 2, unmatched_count: 1 });
  });
});

describe("trader links (link_external_execution / unlink_external_execution)", () => {
  it("links a held execution, replays, unlinks append-only and links again", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const held = await ingest(connection, openPosition({ externalId: "MOCK-USER", enteredAt: plan.lockedAt }), { kind: "HOLD" });
    const linked = await link(plan.tradeId, held.executionId);
    expect(linked).toMatchObject({ tradeId: plan.tradeId, executionId: held.executionId, accountId: a.accountId, action: "LINK", method: "USER", replayed: false });
    expect(await link(plan.tradeId, held.executionId)).toMatchObject({ linkId: linked.linkId, replayed: true });
    expect(await executionStatus(held.executionId)).toMatchObject({ linked_trade_id: plan.tradeId, link_method: "USER" });
    const removed = await unlink(plan.tradeId, held.executionId);
    expect(removed).toMatchObject({ action: "UNLINK", method: "USER", replayed: false });
    expect(await unlink(plan.tradeId, held.executionId)).toMatchObject({ linkId: removed.linkId, action: "UNLINK", replayed: true });
    expect(await executionStatus(held.executionId)).toMatchObject({ linked_trade_id: null });
    expect(await overview(connection)).toMatchObject({ unmatched_count: 1 });
    expect((await link(plan.tradeId, held.executionId)).replayed).toBe(false);
    await db.actor(OWNER);
    expect(await rows("select action, method from public.trade_execution_links where external_execution_id = $1 order by id", [held.executionId]))
      .toEqual([{ action: "LINK", method: "USER" }, { action: "UNLINK", method: "USER" }, { action: "LINK", method: "USER" }]);
  });

  it("unlinks an automatic match on the trader's request", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const matched = await ingest(connection, openPosition({ externalId: "MOCK-AUTO", enteredAt: plan.lockedAt }), { kind: "LINK", tradeId: plan.tradeId });
    expect(await unlink(plan.tradeId, matched.executionId)).toMatchObject({ action: "UNLINK", method: "USER", replayed: false });
    expect(await executionStatus(matched.executionId)).toMatchObject({ linked_trade_id: null, link_method: null });
  });

  it("allows linking closed planned trades, and enforces one link per trade and per execution", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const closed = await lockedTrade(a);
    await db.actor(OWNER);
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [closed.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.101', clock_timestamp(), '0')", [closed.tradeId]);
    const second = await lockedTrade(a, { target: "1.10601" });
    const first = await ingest(connection, openPosition({ externalId: "MOCK-C1", enteredAt: second.lockedAt }), { kind: "HOLD" });
    const other = await ingest(connection, openPosition({ externalId: "MOCK-C2", enteredAt: second.lockedAt }), { kind: "HOLD" });
    expect((await link(closed.tradeId, first.executionId)).method).toBe("USER");
    await expect(link(closed.tradeId, other.executionId)).rejects.toThrow(/^TRADE_ALREADY_LINKED:/);
    await expect(link(second.tradeId, first.executionId)).rejects.toThrow(/^EXECUTION_ALREADY_LINKED:/);
    await expect(unlink(second.tradeId, first.executionId)).rejects.toThrow(/^LINK_NOT_FOUND:/);
    const imported = await ingest(connection, position({ externalId: "MOCK-C3", enteredAt: second.lockedAt, exitedAt: await dbNow() }));
    await expect(link(second.tradeId, imported.executionId)).rejects.toThrow(/^EXECUTION_ALREADY_LINKED:/);
    await expect(unlink(String(imported.tradeId), imported.executionId)).rejects.toThrow(/^LINK_NOT_REMOVABLE:/);
    await expect(link(String(imported.tradeId), other.executionId)).rejects.toThrow(/^LINK_NOT_ALLOWED: Only planned trades/);
    await expect(link(await liveFirst(a), other.executionId)).rejects.toThrow(/^LINK_NOT_ALLOWED: Only planned trades/);
    await expect(link(await draft(a, { target: "1.10602" }), other.executionId)).rejects.toThrow(/^LINK_NOT_ALLOWED: A draft trade/);
    // A position entered before the plan was locked cannot belong to it.
    await expect(link(second.tradeId, (await ingest(connection, openPosition({ externalId: "MOCK-C4", enteredAt: ago(240) }), { kind: "HOLD" })).executionId))
      .rejects.toThrow(/^LINK_MISMATCH: The execution was entered before the plan was locked/);
  });

  it("denies other users and keeps rows immutable, guarding direct writes too", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    const plan = await lockedTrade(a);
    const held = await ingest(connection, openPosition({ externalId: "MOCK-OWN", enteredAt: plan.lockedAt }), { kind: "HOLD" });
    const imported = await ingest(connection, position({ externalId: "MOCK-IMP" }));
    const closing = openPosition({ externalId: "MOCK-CLOSING", enteredAt: ago(30) });
    await ingest(connection, closing, { kind: "HOLD" });
    expect((await ingest(connection, closedLater(closing, { exitedAt: ago(1) }))).outcome).toBe("CLOSED");
    const liveFirstTrade = await liveFirst(a);
    await db.bootstrapAccount(OTHER);
    await expect(link(plan.tradeId, held.executionId, OTHER)).rejects.toThrow(/^TRADE_NOT_FOUND:/);
    await expect(unlink(plan.tradeId, held.executionId, OTHER)).rejects.toThrow(/^TRADE_NOT_FOUND:/);
    const theirs = await lockedTrade(await db.bootstrapAccount(OTHER), {}, OTHER);
    await expect(link(theirs.tradeId, held.executionId, OTHER)).rejects.toThrow(/^EXECUTION_NOT_FOUND:/);
    await expect(link(plan.tradeId, randomUUID())).rejects.toThrow(/^EXECUTION_NOT_FOUND:/);
    await db.actor(OTHER);
    for (const name of [...TABLES, ...VIEWS]) expect(await count(`select 1 from public.${name} where account_id = $1`, [a.accountId]), name).toBe(0);
    await db.anon();
    await expect(db.query("select public.link_external_execution($1, $2)", [plan.tradeId, held.executionId])).rejects.toThrow(/permission denied/);

    await db.actor(OWNER);
    await expect(db.query("insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method) values ($1, $2, $3, $4, 'LINK', 'USER')",
      [OWNER, a.accountId, plan.tradeId, held.executionId])).rejects.toThrow(/permission denied/);
    await db.admin();
    const insertLink = (tradeId: string, executionId: string, action: string, method: string) => db.query(
      "insert into public.trade_execution_links(user_id, account_id, trade_id, external_execution_id, action, method) values ($1, $2, $3, $4, $5, $6)",
      [OWNER, a.accountId, tradeId, executionId, action, method]);
    await expect(insertLink(plan.tradeId, imported.executionId, "LINK", "USER")).rejects.toThrow(/^EXECUTION_ALREADY_LINKED:/);
    await expect(insertLink(String(imported.tradeId), imported.executionId, "UNLINK", "USER")).rejects.toThrow(/^LINK_NOT_REMOVABLE:/);
    await expect(insertLink(liveFirstTrade, held.executionId, "LINK", "USER")).rejects.toThrow(/^LINK_NOT_ALLOWED:/);
    await expect(insertLink(plan.tradeId, held.executionId, "LINK", "IMPORT_CREATED")).rejects.toThrow(/^LINK_NOT_ALLOWED:/);
    await expect(insertLink(plan.tradeId, held.executionId, "UNLINK", "USER")).rejects.toThrow(/^LINK_NOT_FOUND:/);
    await link(plan.tradeId, held.executionId);
    await db.admin();
    await expect(insertLink(plan.tradeId, held.executionId, "UNLINK", "AUTO_MATCH")).rejects.toThrow(/trade_execution_links_unlink_by_user/);
    for (const table of TABLES) {
      expect(await count(`select 1 from public.${table} where account_id = $1`, [a.accountId]), table).toBeGreaterThan(0);
      await expect(db.query(`update public.${table} set user_id = user_id where account_id = $1`, [a.accountId]), table).rejects.toThrow(/Immutable/);
      await expect(db.query(`delete from public.${table} where account_id = $1`, [a.accountId]), table).rejects.toThrow(/Immutable/);
    }
  });
});

describe("sync status (record_platform_sync_status)", () => {
  it("records SYNCING, SYNCED and ERROR with a cursor that never moves backwards", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const connection = await connect(a);
    await syncStatus(connection, "SYNCING");
    expect(await overview(connection)).toMatchObject({ status: "SYNCING", synced_through: null, last_synced_at: null });
    await syncStatus(connection, "SYNCED", "  Sync complete: 3 imported, 0 linked, 0 awaiting your confirmation.  ", "2026-09-16T14:05:00Z");
    const synced = await overview(connection);
    expect(synced).toMatchObject({ status: "SYNCED", status_message: "Sync complete: 3 imported, 0 linked, 0 awaiting your confirmation." });
    expect((synced.synced_through as Date).toISOString()).toBe("2026-09-16T14:05:00.000Z");
    expect(synced.last_synced_at).toEqual(synced.status_at);
    await syncStatus(connection, "SYNCED", null, "2026-09-16T14:05:00Z");
    await expect(syncStatus(connection, "SYNCED", null, "2026-09-16T14:04:59.999999Z")).rejects.toThrow(/^INVALID_INPUT: syncedThrough cannot move backwards/);
    await expect(syncStatus(connection, "SYNCED", null, null)).rejects.toThrow(/^INVALID_INPUT: syncedThrough cannot move backwards/);
    await expect(syncStatus(connection, "SYNCED", null, new Date(Date.now() + 3_600_000).toISOString())).rejects.toThrow(/^INVALID_INPUT: syncedThrough must be a past instant/);
    await expect(syncStatus(connection, "SYNCED", null, "infinity")).rejects.toThrow(/^INVALID_INPUT: syncedThrough must be a past instant/);
    await expect(syncStatus(connection, "SYNCING", null, "2026-09-17T00:00:00Z")).rejects.toThrow(/^INVALID_INPUT: syncedThrough is recorded only with SYNCED/);
    await expect(syncStatus(connection, "ERROR")).rejects.toThrow(/^INVALID_INPUT: An error needs a message/);
    await expect(syncStatus(connection, "ERROR", "x".repeat(301))).rejects.toThrow(/^INVALID_INPUT: message/);
    await expect(syncStatus(connection, "CONNECTED")).rejects.toThrow(/^INVALID_INPUT: status/);
    await syncStatus(connection, "ERROR", "The platform did not return positions. Nothing was imported.");
    expect(await overview(connection)).toMatchObject({ status: "ERROR", status_message: "The platform did not return positions. Nothing was imported." });
    expect(((await overview(connection)).synced_through as Date).toISOString()).toBe("2026-09-16T14:05:00.000Z");
    // Warnings never change the connection state.
    await ingest(connection, position({ externalId: "MOCK-W", realizedPnl: null }));
    expect(await overview(connection)).toMatchObject({ status: "ERROR", warning_count: 1 });
  });
});
