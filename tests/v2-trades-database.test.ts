import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

type Json = Record<string, unknown>;
type LedgerRow = Record<string, unknown>;
interface Report { decision: "APPROVED" | "BLOCKED"; issues: { code: string; severity: string }[] }
interface DraftEnvelope { tradeId: string; proposalId: string; revision: number; evaluationId: string; result: Report }
interface CheckEnvelope { planId: string | null; evaluationId: string; result: Report; replayed: boolean; tradeId: string }
interface EntryEnvelope { executionId: string; oversize: boolean; plannedQuantity: string; actualQuantity: string }
interface LifecycleEnvelope { tradeId: string; eventId: string; event: string; lifecycle: string }
interface EvidenceEnvelope { id: string; tradeId: string; phase: string; stateAtCreation: string; replayed: boolean }

let db: TestDatabase;

const LEDGER_COLUMNS = [
  "id", "account_id", "origin", "created_at", "duplicated_from", "migrated_from", "currency",
  "revision_count", "latest_revision", "latest_proposal_id", "latest_revision_at", "latest_check_decision", "latest_check_at", "latest_check_evaluation_id",
  "plan_id", "locked_at", "plan_trading_day", "strategy_version_id", "strategy_version", "risk_plan_version_id", "risk_plan_version",
  "symbol", "instrument_version_id", "direction", "entry_model",
  "planned_entry", "planned_stop", "planned_target", "requested_risk_percent", "planned_rr", "planned_quantity", "planned_risk",
  "entry_price", "entered_at", "entry_time_known", "entry_recorded_at", "quantity", "initial_stop", "initial_risk", "actual_initial_risk", "oversize",
  "exit_price", "exited_at", "close_recorded_at", "fees", "gross_pnl", "net_pnl", "realized_r", "outcome", "calculation_version", "pnl_source",
  "disposition", "disposition_reason", "legacy_decision", "discarded_at",
  "lifecycle", "draft_check", "review_completed_at",
  "setup_grade", "liquidity_context", "mss_timeframe", "tags", "tag_source",
  "evidence_count", "cover_evidence_id", "cover_evidence_kind", "journal_count", "ai_review_count",
];

const USER_RPCS: Record<string, string[]> = {
  create_trading_account: ["uuid", "jsonb"],
  update_account_profile: ["uuid", "jsonb"],
  create_instrument_version: ["uuid", "jsonb"],
  record_account_values: ["uuid", "text", "text"],
  create_planned_trade: ["uuid", "jsonb", "uuid", "uuid", "uuid"],
  revise_trade_draft: ["uuid", "jsonb", "uuid", "integer", "uuid", "uuid"],
  duplicate_trade_draft: ["uuid", "uuid", "uuid", "uuid"],
  discard_trade_draft: ["uuid", "text", "uuid"],
  check_trade_risk: ["uuid"],
  lock_trade: ["uuid", "integer"],
  record_planned_entry: ["uuid", "text", "text", "timestamptz"],
  close_planned_trade: ["uuid", "text", "timestamptz", "text"],
  set_planned_disposition: ["uuid", "text", "text"],
  complete_trade_review: ["uuid", "uuid"],
  reopen_trade_review: ["uuid", "text", "uuid"],
  record_live_trade: ["uuid", "jsonb", "uuid"],
  complete_live_entry: ["uuid", "jsonb", "uuid"],
  close_live_trade: ["uuid", "jsonb"],
  add_journal_entry: ["uuid", "text", "text", "jsonb", "uuid"],
  remove_trade_evidence: ["uuid"],
  relabel_trade_evidence: ["uuid", "text", "text", "text"],
  set_trade_tags: ["uuid", "text", "text", "text", "text[]"],
  add_external_loss: ["uuid", "text", "text", "uuid"],
  remove_external_loss: ["uuid", "text"],
  create_risk_policy_version: ["uuid", "jsonb", "boolean", "text"],
  trading_os_schema: [],
};
const nullCall = (name: string, types: string[]) => `select public.${name}(${types.map((t) => `null::${t}`).join(", ")})`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sha = (seed: string) => seed.repeat(64).slice(0, 64);
// Distinct prices keep two plans of one account and day clear of the DUPLICATE rule.
const SECOND_PRICES = { entry: "1.2", stop: "1.198", target: "1.206" };
const THIRD_PRICES = { entry: "1.3", stop: "1.298", target: "1.306" };

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return value<number>(`select count(*)::int as value from (${sql}) x`, params);
}

const proposal = (a: BootstrappedAccount, changes: Json = {}) => ({
  ...previewProposal, instrumentId: a.instrumentId, narrative: "Synthetic V2 draft", contractConfirmed: true, news: "CLEAR", ...changes,
});

