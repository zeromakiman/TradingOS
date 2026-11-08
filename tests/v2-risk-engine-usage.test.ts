import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DailyUsage, dailyUsageSchema } from "@/domain/risk";
import { type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { MOCK_POSITIONS } from "@/domain/sync/mock-provider";
import { normalizeExternalPosition } from "@/domain/sync/normalize";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// Spec §6.2: private.daily_usage / public.get_daily_risk_usage composition over real trades recorded through the
// V2 RPCs, and the engine paths that use it (assess_plan, check_proposal_risk) with the C9 precedence fix.

type Json = Record<string, unknown>;
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // Locks need an eligible session; production RPCs keep clock_timestamp().
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

const USAGE_KEYS = ["day", "externalLoss", "legacyReportedLoss", "lossTotal", "openExposure", "openRiskUnknown", "plannedRisk", "plannedSlots",
  "realizedLoss", "riskUnknownTrades", "unplannedRisk", "unplannedRiskUnknown", "unplannedTrades"];
const OTHER_PRICES = { entry: "1.20000", stop: "1.19800", target: "1.20600" };
const THIRD_PRICES = { entry: "1.30000", stop: "1.29800", target: "1.30600" };

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, params)).rows[0].value;
}
/** Usage through the authenticated RPC (database clock). */
async function usage(a: BootstrappedAccount): Promise<DailyUsage> {
  await db.actor(OWNER);
  return dailyUsageSchema.parse(await value("select public.get_daily_risk_usage($1) as value", [a.accountId]));
}
/** Usage of another instant of the database clock (private function, trusted caller). */
async function usageAt(a: BootstrappedAccount, offset: string): Promise<DailyUsage> {
  await db.admin();
  return dailyUsageSchema.parse(await value("select private.daily_usage($1, clock_timestamp() + $2::interval) as value", [a.accountId, offset]));
}
const proposal = (a: BootstrappedAccount, changes: Json = {}) => ({
  instrumentId: a.instrumentId, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600",
  riskPercent: "0.5", narrative: "Synthetic usage plan", contractConfirmed: true, news: "CLEAR", contradiction: false, ...changes,
});
async function activeIds(a: BootstrappedAccount): Promise<{ risk: string; observation: string }> {
  await db.admin();
  const ids = (await db.query<{ risk: string; observation: string }>(`
    select (private.active_risk_plan($1, private.strategy_day(clock_timestamp()))).id as risk,
           (select id from public.account_observations where account_id = $1 order by recorded_at desc, id desc limit 1) as observation`, [a.accountId])).rows[0];
  await db.actor(OWNER);
  return ids;
}
async function draft(a: BootstrappedAccount, changes: Json = {}): Promise<{ tradeId: string; proposalId: string; result: RiskReportV12 }> {
  const { risk, observation } = await activeIds(a);
  return value("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [a.accountId, JSON.stringify(proposal(a, changes)), randomUUID(), risk, observation]);
}
async function locked(a: BootstrappedAccount, changes: Json = {}): Promise<{ tradeId: string; proposalId: string; planId: string }> {
  const created = await draft(a, changes);
  const lock = await value<{ planId: string | null; result: RiskReportV12 }>("select public.lock_trade($1, 1) as value", [created.tradeId]);
  expect(lock.planId).toBeTruthy();
  return { tradeId: created.tradeId, proposalId: created.proposalId, planId: String(lock.planId) };
}
async function enter(tradeId: string, entry: string, quantity: string): Promise<void> {
  await db.actor(OWNER);
  await db.query("select public.record_planned_entry($1, $2, $3, clock_timestamp())", [tradeId, entry, quantity]);
}
async function closePlanned(tradeId: string, exit: string): Promise<void> {
  await db.actor(OWNER);
  await db.query("select public.close_planned_trade($1, $2, clock_timestamp(), '0')", [tradeId, exit]);
}
async function live(a: BootstrappedAccount, input: Json): Promise<string> {
  await db.actor(OWNER);
  return value("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify({ direction: "LONG", ...input }), randomUUID()]);
}
async function closeLive(tradeId: string, input: Json): Promise<void> {
  await db.actor(OWNER);
  const exitedAt = await value<string>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as value");
  await db.query("select public.close_live_trade($1, $2::jsonb)", [tradeId, JSON.stringify({ exitedAt, ...input })]);
}
async function hoursAgo(hours: number): Promise<string> {
  return value<string>("select to_char((clock_timestamp() - make_interval(hours => $1)) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as value", [hours]);
}
async function externalLoss(a: BootstrappedAccount, amount: string): Promise<string> {
  await db.actor(OWNER);
  return value("select public.add_external_loss($1, $2, null, $3) as value", [a.accountId, amount, randomUUID()]);
}
/** An instant of the database clock, `offset` ago, as an ISO string with microseconds. */
async function dbAgo(offset: string): Promise<string> {
  return value<string>("select to_char((clock_timestamp() - $1::interval) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as value", [offset]);
}
/** A platform position imported as a new IMPORTED trade through the mock connection (trusted server path, §8.6). */
async function imported(connectionId: string, changes: Json): Promise<string> {
  const normalized = normalizeExternalPosition({ ...MOCK_POSITIONS[0], ...changes });
  if (!normalized.ok) throw new Error(normalized.error);
  await db.actor("", "service_role");
  const envelope = await value<{ tradeId: string }>("select public.ingest_external_execution($1, $2, $3::jsonb, '{\"kind\":\"CREATE\"}'::jsonb) as value",
    [OWNER, connectionId, JSON.stringify(normalized.position)]);
  return envelope.tradeId;
}

describe("daily usage composition (§6.2)", () => {
  it("returns exactly the 13 DailyUsage keys for the strategy day of the database clock", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const raw = await (async () => { await db.actor(OWNER); return value<Json>("select public.get_daily_risk_usage($1) as value", [a.accountId]); })();
    expect(Object.keys(raw).sort()).toEqual(USAGE_KEYS);
    await db.admin();
    const day = await value<string>("select to_char(private.strategy_day(clock_timestamp()), 'YYYY-MM-DD') as value");
    expect(raw).toEqual({
      day, plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0",
      legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0",
    });
  });

  it("keeps a locked plan's slot and risk all day; exposure lasts while it is at risk, at the actual risk of an oversized fill", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const first = await locked(a);
    const second = await locked(a, OTHER_PRICES);
    expect(await usage(a)).toMatchObject({ plannedSlots: 2, plannedRisk: "100", openExposure: "100", realizedLoss: "0" });
    await db.actor(OWNER);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'Setup invalidated before entry')", [second.tradeId]);
    expect(await usage(a)).toMatchObject({ plannedSlots: 2, plannedRisk: "100", openExposure: "50" });
    await enter(first.tradeId, "1.1", "1.00");
    expect(await usage(a)).toMatchObject({ plannedSlots: 2, openExposure: "200" });
    await closePlanned(first.tradeId, "1.098");
    expect(await usage(a)).toMatchObject({ plannedSlots: 2, plannedRisk: "100", openExposure: "0", realizedLoss: "200", lossTotal: "200" });
  });

  it("counts live-first trades by entry day with their risk basis (reported, derived or unknown)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await live(a, { symbol: "XAUUSD", riskAmount: "30" });
    expect(await usage(a)).toMatchObject({ unplannedTrades: 1, unplannedRisk: "30", openExposure: "30", riskUnknownTrades: 0 });
    // |1.20000 − 1.20500| = 500 ticks × 1 × 0.10 lots = 50.
    await live(a, { instrumentId: a.instrumentId, direction: "SHORT", entryPrice: "1.20000", quantity: "0.10", initialStop: "1.20500" });
    expect(await usage(a)).toMatchObject({ unplannedTrades: 2, unplannedRisk: "80", openExposure: "80" });
    // Entered on the previous strategy day: not today's trade, but still at risk.
    await live(a, { symbol: "US30", riskAmount: "40", enteredAt: await hoursAgo(24) });
    expect(await usage(a)).toMatchObject({ unplannedTrades: 2, unplannedRisk: "80", openExposure: "120" });
    await live(a, { symbol: "GBPJPY" });
    expect(await usage(a)).toMatchObject({ unplannedTrades: 3, unplannedRisk: "80", unplannedRiskUnknown: 1, openExposure: "120", openRiskUnknown: 1, riskUnknownTrades: 1 });
  });

  it("counts each trade without recorded risk once, and stops counting it once its risk is recorded", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const enteredToday = await live(a, { symbol: "XAUUSD" });
    await live(a, { symbol: "US30", enteredAt: await hoursAgo(24) });
    const closedToday = await live(a, { symbol: "NAS100" });
    await closeLive(closedToday, { netPnl: "-12.50" });
    expect(await usage(a)).toMatchObject({ unplannedTrades: 2, unplannedRiskUnknown: 2, openRiskUnknown: 2, riskUnknownTrades: 3, realizedLoss: "12.5" });
    await db.actor(OWNER);
    await db.query("select public.complete_live_entry($1, $2::jsonb, $3)", [enteredToday, JSON.stringify({ riskAmount: "25" }), randomUUID()]);
    expect(await usage(a)).toMatchObject({ unplannedRisk: "25", unplannedRiskUnknown: 1, openExposure: "25", openRiskUnknown: 1, riskUnknownTrades: 2 });
  });

  it("counts imported trades like live-first trades: entry day, platform losses, unknown risk and the trade limit", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.actor(OWNER);
    const connection = await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, randomUUID()]);
    const open = { exitPrice: null, exitedAt: null, commission: null, swap: null, realizedPnl: null };
    const openToday = await imported(connection, { ...open, externalId: "USAGE-OPEN", enteredAt: await dbAgo("1 second") });
    // Closed on the platform: −100 ticks × 0.50 lots = −50.00 gross, 3.50 commission, −53.50 net.
    await imported(connection, {
      externalId: "USAGE-LOSS", direction: "SELL", volume: "0.50", entryPrice: "1.09875", enteredAt: await dbAgo("2 seconds"),
      exitPrice: "1.09975", exitedAt: await dbAgo("1 second"), commission: "-3.50", swap: "0", realizedPnl: "-53.50",
    });
    await imported(connection, { ...open, externalId: "USAGE-OLD", enteredAt: await dbAgo("24 hours") });
    // Imports carry no stop or risk amount: no risk basis until the trader records one.
    expect(await usage(a)).toMatchObject({
      unplannedTrades: 2, unplannedRisk: "0", unplannedRiskUnknown: 2, openExposure: "0", openRiskUnknown: 2, riskUnknownTrades: 3,
      realizedLoss: "53.5", lossTotal: "53.5",
    });
    await db.actor(OWNER);
    await db.query("select public.complete_live_entry($1, $2::jsonb, $3)", [openToday, JSON.stringify({ riskAmount: "25" }), randomUUID()]);
    expect(await usage(a)).toMatchObject({ unplannedRisk: "25", unplannedRiskUnknown: 1, openExposure: "25", openRiskUnknown: 1, riskUnknownTrades: 2 });
    const blocked = await draft(a);
    expect(blocked.result.issues.filter(i => i.code === "MAX_TRADES" || i.code === "UNPLANNED_RISK_UNKNOWN")).toEqual([
      { code: "MAX_TRADES", severity: "BLOCK", params: { used: 2, max: 2, planned: 0, unplanned: 2 },
        message: "Daily trade limit reached: 2 of 2 trades already used today (0 planned, 2 recorded live)." },
      { code: "UNPLANNED_RISK_UNKNOWN", severity: "WARN", params: { n: 2 },
        message: "2 live-first trades without recorded risk are not included in the daily risk totals." },
    ]);
  });

  it("keeps executed plans and open live-first trades of earlier days in tomorrow's exposure, never stale reservations", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const executed = await locked(a);
    await enter(executed.tradeId, "1.1", "0.25");
    await locked(a, OTHER_PRICES);
    await live(a, { symbol: "XAUUSD", riskAmount: "30" });
    await live(a, { symbol: "GBPJPY" });
    await externalLoss(a, "15");
    expect(await usage(a)).toMatchObject({ plannedSlots: 2, plannedRisk: "100", unplannedTrades: 2, openExposure: "130", externalLoss: "15" });
    const tomorrow = await usageAt(a, "1 day");
    expect(tomorrow).toMatchObject({
      plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0,
      openExposure: "80", openRiskUnknown: 1, riskUnknownTrades: 1, realizedLoss: "0", externalLoss: "0", lossTotal: "0",
    });
    expect(tomorrow.day).not.toBe((await usage(a)).day);
  });

  it("sums realized losses of planned outcomes and unplanned closes of the day; wins never offset them", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const planned = await locked(a);
    await enter(planned.tradeId, "1.1", "0.25");
    await closePlanned(planned.tradeId, "1.098");
    const lost = await live(a, { symbol: "XAUUSD" });
    await closeLive(lost, { netPnl: "-12.50" });
    const won = await live(a, { symbol: "US30" });
    await closeLive(won, { netPnl: "20" });
    expect(await usage(a)).toMatchObject({ realizedLoss: "62.5", lossTotal: "62.5", openExposure: "0" });
  });

  it("adds non-removed external losses of the day", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await externalLoss(a, "25.50");
    const mistaken = await externalLoss(a, "10");
    expect(await usage(a)).toMatchObject({ externalLoss: "35.5", lossTotal: "35.5" });
    await db.actor(OWNER);
    await db.query("select public.remove_external_loss($1, 'Entered twice')", [mistaken]);
    expect(await usage(a)).toMatchObject({ externalLoss: "25.5", lossTotal: "25.5" });
  });

  it("takes greatest(legacy reported total, realized + external) for today's observation only (no double count)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const planned = await locked(a);
    await enter(planned.tradeId, "1.1", "0.25");
    await closePlanned(planned.tradeId, "1.098");
    // A V1 manual total recorded before 0019 revoked record_observation from browsers: the trusted owner path.
    await db.admin();
    await db.query("select public.record_observation($1, '9950', '9950', '100')", [a.accountId]);
    expect(await usage(a)).toMatchObject({ realizedLoss: "50", legacyReportedLoss: "100", lossTotal: "100" });
    await db.admin();
    await db.query("select public.record_observation($1, '9950', '9950', '30')", [a.accountId]);
    await externalLoss(a, "25.50");
    expect(await usage(a)).toMatchObject({ realizedLoss: "50", externalLoss: "25.5", legacyReportedLoss: "30", lossTotal: "75.5" });
    await db.admin();
    await db.query("insert into public.account_observations(user_id, account_id, equity, balance, gross_loss_today, trading_day) values ($1, $2, 9950, 9950, 500, private.strategy_day(clock_timestamp()) - 1)", [OWNER, a.accountId]);
    expect(await usage(a)).toMatchObject({ legacyReportedLoss: null, lossTotal: "75.5" });
    await db.actor(OWNER);
    await db.query("select public.record_account_values($1, '9950', '9950')", [a.accountId]);
    expect(await usage(a)).toMatchObject({ legacyReportedLoss: null, lossTotal: "75.5" });
  });
});

