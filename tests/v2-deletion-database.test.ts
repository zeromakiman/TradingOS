import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// 0020_trade_deletion_journal_models.sql, part 1: Deleted trades (trash_trade, restore_trade), permanent trade deletion
// and trading-account deletion. Synthetic users and accounts only. Two users, several accounts each: every refusal
// changes nothing, and every deletion leaves the other account and the other user byte-identical.

// PGlite reads the JS clock: day 1 is Monday 2026-11-02 (10:00 UTC−5); later tests move to the next strategy days.
const DAY1 = new Date("2026-11-02T15:00:00Z");
const DAY2 = new Date("2026-11-03T15:00:00Z");
const DAY3 = new Date("2026-11-04T15:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(DAY1);
});
afterAll(() => { vi.useRealTimers(); });

type Json = Record<string, unknown>;
const HASH = "c".repeat(64);
const SHA = "a".repeat(64);
const SPEND_TABLES = ["ai_request_reservations", "ai_request_dispatches", "ai_request_generations", "ai_usage_records", "ai_uncertainty_resolutions"];

let db: TestDatabase;
let a: BootstrappedAccount; // OWNER, main account
let b: BootstrappedAccount; // OWNER, untouched sibling account
let o: BootstrappedAccount; // OTHER

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}
async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T> {
  await db.actor(OWNER);
  return value<T>(sql, params);
}
async function fails(sql: string, params: unknown[], user = OWNER): Promise<string> {
  await db.actor(user);
  try {
    await db.query(sql, params);
  } catch (error) {
    return (error as Error).message;
  }
  return "no error";
}

const proposal = (acc: BootstrappedAccount, prices: { entry: string; stop: string; target: string }) =>
  JSON.stringify({ ...previewProposal, instrumentId: acc.instrumentId, narrative: "Synthetic deletion test", contractConfirmed: true, news: "CLEAR", ...prices });
let priceStep = 0;
function prices() {
  priceStep += 1;
  const entry = (1 + priceStep / 100).toFixed(5);
  return { entry, stop: (Number(entry) - 0.002).toFixed(5), target: (Number(entry) + 0.006).toFixed(5) };
}

async function context(acc: BootstrappedAccount): Promise<{ risk: string; observation: string }> {
  await db.admin();
  return (await db.query<{ risk: string; observation: string }>(`select
      (select id from public.risk_plan_versions where account_id = $1 order by created_at desc, id desc limit 1) as risk,
      (select id from public.account_observations where account_id = $1 order by recorded_at desc, id desc limit 1) as observation`, [acc.accountId])).rows[0];
}
async function draft(acc: BootstrappedAccount, user = OWNER): Promise<string> {
  const ctx = await context(acc);
  await db.actor(user);
  return (await value<{ tradeId: string }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [acc.accountId, proposal(acc, prices()), randomUUID(), ctx.risk, ctx.observation])).tradeId;
}
async function locked(acc: BootstrappedAccount, user = OWNER): Promise<string> {
  const id = await draft(acc, user);
  const result = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [id]);
  expect(result.planId, JSON.stringify(result)).toBeTruthy();
  return id;
}
async function closedPlanned(acc: BootstrappedAccount, user = OWNER): Promise<string> {
  const id = await locked(acc, user);
  const entry = await value<string>("select planned_entry as value from public.trade_ledger where id = $1", [id]);
  await db.query("select public.record_planned_entry($1, $2, '0.25', clock_timestamp())", [id, entry]);
  await db.query("select public.close_planned_trade($1, $2, clock_timestamp(), '0')", [id, entry]);
  return id;
}
async function live(acc: BootstrappedAccount, user = OWNER): Promise<string> {
  await db.actor(user);
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [acc.accountId,
    JSON.stringify({ instrumentId: acc.instrumentId, direction: "LONG", entryModel: "OTHER", entryPrice: "1.10000",
      enteredAt: new Date(Date.now() - 10 * 60_000).toISOString(), quantity: "0.50", initialStop: "1.09800" }), randomUUID()]);
}
async function closeLive(id: string, user = OWNER): Promise<void> {
  await db.actor(user);
  await db.query("select public.close_live_trade($1, $2::jsonb)", [id, JSON.stringify({ exitPrice: "1.09900", exitedAt: new Date(Date.now() - 60_000).toISOString() })]);
}
const trash = (id: string) => asOwner<Json>("select public.trash_trade($1) as value", [id]);
const restore = (id: string) => asOwner<Json>("select public.restore_trade($1) as value", [id]);
const deleteTrade = (id: string) => asOwner<{ storagePaths: { legacy: string[]; evidence: string[] }; deleted: Record<string, number> }>(
  "select public.delete_trade_permanently($1, 'DELETE') as value", [id]);

