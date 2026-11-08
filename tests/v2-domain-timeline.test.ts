import { describe, expect, it } from "vitest";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import type { ExplainLookup } from "@/domain/risk-explain";
import {
  buildTimeline, type CheckExplainLookup, classifyTiming, evidenceName, groupByTiming, inferStoredPhase, legacyEvidenceLabel, type TimelineInputs, type TimelineLegacyDecision,
  type TimingInput,
} from "@/domain/timeline";

function ledger(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: "00000000-0000-4000-8000-000000000001", account_id: "00000000-0000-4000-8000-000000000002", origin: "PLANNED",
    created_at: "2026-09-04T12:00:00Z", currency: "USD", revision_count: 1, entry_time_known: false, lifecycle: "DRAFT", tags: [],
    evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

const planned = (changes: Partial<TimingInput>): TimingInput => ({ recordedAt: "2026-09-04T12:00:00Z", storedPhase: "PRE_ENTRY", origin: "PLANNED", entryAt: null, exitAt: null, ...changes });

describe("classifyTiming (spec §5.3)", () => {
  it.each([
    ["pre-entry without an entry", planned({}), "BEFORE_ENTRY", []],
    ["pre-entry recorded before the entry", planned({ entryAt: "2026-09-04T12:00:00.000001Z" }), "BEFORE_ENTRY", []],
    ["pre-entry recorded at the entry instant", planned({ entryAt: "2026-09-04T12:00:00Z" }), "WHILE_LIVE", ["RECORDED_AFTER_EXECUTION_BEGAN"]],
    ["pre-entry recorded after a back-dated entry", planned({ recordedAt: "2026-09-04T13:00:00Z", entryAt: "2026-09-04T12:45:00Z" }), "WHILE_LIVE", ["RECORDED_AFTER_EXECUTION_BEGAN"]],
    ["live phase is never upgraded to before entry", planned({ storedPhase: "LIVE", entryAt: "2026-09-04T13:00:00Z" }), "WHILE_LIVE", []],
    ["post-trade phase", planned({ storedPhase: "POST_TRADE" }), "AFTER_CLOSE", []],
    ["recorded at the exit instant", planned({ storedPhase: "LIVE", entryAt: "2026-09-04T11:00:00Z", exitAt: "2026-09-04T12:00:00Z" }), "AFTER_CLOSE", []],
    ["recorded one microsecond before the exit", planned({ storedPhase: "LIVE", entryAt: "2026-09-04T11:00:00Z", exitAt: "2026-09-04T12:00:00.000001Z" }), "WHILE_LIVE", []],
    ["even a pre-entry record after the exit", planned({ entryAt: "2026-09-04T11:00:00Z", exitAt: "2026-09-04T11:30:00Z" }), "AFTER_CLOSE", []],
    ["live-first live record", planned({ origin: "LIVE_FIRST", storedPhase: "LIVE" }), "WHILE_LIVE", []],
    ["live-first never before entry, even mislabelled", planned({ origin: "LIVE_FIRST", entryAt: "2026-09-04T13:00:00Z" }), "WHILE_LIVE", []],
    ["live-first with unknown entry uses the trade creation time", planned({ origin: "LIVE_FIRST", tradeCreatedAt: "2026-09-04T11:00:00Z" }), "WHILE_LIVE", ["RECORDED_AFTER_EXECUTION_BEGAN"]],
    ["imported never before entry", planned({ origin: "IMPORTED", tradeCreatedAt: "2026-09-04T13:00:00Z" }), "WHILE_LIVE", []],
  ] as const)("%s", (_name, input, timing, flags) => {
    expect(classifyTiming(input)).toEqual({ timing, flags });
  });

  it("compares microseconds that Date would merge", () => {
    expect(classifyTiming(planned({ recordedAt: "2026-09-04T12:00:00.000001Z", entryAt: "2026-09-04T12:00:00.000002Z" })).timing).toBe("BEFORE_ENTRY");
    expect(classifyTiming(planned({ recordedAt: "2026-09-04T12:00:00.000002Z", entryAt: "2026-09-04T12:00:00.000001Z" })).timing).toBe("WHILE_LIVE");
    expect(classifyTiming(planned({ recordedAt: "2026-09-04T14:00:00.000001+02:00", entryAt: "2026-09-04T12:00:00.000002Z" })).timing).toBe("BEFORE_ENTRY");
  });

  it("infers the creation phase of records stored without one from server times", () => {
    expect(inferStoredPhase("2026-09-04T12:00:00Z", null, null)).toBe("PRE_ENTRY");
    expect(inferStoredPhase("2026-09-04T12:00:00Z", "2026-09-04T12:00:00.000001Z", null)).toBe("PRE_ENTRY");
    expect(inferStoredPhase("2026-09-04T12:00:00Z", "2026-09-04T12:00:00Z", null)).toBe("LIVE");
    expect(inferStoredPhase("2026-09-04T15:00:00Z", "2026-09-04T12:00:00Z", "2026-09-04T15:00:00Z")).toBe("POST_TRADE");
    // After a plan ended without an entry, like private.trade_phase (§5.2).
    expect(inferStoredPhase("2026-09-04T12:00:00Z", null, null, "2026-09-04T12:00:00Z")).toBe("POST_TRADE");
    expect(inferStoredPhase("2026-09-04T11:59:59.999999Z", null, null, "2026-09-04T12:00:00Z")).toBe("PRE_ENTRY");
  });
});

describe("classifyTiming after a plan ended without an entry (spec §5.2, §5.3)", () => {
  const ENDED = "2026-09-04T12:00:00Z";

  it.each([
    ["stored post-trade after the end, as the database stores it", planned({ storedPhase: "POST_TRADE", endedAt: ENDED }), "AFTER_CLOSE", []],
    ["stored pre-entry at the end instant (an older row): marked, never pre-entry", planned({ endedAt: ENDED }), "AFTER_CLOSE", ["RECORDED_AFTER_PLAN_ENDED"]],
    ["stored pre-entry an hour after the end", planned({ recordedAt: "2026-09-04T13:00:00Z", endedAt: ENDED }), "AFTER_CLOSE", ["RECORDED_AFTER_PLAN_ENDED"]],
    ["recorded one microsecond before the end", planned({ recordedAt: "2026-09-04T11:59:59.999999Z", endedAt: ENDED }), "BEFORE_ENTRY", []],
    ["a plan that has not ended", planned({ recordedAt: "2026-09-04T13:00:00Z", endedAt: null }), "BEFORE_ENTRY", []],
  ] as const)("%s", (_name, input, timing, flags) => {
    expect(classifyTiming(input)).toEqual({ timing, flags });
  });

  it("only ever downgrades: the end time cannot make anything pre-entry", () => {
    expect(classifyTiming(planned({ storedPhase: "POST_TRADE", recordedAt: "2026-09-04T11:00:00Z", endedAt: ENDED }))).toEqual({ timing: "AFTER_CLOSE", flags: [] });
    expect(classifyTiming(planned({ storedPhase: "LIVE", recordedAt: "2026-09-04T11:00:00Z", endedAt: ENDED })).timing).toBe("WHILE_LIVE");
  });
});

describe("evidence naming", () => {
  it("derives legacy labels from the timeframe role and names charts", () => {
    expect(["DAILY", "H4", "H1", "M15", "M5", "OTHER"].map(legacyEvidenceLabel)).toEqual(["HTF", "HTF", "HTF", "OTHER", "OTHER", "OTHER"]);
    expect(evidenceName("PRE_ENTRY", "M5")).toBe("M5 chart");
    expect(evidenceName("HTF", "DAILY")).toBe("Daily chart");
    expect(evidenceName("ENTRY", null)).toBe("Entry screenshot");
    expect(evidenceName(null, null)).toBe("Screenshot");
  });
});

const ID = {
  plan: "00000000-0000-4000-8000-0000000000a1", rev1: "00000000-0000-4000-8000-0000000000b1", rev2: "00000000-0000-4000-8000-0000000000b2",
  check1: "00000000-0000-4000-8000-0000000000c1", check2: "00000000-0000-4000-8000-0000000000c2", note1: "00000000-0000-4000-8000-0000000000d1",
  note2: "00000000-0000-4000-8000-0000000000d2", lockEvent: "00000000-0000-4000-8000-0000000000d3", openEvent: "00000000-0000-4000-8000-0000000000d4",
  tagNote: "00000000-0000-4000-8000-0000000000d5", stop: "00000000-0000-4000-8000-0000000000e1", partial: "00000000-0000-4000-8000-0000000000e2",
  lesson: "00000000-0000-4000-8000-0000000000e3", m5: "00000000-0000-4000-8000-0000000000f1", exitShot: "00000000-0000-4000-8000-0000000000f2",
  h4: "00000000-0000-4000-8000-0000000000f3", tags: "41", ai: "00000000-0000-4000-8000-0000000000a9", reviewed: "00000000-0000-4000-8000-0000000000aa",
  reopened: "00000000-0000-4000-8000-0000000000ab",
};

const closedPlanned = ledger({
  plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0",
  entered_at: "2026-09-04T12:45:00Z", entry_recorded_at: "2026-09-04T13:20:00Z", entry_price: "1.10005", quantity: "1", planned_quantity: "0.25", oversize: true,
  exited_at: "2026-09-04T15:00:00Z", close_recorded_at: "2026-09-04T15:05:00Z", exit_price: "1.10345", realized_r: "3.4", net_pnl: "340", outcome: "WIN",
});

const RISK_PLAN_V10 = "00000000-0000-4000-8000-0000000000e8";
const RISK_PLAN_V11 = "00000000-0000-4000-8000-0000000000e9";

/** A stored V1 (engine 1.0) report blocked by RISK_LIMIT under the given risk plan version. */
function blockedV1Report(riskPlanVersionId: string, evaluatedAt: string) {
  return {
    engineVersion: "1.0", evaluatedAt, tradingDay: evaluatedAt.slice(0, 10), session: "ACTIVE_KILL_ZONE",
    strategyVersionId: "00000000-0000-4000-8000-000000000001", riskPlanVersionId, status: "TRADE_BLOCKED",
    issues: [
      { code: "RISK_LIMIT", severity: "BLOCK", message: "Requested risk exceeds the risk-plan maximum." },
      { code: "COSTS_UNKNOWN", severity: "WARN", message: "Sizing reflects nominal stop risk; fees, gaps and slippage are not included." },
    ],
    calculations: { budget: "100.00", permittedRisk: "50.00", stopDistance: "0.002", stopTicks: "200", stopPips: "20.0000", plannedRR: "3.00000000", quantity: "0.5", nominalRisk: "100", plannedReward: "300" },
  };
}

const riskPlanRow = (id: string, maxRiskPercent: string): NonNullable<ExplainLookup["riskPlan"]> => ({
  id, maxRiskPercent, minRR: "3", dailyRiskCap: null, dailyLossCap: null, rrPolicy: "BLOCK", newsPolicy: "WARN", maxDailyTrades: 2,
});

/** The loader's resolver: rows keyed by the report's risk plan version and the check's proposal. */
function lookupFrom(plans: Record<string, NonNullable<ExplainLookup["riskPlan"]>>, proposals: Record<string, { riskPercent: string }>): CheckExplainLookup {
  return (check, report) => {
    const riskPlan = Object.hasOwn(plans, report.riskPlanVersionId) ? plans[report.riskPlanVersionId] : undefined;
    const proposal = check.proposalId !== undefined && Object.hasOwn(proposals, check.proposalId) ? proposals[check.proposalId] : undefined;
    return riskPlan || proposal ? { riskPlan, proposal } : undefined;
  };
}

const plannedInputs: TimelineInputs = {
  trade: closedPlanned,
  instrument: { tickSize: "0.00001", quantityStep: "0.01", quantityUnit: "lots (100,000 EUR)" },
  revisions: [{ proposalId: ID.rev1, revision: 1, createdAt: "2026-09-04T12:00:00Z" }, { proposalId: ID.rev2, revision: 2, createdAt: "2026-09-04T12:20:00Z" }],
  riskChecks: [
    { id: ID.check1, proposalId: ID.rev1, recordedAt: "2026-09-04T12:05:00Z", decision: "BLOCKED", result: blockedV1Report(RISK_PLAN_V11, "2026-09-04T12:05:00Z") },
    { id: ID.check2, proposalId: ID.rev2, recordedAt: "2026-09-04T12:25:00Z", decision: "APPROVED", result: { not: "a report" } },
  ],
  legacyEvents: [
    { id: ID.lockEvent, eventType: "PLAN_LOCKED", payload: {}, occurredAt: "2026-09-04T12:30:00Z", recordedAt: "2026-09-04T12:30:00Z" },
    { id: ID.note1, eventType: "NOTE_ADDED", payload: { note: "Waiting for the first touch." }, occurredAt: "2026-09-04T12:40:00Z", recordedAt: "2026-09-04T12:40:00Z" },
    { id: ID.openEvent, eventType: "TRADE_OPENED", payload: { entry_price: "1.10005" }, occurredAt: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T13:20:00Z" },
    { id: ID.note2, eventType: "NOTE_ADDED", payload: { note: "Entered on the touch." }, occurredAt: "2026-09-04T13:00:00Z", recordedAt: "2026-09-04T13:00:00Z" },
    { id: ID.tagNote, eventType: "NOTE_ADDED", payload: { note: "Manual structured tags recorded", setup_grade: "A", source: "MANUAL" }, occurredAt: "2026-09-04T15:20:00Z", recordedAt: "2026-09-04T15:20:00Z" },
  ],
  journal: [
    { id: ID.stop, kind: "STOP_CHANGE", body: null, details: { price: "1.0995" }, phase: "LIVE", recordedAt: "2026-09-04T13:30:00Z" },
    { id: ID.partial, kind: "PARTIAL_CLOSE", body: "Took half at the first target.", details: { percent: "50", price: "1.103" }, phase: "LIVE", recordedAt: "2026-09-04T13:40:00Z" },
    { id: ID.lesson, kind: "LESSON", body: "Wait for displacement.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-04T15:30:00Z" },
  ],
  evidence: [
    { kind: "V2", id: ID.m5, label: "PRE_ENTRY", timeframe: "M5", caption: "Sweep of the Asia low", phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:22:00Z" },
    { kind: "V2", id: ID.exitShot, label: "EXIT", timeframe: null, phase: "POST_TRADE", recordedAt: "2026-09-04T15:10:00Z" },
    { kind: "LEGACY", id: ID.h4, role: "H4", recordedAt: "2026-09-04T12:10:00Z", removedAt: "2026-09-04T12:15:00Z" },
  ],
  tagSets: [{ id: ID.tags, source: "V2", recordedAt: "2026-09-04T15:20:00Z", setupGrade: "A", liquidityContext: "PDH", mssTimeframe: "M5", tags: ["london"] }],
  aiAnalyses: [{ id: ID.ai, operation: "ANALYZE_SETUP", status: "COMPLETED", recordedAt: "2026-09-04T12:26:00Z", summary: "The structure is clearly recorded." }],
  lifecycleEvents: [
    { id: ID.reviewed, event: "REVIEW_COMPLETED", reason: null, recordedAt: "2026-09-04T16:00:00Z" },
    { id: ID.reopened, event: "REVIEW_REOPENED", reason: "Add the exit reasoning.", recordedAt: "2026-09-04T16:30:00Z" },
  ],
  explainLookup: lookupFrom({ [RISK_PLAN_V11]: riskPlanRow(RISK_PLAN_V11, "0.5") }, { [ID.rev1]: { riskPercent: "1" } }),
};

describe("buildTimeline (spec §5.4)", () => {
  const items = buildTimeline(plannedInputs);
  const byId = Object.fromEntries(items.map(item => [item.id, item]));

  it("assembles every source in (at, recordedAt, id) order", () => {
    expect(items.map(item => [item.kind, item.title])).toEqual([
      ["DRAFT_REVISION", "Draft created"],
      ["RISK_CHECK", "Risk check: Blocked"],
      ["EVIDENCE_ADDED", "H4 chart added"],
      ["EVIDENCE_REMOVED", "H4 chart removed"],
      ["DRAFT_REVISION", "Draft revised · revision 2"],
      ["EVIDENCE_ADDED", "M5 chart added"],
      ["RISK_CHECK", "Risk check: Approved"],
      ["AI_ANALYSIS", "Analyze Setup · Completed"],
      ["PLAN_LOCKED", "Plan locked"],
      ["NOTE", "Note"],
      ["ENTRY", "Trade opened"],
      ["SIZE_DEVIATION", "Size above plan: 1.00 vs 0.25 lots"],
      ["NOTE", "Note"],
      ["JOURNAL", "Stop moved to 1.09950"],
      ["JOURNAL", "Partial close · 50% at 1.10300"],
      ["CLOSE", "Trade closed: +3.40R"],
      ["EVIDENCE_ADDED", "Exit screenshot added"],
      ["TAGS", "Tags updated"],
      ["JOURNAL", "Lesson"],
      ["REVIEW_COMPLETED", "Review completed"],
      ["REVIEW_REOPENED", "Review reopened"],
    ]);
  });

  it("explains the first blocking reason of a risk check", () => {
    expect(byId[`check:${ID.check1}`].body).toBe("Requested risk 1.00% exceeds your configured maximum of 0.50%.");
    expect(byId[`check:${ID.check2}`].body).toBeUndefined();
  });

  it("explains each check with the rows of its own risk plan version and proposal", () => {
    const resolved: string[] = [];
    const lookup = lookupFrom({ [RISK_PLAN_V10]: riskPlanRow(RISK_PLAN_V10, "1"), [RISK_PLAN_V11]: riskPlanRow(RISK_PLAN_V11, "0.5") }, { [ID.rev1]: { riskPercent: "1.5" }, [ID.rev2]: { riskPercent: "1" } });
    const items = buildTimeline({
      trade: ledger({ created_at: "2026-09-03T12:00:00Z" }),
      riskChecks: [
        { id: ID.check1, proposalId: ID.rev1, recordedAt: "2026-09-03T13:00:00Z", decision: "BLOCKED", result: blockedV1Report(RISK_PLAN_V10, "2026-09-03T13:00:00Z") },
        { id: ID.check2, proposalId: ID.rev2, recordedAt: "2026-09-04T12:05:00Z", decision: "BLOCKED", result: blockedV1Report(RISK_PLAN_V11, "2026-09-04T12:05:00Z") },
      ],
      explainLookup: (check, report) => {
        resolved.push(`${check.id}:${report.riskPlanVersionId}`);
        return lookup(check, report);
      },
    });
    expect(items.map(item => item.body)).toEqual([
      "Requested risk 1.50% exceeds your configured maximum of 1.00%.",
      "Requested risk 1.00% exceeds your configured maximum of 0.50%.",
    ]);
    expect(resolved).toEqual([`${ID.check1}:${RISK_PLAN_V10}`, `${ID.check2}:${RISK_PLAN_V11}`]);
  });

  it("falls back to the generic sentence without rows of the check's own version", () => {
    const check = { id: ID.check1, proposalId: ID.rev1, recordedAt: "2026-09-03T13:00:00Z", decision: "BLOCKED" as const, result: blockedV1Report(RISK_PLAN_V10, "2026-09-03T13:00:00Z") };
    const body = (explainLookup?: CheckExplainLookup) => buildTimeline({ trade: ledger({ created_at: "2026-09-03T12:00:00Z" }), riskChecks: [check], explainLookup })[0].body;
    expect(body()).toBe("Requested risk exceeds your configured maximum.");
    expect(body(() => undefined)).toBe("Requested risk exceeds your configured maximum.");
    // Even a careless resolver cannot attach another version's numbers: rows name their version.
    expect(body(() => ({ riskPlan: riskPlanRow(RISK_PLAN_V11, "0.5"), proposal: { riskPercent: "1.5" } }))).toBe("Requested risk 1.50% exceeds your configured maximum.");
  });

  it("uses user-reported entry and exit times and shows late recording", () => {
    const entry = byId[`entry:${closedPlanned.id}`];
    expect(entry).toMatchObject({ at: "2026-09-04T12:45:00Z", recordedAt: "2026-09-04T13:20:00Z", timeLabel: "07:45 · recorded 08:20", body: "Entry 1.10005 · 1.00 lots" });
    expect(byId[`close:${closedPlanned.id}`]).toMatchObject({ at: "2026-09-04T15:00:00Z", timeLabel: "10:00", body: "Exit 1.10345", timing: "AFTER_CLOSE" });
    expect(byId[`journal:${ID.stop}`].timeLabel).toBe("08:30");
  });

  it("classifies each record and flags notes recorded after a back-dated entry", () => {
    const timing = (id: string) => [byId[id].timing, byId[id].flags];
    expect(timing(`revision:${ID.rev1}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`plan:${ID.plan}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`evidence-added:${ID.h4}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`evidence-added:${ID.m5}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`event:${ID.note1}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(`event:${ID.note2}`)).toEqual(["WHILE_LIVE", ["RECORDED_AFTER_EXECUTION_BEGAN"]]);
    expect(timing(`entry:${closedPlanned.id}`)).toEqual(["WHILE_LIVE", []]);
    expect(timing(`journal:${ID.partial}`)).toEqual(["WHILE_LIVE", []]);
    expect(timing(`evidence-added:${ID.exitShot}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(`tags:V2:${ID.tags}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(`journal:${ID.lesson}`)).toEqual(["AFTER_CLOSE", []]);
  });

  it("does not duplicate records that other rows render", () => {
    expect(items.some(item => item.source === `event:${ID.lockEvent}` || item.source === `event:${ID.openEvent}` || item.source === `event:${ID.tagNote}`)).toBe(false);
  });

  it("carries bodies, details and canonical sources", () => {
    expect(byId[`event:${ID.note1}`]).toMatchObject({ body: "Waiting for the first touch.", source: `event:${ID.note1}` });
    expect(byId[`journal:${ID.partial}`]).toMatchObject({ journalKind: "PARTIAL_CLOSE", body: "Took half at the first target.", details: { percent: "50", price: "1.103" } });
    expect(byId[`evidence-added:${ID.m5}`]).toMatchObject({ body: "Sweep of the Asia low", evidenceId: ID.m5, source: `evidence:${ID.m5}` });
    expect(byId[`tags:V2:${ID.tags}`].body).toBe("Grade A · PDH · MSS M5 · london");
    expect(byId[`plan:${ID.plan}`].body).toBe("Risk Plan V1.0 · ICT V1.0");
    expect(byId[`ai:${ID.ai}`].body).toBe("The structure is clearly recorded.");
    expect(byId[`lifecycle:${ID.reopened}`].body).toBe("Add the exit reasoning.");
  });

  it("groups into the three bands in order", () => {
    const groups = groupByTiming(items);
    expect(groups.map(group => [group.label, group.items.length])).toEqual([["Before entry", 10], ["While live", 5], ["After close", 6]]);
    expect(groupByTiming([]).map(group => group.items)).toEqual([[], [], []]);
  });

  it("renders local and UTC times on request", () => {
    const utc = buildTimeline(plannedInputs, { mode: "utc" });
    expect(utc.find(item => item.kind === "ENTRY")?.timeLabel).toBe("12:45 · recorded 13:20");
    const lateEntry = { ...closedPlanned, entered_at: "2026-09-04T21:00:00Z", entry_recorded_at: "2026-09-05T02:00:00Z" };
    expect(buildTimeline({ trade: lateEntry }).find(item => item.kind === "ENTRY")?.timeLabel).toBe("16:00 · recorded 21:00");
    // Recorded on another day: both times carry their day, so the entry is never read as made on the recording day.
    expect(buildTimeline({ trade: lateEntry }, { mode: "utc" }).find(item => item.kind === "ENTRY")?.timeLabel).toBe("Sep 4, 21:00 · recorded Sep 5, 02:00");
    const imported = ledger({ origin: "IMPORTED", created_at: "2026-10-31T01:34:00Z", entered_at: "2026-09-15T08:15:00Z", entry_recorded_at: "2026-10-31T01:34:00Z" });
    expect(buildTimeline({ trade: imported }).find(item => item.kind === "ENTRY")?.timeLabel).toBe("Sep 15, 03:15 · recorded Oct 30, 20:34");
  });

  it("orders equal times by id deterministically, whatever the input order", () => {
    const shuffled = { ...plannedInputs, journal: [...(plannedInputs.journal ?? [])].reverse(), evidence: [...(plannedInputs.evidence ?? [])].reverse(), legacyEvents: [...(plannedInputs.legacyEvents ?? [])].reverse() };
    expect(buildTimeline(shuffled).map(item => item.id)).toEqual(items.map(item => item.id));
  });

  it("renders a disposition once and V1 cancellations only without one", () => {
    const lockedOnly = ledger({ plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z" });
    const cancelEvent = { id: ID.note1, eventType: "PLAN_CANCELLED", payload: { reason: "News" }, occurredAt: "2026-09-04T13:00:00Z", recordedAt: "2026-09-04T13:00:00Z" };
    const withoutDisposition = buildTimeline({ trade: lockedOnly, legacyEvents: [cancelEvent] });
    expect(withoutDisposition.map(item => [item.title, item.body])).toEqual([["Plan locked", undefined], ["Plan cancelled", "News"]]);
    const withDisposition = buildTimeline({ trade: lockedOnly, legacyEvents: [cancelEvent], disposition: { status: "SKIPPED", reason: "News", recordedAt: "2026-09-04T13:00:00Z" } });
    expect(withDisposition.map(item => [item.title, item.body])).toEqual([["Plan locked", undefined], ["Trade skipped", "News"]]);
  });
});

describe("timeline of a plan that ended without an entry (spec §5.3)", () => {
  const SKIPPED_AT = "2026-09-04T13:00:00Z";
  const skipped = ledger({ plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", lifecycle: "SKIPPED", disposition: "SKIPPED" });
  const inputs: TimelineInputs = {
    trade: skipped,
    revisions: [{ proposalId: ID.rev1, revision: 1, createdAt: "2026-09-04T12:00:00Z" }],
    legacyEvents: [{ id: ID.note1, eventType: "NOTE_ADDED", payload: { note: "Price ran without me." }, occurredAt: "2026-09-04T13:20:00Z", recordedAt: "2026-09-04T13:20:00Z" }],
    journal: [
      { id: ID.stop, kind: "NOTE", body: "Waiting for the retest.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:40:00Z" },
      { id: ID.lesson, kind: "LESSON", body: "The skip cost a winner.", details: {}, phase: "POST_TRADE", recordedAt: "2026-09-04T13:10:00Z" },
      // Stored before the database stored such records post-trade.
      { id: ID.partial, kind: "NOTE", body: "Where price went.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-04T13:15:00Z" },
    ],
    evidence: [
      { kind: "V2", id: ID.m5, label: "PRE_ENTRY", timeframe: "M5", phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:45:00Z", removedAt: "2026-09-04T13:30:00Z" },
      { kind: "V2", id: ID.exitShot, label: "OTHER", timeframe: "M15", phase: "POST_TRADE", recordedAt: "2026-09-04T13:05:00Z" },
      { kind: "LEGACY", id: ID.h4, role: "H4", recordedAt: "2026-09-04T13:25:00Z" },
    ],
    tagSets: [{ id: ID.tags, source: "V2", recordedAt: "2026-09-04T13:40:00Z", setupGrade: "C", liquidityContext: null, mssTimeframe: null, tags: ["missed"] }],
    disposition: { status: "SKIPPED", reason: "No retest.", recordedAt: SKIPPED_AT },
    planEndedAt: SKIPPED_AT,
  };
  const timing = (items: ReturnType<typeof buildTimeline>, id: string) => {
    const item = items.find(entry => entry.id === id);
    return item ? [item.timing, item.flags] : null;
  };

  it("keeps the skip with what came before it and moves everything recorded afterwards to After close", () => {
    const items = buildTimeline(inputs);
    expect(timing(items, `journal:${ID.stop}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(items, `evidence-added:${ID.m5}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(items, `disposition:${skipped.id}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(items, `journal:${ID.lesson}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(items, `evidence-added:${ID.exitShot}`)).toEqual(["AFTER_CLOSE", []]);
    // A stored phase that contradicts the end is kept and marked, never rewritten.
    expect(timing(items, `journal:${ID.partial}`)).toEqual(["AFTER_CLOSE", ["RECORDED_AFTER_PLAN_ENDED"]]);
    // Records without a stored phase (V1 notes, legacy screenshots, removals, tags) are dated by the end, unmarked.
    expect(timing(items, `event:${ID.note1}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(items, `evidence-added:${ID.h4}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(items, `evidence-removed:${ID.m5}`)).toEqual(["AFTER_CLOSE", []]);
    expect(timing(items, `tags:V2:${ID.tags}`)).toEqual(["AFTER_CLOSE", []]);
    expect(groupByTiming(items).map(group => [group.label, group.items.map(item => item.kind)])).toEqual([
      ["Before entry", ["DRAFT_REVISION", "PLAN_LOCKED", "JOURNAL", "EVIDENCE_ADDED", "DISPOSITION"]],
      ["While live", []],
      ["After close", ["EVIDENCE_ADDED", "JOURNAL", "JOURNAL", "NOTE", "EVIDENCE_ADDED", "EVIDENCE_REMOVED", "TAGS"]],
    ]);
  });

  it("classifies by the stored phase alone without an end time, and ignores an end time on trades without a plan", () => {
    const loose = buildTimeline({ ...inputs, planEndedAt: null });
    expect(timing(loose, `journal:${ID.partial}`)).toEqual(["BEFORE_ENTRY", []]);
    expect(timing(loose, `journal:${ID.lesson}`)).toEqual(["AFTER_CLOSE", []]);
    const liveFirst = ledger({ origin: "LIVE_FIRST", revision_count: 0, created_at: "2026-09-04T12:00:00Z", entry_recorded_at: "2026-09-04T12:00:00Z", lifecycle: "LIVE" });
    const items = buildTimeline({ trade: liveFirst, journal: [{ id: ID.note2, kind: "NOTE", body: "Open.", details: {}, phase: "LIVE", recordedAt: "2026-09-04T13:30:00Z" }], planEndedAt: SKIPPED_AT });
    expect(timing(items, `journal:${ID.note2}`)).toEqual(["WHILE_LIVE", []]);
  });

  it("keeps a discard with what came before it", () => {
    const discarded = ledger({ lifecycle: "DISCARDED", discarded_at: "2026-09-04T12:30:00Z" });
    const items = buildTimeline({
      trade: discarded,
      journal: [{ id: ID.note2, kind: "NOTE", body: "Dropped.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-09-04T12:31:00Z" }],
      lifecycleEvents: [{ id: ID.reviewed, event: "DRAFT_DISCARDED", reason: "Stale idea.", recordedAt: "2026-09-04T12:30:00Z" }],
      planEndedAt: "2026-09-04T12:30:00Z",
    });
    expect(items.map(item => [item.kind, item.timing, item.flags])).toEqual([
      ["DRAFT_DISCARDED", "BEFORE_ENTRY", []], ["JOURNAL", "AFTER_CLOSE", ["RECORDED_AFTER_PLAN_ENDED"]],
    ]);
  });
});

describe("decisions recorded in V1 (setup_human_decisions)", () => {
  const DECIDED = {
    skipEarly: "00000000-0000-4000-8000-000000000401", taken: "00000000-0000-4000-8000-000000000402", skip: "00000000-0000-4000-8000-000000000403",
    override: "00000000-0000-4000-8000-000000000404", late: "00000000-0000-4000-8000-000000000405",
  };
  const decision = (id: string, changes: Partial<TimelineLegacyDecision>): TimelineLegacyDecision => ({
    id, decision: "SKIPPED", eventType: "HUMAN_DECISION", reason: null, riskDecision: "APPROVED", aiDecision: "NOT_EVALUATED", recordedAt: "2026-09-04T12:30:00Z", ...changes,
  });
  const SKIPPED_AT = "2026-09-04T13:00:00Z";
  const skippedDraft = ledger({ lifecycle: "SKIPPED", legacy_decision: "SKIPPED" });

  it("shows each decision with the trader's reason, and keeps the skip that ended the plan Before entry", () => {
    const items = buildTimeline({
      trade: skippedDraft,
      revisions: [{ proposalId: ID.rev1, revision: 1, createdAt: "2026-09-04T12:00:00Z" }],
      legacyDecisions: [
        decision(DECIDED.skip, { reason: "Spread widened to 3 pips at the London open, so I passed on it.", riskDecision: "BLOCKED", recordedAt: SKIPPED_AT }),
        decision(DECIDED.skipEarly, { recordedAt: "2026-09-04T12:10:00Z" }),
        decision(DECIDED.taken, { decision: "TAKEN", reason: "   ", recordedAt: "2026-09-04T12:20:00Z" }),
      ],
      // A V1 screenshot of where price went, uploaded after the skip.
      evidence: [{ kind: "LEGACY", id: ID.h4, role: "H4", recordedAt: "2026-09-04T13:20:00Z" }],
      planEndedAt: SKIPPED_AT,
    });
    expect(items.map(item => [item.kind, item.title, item.body ?? null, item.timing, item.flags])).toEqual([
      ["DRAFT_REVISION", "Draft created", null, "BEFORE_ENTRY", []],
      ["LEGACY_DECISION", "Decision: Skipped", null, "BEFORE_ENTRY", []],
      ["LEGACY_DECISION", "Decision: Taken", null, "BEFORE_ENTRY", []],
      ["LEGACY_DECISION", "Decision: Skipped", "Spread widened to 3 pips at the London open, so I passed on it.", "BEFORE_ENTRY", []],
      ["EVIDENCE_ADDED", "H4 chart added", null, "AFTER_CLOSE", []],
    ]);
    // V1 records share the `event:` source; the verdicts it was recorded against stay in the item's details.
    expect(items[3]).toMatchObject({
      id: `event:${DECIDED.skip}`, source: `event:${DECIDED.skip}`, at: SKIPPED_AT, recordedAt: SKIPPED_AT,
      details: { decision: "SKIPPED", eventType: "HUMAN_DECISION", riskDecision: "BLOCKED", aiDecision: "NOT_EVALUATED" },
    });
  });

  it("says Taken despite a block for a V1 manual override, and classifies decisions by their recording time", () => {
    const live = ledger({
      plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", lifecycle: "LIVE", legacy_decision: "TAKEN", entered_at: "2026-09-04T12:45:00Z",
      entry_recorded_at: "2026-09-04T13:20:00Z", entry_price: "1.1",
    });
    const items = buildTimeline({
      trade: live,
      legacyDecisions: [
        decision(DECIDED.override, { decision: "TAKEN", eventType: "MANUAL_OVERRIDE", reason: "Took it anyway: news was priced in.", riskDecision: "BLOCKED", aiDecision: "BLOCKED", recordedAt: "2026-09-04T12:25:00Z" }),
        // Recorded after the reported (earlier) entry time but before the entry was recorded: flagged like any such record.
        decision(DECIDED.late, { decision: "TAKEN", recordedAt: "2026-09-04T12:50:00Z" }),
      ],
    });
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    expect(byId[`event:${DECIDED.override}`]).toMatchObject({
      kind: "LEGACY_DECISION", title: "Taken despite a block", body: "Took it anyway: news was priced in.", timing: "BEFORE_ENTRY", flags: [],
      details: { decision: "TAKEN", eventType: "MANUAL_OVERRIDE", riskDecision: "BLOCKED", aiDecision: "BLOCKED" },
    });
    expect(byId[`event:${DECIDED.late}`]).toMatchObject({ title: "Decision: Taken", timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
  });

  it("moves a decision recorded after a plan ended some other way to After close", () => {
    const cancelled = ledger({ plan_id: ID.plan, locked_at: "2026-09-04T12:30:00Z", lifecycle: "CANCELLED", disposition: "CANCELLED", legacy_decision: "SKIPPED" });
    const items = buildTimeline({
      trade: cancelled,
      disposition: { status: "CANCELLED", reason: "News.", recordedAt: "2026-09-04T12:40:00Z" },
      legacyDecisions: [decision(DECIDED.skip, { recordedAt: SKIPPED_AT })],
      planEndedAt: "2026-09-04T12:40:00Z",
    });
    expect(items.map(item => [item.kind, item.timing, item.flags])).toEqual([
      ["PLAN_LOCKED", "BEFORE_ENTRY", []], ["DISPOSITION", "BEFORE_ENTRY", []], ["LEGACY_DECISION", "AFTER_CLOSE", []],
    ]);
  });
});

describe("decision history in causal order (spec §5.4)", () => {
  const PROP1 = "00000000-0000-4000-8000-000000000101";
  const PROP2 = "00000000-0000-4000-8000-000000000102";
  const EVAL_SAVE1 = "00000000-0000-4000-8000-000000000201";
  const EVAL_MANUAL = "00000000-0000-4000-8000-000000000202";
  const EVAL_SAVE2 = "00000000-0000-4000-8000-000000000203";
  const EVAL_LOCK = "00000000-0000-4000-8000-000000000204";
  // Gaps measured on the database: a save writes its check ~10 ms before the revision row; a lock stamps locked_at with
  // the evaluation time and writes the evaluation row ~17 ms later.
  const locked = ledger({ plan_id: ID.plan, locked_at: "2026-10-24T15:02:54.608822+00:00", lifecycle: "LOCKED", created_at: "2026-10-24T15:02:46.061371+00:00" });
  const inputs: TimelineInputs = {
    trade: locked,
    revisions: [
      { proposalId: PROP1, revision: 1, createdAt: "2026-10-24T15:02:46.061371+00:00" },
      { proposalId: PROP2, revision: 2, createdAt: "2026-10-24T15:02:50.568811+00:00" },
    ],
    riskChecks: [
      { id: EVAL_SAVE1, proposalId: PROP1, recordedAt: "2026-10-24T15:02:46.051594+00:00", decision: "BLOCKED" },
      { id: EVAL_MANUAL, proposalId: PROP1, recordedAt: "2026-10-24T15:02:48.000000+00:00", decision: "BLOCKED" },
      { id: EVAL_SAVE2, proposalId: PROP2, recordedAt: "2026-10-24T15:02:50.566225+00:00", decision: "APPROVED" },
      { id: EVAL_LOCK, proposalId: PROP2, recordedAt: "2026-10-24T15:02:54.626000+00:00", decision: "APPROVED" },
    ],
    lockEvaluationId: EVAL_LOCK,
  };

  it("shows each saved revision before its own check, and the evaluation that authorised the lock right before the lock", () => {
    expect(buildTimeline(inputs).map(item => item.id)).toEqual([
      `revision:${PROP1}`, `check:${EVAL_SAVE1}`, `check:${EVAL_MANUAL}`, `revision:${PROP2}`, `check:${EVAL_SAVE2}`, `check:${EVAL_LOCK}`, `plan:${ID.plan}`,
    ]);
  });

  it("never changes the times it shows, and keeps time order for everything else", () => {
    const items = buildTimeline(inputs);
    expect(items.find(item => item.id === `check:${EVAL_LOCK}`)).toMatchObject({ at: "2026-10-24T15:02:54.626000+00:00", recordedAt: "2026-10-24T15:02:54.626000+00:00" });
    // Without knowing which evaluation authorised the lock, or which revision a check evaluated, time order stands.
    expect(buildTimeline({ ...inputs, lockEvaluationId: null }).slice(-2).map(item => item.id)).toEqual([`plan:${ID.plan}`, `check:${EVAL_LOCK}`]);
    const anonymous = (inputs.riskChecks ?? []).map(({ proposalId: _proposal, ...check }) => check);
    expect(buildTimeline({ ...inputs, riskChecks: anonymous }).slice(0, 2).map(item => item.id)).toEqual([`check:${EVAL_SAVE1}`, `revision:${PROP1}`]);
    // A check recorded after its revision (an explicit check) stays where its time puts it, as does a lock evaluation
    // recorded before the lock.
    const early = { ...inputs, riskChecks: [{ id: EVAL_LOCK, proposalId: PROP2, recordedAt: "2026-10-24T15:02:54.600000+00:00", decision: "APPROVED" as const }] };
    expect(buildTimeline(early).slice(-2).map(item => item.id)).toEqual([`check:${EVAL_LOCK}`, `plan:${ID.plan}`]);
  });

  it("keeps the lock and the evaluation that authorised it Before entry when the entry is reported at the lock instant", () => {
    // An "Earlier" entry typed in the lock's minute is stored at locked_at itself (the database accepts entered_at =
    // locked_at); the lock's evaluation is written ~17 ms after locked_at. A note stored pre-entry after that entry
    // time is still flagged: only the records of the lock itself precede every entry by definition.
    const note = "00000000-0000-4000-8000-000000000301";
    const live = {
      ...locked, lifecycle: "LIVE" as const, entered_at: locked.locked_at, entry_recorded_at: "2026-10-24T15:09:00.000000+00:00", entry_price: "1.1", quantity: "0.5",
    };
    const items = buildTimeline({
      ...inputs, trade: live,
      journal: [{ id: note, kind: "NOTE", body: "Filled on the retest.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-10-24T15:05:00.000000+00:00" }],
    });
    expect(groupByTiming(items).map(group => [group.label, group.items.map(item => [item.id, item.flags])])).toEqual([
      ["Before entry", [
        [`revision:${PROP1}`, []], [`check:${EVAL_SAVE1}`, []], [`check:${EVAL_MANUAL}`, []], [`revision:${PROP2}`, []], [`check:${EVAL_SAVE2}`, []],
        [`check:${EVAL_LOCK}`, []], [`plan:${ID.plan}`, []],
      ]],
      ["While live", [[`entry:${live.id}`, []], [`journal:${note}`, ["RECORDED_AFTER_EXECUTION_BEGAN"]]]],
      ["After close", []],
    ]);
    // The evaluation keeps the time it was recorded; only its band and place follow the lock.
    expect(items.find(item => item.id === `check:${EVAL_LOCK}`)).toMatchObject({ at: "2026-10-24T15:02:54.626000+00:00", title: "Risk check: Approved" });
    // Control: a check nothing names as the lock's evaluation is classified by its own time.
    const unnamed = buildTimeline({ ...inputs, trade: live, lockEvaluationId: null });
    expect(unnamed.find(item => item.id === `check:${EVAL_LOCK}`)).toMatchObject({ timing: "WHILE_LIVE", flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] });
    expect(unnamed.find(item => item.id === `plan:${ID.plan}`)).toMatchObject({ timing: "BEFORE_ENTRY", flags: [] });
  });

  it("orders seeded records written at one instant causally too, deterministically", () => {
    const at = "2026-10-23T07:24:00Z";
    const items = buildTimeline({
      trade: ledger({ created_at: at }),
      revisions: [{ proposalId: PROP1, revision: 1, createdAt: at }],
      riskChecks: [{ id: EVAL_SAVE1, proposalId: PROP1, recordedAt: at, decision: "APPROVED" }],
    });
    expect(items.map(item => item.kind)).toEqual(["DRAFT_REVISION", "RISK_CHECK"]);
  });
});

describe("live-first timeline", () => {
  const liveFirst = ledger({
    origin: "LIVE_FIRST", revision_count: 0, created_at: "2026-09-04T13:00:00Z", entry_recorded_at: "2026-09-04T13:00:00Z",
    exited_at: "2026-09-04T14:00:00Z", close_recorded_at: "2026-09-04T14:01:00Z", net_pnl: "-20", outcome: "LOSS",
  });
  const items = buildTimeline({
    trade: liveFirst,
    journal: [
      { id: ID.note1, kind: "NOTE", body: "Already in; adding notes.", details: {}, phase: "LIVE", recordedAt: "2026-09-04T13:10:00Z" },
      { id: ID.note2, kind: "DECISION", body: "Closing before news.", details: {}, phase: "LIVE", recordedAt: "2026-09-04T13:59:00Z" },
      { id: ID.lesson, kind: "NOTE", body: "Should have waited.", details: {}, phase: "LIVE", recordedAt: "2026-09-04T14:00:30Z" },
    ],
    evidence: [{ kind: "V2", id: ID.m5, label: "MANAGEMENT", timeframe: "M5", phase: "LIVE", recordedAt: "2026-09-04T13:20:00Z" }],
  });

  it("starts at creation when the entry time is unknown and never shows pre-entry items", () => {
    expect(items[0]).toMatchObject({ kind: "ENTRY", at: "2026-09-04T13:00:00Z", body: "Entry price not recorded · entry time not recorded", timing: "WHILE_LIVE" });
    expect(items.some(item => item.timing === "BEFORE_ENTRY")).toBe(false);
  });

  it("shows money when no risk basis was recorded and moves late notes after the close", () => {
    expect(items.find(item => item.kind === "CLOSE")?.title).toBe("Trade closed: -$20.00");
    expect(items.find(item => item.id === `journal:${ID.lesson}`)?.timing).toBe("AFTER_CLOSE");
    expect(items.find(item => item.id === `journal:${ID.note2}`)).toMatchObject({ title: "Decision", timing: "WHILE_LIVE" });
  });
});
