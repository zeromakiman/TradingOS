import { describe, expect, it } from "vitest";
import { analyzeSetupOutput } from "@/ai/analyze-setup-contract";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { biasChallengeOutput } from "@/ai/bias-challenge-contract";
import { AI_OPERATIONS, operationFor } from "@/ai/operations";
import { operationPricing, reservationMicros } from "@/ai/pricing";
import { tradeReviewContext } from "@/ai/trade-review-context";
import { estimateModel } from "@/components/ai/estimate";
import { estimateLabel, estimateTooltip } from "@/components/ai/model";
import {
  AI_TYPICAL_COST_MICROS, type AiCostOperation, aiHistoryLabel, CHANGE_EVIDENCE_NOTE, estimateAiCost, firstSentence, resolveSourceChip,
  STALE_ANALYSIS_NOTE, staleRevisionLabel, summarizeAnalyzeSetup, summarizeBiasChallenge, summarizeMonthlyReview, summarizeRecentTrades, summarizeTradeReview,
  summarizeTradeTimelineReview, summarizeWeeklyReview, type TradeTimelineReviewOutput,
} from "@/domain/ai-summary";
import { analysisOutput } from "./fixtures/analyze-setup";
import { challengeOutput, source } from "./fixtures/bias-challenge";
import { facts as monthlyFacts, monthlyOutput } from "./fixtures/monthly-review";
import { facts as recentFacts, recentOutput } from "./fixtures/recent-trades";
import { events, ids, output as reviewOutput, plan, risk, strategy, trade } from "./fixtures/trade-review";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

const IMAGE = ids.image;

describe("firstSentence", () => {
  it.each([
    ["The recorded long proposal defines entry, stop and target. The supplied thesis reports a sweep.", "The recorded long proposal defines entry, stop and target."],
    ["Entry at 1.10500 held above the level. Next part.", "Entry at 1.10500 held above the level."],
    ["Liquidity, e.g. PDH, was swept first. More text.", "Liquidity, e.g. PDH, was swept first."],
    ["Is the sweep confirmed? Probably not.", "Is the sweep confirmed?"],
    ["He wrote \"stop.\" Then he left.", "He wrote \"stop.\""],
    ["  Multiple   spaces\nand lines.  Next.", "Multiple spaces and lines."],
    ["No boundary here", "No boundary here"],
    ["The answer is no. The rest follows here…", "The answer is no."],
    ["No. The thesis lacks a recorded sweep.", "No."],
    ["Trade no. 5 lost one R. Trade 6 won.", "Trade no. 5 lost one R."],
    ["See No. 12 in the plan. Then decide.", "See No. 12 in the plan."],
    ["Price ran 20 pips etc. Then reversed.", "Price ran 20 pips etc."],
    ["Sweeps, gaps etc. are common here. Next.", "Sweeps, gaps etc. are common here."],
    ["Levels (PDH, PDL etc.) were marked. Next.", "Levels (PDH, PDL etc.) were marked."],
    ["The level vs. Asia high held. More.", "The level vs. Asia high held."],
  ])("%j", (text, expected) => expect(firstSentence(text)).toBe(expected));

  it("cuts long sentences at a word boundary with an ellipsis, within 220 characters", () => {
    const text = `${"evidence ".repeat(40)}remains unverified.`;
    const result = firstSentence(text);
    expect(result.length).toBeLessThanOrEqual(220);
    expect(result.endsWith("…")).toBe(true);
    const head = result.slice(0, -1);
    expect(text.startsWith(head)).toBe(true);
    expect(text[head.length]).toBe(" ");
  });

  it("hard-cuts a single word longer than the limit", () => {
    const result = firstSentence("x".repeat(300));
    expect(result).toHaveLength(220);
    expect(result.endsWith("…")).toBe(true);
  });

  it("respects a custom limit", () => {
    expect(firstSentence("One two three four five.", 12)).toBe("One two…");
  });
});

