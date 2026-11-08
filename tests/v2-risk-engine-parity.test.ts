import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import { RISK_RULES, type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import { createTestDatabase, type TestDatabase } from "./helpers/pglite";

// Spec §6.7 / §16.1: src/domain/risk.ts and private.risk_report_v12 produce the same report 1.2, byte for byte
// except evaluatedAt (issues with params and order, messages, ruleResults, calculations, limits, instrument,
// snapshot), over every precision-audit boundary input and seeded random proposals and contexts.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  await db.admin();
}, 60_000);
afterAll(async () => { await db.close(); });

async function sqlReport(raw: unknown, ctx: RiskContext): Promise<RiskReportV12> {
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

/** Asserts byte-for-byte equality of the JSON (key order aside) and returns the TS report. */
async function expectParity(raw: unknown, ctx: RiskContext, label: string): Promise<RiskReportV12> {
  const ts = evaluateRisk(raw, ctx);
  const sql = await sqlReport(raw, ctx);
  const { evaluatedAt: tsAt, ...tsRest } = ts;
  const { evaluatedAt: sqlAt, ...sqlRest } = sql;
  expect(sqlRest, label).toEqual(tsRest);
  expect(new Date(sqlAt).getTime(), label).toBe(new Date(tsAt).getTime());
  expect(riskReportSchemaV12.safeParse(sql).success, label).toBe(true);
  return ts;
}

const PROPOSAL = { ...previewProposal, narrative: "Liquidity sweep, then displacement through the M5 order block.", contractConfirmed: true, news: "CLEAR" as const };
const ctx = (changes: Partial<RiskContext> = {}, plan: Partial<RiskContext["plan"]> = {}, usage: Partial<DailyUsage> = {}): RiskContext => ({
  ...previewContext, ...changes, plan: { ...previewContext.plan, ...plan }, usage: usageFixture(usage, changes.usage ?? previewContext.usage),
});

describe("parity over the precision-audit boundary inputs", () => {
  const cases: [string, Record<string, unknown>, RiskContext][] = [
    ["T1 base", {}, ctx()],
    ["T2 RR 2.995", { target: "1.10599" }, ctx()],
    ["T3 RR 2.99666666", { stop: "1.09700", target: "1.10899" }, ctx()],
    ["T4 min 2.995", { target: "1.10599" }, ctx({}, { minRR: "2.995" })],
    ["T5 min 2.996", { target: "1.10599" }, ctx({}, { minRR: "2.996" })],
    ["T6 RR WARN", { target: "1.10599" }, ctx({}, { rrPolicy: "WARN" })],
    ["T7 0.50000000", { riskPercent: "0.50000000" }, ctx()],
    ["T8 0.50000001", { riskPercent: "0.50000001" }, ctx()],
    ["T9 0.504", { riskPercent: "0.504" }, ctx()],
    ["T10 0.755 of 0.755", { riskPercent: "0.755" }, ctx({}, { maxRiskPercent: "0.755", defaultRiskPercent: "0.755" })],
    ["T11 0.76 of 0.755", { riskPercent: "0.76" }, ctx({}, { maxRiskPercent: "0.755", defaultRiskPercent: null })],
    ["T12 risk cap at 100", {}, ctx({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50" })],
    ["T13 risk cap over", {}, ctx({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50.01" })],
    ["risk cap used up", {}, ctx({}, { dailyRiskCap: "50" }, { plannedSlots: 1, plannedRisk: "50" })],
    ["zero-size trade over an exceeded risk cap", { stop: "1.04999", target: "1.25003" }, ctx({}, { dailyRiskCap: "50" }, { plannedSlots: 1, plannedRisk: "100" })],
    ["zero-size trade over an exceeded risk cap, SQL scale", { stop: "1.04999", target: "1.25003" },
      ctx({}, { dailyRiskCap: "50" }, { plannedRisk: "40.00000000000000000000000000000000", unplannedTrades: 1, unplannedRisk: "10.005" })],
    ["T14 loss cap at 100", {}, ctx({}, { dailyLossCap: "100" }, { plannedSlots: 1, plannedRisk: "50", openExposure: "50" })],
    ["T15 loss cap over", {}, ctx({}, { dailyLossCap: "100" }, { plannedSlots: 1, plannedRisk: "50", openExposure: "50", realizedLoss: "0.01" })],
    ["T16 no reported loss", {}, ctx({}, { dailyLossCap: "100" }, { legacyReportedLoss: null })],
    ["T17 stale with loss cap", {}, ctx({ observationDay: "2026-09-03" }, { dailyLossCap: "100" })],
    ["T18 one slot", {}, ctx({}, {}, { plannedSlots: 1 })],
    ["T18 two slots", {}, ctx({}, {}, { plannedSlots: 2 })],
    ["T18 planned + live-first", {}, ctx({}, {}, { plannedSlots: 1, unplannedTrades: 1 })],
    ["T19 minimum size", { stop: "1.05000", target: "1.25000" }, ctx()],
    ["T20 below minimum size", { stop: "1.04999", target: "1.25003" }, ctx()],
    ["T21 truncated budget", { riskPercent: "0.33" }, ctx({ equity: "12345.67" }, { maxRiskPercent: "0.33", defaultRiskPercent: null })],
    ["T22 short prices", { entry: "1.1", stop: "1.098", target: "1.106" }, ctx()],
    ["T23 off tick", { entry: "1.100001" }, ctx()],
    ...["2026-09-04T06:59:59.999Z", "2026-09-04T07:00:00Z", "2026-09-04T16:59:59.999Z", "2026-09-04T17:00:00Z", "2026-09-04T22:59:59.999Z",
      "2026-09-04T23:00:00Z", "2026-09-05T04:59:59.999999Z", "2026-09-05T05:00:00Z"]
      .map((now): [string, Record<string, unknown>, RiskContext] => [`T24 ${now}`, {}, ctx({ now, usage: usageFixture({ day: strategyClock(now).day }) })]),
    ["T25 missing stop in Dead Pool, slots used", { stop: null }, ctx({ now: "2026-09-04T17:00:00Z" }, {}, { plannedSlots: 2 })],
    ["T26 absurd prices", { entry: "210000000000", stop: "1000000000", target: "836999999999.99999" }, ctx()],
    ["T27 SQL-scale reserved risk", {}, ctx({}, { dailyRiskCap: "100" }, { plannedSlots: 1, plannedRisk: "50.00000000000000000000000000000000" })],
    ["T28 uppercase instrument id", { instrumentId: previewContext.instrument.id.toUpperCase() }, ctx()],
    ["T29 blank thesis", { narrative: "\n\t" }, ctx()],
    ["S1 realized 50 + 48", { entry: "1.20000", stop: "1.19800", target: "1.20600" }, ctx({ equity: "9950" }, { dailyLossCap: "100", maxDailyTrades: 3 }, { plannedSlots: 1, plannedRisk: "50", realizedLoss: "50" })],
    ["S2 open 50 + 48", { entry: "1.20000", stop: "1.19800", target: "1.20600" }, ctx({ equity: "9950" }, { dailyLossCap: "100", maxDailyTrades: 3 }, { plannedSlots: 1, plannedRisk: "50", openExposure: "50" })],
    ["S3 + external 2.01", { entry: "1.20000", stop: "1.19800", target: "1.20600" }, ctx({ equity: "9950" }, { dailyLossCap: "100", maxDailyTrades: 3 }, { plannedSlots: 1, plannedRisk: "50", realizedLoss: "50", externalLoss: "2.01" })],
    ["S4 oversize exposure 200", {}, ctx({}, { dailyLossCap: "249.99", maxDailyTrades: 3 }, { plannedSlots: 1, plannedRisk: "50", openExposure: "200" })],
    ["S5 worse fill exposure 75", {}, ctx({}, { dailyLossCap: "124.99", maxDailyTrades: 3 }, { plannedSlots: 1, plannedRisk: "50", openExposure: "75" })],
    ["S6 tightened plan", {}, ctx({}, { id: "00000000-0000-4000-8000-000000000009", version: "Risk Plan V1.2", maxRiskPercent: "0.25", defaultRiskPercent: "0.25", maxDailyTrades: 1 })],
    ["legacy reported loss wins", {}, ctx({}, { dailyLossCap: "100" }, { realizedLoss: "20", externalLoss: "5", legacyReportedLoss: "60" })],
    ["unknown risk of live-first trades", {}, ctx({}, {}, { unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 2, riskUnknownTrades: 2 })],
  ];

  it.each(cases)("%s", async (name, change, context) => {
    await expectParity({ ...PROPOSAL, ...change }, context, name);
  });

  it("covers malformed proposals the same way", async () => {
    const { contractConfirmed: _drop, ...missing } = PROPOSAL;
    const shapes: [string, unknown][] = [
      ["null", null], ["array", [PROPOSAL]], ["string", "proposal"], ["empty object", {}], ["missing key", missing],
      ["extra key", { ...PROPOSAL, extra: true }], ["number price", { ...PROPOSAL, entry: 1.1 }], ["exponent", { ...PROPOSAL, target: "1e1" }],
      ["negative", { ...PROPOSAL, riskPercent: "-1" }], ["zero", { ...PROPOSAL, riskPercent: "0" }], ["nine decimals", { ...PROPOSAL, entry: "1.100000001" }],
      ["thirteen digits", { ...PROPOSAL, target: "1000000000000" }], ["empty stop", { ...PROPOSAL, stop: "" }], ["numeric stop", { ...PROPOSAL, stop: 1 }],
      ["bad uuid", { ...PROPOSAL, instrumentId: "EURUSD" }], ["foreign instrument", { ...PROPOSAL, instrumentId: "00000000-0000-4000-8000-0000000000ff" }],
      ["null direction", { ...PROPOSAL, direction: null }], ["lowercase direction", { ...PROPOSAL, direction: "long" }], ["unknown model", { ...PROPOSAL, model: "SCALP" }],
      ["string boolean", { ...PROPOSAL, contractConfirmed: "true" }], ["null news", { ...PROPOSAL, news: null }], ["number contradiction", { ...PROPOSAL, contradiction: 0 }],
      ["5000-character thesis", { ...PROPOSAL, narrative: `  ${"x".repeat(5000)}  ` }], ["5001-character thesis", { ...PROPOSAL, narrative: "x".repeat(5001) }],
      ["astral thesis at 5000", { ...PROPOSAL, narrative: "📈".repeat(5000) }], ["only no-break spaces", { ...PROPOSAL, narrative: "   ﻿" }],
      ["several invalid fields", { ...PROPOSAL, entry: "x", stop: "y", news: "LATER", contradiction: "no" }],
    ];
    for (const [name, raw] of shapes) await expectParity(raw, ctx(), name);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Seeded random proposals and contexts (Park–Miller generator, fixed seed). Half the cases are lockable setups with
// few restrictions, half are adversarial (malformed input, off-tick prices, wrong geometry, sessions, stale values,
// caps, duplicates, odd contracts, SQL-scale usage strings).
// ---------------------------------------------------------------------------------------------------------------
function generator(seed: number) {
  let state = seed % 2147483647;
  const next = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)],
    chance: (p: number) => next() < p,
  };
}

const CONTRACTS = [
  { symbol: "EURUSD", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", quantityUnit: "lots (100,000 EUR)", scale: 5, base: 110000 },
  { symbol: "GBPUSD", tickSize: "0.00001000", pipSize: "0.00010000", tickValue: "1.00000000", quantityStep: "0.01000000", minimumQuantity: "0.01000000", quantityUnit: "lots (100,000 GBP)", scale: 5, base: 127000 },
  { symbol: "ES", tickSize: "0.25", pipSize: null, tickValue: "12.5", quantityStep: "1", minimumQuantity: "1", quantityUnit: "contracts", scale: 2, base: 22000 },
  { symbol: "XAUUSD", tickSize: "0.01", pipSize: "0.1", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", quantityUnit: "lots (100 oz)", scale: 2, base: 240000 },
  { symbol: "USDJPY", tickSize: "0.001", pipSize: "0.01", tickValue: "0.65", quantityStep: "0.01", minimumQuantity: "0.01", quantityUnit: "lots", scale: 3, base: 150000 },
  { symbol: "ODD", tickSize: "0.00003", pipSize: "0.0003", tickValue: "0.33333333", quantityStep: "0.001", minimumQuantity: "0.003", quantityUnit: "units", scale: 5, base: 100000 },
  { symbol: "DE40", tickSize: "0.5", pipSize: null, tickValue: "0.5", quantityStep: "0.1", minimumQuantity: "0.1", quantityUnit: "contracts", scale: 1, base: 36000 },
] as const;
const INSTRUMENT_ID = "40000000-0000-4000-8000-000000000003";

function randomCase(seed: number): { raw: unknown; context: RiskContext } {
  const r = generator(seed);
  const clean = r.chance(0.5);
  const spec = r.pick(CONTRACTS);
  const tick = new Decimal(spec.tickSize);
  const price = (ticks: number, offTick = false) => {
    let value = tick.times(ticks);
    if (offTick) value = value.plus(new Decimal(1).div(new Decimal(10).pow(Math.min(8, spec.scale + 1))));
    return value.toFixed(Math.min(8, Math.max(spec.scale, value.decimalPlaces())));
  };
  const direction = r.pick(["LONG", "SHORT"] as const);
  const sign = direction === "LONG" ? 1 : -1;
  const entryTicks = spec.base + r.int(-500, 500);
  const stopTicks = r.pick([1, 5, 20, 200, 300, 1000, 5000, r.int(1, 8000)]);
  const reward = Math.max(1, Math.round(stopTicks * (clean ? r.pick([3, 3, 3.5, 4, 2.995, 5]) : r.pick([0.5, 1, 2.995, 3, 3.001, 4, r.next() * 6]))));
  const proposal: Record<string, unknown> = {
    instrumentId: INSTRUMENT_ID, direction, model: r.pick(["OB_FIRST_TOUCH", "OTE"]),
    entry: price(entryTicks, !clean && r.chance(0.12)),
    stop: !clean && r.chance(0.08) ? null : price(entryTicks - sign * (!clean && r.chance(0.08) ? -stopTicks : stopTicks)),
    target: price(entryTicks + sign * reward),
    riskPercent: clean ? r.pick(["0.25", "0.5", "0.50000000", "0.1", "0.33"]) : r.pick(["0.5", "0.50000001", "0.504", "0.75", "0.755", "1", "2"]),
    narrative: clean ? r.pick(["Thesis with invalidation.", "  Sweep then MSS.\n", "📈 Trend continuation"]) : r.pick(["Thesis.", "\n\t", " ", "", " x　"]),
    contractConfirmed: clean || r.chance(0.8), news: clean ? r.pick(["CLEAR", "CLEAR", "UNKNOWN"]) : r.pick(["UNKNOWN", "CLEAR", "RESTRICTED"]),
    contradiction: !clean && r.chance(0.15),
  };
  if (!clean && r.chance(0.2)) {
    const field = r.pick(Object.keys(proposal));
    const kind = r.int(0, 6);
    if (kind === 0) delete proposal[field];
    else if (kind === 1) proposal.extra = "x";
    else if (kind === 2) proposal[field] = 1.1;
    else if (kind === 3) proposal[field] = "1e5";
    else if (kind === 4) proposal[field] = "-1";
    else if (kind === 5) proposal.instrumentId = INSTRUMENT_ID.toUpperCase();
    else proposal.instrumentId = "40000000-0000-4000-8000-0000000000ff";
  }
  const raw = !clean && r.chance(0.03) ? r.pick([null, [proposal], "proposal", 42, true]) : proposal;

  // Clean cases trade in the kill zone of 2026-09-04; adversarial ones anywhere over three days, to the millisecond.
  const minute = clean ? r.int(120, 719) : r.int(0, 3 * 1440 - 1);
  const now = new Date(Date.parse("2026-09-04T05:00:00Z") + minute * 60_000 + (clean ? 0 : r.pick([0, 0, 999, 59_999]))).toISOString();
  const day = strategyClock(now).day;
  const cents = (max: number) => new Decimal(r.int(0, max * 100)).div(100).toFixed();
  const sqlScale = (value: string) => (r.chance(0.2) ? new Decimal(value).toFixed(32) : value);
  const maxRisk = clean ? r.pick(["0.5", "1", "0.75"]) : r.pick(["0.5", "0.75", "0.755", "1", "0.25", "2"]);
  const unplannedTrades = r.int(0, clean ? 1 : 2);
  const unplannedRiskUnknown = r.int(0, Math.min(1, unplannedTrades));
  const openRiskUnknown = r.int(0, 2);
  const realizedLoss = cents(clean ? 30 : 80);
  const externalLoss = r.chance(0.3) ? cents(40) : "0";
  const legacyReportedLoss = r.chance(0.2) ? cents(150) : null;
  const usage: DailyUsage = {
    day, plannedSlots: r.int(0, clean ? 1 : 3), plannedRisk: sqlScale(cents(clean ? 60 : 150)), unplannedTrades, unplannedRisk: sqlScale(cents(60)),
    unplannedRiskUnknown, realizedLoss: sqlScale(realizedLoss), externalLoss, legacyReportedLoss, openExposure: sqlScale(cents(clean ? 60 : 120)), openRiskUnknown,
    riskUnknownTrades: r.int(Math.max(unplannedRiskUnknown, openRiskUnknown), unplannedRiskUnknown + openRiskUnknown),
    lossTotal: Decimal.max(legacyReportedLoss ?? 0, new Decimal(realizedLoss).plus(externalLoss)).toFixed(),
  };
  const cap = (high: number) => (r.chance(0.5) ? null : new Decimal(cents(high)).plus("0.01").toFixed());
  const context: RiskContext = {
    now, strategyVersionId: "40000000-0000-4000-8000-000000000001", strategyVersion: r.pick(["ICT V1.0", "ICT V1.1"]),
    observationId: "40000000-0000-4000-8000-000000000004", observationDay: clean || r.chance(0.8) ? day : "2026-09-01",
    equity: r.pick(["10000", "10000.00", "12345.67", "250000", "999.99", "5000000", "100000.50"]),
    currency: !clean && r.chance(0.05) ? "EUR" : "USD",
    plan: {
      id: "40000000-0000-4000-8000-000000000002", version: r.pick(["Risk Plan V1.0", "Risk Plan V1.3"]), maxRiskPercent: maxRisk,
      defaultRiskPercent: r.chance(0.5) ? null : maxRisk, maxDailyTrades: clean ? r.int(3, 5) : r.int(1, 4),
      minRR: clean ? r.pick(["3", "2.5", "1"]) : r.pick(["3", "2.5", "2.995", "2.996", "1", "3.00000001"]),
      rrPolicy: r.pick(["BLOCK", "WARN"]), newsPolicy: r.pick(["BLOCK", "WARN"]),
      dailyRiskCap: cap(clean ? 5000 : 300), dailyLossCap: cap(clean ? 5000 : 300),
    },
    instrument: {
      id: INSTRUMENT_ID, symbol: spec.symbol, currency: "USD", quantityUnit: spec.quantityUnit, tickSize: spec.tickSize, pipSize: spec.pipSize,
      tickValue: spec.tickValue, quantityStep: spec.quantityStep, minimumQuantity: spec.minimumQuantity,
    },
    usage, duplicate: !clean && r.chance(0.1),
  };
  return { raw, context };
}

describe("parity over seeded random proposals and contexts", () => {
  it("agrees on 400 cases covering every finding and every rule outcome", async () => {
    const findings = new Set<string>();
    const outcomes = new Set<string>();
    const decisions = { APPROVED: 0, BLOCKED: 0 };
    for (let i = 1; i <= 400; i++) {
      const { raw, context } = randomCase(20260904 + i * 7919);
      const report = await expectParity(raw, context, `case ${i}`);
      decisions[report.decision]++;
      for (const issue of report.issues) findings.add(`${issue.code}:${issue.severity}`);
      for (const result of report.ruleResults) outcomes.add(`${result.rule}:${result.outcome}`);
    }
    expect(decisions.APPROVED).toBeGreaterThan(80);
    expect(decisions.BLOCKED).toBeGreaterThan(80);
    expect([...findings].sort()).toEqual(expect.arrayContaining([
      "CONTRACT_UNCONFIRMED:BLOCK", "COSTS_UNKNOWN:WARN", "DAILY_LOSS_LIMIT:BLOCK", "DAILY_LOSS_UNCONFIGURED:WARN", "DAILY_RISK_LIMIT:BLOCK",
      "DAILY_RISK_UNCONFIGURED:WARN", "DEAD_POOL:BLOCK", "DUPLICATE:BLOCK", "INSTRUMENT_MISMATCH:BLOCK", "INVALID_INPUT:BLOCK", "MAX_TRADES:BLOCK",
      "MINIMUM_QUANTITY:BLOCK", "MIN_RR:BLOCK", "MIN_RR:WARN", "MISSING_STOP:BLOCK", "NEWS_RESTRICTED:BLOCK", "NEWS_RESTRICTED:WARN", "NEWS_UNKNOWN:WARN",
      "OFF_TICK:BLOCK", "OUTSIDE_ACTIVE:WARN", "PRICE_GEOMETRY:BLOCK", "RISK_LIMIT:BLOCK", "STALE_EQUITY:BLOCK", "STRATEGY_CONTRADICTION:BLOCK",
      "UNPLANNED_RISK_UNKNOWN:WARN",
    ]));
    for (const rule of RISK_RULES.filter(rule => rule !== "SIZING_INVARIANT")) {
      expect(outcomes, rule).toContain(`${rule}:PASS`);
      if (rule !== "INVALID_INPUT" && rule !== "MAX_TRADES" && rule !== "DEAD_POOL" && rule !== "STALE_EQUITY") expect(outcomes, rule).toContain(`${rule}:NOT_EVALUATED`);
    }
  });
});
