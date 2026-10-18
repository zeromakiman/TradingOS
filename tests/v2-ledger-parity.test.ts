import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { DRAFT_CHECKS, type DraftCheck, LIFECYCLES, type Lifecycle, ledgerRow, TRADE_ORIGINS } from "@/domain/ledger";
import { deriveDraftCheck, deriveLifecycle } from "@/domain/trade-state";
import { type BootstrappedAccount, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// §2.2: public.trade_ledger derives lifecycle and draft_check in SQL; deriveLifecycle/deriveDraftCheck mirror it in
// TypeScript. Every state is built on one fully migrated database: V1 plans, fills and decisions through the V1
// RPCs before 0015 (history the backfill carries over), V2 trades through the 0015 RPCs. V1 decisions on V2 trades
// run under the superuser role, which keeps the session's auth.uid() after 0019 revokes record_setup_decision from
// authenticated. Each ledger row is read as JSON, the shape PostgREST returns, and must parse with the ledger
// contract and agree with the TypeScript derivation.

type Json = Record<string, unknown>;
interface Scenario { name: string; lifecycle: Lifecycle; draftCheck: DraftCheck | null }
interface Draft { tradeId: string; proposalId: string }
interface PendingV1 { name: string; lifecycle: Lifecycle; draftCheck?: DraftCheck; planId?: string; proposalId?: string }

const SECOND_PRICES = { entry: "1.2", stop: "1.198", target: "1.206" };
const THIRD_PRICES = { entry: "1.3", stop: "1.298", target: "1.306" };

let db: TestDatabase;
const scenarios = new Map<string, Scenario>();
const v1History: PendingV1[] = [];
let rows: Json[] = [];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const proposalJson = (a: BootstrappedAccount, changes: Json = {}) =>
  JSON.stringify({ ...previewProposal, instrumentId: a.instrumentId, narrative: "Parity fixture", contractConfirmed: true, news: "CLEAR", ...changes });

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  await db.actor(OWNER);
  const { rows: result } = await db.query<{ value: T }>(sql, params);
  return result[0].value;
}
async function call(sql: string, params: unknown[] = []): Promise<void> {
  await db.actor(OWNER);
  await db.query(sql, params);
}
function expectScenario(tradeId: string, name: string, lifecycle: Lifecycle, draftCheck: DraftCheck | null = null): void {
  scenarios.set(tradeId, { name, lifecycle, draftCheck });
}
function scenarioOf(row: Json): Scenario {
  const scenario = scenarios.get(String(row.id));
  if (!scenario) throw new Error(`Ledger row ${String(row.id)} belongs to no scenario`);
  return scenario;
}
const account = () => db.bootstrapAccount(OWNER);

// ---- V1 history (migrations 0001–0014 only). Each plan gets its own account, clear of daily limits.
async function v1Plan(): Promise<{ planId: string; proposalId: string }> {
  const a = await account();
  const proposalId = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, proposalJson(a), randomUUID(), a.riskId, a.observationId]);
  const { planId } = await value<{ planId: string | null }>("select public.check_setup_risk($1, true) as value", [proposalId]);
  if (planId === null) throw new Error("A V1 fixture plan was blocked");
  return { planId, proposalId };
}

