import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ids, maximalPeriodicSources } from "./fixtures/periodic-v2";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// The request gate (src/ai/request-gate.ts) around the whole-request pre-flight estimate (src/ai/request-estimate.ts)
// and every branch of the reservation's settlement: a zero-cost release (0018 Part 4) only while no provider request of
// any kind was issued; after the input count reached the provider, a failure without usable usage holds the full
// reservation as UNCERTAIN (docs/AI_BUDGET_REVIEW.md, as in V1).

const m = vi.hoisted(() => ({ adapter: null as null | { execute: (...args: unknown[]) => Promise<unknown>; accountUsage: (...args: unknown[]) => unknown } }));
vi.mock("server-only", () => ({}));
vi.mock("@/ai/providers", async importOriginal => {
  const real = await importOriginal<typeof import("@/ai/providers")>();
  return { ...real, providerFor: (id: string) => m.adapter ?? real.providerFor(id) };
});
import { operationFor } from "@/ai/operations";
import { operationPricing, priceUsage, reservationMicros } from "@/ai/pricing";
import { callResponses, ProviderError, responsesWire } from "@/ai/provider";
import { recentTradesContextV2 } from "@/ai/recent-trades-context";
import { estimateRequest, imageTokens, MAX_IMAGE_TOKENS, operationRequestConfig, textTokens } from "@/ai/request-estimate";
import { type AiLedger, budgetedAiRequest, GENERATION_NOT_SENT } from "@/ai/request-gate";
import { estimateInputTokens } from "../scripts/local-stack/mock-openai-generator.mjs";

// Every clock read in this file is pinned to NOW, inside the Mini pricing profile's reviewed window: the module-level
// amount below runs before beforeEach freezes Date, so it is priced at NOW explicitly, never at the real time.
const NOW = new Date("2026-10-17T12:00:00Z");
const operation = operationFor("WEEKLY_REVIEW");
const amount = reservationMicros(operationPricing(operation, NOW), operation);
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

/** The adapter's limit on one generation body (src/ai/provider.ts): a larger request is never sent. */
const PAYLOAD_LIMIT = 64 * 1024 * 1024;

/**
 * Makes the adapter measure this request's generation body as `bytes` long, so the payload limit is exercised without
 * building a 64 MiB body. Every other measurement, the pre-flight estimate of the count body included, stays real.
 */
