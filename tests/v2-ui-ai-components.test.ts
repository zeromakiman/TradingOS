import { type ComponentType, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { analysisOutput } from "./fixtures/analyze-setup";
import { challengeOutput, ids, source } from "./fixtures/bias-challenge";
import { output as tradeReviewOutput } from "./fixtures/trade-review";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// AI presentation components (docs/V2_ARCHITECTURE.md §8.3, §11.1, §11.2, §13.9, §15), rendered on the server.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: vi.fn() }));
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { AiActionButton, type AiActionButtonProps, aiButtonLabel, aiRequestForm, aiResultToast, submitAiRequest } from "@/components/ai/ai-action-button";
import { aiBudgetStatus, type AiBudgetModel, AiBudgetSummary, smallestRequestMicros } from "@/components/ai/ai-budget-summary";
import { AiCard, type AiCardProps } from "@/components/ai/ai-card";
import { evidenceSelectionSummary } from "@/components/ai/ai-evidence-actions";
import { AiHistoryList } from "@/components/ai/ai-history-list";
import { aiEstimate, estimateModel } from "@/components/ai/estimate";
import { FullAnalysisBody, FullAnalysisSheet } from "@/components/ai/full-analysis-sheet";
import { chipLabel, failureAccountingText, PRICING_UNAVAILABLE, safeChipHref, type SourceChipModel, sourceChipModel } from "@/components/ai/model";
import {
  type AiResultEntry, AnalyzeSetupCard, ChallengeBiasCard, latestCompleted, TradeReviewV1Card, TradeTimelineReviewCard, WeeklyReviewCard,
} from "@/components/ai/operation-cards";
import { periodicFactModels, storedPeriodicFacts } from "@/components/ai/periodic";
import { SourceChip, SourceChipList } from "@/components/ai/source-chip";
import { StaleRevisionMarker } from "@/components/ai/stale-revision-marker";
import { EvidenceSelectionProvider } from "@/components/evidence/selection";
import { ToastProvider } from "@/components/ui/toast";
import { budgetPresentation, type BudgetSnapshot } from "@/ai/budget";
import { estimateAiCost } from "@/domain/ai-summary";
import { type AiAccounting, type AiRequestRow, type AiResultRow, historyRow, resolvedCard, revisionMarker } from "@/lib/ai-history";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOW = new Date("2026-09-23T12:30:00Z");
const IMAGE = "50000000-0000-4000-8000-000000000001";

const render = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));
const wrap = (provider: ComponentType<{ children: ReactNode }>, child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(provider, null, child));

