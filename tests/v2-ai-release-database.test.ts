import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";
import { createTestDatabase, OTHER, OWNER } from "./helpers/pglite";

vi.mock("server-only", () => ({}));
import { operationFor } from "@/ai/operations";
import { operationPricing, reservationMicros } from "@/ai/pricing";
import { operationRequestConfig } from "@/ai/request-estimate";
import { type AiLedger, budgetedAiRequest, GENERATION_NOT_SENT } from "@/ai/request-gate";

// 0018 Part 4: the recheck before the paid generation request records the generation commit (ai_request_generations);
// a dispatched request is released for zero cost (CANCELLED, usage {"generation":"NOT_SENT"}) only while no generation
// was committed, so SQL itself refuses a refund after a committed generation. Plain CANCELLED keeps its 0008 meaning.

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
const HASH = "a".repeat(64);
const RELEASE = { disposition: "CANCELLED", chargedMicros: 0, usage: { generation: "NOT_SENT" }, errorCode: "INPUT_LIMIT_EXCEEDED" };

async function account(): Promise<string> {
  const { accountId } = await db.bootstrapAccount(OWNER);
  await db.actor(OWNER);
  await db.query("select public.set_account_ai_preferences($1,true,500,true)", [accountId]);
  return accountId;
}
async function reserve(accountId: string, amount = 1_000_000): Promise<string> {
  const id = randomUUID();
  await db.actor(OWNER, "service_role");
  await db.query("select public.reserve_account_ai_request($1,$2,$3,$4,'A',$5,'gpt-5.4-mini','{}',$6,'WEEKLY_REVIEW','openai')", [id, OWNER, accountId, randomUUID(), HASH, amount]);
  return id;
}
async function dispatch(id: string, recheck = false) {
  await db.actor(OWNER, "service_role");
  return db.query("select public.dispatch_account_ai_request($1,$2,$3,$4)", [id, OWNER, HASH, recheck]);
}
async function settle(id: string, record: Record<string, unknown>) {
  await db.actor(OWNER, "service_role");
  return db.query("select public.settle_account_ai_request($1,$2,$3::jsonb)", [id, OWNER, JSON.stringify(record)]);
}
async function budget(accountId: string) {
  await db.actor(OWNER);
  return (await db.query<{ value: Record<string, unknown> }>("select public.get_account_ai_budget($1) value", [accountId])).rows[0].value;
}
async function generations(id: string): Promise<number> {
  await db.admin();
  return (await db.query<{ n: number }>("select count(*)::int n from public.ai_request_generations where reservation_id=$1", [id])).rows[0].n;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
}, 120_000);
afterAll(async () => { await db.close(); });