async function createDraft(a: BootstrappedAccount, changes: Json = {}, key: string = randomUUID()): Promise<DraftEnvelope> {
  await db.actor(OWNER);
  return value<DraftEnvelope>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, JSON.stringify(proposal(a, changes)), key, a.riskId, a.observationId]);
}
async function revise(a: BootstrappedAccount, tradeId: string, expected: number, changes: Json = {}, key: string = randomUUID()): Promise<DraftEnvelope> {
  await db.actor(OWNER);
  return value<DraftEnvelope>("select public.revise_trade_draft($1, $2::jsonb, $3, $4, $5, $6) as value",
    [tradeId, JSON.stringify(proposal(a, changes)), key, expected, a.riskId, a.observationId]);
}
async function lock(tradeId: string, revision = 1): Promise<CheckEnvelope> {
  await db.actor(OWNER);
  return value<CheckEnvelope>("select public.lock_trade($1, $2) as value", [tradeId, revision]);
}
async function lockedTrade(a: BootstrappedAccount, changes: Json = {}): Promise<{ tradeId: string; planId: string }> {
  const draft = await createDraft(a, changes);
  const locked = await lock(draft.tradeId);
  expect(locked.planId).toBeTruthy();
  return { tradeId: draft.tradeId, planId: String(locked.planId) };
}
async function enter(tradeId: string, quantity = "0.25", price = "1.1"): Promise<EntryEnvelope> {
  await db.actor(OWNER);
  return value<EntryEnvelope>("select public.record_planned_entry($1, $2, $3, clock_timestamp()) as value", [tradeId, price, quantity]);
}
async function closePlanned(tradeId: string, exit = "1.104", fees = "0"): Promise<Json> {
  await db.actor(OWNER);
  return value<Json>("select public.close_planned_trade($1, $2, clock_timestamp(), $3) as value", [tradeId, exit, fees]);
}
async function liveTrade(a: BootstrappedAccount, input: Json, key: string = randomUUID()): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify(input), key]);
}
async function closeLive(tradeId: string, input: Json): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.close_live_trade($1, $2::jsonb) as value", [tradeId, JSON.stringify(input)]);
}
async function journal(tradeId: string, kind: string, body: string | null, details: Json = {}, key: string = randomUUID()): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.add_journal_entry($1, $2, $3, $4::jsonb, $5) as value", [tradeId, kind, body, JSON.stringify(details), key]);
}
async function journalRow(id: string): Promise<{ phase: string; state_at_creation: string }> {
  await db.actor(OWNER);
  return (await db.query<{ phase: string; state_at_creation: string }>("select phase, state_at_creation from public.trade_journal_entries where id = $1", [id])).rows[0];
}
function evidenceRecord(tradeId: string, overrides: Json = {}): Json {
  return { id: randomUUID(), tradeId, label: "ENTRY", timeframe: "M5", originalFilename: "chart.png", mimeType: "image/png",
    byteSize: 2048, sha256: sha("a"), width: 1280, height: 720, captureMethod: "PASTE", ...overrides };
}
async function registerEvidence(record: Json, user = OWNER): Promise<EvidenceEnvelope> {
  await db.actor(OWNER, "service_role");
  return value<EvidenceEnvelope>("select public.register_trade_evidence($1, $2::jsonb) as value", [user, JSON.stringify(record)]);
}
async function ledger(tradeId: string): Promise<LedgerRow> {
  await db.actor(OWNER);
  return (await db.query<LedgerRow>("select * from public.trade_ledger where id = $1", [tradeId])).rows[0];
}
async function tradingAccount(input: Json = {}, key: string = randomUUID()): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.create_trading_account($1, $2::jsonb) as value", [key,
    JSON.stringify({ name: "FTMO 100K", currency: "USD", accountType: "EVALUATION", platform: "MT5", balance: "10000", equity: "10000", ...input })]);
}
// 0019 revokes record_setup_decision from authenticated (§10.4). The superuser role keeps the session subject, so
// auth.uid() still names the owner: this models a V1 decision recorded before that revoke.
async function legacyDecision(proposalId: string, decision: "TAKEN" | "SKIPPED", reason: string | null = null): Promise<void> {
  await db.actor(OWNER);
  await db.admin();
  await db.query("select public.record_setup_decision($1, $2, $3)", [proposalId, decision, reason]);
  await db.actor(OWNER);
}
// The V1 lock RPC, which stays granted (§10.4).
async function v1Lock(proposalId: string): Promise<CheckEnvelope> {
  await db.actor(OWNER);
  return value<CheckEnvelope>("select public.check_setup_risk($1, true) as value", [proposalId]);
}
// IMPORTED trades are created by the platform ingest (0017); this inserts what it records first: the trade and its
// IMPORT entry facts.
async function importedTrade(a: BootstrappedAccount, symbol: string, direction: "LONG" | "SHORT"): Promise<string> {
  const id = randomUUID();
  await db.admin();
  await db.query("insert into public.trades(id, user_id, account_id, origin) values ($1, $2, $3, 'IMPORTED')", [id, OWNER, a.accountId]);
  await db.query("insert into public.trade_position_facts(user_id, account_id, trade_id, symbol, direction, source) values ($1, $2, $3, $4, $5, 'IMPORT')",
    [OWNER, a.accountId, id, symbol, direction]);
  await db.actor(OWNER);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // Deterministic eligible session for lock scenarios; production RPCs keep clock_timestamp().
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

describe("strategy template and trading accounts", () => {
  it("extracts the ICT V1.0 template byte-for-byte from what bootstrap_demo_account inserts", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const v2 = await tradingAccount();
    await db.admin();
    const { rows } = await db.query<{ same_rules: boolean; same_text: boolean; same_json_text: boolean }>(
      `select s.rules = t.rules as same_rules, s.written_rules = t.written_rules as same_text, s.rules::text = t.rules::text as same_json_text
         from public.strategy_versions s cross join private.strategy_templates t where s.id = $1 and t.version = 'ICT V1.0'`, [a.strategyId]);
    expect(rows[0]).toEqual({ same_rules: true, same_text: true, same_json_text: true });
    const pair = await db.query<{ same: boolean }>(
      `select v1.rules = v2.rules and v1.written_rules = v2.written_rules and v1.version = v2.version as same
         from public.strategy_versions v1, public.strategy_versions v2 where v1.id = $1 and v2.account_id = $2`, [a.strategyId, v2]);
    expect(pair.rows[0].same).toBe(true);
    await expect(db.query("update private.strategy_templates set written_rules = 'x'")).rejects.toThrow(/Immutable/);
  });

  it("creates a multi-currency trading account atomically with profile, versions and audit event", async () => {
    const id = await tradingAccount({ name: "  Funded EUR  ", currency: "EUR", accountType: "FUNDED", platform: "CTRADER", broker: "IC Markets", balance: "25000.50", equity: "25100" });
    const row = (await db.query<{ currency: string; name: string; mode: string }>("select currency, name, mode from public.accounts where id = $1", [id])).rows[0];
    expect(row).toEqual({ currency: "EUR", name: "Funded EUR", mode: "DEMO" });
    const profile = (await db.query<Json>("select display_name, broker, platform, account_type, starting_balance::text, status, source from public.account_profiles where account_id = $1", [id])).rows;
    expect(profile).toEqual([{ display_name: "Funded EUR", broker: "IC Markets", platform: "CTRADER", account_type: "FUNDED", starting_balance: "25000.50", status: "ACTIVE", source: "USER" }]);
    expect(await count("select 1 from public.instrument_versions where account_id = $1", [id])).toBe(0);
    await db.admin();
    expect((await db.query<Json>("select version, max_risk_percent::text as max, default_risk_percent::text as def, max_daily_trades, min_rr::text as rr, rr_policy, news_policy, daily_risk_cap, daily_loss_cap, effective_day = private.strategy_day(clock_timestamp()) as today from public.risk_plan_versions where account_id = $1", [id])).rows)
      .toEqual([{ version: "Risk Plan V1.0", max: "0.50000000", def: "0.50000000", max_daily_trades: 2, rr: "3.00000000", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: null, today: true }]);
    expect((await db.query<Json>("select equity::text, balance::text, gross_loss_today from public.account_observations where account_id = $1", [id])).rows)
      .toEqual([{ equity: "25100.00", balance: "25000.50", gross_loss_today: null }]);
    expect((await db.query<{ payload: Json }>("select payload from public.configuration_events where account_id = $1 and event_type = 'ACCOUNT_INITIALIZED'", [id])).rows[0].payload)
      .toEqual({ strategy: "ICT V1.0", risk_plan: "Risk Plan V1.0", currency: "EUR", account_type: "FUNDED", platform: "CTRADER" });
  });

  it("seeds the V1 USD instruments, replays a request key and rejects conflicting reuse", async () => {
    const key = randomUUID();
    const id = await tradingAccount({ startingBalance: "9000" }, key);
    expect(await tradingAccount({ startingBalance: "9000.00" }, key)).toBe(id);
    await expect(tradingAccount({ name: "Other name", startingBalance: "9000" }, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    await expect(db.query("select public.bootstrap_demo_account($1, 'FTMO 100K', '10000', '10000')", [key])).rejects.toThrow(/different input/);
    for (const table of ["accounts", "account_profiles", "strategy_versions", "risk_plan_versions", "account_observations", "bootstrap_requests"]) {
      expect(await count(`select 1 from public.${table} where ${table === "accounts" ? "id" : "account_id"} = $1`, [id]), table).toBe(1);
    }
    const instruments = (await db.query<Json>("select symbol, currency, quantity_unit, tick_size::text, pip_size::text, tick_value::text, quantity_step::text, minimum_quantity::text, source from public.instrument_versions where account_id = $1 order by symbol", [id])).rows;
    expect(instruments).toEqual(["EURUSD", "GBPUSD"].map((symbol) => ({ symbol, currency: "USD", quantity_unit: `lots (100,000 ${symbol.slice(0, 3)})`, tick_size: "0.00001000", pip_size: "0.00010000", tick_value: "1.00000000", quantity_step: "0.01000000", minimum_quantity: "0.01000000", source: "STANDARD_CONTRACT_REQUIRES_CONFIRMATION" })));
    expect((await db.query<{ starting: string }>("select starting_balance::text as starting from public.account_profiles where account_id = $1", [id])).rows[0].starting).toBe("9000.00");
    expect((await db.query<{ starting: string }>("select starting_balance::text as starting from public.account_profiles where account_id = $1", [await tradingAccount()])).rows[0].starting).toBe("10000.00");
  });

  it.each([
    [{ currency: "BTC" }, /currency/], [{ accountType: "LIVE" }, /accountType/], [{ platform: "NINJA" }, /platform/],
    [{ name: "   " }, /name/], [{ balance: "10.001" }, /balance/], [{ equity: "0" }, /equity/], [{ extra: true }, /unknown field "extra"/],
    [{ balance: 10000 }, /balance must be a string/], [{ startingBalance: "-1" }, /startingBalance/],
  ])("validates trading-account input %#", async (input, message) => {
    await expect(tradingAccount(input)).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(tradingAccount(input)).rejects.toThrow(message);
  });

  it("appends profile revisions, copies missing keys and is a no-op when unchanged", async () => {
    const id = await tradingAccount({ broker: "Broker A" });
    const update = (input: Json) => value<number>("select public.update_account_profile($1, $2::jsonb) as value", [id, JSON.stringify(input)]);
    const first = (await db.query<{ id: number }>("select id from public.account_profiles where account_id = $1", [id])).rows[0].id;
    expect(await update({ displayName: "FTMO 100K" })).toBe(first);
    const archived = await update({ status: "ARCHIVED", broker: null });
    expect(archived).toBeGreaterThan(first);
    expect((await db.query<Json>("select display_name, broker, platform, account_type, status from public.account_profiles where id = $1", [archived])).rows[0])
      .toEqual({ display_name: "FTMO 100K", broker: null, platform: "MT5", account_type: "EVALUATION", status: "ARCHIVED" });
    expect(await update({ status: "ARCHIVED" })).toBe(archived);
    await expect(update({ status: "DELETED" })).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(update({ displayName: null })).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(update({ currency: "EUR" })).rejects.toThrow(/unknown field "currency"/);
    const legacy = await db.bootstrapAccount(OWNER, { name: "Legacy demo", balance: "5000", equity: "5100" });
    expect(await count("select 1 from public.account_profiles where account_id = $1", [legacy.accountId])).toBe(0);
    const created = await value<number>("select public.update_account_profile($1, $2::jsonb) as value", [legacy.accountId, JSON.stringify({ broker: "Demo broker" })]);
    expect((await db.query<Json>("select display_name, broker, platform, account_type, starting_balance::text, status, source from public.account_profiles where id = $1", [created])).rows[0])
      .toEqual({ display_name: "Legacy demo", broker: "Demo broker", platform: "MANUAL", account_type: "DEMO", starting_balance: "5000.00", status: "ACTIVE", source: "USER" });
  });

  it("creates instrument versions in the account currency and records account values", async () => {
    const eur = await tradingAccount({ currency: "EUR" });
    const instrument = await value<string>("select public.create_instrument_version($1, $2::jsonb) as value", [eur, JSON.stringify({ symbol: "DE40", quantityUnit: "contracts", tickSize: "0.5", tickValue: "0.5", quantityStep: "0.1", minimumQuantity: "0.1" })]);
    expect((await db.query<Json>("select symbol, currency, source, pip_size, tick_size::text from public.instrument_versions where id = $1", [instrument])).rows[0])
      .toEqual({ symbol: "DE40", currency: "EUR", source: "USER_DEFINED", pip_size: null, tick_size: "0.50000000" });
    expect(await count("select 1 from public.configuration_events where account_id = $1 and event_type = 'INSTRUMENT_VERSION_CREATED'", [eur])).toBe(1);
    for (const input of [{ symbol: "de40" }, { symbol: "DE40", quantityUnit: "" }, { symbol: "DE40", quantityUnit: "contracts", tickSize: "0" }, { symbol: "DE40", quantityUnit: "contracts", tickSize: "0.5", tickValue: "0.5", quantityStep: "0.1" }]) {
      await expect(db.query("select public.create_instrument_version($1, $2::jsonb)", [eur, JSON.stringify(input)])).rejects.toThrow(/^INVALID_INPUT:/);
    }
    const ids = (await db.query<{ observation: string; risk: string }>("select (select id from public.account_observations where account_id = $1) as observation, (select id from public.risk_plan_versions where account_id = $1) as risk", [eur])).rows[0];
    const draft = await value<DraftEnvelope>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [eur,
      JSON.stringify({ ...previewProposal, instrumentId: instrument, entry: "18000", stop: "17950", target: "18150", narrative: "EUR index plan", contractConfirmed: true, news: "CLEAR" }), randomUUID(), ids.risk, ids.observation]);
    expect(draft.result.decision).toBe("APPROVED");
    const observation = await value<string>("select public.record_account_values($1, '24000.10', '23950') as value", [eur]);
    expect((await db.query<Json>("select balance::text, equity::text, gross_loss_today from public.account_observations where id = $1", [observation])).rows[0])
      .toEqual({ balance: "24000.10", equity: "23950.00", gross_loss_today: null });
    await expect(db.query("select public.record_account_values($1, '1.001', '1')", [eur])).rejects.toThrow(/^INVALID_INPUT:/);
  });
});

describe("planned trades", () => {
  it("creates a draft with a persisted free check, replays the key and rejects conflicts", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const draft = await createDraft(a, {}, key);
    expect(draft).toMatchObject({ revision: 1, result: { decision: "APPROVED" } });
    expect(Object.keys(draft).sort()).toEqual(["evaluationId", "proposalId", "result", "revision", "tradeId"]);
    expect(await createDraft(a, {}, key)).toEqual(draft);
    await expect(createDraft(a, { narrative: "Hindsight" }, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    const other = await db.bootstrapAccount(OWNER);
    await expect(createDraft(other, {}, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect((await db.query<Json>("select origin, request_key, migrated_from, duplicated_from from public.trades where id = $1", [draft.tradeId])).rows[0])
      .toEqual({ origin: "PLANNED", request_key: key, migrated_from: null, duplicated_from: null });
    expect((await db.query<Json>("select proposal_id, revision from public.trade_revisions where trade_id = $1", [draft.tradeId])).rows).toEqual([{ proposal_id: draft.proposalId, revision: 1 }]);
    expect(await count("select 1 from public.setup_risk_checks where proposal_id = $1", [draft.proposalId])).toBe(1);
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(0);
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "DRAFT", draft_check: "APPROVED", latest_revision: 1, revision_count: 1, plan_id: null });
  });

  it("maps stale context, foreign instruments and malformed proposals to stable errors", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const b = await db.bootstrapAccount(OWNER);
    await db.query("select public.record_account_values($1, '9990', '9990')", [a.accountId]);
    await expect(createDraft(a)).rejects.toThrow(/^CONTEXT_CHANGED: Account or risk plan changed/);
    await expect(createDraft(b, { instrumentId: a.instrumentId })).rejects.toThrow(/^INVALID_INPUT: instrumentId/);
    await expect(createDraft(b, { instrumentId: "EURUSD" })).rejects.toThrow(/^INVALID_INPUT: instrumentId/);
    await expect(createDraft(b, { entry: 1.1 })).rejects.toThrow(/^INVALID_INPUT: Invalid proposal/);
    await expect(createDraft(b, { extra: "key" })).rejects.toThrow(/^INVALID_INPUT: Invalid proposal/);
    expect(await count("select 1 from public.trades where account_id in ($1, $2)", [a.accountId, b.accountId])).toBe(0);
  });

  it("saves a blocked draft and never locks it", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a, { riskPercent: "2" });
    expect(draft.result.decision).toBe("BLOCKED");
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "DRAFT", draft_check: "BLOCKED", latest_check_decision: "BLOCKED" });
    const attempt = await lock(draft.tradeId);
    expect(attempt).toMatchObject({ planId: null, tradeId: draft.tradeId, result: { decision: "BLOCKED" } });
    expect(attempt.result.issues.map((i) => i.code)).toContain("RISK_LIMIT");
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "DRAFT", draft_check: "BLOCKED", plan_id: null, latest_check_evaluation_id: attempt.evaluationId });
    expect(await count("select 1 from public.trade_plan_links where trade_id = $1", [draft.tradeId])).toBe(0);
  });

  it("appends revisions, replays them by key and reports DRAFT_CHANGED for stale editors", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a, { riskPercent: "2" });
    const key = randomUUID();
    const second = await revise(a, draft.tradeId, 1, { riskPercent: "0.5", narrative: "Reduced risk" }, key);
    expect(second).toMatchObject({ tradeId: draft.tradeId, revision: 2, result: { decision: "APPROVED" } });
    expect(await revise(a, draft.tradeId, 1, { riskPercent: "0.5", narrative: "Reduced risk" }, key)).toEqual(second);
    await expect(revise(a, draft.tradeId, 2, { narrative: "Different" }, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    await expect(revise(a, draft.tradeId, 1, { narrative: "Stale tab" })).rejects.toThrow(/^DRAFT_CHANGED:/);
    // Two tabs that loaded revision 2: the first save wins and the second is stale. PGlite runs one statement at a
    // time, so this is the sequential form only; the trade row lock that serializes truly concurrent saves needs
    // two sessions on PostgreSQL.
    expect(await revise(a, draft.tradeId, 2, { narrative: "Tab A" })).toMatchObject({ revision: 3 });
    await expect(revise(a, draft.tradeId, 2, { narrative: "Tab B" })).rejects.toThrow(/^DRAFT_CHANGED:/);
    expect(await ledger(draft.tradeId)).toMatchObject({ revision_count: 3, latest_revision: 3, draft_check: "APPROVED" });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.setup_proposals p join public.trade_revisions r on r.proposal_id = p.id where r.trade_id = $1", [draft.tradeId])).rows[0].n).toBe(3);
  });

  it("locks only the latest approved revision and replays the lock", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a, { riskPercent: "2" });
    const latest = await revise(a, draft.tradeId, 1, { riskPercent: "0.5" });
    await expect(lock(draft.tradeId, 1)).rejects.toThrow(/^DRAFT_CHANGED:/);
    const locked = await lock(draft.tradeId, 2);
    expect(locked).toMatchObject({ tradeId: draft.tradeId, replayed: false, result: { decision: "APPROVED" } });
    expect((await db.query<{ proposal_id: string }>("select proposal_id from public.setup_locks where plan_id = $1", [locked.planId])).rows[0].proposal_id).toBe(latest.proposalId);
    const replay = await lock(draft.tradeId, 2);
    expect(replay).toMatchObject({ planId: locked.planId, replayed: true, tradeId: draft.tradeId });
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(1);
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "LOCKED", plan_id: locked.planId, draft_check: null, risk_plan_version_id: a.riskId, strategy_version: "ICT V1.0" });
    await expect(revise(a, draft.tradeId, 2)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    await expect(db.query("select public.check_trade_risk($1)", [draft.tradeId])).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
  });

  it("lets the V1 lock RPC lock only the latest revision of a draft, and links the plan (§10.4)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const latest = await revise(a, draft.tradeId, 1, { narrative: "Revised thesis" });
    await expect(v1Lock(draft.proposalId)).rejects.toThrow(/^DRAFT_CHANGED:/);
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(0);
    const locked = await v1Lock(latest.proposalId);
    expect(locked).toMatchObject({ planId: expect.any(String), replayed: false, result: { decision: "APPROVED" } });
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "LOCKED", plan_id: locked.planId, latest_proposal_id: latest.proposalId, draft_check: null });
    expect(await v1Lock(latest.proposalId)).toMatchObject({ planId: locked.planId, replayed: true });
    expect(await lock(draft.tradeId, 2)).toMatchObject({ planId: locked.planId, replayed: true, tradeId: draft.tradeId });
    await expect(v1Lock(draft.proposalId)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(1);
    expect(await count("select 1 from public.trade_plan_links where trade_id = $1", [draft.tradeId])).toBe(1);
    // A free recheck (no lock) of any revision keeps the V1 behaviour and reserves nothing.
    expect(await value<CheckEnvelope>("select public.check_setup_risk($1, false) as value", [draft.proposalId])).toMatchObject({ planId: null });
  });

  it("refuses V1 locks of discarded and skipped drafts", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const discarded = await createDraft(a);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    const skipped = await createDraft(a, SECOND_PRICES);
    await legacyDecision(skipped.proposalId, "SKIPPED", "Not my setup");
    for (const proposalId of [discarded.proposalId, skipped.proposalId]) {
      await expect(v1Lock(proposalId)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    }
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(0);
    expect(await ledger(discarded.tradeId)).toMatchObject({ lifecycle: "DISCARDED", plan_id: null });
    expect(await ledger(skipped.tradeId)).toMatchObject({ lifecycle: "SKIPPED", plan_id: null });
  });

  it("records notes and evidence after a fill entered through the V1 RPCs as live", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const { planId } = await v1Lock(draft.proposalId);
    await db.query("select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [planId]);
    const note = await journal(draft.tradeId, "NOTE", "Written after the fill");
    expect(await journalRow(note)).toEqual({ phase: "LIVE", state_at_creation: "LIVE" });
    expect(await registerEvidence(evidenceRecord(draft.tradeId))).toMatchObject({ phase: "LIVE", stateAtCreation: "LIVE" });
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "LIVE", plan_id: planId, entry_time_known: true, quantity: "0.25" });
  });

  it("wraps a V1 lock of a proposal outside the trade model into exactly one PLANNED trade", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const proposalId = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a)), randomUUID(), a.riskId, a.observationId]);
    const locked = await v1Lock(proposalId);
    expect(locked).toMatchObject({ planId: expect.any(String), replayed: false });
    expect(await v1Lock(proposalId)).toMatchObject({ planId: locked.planId, replayed: true });
    // No hidden plans: the plan is linked to one new trade whose revision 1 is the locked proposal.
    expect(await count("select 1 from public.trade_plan_links where plan_id = $1", [locked.planId])).toBe(1);
    expect(await count("select 1 from public.trade_revisions where proposal_id = $1 and revision = 1", [proposalId])).toBe(1);
    const tradeId = await value<string>("select trade_id as value from public.trade_plan_links where plan_id = $1", [locked.planId]);
    expect(await ledger(tradeId)).toMatchObject({ origin: "PLANNED", lifecycle: "LOCKED", plan_id: locked.planId, latest_proposal_id: proposalId });
    const created = await value<string>("select created_at::text as value from public.trades where id = $1", [tradeId]);
    const proposed = await value<string>("select created_at::text as value from public.setup_proposals where id = $1", [proposalId]);
    expect(created).toBe(proposed);
  });

  it("does not wrap a blocked V1 check of a proposal outside the trade model", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const proposalId = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a, { riskPercent: "2" })), randomUUID(), a.riskId, a.observationId]);
    expect(await v1Lock(proposalId)).toMatchObject({ planId: null });
    expect(await count("select 1 from public.trade_revisions where proposal_id = $1", [proposalId])).toBe(0);
  });

  it("refuses a NULL p_lock on the V1 entry point before anything is written (PostgREST sends JSON null as SQL NULL)", async () => {
    // With NULL every trade-aware branch of check_setup_risk was skipped while the engine still locked: a stale
    // revision, a discarded draft or a proposal outside the trade model became a plan without a trade.
    const a = await db.bootstrapAccount(OWNER);
    const stale = await createDraft(a);
    await revise(a, stale.tradeId, 1, { narrative: "Revised thesis" });
    const discarded = await createDraft(a, SECOND_PRICES);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    await db.actor(OWNER);
    const standalone = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a, THIRD_PRICES)), randomUUID(), a.riskId, a.observationId]);
    const written = async () => ({
      plans: await count("select 1 from public.trade_plans where account_id = $1", [a.accountId]),
      locks: await count("select 1 from public.setup_locks where account_id = $1", [a.accountId]),
      evaluations: await count("select 1 from public.risk_evaluations where account_id = $1", [a.accountId]),
      trades: await count("select 1 from public.trades where account_id = $1", [a.accountId]),
    });
    const before = await written();
    for (const proposalId of [stale.proposalId, discarded.proposalId, standalone]) {
      await db.actor(OWNER);
      await expect(db.query("select public.check_setup_risk($1, null)", [proposalId]), proposalId).rejects.toThrow(/^INVALID_INPUT: p_lock must be true or false/);
    }
    expect(await written()).toEqual(before);
    expect(before.plans).toBe(0);
    expect(await ledger(stale.tradeId)).toMatchObject({ lifecycle: "DRAFT", plan_id: null, latest_revision: 2 });
    // The engine refuses NULL as well, whoever calls it (only the database's own functions can).
    await db.admin();
    await expect(db.query("select private.check_proposal_risk($1, null)", [standalone])).rejects.toThrow(/^INVALID_INPUT: p_lock must be true or false/);
    await expect(db.query("select private.assess_plan($1, $2::jsonb, $3, $4, $5, null)",
      [a.accountId, JSON.stringify(proposal(a, THIRD_PRICES)), standalone, a.riskId, a.observationId])).rejects.toThrow(/^INVALID_INPUT: p_lock must be true or false/);
    expect(await written()).toEqual(before);
  });

  it("never lets an API request leave a plan without its trade (§2.1 in the database)", async () => {
    // A V1 path that locks outside the trade model, reopened here on purpose: the deferred check at commit rolls back
    // the plan, its reservation and its PLAN_LOCKED event.
    const a = await db.bootstrapAccount(OWNER);
    const plans = () => count("select 1 from public.trade_plans where account_id = $1", [a.accountId]);
    const lockV1 = (key: string) => db.query("select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5)",
      [a.accountId, JSON.stringify(proposal(a)), key, a.riskId, a.observationId]);
    await db.admin();
    await db.exec("grant execute on function public.lock_trade_plan(uuid, jsonb, uuid, uuid, uuid) to authenticated");
    try {
      await db.actor(OWNER);
      await expect(lockV1(randomUUID())).rejects.toThrow(/^PLAN_WITHOUT_TRADE: Every plan belongs to exactly one trade/);
      expect(await plans()).toBe(0);
      await db.admin();
      expect(await count("select 1 from public.trade_events where account_id = $1 and event_type = 'PLAN_LOCKED'", [a.accountId])).toBe(0);
    } finally {
      await db.admin();
      await db.exec("revoke execute on function public.lock_trade_plan(uuid, jsonb, uuid, uuid, uuid) from authenticated");
    }
    // Every V2 path links in the same transaction: lock_trade, the V1 lock of a draft and the wrap of a proposal (on a
    // second account: Risk Plan V1.0 allows two trades a day).
    const draft = await createDraft(a);
    expect((await lock(draft.tradeId)).planId).toBeTruthy();
    const viaV1 = await createDraft(a, SECOND_PRICES);
    expect((await v1Lock(viaV1.proposalId)).planId).toBeTruthy();
    expect(await plans()).toBe(2);
    const b = await db.bootstrapAccount(OWNER);
    const standalone = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [b.accountId, JSON.stringify(proposal(b)), randomUUID(), b.riskId, b.observationId]);
    expect((await v1Lock(standalone)).planId).toBeTruthy();
    expect(await count("select 1 from public.trade_plans p where p.account_id in ($1, $2) and not exists (select 1 from public.trade_plan_links l where l.plan_id = p.id)",
      [a.accountId, b.accountId])).toBe(0);
    // A session without an API role (migrations, operators, the synthetic history seed) is not checked: the V1 history
    // it holds was linked by the 0015 backfill, never by an API request. The superuser keeps the session subject.
    await db.actor(OWNER);
    await db.admin();
    const { planId: unlinked } = (await db.query<{ value: { planId: string } }>("select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5) as value",
      [b.accountId, JSON.stringify(proposal(b, SECOND_PRICES)), randomUUID(), b.riskId, b.observationId])).rows[0].value;
    expect(await count("select 1 from public.trade_plan_links where plan_id = $1", [unlinked])).toBe(0);
  });

  it("checks the latest revision on demand without reserving a slot", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const check = await value<CheckEnvelope>("select public.check_trade_risk($1) as value", [draft.tradeId]);
    expect(check).toMatchObject({ planId: null, tradeId: draft.tradeId, replayed: false, result: { decision: "APPROVED" } });
    expect(check.evaluationId).not.toBe(draft.evaluationId);
    expect(await ledger(draft.tradeId)).toMatchObject({ latest_check_evaluation_id: check.evaluationId, draft_check: "APPROVED" });
    expect(await count("select 1 from public.trade_plans where account_id = $1", [a.accountId])).toBe(0);
  });

  it("duplicates a trade as a new draft with news reset and replays the key", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await lockedTrade(a, { news: "CLEAR", narrative: "Original thesis" });
    const key = randomUUID();
    const duplicate = () => value<{ tradeId: string; proposalId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [source.tradeId, key, a.riskId, a.observationId]);
    const copy = await duplicate();
    expect(await duplicate()).toEqual(copy);
    expect((await db.query<{ proposal: Json }>("select proposal from public.setup_proposals where id = $1", [copy.proposalId])).rows[0].proposal)
      .toEqual(proposal(a, { news: "UNKNOWN", narrative: "Original thesis" }));
    expect(await ledger(copy.tradeId)).toMatchObject({ lifecycle: "DRAFT", duplicated_from: source.tradeId, latest_revision: 1, origin: "PLANNED" });
    await expect(db.query("select public.duplicate_trade_draft($1, $2, $3, $4)", [(await createDraft(a)).tradeId, key, a.riskId, a.observationId])).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    const live = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" });
    await expect(db.query("select public.duplicate_trade_draft($1, $2, $3, $4)", [live, randomUUID(), a.riskId, a.observationId])).rejects.toThrow(/^NO_PLAN_TO_DUPLICATE:/);
  });

  it("duplicates onto the account's current contract and asks to confirm it again when the source's was replaced", async () => {
    // Edit Draft and the pickers move a superseded contract to the newest version of the symbol (created_at desc,
    // id desc) and clear the confirmation: a duplicate is a new plan and must never be sized with replaced values.
    const a = await db.bootstrapAccount(OWNER);
    const source = await lockedTrade(a, { narrative: "Sized on the old contract" });
    expect(await value<string>("select risk_result #>> '{calculations,quantity}' as value from public.trade_plans where id = $1", [source.planId])).toBe("0.25");
    await db.actor(OWNER);
    const current = await value<string>("select public.create_instrument_version($1, $2::jsonb) as value", [a.accountId, JSON.stringify({
      symbol: "EURUSD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "2", quantityStep: "0.01", minimumQuantity: "0.01" })]);
    const copy = await value<{ tradeId: string; proposalId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value",
      [source.tradeId, randomUUID(), a.riskId, a.observationId]);
    const saved = (await db.query<{ proposal: Json; instrument: string; result: Report }>(`select s.proposal, s.instrument_version_id as instrument, e.result
        from public.setup_proposals s join public.risk_evaluations e on e.id = s.risk_evaluation_id where s.id = $1`, [copy.proposalId])).rows[0];
    expect(saved.proposal).toEqual(proposal(a, { instrumentId: current, contractConfirmed: false, news: "UNKNOWN", narrative: "Sized on the old contract" }));
    expect(saved.instrument).toBe(current);
    expect(saved.result.decision).toBe("BLOCKED");
    expect(saved.result.issues.map((issue) => issue.code)).toContain("CONTRACT_UNCONFIRMED");
    expect(await lock(copy.tradeId)).toMatchObject({ planId: null });
    // Confirmed again, the copy locks with the current contract: half the size for the same 0.5% risk.
    await revise(a, copy.tradeId, 1, { instrumentId: current, news: "CLEAR", narrative: "Sized on the old contract" });
    const relocked = await lock(copy.tradeId, 2);
    expect(relocked.planId).toBeTruthy();
    expect(await value<Json>("select jsonb_build_object('instrument', instrument_version_id, 'quantity', risk_result #>> '{calculations,quantity}') as value from public.trade_plans where id = $1",
      [relocked.planId])).toEqual({ instrument: current, quantity: "0.12" });
    // A source written on the current contract keeps it and its confirmation.
    const fresh = await createDraft(a, { instrumentId: current, ...THIRD_PRICES });
    const again = await value<{ proposalId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value",
      [fresh.tradeId, randomUUID(), a.riskId, a.observationId]);
    expect(await value<Json>("select proposal as value from public.setup_proposals where id = $1", [again.proposalId]))
      .toEqual(proposal(a, { instrumentId: current, ...THIRD_PRICES, news: "UNKNOWN" }));
  });

  it("discards drafts idempotently and refuses to discard anything else", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const key = randomUUID();
    const discard = (tradeId: string, reason: string | null, requestKey: string | null) =>
      value<LifecycleEnvelope>("select public.discard_trade_draft($1, $2, $3) as value", [tradeId, reason, requestKey]);
    const first = await discard(draft.tradeId, " Setup invalidated ", key);
    expect(first).toMatchObject({ tradeId: draft.tradeId, event: "DRAFT_DISCARDED", lifecycle: "DISCARDED" });
    expect(await discard(draft.tradeId, "Setup invalidated", key)).toEqual(first);
    expect(await discard(draft.tradeId, null, null)).toEqual(first);
    await expect(discard(draft.tradeId, "Another reason", key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect(await count("select 1 from public.trade_lifecycle_events where trade_id = $1", [draft.tradeId])).toBe(1);
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "DISCARDED", draft_check: null });
    await expect(revise(a, draft.tradeId, 1)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    await expect(lock(draft.tradeId, 1)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    const locked = await lockedTrade(a);
    await expect(discard(locked.tradeId, null, randomUUID())).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
  });

  it("records the entry through the plan, flags oversize and replays exact fills", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await expect(enter(draft.tradeId)).rejects.toThrow(/^PLAN_REQUIRED:/);
    await lock(draft.tradeId);
    const entry = await enter(draft.tradeId, "0.5");
    expect(entry).toMatchObject({ oversize: true, plannedQuantity: "0.25", actualQuantity: "0.5" });
    const replay = await value<EntryEnvelope>("select public.record_planned_entry($1, '1.1', '0.50', e.entered_at) as value from public.trade_executions e where e.id = $2", [draft.tradeId, entry.executionId]);
    expect(replay).toEqual(entry);
    await expect(enter(draft.tradeId, "0.25")).rejects.toThrow(/^ENTRY_ALREADY_RECORDED:/);
    expect(await ledger(draft.tradeId)).toMatchObject({ lifecycle: "LIVE", oversize: true, quantity: "0.5", planned_quantity: "0.25", initial_risk: "50", actual_initial_risk: "100", entry_time_known: true });
    const other = await lockedTrade(await db.bootstrapAccount(OWNER));
    await expect(enter(other.tradeId, "0.25", "1.100000001")).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(enter(other.tradeId, "0.25", "1.100001")).rejects.toThrow(/^OFF_INCREMENT:/);
    await expect(enter(other.tradeId, "0.25", "1.097")).rejects.toThrow(/^ENTRY_BEYOND_STOP:/);
    expect((await enter(other.tradeId)).oversize).toBe(false);
  });

  it("closes through FULL_CLOSE_V1 and replays exact closes only", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId } = await lockedTrade(a);
    await expect(closePlanned(tradeId)).rejects.toThrow(/^ENTRY_REQUIRED:/);
    await enter(tradeId);
    const closed = await closePlanned(tradeId);
    expect(closed).toMatchObject({ tradeId, outcome: "WIN", netPnl: "100", realizedR: "2", calculationVersion: "FULL_CLOSE_V1" });
    const replay = await value<Json>("select public.close_planned_trade($1, '1.10400', o.exited_at, '0.00') as value from public.trade_outcomes o where o.id = $2", [tradeId, closed.outcomeId]);
    expect(replay).toEqual(closed);
    await expect(closePlanned(tradeId, "1.106")).rejects.toThrow(/^ALREADY_CLOSED:/);
    expect(await ledger(tradeId)).toMatchObject({ lifecycle: "CLOSED", realized_r: "2", net_pnl: "100", gross_pnl: "100", fees: "0", outcome: "WIN", pnl_source: "CALCULATED", calculation_version: "FULL_CLOSE_V1" });
  });

  it("sets SKIPPED/CANCELLED dispositions through the plan", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const skipped = await lockedTrade(a);
    const set = (tradeId: string, status: string, reason: string) => value<Json>("select public.set_planned_disposition($1, $2, $3) as value", [tradeId, status, reason]);
    expect(await set(skipped.tradeId, "SKIPPED", "No displacement")).toEqual({ tradeId: skipped.tradeId, status: "SKIPPED", lifecycle: "SKIPPED" });
    expect(await set(skipped.tradeId, "SKIPPED", "No displacement")).toMatchObject({ lifecycle: "SKIPPED" });
    await expect(set(skipped.tradeId, "CANCELLED", "Changed my mind")).rejects.toThrow(/^ALREADY_DISPOSED:/);
    await expect(enter(skipped.tradeId)).rejects.toThrow(/^PLAN_DISPOSED:/);
    expect(await ledger(skipped.tradeId)).toMatchObject({ lifecycle: "SKIPPED", disposition: "SKIPPED", disposition_reason: "No displacement" });
    const executed = await lockedTrade(a, { entry: "1.2", stop: "1.198", target: "1.206" });
    await enter(executed.tradeId, "0.25", "1.2");
    await expect(set(executed.tradeId, "CANCELLED", "Too late")).rejects.toThrow(/^ALREADY_EXECUTED:/);
    await expect(set(executed.tradeId, "LOST", "x")).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(set(executed.tradeId, "SKIPPED", "   ")).rejects.toThrow(/^INVALID_INPUT:/);
    const cancelled = await lockedTrade(await db.bootstrapAccount(OWNER));
    expect(await set(cancelled.tradeId, "CANCELLED", "News")).toMatchObject({ lifecycle: "CANCELLED" });
  });

  it("completes and reopens reviews on closed trades only", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId } = await lockedTrade(a);
    const complete = (key: string | null = null) => value<LifecycleEnvelope>("select public.complete_trade_review($1, $2) as value", [tradeId, key]);
    const reopen = (reason: string | null, key: string | null = null) => value<LifecycleEnvelope>("select public.reopen_trade_review($1, $2, $3) as value", [tradeId, reason, key]);
    await expect(complete()).rejects.toThrow(/^NOT_CLOSED:/);
    await enter(tradeId);
    await expect(complete()).rejects.toThrow(/^NOT_CLOSED:/);
    await closePlanned(tradeId);
    await expect(reopen(null)).rejects.toThrow(/^NOT_REVIEWED:/);
    const key = randomUUID();
    const done = await complete(key);
    expect(done).toMatchObject({ event: "REVIEW_COMPLETED", lifecycle: "REVIEWED" });
    expect(await complete(key)).toEqual(done);
    expect(await complete()).toEqual(done);
    expect((await ledger(tradeId)).review_completed_at).toBeInstanceOf(Date);
    const reopened = await reopen("Missed a lesson", randomUUID());
    expect(reopened).toMatchObject({ event: "REVIEW_REOPENED", lifecycle: "CLOSED" });
    expect(await reopen(null)).toEqual(reopened);
    await expect(reopen("Missed a lesson", key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect(await ledger(tradeId)).toMatchObject({ lifecycle: "CLOSED", review_completed_at: null });
    expect((await complete()).lifecycle).toBe("REVIEWED");
  });
});

