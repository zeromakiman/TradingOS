import { beforeEach, describe, expect, it, vi } from "vitest";

// V2 AI server actions (spec §8.3, §11, §13.10): schema gate first, zod-validated input, ids from the form only,
// request-key idempotency, revalidation of the V2 routes, human copy for every outcome, and unstable_rethrow before
// any error handling.

const m = vi.hoisted(() => ({
  analyze: vi.fn(), challenge: vi.fn(), review: vi.fn(), week: vi.fn(), recent: vi.fn(), month: vi.fn(), revalidate: vi.fn(), rethrow: vi.fn(), log: vi.fn(),
  schema: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ unstable_rethrow: m.rethrow }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: { rpc: m.schema }, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/analyze-setup", () => ({ analyzeTradeSetup: m.analyze }));
vi.mock("@/lib/bias-challenge", () => ({ challengeTradeBias: m.challenge }));
vi.mock("@/lib/trade-timeline-review", () => ({ reviewTradeTimeline: m.review }));
vi.mock("@/lib/weekly-review", () => ({ reviewWeek: m.week }));
vi.mock("@/lib/recent-trades", () => ({ analyzeRecentTrades: m.recent }));
vi.mock("@/lib/monthly-review", () => ({ reviewMonth: m.month }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.log }));
import {
  type AiActionState, requestMonthlyAiReview, requestRecentTradesAiReview, requestTradeAnalyzeSetup, requestTradeBiasChallenge, requestTradeTimelineReview,
  requestWeeklyAiReview,
} from "@/app/actions/ai";

const ids = {
  trade: "a0000000-0000-4000-8000-000000000001",
  account: "20000000-0000-4000-8000-000000000001",
  key: "70000000-0000-4000-8000-000000000001",
  evidence: ["e0000000-0000-4000-8000-000000000001", "e0000000-0000-4000-8000-000000000002", "e0000000-0000-4000-8000-000000000003", "e0000000-0000-4000-8000-000000000004", "e0000000-0000-4000-8000-000000000005"],
};

function form(fields: Record<string, string>, evidence: string[] = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const id of evidence) data.append("evidence", id);
  return data;
}

const libs = () => [m.analyze, m.challenge, m.review, m.week, m.recent, m.month];

beforeEach(() => {
  vi.clearAllMocks();
  for (const lib of libs()) lib.mockResolvedValue({ status: "COMPLETED", message: "Saved." });
  m.schema.mockResolvedValue({ data: "2.0", error: null });
});

describe("schema gate (spec §13.10)", () => {
  const SCHEMA_OUTDATED = "Database update required — this deployment expects Trading OS database version 2.0. No changes were made.";
  const requests: [string, (state: AiActionState, data: FormData) => Promise<AiActionState>, () => FormData][] = [
    ["analyze", requestTradeAnalyzeSetup, () => form({ tradeId: ids.trade, requestKey: ids.key })],
    ["challenge", requestTradeBiasChallenge, () => form({ tradeId: ids.trade, requestKey: ids.key })],
    ["timeline review", requestTradeTimelineReview, () => form({ tradeId: ids.trade, requestKey: ids.key })],
    ["weekly", requestWeeklyAiReview, () => form({ accountId: ids.account, requestKey: ids.key, week: "2026-09-02" })],
    ["recent trades", requestRecentTradesAiReview, () => form({ accountId: ids.account, requestKey: ids.key, sample: "10" })],
    ["monthly", requestMonthlyAiReview, () => form({ accountId: ids.account, requestKey: ids.key, month: "2026-08" })],
  ];

  it.each(requests)("%s reads the schema marker before calling its service", async (_label, action, data) => {
    expect(await action({}, data())).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(m.schema).toHaveBeenCalledExactlyOnceWith("trading_os_schema");
    const called = libs().find(lib => lib.mock.calls.length > 0);
    expect(m.schema.mock.invocationCallOrder[0]).toBeLessThan(called?.mock.invocationCallOrder[0] ?? 0);
  });

  it.each([
    ["an older schema", { data: "1.9", error: null }],
    ["a missing schema marker", { data: null, error: { code: "PGRST202", message: "Could not find the function public.trading_os_schema" } }],
    ["a missing schema function", { data: null, error: { code: "42883", message: "function public.trading_os_schema() does not exist" } }],
    ["an unrecognised marker", { data: "two", error: null }],
  ])("%s refuses every request before any service call or revalidation", async (_label, marker) => {
    m.schema.mockResolvedValue(marker);
    for (const [label, action, data] of requests) {
      expect(await action({}, data()), label).toEqual({ error: SCHEMA_OUTDATED });
    }
    for (const lib of libs()) expect(lib).not.toHaveBeenCalled();
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it("treats an unreadable marker as an unexpected failure that starts nothing", async () => {
    m.schema.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } });
    const result = await requestTradeTimelineReview({}, form({ tradeId: ids.trade, requestKey: ids.key }));
    expect(result).toEqual({ error: "Unable to request a review. Refresh to check the trade, its screenshots and AI settings." });
    expect(m.review).not.toHaveBeenCalled();
    expect(m.revalidate).not.toHaveBeenCalled();
    expect(m.log).toHaveBeenCalledWith("request_failed");
  });

  it("accepts later schema versions", async () => {
    m.schema.mockResolvedValue({ data: "2.1", error: null });
    expect(await requestMonthlyAiReview({}, form({ accountId: ids.account, requestKey: ids.key, month: "2026-08" }))).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(m.month).toHaveBeenCalledTimes(1);
  });
});