describe("releasing provably unsent requests (0018 Part 4)", () => {
  it("releases a dispatched request whose generation was never committed, for zero cost, without pausing the account", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    expect(await budget(a)).toMatchObject({ heldMicros: 1_000_000, usedMicros: 0, uncertain: false });
    await settle(id, RELEASE);
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
    await db.admin();
    expect((await db.query("select disposition,charged_micros,usage,error_code from public.ai_usage_records where reservation_id=$1", [id])).rows)
      .toEqual([{ disposition: "CANCELLED", charged_micros: 0, usage: { generation: "NOT_SENT" }, error_code: "INPUT_LIMIT_EXCEEDED" }]);
    // The account can reserve again at once: nothing waits for an accounting review.
    await reserve(a);
  });

  it("refuses any refund once the recheck committed the generation; the full reservation can then only be held", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    await dispatch(id, true);
    expect(await generations(id)).toBe(1);
    await expect(settle(id, RELEASE)).rejects.toThrow(/Committed generations cannot be refunded/);
    await expect(settle(id, { disposition: "CANCELLED", chargedMicros: 0 })).rejects.toThrow(/Committed generations cannot be refunded/);
    await expect(settle(id, { disposition: "UNCERTAIN", chargedMicros: 999_999 })).rejects.toThrow(/full reservation/);
    await settle(id, { disposition: "UNCERTAIN", chargedMicros: 1_000_000, errorCode: "TIMEOUT_OR_NETWORK" });
    expect(await budget(a)).toMatchObject({ uncertain: true, usedMicros: 1_000_000, heldMicros: 0 });
    await expect(reserve(a)).rejects.toThrow(/requires review/);
  });

  it("keeps the 0008 meaning of a plain CANCELLED: only a request that was never dispatched", async () => {
    const a = await account();
    const never = await reserve(a);
    await settle(never, { disposition: "CANCELLED", chargedMicros: 0, errorCode: "NOT_DISPATCHED" });
    const sent = await reserve(a);
    await dispatch(sent);
    await expect(settle(sent, { disposition: "CANCELLED", chargedMicros: 0 })).rejects.toThrow(/cannot be refunded/);
    await expect(settle(sent, { ...RELEASE, usage: { generation: "SENT" } })).rejects.toThrow(/cannot be refunded/);
    await expect(settle(sent, { ...RELEASE, usage: "NOT_SENT" })).rejects.toThrow(/cannot be refunded/);
    await expect(settle(sent, { ...RELEASE, usage: null })).rejects.toThrow(/cannot be refunded/);
    await expect(settle(sent, { ...RELEASE, chargedMicros: 1 })).rejects.toThrow(/cannot be refunded/);
    await settle(sent, RELEASE);
    await expect(settle(sent, RELEASE)).rejects.toThrow(/Already reconciled/);
  });

  it("commits a generation once and only after dispatch; settled usage works as before", async () => {
    const a = await account();
    const id = await reserve(a);
    await expect(dispatch(id, true)).rejects.toThrow(/not dispatched/);
    expect(await generations(id)).toBe(0);
    await dispatch(id);
    await dispatch(id, true);
    await expect(dispatch(id, true)).rejects.toThrow(/already committed/);
    expect(await generations(id)).toBe(1);
    await settle(id, { disposition: "SETTLED", chargedMicros: 1234, inputTokens: 10, outputTokens: 2, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(await budget(a)).toMatchObject({ usedMicros: 1234, heldMicros: 0, uncertain: false });
  });

  it("an opt-out or a lowered cap between count and generation commits nothing, so the request is released", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    await db.actor(OWNER);
    await db.query("select public.set_account_ai_preferences($1,false,null)", [a]);
    await expect(dispatch(id, true)).rejects.toThrow(/changed/);
    expect(await generations(id)).toBe(0);
    await settle(id, { ...RELEASE, errorCode: "AI_BUDGET_OR_PERMISSION_CHANGED" });
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
  });

  it("a release of another user's reservation is refused", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    await db.actor(OWNER, "service_role");
    await expect(db.query("select public.settle_account_ai_request($1,$2,$3::jsonb)", [id, OTHER, JSON.stringify(RELEASE)])).rejects.toThrow(/not found/);
  });

  it("a committed dispatch whose response was lost is released by the NOT_SENT record, never by a plain refund", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    await expect(settle(id, { disposition: "CANCELLED", chargedMicros: 0, errorCode: "NOT_DISPATCHED" })).rejects.toThrow(/cannot be refunded/);
    await settle(id, { disposition: "CANCELLED", chargedMicros: 0, usage: { generation: "NOT_SENT" }, errorCode: "NOT_DISPATCHED" });
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
    // The same record releases a reservation whose dispatch never committed.
    const never = await reserve(a);
    await settle(never, { disposition: "CANCELLED", chargedMicros: 0, usage: { generation: "NOT_SENT" }, errorCode: "NOT_DISPATCHED" });
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
  });

  it("generation commits are owner-readable, immutable and writable only through the recheck", async () => {
    const a = await account();
    const id = await reserve(a);
    await dispatch(id);
    await dispatch(id, true);
    await db.actor(OWNER);
    expect((await db.query("select reservation_id from public.ai_request_generations where reservation_id=$1", [id])).rows).toHaveLength(1);
    await expect(db.query("insert into public.ai_request_generations(reservation_id,user_id,account_id) values($1,$2,$3)", [randomUUID(), OWNER, a])).rejects.toThrow(/permission/);
    await expect(db.query("select public.dispatch_account_ai_request($1,$2,$3,true)", [id, OWNER, HASH])).rejects.toThrow(/permission/);
    await db.actor(OTHER);
    expect((await db.query("select reservation_id from public.ai_request_generations where reservation_id=$1", [id])).rows).toHaveLength(0);
    await db.actor(OWNER, "service_role");
    await expect(db.query("delete from public.ai_request_generations where reservation_id=$1", [id])).rejects.toThrow(/permission/);
    await expect(db.query("insert into public.ai_request_generations(reservation_id,user_id,account_id) values($1,$2,$3)", [id, OWNER, a])).rejects.toThrow(/permission/);
    await db.admin();
    await expect(db.query("delete from public.ai_request_generations where reservation_id=$1", [id])).rejects.toThrow(/immutable|reject/i);
    await expect(db.query("truncate public.ai_request_generations")).rejects.toThrow(/TRUNCATE_FORBIDDEN/);
    await db.anon();
    await expect(db.query("select * from public.ai_request_generations")).rejects.toThrow(/permission/);
  });
});

