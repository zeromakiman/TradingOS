import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { validateAnalyzeSetup } from "@/ai/analyze-setup-contract";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { validateBiasChallenge } from "@/ai/bias-challenge-contract";
import { validateChartEvaluation } from "@/ai/chart-contract";
import { operationAllowedSources } from "@/ai/citation-sources";
import { modelConfig } from "@/ai/config";
import { monthlyReviewContext } from "@/ai/monthly-review-context";
import { validateMonthlyReview } from "@/ai/monthly-review-contract";
import { operationContract } from "@/ai/operation-contract";
import { AI_OPERATIONS, type AiOperation, operationFor, setupOperation } from "@/ai/operations";
import { acceptsResponseModel, operationPricing, priceUsage, reservationMicros } from "@/ai/pricing";
import { callResponses, ProviderError } from "@/ai/provider";
import type { AiProviderRequest } from "@/ai/provider-contract";
import { recentTradesContext } from "@/ai/recent-trades-context";
import { validateRecentTrades } from "@/ai/recent-trades-contract";
import { type AiLedger, budgetedAiRequest } from "@/ai/request-gate";
import { type PassRecord, runEvaluation } from "@/ai/run";
import { tradeReviewContext } from "@/ai/trade-review-context";
import { validateTradeReview } from "@/ai/trade-review-contract";
import { type TimelineReviewInput, type TimelineReviewTrade, tradeTimelineReviewContext } from "@/ai/trade-timeline-review-context";
import { TimelineReviewRejection, validateTradeTimelineReview } from "@/ai/trade-timeline-review-contract";
import { validateWeeklyReview } from "@/ai/weekly-review-contract";
import {
  buildResponsesResult, estimateInputTokens, fitText, generateOutput, imageDimensions, imageTokens, MAX_IMAGE_TOKENS, MOCK_SCENARIOS, type MockScenarioName,
  parseScenarioConfig, resolveScenario, ScenarioConfigError, schemaErrors,
} from "../scripts/local-stack/mock-openai-generator.mjs";
import { context as chartContext } from "./chart-fixtures";
import { source as biasSource } from "./fixtures/bias-challenge";
import * as monthly from "./fixtures/monthly-review";
import * as recent from "./fixtures/recent-trades";
import { events, plan, risk, strategy, trade } from "./fixtures/trade-review";
import { facts as weeklyFacts } from "./fixtures/weekly-review";

type Preload = typeof import("../scripts/local-stack/mock-openai.mjs");
let preload: Preload;

const MOCK_KEY = "sk-local-mock-vitest";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const DIRECTIVE = /\b(?:take|enter|execute)\s+(?:the|this)\s+trade\b/i;
const SIGNAL = /\b(?:buy|sell)\b|\b(?:will|going to)\s+(?:rise|fall|rally|drop|reach|hit)\b/i;

beforeAll(async () => {
  // The preload installs itself only when MOCK_OPENAI === "1"; tests use its exported pieces with injected fetches.
  vi.stubEnv("MOCK_OPENAI", "");
  preload = await import("../scripts/local-stack/mock-openai.mjs");
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", MOCK_KEY);
  vi.stubEnv("MOCK_OPENAI", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** Minimal PNG header (signature + IHDR): enough for the provider's data-URL check and the mock's tile estimate. */
function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const CHART = pngDataUrl(1280, 720);

function harness(scenarios: string | null = null) {
  const lines: string[] = [];
  const originalFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("The OpenAI mock must not reach the network in this test");
  });
  const sleep = vi.fn<(ms: number, signal?: AbortSignal | null) => Promise<void>>(async () => {});
  const readScenarioText = vi.fn(() => scenarios);
  const mockFetch = preload.createMockFetch({ originalFetch, readScenarioText, log: line => { lines.push(line); }, sleep, now: () => NOW });
  return { mockFetch, lines, originalFetch, sleep, readScenarioText };
}

function providerRequest(operation: AiOperation, context: unknown, images: AiProviderRequest["images"] = [], prior: unknown[] = []): AiProviderRequest {
  return {
    apiKey: MOCK_KEY,
    config: { model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens, imageDetail: operation.imageDetail, deepEnabled: false },
    context, images, prior,
  };
}

function ajvErrors(schema: unknown, value: unknown): string[] {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema as Parameters<typeof ajv.compile>[0]);
  return validate(value) ? [] : (validate.errors ?? []).map(error => `${error.instancePath} ${error.message}`);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function ledger() {
  return {
    reserve: vi.fn<AiLedger["reserve"]>().mockResolvedValue(), dispatch: vi.fn<AiLedger["dispatch"]>().mockResolvedValue(),
    recheck: vi.fn<AiLedger["recheck"]>().mockResolvedValue(), settle: vi.fn<AiLedger["settle"]>().mockResolvedValue(),
  };
}
const owner = (operation: AiOperation, stage = "A") => ({ userId: "owner", accountId: "account", operationId: "40000000-0000-4000-8000-000000000009", stage, operation: operation.id });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

// ---------------------------------------------------------------------------------------------------------------
// Representative contexts (tests/fixtures builders) for every operation
// ---------------------------------------------------------------------------------------------------------------

const EVIDENCE = [{ id: "50000000-0000-4000-8000-0000000000e1", role: "M5", sha256: "a".repeat(64), mime_type: "image/png", byte_size: 33 }];
const sourceRefsOf = (context: unknown) => (context as { sourceRefs: string[] }).sourceRefs;
const hasEvidence = (context: unknown) => (context as { selectedEvidence: unknown[] }).selectedEvidence.length > 0;

const TL = {
  trade: "a0000000-0000-4000-8000-000000000001", live: "a0000000-0000-4000-8000-000000000002", plan: plan.id,
  revision1: "b0000000-0000-4000-8000-000000000001", revision2: "b0000000-0000-4000-8000-000000000002",
  check1: "b1000000-0000-4000-8000-000000000001", check2: "b1000000-0000-4000-8000-000000000002",
  preEntryNote: "c0000000-0000-4000-8000-000000000001", stopChange: "c0000000-0000-4000-8000-000000000002",
  lesson: "c0000000-0000-4000-8000-000000000003", liveNote: "c0000000-0000-4000-8000-000000000004",
  stop2: "c0000000-0000-4000-8000-000000000005", stop3: "c0000000-0000-4000-8000-000000000006",
  legacyNote: "d0000000-0000-4000-8000-000000000001", preEntryShot: "e0000000-0000-4000-8000-000000000001",
  afterCloseShot: "e0000000-0000-4000-8000-000000000002", position: "f0000000-0000-4000-8000-000000000001",
  strategy: "40000000-0000-4000-8000-000000000001", risk: "50000000-0000-4000-8000-000000000001",
};
const THESIS = "London swept the Asian low; waiting for an M5 order block first touch.";
const CAPTURED = "2026-09-01T10:00:00Z";
const plannedTrade: TimelineReviewTrade = {
  id: TL.trade, account_id: plan.account_id, origin: "PLANNED", created_at: "2026-09-01T06:00:00Z", currency: "USD", lifecycle: "CLOSED",
  plan_id: TL.plan, symbol: "EURUSD", direction: "LONG", entry_model: "OB_FIRST_TOUCH", planned_quantity: "0.25", planned_rr: "3",
  entry_price: "1.1", entered_at: "2026-09-01T08:00:00Z", entry_recorded_at: "2026-09-01T08:01:00Z", quantity: "0.25", oversize: false,
  exit_price: "1.106", exited_at: "2026-09-01T09:00:00Z", close_recorded_at: "2026-09-01T09:02:00Z", fees: "0", net_pnl: "150",
  realized_r: "3", outcome: "WIN", pnl_source: "CALCULATED",
};

function plannedInput(changes: Partial<TimelineReviewInput> = {}): TimelineReviewInput {
  return {
    trade: plannedTrade,
    plan: { id: TL.plan, lockedAt: "2026-09-01T07:00:00Z", tradingDay: "2026-09-01", proposal: { ...plan.proposal, narrative: THESIS }, nominalRisk: "50", riskResult: plan.risk_result },
    strategy: { id: TL.strategy, version: "ICT V1.0", rules: { minimum_rr: "3" } },
    riskVersion: {
      id: TL.risk, version: "Risk Plan V1.0", effective_day: "2026-01-01", max_risk_percent: "0.5", default_risk_percent: null, max_daily_trades: 2,
      min_rr: "3", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: "200",
    },
    revisions: [
      { proposalId: TL.revision1, revision: 1, createdAt: "2026-09-01T06:00:00Z", proposal: { ...plan.proposal, narrative: "First idea", riskPercent: "1" } },
      { proposalId: TL.revision2, revision: 2, createdAt: "2026-09-01T06:30:00Z", proposal: { ...plan.proposal, narrative: THESIS } },
    ],
    riskChecks: [
      { id: TL.check1, proposalId: TL.revision1, recordedAt: "2026-09-01T06:00:01Z", result: plan.risk_result, checks: 3 },
      { id: TL.check2, proposalId: TL.revision2, recordedAt: "2026-09-01T06:30:01Z", result: plan.risk_result, checks: 1 },
    ],
    legacyEvents: [
      { id: TL.legacyNote, eventType: "NOTE_ADDED", payload: { note: "Price is reacting at the order block." }, occurredAt: "2026-09-01T08:10:00Z", recordedAt: "2026-09-01T08:10:00Z" },
    ],
    journal: [
      { id: TL.preEntryNote, kind: "NOTE", body: "Waiting for the M5 shift before entering.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-01T07:30:00Z" },
      { id: TL.stopChange, kind: "STOP_CHANGE", body: null, details: { price: "1.0990" }, phase: "LIVE", recordedAt: "2026-09-01T08:30:00Z" },
      { id: TL.lesson, kind: "LESSON", body: "I knew from the start it would reverse.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-01T09:30:00Z" },
    ],
    positionFacts: [],
    riskBasisSource: null,
    tags: { setupGrade: "A", liquidityContext: "ARL_LOW", mssTimeframe: "M5", tags: ["patient"], source: "V2", recordedAt: "2026-09-01T09:45:00Z" },
    evidence: [
      { id: TL.preEntryShot, label: "PRE_ENTRY", timeframe: "M5", storedPhase: "PRE_ENTRY", recordedAt: "2026-09-01T06:45:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 33 },
      { id: TL.afterCloseShot, label: "EXIT", timeframe: null, storedPhase: "POST_TRADE", recordedAt: "2026-09-01T09:10:00Z", sha256: "b".repeat(64), mimeType: "image/png", byteSize: 33 },
    ],
    ...changes,
  };
}

function liveInput(): TimelineReviewInput {
  const liveTrade: TimelineReviewTrade = {
    ...plannedTrade, id: TL.live, origin: "LIVE_FIRST", created_at: "2026-09-02T08:00:00Z", plan_id: null, planned_quantity: null, planned_rr: null,
    entered_at: "2026-09-02T07:55:00Z", entry_recorded_at: "2026-09-02T08:00:00Z", oversize: null, exited_at: "2026-09-02T09:00:00Z",
    close_recorded_at: "2026-09-02T09:01:00Z", net_pnl: "-40", realized_r: "-0.8", outcome: "LOSS",
  };
  return {
    trade: liveTrade, plan: null, strategy: { id: TL.strategy, version: "ICT V1.0", rules: { minimum_rr: "3" } }, riskVersion: null, revisions: [], riskChecks: [], legacyEvents: [],
    journal: [
      { id: TL.liveNote, kind: "DECISION", body: "Holding through the pullback.", details: {}, phase: "LIVE", recordedAt: "2026-09-02T08:20:00Z" },
      { id: TL.lesson, kind: "LESSON", body: "My plan was to fade the high all along.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-02T09:30:00Z" },
    ],
    positionFacts: [
      { id: TL.position, recordedAt: "2026-09-02T08:00:00Z", source: "USER", symbol: "EURUSD", direction: "LONG", entryModel: null, entryPrice: "1.1", enteredAt: "2026-09-02T07:55:00Z", quantity: "0.25", initialStop: "1.098", riskAmount: "50" },
    ],
    riskBasisSource: "USER_REPORTED",
    tags: { setupGrade: null, liquidityContext: null, mssTimeframe: null, tags: [], source: null, recordedAt: null },
    evidence: [{ id: TL.preEntryShot, label: "ENTRY", timeframe: "M5", storedPhase: "LIVE", recordedAt: "2026-09-02T08:02:00Z", sha256: "c".repeat(64), mimeType: "image/png", byteSize: 33 }],
  };
}

const twoCharts = [{ sourceId: `evidence:${TL.preEntryShot}`, role: "M5", dataUrl: CHART }, { sourceId: `evidence:${TL.afterCloseShot}`, role: "EXIT", dataUrl: CHART }];
const stopChanges = [
  { id: TL.stopChange, kind: "STOP_CHANGE" as const, body: null, details: { price: "1.0990" }, phase: "LIVE" as const, recordedAt: "2026-09-01T08:20:00Z" },
  { id: TL.stop2, kind: "STOP_CHANGE" as const, body: null, details: { price: "1.0995" }, phase: "LIVE" as const, recordedAt: "2026-09-01T08:30:00Z" },
  { id: TL.stop3, kind: "TARGET_CHANGE" as const, body: null, details: { price: "1.1050" }, phase: "LIVE" as const, recordedAt: "2026-09-01T08:40:00Z" },
];

interface OperationCase {
  label: string;
  operation: string;
  context: () => unknown;
  images?: AiProviderRequest["images"];
  validate: (output: unknown, context: unknown) => unknown;
  assessments?: Record<string, string>;
}

const timelineValidate = (output: unknown, context: unknown) => validateTradeTimelineReview(output, context);
const CASES: OperationCase[] = [
  { label: "ANALYZE_SETUP · no screenshot", operation: "ANALYZE_SETUP", context: () => analyzeSetupContext(biasSource, []),
    validate: (o, c) => validateAnalyzeSetup(o, operationAllowedSources("ANALYZE_SETUP", c), hasEvidence(c)) },
  { label: "ANALYZE_SETUP · one screenshot", operation: "ANALYZE_SETUP", context: () => analyzeSetupContext(biasSource, EVIDENCE),
    images: [{ sourceId: `evidence:${EVIDENCE[0].id}`, role: "M5", dataUrl: CHART }],
    validate: (o, c) => validateAnalyzeSetup(o, operationAllowedSources("ANALYZE_SETUP", c), hasEvidence(c)) },
  { label: "CHALLENGE_BIAS · no screenshot", operation: "CHALLENGE_BIAS", context: () => biasChallengeContext(biasSource, []),
    validate: (o, c) => validateBiasChallenge(o, operationAllowedSources("CHALLENGE_BIAS", c)) },
  { label: "CHALLENGE_BIAS · one screenshot", operation: "CHALLENGE_BIAS", context: () => biasChallengeContext(biasSource, EVIDENCE),
    images: [{ sourceId: `evidence:${EVIDENCE[0].id}`, role: "M5", dataUrl: CHART }],
    validate: (o, c) => validateBiasChallenge(o, operationAllowedSources("CHALLENGE_BIAS", c)) },
  { label: "REVIEW_TRADE (V1) · no screenshot", operation: "REVIEW_TRADE", context: () => tradeReviewContext(plan, trade, strategy, risk, events, []),
    validate: (o, c) => validateTradeReview(o, sourceRefsOf(c)) },
  { label: "REVIEW_TRADE (V1) · one screenshot", operation: "REVIEW_TRADE", context: () => tradeReviewContext(plan, trade, strategy, risk, events, EVIDENCE),
    images: [{ sourceId: `evidence:${EVIDENCE[0].id}`, role: "M5", dataUrl: CHART }], validate: (o, c) => validateTradeReview(o, sourceRefsOf(c)) },
  { label: "WEEKLY_REVIEW", operation: "WEEKLY_REVIEW", context: () => weeklyFacts,
    validate: (o, c) => validateWeeklyReview(o, operationAllowedSources("WEEKLY_REVIEW", c)) },
  { label: "RECENT_TRADES_ANALYSIS · 1 of 20", operation: "RECENT_TRADES_ANALYSIS", context: () => recent.facts,
    validate: (o, c) => validateRecentTrades(o, operationAllowedSources("RECENT_TRADES_ANALYSIS", c)) },
  { label: "RECENT_TRADES_ANALYSIS · 12 of 30", operation: "RECENT_TRADES_ANALYSIS", context: () => recentTradesContext(recent.ids.account, 30, recent.makeSources(12), recent.capturedAt),
    validate: (o, c) => validateRecentTrades(o, operationAllowedSources("RECENT_TRADES_ANALYSIS", c)) },
  { label: "MONTHLY_REVIEW · detailed", operation: "MONTHLY_REVIEW", context: () => monthly.facts,
    validate: (o, c) => validateMonthlyReview(o, operationAllowedSources("MONTHLY_REVIEW", c)) },
  { label: "MONTHLY_REVIEW · deterministic summary (31 trades)", operation: "MONTHLY_REVIEW",
    context: () => monthlyReviewContext(monthly.ids.account, monthly.month, monthly.monthSources(31), "2026-09-23T12:00:00Z"),
    validate: (o, c) => validateMonthlyReview(o, operationAllowedSources("MONTHLY_REVIEW", c)) },
  { label: "REVIEW_TRADE_TIMELINE · planned, thesis revised before entry", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(plannedInput(), CAPTURED), images: twoCharts, validate: timelineValidate,
    assessments: { thesisCheck: "CHANGED", executionVsPlan: "ALIGNED", liveManagement: "DISCIPLINED" } },
  { label: "REVIEW_TRADE_TIMELINE · planned, consistent thesis", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(plannedInput({ revisions: plannedInput().revisions.slice(1), riskChecks: plannedInput().riskChecks.slice(1) }), CAPTURED),
    validate: timelineValidate, assessments: { thesisCheck: "CONSISTENT", executionVsPlan: "ALIGNED" } },
  { label: "REVIEW_TRADE_TIMELINE · planned, oversized fill and reactive management", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, oversize: true, quantity: "0.5" }, journal: stopChanges }), CAPTURED),
    validate: timelineValidate, assessments: { executionVsPlan: "DEVIATION", liveManagement: "REACTIVE" } },
  { label: "REVIEW_TRADE_TIMELINE · planned, undersized fill", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, quantity: "0.10" } }), CAPTURED),
    validate: timelineValidate, assessments: { executionVsPlan: "DEVIATION" } },
  { label: "REVIEW_TRADE_TIMELINE · locked plan without thesis", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(plannedInput({
      plan: { ...(plannedInput().plan as NonNullable<TimelineReviewInput["plan"]>), proposal: { ...plan.proposal, narrative: "" } }, revisions: [], riskChecks: [], journal: [], legacyEvents: [],
    }), CAPTURED),
    validate: timelineValidate, assessments: { thesisCheck: "NOT_RECORDED", executionVsPlan: "ALIGNED", liveManagement: "NO_LIVE_RECORDS" } },
  { label: "REVIEW_TRADE_TIMELINE · live-first, no plan recorded", operation: "REVIEW_TRADE_TIMELINE",
    context: () => tradeTimelineReviewContext(liveInput(), CAPTURED), images: [{ sourceId: `evidence:${TL.preEntryShot}`, role: "M5", dataUrl: CHART }],
    validate: timelineValidate, assessments: { thesisCheck: "NOT_RECORDED", executionVsPlan: "NO_PLAN", liveManagement: "DISCIPLINED" } },
];