/** Collapses every `<details>` element (nested ones included) to its summary: what a reader sees by default. */
function stripDetails(html: string): string {
  let out = "";
  let depth = 0;
  let start = 0;
  for (const match of html.matchAll(/<details\b[^>]*>|<\/details>/g)) {
    const index = match.index ?? 0;
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        out += /<summary\b[^>]*>[\s\S]*?<\/summary>/.exec(html.slice(start, index))?.[0] ?? "";
        start = index + match[0].length;
      }
    } else {
      if (depth === 0) {
        out += html.slice(start, index);
        start = index;
      }
      depth += 1;
    }
  }
  return depth === 0 ? out + html.slice(start) : out;
}

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** Text a reader sees by default: tags, attributes and collapsed disclosures removed. */
const visibleText = (html: string) => textOf(stripDetails(html));
const detailsBlocks = (html: string) => [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map(match => match[0]);

const request = (n: number, operation: Record<string, string>, createdAt: string): AiRequestRow => ({
  id: `71000000-0000-4000-8000-00000000000${n}`, operation, created_at: createdAt, deadline_at: "2026-09-23T13:00:00Z",
});
const operation = (id: string, contract: string, version = `${id}_MINI_V1`) => ({ id, version, contract, provider: "openai", model: "gpt-5.4-mini" });
const done = (interpretation: unknown, at: string): AiResultRow => ({ status: "COMPLETED", interpretation, error_code: null, reservation_id: null, created_at: at });
const none: AiAccounting = { holds: [], usage: [] };

function entry(op: Parameters<typeof historyRow>[0], req: AiRequestRow, result: AiResultRow | null, interpretation: unknown, facts: unknown, accounting = none): AiResultEntry {
  const row = historyRow(op, req, result, accounting, NOW);
  return { ...row, card: resolvedCard(row, interpretation, facts) };
}

const evidence = [{ id: IMAGE, role: "M5", sha256: "a".repeat(64), mime_type: "image/png", byte_size: 1024 }];
const analysisFacts = analyzeSetupContext(source, evidence);
const analysisWithEvidence = {
  ...analysisOutput,
  confluences: [
    { text: "First confluence is recorded on the chart. Second sentence stays in the full analysis.", sourceRefs: ["proposal", `evidence:${IMAGE}`] },
    { text: "Second confluence.", sourceRefs: ["strategy"] },
    { text: "Third confluence.", sourceRefs: ["strategy"] },
    { text: "Fourth confluence.", sourceRefs: ["currentThesis"] },
  ],
  evidenceStatus: "SELECTED_NOT_INDEPENDENTLY_VERIFIED" as const,
};
const analysisEntry = entry("ANALYZE_SETUP", request(1, operation("ANALYZE_SETUP", "ANALYZE_SETUP_V1"), "2026-09-23T12:00:00Z"), done(analysisWithEvidence, "2026-09-23T12:01:00Z"), analysisWithEvidence, analysisFacts);
const challengeFacts = biasChallengeContext(source, []);
const challengeEntry = entry("CHALLENGE_BIAS", request(2, operation("CHALLENGE_BIAS", "CHALLENGE_BIAS_V1"), "2026-09-23T12:05:00Z"), done(challengeOutput, "2026-09-23T12:06:00Z"), challengeOutput, challengeFacts);
const blocked = { decision: "BLOCKED" as const, text: "Requested risk 2.00% exceeds your configured maximum of 0.50%." };

// ---------------------------------------------------------------------------------------------
// AiCard
// ---------------------------------------------------------------------------------------------

const cardProps = (overrides: Partial<AiCardProps> = {}): AiCardProps => ({
  title: "Setup analysis",
  operationLabel: "Analyze Setup",
  completedAt: "2026-09-23T13:00:00Z",
  status: "COMPLETED",
  riskLine: blocked,
  headline: { label: "Setup", text: "The long setup follows an M5 shift. Everything else is detail.", sources: [{ label: "Trade plan", kind: "plan", technicalId: "proposal" }] },
  sections: [
    {
      heading: "Strengths",
      items: ["One. Extra.", "Two.", "Three.", "Four."].map(text => ({ text, sources: [] })),
    },
    { heading: "Weaknesses", items: [{ text: "Visual evidence is thin.", sources: [{ label: "M5 chart", kind: "evidence", href: `#evidence-${IMAGE}`, technicalId: `evidence:${IMAGE}` }] }] },
    { heading: "Empty", items: [] },
  ],
  ...overrides,
});

describe("AiCard", () => {
  it("shows at most two first-sentence items per section and points to the full analysis for the rest", () => {
    const html = render(AiCard, cardProps());
    const text = visibleText(html);
    expect(text).toContain("One.");
    expect(text).toContain("Two.");
    expect(text).not.toContain("Three.");
    expect(text).not.toContain("Extra.");
    expect(text).toContain("+2 more in the full analysis");
    expect(text).not.toContain("Empty");
    expect(text).toContain("The long setup follows an M5 shift.");
    expect(text).not.toContain("Everything else is detail.");
    expect(html.match(/<li class="flex flex-col gap-1">/g)).toHaveLength(3);
  });

  it("leads with the deterministic Risk Engine line, visually separate from the advisory AI interpretation", () => {
    const html = render(AiCard, cardProps());
    const text = visibleText(html);
    const risk = text.indexOf("Risk Engine · Blocked — Requested risk 2.00% exceeds your configured maximum of 0.50%.");
    const label = text.indexOf("AI interpretation · advisory");
    expect(risk).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(risk);
    expect(text.indexOf("The long setup follows an M5 shift.")).toBeGreaterThan(label);
    expect(html).toMatch(/data-zone="risk-engine" data-decision="blocked"/);
    expect(html).toMatch(/class="[^"]*bg-neg-soft[^"]*" data-zone="risk-engine"/);
    expect(html.indexOf('data-zone="deterministic"')).toBeLessThan(html.indexOf('data-zone="ai"'));
    expect(text).toContain("Analyze Setup · Completed · 08:00");
  });

  it("marks stale analyses, keeps technical fields collapsed and offers the full-analysis slot", () => {
    const html = render(AiCard, cardProps({ staleNote: "Based on draft revision 2 · current revision is 3", technical: "REQUEST-RAW", onOpenFull: createElement("button", { type: "button" }, "View full analysis") }));
    expect(visibleText(html)).toContain("Based on draft revision 2 · current revision is 3");
    expect(html).toContain("Analysis belongs to an earlier draft version");
    expect(visibleText(html)).not.toContain("REQUEST-RAW");
    expect(detailsBlocks(html).join("")).toContain("REQUEST-RAW");
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(visibleText(html)).toContain("View full analysis");
    expect(render(AiCard, cardProps({ technical: "X", developerMode: true }))).toMatch(/<details[^>]*open=""/);
  });

  it("words every Risk Engine state, never by colour alone", () => {
    const line = (riskLine: AiCardProps["riskLine"]) => render(AiCard, cardProps({ riskLine }));
    expect(visibleText(line({ decision: "APPROVED", text: "" }))).toContain("Risk Engine · Approved AI interpretation");
    expect(visibleText(line({ decision: "UNCHECKED", text: "" }))).toContain("Risk Engine · Not checked");
    const recheck = line({ decision: "RECHECK", text: "The session changed since the last check." });
    expect(visibleText(recheck)).toContain("Risk Engine · Recheck needed — The session changed since the last check.");
    expect(recheck).toMatch(/class="[^"]*bg-warn-soft[^"]*" data-zone="risk-engine" data-decision="recheck"/);
    expect(visibleText(line(null))).not.toContain("Risk Engine");
  });

  it("shows a failed or running request without AI sections", () => {
    const failed = visibleText(render(AiCard, cardProps({ status: "FAILED", failure: { reason: "The AI provider did not respond in time.", accounting: "No reservation is recorded for this attempt." } })));
    expect(failed).toContain("Analyze Setup · Failed · 08:00");
    expect(failed).toContain("The AI provider did not respond in time.");
    expect(failed).toContain("No reservation is recorded for this attempt.");
    expect(failed).not.toContain("Strengths");
    const running = visibleText(render(AiCard, cardProps({ status: "IN_PROGRESS" })));
    expect(running).toContain("In progress");
    expect(running).toContain("Still running.");
  });
});

// ---------------------------------------------------------------------------------------------
// Source chips and stale marker
// ---------------------------------------------------------------------------------------------

describe("SourceChip", () => {
  it("links screenshots to the gallery viewer hash, trades to the trade page and timeline records to their item", () => {
    const evidenceChip = render(SourceChip, { chip: { label: "M5 chart", kind: "evidence", href: `#evidence-${IMAGE}`, technicalId: `evidence:${IMAGE}` } });
    expect(evidenceChip).toContain(`href="#evidence-${IMAGE}"`);
    expect(visibleText(evidenceChip)).toBe("M5 chart · open screenshot");
    expect(render(SourceChip, { chip: { label: "EURUSD long · Oct 14", kind: "trade", href: `/trades/${ids.plan}` } })).toContain(`href="/trades/${ids.plan}"`);
    expect(render(SourceChip, { chip: { label: "Live note · 09:45", kind: "note", href: `#journal:${ids.event}` } })).toContain(`href="#journal:${ids.event}"`);
    expect(render(SourceChip, { chip: { label: "Risk Engine", kind: "risk-engine" } })).not.toContain("href");
  });

  it("never prints raw ids and never renders unsafe links", () => {
    expect(chipLabel(`Source ${IMAGE}`)).toBe("Source");
    expect(visibleText(render(SourceChip, { chip: { label: IMAGE, kind: "unknown", technicalId: IMAGE } }))).toBe("Source");
    for (const href of ["javascript:alert(1)", "https://example.com", "//evil.example", "#"]) expect(safeChipHref(href)).toBeUndefined();
    expect(render(SourceChip, { chip: { label: "Source", kind: "unknown", href: "javascript:alert(1)" } })).not.toContain("href");
    const chips = (analysisEntry.card?.full ?? []).flatMap(section => section.items.flatMap(item => item.sources)).map(sourceChipModel);
    expect(chips.length).toBeGreaterThan(3);
    const html = render(SourceChipList, { sources: chips });
    expect(visibleText(html)).not.toMatch(UUID);
    expect(visibleText(html)).toContain("M5 chart");
    expect(html).toContain('aria-label="Sources"');
  });
});

describe("StaleRevisionMarker", () => {
  it("states the analysed and the current revision, and renders nothing for the current one", () => {
    const html = render(StaleRevisionMarker, { analysisRevision: 2, currentRevision: 3 });
    expect(visibleText(html)).toBe("Analysis belongs to an earlier draft version. Based on draft revision 2 · current revision is 3");
    expect(html).toContain('data-stale="true"');
    expect(render(StaleRevisionMarker, { analysisRevision: 3, currentRevision: 3 })).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// Operation cards and full analysis
// ---------------------------------------------------------------------------------------------

describe("operation cards", () => {
  it("Analyze Setup: Risk Engine first, concise sections, friendly chips, stale marker and collapsed technical fields", () => {
    const stale = { ...analysisEntry, revision: revisionMarker(1, 2) };
    const html = render(AnalyzeSetupCard, { entry: stale, riskLine: blocked, currentRevision: 2 });
    const text = visibleText(html);
    expect(text.indexOf("Risk Engine · Blocked")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text).toContain("Setup analysis");
    expect(text).toContain("Based on draft revision 1 · current revision is 2");
    expect(text).toContain("First confluence is recorded on the chart.");
    expect(text).toContain("Second confluence.");
    expect(text).not.toContain("Third confluence.");
    expect(text).toContain("M5 chart");
    expect(text).toContain("Trade plan");
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/ANALYZE_SETUP|openai|gpt-5\.4-mini|COMPLETED/);
    const technical = detailsBlocks(html).join("");
    expect(technical).toContain("ANALYZE_SETUP_V1");
    expect(technical).toContain(analysisEntry.technical.requestId);
    expect(render(AnalyzeSetupCard, { entry: stale, riskLine: blocked, currentRevision: 1 })).not.toContain("Based on draft revision");
  });

  it("Challenge My Bias and the trade reviews keep facts apart from the interpretation", () => {
    const challenge = visibleText(render(ChallengeBiasCard, { entry: challengeEntry, riskLine: { decision: "APPROVED", text: "" } }));
    expect(challenge).toContain("Risk Engine · Approved");
    expect(challenge).toContain("Why your thesis might be wrong");
    expect(challenge).toContain("Questions to answer");
    const v1 = entry("REVIEW_TRADE", request(3, operation("REVIEW_TRADE", "REVIEW_TRADE_V1"), "2026-09-23T12:10:00Z"), done(tradeReviewOutput, "2026-09-23T12:11:00Z"), tradeReviewOutput, {});
    const v1Text = visibleText(render(TradeReviewV1Card, { entry: v1 }));
    expect(v1Text).toContain("Plan adherence · Insufficient evidence");
    expect(v1Text).toContain("Lessons");
    const timeline = {
      headline: { text: "Execution followed the plan, then management turned reactive. More detail.", sourceRefs: ["execution"] },
      thesisCheck: { assessment: "NOT_RECORDED", text: "No plan existed.", sourceRefs: ["strategy"] },
      executionVsPlan: { assessment: "NO_PLAN", text: "No plan to compare.", sourceRefs: ["execution"] },
      liveManagement: { assessment: "REACTIVE", text: "The target moved twice.", sourceRefs: ["execution"] },
      patterns: [], keyLesson: { text: "Record why a target moves.", sourceRefs: ["execution"] }, limitations: ["Only one trade."],
    };
    const reviewed = entry("REVIEW_TRADE_TIMELINE", request(4, operation("REVIEW_TRADE_TIMELINE", "REVIEW_TRADE_TIMELINE_V1"), "2026-09-23T12:20:00Z"), done(timeline, "2026-09-23T12:21:00Z"), timeline, {});
    const html = render(TradeTimelineReviewCard, { entry: reviewed, noPlan: true });
    const text = visibleText(html);
    expect(text.indexOf("From Trading OS")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text).toContain("No pre-trade plan recorded");
    expect(text).toContain("Live management · Reactive");
    expect(html).toMatch(/data-tone="warning"[^>]*>Live management · Reactive/);
    expect(text).toContain("Execution followed the plan, then management turned reactive.");
    expect(text).not.toContain("More detail.");
  });

  it("periodic cards show sample size and net R from the stored facts, never from the AI", () => {
    const weekly = entry("WEEKLY_REVIEW", request(5, operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), "2026-09-23T12:25:00Z"), done(weeklyOutput, "2026-09-23T12:26:00Z"), weeklyOutput, weeklyFacts);
    const html = render(WeeklyReviewCard, { entry: weekly, storedFacts: weeklyFacts, scopeLabel: "Week of Aug 31–Sep 6" });
    const text = visibleText(html);
    expect(text).toContain("Week of Aug 31–Sep 6");
    expect(text).toContain("From Trading OS Sample 1 trade Net R +3.00R");
    expect(text).toContain("1 completed trade — early sample; more data is needed before drawing conclusions.");
    expect(text).toContain("Went well");
    expect(text).toContain("Needs attention");
    expect(text).toContain("Focus next");
    expect(text).not.toMatch(UUID);
    expect(storedPeriodicFacts({ sample: { actual: 12 }, edge: { netR: -1.5 } })).toEqual({ trades: 12, netR: "-1.5" });
    expect(storedPeriodicFacts({ sample: {} })).toBeNull();
    expect(periodicFactModels({ trades: 0, netR: null }).facts).toEqual([{ label: "Sample", value: "0 trades" }]);
  });

  it("failed entries render the human reason and accounting outcome; latestCompleted skips them", () => {
    const failedRow = historyRow("ANALYZE_SETUP", request(6, operation("ANALYZE_SETUP", "ANALYZE_SETUP_V1"), "2026-09-23T12:28:00Z"), { status: "FAILED", interpretation: null, error_code: "SCREENSHOT_CHANGED", reservation_id: null, created_at: "2026-09-23T12:29:00Z" }, none, NOW);
    const failed: AiResultEntry = { ...failedRow, card: null };
    const text = visibleText(render(AnalyzeSetupCard, { entry: failed, riskLine: blocked }));
    expect(text).toContain("A selected screenshot changed after it was selected. Nothing was sent to the AI provider.");
    expect(text).toContain("Nothing was charged for this attempt.");
    expect(text).not.toContain("SCREENSHOT_CHANGED");
    expect(text).not.toMatch(/reservation/i);
    expect(latestCompleted([failed, analysisEntry])).toBe(analysisEntry);
    expect(latestCompleted([failed])).toBeNull();
  });

  it("states what a failed attempt cost in plain words for every accounting outcome", () => {
    const outcomes = [
      [null, null, "Nothing was charged for this attempt."],
      [59_400, "SETTLED", "The cost is recorded; unused funds were released."],
      [59_400, "UNCERTAIN", "The cost could not be confirmed; the held amount stays until it is reviewed."],
      [59_400, "CANCELLED", "Nothing was charged; the held amount was released."],
      [59_400, null, "The cost of this attempt is not settled yet; the held amount still counts toward this month's budget."],
      [59_400, "SOMETHING_NEW", "The cost of this attempt is not settled yet; the held amount still counts toward this month's budget."],
    ] as const;
    for (const [reservedMicros, disposition, copy] of outcomes) {
      expect(failureAccountingText({ reservedMicros, disposition })).toBe(copy);
      expect(copy).not.toMatch(/reservation|[A-Z]{2,}_/);
    }
  });
});

describe("FullAnalysisSheet", () => {
  it("lists every section, every item in full and every citation; raw ids only in Technical details", () => {
    const sections = (analysisEntry.card?.full ?? []).map(section => ({ heading: section.title, items: section.items.map(item => ({ text: item.text, sources: item.sources.map(sourceChipModel) })) }));
    const html = render(FullAnalysisBody, { sections, riskLine: blocked, limitations: ["Only one chart was selected."] });
    const text = visibleText(html);
    for (const heading of ["Setup", "Entry model", "Strengths", "Weaknesses", "Invalidation", "AI observations", "Evidence"]) expect(text).toContain(heading);
    expect(text).toContain("First confluence is recorded on the chart. Second sentence stays in the full analysis.");
    expect(text).toContain("Fourth confluence.");
    expect(text).toContain("What the AI could not assess");
    expect(text.indexOf("Risk Engine · Blocked")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text).not.toMatch(UUID);
    const technical = detailsBlocks(html).join("");
    expect(technical).toContain(`evidence:${IMAGE}`);
    expect(technical).toContain("currentThesis");
    // The trigger is server-rendered; the sheet content mounts on open (Radix portal).
    expect(visibleText(render(FullAnalysisSheet, { title: "Setup analysis", sections }))).toBe("View full analysis");
  });
});

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

describe("AiHistoryList", () => {
  const failedHistorical = historyRow(
    "WEEKLY_REVIEW",
    request(7, { id: "WEEKLY_REVIEW", version: "HISTORICAL_VERSION", provider: "openai", model: "gpt-5.4-mini" }, "2026-09-23T12:00:00Z"),
    { status: "FAILED", interpretation: null, error_code: "INVALID_OUTPUT", reservation_id: "80000000-0000-4000-8000-000000000001", created_at: "2026-09-23T12:01:00Z" },
    { holds: [{ id: "80000000-0000-4000-8000-000000000001", operation_id: "71000000-0000-4000-8000-000000000007", reserved_micros: 59400 }], usage: [{ reservation_id: "80000000-0000-4000-8000-000000000001", charged_micros: 59400, disposition: "UNCERTAIN" }] },
    NOW,
  );

  it("renders compact rows with the top finding", () => {
    const html = render(AiHistoryList, { rows: [{ ...analysisEntry, revision: revisionMarker(1, 2) }, challengeEntry] });
    const text = visibleText(html);
    expect(text).toContain("Analyze Setup · Completed · 07:01");
    expect(text).toContain("The recorded long proposal defines entry, stop and target.");
    expect(text).toContain("Based on draft revision 1 · current revision is 2");
    expect(text).toContain("Challenge My Bias · Completed · 07:06");
    expect(html).toMatch(/^<div[^>]*><ol aria-label="AI history"/);
  });

  it("keeps the technical fields of failed rows in the HTML, inside a collapsed element", () => {
    const html = render(AiHistoryList, { rows: [failedHistorical] });
    const visible = visibleText(html);
    expect(visible).toContain("Weekly Review · Failed · 07:01");
    expect(visible).toContain("The request did not complete.");
    expect(visible).toContain("The cost could not be confirmed; the held amount stays until it is reviewed.");
    expect(visible).not.toMatch(/reservation/i);
    for (const code of ["FAILED", "INVALID_OUTPUT", "HISTORICAL_VERSION", "UNCERTAIN", "59400"]) {
      expect(html).toContain(code);
      expect(visible).not.toContain(code);
    }
    const technical = detailsBlocks(html);
    expect(technical).toHaveLength(1);
    expect(technical[0]).toMatch(/^<details class="disclosure technical-details[^"]*">/);
    expect(technical[0]).not.toMatch(/^<details[^>]*\bopen\b/);
    expect(technical[0]).toContain("Technical details");
    expect(technical[0]).toContain("HISTORICAL_VERSION");
    expect(visible).not.toMatch(UUID);
    expect(render(AiHistoryList, { rows: [failedHistorical], developerMode: true })).toMatch(/<details[^>]*open=""/);
  });

  it("shows a request that is still running", () => {
    const running = historyRow("ANALYZE_SETUP", request(8, operation("ANALYZE_SETUP", "ANALYZE_SETUP_V1"), "2026-09-23T12:20:00Z"), null, none, NOW);
    const html = render(AiHistoryList, { rows: [running] });
    expect(visibleText(html)).toContain("Analyze Setup · In progress · 07:20");
    expect(visibleText(html)).toContain("Still running. Refresh to see the result.");
    expect(html).toContain('data-status="in-progress"');
  });

  it("moves older rows behind a disclosure and explains an empty history", () => {
    const html = render(AiHistoryList, { rows: [analysisEntry, challengeEntry, failedHistorical], limit: 1 });
    expect(visibleText(html)).toContain("Show 2 earlier");
    expect(visibleText(html)).not.toContain("Challenge My Bias");
    expect(html).toContain("Challenge My Bias");
    expect(visibleText(render(AiHistoryList, { rows: [] }))).toContain("No AI history yet.");
    expect(render(AiHistoryList, { rows: [], emptyText: null })).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------

describe("AiBudgetSummary", () => {
  const snapshot = (overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
    enabled: true, budgetCents: 500, usedMicros: 740_000, heldMicros: 0, uncertain: false, period: "2026-10-01", resetAt: "2026-11-01T05:00:00.000Z", ...overrides,
  });
  const budget = (snap: BudgetSnapshot | null, system: AiBudgetModel["system"]["status"] = "ENABLED"): AiBudgetModel => ({
    snapshot: snap,
    presentation: snap ? budgetPresentation(snap, system === "ENABLED") : null,
    system: { status: system, message: "x" },
    events: [{ id: 1, previous_enabled: false, enabled: true, previous_budget_cents: 500, budget_cents: 500, created_at: "2026-10-02T14:42:00Z" }],
    error: snap ? null : "AI budget controls are unavailable. No AI request can run; other Trading OS workflows remain available.",
  });

  const summary = (snap: BudgetSnapshot | null, system: AiBudgetModel["system"]["status"] = "ENABLED", compact = false) =>
    render(AiBudgetSummary, { accountName: "FTMO 100K", budget: budget(snap, system), compact, now: NOW });

  it("states usage, limit, remainder and reset day with one status chip", () => {
    const html = summary(snapshot());
    const text = visibleText(html);
    expect(text).toContain("AI usage this month · €0.74 of €5.00 · €4.26 left · resets Nov 1");
    expect(html.match(/data-budget-status="[^"]+"/g)).toEqual(['data-budget-status="On"']);
    expect(text).toContain("FTMO 100K");
    expect(text).toContain("Details");
    const details = detailsBlocks(html).join("");
    expect(details).toContain("gpt-5.4-mini");
    expect(details).toContain("Reserved for requests in progress");
    expect(details).toContain("Off → On");
    expect(text).not.toContain("gpt-5.4-mini");
  });

  it.each([
    [snapshot({ enabled: false }), "ENABLED", "Off"],
    [snapshot({ usedMicros: 4_950_000, heldMicros: 60_000 }), "ENABLED", "Limit reached"],
    [snapshot({ uncertain: true, heldMicros: 59_400 }), "ENABLED", "Paused — needs review"],
    [snapshot(), "DISABLED", "Unavailable"],
    [null, "ENABLED", "Unavailable"],
  ] as const)("status chip %#: %s", (snap, system, label) => {
    expect(aiBudgetStatus(budget(snap, system), NOW).label).toBe(label);
    expect(summary(snap, system)).toContain(`data-budget-status="${label}"`);
  });

  it("says Limit reached once the remainder can't cover the cheapest request, as the AI buttons do", () => {
    const operations = ["ANALYZE_SETUP", "CHALLENGE_BIAS", "REVIEW_TRADE_TIMELINE", "WEEKLY_REVIEW", "RECENT_TRADES_ANALYSIS", "MONTHLY_REVIEW"] as const;
    const smallest = Math.min(...operations.map(operation => estimateAiCost(operation, NOW).maxMicros));
    expect(smallestRequestMicros(NOW)).toBe(smallest);
    const cap = 500 * 10_000;
    const covered = aiBudgetStatus(budget(snapshot({ usedMicros: cap - smallest })), NOW);
    expect(covered).toEqual({ label: "On", tone: "positive", reason: null });
    // For example €4.97 of €5.00: €0.03 left, below every request's reserved maximum.
    const short = snapshot({ usedMicros: cap - smallest + 1 });
    expect(aiBudgetStatus(budget(short), NOW).label).toBe("Limit reached");
    const text = visibleText(summary(short));
    expect(text).toContain("Limit reached");
    expect(text).toContain("This month's budget can't cover another AI request.");
  });

  it("says Unavailable, not On, while AI pricing needs review", () => {
    const expired = new Date("2027-01-01T00:00:00Z");
    expect(smallestRequestMicros(expired)).toBeNull();
    const status = aiBudgetStatus(budget(snapshot()), expired);
    expect(status.label).toBe("Unavailable");
    expect(status.reason).toContain(PRICING_UNAVAILABLE);
    const html = render(AiBudgetSummary, { accountName: "FTMO 100K", budget: budget(snapshot()), now: expired });
    expect(html).toContain('data-budget-status="Unavailable"');
    expect(visibleText(html)).toContain(PRICING_UNAVAILABLE);
  });

  it("keeps held amounts in Details and never says 'reservation' by default", () => {
    const held = summary(snapshot({ heldMicros: 59_400 }));
    expect(visibleText(held)).toContain("AI usage this month · €0.74 of €5.00 · €4.20 left · resets Nov 1");
    expect(visibleText(held)).not.toMatch(/reserv/i);
    expect(detailsBlocks(held).join("")).toMatch(/Reserved for requests in progress<\/dt><dd[^>]*>€0\.06</);
    const uncertain = summary(snapshot({ uncertain: true, heldMicros: 59_400 }));
    expect(visibleText(uncertain)).toContain("The cost of an earlier request could not be confirmed, so the amount held for it stays in place.");
    expect(visibleText(uncertain)).not.toMatch(/reserv/i);
    expect(textOf(detailsBlocks(uncertain).join(""))).toContain("reserved for this request");
    for (const html of [held, uncertain, summary(snapshot(), "ENABLED", true), summary(snapshot({ heldMicros: 59_400 }), "ENABLED", true)]) {
      expect(html).not.toMatch(/reservation/i);
    }
  });

  it("renders a compact row for All Accounts", () => {
    const compact = render(AiBudgetSummary, { accountName: "Personal EUR", budget: budget(snapshot()), compact: true, now: NOW });
    expect(visibleText(compact)).toBe("Personal EUR €0.74 of €5.00 · €4.26 left On");
    expect(compact).not.toContain("<details");
    expect(visibleText(summary(snapshot({ heldMicros: 59_400 }), "ENABLED", true))).toBe("FTMO 100K €0.74 of €5.00 · €4.20 left On");
    expect(visibleText(summary(null))).toContain("AI budget controls are unavailable.");
  });
});

// ---------------------------------------------------------------------------------------------
// Paid button and estimates
// ---------------------------------------------------------------------------------------------

describe("AiActionButton", () => {
  const action = vi.fn(async () => ({ success: "Analysis saved.", status: "COMPLETED" }));
  const props = (overrides: Partial<AiActionButtonProps> = {}): AiActionButtonProps => ({
    operation: "ANALYZE_SETUP", label: "Analyze setup", action, payload: { tradeId: ids.plan, revision: "2" }, requestKey: "90000000-0000-4000-8000-000000000001",
    estimate: { typical: "€0.02", max: "€0.06" }, available: true, ...overrides,
  });

  it("shows the estimate in the label and never fires while rendering", () => {
    const html = render(AiActionButton, props());
    expect(visibleText(html)).toContain("Analyze setup · ≈ €0.02");
    expect(html).toMatch(/<button[^>]*class="btn btn-primary[^"]*"[^>]*data-operation="analyze-setup"/);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain('type="button"');
    expect(action).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("renders a blocked draft's tool as a secondary 'anyway' button", () => {
    const html = render(AiActionButton, props({ blockedLabel: "Analyze blocked setup anyway" }));
    expect(visibleText(html)).toContain("Analyze blocked setup anyway · ≈ €0.02");
    expect(html).toMatch(/class="btn btn-secondary[^"]*"/);
    expect(html).toContain('data-blocked="true"');
    expect(aiButtonLabel("Analyze setup", { typical: "€0.02", max: "€0.06" }, "Analyze blocked setup anyway")).toBe("Analyze blocked setup anyway · ≈ €0.02");
  });

  it("stays focusable but inert without pricing or availability, with the reason linked", () => {
    const noPricing = render(AiActionButton, props({ estimate: null }));
    expect(noPricing).toContain('aria-disabled="true"');
    expect(visibleText(noPricing)).toContain(PRICING_UNAVAILABLE);
    expect(visibleText(noPricing)).not.toContain("≈");
    const off = render(AiActionButton, props({ available: false, unavailableReason: "AI is off for this trading account. Turn it on in Settings → AI." }));
    const describedBy = /aria-describedby="([^"]+)"/.exec(off)?.[1] ?? "";
    expect(off).toContain(`id="${describedBy.split(" ")[0]}"`);
    expect(visibleText(off)).toContain("AI is off for this trading account.");
    expect(off).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("links a reason shown elsewhere through describedBy instead of repeating it", () => {
    const shared = render(AiActionButton, props({ available: false, unavailableReason: "", describedBy: "shared-reason" }));
    expect(shared).toMatch(/<button[^>]*aria-describedby="shared-reason"/);
    expect(shared).toContain('aria-disabled="true"');
    expect(shared).not.toContain('class="t-caption"');
    const both = render(AiActionButton, props({ available: false, unavailableReason: "AI is off for this trading account.", describedBy: "shared-reason" }));
    const ids = /aria-describedby="([^"]+)"/.exec(both)?.[1].split(" ") ?? [];
    expect(ids[0]).toBe("shared-reason");
    expect(ids).toHaveLength(2);
    expect(both).toContain(`id="${ids[1]}"`);
  });

  it("builds the request form and words every outcome", () => {
    const form = aiRequestForm({ tradeId: "t", tags: ["a", "b"] }, "k", ["e1", "e2", "e1"]);
    expect([...form.entries()]).toEqual([["tradeId", "t"], ["tags", "a"], ["tags", "b"], ["requestKey", "k"], ["evidence", "e1"], ["evidence", "e2"]]);
    expect(aiResultToast("ANALYZE_SETUP", { status: "COMPLETED", success: "Saved." })).toEqual({ tone: "positive", title: "Setup analysis ready", description: "Saved." });
    expect(aiResultToast("WEEKLY_REVIEW", { status: "FAILED", success: "Kept in history." })).toMatchObject({ tone: "warning", title: "Weekly review failed" });
    expect(aiResultToast("CHALLENGE_BIAS", { status: "RECORDED", success: "Already recorded." })).toMatchObject({ tone: "info", title: "Already requested" });
    expect(aiResultToast("REVIEW_TRADE_TIMELINE", { status: "ACCOUNT_OFF", error: "AI is OFF." })).toMatchObject({ tone: "negative", title: "Trade review not requested", description: "AI is OFF." });
  });

  it("submits one request per click: terminal outcomes rotate the key, refusals and dropped connections keep it", async () => {
    const form = aiRequestForm({ tradeId: ids.plan }, "90000000-0000-4000-8000-000000000001");
    const completed = vi.fn(async () => ({ success: "Analysis saved.", status: "COMPLETED" }));
    expect(await submitAiRequest(completed, form)).toEqual({ result: { success: "Analysis saved.", status: "COMPLETED" }, terminal: true });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith({}, form);
    expect((await submitAiRequest(async () => ({ success: "Already recorded.", status: "RECORDED" }), form)).terminal).toBe(true);
    expect((await submitAiRequest(async () => ({ success: "Kept in history.", status: "FAILED" }), form)).terminal).toBe(true);
    expect(await submitAiRequest(async () => ({ error: "AI is OFF for this account.", status: "ACCOUNT_OFF" }), form)).toEqual({ result: { error: "AI is OFF for this account.", status: "ACCOUNT_OFF" }, terminal: false });
    const dropped = await submitAiRequest(async () => { throw new TypeError("Failed to fetch"); }, form);
    expect(dropped.terminal).toBe(false);
    expect(dropped.result.error).toMatch(/never charged twice/);
  });

  it("renders inside the shell's toast provider", () => {
    expect(visibleText(wrap(ToastProvider, createElement(AiActionButton, props())))).toContain("Analyze setup · ≈ €0.02");
  });
});

describe("estimates", () => {
  it("formats the typical cost and the reserved maximum, and falls back to null when pricing expired (never throws)", () => {
    const live = aiEstimate("ANALYZE_SETUP", new Date("2026-10-18T12:00:00Z"));
    expect(live?.typical).toBe("€0.02");
    expect(live?.max).toMatch(/^€0\.\d\d$/);
    expect(aiEstimate("MONTHLY_REVIEW", new Date("2026-10-18T12:00:00Z"))?.typical).toBe("€0.03");
    expect(() => aiEstimate("ANALYZE_SETUP", new Date("2027-01-01T00:00:00Z"))).not.toThrow();
    expect(aiEstimate("ANALYZE_SETUP", new Date("2027-01-01T00:00:00Z"))).toBeNull();
    expect(aiEstimate("UNKNOWN" as never, new Date("2026-10-18T12:00:00Z"))).toBeNull();
    expect(estimateModel(null)).toBeNull();
    expect(estimateModel({ typicalMicros: 15_800, maxMicros: 60_001 })).toEqual({ typical: "€0.02", max: "€0.07" });
    expect(estimateModel({ typicalMicros: Number.NaN, maxMicros: 1 })).toBeNull();
  });
});

describe("evidence selection", () => {
  it("summarises what will be sent", () => {
    expect(evidenceSelectionSummary(2, 0, 3, 3)).toBe("Includes 2 selected screenshots.");
    expect(evidenceSelectionSummary(0, 0, 3, 3)).toBe("No screenshots selected. Select up to 3 in Evidence to include them.");
    expect(evidenceSelectionSummary(0, 0, 0, 3)).toBe("No screenshots available, so only your recorded text and numbers are sent.");
    expect(evidenceSelectionSummary(4, 1, 5, 3)).toBe("4 screenshots selected; this request accepts up to 3. Deselect some in Evidence. 1 selected screenshot isn't available to this tool and won't be sent.");
  });

  it("sends only eligible selected screenshots", async () => {
    const { AiEvidenceActions } = await import("@/components/ai/ai-evidence-actions");
    const button = { operation: "ANALYZE_SETUP" as const, label: "Analyze setup", action: vi.fn(), payload: {}, requestKey: "k", estimate: { typical: "€0.02", max: "€0.06" }, available: true };
    const actions = createElement(AiEvidenceActions, { buttons: [button], eligibleEvidenceIds: [IMAGE], maxEvidence: 3 });
    const html = render(EvidenceSelectionProvider, { max: 3, initialSelected: [IMAGE, "50000000-0000-4000-8000-000000000009"], children: actions });
    expect(visibleText(html)).toContain("Includes 1 selected screenshot. 1 selected screenshot isn't available to this tool and won't be sent.");
    expect(visibleText(render(AiEvidenceActions, { buttons: [button], eligibleEvidenceIds: [IMAGE], maxEvidence: 3 }))).toContain("No screenshots selected.");
  });

  it("shows a reason shared by every button once and links each button to it", async () => {
    const { AiEvidenceActions } = await import("@/components/ai/ai-evidence-actions");
    const reason = "Run the free risk check first. AI tools need the Risk Engine result for the current revision.";
    const base = { action: vi.fn(), payload: {}, requestKey: "k", estimate: { typical: "€0.02", max: "€0.06" }, available: false, unavailableReason: reason, secondary: true };
    const html = render(AiEvidenceActions, {
      buttons: [{ ...base, operation: "ANALYZE_SETUP", label: "Analyze setup" }, { ...base, operation: "CHALLENGE_BIAS", label: "Challenge my bias" }],
      eligibleEvidenceIds: [IMAGE],
      maxEvidence: 3,
    });
    expect(visibleText(html).split("Run the free risk check first.").length - 1).toBe(1);
    const described = [...html.matchAll(/<button\b[^>]*aria-describedby="([^"]+)"/g)].map(match => match[1]);
    expect(described).toHaveLength(2);
    expect(described[0]).toBe(described[1]);
    expect(html).toContain(`<p id="${described[0]}" class="t-caption">${reason}</p>`);
  });
});

// Typed fixture sanity: the chip type the components accept.
const _chip: SourceChipModel = { label: "Trade plan", kind: "plan" };
void _chip;
