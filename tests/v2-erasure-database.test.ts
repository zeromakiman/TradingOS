import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, migrationFiles, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §10.4 and §10.1: purge_user_trading_data (service role only), the scoped DELETE exception in
// private.reject_mutation, the foreign-key lookup indexes, the TRUNCATE guards and the final privilege hygiene of
// 0019_account_erasure.sql, against every migration present. Fixtures are written like a database that is upgraded in
// production: V1 history through the V1 write paths before 0015 (whose backfill wraps it into trades), V2 records
// through the V2 RPCs before 0019 (which closes some V1 entry points).

// A pinned clock (PGlite reads the JS Date): no run crosses 00:00 UTC−5, where the account values the seed records
// would turn stale before the locks that follow. stepped() still gives every statement its own instant.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
});
afterAll(() => { vi.useRealTimers(); });

const PHRASE = "ERASE ALL MY TRADING OS DATA";
const HASH = "b".repeat(64);
const SHA = "a".repeat(64);
const HAS_CONNECTIONS = migrationFiles().some((name) => name.startsWith("0017_"));
const HAS_TIMELINE_REVIEWS = migrationFiles().some((name) => name.startsWith("0018_"));
// Every tenant table that seedV1() and seedV2() (or the 0015 backfill) write at least one row to, for both users.
const SEEDED_TABLES = [
  "account_observations", "account_profiles", "accounts", "ai_analysis_attempts", "ai_preference_events", "ai_request_dispatches",
  "ai_request_reservations", "ai_uncertainty_resolutions", "ai_usage_records", "bias_challenge_results", "bias_challenges",
  "bootstrap_requests", "chart_assets", "configuration_events", "daily_contexts", "experiment_reviews", "external_loss_entries",
  "external_loss_removals", "instrument_versions", "monthly_ai_review_results", "monthly_ai_reviews", "plan_chart_assets",
  "recent_ai_analyses", "recent_ai_analysis_results", "risk_evaluations", "risk_plan_versions", "setup_evaluation_events",
  "setup_evaluation_passes", "setup_evaluation_screenshots", "setup_evaluations", "setup_human_decisions", "setup_locks",
  "setup_proposals", "setup_risk_checks", "setup_screenshot_removals", "setup_screenshots", "strategy_experiments",
  "strategy_versions", "trade_ai_review_results", "trade_ai_reviews", "trade_dispositions", "trade_events", "trade_evidence",
  "trade_evidence_labels", "trade_evidence_removals", "trade_executions", "trade_journal_entries", "trade_lifecycle_events",
  "trade_outcomes", "trade_plan_links", "trade_plans", "trade_position_facts", "trade_reviews", "trade_revisions",
  "trade_tag_revisions", "trade_tag_sets", "trade_unplanned_closes", "trades", "weekly_ai_review_results", "weekly_ai_reviews",
  ...(HAS_CONNECTIONS
    ? ["external_execution_closes", "external_executions", "platform_connection_events", "platform_connections", "trade_execution_links"]
    : []),
  ...(HAS_TIMELINE_REVIEWS ? ["trade_timeline_review_results", "trade_timeline_reviews"] : []),
];
const V1_ENTRY_POINTS = [
  "public.lock_trade_plan(uuid,jsonb,uuid,uuid,uuid)", "public.evaluate_trade_plan(uuid,jsonb,uuid,uuid)", "public.import_locked_setup(uuid)",
  "public.create_risk_version(uuid,jsonb,boolean,text)", "public.record_observation(uuid,text,text,text)", "public.record_setup_decision(uuid,text,text)",
];

type Json = Record<string, unknown>;
type Counts = Record<string, number>;
interface PurgeResult { storagePaths: { legacy: string[]; evidence: string[] }; deleted: Counts }
interface Seeded { v1Account: string; v2Account: string; connection: string | null; legacyPaths: string[]; evidencePaths: string[] }

async function value<T>(db: TestDatabase, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}

async function tenantTables(db: TestDatabase): Promise<string[]> {
  await db.admin();
  const { rows } = await db.query<{ name: string }>(`
    select c.relname as name from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped)
     order by 1`);
  return rows.map((r) => r.name);
}

async function counts(db: TestDatabase, user: string): Promise<Counts> {
  const result: Counts = {};
  for (const table of await tenantTables(db)) {
    result[table] = await value<number>(db, `select count(*)::int as value from public.${table} where user_id = $1`, [user]);
  }
  return result;
}

/** Rows outside every tenant table: global configuration, the strategy template, storage objects, auth users. */
async function globalState(db: TestDatabase): Promise<Json> {
  await db.admin();
  return (await db.query<Json>(`select (select count(*)::int from public.evaluator_versions) as evaluators,
    (select count(*)::int from private.strategy_templates) as templates, (select count(*)::int from storage.objects) as objects,
    (select count(*)::int from auth.users) as users`)).rows[0];
}

async function receipts(db: TestDatabase): Promise<{ table_counts: Counts; erased_at: string }[]> {
  await db.admin();
  return (await db.query<{ table_counts: Counts; erased_at: string }>(
    "select table_counts, erased_at::text from private.erasure_receipts order by erased_at, id")).rows;
}

/**
 * PostgREST's JSON claims (request.jwt.claims) of an ordinary browser login `ageSeconds` ago, as GoTrue's amr claim
 * records it: exactly what a password re-authentication carries too.
 */
function claims(user: string, ageSeconds = 0): Json {
  return { sub: user, role: "authenticated", amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - ageSeconds }] };
}

/** SQL that makes the rest of a rolledBack() transaction act as `user` signed in a moment ago. */
const signedIn = (user: string) =>
  `select set_config('request.jwt.claim.sub', '${user}', true); select set_config('request.jwt.claims', '${JSON.stringify(claims(user))}', true);`;

/** The trusted server's call (secret key: service_role, no user in the token) after re-authenticating `user`. */
const PURGE_AS_SERVER = (user: string, phrase = PHRASE) =>
  `select set_config('request.jwt.claim.sub', '', true); select public.purge_user_trading_data('${user}', '${phrase}');`;

async function purge(db: TestDatabase, user: string | null, phrase: string | null = PHRASE): Promise<PurgeResult> {
  await db.actor("", "service_role");
  return value<PurgeResult>(db, "select public.purge_user_trading_data($1, $2) as value", [user, phrase]);
}

/** Advances the pinned clock by a millisecond before every statement, so rows keep distinct, ordered timestamps. */
function stepped(db: TestDatabase): TestDatabase {
  const query = db.query.bind(db);
  const exec = db.exec.bind(db);
  db.query = ((sql: string, params?: unknown[]) => {
    vi.advanceTimersByTime(1);
    return query(sql, params);
  }) as TestDatabase["query"];
  db.exec = (sql: string) => {
    vi.advanceTimersByTime(1);
    return exec(sql);
  };
  return db;
}