describe("concise cards (spec §11.1)", () => {
  it("Analyze Setup", () => {
    const four = { ...analysisOutput, confluences: Array.from({ length: 4 }, (_, i) => ({ text: `Confluence ${i + 1} is recorded. Details follow.`, sourceRefs: ["proposal"] })) };
    const card = summarizeAnalyzeSetup(analyzeSetupOutput.parse(four));
    expect(card.headlineTitle).toBe("Setup");
    expect(card.headline).toEqual({ text: "The recorded long proposal defines entry, stop and target.", sourceRefs: ["proposal", "currentThesis"] });
    expect(card.sections.map(s => [s.title, s.items.length])).toEqual([["Strengths", 2], ["Weaknesses", 1], ["Invalidation", 1], ["AI observation", 1], ["Evidence", 1]]);
    expect(card.sections[0].items[0].text).toBe("Confluence 1 is recorded.");
    expect(card.sections.at(-1)?.items[0].text).toBe("No screenshots were selected, so visual evidence was not reviewed.");
    expect(card.full.map(s => s.title)).toEqual(["Setup", "Entry model", "Strengths", "Weaknesses", "Invalidation", "AI observations", "Evidence"]);
    expect(card.full[2].items).toHaveLength(4);
    expect(card.full[2].items[0].text).toBe("Confluence 1 is recorded. Details follow.");
    expect(summarizeAnalyzeSetup({ ...analysisOutput, evidenceStatus: "SELECTED_NOT_INDEPENDENTLY_VERIFIED" }).sections.at(-1)?.items[0].text).toBe("Selected screenshots were reviewed but not independently verified.");
  });

  it("Challenge My Bias", () => {
    const card = summarizeBiasChallenge(biasChallengeOutput.parse(challengeOutput));
    expect(card.headlineTitle).toBe("Why your thesis might be wrong");
    expect(card.headline.text).toBe("Your directional thesis assumes the reported sweep confirms demand; the supplied narrative alone does not establish that.");
    expect(card.sections.map(s => s.title)).toEqual(["Invalidation", "Missing evidence", "Questions to answer"]);
    expect(card.full.map(s => s.title)).toEqual(["Why your thesis might be wrong", "Invalidation", "Missing evidence", "Questions to answer"]);
  });

  it("Review Trade (V1): six dimension chips and at most two lessons", () => {
    const lessons = Array.from({ length: 4 }, (_, i) => ({ ...reviewOutput.lessons[0], interpretation: `Lesson ${i + 1}.` }));
    const card = summarizeTradeReview({ ...reviewOutput, planAdherence: { ...reviewOutput.planAdherence, assessment: "ALIGNED" }, deviations: { ...reviewOutput.deviations, assessment: "DEVIATION" }, lessons });
    expect(card.chips.map(c => [c.label, c.assessmentLabel])).toEqual([
      ["Plan adherence", "Aligned"], ["Execution quality", "Insufficient evidence"], ["Model fit", "Insufficient evidence"],
      ["Process discipline", "Insufficient evidence"], ["Deviations", "Deviation"], ["Behavioral mistakes", "Insufficient evidence"],
    ]);
    expect(card.sections).toEqual([{ id: "lessons", title: "Lessons", items: [{ text: "Lesson 1.", sourceRefs: ["execution"] }, { text: "Lesson 2.", sourceRefs: ["execution"] }] }]);
    expect(card.limitations).toEqual(["One trade cannot establish repeated behavioral patterns."]);
  });

  it("Review Trade (timeline)", () => {
    const output: TradeTimelineReviewOutput = {
      headline: { text: "Execution followed the locked plan, then management became reactive. Details follow.", sourceRefs: ["originalPlan"] },
      thesisCheck: { assessment: "CONSISTENT", text: "The pre-entry thesis matched the plan.", sourceRefs: ["originalPlan"] },
      executionVsPlan: { assessment: "DEVIATION", text: "Size was four times the plan.", sourceRefs: ["execution"] },
      liveManagement: { assessment: "REACTIVE", text: "The target moved without new evidence.", sourceRefs: ["execution"] },
      patterns: [{ text: "Target changed without new recorded evidence.", sourceRefs: ["execution"] }],
      keyLesson: { text: "Record evidence before moving the target.", sourceRefs: ["execution"] },
      limitations: ["Only one closed trade."],
    };
    const card = summarizeTradeTimelineReview(output);
    expect(card.headline.text).toBe("Execution followed the locked plan, then management became reactive.");
    expect(card.chips.map(c => [c.label, c.assessmentLabel])).toEqual([["Thesis check", "Consistent"], ["Execution vs plan", "Deviation"], ["Live management", "Reactive"]]);
    expect(card.sections.map(s => s.title)).toEqual(["Thesis check", "Execution vs plan", "Live management", "Key lesson"]);
    expect(card.full.map(s => s.title)).toContain("Patterns");
    const noPlan = summarizeTradeTimelineReview({ ...output, thesisCheck: { ...output.thesisCheck, assessment: "NOT_RECORDED" }, executionVsPlan: { ...output.executionVsPlan, assessment: "NO_PLAN" }, liveManagement: { ...output.liveManagement, assessment: "NO_LIVE_RECORDS" } });
    expect(noPlan.chips.map(c => c.assessmentLabel)).toEqual(["Not recorded", "No plan", "No live records"]);
  });

  it("periodic reviews: went well, needs attention, focus next, with deterministic facts", () => {
    const weekly = summarizeWeeklyReview(weeklyOutput, { trades: 8, netR: "3.2" });
    expect(weekly.facts).toBe("8 trades · +3.20R");
    expect(weekly.sections.map(s => [s.title, s.items[0]?.text])).toEqual([
      ["Went well", "Improvement cannot be established from this sample; no prior-week comparison was supplied."],
      ["Needs attention", "One recorded trade is too small a sample to establish a recurring pattern."],
      ["Focus next", "Keep recording execution notes and adherence to the supplied rules."],
    ]);
    expect(weekly.full).toHaveLength(9);
    expect(summarizeWeeklyReview(weeklyOutput).facts).toBeNull();
    expect(summarizeWeeklyReview(weeklyOutput, { trades: 1, netR: null }).facts).toBe("1 trade");
    const recent = summarizeRecentTrades(recentOutput, { trades: 20, netR: "-1.5" });
    expect(recent.headline.text).toBe("This small sample cannot establish a recurring behavioral cause.");
    expect(recent.facts).toBe("20 trades · -1.50R");
    expect(recent.full).toHaveLength(8);
    const monthly = summarizeMonthlyReview(monthlyOutput);
    expect(monthly.headline.text).toBe("This small sample cannot establish a recurring behavioral cause.");
    expect(monthly.full).toHaveLength(13);
  });

  it("a monthly review's change sections carry the comparison caveat from Trading OS (kept from V1), no other section does", () => {
    const monthly = summarizeMonthlyReview(monthlyOutput);
    expect(CHANGE_EVIDENCE_NOTE).toBe("Change requires comparable earlier and later evidence. Record completeness alone does not establish improvement or degradation.");
    expect(monthly.full.filter(section => section.note).map(section => [section.id, section.title, section.note])).toEqual([
      ["whatImproved", "What improved", CHANGE_EVIDENCE_NOTE],
      ["whatDegraded", "What degraded", CHANGE_EVIDENCE_NOTE],
    ]);
    // The caveat is never AI text: it is not an item, and the concise card keeps its three sections without it.
    expect(monthly.full.flatMap(section => section.items).map(item => item.text)).not.toContain(CHANGE_EVIDENCE_NOTE);
    expect(monthly.sections.some(section => "note" in section)).toBe(false);
    expect([summarizeWeeklyReview(weeklyOutput), summarizeRecentTrades(recentOutput)].flatMap(card => card.full).some(section => "note" in section)).toBe(false);
  });
});