async function buildV1History(): Promise<void> {
  const closed = await v1Plan();
  await call("select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [closed.planId]);
  await call("select public.close_journal_trade($1, '1.104', clock_timestamp(), '0')", [closed.planId]);
  v1History.push({ name: "V1 plan, closed", lifecycle: "CLOSED", planId: closed.planId });

  const filledThenSkipped = await v1Plan();
  await call("select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [filledThenSkipped.planId]);
  await call("select public.record_setup_decision($1, 'SKIPPED', null)", [filledThenSkipped.proposalId]);
  v1History.push({ name: "V1 plan, filled, then a SKIPPED decision", lifecycle: "LIVE", planId: filledThenSkipped.planId });

  const skipped = await v1Plan();
  await call("select public.record_setup_decision($1, 'SKIPPED', 'Changed my mind after the lock')", [skipped.proposalId]);
  v1History.push({ name: "V1 plan with a SKIPPED decision", lifecycle: "SKIPPED", planId: skipped.planId });

  const taken = await v1Plan();
  await call("select public.record_setup_decision($1, 'TAKEN', null)", [taken.proposalId]);
  v1History.push({ name: "V1 plan with a TAKEN decision and no fill", lifecycle: "LOCKED", planId: taken.planId });

  for (const status of ["SKIPPED", "CANCELLED"] as const) {
    const disposed = await v1Plan();
    await call("select public.set_journal_disposition($1, $2, 'No displacement')", [disposed.planId, status]);
    v1History.push({ name: `V1 plan, disposition ${status}`, lifecycle: status, planId: disposed.planId });
  }

  const direct = await account();
  const { planId: directPlan } = await value<{ planId: string }>("select public.lock_trade_plan($1, $2::jsonb, $3, $4, $5) as value",
    [direct.accountId, proposalJson(direct), randomUUID(), direct.riskId, direct.observationId]);
  v1History.push({ name: "V1 plan locked without a proposal", lifecycle: "LOCKED", planId: directPlan });

  const a = await account();
  const proposal = (changes: Json = {}) => value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, proposalJson(a, changes), randomUUID(), a.riskId, a.observationId]);
  v1History.push({ name: "V1 proposal, approved", lifecycle: "DRAFT", draftCheck: "APPROVED", proposalId: await proposal() });
  v1History.push({ name: "V1 proposal, blocked", lifecycle: "DRAFT", draftCheck: "BLOCKED", proposalId: await proposal({ riskPercent: "2" }) });
  const skippedProposal = await proposal(SECOND_PRICES);
  await call("select public.record_setup_decision($1, 'SKIPPED', 'News risk')", [skippedProposal]);
  v1History.push({ name: "V1 proposal with a SKIPPED decision", lifecycle: "SKIPPED", proposalId: skippedProposal });
  const takenProposal = await proposal(THIRD_PRICES);
  await call("select public.record_setup_decision($1, 'TAKEN', null)", [takenProposal]);
  v1History.push({ name: "V1 proposal with a TAKEN decision", lifecycle: "DRAFT", draftCheck: "APPROVED", proposalId: takenProposal });
}

async function resolveV1History(): Promise<void> {
  for (const fixture of v1History) {
    const tradeId = fixture.planId
      ? await value<string>("select trade_id as value from public.trade_plan_links where plan_id = $1", [fixture.planId])
      : await value<string>("select trade_id as value from public.trade_revisions where proposal_id = $1", [fixture.proposalId]);
    expectScenario(tradeId, fixture.name, fixture.lifecycle, fixture.draftCheck ?? null);
  }
}

// ---- V2 trades (all migrations).
function draft(a: BootstrappedAccount, changes: Json = {}): Promise<Draft> {
  return value<Draft>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, proposalJson(a, changes), randomUUID(), a.riskId, a.observationId]);
}
// One plan per account keeps every lock clear of the daily trade limit and the duplicate rule.
async function lockedDraft(): Promise<Draft> {
  const created = await draft(await account());
  const { planId } = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [created.tradeId]);
  if (planId === null) throw new Error("A V2 fixture plan was blocked");
  return created;
}
async function legacyDecision(proposalId: string, decision: "TAKEN" | "SKIPPED"): Promise<void> {
  await db.actor(OWNER);
  await db.admin();
  await db.query("select public.record_setup_decision($1, $2, null)", [proposalId, decision]);
}
const enter = (tradeId: string) => call("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [tradeId]);
const closePlanned = (tradeId: string) => call("select public.close_planned_trade($1, '1.104', clock_timestamp(), '0')", [tradeId]);
const completeReview = (tradeId: string) => call("select public.complete_trade_review($1, null)", [tradeId]);
const liveTrade = (a: BootstrappedAccount, input: Json) =>
  value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify(input), randomUUID()]);
const closeLive = (tradeId: string, input: Json) => call("select public.close_live_trade($1, $2::jsonb)", [tradeId, JSON.stringify(input)]);