describe("engine paths over the usage (§6.3)", () => {
  it("C3: a stopped-out plan is a realized loss, not open exposure, for the next plan (S1)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.actor(OWNER);
    await db.query("select public.create_risk_policy_version($1, $2::jsonb, true, 'Synthetic loss limit')", [a.accountId, JSON.stringify({
      maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 3, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: "100" })]);
    const first = await locked(a);
    await enter(first.tradeId, "1.1", "0.25");
    await closePlanned(first.tradeId, "1.098");
    await db.query("select public.record_account_values($1, '9950', '9950')", [a.accountId]);
    const second = await draft(a, OTHER_PRICES);
    expect(second.result).toMatchObject({ decision: "APPROVED", calculations: { nominalRisk: "48" } });
    expect(second.result.snapshot).toMatchObject({ plannedSlots: 1, plannedRisk: "50", realizedLoss: "50", openExposure: "0", grossLoss: "50", riskConsumed: "50" });
    const third = await draft(a, { ...THIRD_PRICES, riskPercent: "0.5" });
    expect(third.result.decision).toBe("APPROVED");
    await db.actor(OWNER);
    expect((await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [second.tradeId])).planId).toBeTruthy();
    // Now realized 50 + open 48 + this 48 = 146 > 100.
    const fourth = await draft(a, THIRD_PRICES);
    expect(fourth.result.issues.find(i => i.code === "DAILY_LOSS_LIMIT")?.params).toEqual({ loss: "50", open: "48", nominal: "48", cap: "100" });
  });

  it("MAX_TRADES counts live-first trades: one plan plus one live trade fill a two-trade day", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await locked(a);
    await live(a, { symbol: "XAUUSD", riskAmount: "20" });
    const blocked = await draft(a, OTHER_PRICES);
    expect(blocked.result.decision).toBe("BLOCKED");
    expect(blocked.result.issues.find(i => i.code === "MAX_TRADES")).toMatchObject({
      severity: "BLOCK", params: { used: 2, max: 2, planned: 1, unplanned: 1 },
      message: "Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live).",
    });
    await db.actor(OWNER);
    expect((await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [blocked.tradeId])).planId).toBeNull();
    expect(await usage(a)).toMatchObject({ plannedSlots: 1, unplannedTrades: 1 });
  });

  it("rechecks a locked plan without its own reservation, with the risk plan in effect now", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const plan = await locked(a);
    await db.actor(OWNER);
    const recheck = await value<{ planId: string; result: RiskReportV12 }>("select public.check_setup_risk($1, false) as value", [plan.proposalId]);
    expect(recheck.planId).toBe(plan.planId);
    expect(recheck.result).toMatchObject({ decision: "APPROVED", snapshot: { plannedSlots: 0, plannedRisk: "0", openExposure: "0" } });
    expect(riskReportSchemaV12.safeParse(recheck.result).success).toBe(true);
    await db.query("select public.create_risk_policy_version($1, $2::jsonb, true, 'Tighter after recheck')", [a.accountId, JSON.stringify({
      maxRiskPercent: "0.25", defaultRiskPercent: "0.25", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null })]);
    const tightened = await value<{ result: RiskReportV12 }>("select public.check_setup_risk($1, false) as value", [plan.proposalId]);
    expect(tightened.result).toMatchObject({ decision: "BLOCKED", limits: { maxRiskPercent: "0.25" } });
    expect(tightened.result.riskPlanVersionId).not.toBe(a.riskId);
  });

  it("C9: every engine path uses the newest created risk plan among those in effect", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.admin();
    // As seen on the day after the C9 sequence: a loosening scheduled first took effect today, an immediate tightening
    // created later took effect yesterday. V1 order (effective_day desc) would pick the loosening.
    const loosen = await value<string>(`insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
        max_daily_trades, min_rr, rr_policy, news_policy, created_at)
      values ($1, $2, 'Risk Plan V1.1', private.strategy_day(clock_timestamp()), 1, 1, 2, 3, 'BLOCK', 'WARN', clock_timestamp() + interval '1 minute') returning id as value`, [OWNER, a.accountId]);
    const tighten = await value<string>(`insert into public.risk_plan_versions(user_id, account_id, version, effective_day, max_risk_percent, default_risk_percent,
        max_daily_trades, min_rr, rr_policy, news_policy, override_reason, created_at)
      values ($1, $2, 'Risk Plan V1.2', private.strategy_day(clock_timestamp()) - 1, 0.5, 0.5, 2, 3, 'BLOCK', 'WARN', 'Drawdown protection', clock_timestamp() + interval '2 minutes') returning id as value`, [OWNER, a.accountId]);
    expect(await value<string>("select id as value from public.risk_plan_versions where account_id = $1 and effective_day <= private.strategy_day(clock_timestamp()) order by effective_day desc, created_at desc, id desc limit 1", [a.accountId])).toBe(loosen);
    // assess_plan through the V1 evaluate entry point (trusted caller; 0019 revoked it from browsers).
    await expect(db.query("select private.assess_plan($1, $2::jsonb, null, $3, $4, false)", [a.accountId, JSON.stringify(proposal(a)), loosen, a.observationId]))
      .rejects.toThrow(/Account or risk plan changed/);
    const assessed = await value<{ result: RiskReportV12 }>("select private.assess_plan($1, $2::jsonb, null, $3, $4, false) as value", [a.accountId, JSON.stringify(proposal(a, { riskPercent: "0.75" })), tighten, a.observationId]);
    expect(assessed.result).toMatchObject({ riskPlanVersionId: tighten, decision: "BLOCKED", limits: { maxRiskPercent: "0.5", riskPlanVersion: "Risk Plan V1.2" } });
    // check_trade_risk → check_setup_risk → check_proposal_risk → assess_plan, and the lock, on the same version.
    const created = await draft(a);
    expect(created.result.riskPlanVersionId).toBe(tighten);
    await db.actor(OWNER);
    const check = await value<{ result: RiskReportV12 }>("select public.check_trade_risk($1) as value", [created.tradeId]);
    expect(check.result.riskPlanVersionId).toBe(tighten);
    const lock = await value<{ planId: string }>("select public.lock_trade($1, 1) as value", [created.tradeId]);
    expect(await value<string>("select risk_plan_version_id as value from public.trade_plans where id = $1", [lock.planId])).toBe(tighten);
  });

  it("locks with canonical nominal risk and a stored 1.2 report (P1)", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const plan = await locked(a);
    await db.actor(OWNER);
    const row = (await db.query<{ nominal: string; result: unknown; evaluation: unknown }>(
      "select p.nominal_risk::text as nominal, p.risk_result as result, e.result as evaluation from public.trade_plans p join public.risk_evaluations e on e.id = p.risk_evaluation_id where p.id = $1", [plan.planId])).rows[0];
    expect(row.nominal).toBe("50");
    const report = riskReportSchemaV12.parse(row.result);
    expect(report).toMatchObject({ engineVersion: "1.1", reportVersion: "1.2", decision: "APPROVED", calculations: { nominalRisk: "50", quantity: "0.25", plannedRR: "3" } });
    expect(row.evaluation).toEqual(row.result);
    expect(await value<string>("select planned_risk as value from public.trade_ledger where id = $1", [plan.tradeId])).toBe("50");
  });
});

