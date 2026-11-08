import { describe, expect, it } from "vitest";
import { operationContract } from "@/ai/operation-contract";
import { operationFor } from "@/ai/operations";
import {
  isClosedTrade, type TimelineReviewInput, TimelineReviewScopeError, type TimelineReviewTrade, tradeTimelineReviewContext,
} from "@/ai/trade-timeline-review-context";
import {
  REVIEW_TRADE_TIMELINE_CITATIONS_VERSION, REVIEW_TRADE_TIMELINE_PROMPT, TimelineReviewRejection, type TradeTimelineReviewResult,
  tradeTimelineReviewContract, tradeTimelineReviewOutput, validateTradeTimelineReview,
} from "@/ai/trade-timeline-review-contract";
import {
  maxTimelineFactsBytes, TIMELINE_REVIEW_LIMITS, tradeTimelineAllowedSources, tradeTimelineSourceManifest,
} from "@/ai/trade-timeline-review-sources";
import { classifyTiming, inferStoredPhase } from "@/domain/timeline";
import { plan as v1Plan } from "./fixtures/trade-review";

// Synthetic, fully deterministic trade records (UTC). The account trades in USD.
const ids = {
  trade: "a0000000-0000-4000-8000-000000000001",
  live: "a0000000-0000-4000-8000-000000000002",
  account: "20000000-0000-4000-8000-000000000001",
  plan: "30000000-0000-4000-8000-000000000001",
  revision1: "b0000000-0000-4000-8000-000000000001",
  revision2: "b0000000-0000-4000-8000-000000000002",
  check1: "b1000000-0000-4000-8000-000000000001",
  check2: "b1000000-0000-4000-8000-000000000002",
  preEntryNote: "c0000000-0000-4000-8000-000000000001",
  stopChange: "c0000000-0000-4000-8000-000000000002",
  lesson: "c0000000-0000-4000-8000-000000000003",
  liveNote: "c0000000-0000-4000-8000-000000000004",
  legacyNote: "d0000000-0000-4000-8000-000000000001",
  legacyOpened: "d0000000-0000-4000-8000-000000000002",
  tagNote: "d0000000-0000-4000-8000-000000000003",
  override: "d1000000-0000-4000-8000-000000000001",
  taken: "d1000000-0000-4000-8000-000000000002",
  preEntryShot: "e0000000-0000-4000-8000-000000000001",
  afterCloseShot: "e0000000-0000-4000-8000-000000000002",
  legacyShot: "e0000000-0000-4000-8000-000000000003",
  position1: "f0000000-0000-4000-8000-000000000001",
  position2: "f0000000-0000-4000-8000-000000000002",
  strategy: "40000000-0000-4000-8000-000000000001",
  risk: "50000000-0000-4000-8000-000000000001",
};
const THESIS = "London swept the Asian low; waiting for an M5 order block first touch.";

const plannedTrade: TimelineReviewTrade = {
  id: ids.trade, account_id: ids.account, origin: "PLANNED", created_at: "2026-09-01T06:00:00Z", currency: "USD", lifecycle: "CLOSED",
  plan_id: ids.plan, symbol: "EURUSD", direction: "LONG", entry_model: "OB_FIRST_TOUCH", planned_quantity: "0.25", planned_rr: "3",
  entry_price: "1.1", entered_at: "2026-09-01T08:00:00Z", entry_recorded_at: "2026-09-01T08:01:00Z", quantity: "0.25", oversize: false,
  exit_price: "1.106", exited_at: "2026-09-01T09:00:00Z", close_recorded_at: "2026-09-01T09:02:00Z", fees: "0", net_pnl: "150",
  realized_r: "3", outcome: "WIN", pnl_source: "CALCULATED",
};