describe("pre-trade actions", () => {
  it.each([
    ["analyze", requestTradeAnalyzeSetup, () => m.analyze],
    ["challenge", requestTradeBiasChallenge, () => m.challenge],
  ])("%s passes only the trade, the request key, the selection and the shown revision", async (_label, action, lib) => {
    const data = form({ tradeId: ids.trade, requestKey: ids.key, revision: "2", proposalId: "b0000000-0000-4000-8000-000000000001", riskStatus: "APPROVED", userId: ids.account }, ids.evidence.slice(0, 2));
    expect(await action({}, data)).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(lib()).toHaveBeenCalledWith(ids.trade, ids.key, ids.evidence.slice(0, 2), 2);
    expect(m.revalidate.mock.calls).toEqual([[`/trades/${ids.trade}`], ["/settings"]]);
    await action({}, form({ tradeId: ids.trade, requestKey: ids.key }));
    expect(lib()).toHaveBeenLastCalledWith(ids.trade, ids.key, [], undefined);
  });

  it.each(["COMPLETED", "FAILED", "RECORDED"])("%s is terminal, so the form rotates its request key", async status => {
    m.analyze.mockResolvedValue({ status, message: "Recorded." });
    expect(await requestTradeAnalyzeSetup({}, form({ tradeId: ids.trade, requestKey: ids.key }))).toEqual({ success: "Recorded.", status });
  });

  it.each(["ACCOUNT_OFF", "BUDGET_REACHED", "DRAFT_CHANGED", "LOCKED", "NOT_PLANNED", "EVIDENCE_UNAVAILABLE", "IN_PROGRESS"])("%s is returned as an error the key can be reused for", async status => {
    m.challenge.mockResolvedValue({ status, message: "Not now." });
    expect(await requestTradeBiasChallenge({}, form({ tradeId: ids.trade, requestKey: ids.key }))).toEqual({ error: "Not now.", status });
  });

  it.each([
    [{ tradeId: "not-a-uuid", requestKey: ids.key }, []],
    [{ tradeId: ids.trade, requestKey: "bad" }, []],
    [{ tradeId: ids.trade, requestKey: ids.key }, ids.evidence.slice(0, 4)],
    [{ tradeId: ids.trade, requestKey: ids.key, revision: "0" }, []],
    [{ tradeId: ids.trade, requestKey: ids.key, revision: "two" }, []],
    [{ tradeId: ids.trade, requestKey: ids.key }, ["evidence-1"]],
  ])("invalid input %# never reaches the service", async (fields, evidence) => {
    expect(await requestTradeAnalyzeSetup({}, form(fields, evidence))).toEqual({ error: "Select up to three screenshots from this draft." });
    expect(m.analyze).not.toHaveBeenCalled();
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it("hides internal failures behind human copy and logs only a fixed event name", async () => {
    const failure = new Error("relation public.secret does not exist");
    m.analyze.mockRejectedValue(failure);
    const result = await requestTradeAnalyzeSetup({}, form({ tradeId: ids.trade, requestKey: ids.key }));
    expect(result.error).toMatch(/Refresh to check the draft/);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(m.rethrow).toHaveBeenCalledWith(failure);
    expect(m.log).toHaveBeenCalledWith("request_failed");
  });

  it("rethrows Next.js control flow (redirects, not-found) before handling errors", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    m.rethrow.mockImplementationOnce((error: unknown) => { if (error === redirect) throw error; });
    m.challenge.mockRejectedValue(redirect);
    await expect(requestTradeBiasChallenge({}, form({ tradeId: ids.trade, requestKey: ids.key }))).rejects.toBe(redirect);
    expect(m.log).not.toHaveBeenCalled();
  });
});

describe("timeline review action", () => {
  it("accepts up to four screenshots and refreshes the trade, settings and journal", async () => {
    expect(await requestTradeTimelineReview({}, form({ tradeId: ids.trade, requestKey: ids.key }, ids.evidence.slice(0, 4)))).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(m.review).toHaveBeenCalledWith(ids.trade, ids.key, ids.evidence.slice(0, 4));
    expect(m.revalidate.mock.calls).toEqual([[`/trades/${ids.trade}`], ["/settings"], ["/journal"]]);
    expect(await requestTradeTimelineReview({}, form({ tradeId: ids.trade, requestKey: ids.key }, ids.evidence))).toEqual({ error: "Select up to four screenshots from this trade." });
    expect(m.review).toHaveBeenCalledTimes(1);
  });

  it("returns no-write states as errors", async () => {
    m.review.mockResolvedValue({ status: "NOT_CLOSED", message: "Close the trade first." });
    expect(await requestTradeTimelineReview({}, form({ tradeId: ids.trade, requestKey: ids.key }))).toEqual({ error: "Close the trade first.", status: "NOT_CLOSED" });
  });
});

describe("periodic review actions", () => {
  it("weekly: normalises the chosen day to its Monday and refreshes /review", async () => {
    expect(await requestWeeklyAiReview({}, form({ accountId: ids.account, requestKey: ids.key, week: "2026-09-02" }))).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(m.week).toHaveBeenCalledWith(ids.account, "2026-08-31", ids.key);
    expect(m.revalidate.mock.calls).toEqual([["/review"], ["/review/weekly"], ["/settings"]]);
    const invalid: Record<string, string>[] = [{ accountId: ids.account, requestKey: ids.key, week: "2026-02-30" }, { accountId: "x", requestKey: ids.key, week: "2026-09-02" }, { accountId: ids.account, requestKey: ids.key }];
    for (const fields of invalid) {
      expect(await requestWeeklyAiReview({}, form(fields))).toEqual({ error: "Choose a completed week and a trading account." });
    }
    expect(m.week).toHaveBeenCalledTimes(1);
  });

  it("recent trades: accepts only 10, 20 or 30", async () => {
    expect(await requestRecentTradesAiReview({}, form({ accountId: ids.account, requestKey: ids.key, sample: "30" }))).toMatchObject({ status: "COMPLETED" });
    expect(m.recent).toHaveBeenCalledWith(ids.account, 30, ids.key);
    expect(m.revalidate.mock.calls).toEqual([["/review"], ["/review/recent"], ["/settings"]]);
    expect(await requestRecentTradesAiReview({}, form({ accountId: ids.account, requestKey: ids.key, sample: "15" }))).toEqual({ error: "Choose 10, 20 or 30 completed trades and a trading account." });
    expect(m.recent).toHaveBeenCalledTimes(1);
  });

  it("monthly: validates the month and maps outcomes", async () => {
    m.month.mockResolvedValue({ status: "EMPTY", message: "No completed trades in this month." });
    expect(await requestMonthlyAiReview({}, form({ accountId: ids.account, requestKey: ids.key, month: "2026-08" }))).toEqual({ error: "No completed trades in this month.", status: "EMPTY" });
    expect(m.month).toHaveBeenCalledWith(ids.account, "2026-08", ids.key);
    expect(m.revalidate.mock.calls).toEqual([["/review"], ["/review/monthly"], ["/settings"]]);
    expect(await requestMonthlyAiReview({}, form({ accountId: ids.account, requestKey: ids.key, month: "2026-13" }))).toEqual({ error: "Choose a completed month and a trading account." });
    m.month.mockRejectedValue(new Error("db detail"));
    const failure = await requestMonthlyAiReview({}, form({ accountId: ids.account, requestKey: ids.key, month: "2026-08" }));
    expect(failure.error).toMatch(/Unable to request a monthly review/);
    expect(m.log).toHaveBeenCalledWith("request_failed");
  });
});