async function usage(accountId: string): Promise<Json> {
  await db.admin();
  return value<Json>("select private.daily_usage($1, clock_timestamp()) as value", [accountId]);
}

/** Every row of every public tenant table that matches (user, account?), as canonical JSON text per table. */
async function snapshot(user: string, accountId?: string): Promise<Record<string, string[]>> {
  await db.admin();
  const tables = (await db.query<{ name: string }>(`
    select c.relname as name from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'user_id' and not x.attisdropped)
       and exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'account_id' and not x.attisdropped)
     order by 1`)).rows.map((r) => r.name);
  const result: Record<string, string[]> = {};
  for (const table of tables) {
    const { rows } = await db.query<{ r: string }>(
      `select row_to_json(x)::text as r from public.${table} x where x.user_id = $1 and ($2::uuid is null or x.account_id = $2) order by 1`, [user, accountId ?? null]);
    result[table] = rows.map((row) => row.r);
  }
  const accounts = await db.query<{ r: string }>("select row_to_json(x)::text as r from public.accounts x where x.user_id = $1 and ($2::uuid is null or x.id = $2) order by 1",
    [user, accountId ?? null]);
  result.accounts = accounts.rows.map((row) => row.r);
  return result;
}

/** Tables (and how many rows) that still name the trade, its plan or one of its proposals. */
async function leftovers(trade: { id: string; plan: string | null; proposals: string[] }): Promise<string[]> {
  await db.admin();
  const columns = (await db.query<{ rel: string; col: string }>(`
    select c.relname as rel, a.attname as col from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and (a.attname in ('trade_id', 'plan_id', 'proposal_id', 'duplicated_from') or (c.relname in ('trades', 'trade_plans', 'setup_proposals') and a.attname = 'id'))
     order by 1, 2`)).rows;
  const found: string[] = [];
  for (const { rel, col } of columns) {
    const ids = col === "plan_id" || (rel === "trade_plans" && col === "id") ? [trade.plan].filter(Boolean)
      : col === "proposal_id" || (rel === "setup_proposals" && col === "id") ? trade.proposals : [trade.id];
    if (ids.length === 0) continue;
    const n = await value<number>(`select count(*)::int as value from public.${rel} where ${col} = any ($1::uuid[])`, [ids]);
    if (n > 0) found.push(`${rel}.${col}`);
  }
  return found;
}
async function tradeKeys(id: string): Promise<{ id: string; plan: string | null; proposals: string[] }> {
  await db.admin();
  const plan = (await db.query<{ plan_id: string }>("select plan_id from public.trade_plan_links where trade_id = $1", [id])).rows[0]?.plan_id ?? null;
  const proposals = (await db.query<{ proposal_id: string }>("select proposal_id from public.trade_revisions where trade_id = $1", [id])).rows.map((r) => r.proposal_id);
  return { id, plan, proposals };
}
async function spend(): Promise<Record<string, number>> {
  await db.admin();
  const out: Record<string, number> = {};
  for (const table of SPEND_TABLES) out[table] = await value<number>(`select count(*)::int as value from public.${table}`);
  return out;
}
async function reserve(accountId: string, user: string, settled: boolean, operationId = randomUUID()): Promise<string> {
  await db.admin();
  const id = randomUUID();
  await db.query(`insert into public.ai_request_reservations(id, user_id, account_id, operation, operation_id, stage, request_hash, provider, model,
      pricing, reserved_micros, period) values ($1, $2, $3, 'REVIEW_TRADE', $4, 'A', $5, 'openai', 'synthetic-model', '{}', 1000, date_trunc('month', clock_timestamp())::date)`,
    [id, user, accountId, operationId, HASH]);
  await db.query("insert into public.ai_request_dispatches(reservation_id, user_id, account_id) values ($1, $2, $3)", [id, user, accountId]);
  if (settled) await settle(id, user, accountId);
  return id;
}
async function settle(reservation: string, user: string, accountId: string): Promise<void> {
  await db.admin();
  await db.query("insert into public.ai_usage_records(reservation_id, user_id, account_id, disposition, charged_micros, input_tokens, output_tokens, usage) values ($1, $2, $3, 'SETTLED', 500, 10, 5, '{}')",
    [reservation, user, accountId]);
}
async function raiseDailyLimit(acc: BootstrappedAccount, user = OWNER): Promise<void> {
  // A later instant than the account's first risk plan, so the newer version wins (newest created first).
  vi.setSystemTime(new Date(Date.now() + 1000));
  await db.actor(user);
  await db.query("select public.create_risk_policy_version($1, $2::jsonb, true, 'Synthetic deletion test')", [acc.accountId, JSON.stringify({
    maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 40, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN" })]);
}

async function newAccount(user: string, name: string): Promise<BootstrappedAccount> {
  await db.actor(user);
  const accountId = await value<string>("select public.create_trading_account($1, $2::jsonb) as value", [randomUUID(),
    JSON.stringify({ name, currency: "USD", accountType: "DEMO", platform: "MANUAL", balance: "10000", equity: "10000" })]);
  await db.admin();
  const ids = (await db.query<Omit<BootstrappedAccount, "accountId">>(`select
      (select id from public.instrument_versions where account_id = $1 and symbol = 'EURUSD') as "instrumentId",
      (select id from public.risk_plan_versions where account_id = $1) as "riskId",
      (select id from public.account_observations where account_id = $1) as "observationId",
      (select id from public.strategy_versions where account_id = $1) as "strategyId"`, [accountId])).rows[0];
  const acc = { accountId, ...ids };
  await raiseDailyLimit(acc, user);
  return acc;
}
const stripVolatile = (report: unknown): unknown => JSON.parse(JSON.stringify(report, (key, v) => (key === "evaluatedAt" || key === "evaluationId" ? undefined : v)));

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  await db.pinSession("ACTIVE_KILL_ZONE");
  a = await db.bootstrapAccount(OWNER, { name: "Owner main" });
  b = await db.bootstrapAccount(OWNER, { name: "Owner sibling" });
  o = await db.bootstrapAccount(OTHER, { name: "Other user" });
  for (const [acc, user] of [[a, OWNER], [b, OWNER], [o, OTHER]] as const) await raiseDailyLimit(acc, user);
  // Data in the sibling account and for the other user, so "untouched" is a real check.
  await closedPlanned(b);
  await draft(b);
  await closedPlanned(o, OTHER);
  await live(o, OTHER);
}, 120_000);
afterAll(async () => { await db.close(); });

describe("Deleted trades (trash and restore)", () => {
  it("hides a trashed trade through trashed_at, leaves daily usage byte-identical and the next risk check unchanged", async () => {
    const closed = await closedPlanned(a);
    const blank = await draft(a);
    const finished = await live(a);
    await closeLive(finished);
    const probe = await draft(a);
    const before = await usage(a.accountId);
    const reportBefore = stripVolatile(await asOwner<Json>("select public.check_trade_risk($1) as value", [probe]));
    for (const id of [closed, blank, finished]) {
      const result = await trash(id);
      expect(result).toMatchObject({ tradeId: id });
      expect(result.trashedAt).toBeTruthy();
    }
    expect(await usage(a.accountId)).toEqual(before);
    expect(stripVolatile(await asOwner<Json>("select public.check_trade_risk($1) as value", [probe]))).toEqual(reportBefore);
    const rows = await asOwner<{ id: string; trashed: boolean; lifecycle: string }[]>(
      "select coalesce(json_agg(json_build_object('id', id, 'trashed', trashed_at is not null, 'lifecycle', lifecycle)), '[]') as value from public.trade_ledger where id = any ($1::uuid[])",
      [[closed, blank, finished, probe]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.trashed]))).toEqual({ [closed]: true, [blank]: true, [finished]: true, [probe]: false });
    // Trashing again is a no-op; restore brings it back; restoring twice is refused.
    const again = await trash(closed);
    expect((await trash(closed)).trashedAt).toEqual(again.trashedAt);
    expect(await restore(closed)).toEqual({ tradeId: closed, trashedAt: null });
    expect(await asOwner<string | null>("select trashed_at as value from public.trade_ledger where id = $1", [closed])).toBeNull();
    expect(await fails("select public.restore_trade($1)", [closed])).toMatch(/^TRADE_NOT_DELETED:/);
    expect(await usage(a.accountId)).toEqual(before);
  });

  it("refuses to trash locked and live trades", async () => {
    const plan = await locked(a);
    const open = await live(a);
    for (const id of [plan, open]) expect(await fails("select public.trash_trade($1)", [id])).toMatch(/^TRADE_OPEN:/);
    expect(await asOwner<number>("select count(*)::int as value from public.trade_trash_events where trade_id = any ($1::uuid[])", [[plan, open]])).toBe(0);
    // Skipped and discarded trades can go to Deleted trades.
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'Synthetic skip')", [plan]);
    expect((await trash(plan)).trashedAt).toBeTruthy();
    const dropped = await draft(a);
    await db.query("select public.discard_trade_draft($1, null, $2)", [dropped, randomUUID()]);
    expect((await trash(dropped)).trashedAt).toBeTruthy();
  });

  it("isolates owners: another user can neither trash, restore nor delete the trade", async () => {
    const mine = await draft(a);
    await trash(mine);
    const before = await snapshot(OWNER);
    for (const sql of ["select public.trash_trade($1)", "select public.restore_trade($1)", "select public.delete_trade_permanently($1, 'DELETE')"]) {
      expect(await fails(sql, [mine], OTHER)).toMatch(/^TRADE_NOT_FOUND:/);
    }
    expect(await snapshot(OWNER)).toEqual(before);
  });
});

