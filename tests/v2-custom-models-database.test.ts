import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// 0020_trade_deletion_journal_models.sql, part 2: per-account custom models (create_custom_model, revise_custom_model,
// delete_custom_model, set_trade_custom_model) and the ledger's custom_model_id / custom_model_name. A custom model is
// a journal label only: the trade's entry_model stays OB_FIRST_TOUCH / OTE / OTHER and the Risk Engine never sees it.

type Json = Record<string, unknown>;
let db: TestDatabase;
let a: BootstrappedAccount;
let b: BootstrappedAccount;
let o: BootstrappedAccount;

async function value<T>(sql: string, params: unknown[] = [], user = OWNER): Promise<T> {
  await db.actor(user);
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
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
const create = (accountId: string, input: Json, user = OWNER, key = randomUUID()) =>
  value<{ modelId: string; revisionId: number; replayed: boolean }>("select public.create_custom_model($1, $2::jsonb, $3) as value", [accountId, JSON.stringify(input), key], user);
const revise = (modelId: string, input: Json, user = OWNER) => value<number>("select public.revise_custom_model($1, $2::jsonb) as value", [modelId, JSON.stringify(input)], user);
const assign = (tradeId: string, modelId: string | null, user = OWNER) =>
  value<{ tradeId: string; modelId: string | null; assignmentId: number | null }>("select public.set_trade_custom_model($1, $2) as value", [tradeId, modelId], user);
async function live(acc: BootstrappedAccount, entryModel: string | null, user = OWNER): Promise<string> {
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [acc.accountId,
    JSON.stringify({ instrumentId: acc.instrumentId, direction: "LONG", ...(entryModel ? { entryModel } : {}), entryPrice: "1.10000",
      enteredAt: new Date(Date.now() - 5 * 60_000).toISOString(), quantity: "0.50", initialStop: "1.09800" }), randomUUID()], user);
}
async function ledger(tradeId: string): Promise<Json> {
  return value<Json>("select json_build_object('entry_model', entry_model, 'custom_model_id', custom_model_id, 'custom_model_name', custom_model_name) as value from public.trade_ledger where id = $1", [tradeId]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  await db.pinSession("ACTIVE_KILL_ZONE");
  a = await db.bootstrapAccount(OWNER, { name: "Owner main" });
  b = await db.bootstrapAccount(OWNER, { name: "Owner sibling" });
  o = await db.bootstrapAccount(OTHER, { name: "Other user" });
}, 120_000);
afterAll(async () => { await db.close(); });