// The request gate (src/ai/request-gate.ts) against the real SQL: each ledger call commits and then loses its response,
// as a timeout after the database committed would. The gate must release exactly what provably sent nothing and hold
// everything else.
describe("lost responses through the request gate and the real SQL", () => {
  const operation = operationFor("WEEKLY_REVIEW");
  const owner = (accountId: string) => ({ userId: OWNER, accountId, operationId: randomUUID(), stage: "A", operation: operation.id });
  const input = () => ({ apiKey: "mock-only", config: operationRequestConfig(operation), context: weeklyFacts, images: [], prior: [] });
  type Fault = "reserve" | "dispatch" | "recheck";

  /** A service-role ledger whose `fault` call commits in SQL and then throws, as a lost response does. */
  function ledger(fault: Fault | null): AiLedger & { ids: string[] } {
    const ids: string[] = [];
    const call = async (name: Fault | "settle", sql: string, params: unknown[]) => {
      await db.actor(OWNER, "service_role");
      await db.query(sql, params);
      if (name === fault) throw new Error(`${name} response lost`);
    };
    return {
      ids,
      reserve: async r => {
        ids.push(r.id);
        await call("reserve", "select public.reserve_account_ai_request($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)",
          [r.id, r.userId, r.accountId, r.operationId, r.stage, r.hash, r.model, JSON.stringify(r.pricing), r.amount, r.operation, r.provider]);
      },
      dispatch: (id, user, hash) => call("dispatch", "select public.dispatch_account_ai_request($1,$2,$3,false)", [id, user, hash]),
      recheck: (id, user, hash) => call("recheck", "select public.dispatch_account_ai_request($1,$2,$3,true)", [id, user, hash]),
      settle: (id, user, record) => call("settle", "select public.settle_account_ai_request($1,$2,$3::jsonb)", [id, user, JSON.stringify(record)]),
    };
  }
  function transport() {
    const completed = { id: "resp_mock", model: operation.model, status: "completed", usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(weeklyOutput) }] }] };
    return vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/input_tokens") ? { input_tokens: 1000 } : completed));
  }
  async function usage(id: string) {
    await db.admin();
    return (await db.query<{ disposition: string; charged_micros: number; usage: unknown }>("select disposition,charged_micros,usage from public.ai_usage_records where reservation_id=$1", [id])).rows;
  }

  beforeAll(() => {
    vi.stubEnv("AI_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "mock-only");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("a reserve that committed but lost its response is released before anything is dispatched", async () => {
    const a = await account();
    const book = ledger("reserve");
    const fetcher = transport();
    await expect(budgetedAiRequest(input(), owner(a), book, fetcher)).rejects.toThrow(/reserve response lost/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await usage(book.ids[0])).toEqual([{ disposition: "CANCELLED", charged_micros: 0, usage: null }]);
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
  });

  it("a dispatch that committed but lost its response is released, not held until the month ends", async () => {
    const a = await account();
    const book = ledger("dispatch");
    const fetcher = transport();
    await expect(budgetedAiRequest(input(), owner(a), book, fetcher)).rejects.toThrow(/dispatch response lost/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await generations(book.ids[0])).toBe(0);
    expect(await usage(book.ids[0])).toEqual([{ disposition: "CANCELLED", charged_micros: 0, usage: { ...GENERATION_NOT_SENT } }]);
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: 0, uncertain: false });
  });

  it("a recheck that committed the generation but lost its response is never released: the full reservation is held", async () => {
    const a = await account();
    const book = ledger("recheck");
    const fetcher = transport();
    await expect(budgetedAiRequest(input(), owner(a), book, fetcher)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    // Only the input count reached the provider; the generation request was not sent, yet SQL cannot know that.
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://api.openai.com/v1/responses/input_tokens"]);
    expect(await generations(book.ids[0])).toBe(1);
    const amount = reservationMicros(operationPricing(operation), operation);
    expect(await usage(book.ids[0])).toEqual([{ disposition: "UNCERTAIN", charged_micros: amount, usage: null }]);
    expect(await budget(a)).toMatchObject({ heldMicros: 0, usedMicros: amount, uncertain: true });
  });

  it("a complete request settles its measured usage; nothing is released or held", async () => {
    const a = await account();
    const book = ledger(null);
    await expect(budgetedAiRequest(input(), owner(a), book, transport())).resolves.toMatchObject({ responseId: "resp_mock" });
    expect((await usage(book.ids[0]))[0]).toMatchObject({ disposition: "SETTLED" });
    expect(await budget(a)).toMatchObject({ heldMicros: 0, uncertain: false });
  });
});
