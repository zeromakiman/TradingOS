import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { source as biasSource } from "./fixtures/bias-challenge";
import { createTestDatabase, OWNER } from "./helpers/pglite";

vi.mock("server-only", () => ({}));
import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { operationAllowedSources } from "@/ai/citation-sources";
import { operationContract } from "@/ai/operation-contract";
import { operationFor } from "@/ai/operations";
import { PRE_TRADE_FACTS_BYTES } from "@/ai/pre-trade-draft";
import { estimateRequest, MAX_IMAGE_TOKENS } from "@/ai/request-estimate";
import { maxTimelineFactsBytes, TIMELINE_REVIEW_LIMITS } from "@/ai/trade-timeline-review-sources";
import { TimelineReviewScopeError, tradeTimelineReviewContext } from "@/ai/trade-timeline-review-context";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { evaluateRisk } from "@/domain/risk";
import { storedRiskSchema } from "@/domain/risk-report";

// The trade-level AI operations at their maxima (Wave 4a): Analyze Setup and Challenge My Bias with the real ICT V1.0
// strategy, a 5,000-character thesis and three screenshots at the tile maximum; the timeline-aware trade review at
// its facts bound with four such screenshots. Every request fits its reviewed input limit as a whole.

const UNREADABLE = "data:image/png;base64,AA==";
let ict: { id: string; version: string; rules: Record<string, unknown>; written_rules: string };

beforeAll(async () => {
  const db = await createTestDatabase();
  await db.applyMigrations();
  const { strategyId } = await db.bootstrapAccount(OWNER);
  await db.admin();
  ict = (await db.query<typeof ict>("select id,version,rules,written_rules from public.strategy_versions where id=$1", [strategyId])).rows[0];
  await db.close();
}, 120_000);
afterAll(() => vi.restoreAllMocks());

function preTradeSource() {
  const source = structuredClone(biasSource);
  const proposal = { ...previewProposal, contractConfirmed: true, narrative: "T".repeat(5000) };
  source.proposal.proposal = proposal;
  source.strategy = { ...ict };
  source.risk = { ...source.risk, result: storedRiskSchema.parse(evaluateRisk(proposal, previewContext)) };
  return source;
}
const evidence = Array.from({ length: 3 }, (_, i) => ({ id: `e0000000-0000-4000-8000-00000000000${i + 1}`, role: "M5", sha256: "a".repeat(64), mime_type: "image/png", byte_size: 4_194_304 }));

describe("pre-trade AI at its maxima", () => {
  it.each([["ANALYZE_SETUP", analyzeSetupContext], ["CHALLENGE_BIAS", biasChallengeContext]] as const)("%s fits with a 5,000-character thesis and three maximal screenshots", (id, build) => {
    const operation = operationFor(id);
    const facts = build(preTradeSource(), evidence);
    expect(facts.version).toBe(`${id}_FACTS_V2`);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(PRE_TRADE_FACTS_BYTES);
    const images = evidence.map(e => ({ sourceId: `evidence:${e.id}`, role: e.role, dataUrl: UNREADABLE }));
    const estimate = estimateRequest(operation, { context: facts, images, prior: [] });
    expect(estimate.imageTokens).toBe(3 * MAX_IMAGE_TOKENS);
    expect(estimate.tokens).toBeLessThanOrEqual(operation.maxInputTokens);
    // The written prompt text the V1 facts carried alone is about 6,600 tokens: with it the same request would not fit.
    const withWritten = { ...facts, strategy: { ...facts.strategy, writtenRules: ict.written_rules } };
    expect(estimateRequest(operation, { context: withWritten, images, prior: [] }).tokens).toBeGreaterThan(operation.maxInputTokens);
  });

  it.each(["ANALYZE_SETUP", "CHALLENGE_BIAS"] as const)("stored %s V1 facts with the written rules still validate and keep their contract", id => {
    const v2 = (id === "ANALYZE_SETUP" ? analyzeSetupContext : biasChallengeContext)(preTradeSource(), evidence);
    const v1 = { ...v2, version: `${id}_FACTS_V1`, strategy: { ...v2.strategy, writtenRules: ict.written_rules } };
    expect(operationAllowedSources(id, v1)).toEqual(v2.sourceRefs);
    expect(operationContract(operationFor(id), v1)).toHaveProperty("version", `${id}_CITATIONS_V2`);
  });
});