/** Runs statements inside a transaction that is always rolled back; resolves to the error message, if any. */
async function rolledBack(db: TestDatabase, sql: string): Promise<string | null> {
  try {
    await db.exec(`begin; ${sql}`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await db.exec("rollback");
  }
}

async function currentContext(db: TestDatabase, accountId: string): Promise<{ risk: string; observation: string; instrument: string }> {
  await db.admin();
  return (await db.query<{ risk: string; observation: string; instrument: string }>(`
    select (select id from public.risk_plan_versions where account_id = $1 order by effective_day desc, created_at desc, id desc limit 1) as risk,
           (select id from public.account_observations where account_id = $1 order by recorded_at desc, id desc limit 1) as observation,
           (select id from public.instrument_versions where account_id = $1 and symbol = 'EURUSD' order by created_at, id limit 1) as instrument`,
    [accountId])).rows[0];
}

const proposal = (instrumentId: string, entry: string, stop: string, target: string) => JSON.stringify({
  instrumentId, direction: "LONG", model: "OB_FIRST_TOUCH", entry, stop, target, riskPercent: "0.5",
  narrative: "Synthetic erasure setup", contractConfirmed: true, news: "CLEAR", contradiction: false,
});

/** A platform position imported open and later closed (0017): connection, events, execution, close, link, IMPORTED trade. */
async function seedConnection(db: TestDatabase, user: string, accountId: string): Promise<string> {
  await db.actor(user);
  const connection = await value<string>(db, "select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [accountId, randomUUID()]);
  const execution = {
    externalId: "MOCK-1001", symbol: "EURUSD", direction: "LONG", volume: "0.10", entryPrice: "1.10000",
    enteredAt: new Date(Date.now() - 60 * 60_000).toISOString(), currency: "USD",
  };
  const closed = { ...execution, exitPrice: "1.10100", exitedAt: new Date(Date.now() - 30 * 60_000).toISOString(), commission: "0", swap: "0", realizedPnl: "10.00" };
  await db.actor(user, "service_role");
  for (const [payload, outcome] of [[execution, "CREATED"], [closed, "CLOSED"]] as const) {
    const result = await value<{ outcome: string }>(db, "select public.ingest_external_execution($1, $2, $3::jsonb, $4::jsonb) as value",
      [user, connection, JSON.stringify(payload), JSON.stringify({ kind: "CREATE" })]);
    expect(result.outcome).toBe(outcome);
  }
  // Sealed provider credentials (unused in V2) go with their connection.
  await db.admin();
  await db.query("insert into private.platform_connection_secrets(connection_id, sealed) values ($1, decode('00', 'hex'))", [connection]);
  return connection;
}

interface V1History { v1Account: string; legacyPaths: string[] }

/**
 * V1 history of `user`, written before 0015 like a production database that ran V1: the V1 write paths through their
 * RPCs, the trusted server's direct inserts as service_role, and reserved or AI history tables through admin inserts.
 * 0015's backfill then wraps every plan and unlocked proposal into a trade.
 */
async function seedV1(db: TestDatabase, user: string): Promise<V1History> {
  const legacyPaths: string[] = [];
  const v1 = await db.bootstrapAccount(user);
  const v1Account = v1.accountId;
  await db.actor(user);
  await db.query("select public.create_risk_version($1, $2::jsonb, true, 'Synthetic erasure seed')", [v1Account,
    JSON.stringify({ maxRiskPercent: "0.5", maxDailyTrades: 20, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null })]);
  await db.query("select public.save_daily_context($1, 'Synthetic context')", [v1Account]);
  const ctx = await currentContext(db, v1Account);
  const lockV1 = async (entry: string, stop: string, target: string): Promise<string> => {
    await db.actor(user);
    const result = await value<{ planId: string | null }>(db, "select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5) as value",
      [v1Account, proposal(ctx.instrument, entry, stop, target), randomUUID(), ctx.risk, ctx.observation]);
    expect(result.planId).toBeTruthy();
    return String(result.planId);
  };
  const plan1 = await lockV1("1.10000", "1.09800", "1.10600");
  await db.query("select public.append_plan_note($1, 'Synthetic note', $2)", [plan1, randomUUID()]);
  await db.query("select public.tag_journal_trade($1, 'A', 'PDH', 'M5')", [plan1]);
  await db.query("select public.open_journal_trade($1, '1.10000', '0.25', clock_timestamp())", [plan1]);
  await db.query("select public.close_journal_trade($1, '1.10600', clock_timestamp(), '0')", [plan1]);
  const plan2 = await lockV1("1.20000", "1.19800", "1.20600");
  await db.query("select public.set_journal_disposition($1, 'SKIPPED', 'Synthetic skip')", [plan2]);
  const saveProposal = async (entry: string, stop: string, target: string): Promise<string> => {
    await db.actor(user);
    return value<string>(db, "select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [v1Account, proposal(ctx.instrument, entry, stop, target), randomUUID(), ctx.risk, ctx.observation]);
  };
  const p3 = await saveProposal("1.30000", "1.29800", "1.30600");
  const images: string[] = [];
  for (const role of ["H4", "M5"]) {
    const id = randomUUID();
    const path = `${user}/${p3}/${id}`;
    await db.actor(user, "service_role");
    await db.query(`insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type,
      byte_size, sha256, width, height) values ($1, $2, $3, $4, $5, $6, 'chart.png', 'image/png', 2048, $7, 64, 64)`, [id, user, v1Account, p3, role, path, SHA]);
    await db.admin();
    await db.query("insert into storage.objects(bucket_id, name) values ('setup-screenshots', $1)", [path]);
    images.push(id);
    legacyPaths.push(path);
  }
  const evaluation = randomUUID();
  await db.actor(user, "service_role");
  await db.query("select public.start_setup_evaluation($1::jsonb, array[$2]::uuid[])", [JSON.stringify({
    id: evaluation, user_id: user, proposal_id: p3, evaluator_version: "ERASURE_TEST_V1", mode: "NORMAL", model: "synthetic-model",
    manifest: {}, input_hash: HASH, deadline_at: new Date(Date.now() + 10 * 60_000).toISOString() }), images[0]]);
  await db.query("insert into public.setup_evaluation_passes(id, user_id, account_id, evaluation_id, stage, status, model, output) values ($1, $2, $3, $4, 'A', 'VALID', 'synthetic-model', '{}')",
    [randomUUID(), user, v1Account, evaluation]);
  await db.query("select public.finish_setup_evaluation($1, 'COMPLETED', '{\"result\":{\"decision\":\"APPROVED\"}}'::jsonb)", [evaluation]);
  await db.actor(user);
  await db.query("select public.remove_setup_screenshot($1)", [images[1]]);
  await db.query("select public.record_setup_decision($1, 'SKIPPED', 'Synthetic decision')", [p3]);
  const p4 = await saveProposal("1.40000", "1.39800", "1.40600");
  const locked = await value<{ planId: string | null }>(db, "select public.check_setup_risk($1, true) as value", [p4]);
  expect(locked.planId).toBeTruthy();
  await db.query("select public.set_account_ai_preferences($1, true, 1000, true)", [v1Account]);

  // AI history and reserved V1 tables (no user-facing writer, or a trusted-server flow outside this test's scope).
  await db.admin();
  const strategy = await value<string>(db, "select id as value from public.strategy_versions where account_id = $1", [v1Account]);
  const challenge = randomUUID();
  const review = randomUUID();
  const settled = randomUUID();
  const uncertain = randomUUID();
  await db.query("insert into public.bias_challenges(id, user_id, account_id, proposal_id, facts, input_hash, operation, contract) values ($1, $2, $3, $4, '{}', $5, '{\"id\":\"CHALLENGE_BIAS\"}', '{}')",
    [challenge, user, v1Account, p3, HASH]);
  await db.query("insert into public.trade_ai_reviews(id, user_id, account_id, plan_id, facts, input_hash, operation, contract) values ($1, $2, $3, $4, '{}', $5, '{\"id\":\"REVIEW_TRADE\"}', '{}')",
    [review, user, v1Account, plan1, HASH]);
  for (const [id, operation, operationId] of [[settled, "CHALLENGE_BIAS", challenge], [uncertain, "REVIEW_TRADE", review]]) {
    await db.query(`insert into public.ai_request_reservations(id, user_id, account_id, operation, operation_id, stage, request_hash, provider, model,
      pricing, reserved_micros, period) values ($1, $2, $3, $4, $5, 'A', $6, 'openai', 'synthetic-model', '{}', 1000, date_trunc('month', clock_timestamp())::date)`,
      [id, user, v1Account, operation, operationId, HASH]);
    await db.query("insert into public.ai_request_dispatches(reservation_id, user_id, account_id) values ($1, $2, $3)", [id, user, v1Account]);
  }
  await db.query("insert into public.ai_usage_records(reservation_id, user_id, account_id, disposition, charged_micros, input_tokens, output_tokens, usage) values ($1, $2, $3, 'SETTLED', 500, 10, 5, '{}')",
    [settled, user, v1Account]);
  await db.query("insert into public.ai_usage_records(reservation_id, user_id, account_id, disposition, charged_micros, error_code) values ($1, $2, $3, 'UNCERTAIN', 1000, 'TIMEOUT')",
    [uncertain, user, v1Account]);
  await db.query("insert into public.bias_challenge_results(challenge_id, user_id, account_id, status, interpretation, reservation_id) values ($1, $2, $3, 'COMPLETED', '{}', $4)",
    [challenge, user, v1Account, settled]);
  await db.query("insert into public.trade_ai_review_results(review_id, user_id, account_id, status, error_code, reservation_id) values ($1, $2, $3, 'FAILED', 'TIMEOUT', $4)",
    [review, user, v1Account, uncertain]);
  await db.query(`insert into public.ai_uncertainty_resolutions(id, reservation_id, user_id, account_id, decision, reason, evidence_ref, resolver,
    original_charged_micros, reconciled_micros, released_micros, additional_micros, details)
    values ($1, $2, $3, $4, 'KEEP_UNCERTAIN', 'Synthetic operator review', 'ticket-1', 'operator', 1000, 1000, 0, 0, '{}')`, [randomUUID(), uncertain, user, v1Account]);
  const weekly = randomUUID();
  const recent = randomUUID();
  const monthly = randomUUID();
  await db.query("insert into public.weekly_ai_reviews(id, user_id, account_id, week_start, facts, input_hash, operation, contract) values ($1, $2, $3, '2026-09-07', '{}', $4, '{\"id\":\"WEEKLY_REVIEW\"}', '{}')",
    [weekly, user, v1Account, HASH]);
  await db.query(`insert into public.recent_ai_analyses(id, user_id, account_id, requested_sample, actual_sample, trade_ids, captured_at, facts, input_hash, operation, contract)
    values ($1, $2, $3, 10, 1, array[$4]::uuid[], clock_timestamp(), '{}', $5, '{"id":"RECENT_TRADES_ANALYSIS"}', '{}')`, [recent, user, v1Account, plan1, HASH]);
  await db.query(`insert into public.monthly_ai_reviews(id, user_id, account_id, month_start, period_start, period_end_exclusive, trade_ids, sample_size, facts,
    input_hash, operation, contract) values ($1, $2, $3, '2026-09-01', ('2026-09-01'::timestamp + interval '5 hours') at time zone 'UTC',
    ('2026-09-01'::timestamp + interval '1 month 5 hours') at time zone 'UTC', array[$4]::uuid[], 1, '{}', $5, '{"id":"MONTHLY_REVIEW"}', '{}')`,
    [monthly, user, v1Account, plan1, HASH]);
  for (const [table, id] of [["weekly_ai_review_results", weekly], ["recent_ai_analysis_results", recent], ["monthly_ai_review_results", monthly]]) {
    await db.query(`insert into public.${table}(review_id, user_id, account_id, status, error_code) values ($1, $2, $3, 'FAILED', 'MOCK_FAILURE')`, [id, user, v1Account]);
  }
  const asset = randomUUID();
  const experiment = randomUUID();
  await db.query("insert into public.chart_assets(id, user_id, account_id, object_key, sha256, timeframe, mime_type, byte_size) values ($1, $2, $3, $4, $5, 'M5', 'image/png', 10)",
    [asset, user, v1Account, `reserved/${asset}`, SHA]);
  await db.query("insert into public.plan_chart_assets(user_id, account_id, plan_id, asset_id) values ($1, $2, $3, $4)", [user, v1Account, plan1, asset]);
  await db.query(`insert into public.ai_analysis_attempts(user_id, account_id, strategy_version_id, stage, provider, model, prompt_version, schema_version,
    input_manifest, status) values ($1, $2, $3, 'A', 'openai', 'synthetic-model', 'v1', 's1', '{}', 'FAILED')`, [user, v1Account, strategy]);
  await db.query("insert into public.trade_reviews(user_id, account_id, plan_id, financial_result, process_result) values ($1, $2, $3, '{}', '{}')", [user, v1Account, plan1]);
  await db.query(`insert into public.strategy_experiments(id, user_id, account_id, original_strategy_version_id, experimental_strategy_version_id, hypothesis,
    original_rule, experimental_rule, start_date) values ($1, $2, $3, $4, $4, 'h', 'o', 'e', '2026-09-01')`, [experiment, user, v1Account, strategy]);
  await db.query("insert into public.experiment_reviews(user_id, account_id, experiment_id, sample_size, results, decision) values ($1, $2, $3, 0, '{}', 'KEEP_TESTING')",
    [user, v1Account, experiment]);
  return { v1Account, legacyPaths: legacyPaths.sort() };
}

/** V2 records of `user` through the 0015-0018 RPCs: the migrated V1 account's profile, a V2 account and its trades. */
async function seedV2(db: TestDatabase, user: string, history: V1History): Promise<Seeded> {
  const { v1Account } = history;
  const evidencePaths: string[] = [];
  await db.actor(user);
  await db.query("select public.update_account_profile($1, '{\"broker\":\"Synthetic broker\"}'::jsonb)", [v1Account]);
  const v2Account = await value<string>(db, "select public.create_trading_account($1, $2::jsonb) as value", [randomUUID(),
    JSON.stringify({ name: "Synthetic funded", currency: "USD", accountType: "FUNDED", platform: "MT5", balance: "10000", equity: "10000" })]);
  await db.query("select public.create_risk_policy_version($1, $2::jsonb, true, 'Synthetic erasure seed')", [v2Account, JSON.stringify({
    maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 20, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN" })]);
  await db.query("select public.create_instrument_version($1, $2::jsonb)", [v2Account, JSON.stringify({
    symbol: "XAUUSD", quantityUnit: "oz", tickSize: "0.01", tickValue: "0.01", quantityStep: "1", minimumQuantity: "1" })]);
  await db.query("select public.record_account_values($1, '10000', '10000')", [v2Account]);
  const ctx = await currentContext(db, v2Account);
  await db.actor(user);
  const draft = await value<{ tradeId: string }>(db, "select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [v2Account, proposal(ctx.instrument, "1.10000", "1.09800", "1.10600"), randomUUID(), ctx.risk, ctx.observation]);
  const trade = draft.tradeId;
  await db.query("select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5)",
    [trade, proposal(ctx.instrument, "1.10100", "1.09900", "1.10700"), randomUUID(), ctx.risk, ctx.observation]);
  const evidence: string[] = [];
  for (const label of ["PRE_ENTRY", "CONTEXT"]) {
    const id = randomUUID();
    await db.actor(user, "service_role");
    await db.query("select public.register_trade_evidence($1, $2::jsonb)", [user, JSON.stringify({
      id, tradeId: trade, label, timeframe: "M5", originalFilename: "evidence.png", mimeType: "image/png", byteSize: 2048, sha256: SHA,
      width: 64, height: 64, captureMethod: "PASTE" })]);
    await db.admin();
    await db.query("insert into storage.objects(bucket_id, name) values ('trade-evidence', $1)", [`${user}/${trade}/${id}`]);
    evidence.push(id);
    evidencePaths.push(`${user}/${trade}/${id}`);
  }
  await db.actor(user);
  await db.query("select public.relabel_trade_evidence($1, 'HTF', 'H4', 'Synthetic caption')", [evidence[0]]);
  await db.query("select public.remove_trade_evidence($1)", [evidence[1]]);
  await db.query("select public.set_trade_tags($1, 'A', 'PDH', 'M5', array['synthetic'])", [trade]);
  const copy = await value<{ tradeId: string }>(db, "select public.duplicate_trade_draft($1, $2, $3, $4) as value", [trade, randomUUID(), ctx.risk, ctx.observation]);
  await db.query("select public.discard_trade_draft($1, 'Synthetic discard', $2)", [copy.tradeId, randomUUID()]);
  const lock = await value<{ planId: string | null }>(db, "select public.lock_trade($1, 2) as value", [trade]);
  expect(lock.planId).toBeTruthy();
  await db.query("select public.record_planned_entry($1, '1.10100', '0.25', clock_timestamp())", [trade]);
  await db.query("select public.close_planned_trade($1, '1.10700', clock_timestamp(), '0')", [trade]);
  await db.query("select public.complete_trade_review($1, $2)", [trade, randomUUID()]);
  await db.query("select public.add_journal_entry($1, 'LESSON', 'Synthetic lesson', '{}'::jsonb, $2)", [trade, randomUUID()]);
  const live = await value<string>(db, "select public.record_live_trade($1, $2::jsonb, $3) as value", [v2Account,
    JSON.stringify({ instrumentId: ctx.instrument, direction: "SHORT", entryPrice: "1.20000", quantity: "0.10" }), randomUUID()]);
  await db.query("select public.complete_live_entry($1, '{\"initialStop\":\"1.20200\"}'::jsonb, $2)", [live, randomUUID()]);
  await db.query("select public.close_live_trade($1, $2::jsonb)", [live, JSON.stringify({ exitPrice: "1.19900", exitedAt: new Date().toISOString() })]);
  const loss = await value<string>(db, "select public.add_external_loss($1, '12.50', 'Synthetic loss', $2) as value", [v2Account, randomUUID()]);
  await db.query("select public.remove_external_loss($1, 'Synthetic removal')", [loss]);

  const connection = HAS_CONNECTIONS ? await seedConnection(db, user, v2Account) : null;
  if (HAS_TIMELINE_REVIEWS) {
    await db.admin();
    const timelineReview = randomUUID();
    await db.query(`insert into public.trade_timeline_reviews(id, user_id, account_id, trade_id, facts, input_hash, operation, contract)
      values ($1, $2, $3, $4, '{}', $5, '{"id":"REVIEW_TRADE_TIMELINE"}', '{}')`, [timelineReview, user, v2Account, live, HASH]);
    await db.query("insert into public.trade_timeline_review_results(review_id, user_id, account_id, status, error_code) values ($1, $2, $3, 'FAILED', 'MOCK_FAILURE')",
      [timelineReview, user, v2Account]);
  }
  return { v1Account, v2Account, connection, legacyPaths: history.legacyPaths, evidencePaths: evidencePaths.sort() };
}

/**
 * Grants that Supabase's default privileges leave behind on objects whose migrations revoked only some roles (V1
 * tables keep service_role ALL, journal_analytics keeps authenticated/service_role ALL, V1 sequences keep every
 * role). Applied before 0019 so its hygiene is proven whether or not the harness emulates default privileges.
 */
const SUPABASE_DEFAULT_LEFTOVERS = `
  grant all on all tables in schema public to service_role;
  grant all on public.journal_analytics to authenticated;
  grant all on all sequences in schema public to anon, authenticated, service_role;`;

/** V1 history of two users, the V2 migrations, their V2 records, then 0019 (which must be the last migration). */
async function upgradedDatabase(beforeErasure = ""): Promise<{ db: TestDatabase; owner: Seeded; other: Seeded }> {
  const db = stepped(await createTestDatabase());
  await db.applyMigrations({ upTo: "0014" });
  await db.pinSession("ACTIVE_KILL_ZONE");
  await db.admin();
  await db.query("insert into public.evaluator_versions(version, schema_version, system_prompt, json_schema, config, sha256) values ('ERASURE_TEST_V1', '1', 'p', '{}', '{}', $1)", [SHA]);
  const histories = [await seedV1(db, OWNER), await seedV1(db, OTHER)];
  await db.applyMigrations({ upTo: "0018" });
  const owner = await seedV2(db, OWNER, histories[0]);
  const other = await seedV2(db, OTHER, histories[1]);
  await db.admin();
  if (beforeErasure) await db.exec(beforeErasure);
  expect(await db.applyMigrations()).toEqual(["0019_account_erasure.sql"]);
  return { db, owner, other };
}

describe("purge_user_trading_data", () => {
  let db: TestDatabase;
  let owner: Seeded;
  let other: Seeded;
  let ownerBefore: Counts;
  let otherBefore: Counts;
  let globalsBefore: Json;
  let result: PurgeResult;

  beforeAll(async () => {
    ({ db, owner, other } = await upgradedDatabase());
    // A tenant table that did not exist when 0019 ran: the delete order comes from the catalog on every call.
    await db.exec(`create table public.erasure_probe_notes (
        id uuid primary key default gen_random_uuid(), user_id uuid not null, account_id uuid not null, note text not null,
        foreign key (user_id, account_id) references public.accounts(user_id, id));
      create trigger immutable_record before update or delete on public.erasure_probe_notes for each row execute function private.reject_mutation();`);
    for (const [user, account] of [[OWNER, owner.v1Account], [OTHER, other.v1Account]]) {
      await db.query("insert into public.erasure_probe_notes(user_id, account_id, note) values ($1, $2, 'later table')", [user, account]);
    }
    ownerBefore = await counts(db, OWNER);
    otherBefore = await counts(db, OTHER);
    globalsBefore = await globalState(db);
  }, 180_000);
  afterAll(async () => { await db.close(); });

  it("starts from data in every seeded tenant table for both users", () => {
    for (const before of [ownerBefore, otherBefore]) {
      expect(SEEDED_TABLES.filter((table) => !(before[table] > 0))).toEqual([]);
    }
  });

  it("keeps the auth user undeletable while trading data references it", async () => {
    await db.admin();
    expect(await rolledBack(db, `delete from auth.users where id = '${OWNER}';`)).toMatch(/foreign key/);
  });

  it("deletes exactly the user's rows in every table, returns their storage paths and counts, and touches nothing else", async () => {
    result = await purge(db, OWNER);
    expect(Object.keys(result).sort()).toEqual(["deleted", "storagePaths"]);
    expect(result.deleted).toEqual(ownerBefore);
    expect(result.deleted.erasure_probe_notes).toBe(1);
    expect({ legacy: [...result.storagePaths.legacy].sort(), evidence: [...result.storagePaths.evidence].sort() })
      .toEqual({ legacy: owner.legacyPaths, evidence: owner.evidencePaths });
    expect(Object.entries(await counts(db, OWNER)).filter(([, n]) => n > 0)).toEqual([]);
    expect(await counts(db, OTHER)).toEqual(otherBefore);
    // Storage objects stay until the trusted server deletes them through the Storage API.
    expect(await globalState(db)).toEqual(globalsBefore);
  });

  it.runIf(HAS_CONNECTIONS)("removes the caller's sealed connection credentials with their connection only", async () => {
    await db.admin();
    const secrets = await db.query<{ connection_id: string }>("select connection_id from private.platform_connection_secrets order by 1");
    expect(secrets.rows.map((r) => r.connection_id)).toEqual([other.connection]);
  });

  it("clears the erase flag before it returns, inside the caller's own transaction", async () => {
    // A transaction-local setting vanishes with its transaction: only a check within the purge's transaction counts.
    const flagCheck = "do $$ begin if coalesce(current_setting('trading_os.erase_user_id', true), '') <> '' then raise exception 'ERASE_FLAG_LEFT_SET'; end if; end $$;";
    await db.actor("", "service_role");
    expect(await rolledBack(db, `select set_config('trading_os.erase_user_id', '${OTHER}', true); ${flagCheck}`)).toBe("ERASE_FLAG_LEFT_SET");
    expect(await rolledBack(db, `${PURGE_AS_SERVER(OTHER)} ${flagCheck}`)).toBeNull();
    expect(await counts(db, OTHER)).toEqual(otherBefore);
  });

  it("writes one de-identified receipt that no API role can read", async () => {
    const rows = await receipts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].table_counts).toEqual(result.deleted);
    const raw = await value<string>(db, "select string_agg(r::text, ' ') as value from private.erasure_receipts r");
    expect(raw).not.toContain(OWNER);
    expect(raw).not.toContain("@example.test");
    for (const role of ["authenticated", "service_role"] as const) {
      await db.actor(OWNER, role);
      await expect(db.query("select * from private.erasure_receipts"), role).rejects.toThrow(/permission denied/);
    }
  });

  it("is idempotent: a re-run deletes nothing, writes no second receipt and leaves the other user intact", async () => {
    const again = await purge(db, OWNER);
    expect(again.storagePaths).toEqual({ legacy: [], evidence: [] });
    expect(Object.keys(again.deleted).sort()).toEqual(Object.keys(result.deleted).sort());
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    expect(await receipts(db)).toHaveLength(1);
    expect(await counts(db, OTHER)).toEqual(otherBefore);
  });

  it("lets the auth user be deleted afterwards, and the deleted user's token cannot re-create data", async () => {
    await db.admin();
    await db.query("delete from auth.users where id = $1", [OWNER]);
    await db.actor(OWNER);
    await expect(db.query("select public.bootstrap_demo_account($1, 'Ghost', '1000', '1000')", [randomUUID()])).rejects.toThrow(/foreign key/);
    await expect(db.query("select public.create_trading_account($1, $2::jsonb)", [randomUUID(),
      JSON.stringify({ name: "Ghost", currency: "USD", accountType: "DEMO", platform: "MANUAL", balance: "1000", equity: "1000" })])).rejects.toThrow(/foreign key/);
    expect(await counts(db, OTHER)).toEqual(otherBefore);
  });
});

describe("erasure guards", () => {
  let db: TestDatabase;
  let owner: Seeded;
  let ownerBefore: Counts;
  let otherBefore: Counts;

  // Compares the seeded tables only: probe tables created by a test come and go.
  const unchanged = async () => {
    const [ownerNow, otherNow] = [await counts(db, OWNER), await counts(db, OTHER)];
    expect(Object.fromEntries(Object.keys(ownerBefore).map((t) => [t, ownerNow[t]]))).toEqual(ownerBefore);
    expect(Object.fromEntries(Object.keys(otherBefore).map((t) => [t, otherNow[t]]))).toEqual(otherBefore);
  };
  const refresh = async () => {
    ownerBefore = await counts(db, OWNER);
    otherBefore = await counts(db, OTHER);
  };

  beforeAll(async () => {
    ({ db, owner } = await upgradedDatabase(SUPABASE_DEFAULT_LEFTOVERS));
    await refresh();
  }, 180_000);
  // Each test starts from the rows the previous one left, even when it failed halfway: one failure never turns the
  // unchanged() checks of the tests after it red.
  afterEach(async () => { await refresh(); });
  afterAll(async () => { await db.close(); });

  it("never lets the erase flag delete outside the purge, update anything, or reach another user's or global rows", async () => {
    await db.admin();
    const flag = `select set_config('trading_os.erase_user_id', '${OWNER}', true);`;
    expect(await rolledBack(db, `delete from public.daily_contexts where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `${flag} update public.daily_contexts set narrative = 'rewritten' where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `${flag} update public.trades set origin = 'IMPORTED' where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `${flag} delete from public.daily_contexts where user_id = '${OTHER}';`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `${flag} delete from public.evaluator_versions;`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `${flag} delete from private.strategy_templates;`)).toMatch(/^Immutable record/);
    expect(await rolledBack(db, `select set_config('trading_os.erase_user_id', '', true); delete from public.daily_contexts where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    for (const role of ["authenticated", "service_role"] as const) {
      await db.actor(OWNER, role);
      expect(await rolledBack(db, `${flag} delete from public.daily_contexts where user_id = '${OWNER}';`), role).toMatch(/permission denied/);
    }
    await unchanged();
  });

  it("is executable by the service role only: no user token, however fresh its password sign-in, erases anything", async () => {
    // A browser's own login carries exactly the claims of a password re-authentication (amr password, now), so the
    // database cannot tell them apart: the server action re-authenticates and then calls the purge with the secret key.
    await db.admin();
    const grants = (await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] }>(`
      select has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service, p.prosecdef as definer, p.proconfig as config
        from pg_proc p where p.oid = 'public.purge_user_trading_data(uuid, text)'::regprocedure`)).rows[0];
    expect(grants).toEqual({ anon: false, authenticated: false, service: true, definer: true, config: ['search_path=""'] });
    // The self-service purge of the first 0019 draft is gone, and no other erasing function is reachable by a user.
    expect(await value<string | null>(db, "select to_regprocedure('public.purge_my_trading_data(text)')::text as value")).toBeNull();
    const reachable = (await db.query<{ signature: string }>(`
      select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and (p.proname ~ '(purge|eras)' or p.prosrc ~* 'trading_os[.]erase_user_id')
         and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)).rows;
    expect(reachable).toEqual([]);
    for (const age of [0, 60, 4 * 60]) {
      await db.actor(OWNER);
      for (const target of [OWNER, OTHER]) {
        const sql = `select set_config('request.jwt.claims', '${JSON.stringify(claims(OWNER, age))}', true); select public.purge_user_trading_data('${target}', '${PHRASE}');`;
        expect(await rolledBack(db, sql), `login ${age}s ago, target ${target}`).toMatch(/permission denied for function purge_user_trading_data/);
      }
      expect(await rolledBack(db, `${signedIn(OWNER)} select public.purge_my_trading_data('${PHRASE}');`)).toMatch(/function public.purge_my_trading_data\(unknown\) does not exist/);
    }
    await db.anon();
    await expect(db.query("select public.purge_user_trading_data($1, $2)", [OWNER, PHRASE])).rejects.toThrow(/permission denied for function/);
    await expect(purge(db, null)).rejects.toThrow(/^INVALID_INPUT: A user id is required/);
    await unchanged();
  });

  it("rejects anything but the exact confirmation phrase", async () => {
    for (const phrase of ["DELETE", "erase all my trading os data", ` ${PHRASE}`, `${PHRASE}.`, "", null]) {
      await expect(purge(db, OWNER, phrase), String(phrase)).rejects.toThrow(/^CONFIRMATION_REQUIRED:/);
    }
    await unchanged();
  });

  it("refuses while an AI request of the user is still in flight, and ignores reservations older than 30 minutes", async () => {
    await db.admin();
    const insertReservation = (id: string, age: string) => db.query(`insert into public.ai_request_reservations(id, user_id, account_id, operation, operation_id, stage,
      request_hash, provider, model, pricing, reserved_micros, period, created_at)
      values ($1, $2, $3, 'CHALLENGE_BIAS', $4, 'A', $5, 'openai', 'synthetic-model', '{}', 1000, date_trunc('month', clock_timestamp())::date, clock_timestamp() - $6::interval)`,
      [id, OWNER, owner.v1Account, randomUUID(), HASH, age]);
    const inFlight = randomUUID();
    await insertReservation(inFlight, "29 minutes");
    await insertReservation(randomUUID(), "31 minutes");
    await refresh();
    await expect(purge(db, OWNER)).rejects.toThrow(/^AI_REQUEST_IN_PROGRESS:/);
    await unchanged();
    // Settled (here: cancelled) requests no longer block; another user's in-flight request never blocks this user.
    await db.admin();
    await db.query("insert into public.ai_usage_records(reservation_id, user_id, account_id, disposition, charged_micros) values ($1, $2, $3, 'CANCELLED', 0)",
      [inFlight, OWNER, owner.v1Account]);
    await db.query(`insert into public.ai_request_reservations(id, user_id, account_id, operation, operation_id, stage, request_hash, provider, model, pricing,
      reserved_micros, period) select $1, user_id, id, 'CHALLENGE_BIAS', $2, 'A', $3, 'openai', 'synthetic-model', '{}', 1000,
      date_trunc('month', clock_timestamp())::date from public.accounts where user_id = $4 order by id limit 1`, [randomUUID(), randomUUID(), HASH, OTHER]);
    await refresh();
    await db.actor("", "service_role");
    expect(await rolledBack(db, PURGE_AS_SERVER(OWNER))).toBeNull();
    await unchanged();
  });

  it("blocks TRUNCATE on every public table and every immutable private table, even for the table owner", async () => {
    await db.admin();
    const tables = (await db.query<{ name: string; guarded: boolean }>(`
      select n.nspname || '.' || c.relname as name,
             exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'truncate_guard' and t.tgfoid = 'private.reject_truncate()'::regprocedure
                       and t.tgtype & 32 = 32 and t.tgtype & 2 = 2 and t.tgtype & 1 = 0) as guarded
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p')
         and (n.nspname = 'public' or c.oid in ('private.strategy_templates'::regclass, 'private.erasure_receipts'::regclass))
       order by 1`)).rows;
    expect(tables.length).toBeGreaterThanOrEqual(SEEDED_TABLES.length + 3);
    expect(tables.filter((t) => !t.guarded).map((t) => t.name)).toEqual([]);
    for (const { name } of tables) {
      expect(await rolledBack(db, `truncate table ${name} cascade;`), name).toMatch(/^TRUNCATE_FORBIDDEN:/);
    }
    for (const role of ["authenticated", "service_role"] as const) {
      await db.actor(OWNER, role);
      expect(await rolledBack(db, "truncate table public.trades cascade;"), role).toMatch(/permission denied/);
    }
    await unchanged();
  });

  it("leaves service_role only the documented legacy inserts", async () => {
    await db.admin();
    const { rows } = await db.query<{ name: string; privilege: string }>(`
      select c.relname as name, p.privilege
        from pg_class c cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege('service_role', c.oid, p.privilege)
       order by 1, 2`);
    expect(rows).toEqual([
      { name: "evaluator_versions", privilege: "INSERT" },
      { name: "setup_evaluation_passes", privilege: "INSERT" },
    ]);
    await db.actor(OWNER, "service_role");
    await expect(db.query("insert into public.trade_plans(user_id) values ($1)", [OWNER])).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into public.trades(user_id, account_id, origin) values ($1, $2, 'PLANNED')", [OWNER, owner.v2Account])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.setup_screenshots set role = 'H1' where user_id = $1", [OWNER])).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.setup_screenshots where user_id = $1", [OWNER])).rejects.toThrow(/permission denied/);
    await unchanged();
  });

  it("keeps the legacy evaluator's trusted-server writes working, and registers no legacy screenshot any more", async () => {
    await db.admin();
    const target = (await db.query<{ proposal: string; evaluation: string }>(`
      select (select id from public.setup_proposals where account_id = $1 order by created_at limit 1) as proposal,
             (select id from public.setup_evaluations where account_id = $1 limit 1) as evaluation`, [owner.v1Account])).rows[0];
    const screenshot = randomUUID();
    await db.actor(OWNER, "service_role");
    // V2 evidence goes through register_trade_evidence; no code registers V1 screenshots (0019 keeps no insert grant).
    await expect(db.query(`insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size,
      sha256, width, height) values ($1, $2, $3, $4, 'H1', $5, 'chart.png', 'image/png', 1024, $6, 32, 32)`,
      [screenshot, OWNER, owner.v1Account, target.proposal, `${OWNER}/${target.proposal}/${screenshot}`, SHA])).rejects.toThrow(/permission denied for table setup_screenshots/);
    await db.query("insert into public.evaluator_versions(version, schema_version, system_prompt, json_schema, config, sha256) values ('ERASURE_TEST_V1', '1', 'p', '{}', '{}', $1) on conflict (version) do nothing", [SHA]);
    expect(await value<string>(db, "select sha256 as value from public.evaluator_versions where version = 'ERASURE_TEST_V1'")).toBe(SHA);
    await db.query("insert into public.setup_evaluation_passes(id, user_id, account_id, evaluation_id, stage, status, model, output) values ($1, $2, $3, $4, 'B', 'VALID', 'synthetic-model', '{}')",
      [randomUUID(), OWNER, owner.v1Account, target.evaluation]);
  });

  it("leaves anon nothing and authenticated only SELECT on tables, views and sequences", async () => {
    await db.admin();
    const relations = (await db.query<{ name: string; role: string; privilege: string }>(`
      select c.relname as name, r.role, p.privilege from pg_class c
       cross join unnest(array['anon', 'authenticated']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(r.role, c.oid, p.privilege)
       order by 1, 2, 3`)).rows;
    expect(relations.filter((r) => r.role === "anon" || r.privilege !== "SELECT")).toEqual([]);
    const journal = (await db.query<{ role: string; privilege: string }>(`
      select r.role, p.privilege from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege)
       where has_table_privilege(r.role, 'public.journal_analytics', p.privilege)`)).rows;
    expect(journal).toEqual([{ role: "authenticated", privilege: "SELECT" }]);
    const sequences = (await db.query<{ name: string; role: string }>(`
      select c.relname as name, r.role from pg_class c
       cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(privilege)
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.privilege)`)).rows;
    expect(sequences).toEqual([]);
    await db.actor(OWNER);
    expect((await db.query("select id from public.journal_analytics")).rows.length).toBeGreaterThan(0);
    await expect(db.query("select nextval('public.trade_events_sequence_seq')")).rejects.toThrow(/permission denied/);
  });

  it("closes the V1 entry points to every API role while the V2 wrappers keep using them", async () => {
    await db.admin();
    const grants = (await db.query<{ signature: string; executable: boolean }>(`
      select s as signature, has_function_privilege('anon', s::regprocedure, 'EXECUTE') or has_function_privilege('authenticated', s::regprocedure, 'EXECUTE')
             or has_function_privilege('service_role', s::regprocedure, 'EXECUTE') as executable
        from unnest($1::text[]) as s`, [V1_ENTRY_POINTS])).rows;
    expect(grants.filter((g) => g.executable)).toEqual([]);
    const v1 = await currentContext(db, owner.v1Account);
    const plan = await value<string>(db, "select id as value from public.trade_plans where account_id = $1 order by locked_at limit 1", [owner.v1Account]);
    const proposalId = await value<string>(db, "select id as value from public.setup_proposals where account_id = $1 order by created_at limit 1", [owner.v1Account]);
    await db.actor(OWNER);
    const calls: [string, unknown[]][] = [
      ["select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5)", [owner.v1Account, proposal(v1.instrument, "1.5", "1.498", "1.506"), randomUUID(), v1.risk, v1.observation]],
      ["select public.evaluate_trade_plan($1, $2::jsonb, $3, $4)", [owner.v1Account, proposal(v1.instrument, "1.5", "1.498", "1.506"), v1.risk, v1.observation]],
      ["select public.import_locked_setup($1)", [plan]],
      ["select public.create_risk_version($1, '{}'::jsonb, false, null)", [owner.v1Account]],
      ["select public.record_observation($1, '9990', '9990', null)", [owner.v1Account]],
      ["select public.record_setup_decision($1, 'TAKEN', null)", [proposalId]],
    ];
    for (const [sql, params] of calls) {
      await expect(db.query(sql, params), sql).rejects.toThrow(/permission denied for function/);
    }
    // record_account_values wraps record_observation; save_setup_proposal and create_planned_trade use
    // evaluate_trade_plan; lock_trade and check_setup_risk lock through the V1 engine as the functions' owner.
    await db.query("select public.record_account_values($1, '10000', '10000')", [owner.v2Account]);
    const v2 = await currentContext(db, owner.v2Account);
    await db.actor(OWNER);
    const draft = await value<{ tradeId: string }>(db, "select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
      [owner.v2Account, proposal(v2.instrument, "1.15000", "1.14800", "1.15600"), randomUUID(), v2.risk, v2.observation]);
    expect((await value<{ planId: string | null }>(db, "select public.lock_trade($1, 1) as value", [draft.tradeId])).planId).toBeTruthy();
    const legacy = await value<string>(db, "select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [owner.v1Account, proposal(v1.instrument, "1.60000", "1.59800", "1.60600"), randomUUID(), v1.risk, v1.observation]);
    expect((await value<{ planId: string | null }>(db, "select public.check_setup_risk($1, true) as value", [legacy])).planId).toBeTruthy();
  });

  it("indexes every foreign key into a tenant table by columns that identify the referenced row", async () => {
    // Deleting a referenced row searches the referencing table by the foreign-key columns. Unless an index starts with
    // columns that reference a whole unique key, each of the user's deleted rows scans that table (every user's rows)
    // and an active user's erasure outgrows the API statement timeout.
    const unindexed = async () => (await db.query<{ name: string }>(`
      select k.conrelid::regclass::text || ' (' || k.conname || ')' as name
        from pg_constraint k
       where k.contype = 'f'
         and k.confrelid in (select c.oid from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                               and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped))
         and not exists (
           select 1 from pg_index i cross join lateral generate_series(1, i.indnkeyatts) as p(len)
            where i.indrelid = k.conrelid and i.indisvalid and i.indpred is null
              and (i.indkey::int2[])[0:p.len - 1] <@ k.conkey
              and exists (select 1 from pg_index u
                           where u.indrelid = k.confrelid and u.indisunique and u.indpred is null and u.indexprs is null
                             and (u.indkey::int2[])[0:u.indnkeyatts - 1]
                                 <@ array(select k.confkey[array_position(k.conkey, c)] from unnest((i.indkey::int2[])[0:p.len - 1]) as c)))
       order by 1`)).rows.map((row) => row.name);
    await db.admin();
    expect(await unindexed()).toEqual([]);
    // The check itself: an index led by the tenant columns does not identify an evaluation; one led by its id does.
    await db.exec(`create table public.erasure_probe_refs (id uuid primary key, user_id uuid not null, account_id uuid not null, evaluation_id uuid not null,
        constraint erasure_probe_refs_evaluation foreign key (user_id, account_id, evaluation_id) references public.risk_evaluations(user_id, account_id, id));
      create index on public.erasure_probe_refs (user_id, account_id);`);
    try {
      expect(await unindexed()).toEqual(["erasure_probe_refs (erasure_probe_refs_evaluation)"]);
      await db.exec("create index on public.erasure_probe_refs (evaluation_id, user_id);");
      expect(await unindexed()).toEqual([]);
    } finally {
      await db.exec("drop table public.erasure_probe_refs;");
    }
  });

  it("fails closed and rolls back when a row outside the tenant tables still references the user's data", async () => {
    await db.admin();
    await db.exec("create table public.erasure_probe_links (id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id));");
    await db.query("insert into public.erasure_probe_links(account_id) values ($1)", [owner.v1Account]);
    try {
      await expect(purge(db, OWNER)).rejects.toThrow(/^PURGE_INCOMPLETE: accounts$/);
      await unchanged();
      expect(await receipts(db)).toEqual([]);
    } finally {
      await db.admin();
      await db.exec("drop table public.erasure_probe_links;");
    }
  });

  it("fails closed when deleting the user's rows would cascade into an immutable record", async () => {
    await db.admin();
    await db.exec(`create table public.erasure_probe_cascade (id uuid primary key default gen_random_uuid(),
        trade_id uuid not null references public.trades(id) on delete cascade, note text not null);
      create trigger immutable_record before update or delete on public.erasure_probe_cascade for each row execute function private.reject_mutation();`);
    await db.query("insert into public.erasure_probe_cascade(trade_id, note) select id, 'global note' from public.trades where user_id = $1 limit 1", [OWNER]);
    try {
      await expect(purge(db, OWNER)).rejects.toThrow(/^PURGE_INCOMPLETE: trades$/);
      await unchanged();
    } finally {
      await db.admin();
      await db.exec("drop table public.erasure_probe_cascade;");
    }
  });

  it("fails closed and rolls back when a trigger re-creates a row the purge already removed", async () => {
    await db.admin();
    await db.exec(`create table public.erasure_probe_echo (user_id uuid not null, note text not null);
      create function public.erasure_probe_echo() returns trigger language plpgsql as $f$
        begin insert into public.erasure_probe_echo(user_id, note) values (old.user_id, 'resurrected'); return old; end $f$;
      create trigger erasure_probe_echo after delete on public.accounts for each row execute function public.erasure_probe_echo();`);
    try {
      await expect(purge(db, OWNER)).rejects.toThrow(/^PURGE_INCOMPLETE: erasure_probe_echo$/);
      await unchanged();
      expect(await value<number>(db, "select count(*)::int as value from public.erasure_probe_echo")).toBe(0);
    } finally {
      await db.admin();
      await db.exec("drop trigger erasure_probe_echo on public.accounts; drop function public.erasure_probe_echo(); drop table public.erasure_probe_echo;");
    }
  });

  it("breaks a foreign-key cycle when no row closes it, and fails closed when rows do", async () => {
    await db.admin();
    await db.exec(`create table public.erasure_probe_a (id uuid primary key, user_id uuid not null, b_id uuid);
      create table public.erasure_probe_b (id uuid primary key, user_id uuid not null, a_id uuid references public.erasure_probe_a(id));
      alter table public.erasure_probe_a add constraint erasure_probe_a_b foreign key (b_id) references public.erasure_probe_b(id);`);
    const [a, b] = [randomUUID(), randomUUID()];
    try {
      await db.query("insert into public.erasure_probe_a(id, user_id) values ($1, $2)", [a, OWNER]);
      await db.query("insert into public.erasure_probe_b(id, user_id, a_id) values ($1, $2, $3)", [b, OWNER, a]);
      await db.query("update public.erasure_probe_a set b_id = $1 where id = $2", [b, a]);
      await expect(purge(db, OWNER)).rejects.toThrow(/^PURGE_INCOMPLETE: erasure_probe_a$/);
      await unchanged();
      await db.admin();
      await db.query("update public.erasure_probe_a set b_id = null where id = $1", [a]);
      const purged = await purge(db, OWNER);
      expect({ a: purged.deleted.erasure_probe_a, b: purged.deleted.erasure_probe_b }).toEqual({ a: 1, b: 1 });
      expect(purged.deleted).toMatchObject(ownerBefore);
      expect(Object.entries(await counts(db, OWNER)).filter(([, n]) => n > 0)).toEqual([]);
      expect(await counts(db, OTHER)).toMatchObject(otherBefore);
      expect((await receipts(db)).map((r) => r.table_counts)).toEqual([purged.deleted]);
    } finally {
      await db.admin();
      await db.exec("drop table public.erasure_probe_a, public.erasure_probe_b cascade;");
    }
  });
});
