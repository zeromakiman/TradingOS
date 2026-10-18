import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { type DailyUsage, dailyUsageSchema, evaluateRisk, type RiskContext } from "@/domain/risk";
import { explainIssue } from "@/domain/risk-explain";
import { type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import { type BootstrappedAccount, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// Precision audit §4 (reports/precision.md): every boundary case T1–T29 and money scenario S1–S6, through
// private.risk_report_v12 with an explicit p_now AND through evaluateRisk, which must agree byte for byte.
// Base: EURUSD (tick 0.00001, pip 0.0001, tick value 1, step 0.01, minimum 0.01); equity 10000.00, observation day
// 2026-09-04, now 2026-09-04T14:00:00Z; Risk Plan max 0.5, min RR 3 BLOCK, 2 trades/day, news WARN, no caps;
// LONG OB_FIRST_TOUCH 1.10000/1.09800/1.10600, risk "0.5", news CLEAR, contract confirmed.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
}, 60_000);
afterAll(async () => { await db.close(); });

const BASE: RiskContext = previewContext;
const PROPOSAL = { ...previewProposal, narrative: "Liquidity sweep, then displacement through the M5 order block.", contractConfirmed: true, news: "CLEAR" as const };
const NOTES = ["DAILY_RISK_UNCONFIGURED:WARN", "DAILY_LOSS_UNCONFIGURED:WARN", "COSTS_UNKNOWN:WARN"];

type Report = Omit<RiskReportV12, "evaluatedAt">;

/** Report 1.2 of the SQL engine for an explicit context (rows built with jsonb_populate_record, p_now explicit). */
async function sqlReport(raw: unknown, ctx: RiskContext): Promise<RiskReportV12> {
  await db.admin();
  const { rows } = await db.query<{ report: RiskReportV12 }>(`
    select private.risk_report_v12($1::jsonb,
      jsonb_populate_record(null::public.accounts, $2::jsonb),
      jsonb_populate_record(null::public.account_observations, $3::jsonb),
      jsonb_populate_record(null::public.risk_plan_versions, $4::jsonb),
      jsonb_populate_record(null::public.instrument_versions, $5::jsonb),
      jsonb_populate_record(null::public.strategy_versions, $6::jsonb),
      $7::timestamptz, $8::jsonb, $9::boolean) as report`, [
    JSON.stringify(raw === undefined ? null : raw),
    JSON.stringify({ currency: ctx.currency }),
    JSON.stringify({ id: ctx.observationId, equity: ctx.equity, trading_day: ctx.observationDay }),
    JSON.stringify({ id: ctx.plan.id, version: ctx.plan.version, max_risk_percent: ctx.plan.maxRiskPercent, default_risk_percent: ctx.plan.defaultRiskPercent,
      max_daily_trades: ctx.plan.maxDailyTrades, min_rr: ctx.plan.minRR, rr_policy: ctx.plan.rrPolicy, news_policy: ctx.plan.newsPolicy,
      daily_risk_cap: ctx.plan.dailyRiskCap, daily_loss_cap: ctx.plan.dailyLossCap }),
    JSON.stringify({ id: ctx.instrument.id, symbol: ctx.instrument.symbol, currency: ctx.instrument.currency, quantity_unit: ctx.instrument.quantityUnit,
      tick_size: ctx.instrument.tickSize, pip_size: ctx.instrument.pipSize, tick_value: ctx.instrument.tickValue,
      quantity_step: ctx.instrument.quantityStep, minimum_quantity: ctx.instrument.minimumQuantity }),
    JSON.stringify({ id: ctx.strategyVersionId, version: ctx.strategyVersion }),
    ctx.now, JSON.stringify(ctx.usage), ctx.duplicate,
  ]);
  return rows[0].report;
}

/** Both engines, asserted identical (except evaluatedAt) and schema-valid; returns the shared report. */
async function evaluateBoth(raw: unknown, ctx: RiskContext): Promise<Report> {
  const { evaluatedAt: tsAt, ...ts } = evaluateRisk(raw, ctx);
  const sqlFull = await sqlReport(raw, ctx);
  const { evaluatedAt: sqlAt, ...sql } = sqlFull;
  expect(sql).toEqual(ts);
  expect(riskReportSchemaV12.safeParse(sqlFull).success).toBe(true);
  expect(new Date(sqlAt).getTime()).toBe(new Date(tsAt).getTime());
  return ts;
}