describe("live-first trades", () => {
  it("records a live trade with a known contract and replays the request key", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const input = { instrumentId: a.instrumentId, direction: "LONG", entryModel: "OTE", entryPrice: "1.10000", enteredAt: minutesAgo(10), quantity: "0.50", initialStop: "1.098" };
    const id = await liveTrade(a, input, key);
    expect(await liveTrade(a, { ...input, entryPrice: "1.1" }, key)).toBe(id);
    await expect(liveTrade(a, { ...input, quantity: "0.4" }, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect(await ledger(id)).toMatchObject({
      origin: "LIVE_FIRST", lifecycle: "LIVE", symbol: "EURUSD", instrument_version_id: a.instrumentId, direction: "LONG", entry_model: "OTE",
      entry_price: "1.1", quantity: "0.5", initial_stop: "1.098", initial_risk: "100", actual_initial_risk: "100", entry_time_known: true,
      planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null,
      strategy_version_id: null, risk_plan_version_id: null, plan_id: null, draft_check: null, latest_revision: null, revision_count: 0, oversize: null,
    });
    expect((await db.query<Json>("select source, request_key, symbol from public.trade_position_facts where trade_id = $1", [id])).rows).toEqual([{ source: "USER", request_key: key, symbol: "EURUSD" }]);
  });

  it.each([
    [{ direction: "LONG" }, /^INVALID_INPUT: An instrument/],
    [{ symbol: "XAUUSD" }, /^INVALID_INPUT: An instrument/],
    [{ symbol: "xauusd", direction: "LONG" }, /^INVALID_INPUT: symbol/],
    [{ symbol: "XAUUSD", direction: "UP" }, /^INVALID_INPUT: direction/],
    [{ symbol: "GBPUSD", useInstrument: true, direction: "LONG" }, /^INVALID_INPUT: symbol does not match/],
    [{ useInstrument: true, direction: "LONG", entryPrice: "1.100001" }, /^OFF_INCREMENT:/],
    [{ useInstrument: true, direction: "LONG", quantity: "0.015" }, /^OFF_INCREMENT:/],
    [{ useInstrument: true, direction: "LONG", quantity: "0" }, /^INVALID_INPUT: quantity/],
    [{ symbol: "XAUUSD", direction: "LONG", entryPrice: "2400", initialStop: "2410" }, /^INVALID_INPUT: The stop must be below/],
    [{ symbol: "XAUUSD", direction: "SHORT", entryPrice: "2400", initialStop: "2390" }, /^INVALID_INPUT: The stop must be above/],
    [{ symbol: "XAUUSD", direction: "LONG", enteredAt: new Date(Date.now() + 3_600_000).toISOString() }, /^INVALID_TIME:/],
    [{ symbol: "XAUUSD", direction: "LONG", enteredAt: "now" }, /^INVALID_INPUT: enteredAt/],
    [{ symbol: "XAUUSD", direction: "LONG", enteredAt: "2026-10-01 10:00" }, /^INVALID_INPUT: enteredAt/],
    [{ symbol: "XAUUSD", direction: "LONG", riskAmount: "10.001" }, /^INVALID_INPUT: riskAmount/],
    [{ symbol: "XAUUSD", direction: "LONG", leverage: "100" }, /unknown field "leverage"/],
  ])("validates live-trade input %#", async (input, error) => {
    const a = await db.bootstrapAccount(OWNER);
    const { useInstrument, ...rest } = input as Json & { useInstrument?: boolean };
    await expect(liveTrade(a, useInstrument ? { instrumentId: a.instrumentId, ...rest } : rest)).rejects.toThrow(error);
    expect(await count("select 1 from public.trades where account_id = $1", [a.accountId])).toBe(0);
  });

  it("completes missing entry details once and never changes a recorded fact", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await liveTrade(a, { symbol: "EURUSD", direction: "SHORT" });
    const complete = (input: Json, key: string = randomUUID()) => value<string>("select public.complete_live_entry($1, $2::jsonb, $3) as value", [id, JSON.stringify(input), key]);
    const key = randomUUID();
    const row = await complete({ instrumentId: a.instrumentId, entryPrice: "1.1", quantity: "0.2" }, key);
    expect(await complete({ instrumentId: a.instrumentId, entryPrice: "1.10", quantity: "0.20" }, key)).toBe(row);
    await expect(complete({ instrumentId: a.instrumentId, entryPrice: "1.2", quantity: "0.2" }, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    await expect(complete({ entryPrice: "1.2" })).rejects.toThrow(/^ENTRY_DETAILS_IMMUTABLE:/);
    await expect(complete({ initialStop: "1.098" })).rejects.toThrow(/^INVALID_INPUT: The stop must be above/);
    await expect(complete({ enteredAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/^INVALID_TIME:/);
    await expect(complete({})).rejects.toThrow(/^INVALID_INPUT: Provide at least one/);
    await expect(complete({ symbol: "GBPUSD" })).rejects.toThrow(/unknown field "symbol"/);
    await complete({ initialStop: "1.102", enteredAt: minutesAgo(30) });
    expect(await ledger(id)).toMatchObject({ entry_price: "1.1", quantity: "0.2", initial_stop: "1.102", initial_risk: "40", instrument_version_id: a.instrumentId, entry_time_known: true });
    await closeLive(id, { exitPrice: "1.099", exitedAt: minutesAgo(1) });
    await expect(complete({ riskAmount: "40" })).rejects.toThrow(/^ALREADY_CLOSED:/);
    const planned = await createDraft(a);
    await expect(db.query("select public.complete_live_entry($1, '{\"entryPrice\":\"1.1\"}'::jsonb, $2)", [planned.tradeId, randomUUID()])).rejects.toThrow(/^ORIGIN_MISMATCH:/);
    const imported = await importedTrade(a, "XAUUSD", "SHORT");
    await db.query("select public.complete_live_entry($1, '{\"riskAmount\":\"30\"}'::jsonb, $2)", [imported, randomUUID()]);
    expect(await ledger(imported)).toMatchObject({ origin: "IMPORTED", lifecycle: "LIVE", symbol: "XAUUSD", initial_risk: "30" });
  });

  it("enforces the entry-facts rules for every writer, not only the RPCs", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG", entryPrice: "2400" });
    await db.admin();
    const insert = (tradeId: string, column: string, literal: string) => db.query(
      `insert into public.trade_position_facts(user_id, account_id, trade_id, source, ${column}) values ($1, $2, $3, 'IMPORT', ${literal})`, [OWNER, a.accountId, tradeId]);
    await expect(insert(id, "entry_price", "2401")).rejects.toThrow(/^ENTRY_DETAILS_IMMUTABLE:/);
    await expect(insert(id, "direction", "'LONG'")).rejects.toThrow(/^ENTRY_DETAILS_IMMUTABLE:/);
    await insert(id, "quantity", "1");
    expect(await ledger(id)).toMatchObject({ entry_price: "2400", quantity: "1" });
    await db.admin();
    const imported = randomUUID();
    await db.query("insert into public.trades(id, user_id, account_id, origin) values ($1, $2, $3, 'IMPORTED')", [imported, OWNER, a.accountId]);
    await expect(insert(imported, "symbol", "'XAUUSD'")).rejects.toThrow(/^INVALID_INPUT: The first entry facts/);
  });

  it("calculates P&L and realized R from a reported risk amount (UNPLANNED_CLOSE_V1)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await liveTrade(a, { instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.1", quantity: "0.5", riskAmount: "50", enteredAt: minutesAgo(20) });
    expect(await closeLive(id, { exitPrice: "1.102", exitedAt: minutesAgo(1), fees: "2" })).toBe(id);
    expect((await db.query<Json>("select gross_pnl::text, net_pnl::text, fees::text, pnl_source, risk_basis::text, risk_basis_source, realized_r::text, outcome, calculation_version from public.trade_unplanned_closes where trade_id = $1", [id])).rows[0])
      .toEqual({ gross_pnl: "100", net_pnl: "98", fees: "2.00", pnl_source: "CALCULATED", risk_basis: "50", risk_basis_source: "USER_REPORTED", realized_r: "1.96", outcome: "WIN", calculation_version: "UNPLANNED_CLOSE_V1" });
    expect(await ledger(id)).toMatchObject({ lifecycle: "CLOSED", realized_r: "1.96", net_pnl: "98", gross_pnl: "100", fees: "2", initial_risk: "50", actual_initial_risk: null, pnl_source: "CALCULATED", calculation_version: "UNPLANNED_CLOSE_V1" });
  });

  it("derives the risk basis from entry, stop and size, and handles shorts", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const long = await liveTrade(a, { instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.1", quantity: "0.5", initialStop: "1.098" });
    await closeLive(long, { exitPrice: "1.096", exitedAt: minutesAgo(0.1) });
    expect((await db.query<Json>("select net_pnl::text, risk_basis::text, risk_basis_source, realized_r::text, outcome from public.trade_unplanned_closes where trade_id = $1", [long])).rows[0])
      .toEqual({ net_pnl: "-200", risk_basis: "100", risk_basis_source: "DERIVED", realized_r: "-2", outcome: "LOSS" });
    const short = await liveTrade(a, { instrumentId: a.instrumentId, direction: "SHORT", entryPrice: "1.1", quantity: "0.1", initialStop: "1.103" });
    await closeLive(short, { exitPrice: "1.098", exitedAt: minutesAgo(0.1), fees: "0.5" });
    expect((await db.query<Json>("select gross_pnl::text, net_pnl::text, risk_basis::text, realized_r::text, outcome from public.trade_unplanned_closes where trade_id = $1", [short])).rows[0])
      .toEqual({ gross_pnl: "20", net_pnl: "19.5", risk_basis: "30", realized_r: "0.65", outcome: "WIN" });
    expect(new Decimal(String((await ledger(short)).realized_r)).eq("0.65")).toBe(true);
  });

  it("leaves realized R null without a risk basis and accepts reported P&L only when it cannot be calculated", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const noBasis = await liveTrade(a, { instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.1", quantity: "0.1" });
    await expect(closeLive(noBasis, { exitPrice: "1.101", exitedAt: minutesAgo(0.1), netPnl: "10" })).rejects.toThrow(/^PNL_IS_CALCULATED:/);
    await closeLive(noBasis, { exitPrice: "1.1", exitedAt: minutesAgo(0.1) });
    expect(await ledger(noBasis)).toMatchObject({ outcome: "BREAKEVEN", net_pnl: "0", realized_r: null, initial_risk: null, pnl_source: "CALCULATED" });
    const gold = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT", entryPrice: "2400.5" });
    await expect(closeLive(gold, { exitPrice: "2390", exitedAt: minutesAgo(0.1) })).rejects.toThrow(/^PNL_REQUIRED:/);
    await expect(closeLive(gold, { exitedAt: minutesAgo(0.1), netPnl: "12.345" })).rejects.toThrow(/^INVALID_INPUT: netPnl/);
    await closeLive(gold, { exitPrice: "2390", exitedAt: minutesAgo(0.1), netPnl: "-12.34", fees: "1.5" });
    expect((await db.query<Json>("select exit_price::text, gross_pnl, net_pnl::text, fees::text, pnl_source, risk_basis, risk_basis_source, realized_r, outcome from public.trade_unplanned_closes where trade_id = $1", [gold])).rows[0])
      .toEqual({ exit_price: "2390", gross_pnl: null, net_pnl: "-12.34", fees: "1.50", pnl_source: "USER_REPORTED", risk_basis: null, risk_basis_source: null, realized_r: null, outcome: "LOSS" });
    const reported = await liveTrade(a, { symbol: "NAS100", direction: "LONG", riskAmount: "25" });
    await closeLive(reported, { exitedAt: minutesAgo(0.1), netPnl: "-12.34" });
    expect(await ledger(reported)).toMatchObject({ realized_r: "-0.4936", initial_risk: "25", pnl_source: "USER_REPORTED", gross_pnl: null });
  });

  it("validates close times and replays only identical closes", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await liveTrade(a, { instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.1", quantity: "0.1", enteredAt: minutesAgo(30) });
    await expect(closeLive(id, { exitPrice: "1.101", exitedAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/^INVALID_TIME:/);
    await expect(closeLive(id, { exitPrice: "1.101", exitedAt: minutesAgo(40) })).rejects.toThrow(/^INVALID_TIME:/);
    await expect(closeLive(id, { exitPrice: "1.101" })).rejects.toThrow(/^INVALID_INPUT: exitedAt/);
    await expect(closeLive(id, { exitPrice: "1.101", exitedAt: minutesAgo(1), fees: "-1" })).rejects.toThrow(/^INVALID_INPUT: fees/);
    const exitedAt = minutesAgo(1);
    expect(await closeLive(id, { exitPrice: "1.101", exitedAt, fees: "1" })).toBe(id);
    expect(await closeLive(id, { exitPrice: "1.10100", exitedAt, fees: "1.00" })).toBe(id);
    await expect(closeLive(id, { exitPrice: "1.102", exitedAt, fees: "1" })).rejects.toThrow(/^ALREADY_CLOSED:/);
    const draft = await createDraft(a);
    await expect(closeLive(draft.tradeId, { exitPrice: "1.1", exitedAt })).rejects.toThrow(/^ORIGIN_MISMATCH:/);
    await expect(db.query("select public.close_planned_trade($1, '1.1', clock_timestamp(), '0')", [id])).rejects.toThrow(/^PLAN_REQUIRED:/);
  });
});

describe("trade journal", () => {
  it("stores the server-computed phase and state for every planned lifecycle state", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const expectations: [string, string][] = [];
    expectations.push([await journal(draft.tradeId, "NOTE", "Waiting for the sweep"), "PRE_ENTRY/DRAFT"]);
    await lock(draft.tradeId);
    expectations.push([await journal(draft.tradeId, "DECISION", "Order placed at the OB"), "PRE_ENTRY/LOCKED"]);
    await enter(draft.tradeId);
    expectations.push([await journal(draft.tradeId, "STOP_CHANGE", null, { price: "1.0990" }), "LIVE/LIVE"]);
    expectations.push([await journal(draft.tradeId, "PARTIAL_CLOSE", "Half off", { price: "1.103", percent: "50" }), "LIVE/LIVE"]);
    await closePlanned(draft.tradeId);
    expectations.push([await journal(draft.tradeId, "LESSON", "Patience paid"), "POST_TRADE/CLOSED"]);
    await db.query("select public.complete_trade_review($1, null)", [draft.tradeId]);
    expectations.push([await journal(draft.tradeId, "NOTE", "Reviewed later"), "POST_TRADE/REVIEWED"]);
    expect((await ledger(draft.tradeId)).journal_count).toBe(6);

    // Trades that ended before any entry: what is written afterwards is hindsight, stored POST_TRADE with the terminal
    // state they were in (§5.2), never pre-entry evidence.
    const discarded = await createDraft(a, SECOND_PRICES);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    expectations.push([await journal(discarded.tradeId, "NOTE", "Dropped: no displacement"), "POST_TRADE/DISCARDED"]);
    const skippedDraft = await createDraft(a, THIRD_PRICES);
    await legacyDecision(skippedDraft.proposalId, "SKIPPED", "Not my setup");
    expectations.push([await journal(skippedDraft.tradeId, "LESSON", "Skipped before locking"), "POST_TRADE/SKIPPED"]);
    const b = await db.bootstrapAccount(OWNER);
    const skipped = await lockedTrade(b);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'No displacement')", [skipped.tradeId]);
    expectations.push([await journal(skipped.tradeId, "LESSON", "Waiting was right"), "POST_TRADE/SKIPPED"]);
    const cancelled = await lockedTrade(b, SECOND_PRICES);
    await db.query("select public.set_planned_disposition($1, 'CANCELLED', 'News release')", [cancelled.tradeId]);
    expectations.push([await journal(cancelled.tradeId, "NOTE", "Cancelled for the release"), "POST_TRADE/CANCELLED"]);
    const skippedAfterLock = await createDraft(await db.bootstrapAccount(OWNER));
    await lock(skippedAfterLock.tradeId);
    await legacyDecision(skippedAfterLock.proposalId, "SKIPPED", "Changed my mind after the lock");
    expectations.push([await journal(skippedAfterLock.tradeId, "NOTE", "Legacy skip"), "POST_TRADE/SKIPPED"]);

    // Imported trades, like live-first ones, are live from creation.
    const imported = await importedTrade(a, "XAUUSD", "LONG");
    expectations.push([await journal(imported, "NOTE", "Synced position"), "LIVE/LIVE"]);
    await closeLive(imported, { exitedAt: minutesAgo(0.1), netPnl: "4" });
    expectations.push([await journal(imported, "LESSON", "Closed on the platform"), "POST_TRADE/CLOSED"]);

    for (const [id, expected] of expectations) {
      const row = await journalRow(id);
      expect(`${row.phase}/${row.state_at_creation}`, expected).toBe(expected);
    }
    // Reflection stays possible after a trade ends without an entry: evidence and tags as well as notes.
    for (const [tradeId, state] of [[discarded.tradeId, "DISCARDED"], [skipped.tradeId, "SKIPPED"], [cancelled.tradeId, "CANCELLED"]]) {
      expect(await registerEvidence(evidenceRecord(tradeId)), state).toMatchObject({ phase: "POST_TRADE", stateAtCreation: state });
      await db.actor(OWNER);
      expect(await value<number>("select public.set_trade_tags($1, 'C', null, null, '{late}'::text[]) as value", [tradeId]), state).toBeGreaterThan(0);
    }
  });

  it("marks live-first entries live from creation and post-trade after close", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const id = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" });
    const live = await journal(id, "NOTE", "Opened on impulse");
    const target = await journal(id, "TARGET_CHANGE", null, { price: "2412.123" });
    await closeLive(id, { exitedAt: minutesAgo(0.1), netPnl: "5" });
    const after = await journal(id, "LESSON", "Plan first next time");
    expect(await journalRow(live)).toEqual({ phase: "LIVE", state_at_creation: "LIVE" });
    expect(await journalRow(target)).toEqual({ phase: "LIVE", state_at_creation: "LIVE" });
    expect(await journalRow(after)).toEqual({ phase: "POST_TRADE", state_at_creation: "CLOSED" });
    await expect(journal(id, "TARGET_CHANGE", null, { price: "2412.123" })).rejects.toThrow(/^ENTRY_NOT_LIVE:/);
  });

  it("records stop moves, target changes and partial closes only while the trade is live (§5.2)", async () => {
    const NOT_LIVE = /^ENTRY_NOT_LIVE: Stop, target and partial-close entries can only be recorded while the trade is live$/;
    const management: [string, Json][] = [["STOP_CHANGE", { price: "1.0985" }], ["TARGET_CHANGE", { price: "1.107" }], ["PARTIAL_CLOSE", { percent: "50", price: "1.103" }]];
    const a = await db.bootstrapAccount(OWNER);
    const refusedEverywhere = async (tradeId: string, phase: string) => {
      const entries = await count("select 1 from public.trade_journal_entries where trade_id = $1", [tradeId]);
      for (const [kind, details] of management) {
        await expect(journal(tradeId, kind, null, details), `${kind} ${phase}`).rejects.toThrow(NOT_LIVE);
      }
      expect(await count("select 1 from public.trade_journal_entries where trade_id = $1", [tradeId])).toBe(entries);
      // Notes, decisions and lessons fit every phase.
      for (const kind of ["NOTE", "DECISION", "LESSON"]) expect(await journal(tradeId, kind, `${kind} while ${phase}`), `${kind} ${phase}`).toBeTruthy();
    };
    const draft = await createDraft(a);
    await refusedEverywhere(draft.tradeId, "a draft");
    await lock(draft.tradeId);
    await refusedEverywhere(draft.tradeId, "a locked plan");
    await enter(draft.tradeId);
    const accepted: { kind: string; details: Json; key: string; id: string }[] = [];
    for (const [kind, details] of management) {
      const key = randomUUID();
      const id = await journal(draft.tradeId, kind, null, details, key);
      expect(await journalRow(id), kind).toEqual({ phase: "LIVE", state_at_creation: "LIVE" });
      accepted.push({ kind, details, key, id });
    }
    await closePlanned(draft.tradeId);
    await refusedEverywhere(draft.tradeId, "a closed trade");
    // A retry of a request accepted while live still answers with its entry.
    for (const { kind, details, key, id } of accepted) {
      expect(await journal(draft.tradeId, kind, null, details, key), kind).toBe(id);
    }
    // Plans that ended without an entry, and a live-first trade once closed.
    const discarded = await createDraft(a, SECOND_PRICES);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    await refusedEverywhere(discarded.tradeId, "a discarded draft");
    const skipped = await lockedTrade(a, THIRD_PRICES);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'No displacement')", [skipped.tradeId]);
    await refusedEverywhere(skipped.tradeId, "a skipped plan");
    const imported = await importedTrade(a, "XAUUSD", "SHORT");
    expect(await journal(imported, "STOP_CHANGE", null, { price: "2405.5" })).toBeTruthy();
    await closeLive(imported, { exitedAt: minutesAgo(0.1), netPnl: "-3" });
    await refusedEverywhere(imported, "a closed import");
  });

  it("validates details per kind, normalizes the body and replays by request key", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId } = await lockedTrade(a);
    // Stop, target and partial-close details are validated while the position is open (the only phase they fit).
    await enter(tradeId);
    const key = randomUUID();
    const id = await journal(tradeId, "NOTE", "  Liquidity swept  \n", {}, key);
    expect(await journal(tradeId, "NOTE", "Liquidity swept", {}, key)).toBe(id);
    await expect(journal(tradeId, "NOTE", "Edited", {}, key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect((await db.query<{ body: string; details: Json; source: string }>("select body, details, source from public.trade_journal_entries where id = $1", [id])).rows[0])
      .toEqual({ body: "Liquidity swept", details: {}, source: "USER" });
    const invalid: [string, string | null, Json][] = [
      ["NOTE", null, {}], ["NOTE", " \n\t ", {}], ["DECISION", "Body", { price: "1.1" }], ["LESSON", null, {}],
      ["STOP_CHANGE", null, {}], ["STOP_CHANGE", null, { price: 1.099 }], ["STOP_CHANGE", null, { price: "1.099005" }],
      ["TARGET_CHANGE", null, { price: "1.1", reason: "x" }], ["PARTIAL_CLOSE", null, {}],
      ["PARTIAL_CLOSE", null, { quantity: "0.1", percent: "50" }], ["PARTIAL_CLOSE", null, { percent: "100" }],
      ["PARTIAL_CLOSE", null, { percent: "0" }], ["PARTIAL_CLOSE", null, { quantity: "-1" }], ["MOOD", "Calm", {}],
    ];
    for (const [kind, body, details] of invalid) {
      await expect(journal(tradeId, kind, body, details), `${kind} ${JSON.stringify(details)}`).rejects.toThrow(/^INVALID_INPUT:/);
    }
    expect(await journal(tradeId, "PARTIAL_CLOSE", null, { quantity: "0.1", price: "1.1015" })).toBeTruthy();
    expect(await journal(tradeId, "PARTIAL_CLOSE", "Scaled out", {})).toBeTruthy();
    expect((await ledger(tradeId)).journal_count).toBe(3);
  });
});

describe("trade evidence", () => {
  it("registers evidence as the trusted server with phase, replay and the 24-item limit", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const first = evidenceRecord(draft.tradeId, { label: "HTF", timeframe: "H4", caption: " Daily bias ", captureMethod: "DROP" });
    const registered = await registerEvidence(first);
    expect(registered).toMatchObject({ id: first.id, tradeId: draft.tradeId, phase: "PRE_ENTRY", stateAtCreation: "DRAFT", replayed: false });
    expect(await registerEvidence(first)).toMatchObject({ id: first.id, replayed: true });
    await expect(registerEvidence({ ...first, sha256: sha("b") })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    await expect(registerEvidence(evidenceRecord(draft.tradeId), OTHER)).rejects.toThrow(/^TRADE_NOT_FOUND:/);
    await db.actor(OWNER);
    expect((await db.query<Json>("select storage_path, caption, label, timeframe, capture_method, copied_from from public.trade_evidence where id = $1", [first.id])).rows[0])
      .toEqual({ storage_path: `${OWNER}/${draft.tradeId}/${first.id}`, caption: "Daily bias", label: "HTF", timeframe: "H4", capture_method: "DROP", copied_from: null });
    for (let n = 1; n < 24; n += 1) await registerEvidence(evidenceRecord(draft.tradeId));
    await expect(registerEvidence(evidenceRecord(draft.tradeId))).rejects.toThrow(/^EVIDENCE_LIMIT:/);
    await db.actor(OWNER);
    await db.query("select public.remove_trade_evidence($1)", [first.id]);
    await db.query("select public.remove_trade_evidence($1)", [first.id]);
    expect(await count("select 1 from public.trade_evidence_removals where evidence_id = $1", [first.id])).toBe(1);
    expect((await registerEvidence(evidenceRecord(draft.tradeId))).replayed).toBe(false);
    expect(await ledger(draft.tradeId)).toMatchObject({ evidence_count: 24, cover_evidence_kind: "V2" });
  });

  it.each([
    [{ label: "CHART" }, /label/], [{ timeframe: "W1" }, /timeframe/], [{ mimeType: "image/gif" }, /mimeType/],
    [{ byteSize: 4_194_305 }, /byteSize/], [{ byteSize: "12.5" }, /byteSize/], [{ sha256: "A".repeat(64) }, /sha256/],
    [{ width: 10_000, height: 5_000 }, /megapixels/], [{ captureMethod: "SCREEN" }, /captureMethod/],
    [{ originalFilename: "" }, /originalFilename/], [{ caption: "x".repeat(201) }, /caption/],
    [{ storagePath: "elsewhere/x" }, /storagePath/], [{ copiedFrom: randomUUID() }, /copiedFrom/], [{ owner: OTHER }, /unknown field/],
  ])("validates evidence records %#", async (overrides, error) => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await expect(registerEvidence(evidenceRecord(draft.tradeId, overrides))).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(registerEvidence(evidenceRecord(draft.tradeId, overrides))).rejects.toThrow(error);
  });

  it("computes the phase of evidence from the trade, never from the client", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId } = await lockedTrade(a);
    const locked = await registerEvidence(evidenceRecord(tradeId, { label: "EXIT" }));
    await enter(tradeId);
    const live = await registerEvidence(evidenceRecord(tradeId, { label: "PRE_ENTRY" }));
    await closePlanned(tradeId);
    const closed = await registerEvidence(evidenceRecord(tradeId, { label: "PRE_ENTRY" }));
    expect([locked, live, closed].map((e) => `${e.phase}/${e.stateAtCreation}`)).toEqual(["PRE_ENTRY/LOCKED", "LIVE/LIVE", "POST_TRADE/CLOSED"]);
    const liveFirst = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" });
    expect(await registerEvidence(evidenceRecord(liveFirst))).toMatchObject({ phase: "LIVE", stateAtCreation: "LIVE" });
  });

  it("serves evidence objects to their owner only and denies browser writes to the bucket", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const record = evidenceRecord(draft.tradeId);
    const path = `${OWNER}/${draft.tradeId}/${record.id}`;
    const orphan = `${OWNER}/${draft.tradeId}/${randomUUID()}`;
    await db.actor(OWNER, "service_role");
    await db.query("insert into storage.objects(bucket_id, name) values ('trade-evidence', $1), ('trade-evidence', $2)", [path, orphan]);
    await registerEvidence(record);
    await db.actor(OWNER);
    expect(await count("select 1 from storage.objects where name = $1", [path])).toBe(1);
    expect(await count("select 1 from storage.objects where name = $1", [orphan])).toBe(0);
    await expect(db.query("insert into storage.objects(bucket_id, name) values ('trade-evidence', $1)", [`${OWNER}/forged`])).rejects.toThrow(/row-level security/);
    await db.query("delete from storage.objects where name = $1", [path]);
    await db.query("update storage.objects set name = 'moved' where name = $1", [path]);
    await db.actor(OWNER, "service_role");
    expect(await count("select 1 from storage.objects where name = $1", [path])).toBe(1);
    await db.actor(OTHER);
    expect(await count("select 1 from storage.objects where name = $1", [path])).toBe(0);
    await db.anon();
    expect(await count("select 1 from storage.objects where name = $1", [path])).toBe(0);
    await db.admin();
    const bucket = (await db.query<Json>("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'trade-evidence'")).rows[0];
    expect(bucket).toEqual({ public: false, file_size_limit: 4194304, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] });
    expect((await db.query<{ policyname: string }>("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname")).rows.map((r) => r.policyname)).toEqual([
      "setup_screenshot_delete_guard", "setup_screenshot_insert_guard", "setup_screenshot_owner_read", "setup_screenshot_read_guard", "setup_screenshot_update_guard",
      "trade_evidence_delete_guard", "trade_evidence_insert_guard", "trade_evidence_owner_read", "trade_evidence_read_guard", "trade_evidence_update_guard",
    ]);
  });

  it("keeps the legacy screenshot bucket readable alongside V2 evidence", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const legacyId = randomUUID();
    const legacyPath = `${OWNER}/${draft.proposalId}/${legacyId}`;
    // V2 registers no legacy screenshots (0019 keeps no insert grant): the superuser stands in for a V1 registration.
    await db.admin();
    await db.query("insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size, sha256, width, height) values ($1, $2, $3, $4, 'H1', $5, 'h1.png', 'image/png', 1024, $6, 32, 32)",
      [legacyId, OWNER, a.accountId, draft.proposalId, legacyPath, sha("c")]);
    await db.query("insert into storage.objects(bucket_id, name) values ('setup-screenshots', $1)", [legacyPath]);
    await db.actor(OWNER);
    expect(await count("select 1 from storage.objects where name = $1", [legacyPath])).toBe(1);
    expect(await ledger(draft.tradeId)).toMatchObject({ evidence_count: 1, cover_evidence_id: legacyId, cover_evidence_kind: "LEGACY" });
    const copy = await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [draft.tradeId, randomUUID(), a.riskId, a.observationId]);
    const duplicated = await registerEvidence(evidenceRecord(copy.tradeId, { sha256: sha("c"), captureMethod: "DUPLICATE", copiedFrom: legacyId }));
    expect(duplicated).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    await expect(registerEvidence(evidenceRecord(copy.tradeId, { sha256: sha("d"), captureMethod: "DUPLICATE", copiedFrom: legacyId }))).rejects.toThrow(/copiedFrom/);
    await expect(registerEvidence(evidenceRecord(copy.tradeId, { captureMethod: "DUPLICATE" }))).rejects.toThrow(/copiedFrom/);
    expect(await ledger(copy.tradeId)).toMatchObject({ evidence_count: 1, cover_evidence_id: duplicated.id, cover_evidence_kind: "V2" });
  });

  it("relabels and removes evidence append-only for the owner", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const record = evidenceRecord(draft.tradeId, { label: "CONTEXT", timeframe: null });
    await registerEvidence(record);
    await db.actor(OWNER);
    const relabel = (label: string | null, timeframe: string | null, caption: string | null) => db.query("select public.relabel_trade_evidence($1, $2, $3, $4)", [record.id, label, timeframe, caption]);
    await relabel("CONTEXT", null, null);
    expect(await count("select 1 from public.trade_evidence_labels where evidence_id = $1", [record.id])).toBe(0);
    await relabel("HTF", "DAILY", " Weekly range ");
    await relabel("HTF", "DAILY", "Weekly range");
    expect((await db.query<Json>("select label, timeframe, caption from public.trade_evidence_labels where evidence_id = $1", [record.id])).rows).toEqual([{ label: "HTF", timeframe: "DAILY", caption: "Weekly range" }]);
    await expect(relabel("HTF", "W1", null)).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(relabel(null, null, null)).rejects.toThrow(/^INVALID_INPUT:/);
    expect((await db.query<{ phase: string; label: string }>("select phase, label from public.trade_evidence where id = $1", [record.id])).rows[0]).toEqual({ phase: "PRE_ENTRY", label: "CONTEXT" });
    await db.query("select public.remove_trade_evidence($1)", [record.id]);
    await expect(relabel("ENTRY", null, null)).rejects.toThrow(/^EVIDENCE_REMOVED:/);
    expect(await ledger(draft.tradeId)).toMatchObject({ evidence_count: 0, cover_evidence_id: null, cover_evidence_kind: null });
  });

  it("removes and relabels evidence in every lifecycle state without changing its timing (§2.5)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId } = await lockedTrade(a);
    const add = async (label: string) => (await registerEvidence(evidenceRecord(tradeId, { label }))).id;
    const remove = async (id: string) => {
      await db.actor(OWNER);
      await db.query("select public.remove_trade_evidence($1)", [id]);
    };
    const relabel = async (id: string, label: string) => {
      await db.actor(OWNER);
      await db.query("select public.relabel_trade_evidence($1, $2, 'H1', 'Relabelled later')", [id, label]);
    };
    const rows = async () => {
      await db.actor(OWNER);
      return (await db.query<Json>("select id, label, timeframe, caption, phase, state_at_creation, recorded_at from public.trade_evidence where trade_id = $1 order by recorded_at, id", [tradeId])).rows;
    };
    const activeCount = async () => (await ledger(tradeId)).evidence_count;

    const lockedA = await add("CONTEXT");
    const lockedB = await add("HTF");
    await remove(lockedA);
    await relabel(lockedB, "ENTRY");
    expect(await activeCount()).toBe(1);
    await enter(tradeId);
    const liveA = await add("MANAGEMENT");
    const liveB = await add("MANAGEMENT");
    await remove(liveA);
    await relabel(liveB, "PRE_ENTRY");
    await relabel(lockedB, "OTHER");
    expect(await activeCount()).toBe(2);
    await closePlanned(tradeId);
    const closed = await add("EXIT");
    await remove(liveB);
    await relabel(closed, "PRE_ENTRY");
    expect(await activeCount()).toBe(2);
    expect(await ledger(tradeId)).toMatchObject({ lifecycle: "CLOSED", cover_evidence_id: lockedB, cover_evidence_kind: "V2" });

    // The registered rows (label, phase, state at creation, recorded time) are exactly what was written at upload.
    const registered = await rows();
    expect(registered.map((e) => [e.id, e.label, e.phase, e.state_at_creation])).toEqual([
      [lockedA, "CONTEXT", "PRE_ENTRY", "LOCKED"], [lockedB, "HTF", "PRE_ENTRY", "LOCKED"],
      [liveA, "MANAGEMENT", "LIVE", "LIVE"], [liveB, "MANAGEMENT", "LIVE", "LIVE"], [closed, "EXIT", "POST_TRADE", "CLOSED"],
    ]);
    expect(await count("select 1 from public.trade_evidence_removals where trade_id = $1", [tradeId])).toBe(3);
    expect((await db.query<Json>("select evidence_id, label from public.trade_evidence_labels where trade_id = $1 order by id", [tradeId])).rows).toEqual([
      { evidence_id: lockedB, label: "ENTRY" }, { evidence_id: liveB, label: "PRE_ENTRY" }, { evidence_id: lockedB, label: "OTHER" }, { evidence_id: closed, label: "PRE_ENTRY" },
    ]);
    await expect(relabel(liveB, "EXIT")).rejects.toThrow(/^EVIDENCE_REMOVED:/);
    await remove(liveB);
    expect(await rows()).toEqual(registered);

    // Terminal states before entry and trades without a plan allow the same soft operations.
    const discarded = await createDraft(a, SECOND_PRICES);
    const draftChart = await registerEvidence(evidenceRecord(discarded.tradeId));
    await db.actor(OWNER);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    await relabel(draftChart.id, "OTHER");
    await remove(draftChart.id);
    expect(await ledger(discarded.tradeId)).toMatchObject({ lifecycle: "DISCARDED", evidence_count: 0 });
    const liveFirst = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" });
    const liveFirstChart = await registerEvidence(evidenceRecord(liveFirst));
    await closeLive(liveFirst, { exitedAt: minutesAgo(0.1), netPnl: "2" });
    await relabel(liveFirstChart.id, "EXIT");
    await remove(liveFirstChart.id);
    expect(await ledger(liveFirst)).toMatchObject({ lifecycle: "CLOSED", evidence_count: 0 });
  });

  it("copies only active pre-entry evidence of the trade a draft was duplicated from (§7.4)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await createDraft(a);
    const draftChart = await registerEvidence(evidenceRecord(source.tradeId, { sha256: sha("1") }));
    const removedChart = await registerEvidence(evidenceRecord(source.tradeId, { sha256: sha("2") }));
    await db.actor(OWNER);
    await db.query("select public.remove_trade_evidence($1)", [removedChart.id]);
    await lock(source.tradeId);
    const lockedChart = await registerEvidence(evidenceRecord(source.tradeId, { sha256: sha("3") }));
    await enter(source.tradeId);
    const liveChart = await registerEvidence(evidenceRecord(source.tradeId, { sha256: sha("4") }));
    await closePlanned(source.tradeId);
    const exitChart = await registerEvidence(evidenceRecord(source.tradeId, { sha256: sha("5"), label: "EXIT" }));
    await db.actor(OWNER);
    const copy = await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [source.tradeId, randomUUID(), a.riskId, a.observationId]);
    const copyInto = (tradeId: string, from: string, seed: string) =>
      registerEvidence(evidenceRecord(tradeId, { sha256: sha(seed), captureMethod: "DUPLICATE", copiedFrom: from }));

    expect(await copyInto(copy.tradeId, draftChart.id, "1")).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT", replayed: false });
    expect(await copyInto(copy.tradeId, lockedChart.id, "3")).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    for (const [from, seed] of [[removedChart.id, "2"], [liveChart.id, "4"], [exitChart.id, "5"]]) {
      await expect(copyInto(copy.tradeId, from, seed), seed).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    }
    const unrelated = await createDraft(a, SECOND_PRICES);
    await expect(copyInto(unrelated.tradeId, draftChart.id, "1")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    const otherSource = await createDraft(a, THIRD_PRICES);
    const otherChart = await registerEvidence(evidenceRecord(otherSource.tradeId, { sha256: sha("6") }));
    await expect(copyInto(copy.tradeId, otherChart.id, "6")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);

    // Pre-entry by stored phase but recorded after the (back-dated) entry time: it was While live, never copyable.
    const b = await db.bootstrapAccount(OWNER);
    const backdated = await createDraft(b);
    const { planId } = await lock(backdated.tradeId);
    const afterEntryTime = await registerEvidence(evidenceRecord(backdated.tradeId, { sha256: sha("7") }));
    await db.actor(OWNER);
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', p.locked_at) from public.trade_plans p where p.id = $2", [backdated.tradeId, planId]);
    expect(afterEntryTime.phase).toBe("PRE_ENTRY");
    const backdatedCopy = await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [backdated.tradeId, randomUUID(), b.riskId, b.observationId]);
    await expect(copyInto(backdatedCopy.tradeId, afterEntryTime.id, "7")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
  });

  it("copies legacy screenshots only from the source's own revisions and only while active and pre-entry", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await createDraft(a);
    const screenshot = async (proposalId: string, seed: string) => {
      const id = randomUUID();
      // A V1 registration: V2 keeps no service-role insert grant on setup_screenshots (0019).
      await db.admin();
      await db.query("insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size, sha256, width, height) values ($1, $2, $3, $4, 'M15', $5, 'm15.png', 'image/png', 1024, $6, 32, 32)",
        [id, OWNER, a.accountId, proposalId, `${OWNER}/${proposalId}/${id}`, sha(seed)]);
      return id;
    };
    const beforeEntry = await screenshot(source.proposalId, "1");
    const removed = await screenshot(source.proposalId, "2");
    await db.actor(OWNER);
    await db.query("select public.remove_setup_screenshot($1)", [removed]);
    const elsewhere = await createDraft(a, SECOND_PRICES);
    const foreign = await screenshot(elsewhere.proposalId, "3");
    await lock(source.tradeId);
    await enter(source.tradeId);
    const afterEntry = await screenshot(source.proposalId, "4");
    await db.actor(OWNER);
    const copy = await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [source.tradeId, randomUUID(), a.riskId, a.observationId]);
    const copyInto = (from: string, seed: string) =>
      registerEvidence(evidenceRecord(copy.tradeId, { sha256: sha(seed), captureMethod: "DUPLICATE", copiedFrom: from }));
    expect(await copyInto(beforeEntry, "1")).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    for (const [from, seed] of [[removed, "2"], [foreign, "3"], [afterEntry, "4"]]) {
      await expect(copyInto(from, seed), seed).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    }
  });
});

