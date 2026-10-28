import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ids, maximalPeriodicSources } from "./fixtures/periodic-v2";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// The request gate (src/ai/request-gate.ts) around the whole-request pre-flight estimate (src/ai/request-estimate.ts)
// and the release of provably unsent requests (0018 Part 4): every branch of the reservation's settlement.

const m = vi.hoisted(() => ({ adapter: null as null | { execute: (...args: unknown[]) => Promise<unknown>; accountUsage: (...args: unknown[]) => unknown } }));
vi.mock("server-only", () => ({}));
vi.mock("@/ai/providers", async importOriginal => {
  const real = await importOriginal<typeof import("@/ai/providers")>();
  return { ...real, providerFor: (id: string) => m.adapter ?? real.providerFor(id) };
});
import { operationFor } from "@/ai/operations";
import { operationPricing, priceUsage, reservationMicros } from "@/ai/pricing";
import { ProviderError, responsesWire } from "@/ai/provider";
import { recentTradesContextV2 } from "@/ai/recent-trades-context";
import { estimateRequest, imageTokens, MAX_IMAGE_TOKENS, operationRequestConfig, textTokens } from "@/ai/request-estimate";
import { type AiLedger, budgetedAiRequest, GENERATION_NOT_SENT } from "@/ai/request-gate";
import { estimateInputTokens } from "../scripts/local-stack/mock-openai-generator.mjs";

const operation = operationFor("WEEKLY_REVIEW");
const amount = reservationMicros(operationPricing(operation), operation);
const owner = { userId: "10000000-0000-4000-8000-000000000001", accountId: "20000000-0000-4000-8000-000000000001", operationId: "40000000-0000-4000-8000-000000000001", stage: "A", operation: operation.id };
const request = (context: unknown = weeklyFacts, images: { sourceId: string; role: string; dataUrl: string }[] = []) => ({
  apiKey: "mock-only", config: operationRequestConfig(operation), context, images, prior: [],
});
const completed = () => Response.json({
  id: "resp_mock", model: operation.model, status: "completed", usage: { input_tokens: 1000, output_tokens: 100 },
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(weeklyOutput) }] }],
});

function harness(options: { count?: () => Promise<Response>; generate?: () => Promise<Response> } = {}) {
  const ledger = {
    reserve: vi.fn<AiLedger["reserve"]>().mockResolvedValue(), dispatch: vi.fn<AiLedger["dispatch"]>().mockResolvedValue(),
    recheck: vi.fn<AiLedger["recheck"]>().mockResolvedValue(), settle: vi.fn<AiLedger["settle"]>().mockResolvedValue(),
  };
  const generation = vi.fn(options.generate ?? (async () => completed()));
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith("/input_tokens") ? (options.count ? options.count() : Response.json({ input_tokens: 1000 })) : generation());
  return { ledger, transport, generation };
}

/** A PNG header with the given pixel size: all the tile formula reads. */
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Weekly facts padded so the facts alone stay under the input limit while the whole request is above it. */
function factsOnlyUnderLimit() {
  const facts = structuredClone(weeklyFacts);
  const base = Buffer.byteLength(JSON.stringify(facts));
  facts.trades[0].originalPlan.proposal.narrative = "x".repeat(operation.maxInputTokens * 4 - 400 - base + String(facts.trades[0].originalPlan.proposal.narrative ?? "").length);
  return facts;
}

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  m.adapter = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A deterministic mixed-script string: letters, digits, symbols, whitespace, emoji, Cyrillic, CJK and combining marks. */
function noisyText(seed: number, length: number): string {
  const alphabet = ["a", "Z", "7", " ", "\n", "\t", "-", ":", "\"", "\\", "_", "é", "ж", "語", "😀", "́", "€", ".", "0", "x"];
  let state = seed;
  let text = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += alphabet[state % alphabet.length];
  }
  return text;
}

