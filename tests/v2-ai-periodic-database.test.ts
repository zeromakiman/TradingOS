import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plan as fixture } from "./fixtures/trade-review";
import { createTestDatabase, OWNER } from "./helpers/pglite";

// 0018 Part 3: the periodic start RPCs accept the compact V2 facts of new requests and the V1 facts of stored ones,
// with the unchanged exact scope, sample and trade-id checks; any other facts version is refused.

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
const HASH = "a".repeat(64);

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
}, 120_000);
afterAll(async () => { await db.close(); });

/** An AI-enabled account with one completed planned trade that exited on `exit`. */
async function account(exit: string): Promise<{ accountId: string; planId: string }> {
  const { accountId, instrumentId, riskId, observationId, strategyId } = await db.bootstrapAccount(OWNER);
  const planId = randomUUID(), evaluationId = randomUUID();
  const proposal = JSON.stringify({ ...fixture.proposal, instrumentId }), report = JSON.stringify(fixture.risk_result);
  await db.admin();
  await db.query("insert into public.risk_evaluations(id,user_id,account_id,proposal,result) values($1,$2,$3,$4,$5)", [evaluationId, OWNER, accountId, proposal, report]);
  await db.query(
    "insert into public.trade_plans(id,user_id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,account_observation_id,risk_evaluation_id,idempotency_key,proposal,risk_result,nominal_risk,trading_day,locked_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,50,$12,$13)",
    [planId, OWNER, accountId, strategyId, riskId, instrumentId, observationId, evaluationId, randomUUID(), proposal, report, exit.slice(0, 10), new Date(Date.parse(exit) - 7_200_000).toISOString()],
  );
  await db.actor(OWNER);
  await db.query("select public.open_journal_trade($1,'1.1','0.25',$2)", [planId, new Date(Date.parse(exit) - 3_600_000).toISOString()]);
  await db.query("select public.close_journal_trade($1,'1.106',$2,'0')", [planId, exit]);
  await db.query("select public.set_account_ai_preferences($1,true,500,true)", [accountId]);
  return { accountId, planId };
}

async function startWeekly(accountId: string, version: string) {
  await db.actor(OWNER, "service_role");
  return db.query<{ ok: boolean }>("select public.start_weekly_ai_review($1,$2,$3,'2026-08-31',$4,$5,'{\"id\":\"WEEKLY_REVIEW\"}','{}') ok",
    [randomUUID(), OWNER, accountId, JSON.stringify({ version, period: { startDate: "2026-08-31" } }), HASH]);
}
async function startRecent(accountId: string, planId: string, version: string, tradeIds = [planId]) {
  await db.actor(OWNER, "service_role");
  const captured = new Date().toISOString();
  const facts = { version, capturedAt: captured, sample: { requested: 10, actual: 1, tradeIds }, trades: tradeIds.map(tradeId => ({ tradeId, tradeRecordId: randomUUID() })) };
  return db.query<{ ok: boolean }>("select public.start_recent_ai_analysis($1,$2,$3,10,$4,$5,$6,$7,'{\"id\":\"RECENT_TRADES_ANALYSIS\"}','{}') ok",
    [randomUUID(), OWNER, accountId, [planId], captured, JSON.stringify(facts), HASH]);
}
async function startMonthly(accountId: string, planId: string, version: string, tradeIds = [planId]) {
  await db.actor(OWNER, "service_role");
  const facts = {
    version, period: { startDate: "2026-08-01", start: "2026-08-01T05:00:00.000Z", endExclusive: "2026-09-01T05:00:00.000Z" },
    sample: { count: tradeIds.length, tradeIds }, trades: tradeIds.map(tradeId => ({ tradeId })), mode: "DETAILED",
  };
  return db.query<{ ok: boolean }>("select public.start_monthly_ai_review($1,$2,$3,'2026-08-01',$4,$5,'{\"id\":\"MONTHLY_REVIEW\"}','{}') ok",
    [randomUUID(), OWNER, accountId, JSON.stringify(facts), HASH]);
}

describe("periodic AI starts accept V1 and V2 facts versions only", () => {
  it.each(["WEEKLY_REVIEW_FACTS_V1", "WEEKLY_REVIEW_FACTS_V2"])("a weekly review starts with %s", async version => {
    const { accountId } = await account("2026-09-01T09:00:00.000Z");
    expect((await startWeekly(accountId, version)).rows[0].ok).toBe(true);
  });

  it.each(["WEEKLY_REVIEW_FACTS_V3", "RECENT_TRADES_FACTS_V2", ""])("a weekly review refuses facts version %j", async version => {
    const { accountId } = await account("2026-09-01T09:00:00.000Z");
    await expect(startWeekly(accountId, version)).rejects.toThrow(/Weekly scope mismatch/);
  });

  it.each(["RECENT_TRADES_FACTS_V1", "RECENT_TRADES_FACTS_V2"])("a recent-trades analysis starts with %s and the exact sample", async version => {
    const { accountId, planId } = await account("2026-09-01T09:00:00.000Z");
    expect((await startRecent(accountId, planId, version)).rows[0].ok).toBe(true);
  });

  it("a recent-trades analysis refuses another version and V2 facts whose trades are not the exact sample", async () => {
    const { accountId, planId } = await account("2026-09-01T09:00:00.000Z");
    await expect(startRecent(accountId, planId, "RECENT_TRADES_FACTS_V3")).rejects.toThrow(/Sample metadata mismatch/);
    await expect(startRecent(accountId, planId, "WEEKLY_REVIEW_FACTS_V2")).rejects.toThrow(/Sample metadata mismatch/);
    await expect(startRecent(accountId, planId, "RECENT_TRADES_FACTS_V2", [randomUUID()])).rejects.toThrow(/mismatch/);
  });

  it.each(["MONTHLY_REVIEW_FACTS_V1", "MONTHLY_REVIEW_FACTS_V2"])("a monthly review starts with %s and the exact trade ids", async version => {
    const { accountId, planId } = await account("2026-08-15T09:00:00.000Z");
    expect((await startMonthly(accountId, planId, version)).rows[0].ok).toBe(true);
  });

  it("a monthly review refuses another version and V2 facts with other trade ids", async () => {
    const { accountId, planId } = await account("2026-08-15T09:00:00.000Z");
    await expect(startMonthly(accountId, planId, "MONTHLY_REVIEW_FACTS_V3")).rejects.toThrow(/Monthly scope or exact trade IDs mismatch/);
    await expect(startMonthly(accountId, planId, "MONTHLY_REVIEW_FACTS_V2", [randomUUID()])).rejects.toThrow(/Monthly scope or exact trade IDs mismatch/);
  });
});