// Saving through the RPCs always runs the free check, so a revision without one is inserted directly.
async function uncheckedDraft(a: BootstrappedAccount): Promise<string> {
  const [evaluationId, proposalId, tradeId] = [randomUUID(), randomUUID(), randomUUID()];
  await db.admin();
  await db.query("insert into public.risk_evaluations(id, user_id, account_id, proposal, result) values ($1, $2, $3, $4::jsonb, '{}'::jsonb)",
    [evaluationId, OWNER, a.accountId, proposalJson(a)]);
  await db.query(`insert into public.setup_proposals(id, user_id, account_id, strategy_version_id, instrument_version_id, risk_evaluation_id, proposal, request_key)
                  values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [proposalId, OWNER, a.accountId, a.strategyId, a.instrumentId, evaluationId, proposalJson(a), randomUUID()]);
  await db.query("insert into public.trades(id, user_id, account_id, origin) values ($1, $2, $3, 'PLANNED')", [tradeId, OWNER, a.accountId]);
  await db.query("insert into public.trade_revisions(proposal_id, trade_id, revision, user_id, account_id) values ($1, $2, 1, $3, $4)",
    [proposalId, tradeId, OWNER, a.accountId]);
  return tradeId;
}

// IMPORTED trades come from the platform ingest (0017); this inserts what it records first.
async function importedTrade(a: BootstrappedAccount, symbol: string): Promise<string> {
  const tradeId = randomUUID();
  await db.admin();
  await db.query("insert into public.trades(id, user_id, account_id, origin) values ($1, $2, $3, 'IMPORTED')", [tradeId, OWNER, a.accountId]);
  await db.query("insert into public.trade_position_facts(user_id, account_id, trade_id, symbol, direction, source) values ($1, $2, $3, $4, 'LONG', 'IMPORT')",
    [OWNER, a.accountId, tradeId, symbol]);
  return tradeId;
}

async function buildV2Trades(): Promise<void> {
  const drafts = await account();
  const approved = await draft(drafts);
  expectScenario(approved.tradeId, "draft, approved", "DRAFT", "APPROVED");
  expectScenario((await draft(drafts, { riskPercent: "2" })).tradeId, "draft, blocked", "DRAFT", "BLOCKED");
  expectScenario(await uncheckedDraft(drafts), "draft without a check", "DRAFT", "UNCHECKED");
  const taken = await draft(drafts, SECOND_PRICES);
  await legacyDecision(taken.proposalId, "TAKEN");
  expectScenario(taken.tradeId, "draft with a legacy TAKEN decision", "DRAFT", "APPROVED");
  const skipped = await draft(drafts, THIRD_PRICES);
  await legacyDecision(skipped.proposalId, "SKIPPED");
  expectScenario(skipped.tradeId, "draft with a legacy SKIPPED decision", "SKIPPED");
  const discarded = await draft(drafts);
  await call("select public.discard_trade_draft($1, null, null)", [discarded.tradeId]);
  expectScenario(discarded.tradeId, "discarded draft", "DISCARDED");
  const copy = await value<Draft>("select public.duplicate_trade_draft($1, $2, $3, $4) as value",
    [approved.tradeId, randomUUID(), drafts.riskId, drafts.observationId]);
  expectScenario(copy.tradeId, "duplicated draft", "DRAFT", "APPROVED");
  const revised = await draft(drafts);
  await value("select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5) as value",
    [revised.tradeId, proposalJson(drafts, { riskPercent: "2" }), randomUUID(), drafts.riskId, drafts.observationId]);
  expectScenario(revised.tradeId, "draft revised into a blocked revision", "DRAFT", "BLOCKED");

  const viaV1 = await draft(await account());
  await call("select public.check_setup_risk($1, true)", [viaV1.proposalId]);
  expectScenario(viaV1.tradeId, "draft locked through the V1 RPC", "LOCKED");
  expectScenario((await lockedDraft()).tradeId, "locked", "LOCKED");
  const lockedTaken = await lockedDraft();
  await legacyDecision(lockedTaken.proposalId, "TAKEN");
  expectScenario(lockedTaken.tradeId, "locked with a legacy TAKEN decision", "LOCKED");
  const lockedSkipped = await lockedDraft();
  await legacyDecision(lockedSkipped.proposalId, "SKIPPED");
  expectScenario(lockedSkipped.tradeId, "locked, then a legacy SKIPPED decision", "SKIPPED");
  const filledAfterSkip = await lockedDraft();
  await legacyDecision(filledAfterSkip.proposalId, "SKIPPED");
  await enter(filledAfterSkip.tradeId);
  expectScenario(filledAfterSkip.tradeId, "legacy SKIPPED decision, then a fill", "LIVE");
  const cancelledAfterSkip = await lockedDraft();
  await legacyDecision(cancelledAfterSkip.proposalId, "SKIPPED");
  await call("select public.set_planned_disposition($1, 'CANCELLED', 'Session ended')", [cancelledAfterSkip.tradeId]);
  expectScenario(cancelledAfterSkip.tradeId, "legacy SKIPPED decision, then a cancellation", "CANCELLED");
  for (const status of ["SKIPPED", "CANCELLED"] as const) {
    const disposed = await lockedDraft();
    await call("select public.set_planned_disposition($1, $2, 'No displacement')", [disposed.tradeId, status]);
    expectScenario(disposed.tradeId, `locked, disposition ${status}`, status);
  }
  const live = await lockedDraft();
  await enter(live.tradeId);
  expectScenario(live.tradeId, "live", "LIVE");
  const closed = await lockedDraft();
  await enter(closed.tradeId);
  await closePlanned(closed.tradeId);
  expectScenario(closed.tradeId, "closed", "CLOSED");
  const reviewed = await lockedDraft();
  await enter(reviewed.tradeId);
  await closePlanned(reviewed.tradeId);
  await completeReview(reviewed.tradeId);
  expectScenario(reviewed.tradeId, "reviewed", "REVIEWED");
  const reopened = await lockedDraft();
  await enter(reopened.tradeId);
  await closePlanned(reopened.tradeId);
  await completeReview(reopened.tradeId);
  await call("select public.reopen_trade_review($1, 'Missed a lesson', null)", [reopened.tradeId]);
  expectScenario(reopened.tradeId, "review reopened", "CLOSED");

  const unplanned = await account();
  expectScenario(await liveTrade(unplanned, { symbol: "XAUUSD", direction: "LONG" }), "live-first, symbol and direction only", "LIVE");
  const detailed = { instrumentId: unplanned.instrumentId, direction: "SHORT", entryModel: "OTE", entryPrice: "1.1", enteredAt: minutesAgo(30), quantity: "0.1", initialStop: "1.103" };
  expectScenario(await liveTrade(unplanned, detailed), "live-first with entry facts", "LIVE");
  const closedFirst = await liveTrade(unplanned, detailed);
  await closeLive(closedFirst, { exitPrice: "1.098", exitedAt: minutesAgo(1) });
  expectScenario(closedFirst, "live-first, closed", "CLOSED");
  const reviewedFirst = await liveTrade(unplanned, { symbol: "NAS100", direction: "LONG", riskAmount: "25" });
  await closeLive(reviewedFirst, { exitedAt: minutesAgo(1), netPnl: "-12.5" });
  await completeReview(reviewedFirst);
  expectScenario(reviewedFirst, "live-first, reviewed", "REVIEWED");
  expectScenario(await importedTrade(unplanned, "US30"), "imported, open", "LIVE");
  const importedClosed = await importedTrade(unplanned, "GER40");
  await closeLive(importedClosed, { exitedAt: minutesAgo(1), netPnl: "8" });
  expectScenario(importedClosed, "imported, closed", "CLOSED");
}

beforeAll(async () => {
  db = await createTestDatabase([OWNER]);
  await db.applyMigrations({ upTo: "0014" });
  await db.pinSession("ACTIVE_KILL_ZONE");
  await buildV1History();
  await db.applyMigrations();
  // A later migration may redefine the session function; keep lock scenarios deterministic.
  await db.pinSession("ACTIVE_KILL_ZONE");
  await resolveV1History();
  await buildV2Trades();
  await db.actor(OWNER);
  rows = (await db.query<{ row: Json }>("select to_jsonb(l) as row from public.trade_ledger l order by l.created_at, l.id")).rows.map((r) => r.row);
}, 120_000);
afterAll(async () => { await db.close(); });

describe("trade_ledger and deriveTradeState parity (§2.2)", () => {
  it("covers every lifecycle, draft check, origin and legacy decision with named scenarios", () => {
    expect(rows).toHaveLength(scenarios.size);
    const distinct = (column: string) => new Set(rows.map((row) => row[column]));
    expect(distinct("lifecycle")).toEqual(new Set(LIFECYCLES));
    expect(distinct("draft_check")).toEqual(new Set([...DRAFT_CHECKS, null]));
    expect(distinct("origin")).toEqual(new Set(TRADE_ORIGINS));
    expect(distinct("migrated_from")).toEqual(new Set(["V1_PLAN", "V1_PROPOSAL", null]));
    expect(distinct("legacy_decision")).toEqual(new Set(["TAKEN", "SKIPPED", null]));
  });

  it("derives the specified lifecycle and draft check in SQL for every scenario", () => {
    const actual = rows.map((row) => ({ scenario: scenarioOf(row).name, lifecycle: row.lifecycle, draftCheck: row.draft_check }));
    const expected = rows.map((row) => {
      const { name, lifecycle, draftCheck } = scenarioOf(row);
      return { scenario: name, lifecycle, draftCheck };
    });
    expect(actual).toEqual(expected);
  });

  it("parses every row with the ledger contract", () => {
    const failures = rows.flatMap((row) => {
      const parsed = ledgerRow.safeParse(row);
      return parsed.success ? [] : [`${scenarioOf(row).name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`];
    });
    expect(failures).toEqual([]);
  });

  it("agrees with deriveLifecycle and deriveDraftCheck on every row", () => {
    const mismatches = rows.flatMap((row) => {
      const trade = ledgerRow.parse(row);
      const typescript = { lifecycle: deriveLifecycle(trade), draftCheck: deriveDraftCheck(trade) };
      const sql = { lifecycle: row.lifecycle, draftCheck: row.draft_check };
      return typescript.lifecycle === sql.lifecycle && typescript.draftCheck === sql.draftCheck
        ? [] : [{ scenario: scenarioOf(row).name, sql, typescript }];
    });
    expect(mismatches).toEqual([]);
  });
});