describe("whole-request pre-flight estimate", () => {
  it("counts the whole count body, never below what the mock provider counts", () => {
    const input = request();
    const { countWire } = responsesWire(input, operation);
    const estimate = estimateRequest(operation, input);
    expect(estimate.byteTokens).toBe(estimateInputTokens(countWire));
    expect(estimate.tokens).toBeGreaterThanOrEqual(estimateInputTokens(countWire));
    expect(estimate.tokens).toBe(Math.max(estimate.textTokens, estimate.byteTokens));
    expect(estimate.tokens).toBeGreaterThan(Math.ceil(Buffer.byteLength(JSON.stringify(weeklyFacts)) / 4));
  });

  it("counts dense ids, timestamps and decimals at least one token per o200k piece, far above 4 bytes per token", () => {
    // Pieces the o200k tokenizer can never merge: hex runs and digit groups of at most three, separators apart.
    const uuid = "9df00a41-4e9b-4216-b9c5-d4ebdc8d8f58";
    expect(textTokens(uuid)).toBeGreaterThanOrEqual(18);
    expect(textTokens("2026-10-27T08:32:00+00:00")).toBeGreaterThanOrEqual(15);
    // "163" "6" "." then the fraction in groups of at most three digits.
    const fraction = "25000000000000000000000000000000";
    expect(textTokens(`1636.${fraction}`)).toBe(3 + Math.ceil(fraction.length / 3));
    for (const dense of [uuid, "2026-10-27T08:32:00+00:00"]) expect(textTokens(dense)).toBeGreaterThanOrEqual(2 * Math.ceil(Buffer.byteLength(dense) / 4));
    expect(textTokens(`1636.${fraction}`)).toBeGreaterThan(Math.ceil(Buffer.byteLength(`1636.${fraction}`) / 4));
    // English prose stays near the 4-bytes rule: never below it, at most about one token per word.
    const prose = "Moved the stop under the swing low after the displacement candle closed; holding for the target.";
    expect(textTokens(prose)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(prose) / 4));
    expect(textTokens(prose)).toBeLessThanOrEqual(2 * Math.ceil(Buffer.byteLength(prose) / 4));
  });

  it("covers every character: no text is ever counted below 4 bytes per token", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = noisyText(seed, 500);
      expect(textTokens(text)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(text) / 4));
    }
    expect(textTokens("")).toBe(0);
  });

  it("refuses a database-shaped sample the 4-bytes rule would admit, before anything is reserved", async () => {
    const recent = operationFor("RECENT_TRADES_ANALYSIS");
    const facts = recentTradesContextV2(ids.account, 30, maximalPeriodicSources(30, 60, "2026-08-01T08:00:00.000Z", 600), "2026-09-23T12:00:00.000Z", "USD");
    const input = { apiKey: "mock-only", config: operationRequestConfig(recent), context: facts, images: [], prior: [] };
    const estimate = estimateRequest(recent, input);
    expect(estimate.byteTokens).toBeLessThan(recent.maxInputTokens);
    expect(estimate.tokens).toBeGreaterThan(recent.maxInputTokens);
    const h = harness();
    await expect(budgetedAiRequest(input, { ...owner, operation: recent.id }, h.ledger, h.transport)).rejects.toMatchObject({ code: "INPUT_LIMIT_EXCEEDED" });
    expect(h.ledger.reserve).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("prices images by the high-detail tile formula, an unreadable image at the maximum, as the provider does", () => {
    expect(imageTokens(png(1, 1))).toBe(85 + 170);
    expect(imageTokens(png(4096, 2048))).toBe(85 + 170 * 6);
    expect(imageTokens(png(1024, 1024))).toBe(85 + 170 * 4);
    expect(imageTokens("data:image/png;base64,AA==")).toBe(MAX_IMAGE_TOKENS);
    expect(imageTokens(png(4096, 2048), "low")).toBe(85);
    // The setup evaluator's contract takes any context, so images are measured alone here.
    const setup = operationFor("SETUP_ANALYSIS");
    const images = [png(4096, 2048), png(800, 600), "data:image/png;base64,AA=="].map((dataUrl, i) => ({ sourceId: `evidence:${i}`, role: "M5", dataUrl }));
    const input = { apiKey: "mock-only", config: operationRequestConfig(setup), context: { x: 1 }, images, prior: [] };
    const { countWire } = responsesWire(input, setup);
    const estimate = estimateRequest(setup, input);
    // The mock prices the same images by the same tiles; image bytes are never counted as text.
    expect(estimate.byteTokens + estimate.imageTokens).toBe(estimateInputTokens(countWire));
    expect(estimate.tokens).toBeGreaterThanOrEqual(estimateInputTokens(countWire));
    expect(estimate.imageTokens).toBe(1105 + imageTokens(png(800, 600)) + MAX_IMAGE_TOKENS);
  });

  it("refuses before anything is reserved, dispatched or sent when the whole request is above the input limit", async () => {
    const facts = factsOnlyUnderLimit();
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(facts)) / 4)).toBeLessThan(operation.maxInputTokens);
    expect(estimateRequest(operation, request(facts)).tokens).toBeGreaterThan(operation.maxInputTokens);
    const h = harness();
    await expect(budgetedAiRequest(request(facts), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "INPUT_LIMIT_EXCEEDED" });
    expect(h.ledger.reserve).not.toHaveBeenCalled();
    expect(h.ledger.dispatch).not.toHaveBeenCalled();
    expect(h.ledger.settle).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it("lets a request at the limit through to the provider's exact count", async () => {
    const h = harness();
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).resolves.toMatchObject({ responseId: "resp_mock" });
    expect(h.ledger.reserve).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "SETTLED" });
  });
});

