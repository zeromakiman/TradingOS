import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));
import { operationContract } from "@/ai/operation-contract";
import { AI_OPERATIONS, operationFor } from "@/ai/operations";
import { MINI_PRICING, operationPricing, reservationMicros } from "@/ai/pricing";
import { type AiLedger, budgetedAiRequest } from "@/ai/request-gate";
import { tradeTimelineReviewContext } from "@/ai/trade-timeline-review-context";
import { tradeTimelineAllowedSources } from "@/ai/trade-timeline-review-sources";
import { estimateAiCost } from "@/domain/ai-summary";
import { aiCostEstimate } from "@/lib/ai-history";

const TRADE = "a0000000-0000-4000-8000-000000000002";
const EVIDENCE = "e0000000-0000-4000-8000-000000000001";
const facts = tradeTimelineReviewContext({
  trade: {
    id: TRADE, account_id: "20000000-0000-4000-8000-000000000001", origin: "LIVE_FIRST", created_at: "2026-09-02T08:00:00Z", currency: "EUR", lifecycle: "CLOSED",
    plan_id: null, symbol: "EURUSD", direction: "SHORT", entry_model: null, planned_quantity: null, planned_rr: null, entry_price: "1.1", entered_at: null,
    entry_recorded_at: "2026-09-02T08:00:00Z", quantity: "0.25", oversize: null, exit_price: "1.09", exited_at: "2026-09-02T09:00:00Z",
    close_recorded_at: "2026-09-02T09:01:00Z", fees: "0", net_pnl: "250", realized_r: null, outcome: "WIN", pnl_source: "CALCULATED",
  },
  plan: null, strategy: { id: "40000000-0000-4000-8000-000000000001", version: "ICT V1.0", rules: {} }, riskVersion: null, revisions: [], riskChecks: [],
  legacyEvents: [], journal: [], positionFacts: [], riskBasisSource: null,
  tags: { setupGrade: null, liquidityContext: null, mssTimeframe: null, tags: [], source: null, recordedAt: null },
  evidence: [{ id: EVIDENCE, label: "ENTRY", timeframe: "M5", storedPhase: "LIVE", recordedAt: "2026-09-02T08:05:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 10 }],
}, "2026-09-02T10:00:00Z");

const output = {
  headline: { text: "No pre-trade plan was recorded.", sourceRefs: ["execution"] },
  thesisCheck: { assessment: "NOT_RECORDED", text: "No thesis was recorded before execution.", sourceRefs: ["strategy"] },
  executionVsPlan: { assessment: "NO_PLAN", text: "Nothing to compare with.", sourceRefs: ["execution"] },
  liveManagement: { assessment: "NO_LIVE_RECORDS", text: "Nothing was recorded while live.", sourceRefs: ["execution"] },
  patterns: [], keyLesson: { text: "Record the thesis at entry.", sourceRefs: ["execution"] }, limitations: [],
};

function harness() {
  const ledger = {
    reserve: vi.fn<AiLedger["reserve"]>().mockResolvedValue(), dispatch: vi.fn<AiLedger["dispatch"]>().mockResolvedValue(),
    recheck: vi.fn<AiLedger["recheck"]>().mockResolvedValue(), settle: vi.fn<AiLedger["settle"]>().mockResolvedValue(),
  };
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith("/input_tokens")
    ? Response.json({ input_tokens: 9000 })
    : Response.json({
      id: "resp_mock", model: "gpt-5.4-mini", status: "completed", usage: { input_tokens: 9000, output_tokens: 900, input_tokens_details: { cached_tokens: 0 } },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    }));
  return { ledger, transport };
}

const operation = operationFor("REVIEW_TRADE_TIMELINE");
const config = { model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens, imageDetail: operation.imageDetail, deepEnabled: false };
const owner = { userId: "10000000-0000-4000-8000-000000000001", accountId: "20000000-0000-4000-8000-000000000001", operationId: "70000000-0000-4000-8000-000000000001", stage: "A", operation: "REVIEW_TRADE_TIMELINE" };
const image = { sourceId: `evidence:${EVIDENCE}`, role: "M5", dataUrl: "data:image/png;base64,AA==" };

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("REVIEW_TRADE_TIMELINE registry entry", () => {
  it("is a frozen, tool-free Mini envelope with four images and its own versions", () => {
    expect(operation).toEqual({
      id: "REVIEW_TRADE_TIMELINE", version: "REVIEW_TRADE_TIMELINE_MINI_V1", provider: "openai", model: "gpt-5.4-mini", reasoningEffort: "medium",
      contract: "REVIEW_TRADE_TIMELINE_V1", maxInputTokens: 24000, maxOutputTokens: 4000, maxImages: 4, tools: [], imageDetail: "high",
      pricingProfile: MINI_PRICING.version, safetyMultiplier: "1.10", timeoutMs: 180000,
    });
    expect(Object.isFrozen(AI_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.tools)).toBe(true);
  });

  it("reserves exactly 47,520 micro-EUR with the existing pricing functions, far below the EUR 3 cap", () => {
    const amount = reservationMicros(operationPricing(operation), operation);
    expect(amount).toBe(47520);
    expect(reservationMicros(undefined, operation)).toBe(amount);
    expect(amount).toBeLessThan(3_000_000);
    expect(estimateAiCost("REVIEW_TRADE_TIMELINE", new Date())).toEqual({ typicalMicros: 16_000, maxMicros: 47520 });
  });

  it("stops with the Mini pricing profile and leaves REVIEW_TRADE V1 untouched for its history", () => {
    expect(() => operationPricing(operation, new Date(MINI_PRICING.validUntil))).toThrow(/pricing/);
    expect(aiCostEstimate("REVIEW_TRADE_TIMELINE", new Date(MINI_PRICING.validUntil))).toBeNull();
    expect(aiCostEstimate("REVIEW_TRADE_TIMELINE", new Date("2026-10-17T12:00:00Z"))).toEqual({ typicalMicros: 16_000, maxMicros: 47520 });
    expect(operationFor("REVIEW_TRADE")).toMatchObject({ version: "REVIEW_TRADE_MINI_V1", contract: "REVIEW_TRADE_V1", maxOutputTokens: 6000, maxImages: 4 });
    expect(reservationMicros(undefined, operationFor("REVIEW_TRADE"))).toBe(59400);
  });
});

describe("REVIEW_TRADE_TIMELINE through the budget gate (mocked transport)", () => {
  it("reserves, dispatches and sends the strict timeline contract with the selected image", async () => {
    const { ledger, transport } = harness();
    const result = await budgetedAiRequest({ apiKey: "mock-only", config, context: facts, images: [image], prior: [] }, owner, ledger, transport);
    expect(result.output).toEqual(output);
    expect(ledger.reserve.mock.calls[0][0]).toMatchObject({ ...owner, amount: 47520, model: "gpt-5.4-mini", provider: "openai" });
    expect(ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "SETTLED", inputTokens: 9000, outputTokens: 900 });
    const payload = JSON.parse(String(transport.mock.calls[1][1]?.body));
    const contract = operationContract(operation, facts);
    expect(payload).toMatchObject({
      model: "gpt-5.4-mini", max_output_tokens: 4000, reasoning: { effort: "medium" }, store: false, truncation: "disabled",
      instructions: contract.instructions, text: { format: { type: "json_schema", name: "review_trade_timeline_v1", strict: true, schema: contract.schema } },
    });
    expect(payload.tools).toBeUndefined();
    expect(payload.input[0].content[1]).toEqual({ type: "input_text", text: `Chart source evidence:${EVIDENCE}; user-assigned timeframe M5.` });
    const thesisEnum = JSON.stringify(contract.schema).includes(JSON.stringify(tradeTimelineAllowedSources(facts).preEntryIds));
    expect(thesisEnum).toBe(true);
  });

  it("refuses a fifth image and a changed output bound before any provider traffic", async () => {
    const tooMany = harness();
    await expect(budgetedAiRequest({ apiKey: "mock-only", config, context: facts, images: Array(5).fill(image), prior: [] }, owner, tooMany.ledger, tooMany.transport)).rejects.toThrow();
    expect(tooMany.transport).not.toHaveBeenCalled();
    const unbounded = harness();
    await expect(budgetedAiRequest({ apiKey: "mock-only", config: { ...config, maxOutputTokens: 6000 }, context: facts, images: [], prior: [] }, owner, unbounded.ledger, unbounded.transport)).rejects.toThrow(/output limit/);
    expect(unbounded.ledger.reserve).not.toHaveBeenCalled();
    expect(unbounded.transport).not.toHaveBeenCalled();
  });

  it("an input count above 24,000 tokens never generates and releases the unsent reservation", async () => {
    const { ledger, transport } = harness();
    transport.mockResolvedValueOnce(Response.json({ input_tokens: 24001 }));
    await expect(budgetedAiRequest({ apiKey: "mock-only", config, context: facts, images: [], prior: [] }, owner, ledger, transport)).rejects.toMatchObject({ code: "INPUT_LIMIT_EXCEEDED" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger.recheck).not.toHaveBeenCalled();
    expect(ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: { generation: "NOT_SENT" }, errorCode: "INPUT_LIMIT_EXCEEDED" });
  });
});