function plannedInput(changes: Partial<TimelineReviewInput> = {}): TimelineReviewInput {
  return {
    trade: plannedTrade,
    plan: { id: ids.plan, lockedAt: "2026-09-01T07:00:00Z", tradingDay: "2026-09-01", proposal: { ...v1Plan.proposal, narrative: THESIS }, nominalRisk: "50", riskResult: v1Plan.risk_result },
    strategy: { id: ids.strategy, version: "ICT V1.0", rules: { minimum_rr: "3" } },
    riskVersion: {
      id: ids.risk, version: "Risk Plan V1.0", effective_day: "2026-01-01", max_risk_percent: "0.5", default_risk_percent: null, max_daily_trades: 2,
      min_rr: "3", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: "200",
    },
    revisions: [
      { proposalId: ids.revision1, revision: 1, createdAt: "2026-09-01T06:00:00Z", proposal: { ...v1Plan.proposal, narrative: "First idea", riskPercent: "1" } },
      { proposalId: ids.revision2, revision: 2, createdAt: "2026-09-01T06:30:00Z", proposal: { ...v1Plan.proposal, narrative: THESIS } },
    ],
    riskChecks: [
      { id: ids.check1, proposalId: ids.revision1, recordedAt: "2026-09-01T06:00:01Z", result: v1Plan.risk_result, checks: 3 },
      { id: ids.check2, proposalId: ids.revision2, recordedAt: "2026-09-01T06:30:01Z", result: v1Plan.risk_result, checks: 1 },
    ],
    legacyEvents: [
      { id: ids.legacyOpened, eventType: "TRADE_OPENED", payload: { entry_price: "1.1" }, occurredAt: "2026-09-01T08:00:00Z", recordedAt: "2026-09-01T08:01:00Z" },
      { id: ids.tagNote, eventType: "NOTE_ADDED", payload: { source: "MANUAL", setup_grade: "A" }, occurredAt: "2026-09-01T09:40:00Z", recordedAt: "2026-09-01T09:40:00Z" },
      { id: ids.legacyNote, eventType: "NOTE_ADDED", payload: { note: "Price is reacting at the order block." }, occurredAt: "2026-09-01T08:10:00Z", recordedAt: "2026-09-01T08:10:00Z" },
    ],
    journal: [
      { id: ids.preEntryNote, kind: "NOTE", body: "Waiting for the M5 shift before entering.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-01T07:30:00Z" },
      { id: ids.stopChange, kind: "STOP_CHANGE", body: null, details: { price: "1.0990" }, phase: "LIVE", recordedAt: "2026-09-01T08:30:00Z" },
      { id: ids.lesson, kind: "LESSON", body: "I knew from the start it would reverse.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-01T09:30:00Z" },
    ],
    positionFacts: [],
    riskBasisSource: null,
    tags: { setupGrade: "A", liquidityContext: "ARL_LOW", mssTimeframe: "M5", tags: ["patient"], source: "V2", recordedAt: "2026-09-01T09:45:00Z" },
    evidence: [
      { id: ids.preEntryShot, label: "PRE_ENTRY", timeframe: "M5", storedPhase: "PRE_ENTRY", recordedAt: "2026-09-01T06:45:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 1200 },
      { id: ids.afterCloseShot, label: "EXIT", timeframe: null, storedPhase: "POST_TRADE", recordedAt: "2026-09-01T09:10:00Z", sha256: "b".repeat(64), mimeType: "image/webp", byteSize: 900 },
    ],
    ...changes,
  };
}

const liveTrade: TimelineReviewTrade = {
  ...plannedTrade, id: ids.live, origin: "LIVE_FIRST", created_at: "2026-09-02T08:00:00Z", plan_id: null, planned_quantity: null, planned_rr: null,
  entered_at: "2026-09-02T07:55:00Z", entry_recorded_at: "2026-09-02T08:00:00Z", oversize: null,
  exited_at: "2026-09-02T09:00:00Z", close_recorded_at: "2026-09-02T09:01:00Z", net_pnl: "-40", realized_r: "-0.8", outcome: "LOSS", pnl_source: "CALCULATED",
};

function liveInput(changes: Partial<TimelineReviewInput> = {}): TimelineReviewInput {
  return {
    trade: liveTrade, plan: null, strategy: { id: ids.strategy, version: "ICT V1.0", rules: { minimum_rr: "3" } }, riskVersion: null, revisions: [], riskChecks: [], legacyEvents: [],
    journal: [
      { id: ids.liveNote, kind: "DECISION", body: "Holding through the pullback.", details: {}, phase: "LIVE", recordedAt: "2026-09-02T08:20:00Z" },
      { id: ids.lesson, kind: "LESSON", body: "My plan was to fade the high all along.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-02T09:30:00Z" },
    ],
    positionFacts: [
      { id: ids.position1, recordedAt: "2026-09-02T08:00:00Z", source: "USER", symbol: "EURUSD", direction: "LONG", entryModel: null, entryPrice: "1.1", enteredAt: "2026-09-02T07:55:00Z", quantity: "0.25", initialStop: null, riskAmount: null },
      { id: ids.position2, recordedAt: "2026-09-02T08:05:00Z", source: "USER", symbol: null, direction: null, entryModel: null, entryPrice: null, enteredAt: null, quantity: null, initialStop: "1.098", riskAmount: "50" },
    ],
    riskBasisSource: "USER_REPORTED",
    tags: { setupGrade: null, liquidityContext: null, mssTimeframe: null, tags: [], source: null, recordedAt: null },
    evidence: [{ id: ids.preEntryShot, label: "ENTRY", timeframe: "M5", storedPhase: "LIVE", recordedAt: "2026-09-02T08:02:00Z", sha256: "c".repeat(64), mimeType: "image/png", byteSize: 1000 }],
    ...changes,
  };
}

const CAPTURED = "2026-09-01T10:00:00Z";
const plannedFacts = () => tradeTimelineReviewContext(plannedInput(), CAPTURED);
const liveFacts = () => tradeTimelineReviewContext(liveInput(), CAPTURED);
const timingOf = (facts: ReturnType<typeof plannedFacts>, sourceId: string) => facts.timeline.find(item => item.sourceId === sourceId);

function plannedOutput(): TradeTimelineReviewResult {
  return {
    headline: { text: "The recorded entry followed the locked plan, and live management stayed within it.", sourceRefs: ["execution", "originalPlan"] },
    thesisCheck: { assessment: "CONSISTENT", text: "The locked thesis matches the pre-entry note.", sourceRefs: ["originalPlan", `journal:${ids.preEntryNote}`] },
    executionVsPlan: { assessment: "ALIGNED", text: "Entry and size match the locked plan.", sourceRefs: ["execution", "originalPlan"] },
    liveManagement: { assessment: "DISCIPLINED", text: "One recorded stop change while live.", sourceRefs: [`journal:${ids.stopChange}`] },
    patterns: [],
    keyLesson: { text: "Keep recording the pre-entry trigger before the entry.", sourceRefs: [`journal:${ids.preEntryNote}`] },
    limitations: ["Only two screenshots were selected."],
  };
}

function liveOutput(): TradeTimelineReviewResult {
  return {
    headline: { text: "No pre-trade plan was recorded; the review covers live management only.", sourceRefs: ["execution"] },
    thesisCheck: { assessment: "NOT_RECORDED", text: "No thesis was recorded before execution.", sourceRefs: ["strategy"] },
    executionVsPlan: { assessment: "NO_PLAN", text: "There is no recorded plan to compare with.", sourceRefs: ["execution"] },
    liveManagement: { assessment: "INSUFFICIENT_EVIDENCE", text: "One live decision was recorded.", sourceRefs: [`journal:${ids.liveNote}`] },
    patterns: [],
    keyLesson: { text: "Record the thesis before or at entry.", sourceRefs: ["execution"] },
    limitations: [],
  };
}

function rejection(output: unknown, facts: unknown): string {
  try {
    validateTradeTimelineReview(output, facts);
  } catch (error) {
    if (error instanceof TimelineReviewRejection) return error.code;
    throw error;
  }
  return "ACCEPTED";
}

describe("REVIEW_TRADE_TIMELINE_FACTS_V1 timing", () => {
  it("classifies every planned-trade record with classifyTiming exactly", () => {
    const facts = plannedFacts();
    const entryRecordedAt = plannedTrade.entry_recorded_at;
    for (const item of facts.timeline) {
      const journal = plannedInput().journal.find(entry => `journal:${entry.id}` === item.sourceId);
      const storedPhase = item.kind === "CLOSE" ? "POST_TRADE" : journal?.phase ?? inferStoredPhase(item.recordedAt, entryRecordedAt, plannedTrade.close_recorded_at);
      const expected = classifyTiming({
        recordedAt: item.recordedAt, storedPhase, origin: "PLANNED", entryAt: plannedTrade.entered_at, entryRecordedAt, exitAt: plannedTrade.exited_at, tradeCreatedAt: plannedTrade.created_at,
      });
      expect({ id: item.sourceId, timing: item.timing, flags: item.flags }).toEqual({ id: item.sourceId, timing: expected.timing, flags: expected.flags });
    }
    expect(facts.timeline.map(item => [item.sourceId, item.timing])).toEqual([
      [`revision:${ids.revision1}`, "BEFORE_ENTRY"], [`check:${ids.check1}`, "BEFORE_ENTRY"],
      [`revision:${ids.revision2}`, "BEFORE_ENTRY"], [`check:${ids.check2}`, "BEFORE_ENTRY"],
      [`plan:${ids.plan}`, "BEFORE_ENTRY"], [`journal:${ids.preEntryNote}`, "BEFORE_ENTRY"],
      [`execution:${ids.trade}`, "WHILE_LIVE"], [`event:${ids.legacyNote}`, "WHILE_LIVE"], [`journal:${ids.stopChange}`, "WHILE_LIVE"],
      [`close:${ids.trade}`, "AFTER_CLOSE"], [`journal:${ids.lesson}`, "AFTER_CLOSE"],
    ]);
    expect(facts.evidence.map(item => [item.id, item.timing])).toEqual([[ids.preEntryShot, "BEFORE_ENTRY"], [ids.afterCloseShot, "AFTER_CLOSE"]]);
  });

  it("downgrades a pre-entry note once the entry is back-dated before it, and never upgrades after-close text", () => {
    const backDated = tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, entered_at: "2026-09-01T07:15:00Z" } }), CAPTURED);
    expect(timingOf(backDated, `journal:${ids.preEntryNote}`)).toMatchObject({ timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
    expect(timingOf(backDated, `plan:${ids.plan}`)).toMatchObject({ timing: "BEFORE_ENTRY", flags: [] });
    // A post-trade lesson stays after close even when an exit time is reported later than its recording.
    const lateExit = tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, exited_at: "2026-09-01T09:50:00Z" } }), CAPTURED);
    expect(timingOf(lateExit, `journal:${ids.lesson}`)?.timing).toBe("AFTER_CLOSE");
    expect(tradeTimelineAllowedSources(backDated).preEntryIds).not.toContain(`journal:${ids.preEntryNote}`);
  });

  it("keeps the lock and the evaluation that authorised it Before entry when the entry is reported at the lock instant", () => {
    // The lock transaction stamps locked_at and writes its evaluation ~600 ms later; an "Earlier" entry typed in the
    // lock's minute is stored at locked_at itself (the database accepts entered_at = locked_at).
    const lockedAt = "2026-09-01T07:00:00.19218Z";
    const base = plannedInput();
    const plan = { ...(base.plan as NonNullable<TimelineReviewInput["plan"]>), lockedAt, riskEvaluationId: ids.check2 };
    const input = plannedInput({
      trade: { ...plannedTrade, entered_at: lockedAt }, plan,
      riskChecks: [base.riskChecks[0], { ...base.riskChecks[1], recordedAt: "2026-09-01T07:00:00.79914Z" }],
    });
    const facts = tradeTimelineReviewContext(input, CAPTURED);
    expect(facts.timeline.map(item => [item.sourceId, item.timing, item.flags]).slice(2, 7)).toEqual([
      [`revision:${ids.revision2}`, "BEFORE_ENTRY", []], [`check:${ids.check2}`, "BEFORE_ENTRY", []], [`plan:${ids.plan}`, "BEFORE_ENTRY", []],
      [`execution:${ids.trade}`, "WHILE_LIVE", []],
      // Only the records of the lock precede every entry by definition: a note stored pre-entry after that time is flagged.
      [`journal:${ids.preEntryNote}`, "WHILE_LIVE", ["RECORDED_AFTER_EXECUTION_BEGAN"]],
    ]);
    expect(timingOf(facts, `check:${ids.check2}`)?.recordedAt).toBe("2026-09-01T07:00:00.79914Z");
    // The hindsight guard accepts the lock and its evaluation as pre-entry support.
    const output = plannedOutput();
    const cites = (refs: string[]) => rejection({ ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: refs } }, facts);
    expect(cites(["originalPlan", `check:${ids.check2}`, `plan:${ids.plan}`])).toBe("ACCEPTED");
    expect(cites(["originalPlan", `journal:${ids.preEntryNote}`])).toBe("HINDSIGHT_CITATION");
    // Control: a check the plan does not name as its evaluation is classified by its own time.
    const unnamed = tradeTimelineReviewContext({ ...input, plan: { ...plan, riskEvaluationId: null } }, CAPTURED);
    expect(timingOf(unnamed, `check:${ids.check2}`)).toMatchObject({ timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
    expect(timingOf(unnamed, `plan:${ids.plan}`)).toMatchObject({ timing: "BEFORE_ENTRY", flags: [] });
  });

  it("includes V1 decisions in the trader's words, classified like any record, without the AI verdict of that time", () => {
    const facts = tradeTimelineReviewContext(plannedInput({
      legacyDecisions: [
        { id: ids.override, decision: "TAKEN", eventType: "MANUAL_OVERRIDE", reason: "Took it anyway: news was priced in.", riskDecision: "BLOCKED", recordedAt: "2026-09-01T06:40:00Z" },
        { id: ids.taken, decision: "TAKEN", eventType: "HUMAN_DECISION", reason: null, riskDecision: "APPROVED", recordedAt: "2026-09-01T08:00:30Z" },
      ],
    }), CAPTURED);
    expect(timingOf(facts, `event:${ids.override}`)).toEqual({
      sourceId: `event:${ids.override}`, kind: "MANUAL_OVERRIDE", timing: "BEFORE_ENTRY", recordedAt: "2026-09-01T06:40:00Z", occurredAt: null, flags: [],
      text: "Took it anyway: news was priced in.", details: { decision: "TAKEN", riskDecision: "BLOCKED" },
    });
    // Recorded after the reported entry time (08:00) but before the entry was recorded (08:01): flagged.
    expect(timingOf(facts, `event:${ids.taken}`)).toMatchObject({ kind: "HUMAN_DECISION", text: "Recorded as taken", timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
    const { preEntryIds } = tradeTimelineAllowedSources(facts);
    expect(preEntryIds).toContain(`event:${ids.override}`);
    expect(preEntryIds).not.toContain(`event:${ids.taken}`);
  });

  it("never marks a live-first record as before entry, even one recorded before the reported entry time", () => {
    const facts = liveFacts();
    expect(facts.timeline.every(item => item.timing !== "BEFORE_ENTRY")).toBe(true);
    expect(facts.timeline.map(item => [item.sourceId, item.timing])).toEqual([
      [`position:${ids.position1}`, "WHILE_LIVE"], [`position:${ids.position2}`, "WHILE_LIVE"], [`journal:${ids.liveNote}`, "WHILE_LIVE"],
      [`close:${ids.live}`, "AFTER_CLOSE"], [`journal:${ids.lesson}`, "AFTER_CLOSE"],
    ]);
    expect(facts.evidence[0].timing).toBe("WHILE_LIVE");
    // Unknown entry time: the position counts as open from trade creation (spec §5.3).
    const unknownEntry = tradeTimelineReviewContext(liveInput({
      trade: { ...liveTrade, entered_at: null },
      journal: [{ id: ids.liveNote, kind: "NOTE", body: "Opened earlier on the phone.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-02T08:00:30Z" }],
    }), CAPTURED);
    expect(timingOf(unknownEntry, `journal:${ids.liveNote}`)).toMatchObject({ timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
  });

  it("keeps plan facts null and the plan sources out of the manifest without a locked plan", () => {
    const facts = liveFacts();
    expect(facts).toMatchObject({ planStatus: "NO_PLAN_RECORDED", origin: "LIVE_FIRST", plan: null, riskVersion: null, deterministic: null });
    expect(facts.sourceRefs.slice(0, 2)).toEqual(["strategy", "execution"]);
    expect(facts.sourceRefs).not.toContain("originalPlan");
    expect(tradeTimelineAllowedSources(facts).preEntryIds).toEqual(["strategy"]);
    expect(facts.execution).toMatchObject({ riskBasisSource: "USER_REPORTED", entryRecordedAt: "2026-09-02T08:00:00Z", currency: "USD" });
  });

  it("sends an explicit allowlist: no written strategy prompt, storage path, user id or earlier AI output; money carries its currency", () => {
    const facts = plannedFacts();
    const json = JSON.stringify(facts);
    expect(facts.strategy).toEqual({ version: "ICT V1.0", rules: { minimum_rr: "3" } });
    expect(json).not.toMatch(/written|storage|user_id|interpretation|raw_output/i);
    expect(facts.plan).toMatchObject({ thesis: THESIS, currency: "USD", nominalRisk: "50", plannedRR: "3" });
    expect(facts.riskVersion).toMatchObject({ currency: "USD", dailyLossCap: "200" });
    expect(facts.deterministic).toMatchObject({ currency: "USD" });
    expect(facts.execution).toMatchObject({ currency: "USD", netPnl: "150", realizedR: "3", riskBasisSource: "LOCKED_PLAN" });
    expect(timingOf(facts, `close:${ids.trade}`)?.details).toEqual({ exitPrice: "1.106", outcome: "WIN", realizedR: "3", netPnl: "150", currency: "USD" });
    expect(facts.tags).toMatchObject({ setupGrade: "A", timing: "AFTER_CLOSE" });
  });

  it("summarises revisions and checks without repeating the locked thesis, and skips rendered or duplicated V1 events", () => {
    const facts = plannedFacts();
    expect(timingOf(facts, `revision:${ids.revision1}`)).toMatchObject({ text: "First idea", details: { revision: 1, thesisMatchesLockedPlan: false, riskPercent: "1" } });
    expect(timingOf(facts, `revision:${ids.revision2}`)).toMatchObject({ text: "Thesis identical to the locked plan.", details: { revision: 2, thesisMatchesLockedPlan: true } });
    const blocking = v1Plan.risk_result.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code);
    expect(timingOf(facts, `check:${ids.check1}`)).toMatchObject({
      text: `Risk check of this revision: ${blocking.length ? "blocked" : "approved"}`,
      details: { revision: 1, checksOfRevision: 3, decision: blocking.length ? "BLOCKED" : "APPROVED", blocking },
    });
    expect(facts.sourceRefs).not.toContain(`event:${ids.legacyOpened}`);
    expect(facts.sourceRefs).not.toContain(`event:${ids.tagNote}`);
    expect(timingOf(facts, `event:${ids.legacyNote}`)).toMatchObject({ kind: "NOTE_ADDED", text: "Price is reacting at the order block.", occurredAt: null });
    expect(timingOf(facts, `execution:${ids.trade}`)).toMatchObject({ occurredAt: "2026-09-01T08:00:00Z", recordedAt: "2026-09-01T08:01:00Z" });
  });

  it("refuses trades it cannot cover instead of silently omitting records", () => {
    const many = Array.from({ length: TIMELINE_REVIEW_LIMITS.timelineItems }, (_, index) => ({
      id: `c1000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "NOTE" as const, body: "Note", details: {}, phase: "LIVE" as const, recordedAt: "2026-09-02T08:30:00Z",
    }));
    expect(() => tradeTimelineReviewContext(liveInput({ journal: many }), CAPTURED)).toThrow(TimelineReviewScopeError);
    const verbose = Array.from({ length: 6 }, (_, index) => ({
      id: `c2000000-0000-4000-8000-00000000000${index}`, kind: "NOTE" as const, body: "x".repeat(4000), details: {}, phase: "LIVE" as const, recordedAt: `2026-09-02T08:3${index}:00Z`,
    }));
    const size = Buffer.byteLength(JSON.stringify(tradeTimelineReviewContext(liveInput({ journal: verbose, evidence: [] }), CAPTURED)));
    expect(size).toBeLessThanOrEqual(maxTimelineFactsBytes(0));
    expect(size).toBeGreaterThan(maxTimelineFactsBytes(4));
    const fourImages = [0, 1, 2, 3].map(index => ({ ...liveInput().evidence[0], id: `e1000000-0000-4000-8000-00000000000${index}` }));
    expect(() => tradeTimelineReviewContext(liveInput({ journal: verbose, evidence: fourImages }), CAPTURED)).toThrow(/Select fewer screenshots/);
    expect(() => tradeTimelineReviewContext(plannedInput({ evidence: [...fourImages, ...fourImages.slice(0, 1)] }), CAPTURED)).toThrow(TimelineReviewScopeError);
  });

  it("requires a closed trade and plan facts that match the origin", () => {
    expect(isClosedTrade({ lifecycle: "LIVE", exited_at: null })).toBe(false);
    expect(() => tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, lifecycle: "LIVE", exited_at: null } }), CAPTURED)).toThrow(/closed/);
    expect(() => tradeTimelineReviewContext(plannedInput({ plan: null }), CAPTURED)).toThrow(/inconsistent/);
    expect(() => tradeTimelineReviewContext(liveInput({ plan: plannedInput().plan }), CAPTURED)).toThrow(/inconsistent/);
  });
});

describe("REVIEW_TRADE_TIMELINE_SOURCES_V1 manifest", () => {
  it("lists fixed, timeline and evidence sources in order with their timing", () => {
    const facts = plannedFacts();
    expect(facts.sourceManifest.version).toBe("REVIEW_TRADE_TIMELINE_SOURCES_V1");
    expect(facts.sourceManifest.sources.slice(0, 6).map(source => [source.id, source.kind, source.path])).toEqual([
      ["originalPlan", "PLAN", "plan"], ["strategy", "STRATEGY", "strategy"], ["riskVersion", "RISK_VERSION", "riskVersion"],
      ["deterministic", "CALCULATIONS", "deterministic"], ["execution", "EXECUTION", "execution"], ["tags", "TAGS", "tags"],
    ]);
    const timeline = facts.sourceManifest.sources.filter(source => source.kind === "TIMELINE");
    expect(timeline.map(source => [source.id, source.path, source.timing])).toEqual(facts.timeline.map((item, index) => [item.sourceId, `timeline[${index}]`, item.timing]));
    expect(facts.sourceManifest.sources.filter(source => source.kind === "EVIDENCE").map(source => source.timing)).toEqual(["BEFORE_ENTRY", "AFTER_CLOSE"]);
    expect(tradeTimelineAllowedSources(facts).preEntryIds).toEqual([
      "originalPlan", "strategy", "riskVersion", "deterministic", `revision:${ids.revision1}`, `check:${ids.check1}`, `revision:${ids.revision2}`,
      `check:${ids.check2}`, `plan:${ids.plan}`, `journal:${ids.preEntryNote}`, `evidence:${ids.preEntryShot}`,
    ]);
  });

  it("survives a JSONB round trip (reordered keys) but fails closed on any tampering", () => {
    const facts = plannedFacts();
    const reordered = JSON.parse(JSON.stringify(facts, (_, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(tradeTimelineAllowedSources(reordered).ids).toEqual(facts.sourceRefs);
    const upgraded = structuredClone(facts);
    upgraded.timeline[upgraded.timeline.length - 1].timing = "BEFORE_ENTRY";
    expect(() => tradeTimelineAllowedSources(upgraded)).toThrow(/does not match/);
    expect(() => tradeTimelineAllowedSources({ ...facts, sourceRefs: [...facts.sourceRefs, "trade:a0000000-0000-4000-8000-000000000009"] })).toThrow(/does not match/);
    expect(() => tradeTimelineSourceManifest({ ...facts, planStatus: "NO_PLAN_RECORDED" })).toThrow(/Plan status/);
    expect(() => tradeTimelineSourceManifest({ ...facts, timeline: [{ ...facts.timeline[0], sourceId: "events" }] })).toThrow();
  });
});

describe("REVIEW_TRADE_TIMELINE_V1 provider contract", () => {
  it("is dispatched through the operation registry and restricts thesis citations to pre-entry sources", () => {
    const facts = plannedFacts();
    const contract = tradeTimelineReviewContract(facts);
    expect(operationContract(operationFor("REVIEW_TRADE_TIMELINE"), facts)).toEqual(contract);
    expect(contract).toMatchObject({ name: "review_trade_timeline_v1", version: REVIEW_TRADE_TIMELINE_CITATIONS_VERSION, instructions: REVIEW_TRADE_TIMELINE_PROMPT });
    const schema = JSON.stringify(contract.schema);
    expect(schema).not.toContain("$schema");
    const enums = [...schema.matchAll(/"enum":(\[[^\]]*\])/g)].map(match => JSON.parse(match[1]) as string[]).filter(values => values.includes("strategy"));
    const { ids: all, preEntryIds } = tradeTimelineAllowedSources(facts);
    expect(enums).toEqual(expect.arrayContaining([all, preEntryIds]));
    expect(enums).toHaveLength(2);
    expect(schema).toContain('"additionalProperties":false');
    for (const rule of ["AFTER_CLOSE items are hindsight", "NO_PLAN_RECORDED", "Never invent motives", "thesisCheck.sourceRefs may cite nothing else"]) {
      expect(REVIEW_TRADE_TIMELINE_PROMPT).toContain(rule);
    }
  });

  it("rejects a manifest that does not match the facts before anything is dispatched", () => {
    const facts = { ...plannedFacts(), sourceRefs: ["execution"] };
    expect(() => tradeTimelineReviewContract(facts)).toThrow(/does not match/);
  });
});

describe("REVIEW_TRADE_TIMELINE_V1 server validation", () => {
  it("accepts grounded outputs for planned and live-first trades", () => {
    expect(validateTradeTimelineReview(plannedOutput(), plannedFacts())).toEqual(plannedOutput());
    expect(validateTradeTimelineReview(liveOutput(), liveFacts())).toEqual(liveOutput());
    expect(validateTradeTimelineReview({ ...liveOutput(), thesisCheck: { ...liveOutput().thesisCheck, assessment: "INSUFFICIENT_EVIDENCE" } }, liveFacts())).toBeTruthy();
  });

  it("is strict about shape and length", () => {
    const facts = plannedFacts();
    const output = plannedOutput();
    expect(rejection({ ...output, decision: "APPROVED" }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, headline: { ...output.headline, text: "x".repeat(241) } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, text: "x".repeat(601) } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, keyLesson: { ...output.keyLesson, text: "x".repeat(301) } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, limitations: ["a", "b", "c", "d"] }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, limitations: ["x".repeat(201)] }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, patterns: Array(4).fill(output.keyLesson) }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, headline: { ...output.headline, sourceRefs: [] } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, headline: { ...output.headline, sourceRefs: ["execution", "tags", "strategy", "originalPlan", "deterministic"] } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, liveManagement: { ...output.liveManagement, assessment: "PERFECT" } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(rejection({ ...output, keyLesson: { ...output.keyLesson, text: "   " } }, facts)).toBe("INVALID_REVIEW_OUTPUT");
    expect(tradeTimelineReviewOutput.safeParse({ ...output, extra: true }).success).toBe(false);
  });

  it.each(["events", "timeline[3]", "trade:a0000000-0000-4000-8000-000000000009", "evidence:e0000000-0000-4000-8000-000000000009", "proposal"])(
    "rejects citation %s outside the manifest",
    ref => {
      const output = plannedOutput();
      expect(rejection({ ...output, executionVsPlan: { ...output.executionVsPlan, sourceRefs: [ref] } }, plannedFacts())).toBe("FOREIGN_REVIEW_SOURCE");
    },
  );

  it.each([
    ["an after-close lesson", `journal:${ids.lesson}`],
    ["a live stop change", `journal:${ids.stopChange}`],
    ["the execution record", "execution"],
    ["the close", `close:${ids.trade}`],
    ["an after-close screenshot", `evidence:${ids.afterCloseShot}`],
    ["tags recorded later", "tags"],
  ])("hindsight guard: the thesis check cannot cite %s", (_label, ref) => {
    const output = plannedOutput();
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: ["originalPlan", ref] } }, plannedFacts())).toBe("HINDSIGHT_CITATION");
  });

  it("hindsight guard follows the computed timing, including back-dated entries", () => {
    const output = plannedOutput();
    const backDated = tradeTimelineReviewContext(plannedInput({ trade: { ...plannedTrade, entered_at: "2026-09-01T07:15:00Z" } }), CAPTURED);
    expect(rejection(output, backDated)).toBe("HINDSIGHT_CITATION");
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: [`evidence:${ids.preEntryShot}`, `revision:${ids.revision1}`, "deterministic"] } }, plannedFacts())).toBe("ACCEPTED");
  });

  it.each([
    ["a consistent thesis", { thesisCheck: { assessment: "CONSISTENT", text: "Held.", sourceRefs: ["strategy"] } }],
    ["a changed thesis", { thesisCheck: { assessment: "CHANGED", text: "Changed.", sourceRefs: ["strategy"] } }],
    ["an aligned execution", { executionVsPlan: { assessment: "ALIGNED", text: "Aligned.", sourceRefs: ["execution"] } }],
    ["a deviation", { executionVsPlan: { assessment: "DEVIATION", text: "Deviated.", sourceRefs: ["execution"] } }],
  ])("NO_PLAN_RECORDED forbids %s", (_label, change) => {
    expect(rejection({ ...liveOutput(), ...change }, liveFacts())).toBe("NO_PLAN_CONTRADICTION");
  });

  it("a live-first review cannot cite plan sources or post-entry records for its thesis", () => {
    const output = liveOutput();
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: ["originalPlan"] } }, liveFacts())).toBe("FOREIGN_REVIEW_SOURCE");
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: [`journal:${ids.lesson}`] } }, liveFacts())).toBe("HINDSIGHT_CITATION");
  });

  it("a locked plan cannot be reviewed as missing", () => {
    const output = plannedOutput();
    expect(rejection({ ...output, executionVsPlan: { ...output.executionVsPlan, assessment: "NO_PLAN" } }, plannedFacts())).toBe("NO_PLAN_CONTRADICTION");
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, assessment: "NOT_RECORDED" } }, plannedFacts())).toBe("NO_PLAN_CONTRADICTION");
    const noThesis = { ...plannedFacts(), plan: { ...plannedFacts().plan, thesis: null } };
    expect(rejection({ ...output, thesisCheck: { ...output.thesisCheck, assessment: "NOT_RECORDED" } }, noThesis)).toBe("ACCEPTED");
  });

  it.each(["Take the trade next time.", "You should ENTER  this trade earlier.", "execute the trade"])("rejects the trading directive %j anywhere", phrase => {
    const output = plannedOutput();
    expect(rejection({ ...output, keyLesson: { ...output.keyLesson, text: phrase } }, plannedFacts())).toBe("TRADING_DIRECTIVE");
    expect(rejection({ ...output, limitations: [phrase] }, plannedFacts())).toBe("TRADING_DIRECTIVE");
    expect(rejection({ ...output, patterns: [{ text: phrase, sourceRefs: ["execution"] }] }, plannedFacts())).toBe("TRADING_DIRECTIVE");
  });
});