describe("delete_trade_permanently", () => {
  it("refuses a trade that is not in Deleted trades, a wrong confirmation, and a trade that counts toward today", async () => {
    const closed = await closedPlanned(a);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [closed])).toMatch(/^TRADE_NOT_DELETED:/);
    await trash(closed);
    for (const word of ["delete", "", "DELETE "]) {
      expect(await fails("select public.delete_trade_permanently($1, $2)", [closed, word])).toMatch(/^CONFIRMATION_REQUIRED:/);
    }
    const before = await snapshot(OWNER);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [closed])).toMatch(/^TRADE_COUNTS_TODAY:/);
    const finished = await live(a);
    await closeLive(finished);
    await trash(finished);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [finished])).toMatch(/^TRADE_COUNTS_TODAY:/);
    // A skipped plan of today keeps its slot, so it counts as well.
    const skipped = await locked(a);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'Synthetic skip')", [skipped]);
    await trash(skipped);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [skipped])).toMatch(/^TRADE_COUNTS_TODAY:/);
    const after = await snapshot(OWNER);
    expect(after.trades).toEqual([...before.trades, ...after.trades.filter((r) => !before.trades.includes(r))].sort());
    expect(after.trade_plans.length).toBeGreaterThan(before.trade_plans.length);
  });

  it("deletes a draft (which never counts) on the day it was made, with nothing left and usage unchanged", async () => {
    const id = await draft(a);
    await db.query("select public.set_trade_tags($1, 'A', 'PDH', 'M5', array['synthetic'])", [id]);
    await db.query("select public.add_journal_entry($1, 'NOTE', 'Synthetic note', '{}'::jsonb, $2)", [id, randomUUID()]);
    const keys = await tradeKeys(id);
    await trash(id);
    const before = await usage(a.accountId);
    const sibling = await snapshot(OWNER, b.accountId);
    const other = await snapshot(OTHER);
    const result = await deleteTrade(id);
    expect(result.deleted).toMatchObject({ trades: 1, trade_revisions: 1, setup_proposals: 1, trade_tag_sets: 1, trade_journal_entries: 1, trade_trash_events: 1 });
    expect(await leftovers(keys)).toEqual([]);
    expect(await usage(a.accountId)).toEqual(before);
    expect(await snapshot(OWNER, b.accountId)).toEqual(sibling);
    expect(await snapshot(OTHER)).toEqual(other);
  });

  it("removes every per-trade row of a closed trade on a later day, keeps AI spend and the budget, and returns its storage paths", async () => {
    vi.setSystemTime(DAY1);
    const id = await closedPlanned(a);
    const keys = await tradeKeys(id);
    // Evidence (V2) through the trusted-server registration, with its storage object.
    const evidence = randomUUID();
    await db.actor(OWNER, "service_role");
    await db.query("select public.register_trade_evidence($1, $2::jsonb)", [OWNER, JSON.stringify({
      id: evidence, tradeId: id, label: "CONTEXT", timeframe: "M5", originalFilename: "evidence.png", mimeType: "image/png", byteSize: 2048, sha256: SHA,
      width: 64, height: 64, captureMethod: "PASTE" })]);
    await db.admin();
    await db.query("insert into storage.objects(bucket_id, name) values ('trade-evidence', $1)", [`${OWNER}/${id}/${evidence}`]);
    await db.actor(OWNER);
    await db.query("select public.relabel_trade_evidence($1, 'HTF', 'H4', 'Synthetic caption')", [evidence]);
    await db.query("select public.complete_trade_review($1, $2)", [id, randomUUID()]);
    await db.query("select public.add_journal_entry($1, 'LESSON', 'Synthetic lesson', '{}'::jsonb, $2)", [id, randomUUID()]);
    await db.query("select public.set_trade_tags($1, 'A', 'PDH', 'M5', array['synthetic'])", [id]);
    // The trade's AI results: a V1 trade review and a timeline review, each with settled spend.
    await db.admin();
    const review = randomUUID();
    const timeline = randomUUID();
    await db.query("insert into public.trade_ai_reviews(id, user_id, account_id, plan_id, facts, input_hash, operation, contract) values ($1, $2, $3, $4, '{}', $5, '{\"id\":\"REVIEW_TRADE\"}', '{}')",
      [review, OWNER, a.accountId, keys.plan, HASH]);
    const reviewSpend = await reserve(a.accountId, OWNER, true, review);
    await db.query("insert into public.trade_ai_review_results(review_id, user_id, account_id, status, error_code, reservation_id) values ($1, $2, $3, 'FAILED', 'TIMEOUT', $4)",
      [review, OWNER, a.accountId, reviewSpend]);
    await db.query(`insert into public.trade_timeline_reviews(id, user_id, account_id, trade_id, facts, input_hash, operation, contract)
      values ($1, $2, $3, $4, '{}', $5, '{"id":"REVIEW_TRADE_TIMELINE"}', '{}')`, [timeline, OWNER, a.accountId, id, HASH]);
    const timelineSpend = await reserve(a.accountId, OWNER, true, timeline);
    await db.query("insert into public.trade_timeline_review_results(review_id, user_id, account_id, status, error_code, reservation_id) values ($1, $2, $3, 'FAILED', 'MOCK_FAILURE', $4)",
      [timeline, OWNER, a.accountId, timelineSpend]);
    await trash(id);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [id])).toMatch(/^TRADE_COUNTS_TODAY:/);

    vi.setSystemTime(DAY2);
    const spendBefore = await spend();
    const budgetBefore = await asOwner<Json>("select public.get_account_ai_budget($1) as value", [a.accountId]);
    const sibling = await snapshot(OWNER, b.accountId);
    const other = await snapshot(OTHER);
    const result = await deleteTrade(id);
    expect(result.storagePaths).toEqual({ legacy: [], evidence: [`${OWNER}/${id}/${evidence}`] });
    expect(result.deleted).toMatchObject({ trades: 1, trade_plans: 1, trade_executions: 1, trade_outcomes: 1, trade_evidence: 1, trade_evidence_labels: 1,
      trade_ai_reviews: 1, trade_ai_review_results: 1, trade_timeline_reviews: 1, trade_timeline_review_results: 1, trade_lifecycle_events: 1 });
    expect(await leftovers(keys)).toEqual([]);
    expect(await spend()).toEqual(spendBefore);
    expect(await asOwner<Json>("select public.get_account_ai_budget($1) as value", [a.accountId])).toEqual(budgetBefore);
    expect(await snapshot(OWNER, b.accountId)).toEqual(sibling);
    expect(await snapshot(OTHER)).toEqual(other);
    // The flag is cleared inside the caller's transaction.
    await db.actor(OWNER);
    const scope = (await db.query<{ scope: string | null }>("select current_setting('trading_os.delete_scope', true) as scope")).rows[0].scope;
    expect(scope ?? "").toBe("");
  });

  it("refuses while another trade was duplicated from it, and deletes the copy first", async () => {
    const source = await draft(a);
    const ctx = await context(a);
    await db.actor(OWNER);
    const copy = (await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [source, randomUUID(), ctx.risk, ctx.observation])).tradeId;
    await trash(source);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [source])).toMatch(/^TRADE_HAS_COPIES:/);
    await trash(copy);
    await deleteTrade(copy);
    await deleteTrade(source);
    expect(await leftovers({ id: source, plan: null, proposals: [] })).toEqual([]);
  });

  it("refuses while an AI request of the account is in flight, and goes ahead once it settled", async () => {
    const id = await draft(a);
    await trash(id);
    const reservation = await reserve(a.accountId, OWNER, false);
    expect(await fails("select public.delete_trade_permanently($1, 'DELETE')", [id])).toMatch(/^AI_REQUEST_IN_PROGRESS:/);
    // Another account's in-flight request never blocks this account.
    const elsewhere = await reserve(b.accountId, OWNER, false);
    await settle(reservation, OWNER, a.accountId);
    await deleteTrade(id);
    await settle(elsewhere, OWNER, b.accountId);
  });

  it("never lets the delete flag reach another user's rows, an update, or an API role", async () => {
    await db.admin();
    const flag = `select set_config('trading_os.delete_scope', '${OWNER}', true);`;
    const attempt = async (sql: string) => {
      try {
        await db.exec(`begin; ${sql} rollback;`);
        return null;
      } catch (error) {
        await db.exec("rollback");
        return (error as Error).message;
      }
    };
    // Another user's rows stay immutable under the owner's flag; updates are never allowed; without the flag nothing goes.
    expect(await attempt(`${flag} delete from public.trades where user_id = '${OTHER}';`)).toMatch(/^Immutable record/);
    expect(await attempt(`${flag} delete from public.trade_position_facts where user_id = '${OTHER}';`)).toMatch(/^Immutable record/);
    expect(await attempt(`${flag} update public.trades set origin = 'IMPORTED' where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    expect(await attempt(`delete from public.trade_position_facts where user_id = '${OWNER}';`)).toMatch(/^Immutable record/);
    for (const role of ["authenticated", "service_role"] as const) {
      await db.actor(OWNER, role);
      expect(await attempt(`${flag} delete from public.trade_position_facts where user_id = '${OWNER}';`), role).toMatch(/permission denied/);
    }
    await db.admin();
    const grants = (await db.query<{ name: string; anon: boolean; authenticated: boolean; service: boolean }>(`
      select p.proname as name, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('trash_trade', 'restore_trade', 'delete_trade_permanently', 'delete_trading_account')
       order by 1`)).rows;
    expect(grants).toEqual(["delete_trade_permanently", "delete_trading_account", "restore_trade", "trash_trade"].map((name) => ({ name, anon: false, authenticated: true, service: false })));
  });
});

describe("delete_trading_account", () => {
  it("deletes an empty account after the typed name, leaving every other account and user untouched", async () => {
    const empty = await newAccount(OWNER, "Empty demo");
    const ownerRest = await snapshot(OWNER, a.accountId);
    const sibling = await snapshot(OWNER, b.accountId);
    const other = await snapshot(OTHER);
    for (const name of ["empty demo", "Empty demo ", "", "Owner main"]) {
      expect(await fails("select public.delete_trading_account($1, $2, false)", [empty.accountId, name])).toMatch(/^CONFIRMATION_REQUIRED:/);
    }
    expect(await fails("select public.delete_trading_account($1, 'Empty demo', false)", [empty.accountId], OTHER)).toMatch(/^ACCOUNT_NOT_FOUND:/);
    const result = await asOwner<{ accountId: string; tradeIds: string[] }>("select public.delete_trading_account($1, 'Empty demo', false) as value", [empty.accountId]);
    expect(result).toMatchObject({ accountId: empty.accountId, tradeIds: [] });
    const remaining = await snapshot(OWNER, empty.accountId);
    expect(Object.entries(remaining).filter(([, rows]) => rows.length > 0)).toEqual([]);
    expect(await snapshot(OWNER, a.accountId)).toEqual(ownerRest);
    expect(await snapshot(OWNER, b.accountId)).toEqual(sibling);
    expect(await snapshot(OTHER)).toEqual(other);
  });

  it("never bypasses the trade guards: open trades, trades counting today and AI in flight refuse, and nothing is deleted", async () => {
    vi.setSystemTime(DAY2);
    const acc = await newAccount(OWNER, "Prop eval");
    const closed = await closedPlanned(acc);
    const plan = await locked(acc);
    await draft(acc);
    const before = await snapshot(OWNER, acc.accountId);
    expect(await fails("select public.delete_trading_account($1, 'Prop eval', false)", [acc.accountId])).toMatch(/^ACCOUNT_HAS_TRADES:/);
    expect(await fails("select public.delete_trading_account($1, 'Prop eval', true)", [acc.accountId])).toMatch(/^ACCOUNT_HAS_OPEN_TRADES:/);
    await db.query("select public.set_planned_disposition($1, 'CANCELLED', 'Synthetic cancel')", [plan]);
    expect(await fails("select public.delete_trading_account($1, 'Prop eval', true)", [acc.accountId])).toMatch(/^TRADE_COUNTS_TODAY:/);
    const after = await snapshot(OWNER, acc.accountId);
    expect(after.trades).toEqual(before.trades);
    expect(after.accounts).toEqual(before.accounts);

    vi.setSystemTime(DAY3);
    const reservation = await reserve(acc.accountId, OWNER, false);
    expect(await fails("select public.delete_trading_account($1, 'Prop eval', true)", [acc.accountId])).toMatch(/^AI_REQUEST_IN_PROGRESS:/);
    await settle(reservation, OWNER, acc.accountId);
    expect(await fails("select public.delete_trading_account($1, 'Prop eval', true)", [acc.accountId])).toMatch(/^ACCOUNT_HAS_AI_HISTORY:/);
    expect((await snapshot(OWNER, acc.accountId)).trades).toEqual(before.trades);
    expect(closed).toBeTruthy();
  });

  it("deletes an account with closed trades (from a later day) and its configuration, with storage paths and trade ids", async () => {
    vi.setSystemTime(DAY2);
    const acc = await newAccount(OWNER, "Old demo");
    const closed = await closedPlanned(acc);
    const dropped = await draft(acc);
    await db.query("select public.discard_trade_draft($1, null, $2)", [dropped, randomUUID()]);
    const finished = await live(acc);
    await closeLive(finished);
    await trash(dropped);
    await db.actor(OWNER, "service_role");
    const evidence = randomUUID();
    await db.query("select public.register_trade_evidence($1, $2::jsonb)", [OWNER, JSON.stringify({
      id: evidence, tradeId: finished, label: "CONTEXT", timeframe: "M5", originalFilename: "evidence.png", mimeType: "image/png", byteSize: 2048, sha256: SHA,
      width: 64, height: 64, captureMethod: "PASTE" })]);
    await db.actor(OWNER);
    await db.query("select public.add_external_loss($1, '12.50', 'Synthetic loss', $2)", [acc.accountId, randomUUID()]);
    await db.query("select public.create_custom_model($1, '{\"name\":\"Breaker\"}'::jsonb, $2)", [acc.accountId, randomUUID()]);
    await db.query("select public.create_instrument_version($1, $2::jsonb)", [acc.accountId, JSON.stringify({
      symbol: "XAUUSD", quantityUnit: "oz", tickSize: "0.01", tickValue: "0.01", quantityStep: "1", minimumQuantity: "1" })]);
    vi.setSystemTime(DAY3);
    const ownerRest = await snapshot(OWNER, a.accountId);
    const other = await snapshot(OTHER);
    const result = await asOwner<{ tradeIds: string[]; storagePaths: { evidence: string[] }; deleted: Record<string, number> }>(
      "select public.delete_trading_account($1, 'Old demo', true) as value", [acc.accountId]);
    expect(result.tradeIds.sort()).toEqual([closed, dropped, finished].sort());
    expect(result.storagePaths.evidence).toEqual([`${OWNER}/${finished}/${evidence}`]);
    expect(result.deleted).toMatchObject({ accounts: 1, trades: 3, custom_models: 1, external_loss_entries: 1 });
    const remaining = await snapshot(OWNER, acc.accountId);
    expect(Object.entries(remaining).filter(([, rows]) => rows.length > 0)).toEqual([]);
    expect(await snapshot(OWNER, a.accountId)).toEqual(ownerRest);
    expect(await snapshot(OTHER)).toEqual(other);
  });
});

describe("erasure after 0020", () => {
  it("still erases every row of the user, including Deleted-trades events and custom models, and nothing of the other user", async () => {
    await db.actor(OWNER);
    await db.query("select public.create_custom_model($1, '{\"name\":\"Turtle soup\"}'::jsonb, $2)", [a.accountId, randomUUID()]);
    const other = await snapshot(OTHER);
    await db.admin();
    expect(await value<number>("select count(*)::int as value from public.trade_trash_events where user_id = $1", [OWNER])).toBeGreaterThan(0);
    await db.actor("", "service_role");
    await db.query("select public.purge_user_trading_data($1, 'ERASE ALL MY TRADING OS DATA')", [OWNER]);
    const remaining = await snapshot(OWNER);
    expect(Object.entries(remaining).filter(([, rows]) => rows.length > 0)).toEqual([]);
    expect(await snapshot(OTHER)).toEqual(other);
  });
});