describe("settlement branches", () => {
  it("a count that cannot be completed is released: nothing charged, no generation, no recheck", async () => {
    const h = harness({ count: async () => { throw new Error("offline"); } });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "INPUT_COUNT_UNAVAILABLE" });
    expect(h.ledger.recheck).not.toHaveBeenCalled();
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "INPUT_COUNT_UNAVAILABLE" });
  });

  it("an exact count above the limit is released the same way", async () => {
    const h = harness({ count: async () => Response.json({ input_tokens: operation.maxInputTokens + 1 }) });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "INPUT_LIMIT_EXCEEDED" });
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "INPUT_LIMIT_EXCEEDED" });
  });

  it("a recheck that throws without committing the generation is released, and its error reaches the flow", async () => {
    const h = harness();
    const changed = new ProviderError("AI_BUDGET_OR_PERMISSION_CHANGED");
    h.ledger.recheck.mockRejectedValueOnce(changed);
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toBe(changed);
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "AI_BUDGET_OR_PERMISSION_CHANGED" });
  });

  it("a failure after the recheck committed the generation holds the full reservation as UNCERTAIN", async () => {
    const h = harness({ generate: async () => { throw new Error("offline"); } });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.ledger.recheck).toHaveBeenCalledTimes(1);
    expect(h.generation).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "UNCERTAIN", chargedMicros: amount, errorCode: "TIMEOUT_OR_NETWORK" });
  });

  it("when SQL refuses the release (a generation commit exists after all), the full reservation is held instead", async () => {
    const h = harness({ count: async () => { throw new Error("offline"); } });
    h.ledger.settle.mockImplementation(async (_id, _user, record) => {
      if (record.disposition === "CANCELLED") throw new ProviderError("AI_ACCOUNTING_PERSISTENCE_FAILED");
    });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.ledger.settle.mock.calls.map(call => call[2].disposition)).toEqual(["CANCELLED", "UNCERTAIN"]);
    expect(h.ledger.settle.mock.calls[1][2]).toMatchObject({ disposition: "UNCERTAIN", chargedMicros: amount, errorCode: "INPUT_COUNT_UNAVAILABLE" });
  });

  it("an invalid envelope fails before any provider traffic and is released", async () => {
    const h = harness();
    const images = Array.from({ length: 1 }, (_, i) => ({ sourceId: `evidence:${i}`, role: "M5", dataUrl: png(10, 10) }));
    await expect(budgetedAiRequest(request(weeklyFacts, images), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "INVALID_OPERATION_ENVELOPE" });
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT });
  });

  it("a provider response (refusal) after the recheck settles its measured usage; it is never released", async () => {
    const h = harness({ generate: async () => Response.json({ id: "resp_refused", model: operation.model, status: "completed", usage: { input_tokens: 900, output_tokens: 20 }, output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }) });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "REFUSED" });
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "SETTLED", responseId: "resp_refused", errorCode: "REFUSED" });
  });

  it("a failure that carries provider response data is never released, even without a committed recheck", async () => {
    // An adapter that (wrongly) reached the provider without the recheck: its response metadata proves traffic.
    m.adapter = {
      execute: async () => { throw new ProviderError("INVALID_JSON", null, "resp_unexpected", operation.model); },
      accountUsage: (raw: unknown, pricing: unknown) => priceUsage(raw, pricing as Parameters<typeof priceUsage>[1]),
    };
    const h = harness();
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "UNCERTAIN", chargedMicros: amount, responseId: "resp_unexpected" });
  });

  it("a dispatch that fails, even one that committed and lost its response, is released as never sent", async () => {
    const h = harness();
    h.ledger.dispatch.mockRejectedValueOnce(new Error("timeout"));
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toThrow("timeout");
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.recheck).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    // The marker lets SQL release a committed dispatch too; it refuses only after a committed generation (none here).
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "NOT_DISPATCHED" });
  });

  it("a reserve that fails is released as never dispatched, best effort, and reports the original failure", async () => {
    const h = harness();
    const lost = new ProviderError("AI_BUDGET_OR_PERMISSION_CHANGED");
    h.ledger.reserve.mockRejectedValueOnce(lost);
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toBe(lost);
    expect(h.ledger.dispatch).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, errorCode: "NOT_DISPATCHED" });
    // Nothing was reserved: SQL refuses the release, and the flow still sees why the reservation failed.
    const refused = harness();
    refused.ledger.reserve.mockRejectedValueOnce(lost);
    refused.ledger.settle.mockRejectedValueOnce(new ProviderError("AI_ACCOUNTING_PERSISTENCE_FAILED"));
    await expect(budgetedAiRequest(request(), owner, refused.ledger, refused.transport)).rejects.toBe(lost);
    expect(refused.transport).not.toHaveBeenCalled();
  });
});