describe("friendly source chips", () => {
  const evidence = [{ id: IMAGE, role: "M5", sha256: "a".repeat(64), mime_type: "image/png", byte_size: 1024 }];
  const challengeFacts = biasChallengeContext(source, evidence);
  const reviewFacts = tradeReviewContext(plan, trade, strategy, risk, events, evidence);

  it("names pre-trade sources", () => {
    const chip = (id: string) => resolveSourceChip(id, challengeFacts, challengeFacts.sourceManifest);
    expect(chip("proposal")).toEqual({ label: "Trade plan", kind: "plan", technicalId: "proposal" });
    expect(chip("currentThesis").label).toBe("Your thesis");
    expect(chip("strategy").label).toBe("Strategy ICT V1.0");
    expect(chip("deterministic").label).toBe("Risk Engine");
    expect(chip(`evidence:${IMAGE}`)).toEqual({ label: "M5 chart", kind: "evidence", href: `#evidence-${IMAGE}`, evidenceId: IMAGE, technicalId: `evidence:${IMAGE}` });
    expect(resolveSourceChip(`evidence:${IMAGE}`, challengeFacts, challengeFacts.sourceManifest, { [IMAGE]: { label: "ENTRY", timeframe: null } }).label).toBe("Entry screenshot");
  });

  it("names post-trade sources and notes", () => {
    const chip = (id: string) => resolveSourceChip(id, reviewFacts, reviewFacts.sourceManifest);
    expect(chip("originalPlan").label).toBe("Trade plan");
    expect(chip("riskVersion").label).toBe("Risk V1");
    expect(chip("execution").label).toBe("Execution");
    expect(chip("tags").label).toBe("Your tags");
    expect(chip(`event:${ids.event}`)).toEqual({ label: "Journal note · 04:01", kind: "note", href: `#event:${ids.event}`, technicalId: `event:${ids.event}` });
    expect(resolveSourceChip(`event:${ids.event}`, reviewFacts, reviewFacts.sourceManifest, {}, { mode: "utc" }).label).toBe("Journal note · 09:01");
  });

  describe("timeline records of the trade review (REVIEW_TRADE_TIMELINE_FACTS_V1)", () => {
    const tradeId = "60000000-0000-4000-8000-000000000001";
    const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const item = (sourceId: string, kind: string, recordedAt: string, occurredAt: string | null, details: Record<string, unknown> = {}) =>
      ({ sourceId, kind, timing: "BEFORE_ENTRY", recordedAt, occurredAt, flags: [], text: "", details });
    const timeline = [
      item(`revision:${id(2)}`, "DRAFT_REVISION", "2026-09-04T12:00:00Z", null, { revision: 2 }),
      item(`check:${id(3)}`, "RISK_CHECK", "2026-09-04T12:05:00Z", null, { decision: "APPROVED" }),
      item(`plan:${id(4)}`, "PLAN_LOCKED", "2026-09-04T12:10:00Z", null),
      item(`execution:${tradeId}`, "ENTRY", "2026-09-04T12:20:00Z", "2026-09-04T12:15:00Z"),
      item(`position:${id(5)}`, "ENTRY_DETAILS", "2026-09-04T12:30:00Z", null),
      item(`close:${tradeId}`, "CLOSE", "2026-09-04T15:01:00Z", "2026-09-04T14:55:00Z"),
    ];
    const facts = { version: "REVIEW_TRADE_TIMELINE_FACTS_V1", tradeId, timeline };
    const manifest = { sources: timeline.map((entry, index) => ({ id: entry.sourceId, kind: "TIMELINE", path: `timeline[${index}]` })) };

    it("labels each record with its strategy time and links to its timeline item", () => {
      const chips = timeline.map(entry => resolveSourceChip(entry.sourceId, facts, manifest));
      expect(chips.map(chip => [chip.label, chip.kind, chip.href])).toEqual([
        ["Draft revision 2 · 07:00", "event", `#revision:${id(2)}`],
        ["Risk check · 07:05", "event", `#check:${id(3)}`],
        ["Plan lock · 07:10", "event", `#plan:${id(4)}`],
        ["Entry · 07:15", "event", `#entry:${tradeId}`],
        ["Entry details · 07:30", "event", `#entry:${tradeId}`],
        ["Exit · 09:55", "event", `#close:${tradeId}`],
      ]);
      expect(chips.map(chip => chip.technicalId)).toEqual(timeline.map(entry => entry.sourceId));
      expect(resolveSourceChip(`close:${tradeId}`, facts, manifest, {}, { mode: "utc" }).label).toBe("Exit · 14:55");
    });

    it("resolves facts stored without a manifest through the timeline", () => {
      expect(resolveSourceChip(`check:${id(3)}`, facts).label).toBe("Risk check · 07:05");
      expect(resolveSourceChip(`revision:${id(2)}`, { ...facts, timeline: [item(`revision:${id(2)}`, "DRAFT_REVISION", "2026-09-04T12:00:00Z", null)] }).label).toBe("Draft revision · 07:00");
    });

    it("keeps the neutral chip for records the facts do not contain", () => {
      for (const sourceId of [`check:${id(9)}`, `plan:${id(9)}`, `position:${id(9)}`]) {
        expect(resolveSourceChip(sourceId, facts, manifest)).toEqual({ label: "Source", kind: "unknown", technicalId: sourceId });
      }
      expect(resolveSourceChip(`close:${tradeId}`, null)).toEqual({ label: "Source", kind: "unknown", technicalId: `close:${tradeId}` });
    });
  });

  it("uses the timing band of timeline facts", () => {
    const journalId = "70000000-0000-4000-8000-000000000001";
    const facts = { version: "REVIEW_TRADE_TIMELINE_FACTS_V1", timeline: [{ sourceId: `journal:${journalId}`, kind: "NOTE", timing: "WHILE_LIVE", recordedAt: "2026-09-04T14:45:00Z", occurredAt: null }] };
    expect(resolveSourceChip(`journal:${journalId}`, facts).label).toBe("Live note · 09:45");
    facts.timeline[0].timing = "BEFORE_ENTRY";
    expect(resolveSourceChip(`journal:${journalId}`, facts).label).toBe("Pre-entry note · 09:45");
    facts.timeline[0].timing = "AFTER_CLOSE";
    expect(resolveSourceChip(`journal:${journalId}`, facts).label).toBe("After-close note · 09:45");
  });

  it("names periodic sources", () => {
    const weekly = (id: string) => resolveSourceChip(id, weeklyFacts, weeklyFacts.sourceManifest);
    expect(weekly("period").label).toBe("Week of Aug 31");
    expect(weekly("sample").label).toBe("Sample · 1 trade");
    expect(weekly("edge").label).toBe("EDGE metrics");
    expect(weekly(`trade:${ids.plan}`)).toEqual({ label: "EURUSD long · Sep 1", kind: "trade", href: `/journal/${ids.plan}`, technicalId: `trade:${ids.plan}` });
    const monthly = (id: string) => resolveSourceChip(id, monthlyFacts, monthlyFacts.sourceManifest);
    expect(monthly("period").label).toBe("August 2026");
    expect(monthly("models").label).toBe("By model");
    expect(monthly("sessions").label).toBe("By session");
    expect(monthly(`strategy:${strategy.id}`).label).toBe("Strategy ICT V1.0");
    expect(monthly(`risk:${risk.id}`).label).toBe("Risk V1");
    expect(resolveSourceChip("sample", recentFacts, recentFacts.sourceManifest).label).toBe("Sample · 1 trade");
  });

  it("resolves legacy facts stored without a manifest", () => {
    const { sourceManifest: _omitted, ...legacy } = weeklyFacts;
    expect(resolveSourceChip(`trade:${ids.plan}`, legacy).label).toBe("EURUSD long · Sep 1");
  });

  it("a periodic review's notes and events name their trade and open its timeline: the review page has none", () => {
    // V1 facts know the plan only; the legacy journal link redirects to the trade, where the event is a timeline item.
    expect(resolveSourceChip(`event:${ids.event}`, weeklyFacts, weeklyFacts.sourceManifest).label).toBe("EURUSD long · Sep 1 · Journal note · 04:01");
    const v1 = { label: expect.stringMatching(/^EURUSD long · [A-Z][a-z]{2} \d{1,2} · Journal note · \d{2}:\d{2}$/), kind: "note", href: `/journal/${ids.plan}#event:${ids.event}`, technicalId: `event:${ids.event}` };
    for (const facts of [weeklyFacts, recentFacts, monthlyFacts]) {
      expect(resolveSourceChip(`event:${ids.event}`, facts, facts.sourceManifest)).toEqual(v1);
      const { sourceManifest: _omitted, ...legacy } = facts;
      expect(resolveSourceChip(`event:${ids.event}`, legacy)).toEqual(v1);
    }
    // V2 periodic facts carry no manifest: a journal row is found by its id and opens on the V2 trade.
    const tradeRecordId = "90000000-0000-4000-8000-000000000001";
    const journalId = "70000000-0000-4000-8000-000000000001";
    const v2 = {
      version: "WEEKLY_REVIEW_FACTS_V2",
      trades: [{
        tradeId: ids.plan, tradeRecordId, originalPlan: { instrument: "GBPUSD", proposal: { direction: "SHORT" } }, execution: { exited_at: "2026-09-07T12:00Z" },
        journal: [[journalId, "STOP_CHANGE", "2026-09-07T10:11Z", "WHILE_LIVE", "Stop to break-even.", { details: { price: "1.3" } }]],
      }],
    };
    expect(resolveSourceChip(`journal:${journalId}`, v2)).toEqual({
      label: "GBPUSD short · Sep 7 · Live note · 05:11", kind: "note", href: `/trades/${tradeRecordId}#journal:${journalId}`, technicalId: `journal:${journalId}`,
    });
    expect(resolveSourceChip(`journal:${journalId}`, v2, undefined, {}, { mode: "utc" }).label).toBe("GBPUSD short · Sep 7 · Live note · 10:11");
    expect(resolveSourceChip(`trade:${tradeRecordId}`, v2)).toEqual({ label: "GBPUSD short · Sep 7", kind: "trade", href: `/trades/${tradeRecordId}`, technicalId: `trade:${tradeRecordId}` });
    // A record the facts do not hold keeps the neutral note chip with no link (an anchor on the review page would lead
    // nowhere); an id that is not a UUID never becomes a link.
    const missing = "70000000-0000-4000-8000-000000000009";
    expect(resolveSourceChip(`journal:${missing}`, v2)).toEqual({ label: "Journal note", kind: "note", technicalId: `journal:${missing}` });
    expect(resolveSourceChip(`event:${missing}`, weeklyFacts, weeklyFacts.sourceManifest)).not.toHaveProperty("href");
    const unsafe = { ...v2, trades: [{ ...v2.trades[0], tradeRecordId: "../settings", tradeId: "javascript:alert(1)" }] };
    expect(resolveSourceChip(`journal:${journalId}`, unsafe)).not.toHaveProperty("href");
  });

  it("a periodic V1 event opens its timeline item, or the trade when the timeline shows it as the plan lock, entry or close", () => {
    const eventId = "60000000-0000-4000-8000-000000000041";
    const withEvent = (event_type: string) => ({
      version: "WEEKLY_REVIEW_FACTS_V2",
      trades: [{
        tradeId: ids.plan, tradeRecordId: "90000000-0000-4000-8000-000000000001", originalPlan: { instrument: "EURUSD", proposal: { direction: "LONG" } }, execution: { exited_at: "2026-09-01T09:00Z" },
        events: [{ id: eventId, event_type, occurred_at: "2026-09-01T08:20Z", recorded_at: "2026-09-01T08:20Z", timing: "WHILE_LIVE", payload: {} }],
      }],
    });
    expect(resolveSourceChip(`event:${eventId}`, withEvent("STOP_MOVED"))).toEqual({
      label: "EURUSD long · Sep 1 · Stop moved · 03:20", kind: "event", href: `/trades/90000000-0000-4000-8000-000000000001#event:${eventId}`, technicalId: `event:${eventId}`,
    });
    expect(resolveSourceChip(`event:${eventId}`, withEvent("TRADE_OPENED"))).toMatchObject({ label: "EURUSD long · Sep 1 · Entry · 03:20", href: "/trades/90000000-0000-4000-8000-000000000001" });
    // V1 decisions are timeline items too, worded as the timeline titles them.
    expect(resolveSourceChip(`event:${eventId}`, withEvent("MANUAL_OVERRIDE")).label).toBe("EURUSD long · Sep 1 · Taken despite a block · 03:20");
    expect(resolveSourceChip(`event:${eventId}`, withEvent("HUMAN_DECISION")).label).toBe("EURUSD long · Sep 1 · Decision · 03:20");
  });

  it("falls back to a neutral chip and keeps the raw id out of the label", () => {
    for (const id of ["mystery", "evidence:", "bogus:123", `trade:${"f".repeat(8)}`, "__proto__"]) {
      const chip = resolveSourceChip(id, weeklyFacts, weeklyFacts.sourceManifest);
      expect(chip.technicalId).toBe(id);
      expect(chip.label).not.toContain(id.split(":")[1] || "%%");
    }
    expect(resolveSourceChip("mystery", null)).toEqual({ label: "Source", kind: "unknown", technicalId: "mystery" });
    expect(resolveSourceChip(`trade:${"f".repeat(8)}`, weeklyFacts, weeklyFacts.sourceManifest).label).toBe("Trade");
  });
});