describe("get_daily_risk_usage access", () => {
  it("serves only the account owner and keeps private.daily_usage unreachable", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.actor(OTHER);
    await expect(db.query("select public.get_daily_risk_usage($1)", [a.accountId])).rejects.toThrow(/^ACCOUNT_NOT_FOUND:/);
    await expect(db.query("select public.get_daily_risk_usage($1)", [randomUUID()])).rejects.toThrow(/^ACCOUNT_NOT_FOUND:/);
    await db.actor("");
    await expect(db.query("select public.get_daily_risk_usage($1)", [a.accountId])).rejects.toThrow(/^AUTH_REQUIRED:/);
    await db.anon();
    await expect(db.query("select public.get_daily_risk_usage($1)", [a.accountId])).rejects.toThrow(/permission denied/);
    await db.actor(OWNER, "service_role");
    await expect(db.query("select public.get_daily_risk_usage($1)", [a.accountId])).rejects.toThrow(/permission denied/);
    for (const role of ["authenticated", "service_role"] as const) {
      await db.actor(OWNER, role);
      await expect(db.query("select private.daily_usage($1, clock_timestamp())", [a.accountId])).rejects.toThrow(/permission denied/);
    }
    await db.admin();
    const grants = (await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select has_function_privilege('anon', 'public.get_daily_risk_usage(uuid)', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'public.get_daily_risk_usage(uuid)', 'EXECUTE') as authenticated,
             has_function_privilege('service_role', 'public.get_daily_risk_usage(uuid)', 'EXECUTE') as service`)).rows[0];
    expect(grants).toEqual({ anon: false, authenticated: true, service: false });
  });
});