describe("tags, external losses and risk policy", () => {
  it("validates and versions tag sets, falling back to legacy V1 tags", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const { tradeId, planId } = await lockedTrade(a);
    await db.query("select public.tag_journal_trade($1, 'B', 'PDL', 'M15')", [planId]);
    expect(await ledger(tradeId)).toMatchObject({ tag_source: "V1", setup_grade: "B", liquidity_context: "PDL", mss_timeframe: "M15", tags: [] });
    const set = (grade: string | null, liquidity: string | null, mss: string | null, tags: string[] | null) =>
      value<number>("select public.set_trade_tags($1, $2, $3, $4, $5::text[]) as value", [tradeId, grade, liquidity, mss, tags]);
    const first = await set("A+", "PDH", "M5", ["london open", "sweep_1", "a-b"]);
    expect(await set("A+", "PDH", "M5", ["london open", "sweep_1", "a-b"])).toBe(first);
    expect(await ledger(tradeId)).toMatchObject({ tag_source: "V2", setup_grade: "A+", liquidity_context: "PDH", mss_timeframe: "M5", tags: ["london open", "sweep_1", "a-b"] });
    const cleared = await set(null, null, null, null);
    expect(cleared).toBeGreaterThan(first);
    expect(await ledger(tradeId)).toMatchObject({ tag_source: "V2", setup_grade: null, tags: [] });
    for (const tags of [["Upper"], [" lead"], ["x".repeat(33)], ["dup", "dup"], Array.from({ length: 13 }, (_, n) => `t${n}`), ["semi;colon"]]) {
      await expect(set(null, null, null, tags), tags.join(",")).rejects.toThrow(/^INVALID_INPUT:/);
    }
    await expect(set("S", null, null, [])).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(set(null, "MOON", null, [])).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(set(null, null, "H1", [])).rejects.toThrow(/^INVALID_INPUT:/);
    expect(await set(null, null, null, Array.from({ length: 12 }, (_, n) => `tag ${n}`))).toBeGreaterThan(cleared);
  });

  it("adds and removes external losses with replay, validation and the strategy day", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const key = randomUUID();
    const add = (amount: string, note: string | null, requestKey: string = randomUUID()) => value<string>("select public.add_external_loss($1, $2, $3, $4) as value", [a.accountId, amount, note, requestKey]);
    const id = await add("25.50", " Other platform ", key);
    expect(await add("25.5", "Other platform", key)).toBe(id);
    await expect(add("26", "Other platform", key)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    for (const amount of ["0", "-5", "1.001", "abc", "1000000000000"]) await expect(add(amount, null), amount).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(add("5", "x".repeat(501))).rejects.toThrow(/^INVALID_INPUT:/);
    await db.admin();
    expect((await db.query<Json>("select amount::text, note, trading_day = private.strategy_day(recorded_at) as same_day from public.external_loss_entries where id = $1", [id])).rows[0])
      .toEqual({ amount: "25.50", note: "Other platform", same_day: true });
    await db.actor(OWNER);
    await db.query("select public.remove_external_loss($1, $2)", [id, "Entered twice"]);
    await db.query("select public.remove_external_loss($1, null)", [id]);
    expect((await db.query<Json>("select reason from public.external_loss_removals where entry_id = $1", [id])).rows).toEqual([{ reason: "Entered twice" }]);
  });

  it("versions risk policies with a default risk and fixes C9 precedence", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const base = { maxRiskPercent: "1", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: "300" };
    const create = (config: Json, immediate: boolean, reason: string | null = null) =>
      value<string>("select public.create_risk_policy_version($1, $2::jsonb, $3, $4) as value", [a.accountId, JSON.stringify(config), immediate, reason]);
    await expect(create({ ...base, defaultRiskPercent: "1.5" }, false)).rejects.toThrow(/^INVALID_INPUT: defaultRiskPercent must not exceed/);
    await expect(create({ ...base, defaultRiskPercent: undefined }, false)).rejects.toThrow(/^INVALID_INPUT:/);
    await expect(create({ ...base, maxDailyTrades: 0 }, false)).rejects.toThrow(/^INVALID_INPUT: maxDailyTrades/);
    await expect(create({ ...base, rrPolicy: "IGNORE" }, false)).rejects.toThrow(/^INVALID_INPUT: rrPolicy/);
    await expect(create({ ...base, dailyLossCap: "1.234" }, false)).rejects.toThrow(/^INVALID_INPUT: dailyLossCap/);
    await expect(create({ ...base, maxRiskPercent: "0.25", defaultRiskPercent: "0.25" }, true, "tiny")).rejects.toThrow(/^REASON_REQUIRED:/);
    const loosen = await create(base, false);
    const tighten = await create({ ...base, maxRiskPercent: "0.25", defaultRiskPercent: "0.25", maxDailyTrades: "1" }, true, "Drawdown protection");
    await db.admin();
    const versions = (await db.query<Json>("select id, version, effective_day - private.strategy_day(clock_timestamp()) as offset, max_risk_percent::text as max, default_risk_percent::text as def, max_daily_trades, override_reason, daily_loss_cap::text as loss from public.risk_plan_versions where account_id = $1 order by created_at", [a.accountId])).rows;
    expect(versions).toEqual([
      { id: a.riskId, version: "Risk Plan V1.0", offset: 0, max: "0.50000000", def: null, max_daily_trades: 2, override_reason: null, loss: null },
      { id: loosen, version: "Risk Plan V1.1", offset: 1, max: "1.00000000", def: "0.50000000", max_daily_trades: 2, override_reason: null, loss: "300.00" },
      { id: tighten, version: "Risk Plan V1.2", offset: 0, max: "0.25000000", def: "0.25000000", max_daily_trades: 1, override_reason: "Drawdown protection", loss: "300.00" },
    ]);
    const active = (offset: number) => value<string>("select (private.active_risk_plan($1, private.strategy_day(clock_timestamp()) + $2::int)).id as value", [a.accountId, offset]);
    expect(await active(0)).toBe(tighten);
    expect(await active(1)).toBe(tighten);
    expect(await active(-1)).toBeNull();
    const v1Tomorrow = await value<string>("select id as value from public.risk_plan_versions where account_id = $1 and effective_day <= private.strategy_day(clock_timestamp()) + 1 order by effective_day desc, created_at desc, id desc limit 1", [a.accountId]);
    expect(v1Tomorrow).toBe(loosen);
    expect(await count("select 1 from public.configuration_events where account_id = $1 and event_type = 'RISK_VERSION_CREATED'", [a.accountId])).toBe(2);
    await expect(db.query("insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent, max_daily_trades, min_rr, rr_policy, news_policy) values ($1, $2, 'X', current_date, 0.5, 0.6, 1, 3, 'BLOCK', 'WARN')", [OWNER, a.accountId]))
      .rejects.toThrow(/default_risk_percent_check/);
  });
});