describe("AI cost estimates (spec §11.2)", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const measured: [AiCostOperation, number, number][] = [
    ["REVIEW_TRADE", 16_000, 59_400], ["CHALLENGE_BIAS", 15_800, 39_600], ["ANALYZE_SETUP", 18_500, 45_540],
    ["WEEKLY_REVIEW", 21_300, 59_400], ["RECENT_TRADES_ANALYSIS", 28_900, 67_320], ["MONTHLY_REVIEW", 34_400, 67_320],
  ];

  it.each(measured)("%s: typical from measured runs, maximum is the reservation", (operation, typical, max) => {
    const definition = operationFor(operation);
    expect(estimateAiCost(operation, now)).toEqual({ typicalMicros: typical, maxMicros: reservationMicros(operationPricing(definition, now), definition) });
    expect(estimateAiCost(operation, now).maxMicros).toBe(max);
  });

  it("uses the REVIEW_TRADE figure for the timeline review and fails closed until it is registered", () => {
    expect(AI_TYPICAL_COST_MICROS.REVIEW_TRADE_TIMELINE).toBe(AI_TYPICAL_COST_MICROS.REVIEW_TRADE);
    if (Object.hasOwn(AI_OPERATIONS, "REVIEW_TRADE_TIMELINE")) {
      const definition = operationFor("REVIEW_TRADE_TIMELINE");
      expect(estimateAiCost("REVIEW_TRADE_TIMELINE", now)).toEqual({ typicalMicros: 16_000, maxMicros: reservationMicros(operationPricing(definition, now), definition) });
    } else {
      expect(() => estimateAiCost("REVIEW_TRADE_TIMELINE", now)).toThrow("Unknown AI operation");
    }
  });

  it("refuses expired pricing", () => {
    expect(() => estimateAiCost("REVIEW_TRADE", new Date("2026-11-12T00:00:00Z"))).toThrow("AI pricing requires review before requests can run.");
  });

  it("labels buttons and tooltips in euros, as the paid buttons show them", () => {
    // The paid buttons format the estimate with estimateModel (typical half-up, maximum rounded up) and model.ts.
    const model = (operation: AiCostOperation) => {
      const formatted = estimateModel(estimateAiCost(operation, now));
      if (formatted === null) throw new Error("pricing is current at the pinned time");
      return formatted;
    };
    expect(estimateLabel(model("REVIEW_TRADE"))).toBe("≈ €0.02");
    expect(estimateTooltip(model("REVIEW_TRADE"))).toBe("Typical cost based on measured runs; at most €0.06 is reserved and unused funds are released.");
    expect(estimateLabel(model("MONTHLY_REVIEW"))).toBe("≈ €0.03");
    expect(estimateTooltip(model("CHALLENGE_BIAS"))).toContain("at most €0.04 ");
    expect(estimateTooltip(model("ANALYZE_SETUP"))).toContain("at most €0.05 ");
    expect(estimateLabel(model("ANALYZE_SETUP"))).toBe("≈ €0.02");
  });
});

describe("history rows and stale markers", () => {
  it("summarises AI history compactly", () => {
    expect(aiHistoryLabel("ANALYZE_SETUP", "COMPLETED", "2026-09-04T13:00:00Z")).toBe("Analyze Setup · Completed · 08:00");
    expect(aiHistoryLabel("WEEKLY_REVIEW", "FAILED", "2026-09-04T13:00:00Z", { mode: "utc" })).toBe("Weekly Review · Failed · 13:00");
    expect(aiHistoryLabel("SOMETHING_NEW", "RUNNING", "2026-09-04T13:00:00Z")).toBe("AI analysis · In progress · 08:00");
  });

  it("marks analyses of earlier draft revisions", () => {
    expect(staleRevisionLabel(2, 3)).toBe("Based on draft revision 2 · current revision is 3");
    expect(staleRevisionLabel(3, 3)).toBeNull();
    expect(STALE_ANALYSIS_NOTE).toBe("Analysis belongs to an earlier draft version");
  });
});