describe("custom models", () => {
  it("creates a model per account, replays its request key, and refuses taken or reserved names", async () => {
    const key = randomUUID();
    const first = await create(a.accountId, { name: "TSP + IFVG + CISD", description: "Turtle soup, inverse FVG, change in state of delivery" }, OWNER, key);
    expect(first.replayed).toBe(false);
    expect(await create(a.accountId, { name: "TSP + IFVG + CISD", description: "Turtle soup, inverse FVG, change in state of delivery" }, OWNER, key)).toEqual({ ...first, replayed: true });
    expect(await fails("select public.create_custom_model($1, $2::jsonb, $3)", [a.accountId, JSON.stringify({ name: "Other name" }), key])).toMatch(/^IDEMPOTENCY_CONFLICT:/);
    for (const name of ["tsp + ifvg + cisd", " TSP + IFVG + CISD ", "OB first touch", "ob_first_touch", "OTE", "other"]) {
      expect(await fails("select public.create_custom_model($1, $2::jsonb, $3)", [a.accountId, JSON.stringify({ name }), randomUUID()]), name).toMatch(/^MODEL_NAME_TAKEN:/);
    }
    for (const input of [{ name: "" }, { name: "x".repeat(61) }, { name: "Valid", description: "y".repeat(501) }, { name: "Valid", extra: true }]) {
      expect(await fails("select public.create_custom_model($1, $2::jsonb, $3)", [a.accountId, JSON.stringify(input), randomUUID()])).toMatch(/^INVALID_INPUT:/);
    }
    // The same name in another account, and for another user, is free.
    await create(b.accountId, { name: "TSP + IFVG + CISD" });
    await create(o.accountId, { name: "TSP + IFVG + CISD" }, OTHER);
    // Another user's account is not found.
    expect(await fails("select public.create_custom_model($1, $2::jsonb, $3)", [a.accountId, JSON.stringify({ name: "Sneaky" }), randomUUID()], OTHER)).toMatch(/^ACCOUNT_NOT_FOUND:/);
  });

  it("renames and archives through new revisions; an archived name can be reused; restore needs a free name", async () => {
    const { modelId } = await create(a.accountId, { name: "Breaker" });
    const unchanged = await revise(modelId, { name: "Breaker" });
    expect(await revise(modelId, {})).toBe(unchanged);
    const renamed = await revise(modelId, { name: "Breaker block" });
    expect(renamed).toBeGreaterThan(unchanged);
    expect(await fails("select public.revise_custom_model($1, $2::jsonb)", [modelId, JSON.stringify({ name: "TSP + IFVG + CISD" })])).toMatch(/^MODEL_NAME_TAKEN:/);
    await revise(modelId, { status: "ARCHIVED" });
    const reuse = await create(a.accountId, { name: "Breaker block" });
    expect(await fails("select public.revise_custom_model($1, $2::jsonb)", [modelId, JSON.stringify({ status: "ACTIVE" })])).toMatch(/^MODEL_NAME_TAKEN:/);
    await revise(reuse.modelId, { status: "ARCHIVED" });
    await revise(modelId, { status: "ACTIVE" });
    expect(await value<number>("select count(*)::int as value from public.custom_model_revisions where model_id = $1", [modelId])).toBe(4);
    expect(await fails("select public.revise_custom_model($1, $2::jsonb)", [modelId, JSON.stringify({ status: "ACTIVE" })], OTHER)).toMatch(/^MODEL_NOT_FOUND:/);
    // Revisions are immutable for everyone.
    await db.admin();
    await expect(db.query("update public.custom_model_revisions set name = 'x' where model_id = $1", [modelId])).rejects.toThrow(/^Immutable record/);
  });

  it("records a live trade with a custom model as entry_model OTHER and shows the custom name in the ledger", async () => {
    const { modelId } = await create(a.accountId, { name: "Silver bullet" });
    const trade = await live(a, "OTHER");
    expect(await ledger(trade)).toEqual({ entry_model: "OTHER", custom_model_id: null, custom_model_name: null });
    const set = await assign(trade, modelId);
    expect(set).toMatchObject({ tradeId: trade, modelId });
    // Idempotent: the same model again returns the same assignment.
    expect(await assign(trade, modelId)).toEqual(set);
    expect(await ledger(trade)).toEqual({ entry_model: "OTHER", custom_model_id: modelId, custom_model_name: "Silver bullet" });
    // A rename shows at once; archiving keeps it on the trade.
    await revise(modelId, { name: "Silver bullet AM" });
    await revise(modelId, { status: "ARCHIVED" });
    expect(await ledger(trade)).toMatchObject({ custom_model_name: "Silver bullet AM" });
    // An archived model can't be chosen again, a model of another account or user never.
    const other = await live(a, null);
    expect(await fails("select public.set_trade_custom_model($1, $2)", [other, modelId])).toMatch(/^MODEL_NOT_AVAILABLE:/);
    const sibling = await create(b.accountId, { name: "Sibling model" });
    expect(await fails("select public.set_trade_custom_model($1, $2)", [other, sibling.modelId])).toMatch(/^MODEL_NOT_AVAILABLE:/);
    const foreign = await create(o.accountId, { name: "Foreign model" }, OTHER);
    expect(await fails("select public.set_trade_custom_model($1, $2)", [other, foreign.modelId])).toMatch(/^MODEL_NOT_AVAILABLE:/);
    expect(await fails("select public.set_trade_custom_model($1, $2)", [other, foreign.modelId], OTHER)).toMatch(/^TRADE_NOT_FOUND:/);
    // Clearing it.
    const clear = await create(a.accountId, { name: "Clearable" });
    await assign(other, clear.modelId);
    await assign(other, null);
    expect(await ledger(other)).toEqual({ entry_model: null, custom_model_id: null, custom_model_name: null });
  });

  it("never applies to trades recorded with a Risk Engine model or to planned trades", async () => {
    const { modelId } = await create(a.accountId, { name: "Judas swing" });
    const ote = await live(a, "OTE");
    expect(await fails("select public.set_trade_custom_model($1, $2)", [ote, modelId])).toMatch(/^MODEL_NOT_APPLICABLE:/);
    await db.actor(OWNER);
    const draft = (await value<{ tradeId: string }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [a.accountId,
      JSON.stringify({ ...previewProposal, instrumentId: a.instrumentId, narrative: "Synthetic", contractConfirmed: true, news: "CLEAR" }), randomUUID(), a.riskId, a.observationId])).tradeId;
    expect(await fails("select public.set_trade_custom_model($1, $2)", [draft, modelId])).toMatch(/^MODEL_NOT_APPLICABLE:/);
    // A trade without a known model that is later classified OB first touch no longer shows its custom model.
    const unknown = await live(a, null);
    await assign(unknown, modelId);
    await db.actor(OWNER);
    await db.query("select public.complete_live_entry($1, '{\"entryModel\":\"OB_FIRST_TOUCH\"}'::jsonb, $2)", [unknown, randomUUID()]);
    expect(await ledger(unknown)).toEqual({ entry_model: "OB_FIRST_TOUCH", custom_model_id: null, custom_model_name: null });
  });

  it("removes only a model that was never assigned", async () => {
    const spare = await create(a.accountId, { name: "Spare" });
    const used = await create(a.accountId, { name: "Used" });
    await assign(await live(a, "OTHER"), used.modelId);
    expect(await fails("select public.delete_custom_model($1)", [used.modelId])).toMatch(/^MODEL_IN_USE:/);
    expect(await fails("select public.delete_custom_model($1)", [spare.modelId], OTHER)).toMatch(/^MODEL_NOT_FOUND:/);
    await value("select public.delete_custom_model($1) as value", [spare.modelId]);
    expect(await value<number>("select count(*)::int as value from public.custom_models where id = $1", [spare.modelId])).toBe(0);
    expect(await value<number>("select count(*)::int as value from public.custom_model_revisions where model_id = $1", [spare.modelId])).toBe(0);
    await db.actor(OWNER);
    expect((await db.query<{ s: string | null }>("select current_setting('trading_os.delete_scope', true) as s")).rows[0].s ?? "").toBe("");
  });

  it("keeps every model row owner-only under RLS", async () => {
    const mine = await create(a.accountId, { name: "Private" });
    for (const table of ["custom_models", "custom_model_revisions", "trade_custom_models"]) {
      const visible = await value<number>(`select count(*)::int as value from public.${table} where user_id = $1`, [OWNER], OTHER);
      expect(visible, table).toBe(0);
    }
    expect(await value<number>("select count(*)::int as value from public.custom_models where id = $1", [mine.modelId], OTHER)).toBe(0);
    await db.actor(OWNER);
    await expect(db.query("insert into public.custom_models(user_id, account_id) values ($1, $2)", [OWNER, a.accountId])).rejects.toThrow(/permission denied/);
  });

  it("leaves the risk check of a plan unchanged (the engine never reads custom models)", async () => {
    await db.actor(OWNER);
    const draft = (await value<{ tradeId: string }>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [b.accountId,
      JSON.stringify({ ...previewProposal, instrumentId: b.instrumentId, narrative: "Synthetic", contractConfirmed: true, news: "CLEAR" }), randomUUID(), b.riskId, b.observationId])).tradeId;
    const strip = (report: Json) => JSON.parse(JSON.stringify(report, (key, v) => (key === "evaluatedAt" || key === "evaluationId" ? undefined : v)));
    const before = strip(await value<Json>("select public.check_trade_risk($1) as value", [draft]));
    await create(b.accountId, { name: "Unrelated" });
    expect(strip(await value<Json>("select public.check_trade_risk($1) as value", [draft]))).toEqual(before);
  });
});