describe("timeline-aware trade review at its maxima", () => {
  const base = {
    trade: {
      id: "a0000000-0000-4000-8000-000000000002", account_id: "20000000-0000-4000-8000-000000000001", origin: "LIVE_FIRST" as const, created_at: "2026-09-02T08:00:00Z",
      currency: "EUR", lifecycle: "CLOSED" as const, plan_id: null, symbol: "EURUSD", direction: "SHORT" as const, entry_model: null, planned_quantity: null, planned_rr: null,
      entry_price: "1.1", entered_at: null, entry_recorded_at: "2026-09-02T08:00:00Z", quantity: "0.25", oversize: null, exit_price: "1.09",
      exited_at: "2026-09-02T09:00:00Z", close_recorded_at: "2026-09-02T09:01:00Z", fees: "0", net_pnl: "250", realized_r: null, outcome: "WIN" as const, pnl_source: "CALCULATED" as const,
    },
    plan: null, riskVersion: null, revisions: [], riskChecks: [], legacyEvents: [], positionFacts: [], riskBasisSource: null,
    tags: { setupGrade: null, liquidityContext: null, mssTimeframe: null, tags: [], source: null, recordedAt: null },
  };
  /** The densest facts the review accepts with `images` screenshots: `count` journal entries full of characters JSON escapes (or of `body`). */
  function densest(images: number, count: number, body: (length: number) => string = length => "\"quoted\" \\ ".repeat(length)) {
    const evidence = Array.from({ length: images }, (_, i) => ({ id: `e0000000-0000-4000-8000-00000000001${i}`, label: "ENTRY" as const, timeframe: "M5", storedPhase: "LIVE" as const, recordedAt: "2026-09-02T08:05:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 10 }));
    const build = (count: number, length: number) => tradeTimelineReviewContext({
      ...base, strategy: { id: ict.id, version: ict.version, rules: ict.rules }, evidence,
      journal: Array.from({ length: count }, (_, i) => ({ id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, kind: "NOTE" as const, body: body(length), details: {}, phase: "LIVE" as const, recordedAt: `2026-09-02T08:${String(10 + i).padStart(2, "0")}:00Z` })),
    }, "2026-09-02T10:00:00Z");
    let length = 1;
    for (;;) {
      try { build(count, length * 2); length *= 2; } catch (error) { if (!(error instanceof TimelineReviewScopeError)) throw error; break; }
    }
    let low = length, high = length * 2;
    while (high - low > 1) { const mid = Math.floor((low + high) / 2); try { build(count, mid); low = mid; } catch { high = mid; } }
    return { facts: build(count, low), evidence };
  }

  it.each([[0, TIMELINE_REVIEW_LIMITS.timelineItems - 2], [4, 8]])("the densest facts the review accepts fit with %s maximal screenshots", (images, count) => {
    const operation = operationFor("REVIEW_TRADE_TIMELINE");
    const { facts, evidence } = densest(images, count);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeGreaterThan(maxTimelineFactsBytes(images) - 600);
    const estimate = estimateRequest(operation, { context: facts, images: evidence.map(e => ({ sourceId: `evidence:${e.id}`, role: "M5", dataUrl: UNREADABLE })), prior: [] });
    expect(estimate.tokens).toBeLessThanOrEqual(operation.maxInputTokens);
  });

  it("journals dense with numbers are refused by the whole-request estimate well within the facts bound, before anything is written", () => {
    const operation = operationFor("REVIEW_TRADE_TIMELINE");
    // One o200k piece per byte: far denser than the 2.5–3 bytes per token the facts bound assumes.
    const { facts } = densest(0, TIMELINE_REVIEW_LIMITS.timelineItems - 2, length => "1 2 3 4 5 ".repeat(length));
    expect(estimateRequest(operation, { context: facts, images: [], prior: [] }).tokens).toBeLessThanOrEqual(operation.maxInputTokens);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThan(maxTimelineFactsBytes(0) - 4_000);
  });
});
