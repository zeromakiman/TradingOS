import { beforeEach, describe, expect, it, vi } from "vitest";

// V2 replacement of the V1 AI server-action tests whose actions are deleted: tests/{weekly,recent,monthly}-review-
// actions-data.test.ts, tests/trade-review-actions.test.ts and the action halves of tests/{analyze-setup,bias-
// challenge}-actions-data.test.ts. They now run on src/app/actions/ai.ts; tests/v2-ai-actions.test.ts covers the
// schema gate and each action's main path, and this file adds the V1 intents it does not repeat for every action:
// client-sent costs, facts, permissions and identities never reach a service; malformed ids never reach one; terminal
// outcomes rotate the request key while refusals do not; internal failures never show their details.

const m = vi.hoisted(() => ({
  analyze: vi.fn(), challenge: vi.fn(), review: vi.fn(), week: vi.fn(), recent: vi.fn(), month: vi.fn(), revalidate: vi.fn(), log: vi.fn(), schema: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
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

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const FOREIGN = "20000000-0000-4000-8000-000000000009";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const KEY = "70000000-0000-4000-8000-000000000001";
const IMAGE = "e0000000-0000-4000-8000-000000000001";

type Action = (state: AiActionState, form: FormData) => Promise<AiActionState>;

function form(fields: Record<string, string>, evidence: string[] = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const id of evidence) data.append("evidence", id);
  return data;
}

/** Fields a browser could add to try to change who pays, what is sent or what is allowed. */
const FORGED = { cost: "0", budgetCost: "0", facts: "invented", proposal: "changed", permission: "APPROVED", riskStatus: "APPROVED", userId: FOREIGN, user_id: FOREIGN, model: "unreviewed", provider: "other" };

const ACTIONS: { name: string; action: Action; service: () => ReturnType<typeof vi.fn>; fields: Record<string, string>; evidence: string[]; args: unknown[]; revalidated: string[] }[] = [
  { name: "weekly review", action: requestWeeklyAiReview, service: () => m.week, fields: { accountId: ACCOUNT, requestKey: KEY, week: "2026-09-02" }, evidence: [], args: [ACCOUNT, "2026-08-31", KEY], revalidated: ["/review", "/review/weekly", "/settings"] },
  { name: "recent trades", action: requestRecentTradesAiReview, service: () => m.recent, fields: { accountId: ACCOUNT, requestKey: KEY, sample: "20" }, evidence: [], args: [ACCOUNT, 20, KEY], revalidated: ["/review", "/review/recent", "/settings"] },
  { name: "monthly review", action: requestMonthlyAiReview, service: () => m.month, fields: { accountId: ACCOUNT, requestKey: KEY, month: "2026-08" }, evidence: [], args: [ACCOUNT, "2026-08", KEY], revalidated: ["/review", "/review/monthly", "/settings"] },
  { name: "trade review", action: requestTradeTimelineReview, service: () => m.review, fields: { tradeId: TRADE, requestKey: KEY }, evidence: [IMAGE], args: [TRADE, KEY, [IMAGE]], revalidated: [`/trades/${TRADE}`, "/settings", "/journal"] },
  { name: "setup analysis", action: requestTradeAnalyzeSetup, service: () => m.analyze, fields: { tradeId: TRADE, requestKey: KEY }, evidence: [IMAGE], args: [TRADE, KEY, [IMAGE], undefined], revalidated: [`/trades/${TRADE}`, "/settings"] },
  { name: "bias challenge", action: requestTradeBiasChallenge, service: () => m.challenge, fields: { tradeId: TRADE, requestKey: KEY }, evidence: [IMAGE], args: [TRADE, KEY, [IMAGE], undefined], revalidated: [`/trades/${TRADE}`, "/settings"] },
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const service of [m.analyze, m.challenge, m.review, m.week, m.recent, m.month]) service.mockResolvedValue({ status: "COMPLETED", message: "Saved." });
  m.schema.mockResolvedValue({ data: "2.1", error: null });
});

describe.each(ACTIONS)("$name action", ({ action, service, fields, evidence, args, revalidated }) => {
  it("passes only the parsed ids to the service, whatever else the browser sends", async () => {
    expect(await action({}, form({ ...fields, ...FORGED }, evidence))).toEqual({ success: "Saved.", status: "COMPLETED" });
    expect(service()).toHaveBeenCalledExactlyOnceWith(...args);
    expect(JSON.stringify(service().mock.calls)).not.toMatch(/invented|changed|APPROVED|unreviewed|20000000-0000-4000-8000-000000000009/);
    expect(m.revalidate.mock.calls.map(call => call[0])).toEqual(revalidated);
  });

  it.each(["requestKey", "accountId", "tradeId"].filter(key => key in fields))("never calls the service with a malformed %s", async key => {
    expect(await action({}, form({ ...fields, [key]: "not-an-id" }, evidence))).toHaveProperty("error");
    expect(await action({}, form({ ...fields, [key]: "" }, evidence))).toHaveProperty("error");
    expect(service()).not.toHaveBeenCalled();
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "FAILED", "RECORDED"])("reports %s as terminal, so the form takes a new request key", async status => {
    service().mockResolvedValue({ status, message: "Recorded." });
    expect(await action({}, form(fields, evidence))).toEqual({ success: "Recorded.", status });
  });

  it.each(["BUDGET_REACHED", "ACCOUNT_OFF", "DISABLED", "IN_PROGRESS"])("returns %s as an error without a false completed state", async status => {
    service().mockResolvedValue({ status, message: "Insufficient budget." });
    expect(await action({}, form(fields, evidence))).toEqual({ error: "Insufficient budget.", status });
  });

  it("hides an internal failure behind human copy and logs only a fixed event", async () => {
    service().mockRejectedValue(new Error("SECRET private database detail"));
    const result = await action({}, form(fields, evidence));
    expect(result.error).toBeTruthy();
    expect(result.success).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(m.log).toHaveBeenCalledExactlyOnceWith("request_failed");
  });
});

describe("selected screenshots are bounded before any service call", () => {
  it.each([
    ["trade review", requestTradeTimelineReview, m.review, 5],
    ["setup analysis", requestTradeAnalyzeSetup, m.analyze, 4],
    ["bias challenge", requestTradeBiasChallenge, m.challenge, 4],
  ] as const)("%s refuses %i screenshots", async (_name, action, service, count) => {
    const images = Array.from({ length: count }, (_, index) => `e0000000-0000-4000-8000-00000000000${index + 1}`);
    expect(await action({}, form({ tradeId: TRADE, requestKey: KEY }, images))).toHaveProperty("error");
    expect(service).not.toHaveBeenCalled();
  });
});