/** Legacy setup evaluator (SETUP_V2): the provider context is the run context plus the pass id, role and manifest. */
const SETUP_CONTEXT = {
  inputHash: chartContext.inputHash, direction: chartContext.direction, setupModel: chartContext.setupModel, strategyVersionId: chartContext.strategyVersionId,
  riskPlanVersionId: chartContext.riskPlanVersionId, instrument: chartContext.instrument, sources: chartContext.sources, ruleIds: chartContext.ruleIds,
  blockingRuleIds: chartContext.blockingRuleIds, proposalId: plan.id, oteParametersAvailable: false,
};
const SETUP_MANIFEST = { screenshots: [{ id: "chart", role: "M5" }] };
const SETUP_OPERATIONS = (["A", "B", "RECONCILER"] as const).map(stage => setupOperation(stage).id);

interface SetupInputs {
  manifest: { screenshots: { id: string; role: string }[] };
  images: AiProviderRequest["images"];
}
const SETUP_INPUTS: SetupInputs = { manifest: SETUP_MANIFEST, images: [{ sourceId: "chart", role: "M5", dataUrl: CHART }] };

/** The legacy evaluator exactly as src/lib/setup-analysis.ts drives it, with the mock as the provider transport. */
async function runSetup(mode: "NORMAL" | "DEEP", context: typeof SETUP_CONTEXT, scenarios: string | null = null, inputs: SetupInputs = SETUP_INPUTS) {
  const { mockFetch, lines } = harness(scenarios);
  const passes: PassRecord[] = [];
  const used: string[] = [];
  const config = modelConfig({});
  const run = runEvaluation({
    mode, model: config.model, context,
    call: (role, id, prior) => {
      used.push(setupOperation(role).id);
      return callResponses({ apiKey: MOCK_KEY, config, context: { ...context, analysisId: id, role, manifest: inputs.manifest }, images: inputs.images, prior },
        mockFetch, undefined, setupOperation(role));
    },
    savePass: async record => {
      passes.push(record);
    },
  });
  return { run, passes, used, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// Every operation: generated output → provider.ts → JSON Schema + zod + the real server-side validator
// ---------------------------------------------------------------------------------------------------------------

describe("every AI operation is served end to end by the mock", () => {
  it("covers every registered operation", () => {
    expect([...new Set([...CASES.map(c => c.operation), ...SETUP_OPERATIONS])].sort()).toEqual(Object.keys(AI_OPERATIONS).sort());
  });

  it.each(CASES.map(c => [c.label, c] as const))("%s: provider.ts accepts the response and the server validator accepts the output", async (_label, testCase) => {
    const operation = operationFor(testCase.operation);
    const context = testCase.context();
    const { mockFetch, lines, originalFetch } = harness();
    const result = await callResponses(providerRequest(operation, context, testCase.images), mockFetch, undefined, operation);
    const contract = operationContract(operation, context);
    expect(ajvErrors(contract.schema, result.output)).toEqual([]);
    expect(schemaErrors(result.output, contract.schema)).toEqual([]);
    expect(() => testCase.validate(result.output, context)).not.toThrow();
    for (const [section, assessment] of Object.entries(testCase.assessments ?? {})) {
      expect((result.output as Record<string, { assessment: string }>)[section].assessment).toBe(assessment);
    }
    expect(strings(result.output).filter(text => DIRECTIVE.test(text) || SIGNAL.test(text))).toEqual([]);
    // Usage settles with the reviewed pricing profile and stays inside the operation envelope.
    expect(result.model).toBe(operation.model);
    expect(result.responseId).toBe("resp_mock_1");
    expect(acceptsResponseModel(operationPricing(operation), result.model)).toBe(true);
    const priced = priceUsage(result.usage, operationPricing(operation));
    expect(priced.inputTokens).toBeGreaterThan(500);
    expect(priced.inputTokens).toBeLessThanOrEqual(operation.maxInputTokens);
    expect(priced.outputTokens).toBeGreaterThan(50);
    expect(priced.outputTokens).toBeLessThanOrEqual(operation.maxOutputTokens);
    expect(priced.chargedMicros).toBeLessThanOrEqual(reservationMicros(operationPricing(operation), operation));
    // One log line per call, without keys or payload content.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^2026-09-23T12:00:00\\.000Z POST /v1/responses/input_tokens schema=${contract.name} model=${operation.model} bytes=\\d+ scenario=ok status=200$`));
    expect(lines[1]).toMatch(new RegExp(`^2026-09-23T12:00:00\\.000Z POST /v1/responses schema=${contract.name} model=${operation.model} bytes=\\d+ scenario=ok status=200$`));
    expect(lines.join("\n")).not.toMatch(/sk-local-mock|Bearer|London|Waited|thesis/i);
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it("runs the legacy setup evaluator DEEP (A → B → RECONCILER) through runEvaluation and validateChartEvaluation", async () => {
    const { run, passes, used, lines } = await runSetup("DEEP", SETUP_CONTEXT);
    const result = await run;
    expect(used).toEqual(SETUP_OPERATIONS);
    expect(passes.map(pass => [pass.stage, pass.status, pass.error_code])).toEqual([["A", "VALID", null], ["B", "VALID", null], ["RECONCILER", "VALID", null]]);
    expect(result).toMatchObject({ decision: "CONDITIONAL", setup_grade: "UNRATED", assessment: { evaluator_role: "RECONCILER", qualitative_decision: "CONDITIONAL" } });
    const reconciler = passes[2].output as { assessment: { reconciliation: { reviewed_analysis_ids: string[]; accepted_finding_ids: string[] } } };
    expect(reconciler.assessment.reconciliation.reviewed_analysis_ids).toEqual(passes.slice(0, 2).map(pass => pass.id));
    expect(reconciler.assessment.reconciliation.accepted_finding_ids).toHaveLength(4);
    for (const pass of passes) {
      expect(ajvErrors(operationContract(operationFor("SETUP_ANALYSIS")).schema, pass.output)).toEqual([]);
      priceUsage(pass.usage, operationPricing(operationFor("SETUP_ANALYSIS")));
    }
    expect(lines.filter(line => line.includes("schema=ict_setup_v2"))).toHaveLength(6);
  });

  it("keeps setup decisions consistent without charts (INSUFFICIENT_EVIDENCE) and for OTE with parameters", async () => {
    const noCharts = await runSetup("NORMAL", { ...SETUP_CONTEXT, sources: { narrative: "USER_REPORT" } });
    expect(await noCharts.run).toMatchObject({ decision: "INSUFFICIENT_EVIDENCE", assessment: { qualitative_decision: "CONDITIONAL" } });
    const ote = await runSetup("NORMAL", { ...SETUP_CONTEXT, setupModel: "OTE", oteParametersAvailable: true });
    expect(await ote.run).toMatchObject({ decision: "CONDITIONAL", assessment: { setup_model: "OTE", ote: { versioned_parameters_available: "YES" } } });
    // The same pass validates against the stand-alone validator too.
    const output = (ote.passes[0].output ?? null) as unknown;
    expect(() => validateChartEvaluation(output, { ...SETUP_CONTEXT, setupModel: "OTE", oteParametersAvailable: true, analysisId: ote.passes[0].id, role: "A", priorAnalysisIds: [], priorFindingIds: [] })).not.toThrow();
  });

  it("serves the legacy evaluator with several charts (DAILY, H4, M5) and a user report in DEEP mode", async () => {
    // Shaped like src/lib/setup-analysis.ts: screenshot ids as sources plus "user-report", roles from SCREENSHOT_ROLES.
    const charts = ["DAILY", "H4", "M5"].map((role, index) => ({ id: `5a000000-0000-4000-8000-00000000000${index + 1}`, role }));
    const context = { ...SETUP_CONTEXT, sources: { "user-report": "USER_REPORT" as const, ...Object.fromEntries(charts.map(chart => [chart.id, "CHART_IMAGE" as const])) } };
    const images = charts.map(chart => ({ sourceId: chart.id, role: chart.role, dataUrl: CHART }));
    const { run, passes } = await runSetup("DEEP", context, null, { manifest: { screenshots: charts }, images });
    const result = await run;
    expect(passes.map(pass => [pass.stage, pass.status])).toEqual([["A", "VALID"], ["B", "VALID"], ["RECONCILER", "VALID"]]);
    const observed = result.assessment.observed_evidence;
    expect(observed.map(item => item.source_id)).toEqual(charts.map(chart => chart.id));
    expect(result.assessment.user_reported_evidence.map(item => item.source_id)).toEqual(["user-report"]);
    // The structure shift is read from the M5 chart; the daily and H4 charts fill the higher-timeframe context.
    const [daily, h4, m5] = observed.map(item => item.id);
    expect(result.assessment).toMatchObject({
      mss_timeframe: "M5", qualitative_decision: "CONDITIONAL", mss: { evidence_ids: [m5] }, order_block: { timeframe: "M5" },
      htf_context: { daily: { status: "AMBIGUOUS", evidence_ids: [daily] }, h4: { status: "AMBIGUOUS", evidence_ids: [h4] }, h1: { status: "NOT_ASSESSED", rationale: "No H1 screenshot is supplied." } },
      missing_evidence: [{ code: "MISSING_TIMEFRAME", description: expect.stringMatching(/^No H1 screenshot is supplied, so the higher-timeframe context rests on the daily and H4 screenshots alone\.$/) }],
    });
    expect(result.chart_details.mss.timeframe).toBe("M5");
    expect(strings(result).filter(text => /No daily screenshot|No H4 screenshot|No higher-timeframe screenshot/.test(text))).toEqual([]);
  });

  it("keeps the legacy evaluator's text consistent with every combination of supplied screenshot roles", async () => {
    const ROLES = ["DAILY", "H4", "H1", "M5", "M15", "OTHER"] as const;
    const HTF: Array<[key: "daily" | "h4" | "h1", role: string, name: string]> = [["daily", "DAILY", "daily"], ["h4", "H4", "H4"], ["h1", "H1", "H1"]];
    for (let mask = 1; mask < 1 << ROLES.length; mask++) {
      const roles = ROLES.filter((_, index) => (mask >> index) & 1);
      const charts = roles.map((role, index) => ({ id: `5b000000-0000-4000-8000-${String(mask * 10 + index).padStart(12, "0")}`, role }));
      const context = { ...SETUP_CONTEXT, sources: Object.fromEntries(charts.map(chart => [chart.id, "CHART_IMAGE" as const])) };
      const images = charts.map(chart => ({ sourceId: chart.id, role: chart.role, dataUrl: CHART }));
      const { run, passes } = await runSetup("NORMAL", context, null, { manifest: { screenshots: charts }, images });
      const result = await run;
      const label = roles.join("+");
      expect(passes.map(pass => pass.status), label).toEqual(["VALID"]);
      const observation = (role: string) => result.assessment.observed_evidence.find(item => item.source_id === charts.find(chart => chart.role === role)?.id)?.id;
      const texts = strings(result);
      for (const [key, role, name] of HTF) {
        const slot = (result.assessment.htf_context as Record<string, { status: string; evidence_ids: string[]; rationale: string }>)[key];
        if (roles.includes(role as (typeof ROLES)[number])) {
          expect(slot, `${label} ${key}`).toMatchObject({ status: "AMBIGUOUS", evidence_ids: [observation(role)] });
          expect(texts.filter(text => text.includes(`No ${name} screenshot`)), label).toEqual([]);
        } else {
          expect(slot, `${label} ${key}`).toMatchObject({ status: "NOT_ASSESSED", evidence_ids: [], rationale: `No ${name} screenshot is supplied.` });
        }
      }
      if (roles.some(role => ["DAILY", "H4", "H1"].includes(role))) expect(texts.filter(text => text.includes("No higher-timeframe screenshot")), label).toEqual([]);
      // Structure shift: the M5 chart first, then another intraday chart, then an unlabelled one; never a higher timeframe.
      const setupRole = ["M5", "M15", "OTHER"].find(role => roles.includes(role as (typeof ROLES)[number]));
      expect(result.assessment.mss_timeframe, label).toBe(setupRole === "M5" || setupRole === "M15" ? setupRole : "UNKNOWN");
      expect(result.assessment.mss.evidence_ids, label).toEqual(setupRole ? [observation(setupRole)] : []);
      expect(result.decision, label).toBe(setupRole ? "CONDITIONAL" : "INSUFFICIENT_EVIDENCE");
      if (!setupRole) expect(result.assessment.missing_evidence[0], label).toMatchObject({ code: "MISSING_TIMEFRAME", material_to_decision: true, description: expect.stringContaining("No setup-timeframe (M5) screenshot") });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Edge-case contexts beyond the fixtures
// ---------------------------------------------------------------------------------------------------------------

const PLANNED_JOURNAL: TimelineReviewInput["journal"] = [
  { id: "c1000000-0000-4000-8000-000000000001", kind: "NOTE", body: "Waiting for the M5 shift before entering.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-01T07:30:00Z" },
  // Stored as pre-entry but recorded after the reported entry time: WHILE_LIVE with RECORDED_AFTER_EXECUTION_BEGAN.
  { id: "c1000000-0000-4000-8000-000000000002", kind: "NOTE", body: "Entry reason written right after the fill.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-01T08:00:30Z" },
  { id: "c1000000-0000-4000-8000-000000000003", kind: "DECISION", body: "Holding through the pullback.", details: {}, phase: "LIVE", recordedAt: "2026-09-01T08:20:00Z" },
  { id: "c1000000-0000-4000-8000-000000000004", kind: "STOP_CHANGE", body: null, details: { price: "1.0990" }, phase: "LIVE", recordedAt: "2026-09-01T08:30:00Z" },
  { id: "c1000000-0000-4000-8000-000000000005", kind: "TARGET_CHANGE", body: "Target moved to the nearer high.", details: { price: "1.1050" }, phase: "LIVE", recordedAt: "2026-09-01T08:35:00Z" },
  { id: "c1000000-0000-4000-8000-000000000006", kind: "PARTIAL_CLOSE", body: null, details: { quantity: "0.1" }, phase: "LIVE", recordedAt: "2026-09-01T08:40:00Z" },
  { id: "c1000000-0000-4000-8000-000000000007", kind: "LESSON", body: "I knew from the start it would reverse.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-01T09:30:00Z" },
  { id: "c1000000-0000-4000-8000-000000000008", kind: "NOTE", body: "The exit came at the planned target.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-01T09:40:00Z" },
];
const PLANNED_EVIDENCE: TimelineReviewInput["evidence"] = [
  { id: "e1000000-0000-4000-8000-000000000001", label: "PRE_ENTRY", timeframe: "M5", storedPhase: "PRE_ENTRY", recordedAt: "2026-09-01T06:45:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 33 },
  // Legacy screenshot without a stored phase: classified from its upload time (before entry).
  { id: "e1000000-0000-4000-8000-000000000002", label: "HTF", timeframe: "H4", storedPhase: null, recordedAt: "2026-09-01T06:50:00Z", sha256: "b".repeat(64), mimeType: "image/png", byteSize: 33 },
  { id: "e1000000-0000-4000-8000-000000000003", label: "ENTRY", timeframe: "M5", storedPhase: "LIVE", recordedAt: "2026-09-01T08:05:00Z", sha256: "c".repeat(64), mimeType: "image/png", byteSize: 33 },
  { id: "e1000000-0000-4000-8000-000000000004", label: "EXIT", timeframe: null, storedPhase: "POST_TRADE", recordedAt: "2026-09-01T09:10:00Z", sha256: "d".repeat(64), mimeType: "image/png", byteSize: 33 },
];
const PLANNED_EVENTS: TimelineReviewInput["legacyEvents"] = [
  { id: "d1000000-0000-4000-8000-000000000001", eventType: "NOTE_ADDED", payload: { note: "Price is reacting at the order block." }, occurredAt: "2026-09-01T08:10:00Z", recordedAt: "2026-09-01T08:10:00Z" },
  { id: "d1000000-0000-4000-8000-000000000002", eventType: "STOP_MOVED", payload: { stop: "1.0992" }, occurredAt: "2026-09-01T08:15:00Z", recordedAt: "2026-09-01T08:15:00Z" },
  { id: "d1000000-0000-4000-8000-000000000003", eventType: "PARTIAL_CLOSED", payload: { quantity: "0.1", price: "1.1030" }, occurredAt: "2026-09-01T08:45:00Z", recordedAt: "2026-09-01T08:45:00Z" },
];
const LIVE_JOURNAL: TimelineReviewInput["journal"] = [
  { id: "c2000000-0000-4000-8000-000000000001", kind: "NOTE", body: "Logged the position a few minutes after the fill.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-02T08:05:00Z" },
  { id: "c2000000-0000-4000-8000-000000000002", kind: "DECISION", body: "Holding through the pullback.", details: {}, phase: "LIVE", recordedAt: "2026-09-02T08:20:00Z" },
  { id: "c2000000-0000-4000-8000-000000000003", kind: "STOP_CHANGE", body: null, details: { price: "1.0985" }, phase: "LIVE", recordedAt: "2026-09-02T08:25:00Z" },
  { id: "c2000000-0000-4000-8000-000000000004", kind: "TARGET_CHANGE", body: null, details: { price: "1.1040" }, phase: "LIVE", recordedAt: "2026-09-02T08:30:00Z" },
  { id: "c2000000-0000-4000-8000-000000000005", kind: "PARTIAL_CLOSE", body: "Partial at the first target.", details: { quantity: "0.1" }, phase: "LIVE", recordedAt: "2026-09-02T08:40:00Z" },
  { id: "c2000000-0000-4000-8000-000000000006", kind: "LESSON", body: "My plan was to fade the high all along.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-02T09:30:00Z" },
];
const LIVE_EVIDENCE: TimelineReviewInput["evidence"] = [
  { id: "e2000000-0000-4000-8000-000000000001", label: "ENTRY", timeframe: "M5", storedPhase: "LIVE", recordedAt: "2026-09-02T08:02:00Z", sha256: "e".repeat(64), mimeType: "image/png", byteSize: 33 },
  { id: "e2000000-0000-4000-8000-000000000002", label: "MANAGEMENT", timeframe: "M15", storedPhase: "LIVE", recordedAt: "2026-09-02T08:31:00Z", sha256: "f".repeat(64), mimeType: "image/png", byteSize: 33 },
  { id: "e2000000-0000-4000-8000-000000000003", label: "EXIT", timeframe: null, storedPhase: "POST_TRADE", recordedAt: "2026-09-02T09:05:00Z", sha256: "0".repeat(64), mimeType: "image/png", byteSize: 33 },
];

/** Deterministic subset of a pool: item i is kept when bit i of `mask` is set. */
const subset = <T>(pool: readonly T[], mask: number): T[] => pool.filter((_, index) => (mask >> index) & 1);

/**
 * Timeline review inputs across the dimensions the generator's post-processing depends on: planned or live-first,
 * thesis recorded or not, draft revisions (none, identical, changed, without thesis), oversized fill, entry-price
 * deviation, journal/legacy records in every timing band (incl. flagged ones) and up to four screenshots per band.
 */
function timelineVariants(count: number): Array<{ label: string; input: TimelineReviewInput }> {
  const variants: Array<{ label: string; input: TimelineReviewInput }> = [];
  for (let k = 0; k < count; k++) {
    const mask = (k * 2654435761) >>> 0;
    if (k % 3 === 2) {
      const base = liveInput();
      variants.push({
        label: `live-first #${k}`,
        input: { ...base, journal: subset(LIVE_JOURNAL, mask >>> 3), evidence: subset(LIVE_EVIDENCE, mask >>> 11), riskBasisSource: k % 2 ? "USER_REPORTED" : "DERIVED" },
      });
      continue;
    }
    const thesis = k % 6 === 5 ? "" : THESIS;
    const lockedPlan = plannedInput().plan as NonNullable<TimelineReviewInput["plan"]>;
    const revisionShapes = [[], [thesis], ["An earlier idea about the Asian high.", thesis], [null, thesis]][k % 4];
    const revisions = revisionShapes.map((narrative, index) => ({
      proposalId: `b2000000-0000-4000-8000-00000000000${index + 1}`, revision: index + 1, createdAt: `2026-09-01T06:${String(10 + index * 20)}:00Z`,
      proposal: narrative === null ? null : { ...plan.proposal, narrative },
    }));
    const evidence = subset(PLANNED_EVIDENCE, mask >>> 7);
    const size = k % 5 === 1 ? { oversize: true, quantity: "0.5" } : k % 5 === 3 ? { quantity: "0.10" } : {};
    const trade = { ...plannedTrade, ...size, ...(k % 7 === 3 ? { entry_price: "1.1030" } : {}) };
    variants.push({
      label: `planned #${k}${thesis ? "" : " (no thesis)"}`,
      input: plannedInput({
        trade, plan: { ...lockedPlan, proposal: { ...plan.proposal, narrative: thesis } }, revisions,
        riskChecks: revisions.length ? [{ id: "b3000000-0000-4000-8000-000000000001", proposalId: revisions[revisions.length - 1].proposalId, recordedAt: "2026-09-01T06:55:00Z", result: plan.risk_result, checks: 1 }] : [],
        journal: subset(PLANNED_JOURNAL, mask >>> 2), legacyEvents: subset(PLANNED_EVENTS, mask >>> 13), evidence,
      }),
    });
  }
  return variants;
}

describe("edge-case contexts", () => {
  it("timeline reviews pass the real validator (hindsight guard, no-plan rules) across 36 record combinations", async () => {
    const operation = operationFor("REVIEW_TRADE_TIMELINE");
    const seen = { thesis: new Set<string>(), execution: new Set<string>(), management: new Set<string>(), afterClose: 0, flagged: 0 };
    for (const { label, input } of timelineVariants(36)) {
      const context = tradeTimelineReviewContext(input, CAPTURED);
      const images = context.evidence.map(item => ({ sourceId: `evidence:${item.id}`, role: item.timeframe ?? item.label, dataUrl: CHART }));
      const { mockFetch } = harness();
      const result = await callResponses(providerRequest(operation, context, images), mockFetch, undefined, operation);
      const review = validateTradeTimelineReview(result.output, context);
      const timings = new Map(context.sourceManifest.sources.map(source => [source.id, source.timing]));
      expect(review.thesisCheck.sourceRefs.filter(ref => timings.get(ref) === "AFTER_CLOSE" || timings.get(ref) === "WHILE_LIVE"), label).toEqual([]);
      if (context.planStatus === "NO_PLAN_RECORDED") {
        expect([review.thesisCheck.assessment, review.executionVsPlan.assessment], label).toEqual(["NOT_RECORDED", "NO_PLAN"]);
      } else {
        expect(review.executionVsPlan.assessment, label).not.toBe("NO_PLAN");
        expect(review.thesisCheck.assessment === "NOT_RECORDED", label).toBe(context.plan?.thesis == null);
        const departs = input.trade.oversize === true || input.trade.entry_price !== plannedTrade.entry_price || input.trade.quantity !== plannedTrade.planned_quantity;
        expect(review.executionVsPlan.assessment, label).toBe(departs ? "DEVIATION" : "ALIGNED");
        expect(review.headline.text, label).toContain(departs ? "departed from the locked plan" : "followed the locked plan");
      }
      seen.thesis.add(review.thesisCheck.assessment);
      seen.execution.add(review.executionVsPlan.assessment);
      seen.management.add(review.liveManagement.assessment);
      if ([...timings.values()].includes("AFTER_CLOSE")) seen.afterClose++;
      if (context.timeline.some(item => item.flags.length)) seen.flagged++;
    }
    expect([...seen.thesis].sort()).toEqual(["CHANGED", "CONSISTENT", "NOT_RECORDED"]);
    expect([...seen.execution].sort()).toEqual(["ALIGNED", "DEVIATION", "NO_PLAN"]);
    expect([...seen.management].sort()).toEqual(["DISCIPLINED", "NO_LIVE_RECORDS", "REACTIVE"]);
    expect(seen.afterClose).toBeGreaterThan(10);
    expect(seen.flagged).toBeGreaterThan(5);
  });

  it("Review Trade V1 and the timeline review read the same execution records the same way", async () => {
    const SHAPES: Array<[label: string, change: { entry_price?: string; quantity?: string; oversize?: boolean }, assessment: string, phrase: RegExp]> = [
      ["as planned", {}, "ALIGNED", /^The recorded entry and size match the locked plan\./],
      ["undersized fill", { quantity: "0.10" }, "DEVIATION",
        /^The recorded fill size \(0\.10\) is below the planned quantity \(0\.25\), so the position differed from the locked plan even though the entry followed it\.$/],
      ["oversized fill", { quantity: "0.5", oversize: true }, "DEVIATION", /^The recorded fill size \(0\.5\) is above the planned quantity \(0\.25\), so the position differed/],
      ["other entry price", { entry_price: "1.1030" }, "DEVIATION", /^The recorded entry price \(1\.1030\) differs from the planned entry \([\d.]+\); the values are quoted/],
      ["other entry price and undersized fill", { entry_price: "1.1030", quantity: "0.10" }, "DEVIATION",
        /^The recorded entry price \(1\.1030\) differs from the planned entry \([\d.]+\), and the recorded fill size \(0\.10\) is below the planned quantity \(0\.25\);/],
    ];
    const v1 = operationFor("REVIEW_TRADE");
    const timeline = operationFor("REVIEW_TRADE_TIMELINE");
    for (const [label, change, assessment, phrase] of SHAPES) {
      const { oversize: _oversize, ...fill } = change;
      const v1Context = tradeReviewContext(plan, { ...trade, ...fill }, strategy, risk, events, []);
      const v1Result = await callResponses(providerRequest(v1, v1Context), harness().mockFetch, undefined, v1);
      const v1Review = validateTradeReview(v1Result.output, sourceRefsOf(v1Context));
      const timelineContext = tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, ...change } }), CAPTURED);
      const timelineResult = await callResponses(providerRequest(timeline, timelineContext), harness().mockFetch, undefined, timeline);
      const review = validateTradeTimelineReview(timelineResult.output, timelineContext);
      expect([v1Review.planAdherence.assessment, v1Review.deviations.assessment, review.executionVsPlan.assessment], label).toEqual([assessment, assessment, assessment]);
      expect(review.executionVsPlan.text, label).toMatch(phrase);
      expect(v1Review.planAdherence.interpretation, label).toMatch(phrase);
      expect(review.headline.text, label).toContain(assessment === "ALIGNED" ? "followed the locked plan" : "departed from the locked plan");
    }
  });

  it("cites from anyOf enum branches (more than 250 canonical ids), and the honest count refuses that oversized request", async () => {
    const event = (trade: number, index: number, at: string) => ({
      id: `61000000-0000-4000-8${String(index).padStart(3, "0")}-${String(trade + 1).padStart(12, "0")}`, event_type: index % 3 ? "NOTE_ADDED" : "STOP_MOVED",
      payload: { note: "Short note.", stop: "1.0985" }, occurred_at: at, recorded_at: at,
    });
    const sources = recent.makeSources(30).map((source, trade) => ({ ...source, events: Array.from({ length: 10 }, (_, index) => event(trade, index, source.trade.exited_at as string)) }));
    const context = recentTradesContext(recent.ids.account, 30, sources, recent.capturedAt);
    const operation = operationFor("RECENT_TRADES_ANALYSIS");
    const contract = operationContract(operation, context);
    const allowed = operationAllowedSources("RECENT_TRADES_ANALYSIS", context);
    expect(allowed.length).toBeGreaterThan(250);
    expect((contract.schema as { $defs: { canonicalCitation: { anyOf?: unknown[] } } }).$defs.canonicalCitation.anyOf).toHaveLength(2);
    const output = generateOutput({ name: contract.name, schema: contract.schema, context, seed: "anyOf" });
    expect(ajvErrors(contract.schema, output)).toEqual([]);
    expect(() => validateRecentTrades(output, allowed)).not.toThrow();
    // About 70,000 estimated input tokens against the operation's 32,000: refused before any generation call.
    const { mockFetch, lines } = harness();
    await expect(callResponses(providerRequest(operation, context), mockFetch, undefined, operation)).rejects.toMatchObject({ code: "INPUT_LIMIT_EXCEEDED" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("POST /v1/responses/input_tokens schema=recent_trades_v1");
  });

  it("generates valid instances for every JSON Schema keyword the contracts use", () => {
    const schema = {
      type: "object", additionalProperties: false,
      required: ["id", "kind", "fixed", "count", "ratio", "maybe", "label", "code", "tags", "choice", "union", "sourceRefs", "nested"],
      properties: {
        id: { type: "string", format: "uuid" },
        kind: { type: "string", enum: ["A", "B"] },
        fixed: { const: "2.0" },
        count: { type: "integer", minimum: 3, maximum: 9 },
        ratio: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        maybe: { type: ["string", "null"], minLength: 2 },
        label: { type: "string", minLength: 120, maxLength: 140 },
        code: { type: "string", pattern: "^[0-9a-f]{64}$" },
        tags: { type: "array", items: { type: "string", maxLength: 20 }, minItems: 2, maxItems: 3 },
        choice: { oneOf: [{ type: "integer" }, { type: "string", enum: ["x"] }] },
        union: { anyOf: [{ type: "null" }, { $ref: "#/$defs/thing" }] },
        sourceRefs: { type: "array", items: { $ref: "#/$defs/canonicalCitation" }, minItems: 2, maxItems: 4 },
        nested: { $ref: "#/$defs/thing" },
      },
      $defs: {
        thing: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 60 } } },
        canonicalCitation: { anyOf: [{ type: "string", enum: ["sample"] }, { type: "string", enum: ["trade:1", "trade:2"] }] },
      },
    };
    const output = generateOutput({ name: "synthetic_v1", schema, seed: "keywords" }) as { sourceRefs: string[]; union: unknown; label: string };
    expect(ajvErrors(schema, output)).toEqual([]);
    expect(schemaErrors(output, schema)).toEqual([]);
    expect(output.union).toMatchObject({ text: expect.any(String) });
    expect(new Set(output.sourceRefs).size).toBe(output.sourceRefs.length);
    expect(output.sourceRefs.some(id => id.startsWith("trade:"))).toBe(true);
    for (const [min, max] of [[1, 12], [40, 41], [120, 140], [300, 1400]]) {
      const text = fitText("The supplied records describe a small sample. Observations are tentative and nothing beyond them is assumed.", min, max);
      expect(text.length).toBeGreaterThanOrEqual(min);
      expect(text.length).toBeLessThanOrEqual(max);
    }
  });
});

describe("budget settlement through the real request gate", () => {
  it.each(CASES.map(c => [c.label, c] as const))("%s settles a plausible charge inside the reservation", async (_label, testCase) => {
    const operation = operationFor(testCase.operation);
    const book = ledger();
    const { mockFetch } = harness();
    await budgetedAiRequest(providerRequest(operation, testCase.context(), testCase.images), owner(operation), book, mockFetch);
    const record = book.settle.mock.calls[0][2];
    expect(record).toMatchObject({ disposition: "SETTLED", errorCode: null, cachedTokens: 0, reasoningTokens: 0, responseModel: operation.model });
    expect(record.chargedMicros as number).toBeGreaterThan(0);
    expect(record.chargedMicros as number).toBeLessThan(reservationMicros(operationPricing(operation), operation));
  });

  it("settles the legacy setup operation through the gate as well", async () => {
    const operation = operationFor("SETUP_ANALYSIS");
    const book = ledger();
    const { mockFetch } = harness();
    const input = { apiKey: MOCK_KEY, config: modelConfig({}), context: { ...SETUP_CONTEXT, analysisId: "pass-a", role: "A", manifest: SETUP_MANIFEST }, images: [{ sourceId: "chart", role: "M5", dataUrl: CHART }], prior: [] };
    await budgetedAiRequest(input, owner(operation), book, mockFetch);
    expect(book.settle.mock.calls[0][2]).toMatchObject({ disposition: "SETTLED", responseModel: "gpt-6-astra" });
  });

  // What every scenario means for accounting (README table): the usage disposition the gate settles and the error the
  // calling flow receives (null: the call succeeds and the flow's own validator decides). The two count-endpoint
  // scenarios fail before the recheck commits a generation, so the gate releases them unsent (CANCELLED, 0).
  const GATE_OUTCOMES: Record<MockScenarioName, [disposition: "SETTLED" | "UNCERTAIN" | "CANCELLED", thrown: string | null]> = {
    ok: ["SETTLED", null], schema_violation: ["SETTLED", null], foreign_source: ["SETTLED", null], hindsight_citation: ["SETTLED", null],
    trading_directive: ["SETTLED", null], refusal: ["SETTLED", "REFUSED"], incomplete: ["SETTLED", "INCOMPLETE"], invalid_json: ["SETTLED", "INVALID_JSON"],
    http_500: ["UNCERTAIN", "ACCOUNTING_UNCERTAIN"], http_429: ["UNCERTAIN", "ACCOUNTING_UNCERTAIN"], http_401: ["UNCERTAIN", "ACCOUNTING_UNCERTAIN"],
    http_403: ["UNCERTAIN", "ACCOUNTING_UNCERTAIN"], network_error: ["UNCERTAIN", "ACCOUNTING_UNCERTAIN"],
    count_unavailable: ["CANCELLED", "INPUT_COUNT_UNAVAILABLE"], input_limit_exceeded: ["CANCELLED", "INPUT_LIMIT_EXCEEDED"],
  };
  it.each(Object.entries(GATE_OUTCOMES))("scenario %s settles as %j through budgetedAiRequest", async (scenario, [disposition, thrown]) => {
    const operation = operationFor("WEEKLY_REVIEW");
    const book = ledger();
    const outcome = await failure(budgetedAiRequest(providerRequest(operation, weeklyFacts), owner(operation), book, harness(JSON.stringify({ "*": scenario })).mockFetch));
    expect(outcome === null ? null : (outcome as ProviderError).code).toBe(thrown);
    expect(book.settle).toHaveBeenCalledTimes(1);
    const record = book.settle.mock.calls[0][2];
    expect(record.disposition).toBe(disposition);
    if (disposition === "UNCERTAIN") {
      // The whole reservation stays held and the account's AI is paused for an accounting review until resolved.
      expect(record).toMatchObject({ chargedMicros: reservationMicros(operationPricing(operation), operation), errorCode: MOCK_SCENARIOS[scenario as MockScenarioName].providerError });
    } else if (disposition === "CANCELLED") {
      // No generation request was sent: nothing is charged and the hold is released (SQL re-checks it, 0018 Part 4).
      expect(record).toEqual({ disposition: "CANCELLED", chargedMicros: 0, usage: { generation: "NOT_SENT" }, errorCode: MOCK_SCENARIOS[scenario as MockScenarioName].providerError });
      expect(book.recheck).not.toHaveBeenCalled();
    } else {
      expect(record.chargedMicros as number).toBeGreaterThan(0);
      expect(record.chargedMicros as number).toBeLessThan(reservationMicros(operationPricing(operation), operation));
    }
  });

  it("refusals settle their usage; an HTTP 500 keeps the full reservation held as UNCERTAIN", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const refused = ledger();
    const refusal = await failure(budgetedAiRequest(providerRequest(operation, weeklyFacts), owner(operation), refused, harness('{"*":"refusal"}').mockFetch));
    expect(refusal).toMatchObject({ code: "REFUSED" });
    expect(refused.settle.mock.calls[0][2]).toMatchObject({ disposition: "SETTLED", errorCode: "REFUSED" });
    const errored = ledger();
    const serverError = await failure(budgetedAiRequest(providerRequest(operation, weeklyFacts), owner(operation), errored, harness('{"*":"http_500"}').mockFetch));
    expect(serverError).toMatchObject({ code: "ACCOUNTING_UNCERTAIN" });
    expect(errored.settle.mock.calls[0][2]).toMatchObject({ disposition: "UNCERTAIN", errorCode: "MODEL_ERROR", chargedMicros: reservationMicros(operationPricing(operation), operation) });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Failure scenarios
// ---------------------------------------------------------------------------------------------------------------

describe("failure scenarios", () => {
  const PROVIDER_FAILURES: Array<[MockScenarioName, string]> = [
    ["refusal", "REFUSED"], ["incomplete", "INCOMPLETE"], ["http_500", "MODEL_ERROR"], ["http_429", "RATE_LIMIT"], ["http_401", "OPENAI_AUTH"],
    ["http_403", "MODEL_ACCESS"], ["network_error", "TIMEOUT_OR_NETWORK"], ["invalid_json", "INVALID_JSON"],
    ["count_unavailable", "INPUT_COUNT_UNAVAILABLE"], ["input_limit_exceeded", "INPUT_LIMIT_EXCEEDED"],
  ];

  it.each(PROVIDER_FAILURES)("%s maps to ProviderError %s", async (scenario, code) => {
    expect(MOCK_SCENARIOS[scenario].providerError).toBe(code);
    const operation = operationFor("WEEKLY_REVIEW");
    const { mockFetch, lines } = harness(JSON.stringify({ weekly_review_v1: scenario }));
    const error = await failure(callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    const withUsage = ["refusal", "incomplete", "invalid_json"].includes(scenario);
    expect((error as ProviderError).usage === null).toBe(!withUsage);
    if (withUsage) expect(error).toMatchObject({ responseId: "resp_mock_1", model: operation.model, usage: { input_tokens: expect.any(Number) } });
    expect(lines.at(-1)).toContain(`scenario=${scenario}`);
    expect(lines).toHaveLength(MOCK_SCENARIOS[scenario].endpoint === "input_tokens" ? 1 : 2);
  });

  it("covers every scenario in the documentation table", () => {
    const json = ["ok", "schema_violation", "foreign_source", "hindsight_citation", "trading_directive"];
    expect([...PROVIDER_FAILURES.map(([scenario]) => scenario), ...json].sort()).toEqual(Object.keys(MOCK_SCENARIOS).sort());
  });

  const JSON_FAILURES = ["schema_violation", "foreign_source", "hindsight_citation", "trading_directive"] as const;
  it.each(JSON_FAILURES)("%s passes provider.ts and is rejected by the server-side validators", async scenario => {
    for (const testCase of CASES) {
      const operation = operationFor(testCase.operation);
      const context = testCase.context();
      const { mockFetch } = harness(JSON.stringify({ "*": scenario }));
      const result = await callResponses(providerRequest(operation, context, testCase.images), mockFetch, undefined, operation);
      // REVIEW_TRADE (V1) has no directive check in validateTradeReview; that contract is not asserted for this scenario.
      if (scenario === "trading_directive" && operation.id === "REVIEW_TRADE") continue;
      let rejection: unknown = null;
      try {
        testCase.validate(result.output, context);
      } catch (error) {
        rejection = error;
      }
      expect(rejection, `${testCase.label} should reject ${scenario}`).toBeInstanceOf(Error);
      if (operation.id === "REVIEW_TRADE_TIMELINE") {
        const codes = { schema_violation: "INVALID_REVIEW_OUTPUT", foreign_source: "FOREIGN_REVIEW_SOURCE", hindsight_citation: "HINDSIGHT_CITATION", trading_directive: "TRADING_DIRECTIVE" };
        expect(rejection).toBeInstanceOf(TimelineReviewRejection);
        expect(rejection).toMatchObject({ code: codes[scenario] });
      }
    }
  });

  it("an invalid setup output fails the evaluator pass as INVALID_OUTPUT; a refusal as REFUSED", async () => {
    const invalid = await runSetup("NORMAL", SETUP_CONTEXT, '{"ict_setup_v2":"schema_violation"}');
    await expect(invalid.run).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(invalid.passes.map(pass => [pass.status, pass.error_code])).toEqual([["INVALID", "INVALID_OUTPUT"]]);
    const refused = await runSetup("NORMAL", SETUP_CONTEXT, '{"*":"refusal"}');
    await expect(refused.run).rejects.toMatchObject({ code: "REFUSED" });
    expect(refused.passes[0]).toMatchObject({ status: "REFUSED", response_id: "resp_mock_1" });
    for (const scenario of ["foreign_source", "hindsight_citation"]) {
      const foreign = await runSetup("NORMAL", SETUP_CONTEXT, JSON.stringify({ ict_setup_v2: scenario }));
      await expect(foreign.run).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    }
  });

  it("documents the app's own gaps: V1 Review Trade and the legacy evaluator have no trading-directive check", async () => {
    // Recorded so the README's scenario table stays true; the timeline review and every other contract reject it.
    const directive = await runSetup("NORMAL", SETUP_CONTEXT, '{"ict_setup_v2":"trading_directive"}');
    await expect(directive.run).resolves.toMatchObject({ decision: "CONDITIONAL" });
    expect(JSON.stringify(directive.passes[0].output)).toContain("Take the trade at the next touch of the zone.");
    const operation = operationFor("REVIEW_TRADE");
    const context = tradeReviewContext(plan, trade, strategy, risk, events, []);
    const result = await callResponses(providerRequest(operation, context), harness('{"*":"trading_directive"}').mockFetch, undefined, operation);
    expect(validateTradeReview(result.output, sourceRefsOf(context)).planAdherence.interpretation).toBe("Take the trade at the next touch of the zone.");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Scenario file
// ---------------------------------------------------------------------------------------------------------------

describe("scenario file", () => {
  it("parses names, '*', per-entry and top-level delays, and rejects unknown scenarios or fields", () => {
    const config = parseScenarioConfig('{"*":"http_429","weekly_review_v1":{"scenario":"refusal","delayMs":25},"delayMs":5}');
    expect(resolveScenario(config, "weekly_review_v1")).toEqual({ scenario: "refusal", delayMs: 25, matched: "weekly_review_v1" });
    expect(resolveScenario(config, "monthly_review_v1")).toEqual({ scenario: "http_429", delayMs: 5, matched: "*" });
    expect(resolveScenario(parseScenarioConfig(null), "weekly_review_v1")).toEqual({ scenario: "ok", delayMs: 0, matched: null });
    expect(resolveScenario(parseScenarioConfig('{"__proto__":"refusal"}'), "toString")).toMatchObject({ scenario: "ok" });
    for (const text of ["{", "[]", '{"*":"explode"}', '{"*":{"scenario":"ok","extra":1}}', '{"delayMs":-1}', '{"*":3}']) {
      expect(() => parseScenarioConfig(text)).toThrow(ScenarioConfigError);
    }
  });

  it("is re-read on every call, so a changed file applies without a restart", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const { mockFetch, readScenarioText } = harness();
    readScenarioText.mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue('{"weekly_review_v1":"refusal"}');
    await expect(callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation)).resolves.toMatchObject({ responseId: "resp_mock_1" });
    await expect(callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation)).rejects.toMatchObject({ code: "REFUSED" });
    expect(readScenarioText).toHaveBeenCalledTimes(4);
  });

  it("a malformed file answers as a logged refusal (loud, and its usage still settles)", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const { mockFetch, lines } = harness("{not json");
    await expect(callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation)).rejects.toMatchObject({ code: "REFUSED" });
    expect(lines[1]).toMatch(/scenario=refusal status=200 note=invalid-scenario-file/);
  });

  it("delays the generation call only, and an abort during the delay rejects the fetch", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const { mockFetch, sleep } = harness('{"*":{"scenario":"ok","delayMs":25}}');
    await callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(25);
    expect(sleep.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    // Real timer-based sleep (not injected): aborting rejects with the signal's reason, and the call is still logged.
    const lines: string[] = [];
    const real = preload.createMockFetch({ originalFetch: vi.fn<typeof fetch>(), readScenarioText: () => '{"delayMs":60000}', log: line => { lines.push(line); }, now: () => NOW });
    const controller = new AbortController();
    const body = JSON.stringify({ model: operation.model, text: { format: { type: "json_schema", name: "weekly_review_v1", schema: { type: "object" } } } });
    const pending = real("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${MOCK_KEY}` }, body, signal: controller.signal });
    controller.abort(new Error("aborted by test"));
    await expect(pending).rejects.toThrow("aborted by test");
    expect(lines).toEqual([`2026-09-23T12:00:00.000Z POST /v1/responses schema=weekly_review_v1 model=${operation.model} bytes=${Buffer.byteLength(body)} scenario=ok status=aborted note=during-delay-60000ms`]);
  });

  it("logs every call that ends early: a timeout or abort during delayMs, an aborted signal, an unreadable body", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const body = JSON.stringify({ model: operation.model, text: { format: { type: "json_schema", name: "weekly_review_v1", schema: { type: "object" } } } });
    const headers = { Authorization: `Bearer ${MOCK_KEY}` };
    const fields = `schema=weekly_review_v1 model=${operation.model} bytes=${Buffer.byteLength(body)}`;
    const lines: string[] = [];
    const errorName = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as Error).name);
    const delayed = preload.createMockFetch({
      originalFetch: vi.fn<typeof fetch>(), readScenarioText: () => '{"*":{"scenario":"ok","delayMs":60000}}', log: line => { lines.push(line); }, now: () => NOW,
    });
    // The provider's own AbortSignal.timeout firing during the delay (what a delayMs above 180000 produces in the app).
    await expect(errorName(delayed("https://api.openai.com/v1/responses", { method: "POST", headers, body, signal: AbortSignal.timeout(20) }))).resolves.toBe("TimeoutError");
    // An already aborted signal on either endpoint: nothing is answered, and the line still names the schema.
    for (const url of ["https://api.openai.com/v1/responses/input_tokens", "https://api.openai.com/v1/responses"]) {
      await expect(errorName(delayed(url, { method: "POST", headers, body, signal: AbortSignal.abort() }))).resolves.toBe("AbortError");
    }
    // A body stream that fails while it is read.
    const broken = new ReadableStream({ start(controller) { controller.error(new Error("stream broke")); } });
    await expect(delayed("https://api.openai.com/v1/responses", { method: "POST", headers, body: broken })).rejects.toBeDefined();
    // An injected sleep that returns although the signal was aborted meanwhile: still rejected and logged as such.
    const controller = new AbortController();
    const injected = preload.createMockFetch({
      originalFetch: vi.fn<typeof fetch>(), readScenarioText: () => '{"delayMs":5}', log: line => { lines.push(line); }, now: () => NOW,
      sleep: async () => { controller.abort(); },
    });
    await expect(errorName(injected("https://api.openai.com/v1/responses", { method: "POST", headers, body, signal: controller.signal }))).resolves.toBe("AbortError");
    expect(lines).toEqual([
      `2026-09-23T12:00:00.000Z POST /v1/responses ${fields} scenario=ok status=timeout note=during-delay-60000ms`,
      `2026-09-23T12:00:00.000Z POST /v1/responses/input_tokens ${fields} scenario=- status=aborted`,
      `2026-09-23T12:00:00.000Z POST /v1/responses ${fields} scenario=- status=aborted`,
      expect.stringMatching(/^2026-09-23T12:00:00\.000Z POST \/v1\/responses schema=- model=- bytes=- scenario=- status=error note=failed\S*$/),
      `2026-09-23T12:00:00.000Z POST /v1/responses ${fields} scenario=ok status=aborted note=during-delay-5ms`,
    ]);
  });

  it("reads the scenario file and appends the log on disk by default (log folder created when missing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-openai-"));
    try {
      const scenarioFile = join(dir, "mock-openai-scenarios.json");
      const logFile = join(dir, "logs", "mock-openai.log");
      const mockFetch = preload.createMockFetch({ originalFetch: vi.fn<typeof fetch>(), scenarioFile, logFile });
      const operation = operationFor("WEEKLY_REVIEW");
      await callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation);
      writeFileSync(scenarioFile, '{"weekly_review_v1":"http_429"}');
      await expect(callResponses(providerRequest(operation, weeklyFacts), mockFetch, undefined, operation)).rejects.toMatchObject({ code: "RATE_LIMIT" });
      const log = readFileSync(logFile, "utf8").trim().split("\n");
      expect(log).toHaveLength(4);
      expect(log[3]).toMatch(/POST \/v1\/responses schema=weekly_review_v1 model=gpt-5\.4-mini bytes=\d+ scenario=http_429 status=429$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Activation guards, blocking and pass-through
// ---------------------------------------------------------------------------------------------------------------

describe("activation guards", () => {
  const REAL_LOOKING = "sk-proj-AbCdEf0123456789";
  const noFiles = () => null;

  it("refuses a real-looking key with MOCK_OPENAI=1 and never echoes it", () => {
    let message = "";
    try {
      preload.assertMockEnvironment({ MOCK_OPENAI: "1", OPENAI_API_KEY: REAL_LOOKING }, { readFile: noFiles });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/refusing to start: OPENAI_API_KEY does not start with "sk-local-mock"/);
    expect(message).not.toContain(REAL_LOOKING);
    const target = { fetch: vi.fn<typeof fetch>() };
    const before = target.fetch;
    expect(() => preload.installMockOpenAi({ env: { MOCK_OPENAI: "1", OPENAI_API_KEY: REAL_LOOKING }, target, readFile: noFiles })).toThrow(/refusing to start/);
    expect(target.fetch).toBe(before);
  });

  it("refuses a non-mock key that only a .env file would supply, and starts on Vercel never", () => {
    const files = (text: string) => (file: string) => (file.endsWith(".env.local") ? text : null);
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1" }, { readFile: files(`# local\nexport OPENAI_API_KEY="${REAL_LOOKING}" # real\n`) })).toThrow(/\.env\.local defines OPENAI_API_KEY/);
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1", OPENAI_API_KEY: "" }, { readFile: files(`OPENAI_API_KEY=${REAL_LOOKING}`) })).toThrow(/\.env\.local/);
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1" }, { readFile: files("OPENAI_API_KEY=\nAI_ENABLED=false\n") })).not.toThrow();
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1" }, { readFile: files("OPENAI_API_KEY='sk-local-mock-file'") })).not.toThrow();
    const readFile = vi.fn(files(`OPENAI_API_KEY=${REAL_LOOKING}`));
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1", OPENAI_API_KEY: MOCK_KEY }, { readFile })).not.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1", OPENAI_API_KEY: MOCK_KEY, VERCEL: "1" }, { readFile: noFiles })).toThrow(/Vercel/);
    expect(() => preload.assertMockEnvironment({ MOCK_OPENAI: "1", OPENAI_API_KEY: MOCK_KEY, VERCEL_ENV: "preview" }, { readFile: noFiles })).toThrow(/Vercel/);
  });

  it("reads .env files with Next.js's dotenv grammar (all assignments, colon form, quoted values across lines)", () => {
    expect(preload.dotenvValues("A=1\nOPENAI_API_KEY='first'\r\nexport OPENAI_API_KEY: second # note\nOPENAI_API_KEY=\"x\\ny\"\n", "OPENAI_API_KEY")).toEqual(["first", "second", "x\ny"]);
    expect(preload.dotenvValues(`OPENAI_API_KEY="\n${REAL_LOOKING}"\nB=2`, "OPENAI_API_KEY")).toEqual([`\n${REAL_LOOKING}`]);
    expect(preload.dotenvValues(`OPENAI_API_KEY\n=${REAL_LOOKING}`, "OPENAI_API_KEY")).toEqual([REAL_LOOKING]);
    expect(preload.dotenvValues(`# OPENAI_API_KEY=${REAL_LOOKING}\nOPENAI_API_KEY=#${REAL_LOOKING}`, "OPENAI_API_KEY")).toEqual([""]);
    expect(preload.envFileProblem("OPENAI_API_KEY=\nAI_ENABLED=false\n")).toBeNull();
    expect(preload.envFileProblem(`OPENAI_API_KEY: ${REAL_LOOKING}`)).toMatch(/^defines OPENAI_API_KEY/);
    // A line Next.js ignores but that names the key in an unverifiable form is refused as well (fail closed).
    expect(preload.envFileProblem(`OPENAI_API_KEY : ${REAL_LOOKING}`)).toMatch(/cannot verify/);
  });

  it("refuses every .env.local from which Next.js's own loader (@next/env, in a child process) would load a non-mock key", () => {
    const SAMPLES: Record<string, [text: string, guard: "refuse" | "allow"]> = {
      equals: [`OPENAI_API_KEY=${REAL_LOOKING}\n`, "refuse"],
      colon: [`OPENAI_API_KEY: ${REAL_LOOKING}\n`, "refuse"],
      exportColon: [`export OPENAI_API_KEY: ${REAL_LOOKING}\n`, "refuse"],
      tabColon: [`OPENAI_API_KEY:\t${REAL_LOOKING}\n`, "refuse"],
      crlfColon: [`A=1\r\nOPENAI_API_KEY: ${REAL_LOOKING}\r\n`, "refuse"],
      multilineDouble: [`OPENAI_API_KEY="\n${REAL_LOOKING}"\n`, "refuse"],
      multilineSingle: [`OPENAI_API_KEY='\n${REAL_LOOKING}'\n`, "refuse"],
      multilineBacktick: [`OPENAI_API_KEY=\`\n${REAL_LOOKING}\`\n`, "refuse"],
      escapedNewline: [`OPENAI_API_KEY="\\n${REAL_LOOKING}"\n`, "refuse"],
      quotedOnNextLine: [`OPENAI_API_KEY=\n"${REAL_LOOKING}"\n`, "refuse"],
      colonThenNextLine: [`OPENAI_API_KEY:\n${REAL_LOOKING}\n`, "refuse"],
      separatorOnNextLine: [`OPENAI_API_KEY\n=${REAL_LOOKING}\n`, "refuse"],
      exportOnPreviousLine: [`export\nOPENAI_API_KEY=${REAL_LOOKING}\n`, "refuse"],
      expansion: [`REAL_KEY=${REAL_LOOKING}\nOPENAI_API_KEY=\${REAL_KEY}\n`, "refuse"],
      mockThenReal: [`OPENAI_API_KEY='sk-local-mock-a'\nOPENAI_API_KEY=${REAL_LOOKING}\n`, "refuse"],
      spaceBeforeColon: [`OPENAI_API_KEY : ${REAL_LOOKING}\n`, "refuse"],
      empty: ["OPENAI_API_KEY=\nAI_ENABLED=false\n", "allow"],
      emptyWithComment: ["OPENAI_API_KEY= # set in the shell\n", "allow"],
      strayLineAfterEmpty: [`OPENAI_API_KEY=\n${REAL_LOOKING}\n`, "allow"],
      mockQuoted: ["OPENAI_API_KEY='sk-local-mock-file'\n", "allow"],
      mockColon: ["OPENAI_API_KEY: sk-local-mock-file\n", "allow"],
      mockExportDouble: ['export OPENAI_API_KEY="sk-local-mock-file" # local\n', "allow"],
      comment: [`# OPENAI_API_KEY=${REAL_LOOKING}\n`, "allow"],
      hashValue: [`OPENAI_API_KEY=#${REAL_LOOKING}\n`, "allow"],
      reference: [`OTHER=\${OPENAI_API_KEY}\nOPENAI_API_KEY=\n`, "allow"],
      otherKeys: [`MY_OPENAI_API_KEY=${REAL_LOOKING}\nOPENAI_API_KEY.backup=${REAL_LOOKING}\n`, "allow"],
    };
    const root = mkdtempSync(join(tmpdir(), "mock-openai-dotenv-"));
    try {
      for (const [name, [text]] of Object.entries(SAMPLES)) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, ".env.local"), text);
      }
      // Next.js's loader, exactly as `next dev` runs it (development mode, nothing exported); prints classes, never values.
      const nextEnv = createRequire(createRequire(import.meta.url).resolve("next/package.json")).resolve("@next/env");
      const script = [
        `const fs = require("node:fs"), path = require("node:path");`,
        `const { loadEnvConfig } = require(process.argv[1]);`,
        `const silent = { info() {}, warn() {}, error() {}, log() {} }, out = {};`,
        `for (const name of fs.readdirSync(process.argv[2])) {`,
        `  const value = loadEnvConfig(path.join(process.argv[2], name), true, silent, true).combinedEnv.OPENAI_API_KEY?.trim() ?? "";`,
        `  out[name] = value === "" ? "none" : value.startsWith("sk-local-mock") ? "mock" : "other";`,
        `}`,
        `console.log(JSON.stringify(out));`,
      ].join("\n");
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of ["OPENAI_API_KEY", "NODE_ENV", "NODE_OPTIONS", "__NEXT_PROCESSED_ENV"]) delete env[key];
      const child = spawnSync(process.execPath, ["-e", script, nextEnv, root], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60000, windowsHide: true });
      expect(child.status, child.stderr).toBe(0);
      const loaded = JSON.parse(child.stdout) as Record<string, "none" | "mock" | "other">;
      expect(Object.keys(loaded).sort()).toEqual(Object.keys(SAMPLES).sort());
      for (const [name, [, expected]] of Object.entries(SAMPLES)) {
        let refused = false;
        try {
          preload.assertMockEnvironment({ MOCK_OPENAI: "1" }, { repoRoot: join(root, name) });
        } catch (error) {
          refused = true;
          expect((error as Error).message, name).not.toContain(REAL_LOOKING);
        }
        expect(refused ? "refuse" : "allow", name).toBe(expected);
        if (loaded[name] === "other") expect(refused, `${name}: Next.js would load a non-mock key`).toBe(true);
        if (expected === "allow") expect(["none", "mock"], name).toContain(loaded[name]);
      }
      // Everything refused except the deliberately strict spaceBeforeColon is a key Next.js really loads.
      expect(Object.entries(SAMPLES).filter(([name, [, expected]]) => expected === "refuse" && loaded[name] !== "other").map(([name]) => name)).toEqual(["spaceBeforeColon"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing unless MOCK_OPENAI is exactly 1, even with a real-looking key", () => {
    for (const flag of [undefined, "", "0", "true", "yes"]) {
      const target = { fetch: vi.fn<typeof fetch>() };
      const before = target.fetch;
      expect(preload.installMockOpenAi({ env: { MOCK_OPENAI: flag, OPENAI_API_KEY: REAL_LOOKING }, target })).toBeNull();
      expect(target.fetch).toBe(before);
    }
  });

  it("installs once, keeps the original fetch for other hosts and uninstalls cleanly", async () => {
    const response = new Response("ok");
    const original = vi.fn<typeof fetch>(async () => response);
    const target = { fetch: original as typeof fetch };
    const handle = preload.installMockOpenAi({ env: { MOCK_OPENAI: "1", OPENAI_API_KEY: MOCK_KEY }, target, log: () => {}, readScenarioText: () => null });
    expect(handle).not.toBeNull();
    expect(target.fetch).not.toBe(original);
    expect(preload.installMockOpenAi({ env: { MOCK_OPENAI: "1", OPENAI_API_KEY: MOCK_KEY }, target })).toBe(handle);
    await expect(target.fetch("http://127.0.0.1:54321/rest/v1/trades")).resolves.toBe(response);
    handle?.uninstall();
    expect(target.fetch).toBe(original);
  });

  it("as a real preload: a no-op without MOCK_OPENAI=1, and a refused import with a real key", async () => {
    const before = globalThis.fetch;
    vi.resetModules();
    vi.stubEnv("MOCK_OPENAI", "");
    vi.stubEnv("OPENAI_API_KEY", REAL_LOOKING);
    await import("../scripts/local-stack/mock-openai.mjs");
    expect(globalThis.fetch).toBe(before);
    vi.resetModules();
    vi.stubEnv("MOCK_OPENAI", "1");
    await expect(import("../scripts/local-stack/mock-openai.mjs")).rejects.toThrow(/refusing to start/);
    expect(globalThis.fetch).toBe(before);
    vi.resetModules();
    vi.stubEnv("OPENAI_API_KEY", MOCK_KEY);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await import("../scripts/local-stack/mock-openai.mjs");
      expect(globalThis.fetch).not.toBe(before);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[mock-openai] active"));
    } finally {
      globalThis.fetch = before;
      stderr.mockRestore();
    }
  });
});

describe("request routing", () => {
  const auth = { Authorization: `Bearer ${MOCK_KEY}`, "Content-Type": "application/json" };

  it.each([
    ["POST", "https://api.openai.com/v1/chat/completions"], ["POST", "https://api.openai.com/v1/embeddings"], ["GET", "https://api.openai.com/v1/models"],
    ["GET", "https://api.openai.com/v1/responses"], ["POST", "https://api.openai.com/v1/responses?stream=true"], ["POST", "http://api.openai.com/v1/responses"],
    ["POST", "https://api.openai.com./v1/responses"], ["POST", "https://API.OpenAI.com/v1/files"], ["POST", "https://openai.com/v1/responses"],
    ["POST", "https://chat.openai.com/backend-api"], ["POST", "https://api.openai.com:8443/v1/responses"],
  ])("blocks %s %s without forwarding it", async (method, url) => {
    const { mockFetch, originalFetch, lines } = harness();
    await expect(mockFetch(url, { method, headers: auth, body: "{}" })).rejects.toBeInstanceOf(preload.MockOpenAiBlockedError);
    expect(originalFetch).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ scenario=blocked status=blocked$/);
  });

  it("blocks the mocked endpoints without an sk-local-mock key", async () => {
    const { mockFetch, originalFetch, lines } = harness();
    const headerSets: Record<string, string>[] = [{ Authorization: "Bearer sk-proj-real" }, {}];
    for (const headers of headerSets) {
      await expect(mockFetch("https://api.openai.com/v1/responses", { method: "POST", headers, body: "{}" })).rejects.toThrow(/sk-local-mock/);
    }
    expect(originalFetch).not.toHaveBeenCalled();
    expect(lines.every(line => line.includes("scenario=blocked-key") && !line.includes("sk-proj-real"))).toBe(true);
  });

  it("passes every non-OpenAI request to the original fetch with the exact same arguments", async () => {
    const { mockFetch, originalFetch, lines } = harness();
    const response = new Response("{}");
    originalFetch.mockResolvedValue(response);
    const init = { method: "POST", headers: { apikey: "sb_secret_local" }, body: "{}" };
    await expect(mockFetch("http://127.0.0.1:54321/rest/v1/rpc/x", init)).resolves.toBe(response);
    expect(originalFetch.mock.calls[0]).toEqual(["http://127.0.0.1:54321/rest/v1/rpc/x", init]);
    expect(originalFetch.mock.calls[0][1]).toBe(init);
    const url = new URL("https://openai.com.example.test/v1/responses");
    await mockFetch(url);
    expect(originalFetch.mock.calls[1]).toEqual([url]);
    const request = new Request("https://example.test/data");
    await mockFetch(request);
    expect(originalFetch.mock.calls[2][0]).toBe(request);
    expect(lines).toEqual([]);
  });

  it("answers a real Request object and fails closed for Request- or URL-shaped objects of other implementations", async () => {
    const { mockFetch, originalFetch, lines } = harness();
    const body = JSON.stringify({ model: "gpt-5.4-mini", input: "abcdefgh" });
    const request = new Request("https://api.openai.com/v1/responses/input_tokens", { method: "POST", headers: auth, body });
    await expect((await mockFetch(request)).json()).resolves.toEqual({ input_tokens: Math.ceil(Buffer.byteLength(body) / 4) });
    // fetch() would stringify these (e.g. "[object Object]"); their url/href still names OpenAI, so they are blocked.
    const foreignRequest = { url: "https://api.openai.com/v1/responses/input_tokens", method: "POST", headers: auth, clone: () => ({ text: async () => body }) };
    const foreignUrl = { href: "https://API.openai.com/v1/responses", toString: () => "https://example.test/" };
    const stringified = { toString: () => "https://api.openai.com/v1/files" };
    for (const input of [foreignRequest, foreignUrl, stringified]) {
      await expect(mockFetch(input as unknown as Request, { method: "POST", headers: auth, body })).rejects.toBeInstanceOf(preload.MockOpenAiBlockedError);
    }
    expect(originalFetch).not.toHaveBeenCalled();
    expect(lines.slice(1).every(line => / scenario=blocked status=blocked$/.test(line))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Determinism and token estimates
// ---------------------------------------------------------------------------------------------------------------

describe("determinism and token estimates", () => {
  it("returns the same output and usage for the same request body", async () => {
    const operation = operationFor("REVIEW_TRADE_TIMELINE");
    const context = tradeTimelineReviewContext(plannedInput(), CAPTURED);
    const bodies: string[] = [];
    const { mockFetch } = harness();
    const capture: typeof fetch = async (input, init) => {
      bodies.push(String(init?.body));
      return mockFetch(input, init);
    };
    const first = await callResponses(providerRequest(operation, context), capture, undefined, operation);
    const second = await callResponses(providerRequest(operation, context), capture, undefined, operation);
    expect([first.responseId, second.responseId]).toEqual(["resp_mock_1", "resp_mock_2"]);
    expect(second.output).toEqual(first.output);
    expect(second.usage).toEqual(first.usage);
    expect(bodies[3]).toBe(bodies[1]);
    const again = buildResponsesResult(bodies[1], { responseId: "resp_fixed", createdAt: 1 });
    expect(buildResponsesResult(bodies[1], { responseId: "resp_fixed", createdAt: 1 })).toEqual(again);
    expect(again.output).toEqual(first.output);
  });

  it("counts input_tokens as ceil(UTF-8 bytes / 4) of the count body and reports the same number as usage", async () => {
    const operation = operationFor("WEEKLY_REVIEW");
    const calls: Array<{ body: string; json: unknown }> = [];
    const { mockFetch } = harness();
    const capture: typeof fetch = async (input, init) => {
      const response = await mockFetch(input, init);
      calls.push({ body: String(init?.body), json: await response.clone().json() });
      return response;
    };
    const result = await callResponses(providerRequest(operation, weeklyFacts), capture, undefined, operation);
    const counted = Math.ceil(Buffer.byteLength(calls[0].body) / 4);
    expect(calls[0].json).toEqual({ input_tokens: counted });
    expect(result.usage).toMatchObject({ input_tokens: counted, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
    const usage = result.usage as { input_tokens: number; output_tokens: number; total_tokens: number };
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
    expect(estimateInputTokens("€€€€€")).toBe(4);
  });

  it("estimates data-URL images by 512px tiles instead of base64 length", async () => {
    expect(imageDimensions(Buffer.from(CHART.split(",")[1], "base64"))).toEqual({ width: 1280, height: 720 });
    expect(imageTokens(CHART)).toBe(1105);
    expect(imageTokens(pngDataUrl(4096, 4096))).toBe(765);
    expect(imageTokens(pngDataUrl(768, 2048))).toBe(MAX_IMAGE_TOKENS);
    expect(imageTokens("data:image/png;base64,AAAA")).toBe(MAX_IMAGE_TOKENS);
    expect(imageTokens(CHART, "low")).toBe(85);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00]);
    expect(imageDimensions(jpeg)).toEqual({ width: 1280, height: 720 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    expect(imageDimensions(webp)).toEqual({ width: 1280, height: 720 });
    const operation = operationFor("ANALYZE_SETUP");
    const bodies: string[] = [];
    const { mockFetch } = harness();
    const capture: typeof fetch = async (input, init) => {
      bodies.push(String(init?.body));
      return mockFetch(input, init);
    };
    const result = await callResponses(providerRequest(operation, analyzeSetupContext(biasSource, EVIDENCE), [{ sourceId: `evidence:${EVIDENCE[0].id}`, role: "M5", dataUrl: CHART }]), capture, undefined, operation);
    expect(result.usage).toMatchObject({ input_tokens: Math.ceil((Buffer.byteLength(bodies[0]) - Buffer.byteLength(CHART)) / 4) + 1105 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Next.js 16: server-side provider calls reach the preload's fetch
// ---------------------------------------------------------------------------------------------------------------

describe("Next.js 16 dev server integration", () => {
  it("Next's patched fetch (dedupe + patchFetch wrapper) passes provider calls inside a request work store to the mock", async () => {
    // patchFetch() runs when the server loads app modules, after every --import preload, and wraps whatever
    // globalThis.fetch is at that moment: createPatchedFetcher(createDedupeFetch(globalThis.fetch)). In dev,
    // router-server also captures globalThis.fetch at startup and restores exactly that function on HMR.
    const globals = globalThis as unknown as Record<string | symbol, unknown>;
    const marker = Symbol.for("next-patch");
    const hadMarker = Object.hasOwn(globals, marker);
    const previous = globals[marker];
    const hadAsyncLocalStorage = Object.hasOwn(globals, "AsyncLocalStorage");
    try {
      // What the server sets up first (next-server.js → node-environment → node-environment-baseline).
      if (typeof globals.AsyncLocalStorage !== "function") globals.AsyncLocalStorage = AsyncLocalStorage;
      const { createDedupeFetch } = await import("next/dist/server/lib/dedupe-fetch");
      const { createPatchedFetcher } = await import("next/dist/server/lib/patch-fetch");
      const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
      const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
      const { mockFetch, lines, originalFetch } = harness();
      const nextFetch = createPatchedFetcher(createDedupeFetch(mockFetch) as typeof fetch, { workAsyncStorage, workUnitAsyncStorage });
      const operation = operationFor("REVIEW_TRADE_TIMELINE");
      const context = tradeTimelineReviewContext(plannedInput(), CAPTURED);
      // The minimum of a server action's stores that Next's fetch patch reads for a POST with headers.
      const workStore = {
        route: "/trades/[id]", page: "/trades/[id]/page", isStaticGeneration: false, isDraftMode: false, forceStatic: false, forceDynamic: false,
        fetchCache: undefined, isUnstableNoStore: false, isBuildTimePrerendering: false, isOnDemandRevalidate: false, incrementalCache: undefined,
        pendingRevalidates: {}, nextFetchId: 1, shouldTrackFetchMetrics: false,
      };
      const requestStore = { type: "request", phase: "action", implicitTags: { tags: [], expirationsByCacheKind: new Map() }, isHmrRefresh: false };
      const inAction = <T>(run: () => Promise<T>) => workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(requestStore as never, run));
      const result = await inAction(() => callResponses(providerRequest(operation, context, twoCharts), nextFetch, undefined, operation));
      expect(() => validateTradeTimelineReview(result.output, context)).not.toThrow();
      expect(result.responseId).toBe("resp_mock_1");
      // Both calls took Next's full in-request path (doOriginalFetch numbers every fetch of the work store).
      expect(workStore.nextFetchId).toBe(3);
      // Outside any work store (module scope, route without a store) Next passes the call straight through as well.
      await expect(callResponses(providerRequest(operation, context), nextFetch, undefined, operation)).resolves.toMatchObject({ responseId: "resp_mock_2" });
      expect(lines.map(line => line.split(" ").slice(1, 3).join(" "))).toEqual([
        "POST /v1/responses/input_tokens", "POST /v1/responses", "POST /v1/responses/input_tokens", "POST /v1/responses",
      ]);
      // Other OpenAI paths stay blocked behind Next's wrapper, and non-OpenAI requests still reach the original fetch.
      await expect(inAction(() => nextFetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${MOCK_KEY}` } }))).rejects.toBeInstanceOf(preload.MockOpenAiBlockedError);
      originalFetch.mockResolvedValueOnce(new Response("{}"));
      await inAction(() => nextFetch("http://127.0.0.1:54321/rest/v1/trades", { method: "POST", body: "{}", signal: AbortSignal.timeout(1000) }));
      expect(String(originalFetch.mock.calls[0][0])).toBe("http://127.0.0.1:54321/rest/v1/trades");
    } finally {
      if (hadMarker) globals[marker] = previous;
      else delete globals[marker];
      if (!hadAsyncLocalStorage) delete globals.AsyncLocalStorage;
    }
  });

  it("next dev forwards the --import preload to its server child process (NODE_OPTIONS round trip)", async () => {
    const { formatNodeOptions, getParsedNodeOptions } = await import("next/dist/server/lib/utils");
    const absolute = new URL("../scripts/local-stack/mock-openai.mjs", import.meta.url).href;
    for (const flag of ["--import=./scripts/local-stack/mock-openai.mjs", `--import=${absolute}`]) {
      vi.stubEnv("NODE_OPTIONS", flag);
      // Exactly what next-dev.js does before fork()ing start-server.js (plus its own flags).
      const options = getParsedNodeOptions();
      options["max-old-space-size"] = "4096";
      options["enable-source-maps"] = true;
      expect(formatNodeOptions(options).nodeOptions.split(" ")).toContain(flag);
    }
  });

  it("application code never imports the mock", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/mock-openai|MOCK_OPENAI|sk-local-mock/.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    for (const file of ["../next.config.ts", "../package.json"]) {
      if (/mock-openai|MOCK_OPENAI/.test(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The preload as a real Node process (sandboxed copy, so logs never touch the repository's .local/)
// ---------------------------------------------------------------------------------------------------------------

describe("the preload in a real Node process", () => {
  const LOCAL_STACK = fileURLToPath(new URL("../scripts/local-stack/", import.meta.url));
  const REAL_LOOKING = "sk-proj-AbCdEf0123456789";
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mock-openai-preload-"));
    mkdirSync(join(root, "scripts", "local-stack"), { recursive: true });
    for (const file of ["mock-openai.mjs", "mock-openai-generator.mjs"]) copyFileSync(join(LOCAL_STACK, file), join(root, "scripts", "local-stack", file));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** `node -e <script>` from the sandbox root with the documented relative --import, like `npx pnpm dev` from the repo. */
  function node(env: Record<string, string | undefined>, script = "console.log(typeof globalThis.fetch[Symbol.for('trading-os.mock-openai.installed')]);") {
    const childEnv: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: "--import=./scripts/local-stack/mock-openai.mjs", VERCEL: undefined, VERCEL_ENV: undefined, ...env };
    for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60000, windowsHide: true });
  }

  it("refuses to start with a real-looking key, or with one that only .env.local would supply, without printing it", () => {
    const direct = node({ MOCK_OPENAI: "1", OPENAI_API_KEY: REAL_LOOKING });
    expect(direct.status).not.toBe(0);
    expect(direct.stdout).toBe("");
    expect(direct.stderr).toMatch(/refusing to start: OPENAI_API_KEY does not start with "sk-local-mock"/);
    expect(direct.stderr).not.toContain(REAL_LOOKING);
    writeFileSync(join(root, ".env.local"), `OPENAI_API_KEY=${REAL_LOOKING}\n`);
    const fromFile = node({ MOCK_OPENAI: "1", OPENAI_API_KEY: undefined });
    expect(fromFile.status).not.toBe(0);
    expect(fromFile.stderr).toMatch(/\.env\.local defines OPENAI_API_KEY/);
    expect(fromFile.stderr).not.toContain(REAL_LOOKING);
    expect(existsSync(join(root, ".local"))).toBe(false);
  });

  it("does nothing without MOCK_OPENAI=1, even with a real-looking key", () => {
    for (const flag of [undefined, "0", "true"]) {
      const child = node({ MOCK_OPENAI: flag, OPENAI_API_KEY: REAL_LOOKING });
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe("undefined");
      expect(child.stderr).not.toContain("[mock-openai]");
    }
  });

  it("with MOCK_OPENAI=1 and an sk-local-mock key: answers input_tokens, blocks other OpenAI paths and logs one line per call", () => {
    const script = [
      `const headers = { Authorization: "Bearer sk-local-mock-child", "Content-Type": "application/json" };`,
      `const body = JSON.stringify({ model: "gpt-5.4-mini", input: "abcdefgh" });`,
      `const counted = await (await fetch("https://api.openai.com/v1/responses/input_tokens", { method: "POST", headers, body })).json();`,
      `let blocked = null;`,
      `try { await fetch("https://api.openai.com/v1/models", { headers }); } catch (error) { blocked = error.name; }`,
      `const installed = typeof globalThis.fetch[Symbol.for("trading-os.mock-openai.installed")];`,
      `console.log(JSON.stringify({ installed, counted, blocked, bytes: Buffer.byteLength(body) }));`,
    ].join("\n");
    const child = node({ MOCK_OPENAI: "1", OPENAI_API_KEY: "sk-local-mock-child" }, script);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toContain("[mock-openai] active");
    const report = JSON.parse(child.stdout) as { installed: string; counted: unknown; blocked: string; bytes: number };
    expect(report).toEqual({ installed: "object", counted: { input_tokens: Math.ceil(report.bytes / 4) }, blocked: "MockOpenAiBlockedError", bytes: report.bytes });
    const log = readFileSync(join(root, ".local", "logs", "mock-openai.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z POST \/v1\/responses\/input_tokens schema=- model=gpt-5\.4-mini bytes=\d+ scenario=ok status=200$/);
    expect(log[1]).toMatch(/ GET api\.openai\.com\/v1\/models schema=- model=- bytes=- scenario=blocked status=blocked$/);
    expect(log.join("\n")).not.toMatch(/sk-local-mock|abcdefgh/);
  });
});