describe("trade ledger", () => {
  it("exposes exactly the normative columns through a security-invoker view", async () => {
    await db.admin();
    expect((await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'trade_ledger' order by ordinal_position")).rows.map((r) => r.column_name)).toEqual(LEDGER_COLUMNS);
    expect((await db.query<{ options: string[] }>("select reloptions as options from pg_class where oid = 'public.trade_ledger'::regclass")).rows[0].options).toContain("security_invoker=true");
  });

  it("derives every lifecycle state with canonical numbers", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const b = await db.bootstrapAccount(OWNER);
    const drafted = await createDraft(a);
    const blocked = await createDraft(a, { riskPercent: "0.75" });
    const skippedDraft = await createDraft(a);
    await legacyDecision(skippedDraft.proposalId, "SKIPPED", "Not my setup");
    const takenDraft = await createDraft(a);
    await legacyDecision(takenDraft.proposalId, "TAKEN");
    const discarded = await createDraft(a);
    await db.query("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
    const closed = await lockedTrade(a);
    await enter(closed.tradeId);
    await closePlanned(closed.tradeId);
    const reviewed = await lockedTrade(a, { entry: "1.2", stop: "1.198", target: "1.206" });
    await enter(reviewed.tradeId, "0.25", "1.2");
    await closePlanned(reviewed.tradeId, "1.198");
    await db.query("select public.complete_trade_review($1, null)", [reviewed.tradeId]);
    const live = await lockedTrade(b);
    await enter(live.tradeId);
    const locked = await lockedTrade(b, { entry: "1.2", stop: "1.198", target: "1.206" });
    const liveFirst = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" });
    const closedFirst = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" });
    await closeLive(closedFirst, { exitedAt: minutesAgo(0.1), netPnl: "3" });
    const reviewedFirst = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" });
    await closeLive(reviewedFirst, { exitedAt: minutesAgo(0.1), netPnl: "-3" });
    await db.query("select public.complete_trade_review($1, null)", [reviewedFirst]);
    const expected: [string, Json][] = [
      [drafted.tradeId, { lifecycle: "DRAFT", draft_check: "APPROVED", legacy_decision: null }],
      [blocked.tradeId, { lifecycle: "DRAFT", draft_check: "BLOCKED" }],
      [skippedDraft.tradeId, { lifecycle: "SKIPPED", draft_check: null, legacy_decision: "SKIPPED" }],
      [takenDraft.tradeId, { lifecycle: "DRAFT", legacy_decision: "TAKEN" }],
      [discarded.tradeId, { lifecycle: "DISCARDED" }],
      [locked.tradeId, { lifecycle: "LOCKED" }],
      [live.tradeId, { lifecycle: "LIVE", exited_at: null }],
      [closed.tradeId, { lifecycle: "CLOSED", review_completed_at: null, outcome: "WIN" }],
      [reviewed.tradeId, { lifecycle: "REVIEWED", outcome: "LOSS", realized_r: "-1" }],
      [liveFirst, { lifecycle: "LIVE", origin: "LIVE_FIRST" }],
      [closedFirst, { lifecycle: "CLOSED", origin: "LIVE_FIRST" }],
      [reviewedFirst, { lifecycle: "REVIEWED", origin: "LIVE_FIRST" }],
    ];
    for (const [id, fields] of expected) expect(await ledger(id), String(fields.lifecycle)).toMatchObject(fields);
    expect(await ledger(closed.tradeId)).toMatchObject({
      origin: "PLANNED", currency: "USD", symbol: "EURUSD", instrument_version_id: a.instrumentId, direction: "LONG", entry_model: "OB_FIRST_TOUCH",
      planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "50",
      entry_price: "1.1", quantity: "0.25", initial_stop: "1.098", initial_risk: "50", actual_initial_risk: "50", oversize: false,
      exit_price: "1.104", fees: "0", gross_pnl: "100", net_pnl: "100", realized_r: "2", pnl_source: "CALCULATED", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0",
      revision_count: 1, latest_revision: 1, tags: [], tag_source: null, evidence_count: 0, journal_count: 0, ai_review_count: 0,
    });
    expect(await ledger(drafted.tradeId)).toMatchObject({ planned_quantity: "0.25", planned_risk: "50", initial_risk: null, initial_stop: null, entry_time_known: false, plan_trading_day: null, risk_plan_version_id: a.riskId });
    await db.actor(OTHER);
    expect(await count("select 1 from public.trade_ledger where account_id in ($1, $2)", [a.accountId, b.accountId])).toBe(0);
    await db.anon();
    await expect(db.query("select * from public.trade_ledger")).rejects.toThrow(/permission denied/);
  });

  it("keeps a legacy V1 SKIPPED decision after a lock until a fill or a disposition takes precedence", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const skipped = await createDraft(a);
    await lock(skipped.tradeId);
    await legacyDecision(skipped.proposalId, "SKIPPED", "Changed my mind after the lock");
    expect(await ledger(skipped.tradeId)).toMatchObject({ lifecycle: "SKIPPED", legacy_decision: "SKIPPED", draft_check: null, disposition: null, plan_id: expect.any(String) });
    await expect(revise(a, skipped.tradeId, 1)).rejects.toThrow(/^DRAFT_NOT_EDITABLE:/);
    await enter(skipped.tradeId);
    expect(await ledger(skipped.tradeId)).toMatchObject({ lifecycle: "LIVE", legacy_decision: "SKIPPED" });

    const cancelled = await createDraft(await db.bootstrapAccount(OWNER));
    await lock(cancelled.tradeId);
    await legacyDecision(cancelled.proposalId, "SKIPPED");
    await db.query("select public.set_planned_disposition($1, 'CANCELLED', 'Session ended')", [cancelled.tradeId]);
    expect(await ledger(cancelled.tradeId)).toMatchObject({ lifecycle: "CANCELLED", legacy_decision: "SKIPPED", disposition: "CANCELLED" });

    const taken = await createDraft(await db.bootstrapAccount(OWNER));
    await lock(taken.tradeId);
    await legacyDecision(taken.proposalId, "TAKEN");
    expect(await ledger(taken.tradeId)).toMatchObject({ lifecycle: "LOCKED", legacy_decision: "TAKEN" });
  });

  it("reports UNCHECKED drafts, legacy notes and completed AI reviews", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.admin();
    const evaluation = randomUUID();
    const proposalId = randomUUID();
    const tradeId = randomUUID();
    await db.query("insert into public.risk_evaluations(id, user_id, account_id, proposal, result) values ($1, $2, $3, $4::jsonb, '{}'::jsonb)", [evaluation, OWNER, a.accountId, JSON.stringify(proposal(a))]);
    await db.query("insert into public.setup_proposals(id, user_id, account_id, strategy_version_id, instrument_version_id, risk_evaluation_id, proposal, request_key) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
      [proposalId, OWNER, a.accountId, a.strategyId, a.instrumentId, evaluation, JSON.stringify(proposal(a)), randomUUID()]);
    await db.query("insert into public.trades(id, user_id, account_id, origin) values ($1, $2, $3, 'PLANNED')", [tradeId, OWNER, a.accountId]);
    await db.query("insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id) values ($1, $2, 1, $3, $4)", [proposalId, tradeId, OWNER, a.accountId]);
    expect(await ledger(tradeId)).toMatchObject({ lifecycle: "DRAFT", draft_check: "UNCHECKED", latest_check_decision: null, planned_quantity: null, planned_rr: "3" });
    const { tradeId: closedTrade, planId } = await lockedTrade(a);
    await enter(closedTrade);
    await closePlanned(closedTrade);
    await db.query("select public.append_plan_note($1, 'Legacy journal note', $2)", [planId, randomUUID()]);
    await db.query("select public.tag_journal_trade($1, 'A', null, null)", [planId]);
    await db.admin();
    const review = randomUUID();
    await db.query("insert into public.trade_ai_reviews(id, user_id, account_id, plan_id, facts, input_hash, operation, contract) values ($1, $2, $3, $4, '{}', $5, '{\"id\":\"REVIEW_TRADE\"}', '{}')", [review, OWNER, a.accountId, planId, sha("e")]);
    await db.query("insert into public.trade_ai_review_results(review_id, user_id, account_id, status, interpretation) values ($1, $2, $3, 'COMPLETED', '{}')", [review, OWNER, a.accountId]);
    const failed = randomUUID();
    await db.query("insert into public.trade_ai_reviews(id, user_id, account_id, plan_id, facts, input_hash, operation, contract) values ($1, $2, $3, $4, '{}', $5, '{\"id\":\"REVIEW_TRADE\"}', '{}')", [failed, OWNER, a.accountId, planId, sha("f")]);
    await db.query("insert into public.trade_ai_review_results(review_id, user_id, account_id, status, error_code) values ($1, $2, $3, 'FAILED', 'INVALID_OUTPUT')", [failed, OWNER, a.accountId]);
    await journal(closedTrade, "LESSON", "Wait for displacement");
    expect(await ledger(closedTrade)).toMatchObject({ journal_count: 2, ai_review_count: 1, tag_source: "V1", setup_grade: "A" });
  });
});