const codes = (report: Report) => report.issues.map(issue => `${issue.code}:${issue.severity}`);
const issue = (report: Report, code: string) => report.issues.find(i => i.code === code);
const context = (changes: Partial<RiskContext> = {}, plan: Partial<RiskContext["plan"]> = {}, usage: Partial<DailyUsage> = {}): RiskContext => ({
  ...BASE, ...changes, plan: { ...BASE.plan, ...plan }, usage: usageFixture(usage, changes.usage ?? BASE.usage),
});
const run = (proposal: Record<string, unknown> = {}, ctx: RiskContext = BASE) => evaluateBoth({ ...PROPOSAL, ...proposal }, ctx);

describe("precision audit boundaries T1–T29 (both engines, explicit p_now)", () => {
  it("T1 base plan: approved, 50.00 budget, 0.25 lots, nominal 50, 3R", async () => {
    const r = await run();
    expect(r.decision).toBe("APPROVED");
    expect(codes(r)).toEqual(NOTES);
    expect(r.calculations).toEqual({ budget: "50", permittedRisk: "50", stopDistance: "0.002", stopTicks: "200", stopPips: "20", plannedRR: "3", quantity: "0.25", nominalRisk: "50", plannedReward: "150" });
    expect(r.ruleResults.every(rule => rule.outcome === "PASS" || (rule.rule.startsWith("DAILY_") && rule.outcome === "NOT_EVALUATED"))).toBe(true);
  });

  it("T2 target 1.10599: blocked MIN_RR at exactly 2.995, never displayed as the minimum", async () => {
    const r = await run({ target: "1.10599" });
    expect(codes(r)).toEqual(["MIN_RR:BLOCK", ...NOTES]);
    expect(r.calculations?.plannedRR).toBe("2.995");
    expect(issue(r, "MIN_RR")).toMatchObject({ params: { rr: "2.995", min: "3" }, message: "Planned RR 2.995R is below the required minimum of 3.00R." });
    const shown = explainIssue(issue(r, "MIN_RR") as RiskReportV12["issues"][number], riskReportSchemaV12.parse({ ...r, evaluatedAt: BASE.now }));
    expect(shown.detail).toBe("Planned RR 2.99R is below the required minimum of 3.00R.");
  });

  it("T3 stop 1.09700 target 1.10899: MIN_RR at 2.99666666, 0.16 lots, nominal 48", async () => {
    const r = await run({ stop: "1.09700", target: "1.10899" });
    expect(codes(r)).toEqual(["MIN_RR:BLOCK", ...NOTES]);
    expect(r.calculations).toMatchObject({ plannedRR: "2.99666666", quantity: "0.16", nominalRisk: "48" });
  });

  it("T4/T5 minimum RR 2.995 passes at equality, 2.996 blocks", async () => {
    expect((await run({ target: "1.10599" }, context({}, { minRR: "2.995" }))).decision).toBe("APPROVED");
    const blocked = await run({ target: "1.10599" }, context({}, { minRR: "2.996" }));
    expect(codes(blocked)).toEqual(["MIN_RR:BLOCK", ...NOTES]);
    expect(issue(blocked, "MIN_RR")?.params).toEqual({ rr: "2.995", min: "2.996" });
  });

  it("T6 WARN policy: approved with a MIN_RR warning", async () => {
    const r = await run({ target: "1.10599" }, context({}, { rrPolicy: "WARN" }));
    expect(r.decision).toBe("APPROVED");
    expect(codes(r)).toEqual(["MIN_RR:WARN", ...NOTES]);
    expect(issue(r, "MIN_RR")?.message).toBe("Planned RR 2.995R is below your 3.00R minimum. Your risk plan allows it with a warning.");
    expect(r.ruleResults.find(rule => rule.rule === "MIN_RR")?.outcome).toBe("WARN");
  });

  it.each(["0.5", "0.50", "0.50000000"])("T7 risk %s is the same request: approved, budget 50", async riskPercent => {
    const r = await run({ riskPercent });
    expect(r.decision).toBe("APPROVED");
    expect(r.requestedRiskPercent).toBe("0.5");
    expect(r.calculations?.budget).toBe("50");
  });

  it("T8 risk 0.50000001: RISK_LIMIT although budget and permitted risk are both 50.00", async () => {
    const r = await run({ riskPercent: "0.50000001" });
    expect(codes(r)).toEqual(["RISK_LIMIT:BLOCK", ...NOTES]);
    expect(r.calculations).toMatchObject({ budget: "50", permittedRisk: "50" });
    expect(issue(r, "RISK_LIMIT")).toMatchObject({ params: { requested: "0.50000001", maximum: "0.5" }, message: "Requested risk 0.50000001% exceeds your configured maximum of 0.50%." });
  });

  it("T9 risk 0.504: RISK_LIMIT, budget 50.40 vs permitted 50.00, shown exactly", async () => {
    const r = await run({ riskPercent: "0.504" });
    expect(codes(r)).toEqual(["RISK_LIMIT:BLOCK", ...NOTES]);
    expect(r.calculations).toMatchObject({ budget: "50.4", permittedRisk: "50" });
    expect(issue(r, "RISK_LIMIT")?.message).toBe("Requested risk 0.504% exceeds your configured maximum of 0.50%.");
  });

  it("T10/T11 maximum 0.755: 0.755 approved (75.50, 0.37 lots, nominal 74), 0.76 blocked (76.00 vs 75.50)", async () => {
    const ctx = context({}, { maxRiskPercent: "0.755", defaultRiskPercent: "0.755" });
    const approved = await run({ riskPercent: "0.755" }, ctx);
    expect(approved.decision).toBe("APPROVED");
    expect(approved.calculations).toMatchObject({ budget: "75.5", permittedRisk: "75.5", quantity: "0.37", nominalRisk: "74" });
    expect(approved.limits.maxRiskPercent).toBe("0.755");
    const blocked = await run({ riskPercent: "0.76" }, ctx);
    expect(codes(blocked)).toEqual(["RISK_LIMIT:BLOCK", ...NOTES]);
    expect(blocked.calculations).toMatchObject({ budget: "76", permittedRisk: "75.5" });
    expect(issue(blocked, "RISK_LIMIT")?.message).toBe("Requested risk 0.76% exceeds your configured maximum of 0.755%.");
  });

  it("T12/T13 daily risk cap 100: 50 reserved passes at 100, 50.01 blocks with the remaining risk", async () => {
    expect((await run({}, context({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50" }))).decision).toBe("APPROVED");
    const blocked = await run({}, context({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50.01" }));
    expect(codes(blocked)).toEqual(["DAILY_RISK_LIMIT:BLOCK", "DAILY_LOSS_UNCONFIGURED:WARN", "COSTS_UNKNOWN:WARN"]);
    expect(issue(blocked, "DAILY_RISK_LIMIT")).toMatchObject({
      params: { remaining: "49.99", nominal: "50", cap: "100", used: "50.01" },
      message: "Remaining daily risk 49.99 USD is insufficient for this trade's 50.00 USD risk (cap 100.00 USD).",
    });
  });

  it("daily risk cap already exceeded by reserved risk: a zero-size trade's sentence stays true; any other keeps the remaining risk", async () => {
    // Reserved 100 against a cap tightened to 50; a 5001-tick stop sizes the 50.00 budget to 0 lots.
    const zero = await run({ stop: "1.04999", target: "1.25003" }, context({}, { dailyRiskCap: "50" }, { plannedSlots: 1, plannedRisk: "100" }));
    expect(codes(zero)).toEqual(["MINIMUM_QUANTITY:BLOCK", "DAILY_RISK_LIMIT:BLOCK", "DAILY_LOSS_UNCONFIGURED:WARN", "COSTS_UNKNOWN:WARN"]);
    expect(zero.calculations).toMatchObject({ quantity: "0", nominalRisk: "0" });
    const sentence = "Today's reserved risk 100.00 USD plus this trade's 0.00 USD would exceed your daily risk cap of 50.00 USD.";
    expect(issue(zero, "DAILY_RISK_LIMIT")).toMatchObject({ params: { remaining: "0", nominal: "0", cap: "50", used: "100" }, message: sentence });
    expect(zero.ruleResults.find(rule => rule.rule === "DAILY_RISK_LIMIT")).toEqual({ rule: "DAILY_RISK_LIMIT", outcome: "BLOCK", message: sentence });
    const shown = explainIssue(issue(zero, "DAILY_RISK_LIMIT") as RiskReportV12["issues"][number], riskReportSchemaV12.parse({ ...zero, evaluatedAt: BASE.now }));
    expect(shown.detail).toBe("Today's reserved risk $100.00 plus this trade's $0.00 would exceed your daily risk cap of $50.00.");
    // Live-first risk counts as reserved risk too, at any scale.
    const mixed = await run({ stop: "1.04999", target: "1.25003" }, context({}, { dailyRiskCap: "50" }, { plannedRisk: "40.00000000000000000000000000000000", unplannedTrades: 1, unplannedRisk: "10.005" }));
    expect(issue(mixed, "DAILY_RISK_LIMIT")).toMatchObject({
      params: { remaining: "0", nominal: "0", cap: "50", used: "50.005" },
      message: "Today's reserved risk 50.005 USD plus this trade's 0.00 USD would exceed your daily risk cap of 50.00 USD.",
    });
    // With a positive nominal the remaining-risk sentence is true, also when nothing remains.
    const full = await run({}, context({}, { dailyRiskCap: "50" }, { plannedSlots: 1, plannedRisk: "50" }));
    expect(codes(full)).toEqual(["DAILY_RISK_LIMIT:BLOCK", "DAILY_LOSS_UNCONFIGURED:WARN", "COSTS_UNKNOWN:WARN"]);
    expect(issue(full, "DAILY_RISK_LIMIT")).toMatchObject({
      params: { remaining: "0", nominal: "50", cap: "50", used: "50" },
      message: "Remaining daily risk 0.00 USD is insufficient for this trade's 50.00 USD risk (cap 50.00 USD).",
    });
  });

  it("T14/T15 daily loss cap 100 with 50 open: losses 0.00 pass at 100, 0.01 blocks", async () => {
    const open = { plannedSlots: 1, plannedRisk: "50", openExposure: "50" };
    expect((await run({}, context({}, { dailyLossCap: "100" }, { ...open, realizedLoss: "0" }))).decision).toBe("APPROVED");
    const blocked = await run({}, context({}, { dailyLossCap: "100" }, { ...open, realizedLoss: "0.01" }));
    expect(codes(blocked)).toEqual(["DAILY_RISK_UNCONFIGURED:WARN", "DAILY_LOSS_LIMIT:BLOCK", "COSTS_UNKNOWN:WARN"]);
    expect(issue(blocked, "DAILY_LOSS_LIMIT")).toMatchObject({
      params: { loss: "0.01", open: "50", nominal: "50", cap: "100" },
      message: "Today's realized losses 0.01 USD plus open risk 50.00 USD plus this trade's 50.00 USD would exceed your daily loss limit of 100.00 USD.",
    });
  });

  it("T16 no reported loss total: 1.2 knows today's losses, so there is no DAILY_LOSS_UNKNOWN", async () => {
    const r = await run({}, context({}, { dailyLossCap: "100" }, { plannedSlots: 1, plannedRisk: "50", openExposure: "50", legacyReportedLoss: null }));
    expect(r.decision).toBe("APPROVED");
    expect(codes(r)).not.toContain("DAILY_LOSS_UNKNOWN:BLOCK");
    expect(r.snapshot).toMatchObject({ legacyReportedLoss: null, grossLoss: "0" });
  });

  it("T17 stale observation with a loss cap: STALE_EQUITY only", async () => {
    const r = await run({}, context({ observationDay: "2026-09-03" }, { dailyLossCap: "100" }));
    expect(codes(r)).toEqual(["STALE_EQUITY:BLOCK", "DAILY_RISK_UNCONFIGURED:WARN", "COSTS_UNKNOWN:WARN"]);
    expect(issue(r, "STALE_EQUITY")).toMatchObject({ params: { observationDay: "2026-09-03" }, message: "Confirm today's account balance before locking (last recorded 2026-09-03)." });
  });

  it("T18 slots 1 pass, 2 block; a live-first trade uses a slot too (§6.3)", async () => {
    expect((await run({}, context({}, {}, { plannedSlots: 1 }))).decision).toBe("APPROVED");
    const planned = await run({}, context({}, {}, { plannedSlots: 2 }));
    expect(codes(planned)).toEqual(["MAX_TRADES:BLOCK", ...NOTES]);
    const mixed = await run({}, context({}, {}, { plannedSlots: 1, unplannedTrades: 1 }));
    expect(issue(mixed, "MAX_TRADES")).toMatchObject({
      params: { used: 2, max: 2, planned: 1, unplanned: 1 },
      message: "Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live).",
    });
    expect(mixed.snapshot).toMatchObject({ slotsUsed: 2, executedTrades: 1, plannedSlots: 1, unplannedTrades: 1 });
  });

  it("T19/T20 minimum quantity at the 50.00 budget: 5000 ticks approved (0.01 lots), 5001 ticks blocked (0 lots)", async () => {
    const approved = await run({ stop: "1.05000", target: "1.25000" });
    expect(approved.decision).toBe("APPROVED");
    expect(approved.calculations).toMatchObject({ quantity: "0.01", nominalRisk: "50", budget: "50" });
    const blocked = await run({ stop: "1.04999", target: "1.25003" });
    expect(codes(blocked)).toEqual(["MINIMUM_QUANTITY:BLOCK", ...NOTES]);
    expect(blocked.calculations).toMatchObject({ quantity: "0", nominalRisk: "0", plannedRR: "3" });
    expect(issue(blocked, "MINIMUM_QUANTITY")).toMatchObject({
      params: { budget: "50", minQty: "0.01", unit: "lots (100,000 EUR)" },
      message: "Your 50.00 USD risk budget is too small for the minimum position size of 0.01 lots (100,000 EUR) at this stop.",
    });
  });

  it("T21 equity 12345.67 at risk = max = 0.33: budget truncated to 40.74, 0.20 lots, nominal 40", async () => {
    const r = await run({ riskPercent: "0.33" }, context({ equity: "12345.67" }, { maxRiskPercent: "0.33", defaultRiskPercent: null }));
    expect(r.decision).toBe("APPROVED");
    expect(r.calculations).toMatchObject({ budget: "40.74", permittedRisk: "40.74", quantity: "0.2", nominalRisk: "40" });
    expect(r.snapshot.equity).toBe("12345.67");
  });

  it("T22 short and 5-decimal price forms give the identical report", async () => {
    const short = await run({ entry: "1.1", stop: "1.098", target: "1.106" });
    const long = await run({ entry: "1.10000", stop: "1.09800", target: "1.10600" });
    expect(short).toEqual(long);
  });

  it("T23 entry 1.100001: OFF_TICK and MIN_RR, RR 2.99800099", async () => {
    const r = await run({ entry: "1.100001" });
    expect(codes(r)).toEqual(["OFF_TICK:BLOCK", "MIN_RR:BLOCK", ...NOTES]);
    expect(r.calculations?.plannedRR).toBe("2.99800099");
    expect(issue(r, "OFF_TICK")).toMatchObject({ params: { symbol: "EURUSD", tick: "0.00001" }, message: "Prices must align to the EURUSD tick size of 0.00001." });
  });

  it.each([
    ["2026-09-04T06:59:59.999Z", "JUDAS", "2026-09-04", ["OUTSIDE_ACTIVE:WARN", ...NOTES]],
    ["2026-09-04T07:00:00Z", "ACTIVE_KILL_ZONE", "2026-09-04", NOTES],
    ["2026-09-04T16:59:59.999Z", "ACTIVE_KILL_ZONE", "2026-09-04", NOTES],
    ["2026-09-04T17:00:00Z", "DEAD_POOL", "2026-09-04", ["DEAD_POOL:BLOCK", ...NOTES]],
    ["2026-09-04T22:59:59.999Z", "DEAD_POOL", "2026-09-04", ["DEAD_POOL:BLOCK", ...NOTES]],
    ["2026-09-04T23:00:00Z", "ASIA", "2026-09-04", ["OUTSIDE_ACTIVE:WARN", ...NOTES]],
    ["2026-09-05T04:59:59.999999Z", "ASIA", "2026-09-04", ["OUTSIDE_ACTIVE:WARN", ...NOTES]],
    ["2026-09-05T05:00:00Z", "ASIA", "2026-09-05", ["OUTSIDE_ACTIVE:WARN", "STALE_EQUITY:BLOCK", ...NOTES]],
  ] as const)("T24 at %s the session is %s on strategy day %s", async (now, session, day, expected) => {
    const r = await run({}, context({ now, usage: usageFixture({ day }) }));
    expect({ session: r.session, tradingDay: r.tradingDay, sessionEligible: r.sessionEligible }).toEqual({ session, tradingDay: day, sessionEligible: session !== "DEAD_POOL" });
    expect(codes(r)).toEqual(expected);
  });

  it("T25 missing stop in Dead Pool with both slots used reports MISSING_STOP, MAX_TRADES and DEAD_POOL", async () => {
    const r = await run({ stop: null }, context({ now: "2026-09-04T17:00:00Z" }, {}, { plannedSlots: 2 }));
    expect(codes(r)).toEqual(["MISSING_STOP:BLOCK", "MAX_TRADES:BLOCK", "DEAD_POOL:BLOCK"]);
    expect(r.calculations).toBeNull();
    const outcome = (rule: string) => r.ruleResults.find(result => result.rule === rule)?.outcome;
    expect([outcome("PRICE_GEOMETRY"), outcome("MIN_RR"), outcome("INSTRUMENT_MISMATCH"), outcome("STALE_EQUITY")]).toEqual(["NOT_EVALUATED", "NOT_EVALUATED", "PASS", "PASS"]);
  });

  it("T26 absurd prices: MINIMUM_QUANTITY and MIN_RR with the exact 8-decimal RR 2.99999999", async () => {
    const r = await run({ entry: "210000000000", stop: "1000000000", target: "836999999999.99999" });
    expect(codes(r)).toEqual(["MINIMUM_QUANTITY:BLOCK", "MIN_RR:BLOCK", ...NOTES]);
    expect(r.calculations).toMatchObject({ plannedRR: "2.99999999", quantity: "0", stopDistance: "209000000000" });
  });

  it("T27 reserved risk at SQL scale (32 decimals) is accepted and canonicalised", async () => {
    const r = await run({}, context({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50.00000000000000000000000000000000" }));
    expect(r.decision).toBe("APPROVED");
    expect(r.snapshot).toMatchObject({ plannedRisk: "50", riskConsumed: "50" });
  });

  it("T28 an uppercase instrument id is the same instrument in both engines", async () => {
    const r = await run({ instrumentId: BASE.instrument.id.toUpperCase() });
    expect(r.decision).toBe("APPROVED");
    expect(codes(r)).not.toContain("INSTRUMENT_MISMATCH:BLOCK");
  });

  it("T29 a blank-looking thesis is invalid input in both engines", async () => {
    for (const narrative of ["\n\t", "  　 ", ""]) {
      const r = await run({ narrative });
      expect(codes(r)).toEqual(["INVALID_INPUT:BLOCK"]);
      expect(issue(r, "INVALID_INPUT")).toMatchObject({ params: { fields: "narrative" }, message: "Add your thesis: why this trade, and what would invalidate it." });
    }
    expect((await run({ narrative: " \n x \t" })).decision).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// S1–S6: money logic over real trades. Usage comes from private.daily_usage; the check runs through
// private.risk_report_v12 with an explicit p_now (in the kill zone of the current strategy day) and through
// evaluateRisk with the same context; the RPC path (create_planned_trade / lock_trade) agrees.
// ---------------------------------------------------------------------------------------------------------------
describe("money logic S1–S6 over recorded trades", () => {
  const value = async <T,>(sql: string, params: unknown[] = []) => (await db.query<{ value: T }>(sql, params)).rows[0].value;
  const today = () => strategyClock(new Date()).day;
  const killZone = () => `${today()}T14:00:00Z`;
  const proposal = (a: BootstrappedAccount, changes: Record<string, unknown> = {}) => ({ ...PROPOSAL, instrumentId: a.instrumentId, ...changes });

  beforeAll(async () => { await db.pinSession("ACTIVE_KILL_ZONE"); });
  afterAll(async () => { await db.unpinSession(); });

  /** A distinct second setup of the same account (an identical plan of the day would be a DUPLICATE). */
  const OTHER_PRICES = { entry: "1.20000", stop: "1.19800", target: "1.20600" };

  async function plannedTrade(a: BootstrappedAccount, changes: Record<string, unknown> = {}) {
    await db.admin();
    const risk = await value<string>("select (private.active_risk_plan($1, private.strategy_day(clock_timestamp()))).id as value", [a.accountId]);
    const observation = await value<string>("select id as value from public.account_observations where account_id = $1 order by recorded_at desc, id desc limit 1", [a.accountId]);
    await db.actor(OWNER);
    return value<{ tradeId: string; result: RiskReportV12 }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a, changes)), randomUUID(), risk, observation]);
  }
  async function lock(tradeId: string) {
    await db.actor(OWNER);
    return value<{ planId: string | null; result: RiskReportV12 }>("select public.lock_trade($1, 1) as value", [tradeId]);
  }
  async function lossCap(a: BootstrappedAccount, cap: string) {
    await db.actor(OWNER);
    await db.query("select public.create_risk_policy_version($1, $2::jsonb, true, 'Synthetic loss limit')", [a.accountId, JSON.stringify({
      maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 3, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: cap })]);
  }
  /** Usage now, and the check of `changes` through both engines with that usage and an explicit p_now. */
  async function checkBoth(a: BootstrappedAccount, changes: Record<string, unknown> = {}) {
    await db.admin();
    const usage = dailyUsageSchema.parse(await value("select private.daily_usage($1, $2::timestamptz) as value", [a.accountId, killZone()]));
    const row = (await db.query<Record<string, string | number | null>>(`
      select o.id as "observationId", o.trading_day::text as "observationDay", o.equity::text as equity, r.id as "planId", r.version,
             r.max_risk_percent::text as max, r.default_risk_percent::text as "default", r.max_daily_trades as trades, r.min_rr::text as rr,
             r.rr_policy, r.news_policy, r.daily_risk_cap::text as risk_cap, r.daily_loss_cap::text as loss_cap, s.id as "strategyId"
        from private.active_risk_plan($1, private.strategy_day($2::timestamptz)) r
        cross join lateral (select * from public.account_observations x where x.account_id = $1 order by x.recorded_at desc, x.id desc limit 1) o
        join public.strategy_versions s on s.account_id = $1`, [a.accountId, killZone()])).rows[0];
    const ctx: RiskContext = {
      ...BASE, now: killZone(), strategyVersionId: String(row.strategyId), observationId: String(row.observationId), observationDay: String(row.observationDay),
      equity: String(row.equity), instrument: { ...BASE.instrument, id: a.instrumentId, tickSize: "0.00001000", pipSize: "0.00010000", tickValue: "1.00000000", quantityStep: "0.01000000", minimumQuantity: "0.01000000" },
      plan: { id: String(row.planId), version: String(row.version), maxRiskPercent: String(row.max), defaultRiskPercent: row.default === null ? null : String(row.default),
        maxDailyTrades: Number(row.trades), minRR: String(row.rr), rrPolicy: row.rr_policy as "BLOCK", newsPolicy: row.news_policy as "WARN",
        dailyRiskCap: row.risk_cap === null ? null : String(row.risk_cap), dailyLossCap: row.loss_cap === null ? null : String(row.loss_cap) },
      usage,
    };
    return { usage, report: await evaluateBoth(proposal(a, changes), ctx) };
  }

  it("S1 a stopped-out plan counts once: realized 50 + new 48 = 98 is within a 100 loss limit (C3)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await lossCap(a, "100");
    const first = await plannedTrade(a);
    expect((await lock(first.tradeId)).planId).toBeTruthy();
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [first.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.098', clock_timestamp(), '0')", [first.tradeId]);
    await db.query("select public.record_account_values($1, '9950', '9950')", [a.accountId]);
    const { usage, report } = await checkBoth(a, OTHER_PRICES);
    expect(usage).toMatchObject({ plannedSlots: 1, plannedRisk: "50", realizedLoss: "50", openExposure: "0", lossTotal: "50" });
    expect(report.decision).toBe("APPROVED");
    expect(report.calculations).toMatchObject({ budget: "49.75", quantity: "0.24", nominalRisk: "48" });
    // The V1 sum (reported loss + every reservation + nominal = 50 + 50 + 48 = 148) would have blocked.
    expect(new Decimal(usage.lossTotal).plus(usage.plannedRisk).plus(48).gt(100)).toBe(true);
    const second = await plannedTrade(a, OTHER_PRICES);
    expect(second.result.decision).toBe("APPROVED");
    expect((await lock(second.tradeId)).planId).toBeTruthy();
  });

  it("S2 an open plan (50) plus the new 48 is within the limit", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await lossCap(a, "100");
    const first = await plannedTrade(a);
    await lock(first.tradeId);
    await db.query("select public.record_account_values($1, '9950', '9950')", [a.accountId]);
    const { usage, report } = await checkBoth(a, OTHER_PRICES);
    expect(usage).toMatchObject({ openExposure: "50", lossTotal: "0" });
    expect(report.decision).toBe("APPROVED");
    expect(report.calculations?.nominalRisk).toBe("48");
  });

  it("S3 S1 plus an external loss of 2.01 blocks, with the values in the finding", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await lossCap(a, "100");
    const first = await plannedTrade(a);
    await lock(first.tradeId);
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [first.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.098', clock_timestamp(), '0')", [first.tradeId]);
    await db.query("select public.record_account_values($1, '9950', '9950')", [a.accountId]);
    await db.query("select public.add_external_loss($1, '2.01', 'Other platform', $2)", [a.accountId, randomUUID()]);
    const { usage, report } = await checkBoth(a, OTHER_PRICES);
    expect(usage).toMatchObject({ realizedLoss: "50", externalLoss: "2.01", lossTotal: "52.01" });
    expect(codes(report)).toEqual(["DAILY_RISK_UNCONFIGURED:WARN", "DAILY_LOSS_LIMIT:BLOCK", "COSTS_UNKNOWN:WARN"]);
    expect(issue(report, "DAILY_LOSS_LIMIT")).toMatchObject({
      severity: "BLOCK", params: { loss: "52.01", open: "0", nominal: "48", cap: "100" },
      message: "Today's realized losses 52.01 USD plus open risk 0.00 USD plus this trade's 48.00 USD would exceed your daily loss limit of 100.00 USD.",
    });
    const rpc = await plannedTrade(a, OTHER_PRICES);
    expect(codes(rpc.result)).toEqual(["DAILY_RISK_UNCONFIGURED:WARN", "DAILY_LOSS_LIMIT:BLOCK", "COSTS_UNKNOWN:WARN"]);
  });

  it("S4 a 1.00-lot fill on a 0.25-lot plan: actual initial risk 200 is open exposure; R is 8 planned and 2 actual", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await lossCap(a, "250");
    const first = await plannedTrade(a);
    await lock(first.tradeId);
    const entry = await value<{ oversize: boolean; plannedQuantity: string; actualQuantity: string }>("select public.record_planned_entry($1, '1.1', '1.00', clock_timestamp()) as value", [first.tradeId]);
    expect(entry).toMatchObject({ oversize: true, plannedQuantity: "0.25", actualQuantity: "1" });
    const atLimit = await checkBoth(a, OTHER_PRICES);
    expect(atLimit.usage.openExposure).toBe("200");
    expect(atLimit.report.decision).toBe("APPROVED");
    await lossCap(a, "249.99");
    const over = await checkBoth(a, OTHER_PRICES);
    expect(issue(over.report, "DAILY_LOSS_LIMIT")?.params).toEqual({ loss: "0", open: "200", nominal: "50", cap: "249.99" });
    await db.actor(OWNER);
    await db.query("select public.close_planned_trade($1, '1.104', clock_timestamp(), '0')", [first.tradeId]);
    const ledger = (await db.query<{ realized_r: string; net_pnl: string; actual_initial_risk: string; initial_risk: string }>(
      "select realized_r, net_pnl, actual_initial_risk, initial_risk from public.trade_ledger where id = $1", [first.tradeId])).rows[0];
    expect(ledger).toEqual({ realized_r: "8", net_pnl: "400", actual_initial_risk: "200", initial_risk: "50" });
    expect(new Decimal(ledger.net_pnl).div(ledger.actual_initial_risk).toFixed()).toBe("2");
  });

  it("S5 a worse fill (1.10100) stopped at 1.09800: R −1.5 on planned risk, −1 on actual risk; exposure uses the actual 75", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const first = await plannedTrade(a);
    await lock(first.tradeId);
    await db.actor(OWNER);
    await db.query("select public.record_planned_entry($1, '1.101', '0.25', clock_timestamp())", [first.tradeId]);
    await db.admin();
    expect(dailyUsageSchema.parse(await value("select private.daily_usage($1, $2::timestamptz) as value", [a.accountId, killZone()])).openExposure).toBe("75");
    await db.actor(OWNER);
    await db.query("select public.close_planned_trade($1, '1.098', clock_timestamp(), '0')", [first.tradeId]);
    const ledger = (await db.query<{ realized_r: string; net_pnl: string; actual_initial_risk: string }>(
      "select realized_r, net_pnl, actual_initial_risk from public.trade_ledger where id = $1", [first.tradeId])).rows[0];
    expect(ledger).toEqual({ realized_r: "-1.5", net_pnl: "-75", actual_initial_risk: "75" });
    expect(new Decimal(ledger.net_pnl).div(ledger.actual_initial_risk).toFixed()).toBe("-1");
    await db.admin();
    expect(dailyUsageSchema.parse(await value("select private.daily_usage($1, $2::timestamptz) as value", [a.accountId, killZone()])))
      .toMatchObject({ realizedLoss: "75", openExposure: "0", lossTotal: "75" });
  });

  it("S6 a later immediate tightening outranks an earlier next-day loosening, today and tomorrow (C9)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.admin();
    // Tomorrow's view, built from today's clock: the loosening (created first) took effect today, the tightening
    // (created later, immediate) took effect yesterday. The engine must use the tightening.
    const loosen = await value<string>(`insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
        max_daily_trades, min_rr, rr_policy, news_policy, created_at)
      values ($1, $2, 'Risk Plan V1.1', private.strategy_day(clock_timestamp()), 1, 1, 2, 3, 'BLOCK', 'WARN', clock_timestamp() + interval '1 minute') returning id as value`, [OWNER, a.accountId]);
    const tighten = await value<string>(`insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
        max_daily_trades, min_rr, rr_policy, news_policy, override_reason, created_at)
      values ($1, $2, 'Risk Plan V1.2', private.strategy_day(clock_timestamp()) - 1, 0.25, 0.25, 1, 3, 'BLOCK', 'WARN', 'Drawdown protection', clock_timestamp() + interval '2 minutes') returning id as value`, [OWNER, a.accountId]);
    expect(await value<string>("select (private.active_risk_plan($1, private.strategy_day(clock_timestamp()))).id as value", [a.accountId])).toBe(tighten);
    await db.actor(OWNER);
    const send = (expected: string) => db.query<{ value: { result: RiskReportV12 } }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a)), randomUUID(), expected, a.observationId]);
    await expect(send(loosen)).rejects.toThrow(/^CONTEXT_CHANGED:/);
    const draft = (await send(tighten)).rows[0].value;
    expect(draft.result).toMatchObject({ riskPlanVersionId: tighten, decision: "BLOCKED", limits: { maxRiskPercent: "0.25", maxDailyTrades: 1, riskPlanVersion: "Risk Plan V1.2" } });
    expect(issue(draft.result, "RISK_LIMIT")?.params).toEqual({ requested: "0.5", maximum: "0.25" });
  });
});
