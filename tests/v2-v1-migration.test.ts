import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import {
  type BootstrappedAccount, createTestDatabase, migrationFiles, OTHER, OWNER, readMigration, type TestDatabase,
} from "./helpers/pglite";

// Builds a representative V1 database through the V1 RPCs (migrations 0001–0014 only), snapshots every table,
// then applies 0015+ and checks the insert-only backfill of §3.2/§3.3.

type Json = Record<string, unknown>;
interface CheckEnvelope { planId: string | null }

let db: TestDatabase;
const before = new Map<string, { columns: string[]; rows: string[] }>();
const accounts: Record<"a1" | "a2" | "a3" | "b1", BootstrappedAccount> = {} as Record<"a1" | "a2" | "a3" | "b1", BootstrappedAccount>;
const proposals: Record<string, string> = {};
const plans: Record<string, string> = {};
const screenshots: Record<string, string> = {};

const SECOND_PRICES = { entry: "1.2", stop: "1.198", target: "1.206" };
const THIRD_PRICES = { entry: "1.3", stop: "1.298", target: "1.306" };

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}
const sameDecimal = (a: string | null, b: string | null) => (a === null || b === null ? a === b : new Decimal(a).eq(b));
const proposal = (a: BootstrappedAccount, changes: Json = {}) => ({
  ...previewProposal, instrumentId: a.instrumentId, narrative: "V1 synthetic setup", contractConfirmed: true, news: "CLEAR", ...changes,
});
async function saveProposal(user: string, a: BootstrappedAccount, changes: Json = {}): Promise<string> {
  await db.actor(user);
  return value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, JSON.stringify(proposal(a, changes)), randomUUID(), a.riskId, a.observationId]);
}
async function lockProposal(user: string, proposalId: string): Promise<string> {
  await db.actor(user);
  const result = await value<CheckEnvelope>("select public.check_setup_risk($1, true) as value", [proposalId]);
  expect(result.planId).toBeTruthy();
  return String(result.planId);
}
async function lockDirect(user: string, a: BootstrappedAccount, changes: Json = {}): Promise<string> {
  await db.actor(user);
  const result = await value<CheckEnvelope>("select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, JSON.stringify(proposal(a, changes)), randomUUID(), a.riskId, a.observationId]);
  expect(result.planId).toBeTruthy();
  return String(result.planId);
}
async function rpc(user: string, sql: string, params: unknown[]): Promise<void> {
  await db.actor(user);
  await db.query(sql, params);
}
async function screenshot(user: string, a: BootstrappedAccount, proposalId: string): Promise<string> {
  const id = randomUUID();
  const path = `${user}/${proposalId}/${id}`;
  await db.actor(user, "service_role");
  await db.query("insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size, sha256, width, height) values ($1, $2, $3, $4, 'M5', $5, 'm5.png', 'image/png', 2048, $6, 64, 64)",
    [id, user, a.accountId, proposalId, path, "b".repeat(64)]);
  await db.query("insert into storage.objects(bucket_id, name) values ('setup-screenshots', $1)", [path]);
  return id;
}

// V1 state. Expected V1 journal_analytics status → V2 lifecycle (§2.2):
//   L1 CLOSED→CLOSED, L2 SKIPPED(disposition)→SKIPPED, L3 TAKEN(fill)→LIVE, L4 CANCELLED→CANCELLED,
//   L5 SKIPPED(human decision only)→SKIPPED (V1 meaning preserved), L6 CLOSED→CLOSED,
//   L7 TAKEN(human decision, no fill)→LOCKED with legacy_decision TAKEN (V2 has no "taken but not entered" state).
// Unlocked proposals: P3 blocked→DRAFT/BLOCKED, P4 skipped→SKIPPED, P5 taken→DRAFT, P9/P10→DRAFT.
async function buildV1State(): Promise<void> {
  accounts.a1 = await db.bootstrapAccount(OWNER, { name: "Demo one" });
  accounts.a2 = await db.bootstrapAccount(OWNER, { name: "Demo two", balance: "20000", equity: "20000" });
  accounts.a3 = await db.bootstrapAccount(OWNER, { name: "Demo three" });
  accounts.b1 = await db.bootstrapAccount(OTHER, { name: "Other user" });
  const { a1, a2, a3, b1 } = accounts;

  proposals.p1 = await saveProposal(OWNER, a1);
  screenshots.p1 = await screenshot(OWNER, a1, proposals.p1);
  plans.l1 = await lockProposal(OWNER, proposals.p1);
  await rpc(OWNER, "select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [plans.l1]);
  await rpc(OWNER, "select public.append_plan_note($1, 'Price respected the OB', $2)", [plans.l1, randomUUID()]);
  await rpc(OWNER, "select public.record_setup_decision($1, 'TAKEN', null)", [proposals.p1]);
  await rpc(OWNER, "select public.close_journal_trade($1, '1.104', clock_timestamp(), '1.50')", [plans.l1]);
  await rpc(OWNER, "select public.append_plan_note($1, 'Exited at target', $2)", [plans.l1, randomUUID()]);
  await rpc(OWNER, "select public.tag_journal_trade($1, 'A', 'PDH', 'M5')", [plans.l1]);
  proposals.p2 = await saveProposal(OWNER, a1, SECOND_PRICES);
  plans.l2 = await lockProposal(OWNER, proposals.p2);
  await rpc(OWNER, "select public.set_journal_disposition($1, 'SKIPPED', 'No displacement')", [plans.l2]);
  proposals.p3 = await saveProposal(OWNER, a1, { riskPercent: "2" });
  screenshots.p3 = await screenshot(OWNER, a1, proposals.p3);
  await rpc(OWNER, "select public.remove_setup_screenshot($1)", [screenshots.p3]);
  proposals.p4 = await saveProposal(OWNER, a1, { entry: "1.3", stop: "1.298", target: "1.306" });
  await rpc(OWNER, "select public.record_setup_decision($1, 'SKIPPED', 'News risk')", [proposals.p4]);
  proposals.p5 = await saveProposal(OWNER, a1, { entry: "1.4", stop: "1.398", target: "1.406" });
  await rpc(OWNER, "select public.record_setup_decision($1, 'TAKEN', null)", [proposals.p5]);
  await rpc(OWNER, "select public.record_observation($1, '9990', '9990', null)", [a1.accountId]);

  plans.l3 = await lockDirect(OWNER, a2);
  await rpc(OWNER, "select public.open_journal_trade($1, '1.1', '0.5', clock_timestamp())", [plans.l3]);
  plans.l4 = await lockDirect(OWNER, a2, SECOND_PRICES);
  await db.actor(OWNER);
  proposals.p6 = await value<string>("select public.import_locked_setup($1) as value", [plans.l4]);
  await rpc(OWNER, "select public.set_journal_disposition($1, 'CANCELLED', 'Session ended')", [plans.l4]);

  proposals.p7 = await saveProposal(OWNER, a3);
  plans.l5 = await lockProposal(OWNER, proposals.p7);
  await rpc(OWNER, "select public.record_setup_decision($1, 'SKIPPED', 'Changed my mind after lock')", [proposals.p7]);
  proposals.p10 = await saveProposal(OWNER, a3, SECOND_PRICES);
  proposals.p11 = await saveProposal(OWNER, a3, THIRD_PRICES);
  plans.l7 = await lockProposal(OWNER, proposals.p11);
  await rpc(OWNER, "select public.record_setup_decision($1, 'TAKEN', null)", [proposals.p11]);

  proposals.p8 = await saveProposal(OTHER, b1);
  plans.l6 = await lockProposal(OTHER, proposals.p8);
  await rpc(OTHER, "select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [plans.l6]);
  await rpc(OTHER, "select public.close_journal_trade($1, '1.098', clock_timestamp(), '0')", [plans.l6]);
  proposals.p9 = await saveProposal(OTHER, b1, SECOND_PRICES);
}

async function snapshotTables(): Promise<void> {
  await db.admin();
  const tables = (await db.query<{ name: string }>("select relname as name from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1")).rows;
  for (const { name } of tables) {
    const columns = (await db.query<{ name: string }>("select column_name as name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [name])).rows.map((r) => r.name);
    before.set(name, { columns, rows: await tableRows(name, columns) });
  }
}

async function tableRows(table: string, columns: string[]): Promise<string[]> {
  const list = columns.map((c) => `"${c}"`).join(", ");
  return (await db.query<{ row: string }>(`select to_jsonb(x)::text as row from (select ${list} from public."${table}") x order by 1`)).rows.map((r) => r.row);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations({ upTo: "0014" });
  await db.pinSession("ACTIVE_KILL_ZONE");
  await buildV1State();
  await snapshotTables();
  const applied = await db.applyMigrations();
  expect(applied[0]).toBe("0015_canonical_trades.sql");
  await db.admin();
}, 120_000);
afterAll(async () => { await db.close(); });

describe("V1 → V2 backfill (0015)", () => {
  it("leaves every pre-existing row of every table unchanged", async () => {
    expect(before.size).toBe(47);
    expect([...before.values()].reduce((n, t) => n + t.rows.length, 0)).toBeGreaterThan(100);
    for (const [table, snapshot] of before) {
      expect(await tableRows(table, snapshot.columns), table).toEqual(snapshot.rows);
    }
  });

  it("maps every V1 plan and every unlocked proposal to exactly one PLANNED trade", async () => {
    const counts = (await db.query<Json>(`select
        (select count(*)::int from public.trades) as trades,
        (select count(*)::int from public.trade_plans) as plans,
        (select count(*)::int from public.setup_proposals s where not exists (select 1 from public.setup_locks l where l.proposal_id = s.id)) as unlocked,
        (select count(*)::int from public.trades where migrated_from = 'V1_PLAN') as plan_trades,
        (select count(*)::int from public.trades where migrated_from = 'V1_PROPOSAL') as proposal_trades,
        (select count(*)::int from public.trade_plan_links) as links,
        (select count(*)::int from public.trade_revisions) as revisions,
        (select count(*)::int from public.setup_proposals) as proposals`)).rows[0];
    expect(counts).toEqual({ trades: 12, plans: 7, unlocked: 5, plan_trades: 7, proposal_trades: 5, links: 7, revisions: 11, proposals: 11 });
    expect((await db.query("select p.id from public.trade_plans p left join public.trade_plan_links l on l.plan_id = p.id group by p.id having count(l.trade_id) <> 1")).rows).toEqual([]);
    expect((await db.query("select s.id from public.setup_proposals s left join public.trade_revisions r on r.proposal_id = s.id group by s.id having count(r.trade_id) <> 1")).rows).toEqual([]);
    expect((await db.query("select t.id from public.trades t where t.origin <> 'PLANNED' or t.request_key is not null or t.duplicated_from is not null or t.migrated_from is null")).rows).toEqual([]);
    expect((await db.query("select r.trade_id from public.trade_revisions r where r.revision <> 1")).rows).toEqual([]);
    expect((await db.query(`select k.proposal_id from public.setup_locks k join public.trade_plan_links l on l.plan_id = k.plan_id
                             left join public.trade_revisions r on r.trade_id = l.trade_id and r.proposal_id = k.proposal_id where r.proposal_id is null`)).rows).toEqual([]);
    expect((await db.query(`select t.id from public.trades t where t.migrated_from = 'V1_PROPOSAL' and (exists (select 1 from public.trade_plan_links l where l.trade_id = t.id)
                             or (select count(*) from public.trade_revisions r where r.trade_id = t.id) <> 1)`)).rows).toEqual([]);
    const planWithoutProposal = await value<number>("select count(*)::int as value from public.trade_plan_links l where not exists (select 1 from public.trade_revisions r where r.trade_id = l.trade_id)");
    expect(planWithoutProposal).toBe(1);
  });

  it("preserves owners and accounts and derives created_at deterministically", async () => {
    expect((await db.query(`select t.id from public.trades t join public.trade_plan_links l on l.trade_id = t.id join public.trade_plans p on p.id = l.plan_id
                             where t.user_id <> p.user_id or t.account_id <> p.account_id or l.created_at <> p.locked_at
                                or t.created_at <> least(p.locked_at, (select s.created_at from public.setup_locks k join public.setup_proposals s on s.id = k.proposal_id where k.plan_id = p.id))`)).rows).toEqual([]);
    expect((await db.query(`select r.proposal_id from public.trade_revisions r join public.setup_proposals s on s.id = r.proposal_id join public.trades t on t.id = r.trade_id
                             where r.created_at <> s.created_at or r.user_id <> s.user_id or r.account_id <> s.account_id or t.user_id <> s.user_id or t.account_id <> s.account_id
                                or (t.migrated_from = 'V1_PROPOSAL' and t.created_at <> s.created_at)`)).rows).toEqual([]);
    expect((await db.query(`select t.id from public.trades t
                             where exists (select 1 from public.trade_plan_links l where l.trade_id = t.id and l.created_at < t.created_at)
                                or exists (select 1 from public.trade_revisions r where r.trade_id = t.id and r.created_at < t.created_at)`)).rows).toEqual([]);
    const imported = (await db.query<{ trade_created: Date; locked: Date; revision_created: Date }>(`select t.created_at as trade_created, p.locked_at as locked, r.created_at as revision_created
        from public.trade_plan_links l join public.trades t on t.id = l.trade_id join public.trade_plans p on p.id = l.plan_id
        join public.trade_revisions r on r.trade_id = t.id where l.plan_id = $1`, [plans.l4])).rows[0];
    expect(imported.trade_created).toEqual(imported.locked);
    expect(imported.revision_created.getTime()).toBeGreaterThan(imported.locked.getTime());
    const owners = (await db.query<{ user_id: string; n: number }>("select user_id, count(*)::int as n from public.trades group by user_id order by user_id")).rows;
    expect(owners).toEqual([{ user_id: OWNER, n: 10 }, { user_id: OTHER, n: 2 }]);
  });

  it("creates one MIGRATION profile per account from its name and earliest balance", async () => {
    const rows = (await db.query<Json>(`select a.id, p.display_name, p.broker, p.platform, p.account_type, p.starting_balance::text as starting_balance, p.status, p.source
        from public.accounts a join public.account_profiles p on p.account_id = a.id order by a.created_at`)).rows;
    expect(rows).toEqual([
      { id: accounts.a1.accountId, display_name: "Demo one", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: "10000.00", status: "ACTIVE", source: "MIGRATION" },
      { id: accounts.a2.accountId, display_name: "Demo two", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: "20000.00", status: "ACTIVE", source: "MIGRATION" },
      { id: accounts.a3.accountId, display_name: "Demo three", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: "10000.00", status: "ACTIVE", source: "MIGRATION" },
      { id: accounts.b1.accountId, display_name: "Other user", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: "10000.00", status: "ACTIVE", source: "MIGRATION" },
    ]);
  });

  it("derives ledger lifecycles that agree with V1 journal_analytics where comparable", async () => {
    const rows = (await db.query<{ plan: string; v1: string; v2: string; v1_r: string | null; v2_r: string | null; v1_net: string | null; v2_net: string | null; executed: boolean; disposed: boolean; legacy: string | null }>(`
      select j.id as plan, j.status as v1, l.lifecycle as v2, j.realized_r as v1_r, l.realized_r as v2_r, j.net_pnl as v1_net, l.net_pnl as v2_net,
             j.execution_id is not null as executed, exists (select 1 from public.trade_dispositions d where d.plan_id = j.id) as disposed,
             l.legacy_decision as legacy
        from public.journal_analytics j join public.trade_ledger l on l.plan_id = j.id`)).rows;
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      // V1 TAKEN covers both "filled" and "decided to take, no fill yet"; V2 says LIVE or LOCKED. Every other V1
      // status keeps its name, including SKIPPED from a human decision alone.
      const expected = row.v1 === "TAKEN" ? (row.executed ? "LIVE" : "LOCKED") : row.v1;
      expect(row.v2, `${row.plan} ${row.v1}`).toBe(expected);
      expect(sameDecimal(row.v1_r, row.v2_r), `${row.plan} realized R`).toBe(true);
      expect(sameDecimal(row.v1_net, row.v2_net), `${row.plan} net P&L`).toBe(true);
    }
    const byPlan = Object.fromEntries(rows.map((r) => [r.plan, r]));
    expect([plans.l1, plans.l2, plans.l3, plans.l4, plans.l5, plans.l6, plans.l7].map((id) => `${byPlan[id].v1}→${byPlan[id].v2}`))
      .toEqual(["CLOSED→CLOSED", "SKIPPED→SKIPPED", "TAKEN→LIVE", "CANCELLED→CANCELLED", "SKIPPED→SKIPPED", "CLOSED→CLOSED", "TAKEN→LOCKED"]);
    expect([byPlan[plans.l2].disposed, byPlan[plans.l5].disposed]).toEqual([true, false]);
    expect([byPlan[plans.l5].legacy, byPlan[plans.l7].legacy]).toEqual(["SKIPPED", "TAKEN"]);
  });

  it("presents unlocked proposals as drafts with their latest check and legacy decision", async () => {
    const lifecycle = async (proposalId: string) => (await db.query<Json>(`select l.lifecycle, l.draft_check, l.legacy_decision, l.migrated_from, l.latest_proposal_id
        from public.trade_ledger l join public.trade_revisions r on r.trade_id = l.id where r.proposal_id = $1`, [proposalId])).rows[0];
    expect(await lifecycle(proposals.p3)).toMatchObject({ lifecycle: "DRAFT", draft_check: "BLOCKED", legacy_decision: null, migrated_from: "V1_PROPOSAL" });
    expect(await lifecycle(proposals.p4)).toMatchObject({ lifecycle: "SKIPPED", draft_check: null, legacy_decision: "SKIPPED" });
    // The newest check of P5 is the recheck made by record_setup_decision after both daily slots were used.
    expect(await lifecycle(proposals.p5)).toMatchObject({ lifecycle: "DRAFT", draft_check: "BLOCKED", legacy_decision: "TAKEN" });
    expect(await lifecycle(proposals.p9)).toMatchObject({ lifecycle: "DRAFT", draft_check: "APPROVED", latest_proposal_id: proposals.p9 });
    expect(await lifecycle(proposals.p10)).toMatchObject({ lifecycle: "DRAFT", draft_check: "APPROVED" });
  });

  it("carries legacy evidence, notes, tags and outcomes into the ledger", async () => {
    const closed = (await db.query<Json>("select * from public.trade_ledger where plan_id = $1", [plans.l1])).rows[0];
    expect(closed).toMatchObject({
      origin: "PLANNED", migrated_from: "V1_PLAN", lifecycle: "CLOSED", revision_count: 1, latest_proposal_id: proposals.p1,
      evidence_count: 1, cover_evidence_id: screenshots.p1, cover_evidence_kind: "LEGACY", journal_count: 2,
      tag_source: "V1", setup_grade: "A", liquidity_context: "PDH", mss_timeframe: "M5", tags: [],
      planned_entry: "1.1", planned_rr: "3", planned_quantity: "0.25", initial_risk: "50", fees: "1.5", net_pnl: "98.5", realized_r: "1.97",
      legacy_decision: "TAKEN", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0", currency: "USD",
    });
    expect((await db.query<Json>("select evidence_count, cover_evidence_id from public.trade_ledger l join public.trade_revisions r on r.trade_id = l.id where r.proposal_id = $1", [proposals.p3])).rows[0])
      .toEqual({ evidence_count: 0, cover_evidence_id: null });
    const direct = (await db.query<Json>("select * from public.trade_ledger where plan_id = $1", [plans.l3])).rows[0];
    expect(direct).toMatchObject({ lifecycle: "LIVE", revision_count: 0, latest_revision: null, latest_proposal_id: null, symbol: "EURUSD", quantity: "0.5", planned_quantity: "0.5", oversize: false });
  });

  it("lets V2 RPCs continue migrated trades and keeps V1 bootstrap working", async () => {
    const b1 = accounts.b1;
    const draftTrade = await value<string>("select r.trade_id as value from public.trade_revisions r where r.proposal_id = $1", [proposals.p9]);
    await db.actor(OTHER);
    const revised = await value<{ revision: number }>("select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5) as value",
      [draftTrade, JSON.stringify(proposal(b1, { ...SECOND_PRICES, narrative: "Revised after migration" })), randomUUID(), b1.riskId, b1.observationId]);
    expect(revised.revision).toBe(2);
    expect(await value<CheckEnvelope>("select public.lock_trade($1, 2) as value", [draftTrade])).toMatchObject({ planId: expect.any(String) });
    const closedTrade = await value<string>("select trade_id as value from public.trade_plan_links where plan_id = $1", [plans.l6]);
    expect(await value<Json>("select public.complete_trade_review($1, null) as value", [closedTrade])).toMatchObject({ lifecycle: "REVIEWED" });
    await db.actor(OWNER);
    const liveTrade = await value<string>("select trade_id as value from public.trade_plan_links where plan_id = $1", [plans.l3]);
    const note = await value<string>("select public.add_journal_entry($1, 'NOTE', 'Still running after the upgrade', '{}'::jsonb, $2) as value", [liveTrade, randomUUID()]);
    expect((await db.query<Json>("select phase, state_at_creation from public.trade_journal_entries where id = $1", [note])).rows[0]).toEqual({ phase: "LIVE", state_at_creation: "LIVE" });
    const fresh = await db.bootstrapAccount(OWNER, { name: "After upgrade" });
    expect(fresh.strategyId).toBeTruthy();
    expect(await value<string>("select public.trading_os_schema() as value")).toBe("2.0");
  });
});

describe("strategy template line endings", () => {
  it.each(["as checked out", "with flipped line endings"])("matches what bootstrap_demo_account inserts when 0002 is applied %s", async (variant) => {
    const flipped = variant !== "as checked out";
    const isolated = await createTestDatabase([OWNER]);
    try {
      for (const name of migrationFiles()) {
        const source = readMigration(name);
        const crlf = source.includes("\r\n");
        await isolated.exec(name.startsWith("0002_") && flipped ? (crlf ? source.replaceAll("\r\n", "\n") : source.replaceAll("\n", "\r\n")) : source);
      }
      const account = await isolated.bootstrapAccount(OWNER);
      await isolated.admin();
      const row = (await isolated.query<{ same: boolean; carriage_returns: boolean }>(
        `select t.rules = s.rules and t.written_rules = s.written_rules as same, strpos(t.written_rules, chr(13)) > 0 as carriage_returns
           from private.strategy_templates t cross join public.strategy_versions s where s.id = $1`, [account.strategyId])).rows[0];
      expect(row.same).toBe(true);
      expect(row.carriage_returns).toBe(readMigration("0002_baseline.sql").includes("\r\n") !== flipped);
    } finally {
      await isolated.close();
    }
  }, 60_000);
});
