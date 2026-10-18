import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { type DailyUsage, type DuplicateCandidate, dailyUsageSchema, evaluateRisk, isDuplicatePlan, type RiskContext } from "@/domain/risk";
import { type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import { type BootstrappedAccount, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// Spec §6.3 DUPLICATE, §14.2 live preview: the TypeScript preview must compute RiskContext.duplicate exactly as
// private.assess_plan does, or it approves what the stored server check blocks (a draft duplicated from a plan locked
// today, §3.4 duplicate_trade_draft). isDuplicatePlan mirrors the SQL rule; a preview built with it equals the stored
// server check byte for byte except evaluatedAt.

const INSTRUMENT = "00000000-0000-4000-8000-000000000003";
const OTHER_INSTRUMENT = "00000000-0000-4000-8000-0000000000ff";
const BASE: Record<string, unknown> = {
  ...previewProposal, instrumentId: INSTRUMENT, narrative: "Sweep, then displacement through the M5 order block.", contractConfirmed: true, news: "CLEAR",
};
const lockedPlan = (changes: Record<string, unknown> = {}, instrumentVersionId = INSTRUMENT): DuplicateCandidate =>
  ({ instrumentVersionId, proposal: { ...BASE, ...changes } });

describe("isDuplicatePlan", () => {
  const today = [lockedPlan()];

  it("matches the same instrument version, direction and model with numerically equal entry, stop and target", () => {
    expect(isDuplicatePlan(BASE, today)).toBe(true);
    for (const prices of [{ entry: "1.1", stop: "1.098", target: "1.106" }, { entry: "01.10000000", stop: "1.09800000" }, { target: "1.106000" }]) {
      expect(isDuplicatePlan({ ...BASE, ...prices }, today), JSON.stringify(prices)).toBe(true);
    }
    expect(isDuplicatePlan({ ...BASE, instrumentId: INSTRUMENT.toUpperCase() }, today)).toBe(true);
    expect(isDuplicatePlan(BASE, [lockedPlan({}, INSTRUMENT.toUpperCase())])).toBe(true);
  });

  it("ignores risk, thesis, news and the confirmations", () => {
    const other = { riskPercent: "0.25", narrative: "Another thesis.", news: "UNKNOWN", contractConfirmed: false, contradiction: true };
    expect(isDuplicatePlan({ ...BASE, ...other }, today)).toBe(true);
  });

  it("needs every compared field to match", () => {
    for (const change of [{ instrumentId: OTHER_INSTRUMENT }, { direction: "SHORT" }, { model: "OTE" }, { entry: "1.09999" }, { stop: "1.09799" }, { target: "1.10601" }]) {
      expect(isDuplicatePlan({ ...BASE, ...change }, today), JSON.stringify(change)).toBe(false);
    }
    expect(isDuplicatePlan(BASE, [lockedPlan({}, OTHER_INSTRUMENT)])).toBe(false);
    expect(isDuplicatePlan(BASE, [])).toBe(false);
  });

  it("never matches a proposal without three price strings: the engine reports it as INVALID_INPUT first", () => {
    const malformed = [
      { stop: null }, { entry: 1.1 }, { target: "1e1" }, { stop: "1.098000001" }, { entry: "1000000000000" }, { entry: "" }, { entry: "-1.1" },
      { entry: " 1.1" }, { instrumentId: 3 },
    ];
    for (const change of malformed) expect(isDuplicatePlan({ ...BASE, ...change }, today), JSON.stringify(change)).toBe(false);
    for (const raw of [null, undefined, "proposal", [BASE], 42]) expect(isDuplicatePlan(raw, today)).toBe(false);
    // SQL compares text with `=`: two missing directions are NULL = NULL, never equal.
    const { direction: _direction, ...withoutDirection } = BASE;
    expect(isDuplicatePlan(withoutDirection, [{ instrumentVersionId: INSTRUMENT, proposal: withoutDirection }])).toBe(false);
  });

  it("skips stored proposals it cannot read", () => {
    const unreadable: DuplicateCandidate[] = [{ instrumentVersionId: INSTRUMENT, proposal: null }, { instrumentVersionId: INSTRUMENT, proposal: { ...BASE, entry: 1.1 } }];
    expect(isDuplicatePlan(BASE, unreadable)).toBe(false);
    expect(isDuplicatePlan(BASE, [...unreadable, lockedPlan()])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Against the server: checks stored by create_planned_trade, duplicate_trade_draft, check_trade_risk, lock_trade
// (private.assess_plan) and the recheck of a locked plan (private.check_proposal_risk). Today's plans are read with
// the owner's session, as a page loader does.
// ---------------------------------------------------------------------------------------------------------------
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // Locks need an eligible session; the preview below evaluates at 14:00Z (kill zone) of the same strategy day.
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

interface Envelope { planId: string | null; result: RiskReportV12 }
interface Draft { tradeId: string; proposalId: string; result: RiskReportV12 }
interface ContextRow {
  observationId: string; observationDay: string; equity: string; currency: string;
  planId: string; version: string; maxRisk: string; defaultRisk: string | null; maxTrades: number; minRR: string;
  rrPolicy: "BLOCK" | "WARN"; newsPolicy: "BLOCK" | "WARN"; riskCap: string | null; lossCap: string | null;
  strategyId: string; strategy: string;
  instrumentId: string; symbol: string; instrumentCurrency: string; unit: string; tick: string; pip: string | null; tickValue: string; step: string; minimum: string;
}

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, params)).rows[0].value;
}
const proposalFor = (a: BootstrappedAccount, changes: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...BASE, instrumentId: a.instrumentId, ...changes });

async function draft(a: BootstrappedAccount, raw: Record<string, unknown>): Promise<Draft> {
  await db.actor(OWNER);
  return value("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [a.accountId, JSON.stringify(raw), randomUUID(), a.riskId, a.observationId]);
}
async function lockTrade(tradeId: string): Promise<Envelope> {
  await db.actor(OWNER);
  return value("select public.lock_trade($1, 1) as value", [tradeId]);
}
async function usageNow(a: BootstrappedAccount): Promise<DailyUsage> {
  await db.actor(OWNER);
  return dailyUsageSchema.parse(await value("select public.get_daily_risk_usage($1) as value", [a.accountId]));
}
/** The account's plans of strategy day `day` (owner session, RLS), optionally without one plan. */
async function todaysPlans(a: BootstrappedAccount, day: string, without: string | null = null): Promise<DuplicateCandidate[]> {
  await db.actor(OWNER);
  const { rows } = await db.query<{ instrument_version_id: string; proposal: unknown }>(
    "select instrument_version_id, proposal from public.trade_plans where account_id = $1 and trading_day = $2::date and id is distinct from $3::uuid order by locked_at, id",
    [a.accountId, day, without]);
  return rows.map(row => ({ instrumentVersionId: row.instrument_version_id, proposal: row.proposal }));
}
/** The engine context of the server check, at 14:00Z of the usage's strategy day, with `duplicate` from today's plans. */
async function contextOf(a: BootstrappedAccount, raw: Record<string, unknown>, usage: DailyUsage, todays: readonly DuplicateCandidate[]): Promise<RiskContext> {
  await db.admin();
  const row = (await db.query<ContextRow>(`
    select o.id as "observationId", o.trading_day::text as "observationDay", o.equity::text as equity, ac.currency,
           r.id as "planId", r.version, r.max_risk_percent::text as "maxRisk", r.default_risk_percent::text as "defaultRisk",
           r.max_daily_trades as "maxTrades", r.min_rr::text as "minRR", r.rr_policy as "rrPolicy", r.news_policy as "newsPolicy",
           r.daily_risk_cap::text as "riskCap", r.daily_loss_cap::text as "lossCap", s.id as "strategyId", s.version as strategy,
           i.id as "instrumentId", i.symbol, i.currency as "instrumentCurrency", i.quantity_unit as unit, i.tick_size::text as tick,
           i.pip_size::text as pip, i.tick_value::text as "tickValue", i.quantity_step::text as step, i.minimum_quantity::text as minimum
      from public.accounts ac
      cross join lateral private.active_risk_plan(ac.id, private.strategy_day(clock_timestamp())) r
      cross join lateral (select * from public.account_observations x where x.account_id = ac.id order by x.recorded_at desc, x.id desc limit 1) o
      join public.strategy_versions s on s.account_id = ac.id and s.version = 'ICT V1.0'
      join public.instrument_versions i on i.account_id = ac.id and i.id = $2::uuid
     where ac.id = $1`, [a.accountId, String(raw.instrumentId)])).rows[0];
  return {
    now: `${usage.day}T14:00:00Z`, strategyVersionId: row.strategyId, strategyVersion: row.strategy,
    observationId: row.observationId, observationDay: row.observationDay, equity: row.equity, currency: row.currency,
    plan: {
      id: row.planId, version: row.version, maxRiskPercent: row.maxRisk, defaultRiskPercent: row.defaultRisk, maxDailyTrades: row.maxTrades,
      minRR: row.minRR, rrPolicy: row.rrPolicy, newsPolicy: row.newsPolicy, dailyRiskCap: row.riskCap, dailyLossCap: row.lossCap,
    },
    instrument: {
      id: row.instrumentId, symbol: row.symbol, currency: row.instrumentCurrency, quantityUnit: row.unit, tickSize: row.tick, pipSize: row.pip,
      tickValue: row.tickValue, quantityStep: row.step, minimumQuantity: row.minimum,
    },
    usage, duplicate: isDuplicatePlan(raw, todays),
  };
}
/** The preview equals the stored check except evaluatedAt, which lies on the same strategy day. */
function expectSameReport(preview: RiskReportV12, stored: RiskReportV12, label: string): void {
  const { evaluatedAt: previewAt, ...shown } = preview;
  const { evaluatedAt: storedAt, ...server } = stored;
  expect(server, label).toEqual(shown);
  expect(strategyClock(storedAt).day, label).toBe(strategyClock(previewAt).day);
  expect(riskReportSchemaV12.safeParse(stored).success, label).toBe(true);
}

describe("isDuplicatePlan agrees with the server check", () => {
  it("a draft duplicated from a plan locked today: the preview blocks it exactly like the stored check, the check and the lock", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const original = await draft(a, proposalFor(a));
    expect((await lockTrade(original.tradeId)).planId).toBeTruthy();
    await db.actor(OWNER);
    const copy = await value<{ tradeId: string; proposalId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value",
      [original.tradeId, randomUUID(), a.riskId, a.observationId]);
    const stored = await value<RiskReportV12>(
      "select e.result as value from public.setup_proposals s join public.risk_evaluations e on e.id = s.risk_evaluation_id where s.id = $1", [copy.proposalId]);
    expect(stored.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code)).toEqual(["DUPLICATE"]);
    const copied = await value<Record<string, unknown>>("select proposal as value from public.setup_proposals where id = $1", [copy.proposalId]);
    expect(copied).toEqual(proposalFor(a, { news: "UNKNOWN" }));

    const usage = await usageNow(a);
    const todays = await todaysPlans(a, usage.day);
    expect(todays).toHaveLength(1);
    expect(isDuplicatePlan(copied, todays)).toBe(true);
    const context = await contextOf(a, copied, usage, todays);
    const preview = evaluateRisk(copied, context);
    expectSameReport(preview, stored, "duplicated draft");
    // Assuming no duplicate would show "approved" next to the stored "Blocked: duplicate plan".
    expect(evaluateRisk(copied, { ...context, duplicate: false }).decision).toBe("APPROVED");

    await db.actor(OWNER);
    const check = await value<Envelope>("select public.check_trade_risk($1) as value", [copy.tradeId]);
    expectSameReport(preview, check.result, "check_trade_risk");
    const lock = await lockTrade(copy.tradeId);
    expect(lock.planId).toBeNull();
    expectSameReport(preview, lock.result, "lock_trade");
  });

  it("agrees on variants of today's plan: instrument, direction, model and prices in any form", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.admin();
    const gbpusd = await value<string>("select id as value from public.instrument_versions where account_id = $1 and symbol = 'GBPUSD'", [a.accountId]);
    const original = await draft(a, proposalFor(a));
    expect((await lockTrade(original.tradeId)).planId).toBeTruthy();
    const usage = await usageNow(a);
    const todays = await todaysPlans(a, usage.day);
    const variants: [string, Record<string, unknown>, boolean][] = [
      ["same setup, other thesis and risk", { narrative: "A second look at the same setup.", riskPercent: "0.25" }, true],
      ["short price forms", { entry: "1.1", stop: "1.098", target: "1.106" }, true],
      ["leading zero and eight decimals", { entry: "01.10000000", target: "1.10600000" }, true],
      ["uppercase instrument id", { instrumentId: a.instrumentId.toUpperCase() }, true],
      ["news not checked, contradiction flagged", { news: "UNKNOWN", contradiction: true }, true],
      ["other model", { model: "OTE" }, false],
      ["entry one tick lower", { entry: "1.09999" }, false],
      ["stop one tick lower", { stop: "1.09799" }, false],
      ["target one tick higher", { target: "1.10601" }, false],
      ["other instrument, same prices", { instrumentId: gbpusd }, false],
      ["short setup", { direction: "SHORT", stop: "1.10200", target: "1.09400" }, false],
      ["missing stop", { stop: null }, false],
    ];
    for (const [label, changes, duplicate] of variants) {
      const raw = proposalFor(a, changes);
      const created = await draft(a, raw);
      expect(isDuplicatePlan(raw, todays), label).toBe(duplicate);
      expect(created.result.issues.some(issue => issue.code === "DUPLICATE"), label).toBe(duplicate);
      expectSameReport(evaluateRisk(raw, await contextOf(a, raw, usage, todays)), created.result, label);
    }
    // Drafts reserve nothing: today's plans and usage did not change.
    expect(await usageNow(a)).toEqual(usage);
    expect(await todaysPlans(a, usage.day)).toEqual(todays);
  });

  it("a recheck of a locked plan leaves that plan out, as check_proposal_risk does", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const raw = proposalFor(a);
    const original = await draft(a, raw);
    const lock = await lockTrade(original.tradeId);
    const planId = String(lock.planId);
    await db.actor(OWNER);
    const recheck = await value<Envelope>("select public.check_setup_risk($1, false) as value", [original.proposalId]);
    expect(recheck.planId).toBe(planId);
    expect(recheck.result.issues.some(issue => issue.code === "DUPLICATE")).toBe(false);
    await db.admin();
    const usage = dailyUsageSchema.parse(await value("select private.daily_usage($1, clock_timestamp(), $2) as value", [a.accountId, planId]));
    expect(isDuplicatePlan(raw, await todaysPlans(a, usage.day))).toBe(true);
    const others = await todaysPlans(a, usage.day, planId);
    expect(others).toEqual([]);
    expectSameReport(evaluateRisk(raw, await contextOf(a, raw, usage, others)), recheck.result, "recheck");
  });
});
