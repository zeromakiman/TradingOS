import { beforeEach, describe, expect, it, vi } from "vitest";

// V2 replacement of the V1 lock-feedback tests in tests/ux.test.ts (setupRiskFeedback, deleted with src/domain/ux.ts):
// a lock or check is reported only from what the database actually answered. tests/v2-actions-trades.test.ts covers a
// blocked lock ("Not locked …") and a real lock; this file adds the V1 intent "does not invent a lock on an unexpected
// reply": an answer the action cannot read is an error, never a success.

const m = vi.hoisted(() => ({ rpc: vi.fn(), revalidate: vi.fn(), log: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: { rpc: m.rpc }, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.log }));

import { idleState } from "@/app/actions/state";
import { checkRisk, lockPlan } from "@/app/actions/trades";

const TRADE = "a0000000-0000-4000-8000-000000000001";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function reply(rpcAnswer: { data: unknown; error: unknown }) {
  m.rpc.mockImplementation(async (name: string) => (name === "trading_os_schema" ? { data: "2.0", error: null } : rpcAnswer));
}

beforeEach(() => vi.clearAllMocks());

describe("a lock or check is reported only from the database's own answer", () => {
  it.each([
    ["an empty answer", { data: null, error: null }],
    ["an answer without a result", { data: {}, error: null }],
    ["a malformed plan id", { data: { planId: 42, evaluationId: null, result: null, replayed: false, tradeId: TRADE }, error: null }],
    ["no plan id and an unreadable report", { data: { planId: null, evaluationId: "c0000000-0000-4000-8000-000000000002", result: { decision: "BLOCKED" }, replayed: false, tradeId: TRADE }, error: null }],
  ])("Lock plan never reports a lock for %s", async (_label, answer) => {
    reply(answer);
    const result = await lockPlan(idleState, form({ tradeId: TRADE, expectedRevision: "1" }));
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toMatch(/Plan locked|"locked":true/);
    expect(m.rpc).toHaveBeenCalledWith("lock_trade", { p_trade_id: TRADE, p_expected_revision: 1 });
  });

  it.each([
    ["an empty answer", { data: null, error: null }],
    ["an answer without a result", { data: { planId: null, evaluationId: null, result: null }, error: null }],
  ])("Check risk never reports a verdict for %s", async (_label, answer) => {
    reply(answer);
    const result = await checkRisk(idleState, form({ tradeId: TRADE }));
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toMatch(/Approved|Blocked/);
  });
});