function measureGenerationBodyAs(input: Parameters<typeof callResponses>[0], op: typeof operation, bytes: number) {
  const { wire } = responsesWire(input, op);
  const byteLength = Buffer.byteLength;
  return vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => (value === wire ? bytes : byteLength(value, encoding)));
}

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
  /** The full reservation held: what every failure after provider contact without usable usage settles. */
  const HELD = { disposition: "UNCERTAIN", chargedMicros: amount, usage: null, responseModel: null, responseId: null };
  /** One chart for an operation that takes none: the adapter refuses it before its first provider request. */
  const oneImage = () => [{ sourceId: "evidence:0", role: "M5", dataUrl: png(10, 10) }];

  it("a count request that fails after it was sent holds the full reservation as UNCERTAIN: no recheck, no generation", async () => {
    const h = harness({ count: async () => { throw new Error("offline"); } });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.ledger.recheck).not.toHaveBeenCalled();
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ ...HELD, errorCode: "INPUT_COUNT_UNAVAILABLE" });
  });

  it("an unusable count answer (an HTTP error, a malformed count) is held the same way", async () => {
    for (const answer of [() => new Response("unavailable", { status: 503 }), () => Response.json({ input_tokens: -1 }), () => Response.json({})]) {
      const h = harness({ count: async () => answer() });
      await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
      expect(h.generation).not.toHaveBeenCalled();
      expect(h.ledger.settle.mock.calls).toHaveLength(1);
      expect(h.ledger.settle.mock.calls[0][2]).toEqual({ ...HELD, errorCode: "INPUT_COUNT_UNAVAILABLE" });
    }
  });

  it("an exact count above the limit never generates and holds the full reservation: the count reached the provider", async () => {
    const h = harness({ count: async () => Response.json({ input_tokens: operation.maxInputTokens + 1 }) });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.ledger.recheck).not.toHaveBeenCalled();
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ ...HELD, errorCode: "INPUT_LIMIT_EXCEEDED" });
  });

  it("a recheck refused after the count was sent never generates and holds the full reservation", async () => {
    const h = harness();
    h.ledger.recheck.mockRejectedValueOnce(new ProviderError("AI_BUDGET_OR_PERMISSION_CHANGED"));
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.generation).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ ...HELD, errorCode: "AI_BUDGET_OR_PERMISSION_CHANGED" });
  });

  it("a failure after the recheck committed the generation holds the full reservation as UNCERTAIN", async () => {
    const h = harness({ generate: async () => { throw new Error("offline"); } });
    await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.ledger.recheck).toHaveBeenCalledTimes(1);
    expect(h.generation).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({ disposition: "UNCERTAIN", chargedMicros: amount, errorCode: "TIMEOUT_OR_NETWORK" });
  });

  it("an invalid envelope fails before any provider request and is released at zero cost", async () => {
    const h = harness();
    await expect(budgetedAiRequest(request(weeklyFacts, oneImage()), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "INVALID_OPERATION_ENVELOPE" });
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "INVALID_OPERATION_ENVELOPE" });
  });

  it("a generation body above the 64 MiB limit fails before any provider request and is released at zero cost", async () => {
    const h = harness();
    const measured = measureGenerationBodyAs(request(), operation, PAYLOAD_LIMIT + 1);
    try {
      await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "OPERATION_PAYLOAD_TOO_LARGE" });
    } finally {
      measured.mockRestore();
    }
    // Reserved and dispatched, then refused by the adapter before its first provider request.
    expect(h.ledger.reserve).toHaveBeenCalledTimes(1);
    expect(h.ledger.dispatch).toHaveBeenCalledTimes(1);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.recheck).not.toHaveBeenCalled();
    expect(h.ledger.settle).toHaveBeenCalledTimes(1);
    expect(h.ledger.settle.mock.calls[0][2]).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "OPERATION_PAYLOAD_TOO_LARGE" });
  });

  it("when SQL refuses that release (a generation commit exists after all), the full reservation is held instead", async () => {
    const h = harness();
    h.ledger.settle.mockImplementation(async (_id, _user, record) => {
      if (record.disposition === "CANCELLED") throw new ProviderError("AI_ACCOUNTING_PERSISTENCE_FAILED");
    });
    await expect(budgetedAiRequest(request(weeklyFacts, oneImage()), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.ledger.settle.mock.calls.map(call => call[2].disposition)).toEqual(["CANCELLED", "UNCERTAIN"]);
    expect(h.ledger.settle.mock.calls[1][2]).toEqual({ ...HELD, errorCode: "INVALID_OPERATION_ENVELOPE" });
  });

  it("only the adapter's contact report decides a release: the same error is released before contact and held after it", async () => {
    for (const contacted of [false, true]) {
      m.adapter = {
        execute: async (...args: unknown[]) => {
          if (contacted) (args[5] as () => void)();
          throw new ProviderError("INPUT_COUNT_UNAVAILABLE");
        },
        accountUsage: (raw: unknown, pricing: unknown) => priceUsage(raw, pricing as Parameters<typeof priceUsage>[1]),
      };
      const h = harness();
      await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: contacted ? "ACCOUNTING_UNCERTAIN" : "INPUT_COUNT_UNAVAILABLE" });
      expect(h.ledger.settle).toHaveBeenCalledTimes(1);
      expect(h.ledger.settle.mock.calls[0][2]).toEqual(contacted
        ? { ...HELD, errorCode: "INPUT_COUNT_UNAVAILABLE" }
        : { disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT, errorCode: "INPUT_COUNT_UNAVAILABLE" });
    }
  });

  it("an adapter that returns nothing is reported as NO_RESULT: released before contact, held after it", async () => {
    for (const contacted of [false, true]) {
      m.adapter = {
        execute: async (...args: unknown[]) => { if (contacted) (args[5] as () => void)(); return undefined; },
        accountUsage: (raw: unknown, pricing: unknown) => priceUsage(raw, pricing as Parameters<typeof priceUsage>[1]),
      };
      const h = harness();
      await expect(budgetedAiRequest(request(), owner, h.ledger, h.transport)).rejects.toMatchObject({ code: contacted ? "ACCOUNTING_UNCERTAIN" : "NO_RESULT" });
      expect(h.ledger.settle).toHaveBeenCalledTimes(1);
      expect(h.ledger.settle.mock.calls[0][2]).toMatchObject(contacted
        ? { disposition: "UNCERTAIN", chargedMicros: amount, errorCode: "ACCOUNTING_UNCERTAIN" }
        : { disposition: "CANCELLED", chargedMicros: 0, usage: GENERATION_NOT_SENT });
    }
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

describe("provider contact reports (src/ai/provider.ts)", () => {
  it("reports every provider request, the input count and the generation, immediately before issuing it", async () => {
    const order: string[] = [];
    const transport = vi.fn<typeof fetch>(async url => {
      order.push(`send ${new URL(String(url)).pathname}`);
      return String(url).endsWith("/input_tokens") ? Response.json({ input_tokens: 1000 }) : completed();
    });
    await callResponses(request(), transport, undefined, operation, async () => { order.push("recheck"); }, () => { order.push("contact"); });
    expect(order).toEqual(["contact", "send /v1/responses/input_tokens", "recheck", "contact", "send /v1/responses"]);
  });

  it("reports a count request whose transport throws at once: it may have left, so it counts as contact", async () => {
    const contact = vi.fn();
    const transport = vi.fn<typeof fetch>(() => { throw new TypeError("fetch failed"); });
    await expect(callResponses(request(), transport, undefined, operation, undefined, contact)).rejects.toMatchObject({ code: "INPUT_COUNT_UNAVAILABLE" });
    expect(contact).toHaveBeenCalledTimes(1);
    expect(contact.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]);
  });

  it("reports nothing for an envelope, image or payload failure: those fail before the first provider request", async () => {
    const setup = operationFor("SETUP_ANALYSIS");
    const setupRequest = (dataUrl: string) => ({ apiKey: "mock-only", config: operationRequestConfig(setup), context: { x: 1 }, images: [{ sourceId: "evidence:0", role: "M5", dataUrl }], prior: [] });
    // The optional last element is the measured size of the generation body (a real 64 MiB body is not built).
    const cases: [Parameters<typeof callResponses>[0], typeof operation, string, number?][] = [
      [request(weeklyFacts, [{ sourceId: "evidence:0", role: "M5", dataUrl: png(10, 10) }]), operation, "INVALID_OPERATION_ENVELOPE"],
      [setupRequest("https://example.com/chart.png"), setup, "INVALID_OPERATION_IMAGE"],
      [request(), operation, "OPERATION_PAYLOAD_TOO_LARGE", PAYLOAD_LIMIT + 1],
    ];
    for (const [input, op, code, bodyBytes] of cases) {
      const contact = vi.fn();
      const transport = vi.fn<typeof fetch>();
      const measured = bodyBytes === undefined ? null : measureGenerationBodyAs(input, op, bodyBytes);
      try {
        await expect(callResponses(input, transport, undefined, op, undefined, contact)).rejects.toMatchObject({ code });
      } finally {
        measured?.mockRestore();
      }
      expect(contact).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("measures the whole generation body against the payload limit: a body of exactly 64 MiB is sent", async () => {
    const input = request();
    const { wire } = responsesWire(input, operation);
    const contact = vi.fn();
    const transport = vi.fn<typeof fetch>(async url => String(url).endsWith("/input_tokens") ? Response.json({ input_tokens: 1000 }) : completed());
    const measured = measureGenerationBodyAs(input, operation, PAYLOAD_LIMIT);
    try {
      await expect(callResponses(input, transport, undefined, operation, undefined, contact)).resolves.toMatchObject({ responseId: "resp_mock" });
      expect(measured.mock.calls.some(([value]) => value === wire)).toBe(true);
    } finally {
      measured.mockRestore();
    }
    expect(contact).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