describe("access control", () => {
  it.each(Object.entries(USER_RPCS))("denies anon and service_role execution of %s", async (name, types) => {
    for (const role of ["anon", "service_role"] as const) {
      await db.actor(role === "anon" ? "" : OWNER, role);
      await expect(db.query(nullCall(name, types)), role).rejects.toThrow(/permission denied for function/);
    }
  });

  it("allows only the trusted server to register evidence", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await db.actor(OWNER, role);
      await expect(db.query("select public.register_trade_evidence(null::uuid, null::jsonb)"), role).rejects.toThrow(/permission denied for function/);
    }
    await db.actor(OWNER);
    expect(await value<string>("select public.trading_os_schema() as value")).toBe("2.0");
  });

  it("denies every RPC on another user's account, trade, evidence and losses", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    const locked = await lockedTrade(a);
    const live = await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" });
    const evidence = evidenceRecord(draft.tradeId);
    await registerEvidence(evidence);
    await db.actor(OWNER);
    const loss = await value<string>("select public.add_external_loss($1, '10', null, $2) as value", [a.accountId, randomUUID()]);
    const theirs = await db.bootstrapAccount(OTHER);
    const attempts: [string, unknown[], RegExp][] = [
      ["select public.update_account_profile($1, '{\"status\":\"ARCHIVED\"}'::jsonb)", [a.accountId], /^ACCOUNT_NOT_FOUND:/],
      ["select public.create_instrument_version($1, '{}'::jsonb)", [a.accountId], /^ACCOUNT_NOT_FOUND:/],
      ["select public.record_account_values($1, '1', '1')", [a.accountId], /^ACCOUNT_NOT_FOUND:/],
      ["select public.create_planned_trade($1, $2::jsonb, $3, $4, $5)", [a.accountId, JSON.stringify(proposal(a)), randomUUID(), a.riskId, a.observationId], /^ACCOUNT_NOT_FOUND:/],
      ["select public.create_planned_trade($1, $2::jsonb, $3, $4, $5)", [theirs.accountId, JSON.stringify(proposal(a)), randomUUID(), theirs.riskId, theirs.observationId], /^INVALID_INPUT: instrumentId/],
      ["select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5)", [draft.tradeId, JSON.stringify(proposal(a)), randomUUID(), a.riskId, a.observationId], /^TRADE_NOT_FOUND:/],
      ["select public.duplicate_trade_draft($1, $2, $3, $4)", [locked.tradeId, randomUUID(), theirs.riskId, theirs.observationId], /^TRADE_NOT_FOUND:/],
      ["select public.discard_trade_draft($1, null, null)", [draft.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.check_trade_risk($1)", [draft.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.lock_trade($1, 1)", [draft.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [locked.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.close_planned_trade($1, '1.1', clock_timestamp(), '0')", [locked.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.set_planned_disposition($1, 'SKIPPED', 'x')", [locked.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.complete_trade_review($1, null)", [locked.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.reopen_trade_review($1, null, null)", [locked.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.record_live_trade($1, '{\"symbol\":\"XAUUSD\",\"direction\":\"LONG\"}'::jsonb, $2)", [a.accountId, randomUUID()], /^ACCOUNT_NOT_FOUND:/],
      ["select public.complete_live_entry($1, '{\"entryPrice\":\"1\"}'::jsonb, $2)", [live, randomUUID()], /^TRADE_NOT_FOUND:/],
      ["select public.close_live_trade($1, '{}'::jsonb)", [live], /^TRADE_NOT_FOUND:/],
      ["select public.add_journal_entry($1, 'NOTE', 'x', '{}'::jsonb, $2)", [draft.tradeId, randomUUID()], /^TRADE_NOT_FOUND:/],
      ["select public.remove_trade_evidence($1)", [evidence.id], /^EVIDENCE_NOT_FOUND:/],
      ["select public.relabel_trade_evidence($1, 'HTF', null, null)", [evidence.id], /^EVIDENCE_NOT_FOUND:/],
      ["select public.set_trade_tags($1, 'A', null, null, '{}'::text[])", [draft.tradeId], /^TRADE_NOT_FOUND:/],
      ["select public.add_external_loss($1, '10', null, $2)", [a.accountId, randomUUID()], /^ACCOUNT_NOT_FOUND:/],
      ["select public.remove_external_loss($1, null)", [loss], /^EXTERNAL_LOSS_NOT_FOUND:/],
      ["select public.create_risk_policy_version($1, '{}'::jsonb, false, null)", [a.accountId], /^ACCOUNT_NOT_FOUND:/],
    ];
    await db.actor(OTHER);
    for (const [sql, params, error] of attempts) await expect(db.query(sql, params), sql).rejects.toThrow(error);
    for (const table of ["trades", "trade_lifecycle_events", "trade_journal_entries", "trade_evidence_removals", "trade_evidence_labels", "trade_tag_sets", "external_loss_removals", "trade_position_facts"]) {
      expect(await count(`select 1 from public.${table}`), table).toBe(0);
    }
    expect(await count("select 1 from public.trade_evidence")).toBe(0);
  });

  it("denies direct writes to V2 tables and keeps rows immutable even for the owner role", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await expect(db.query("insert into public.trades(user_id, account_id, origin) values ($1, $2, 'PLANNED')", [OWNER, a.accountId])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.trades set origin = 'IMPORTED' where id = $1", [draft.tradeId])).rejects.toThrow(/permission denied/);
    await db.admin();
    await expect(db.query("update public.trades set origin = 'IMPORTED' where id = $1", [draft.tradeId])).rejects.toThrow(/Immutable/);
    await expect(db.query("delete from public.trade_revisions where trade_id = $1", [draft.tradeId])).rejects.toThrow(/Immutable/);
  });
});
