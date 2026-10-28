import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisOutput } from "./fixtures/analyze-setup";
import { challengeOutput, source } from "./fixtures/bias-challenge";
import { output as tradeReviewOutput } from "./fixtures/trade-review";
import { facts as monthlyFacts, monthlyOutput } from "./fixtures/monthly-review";
import { facts as recentFacts, recentOutput } from "./fixtures/recent-trades";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// Composite AI panels (docs/V2_ARCHITECTURE.md §8.3, §11.1, §11.5): loaders mocked, no provider and no database.

type Row = Record<string, unknown>;
const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const IMAGE = "50000000-0000-4000-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend enum spellings (`ANALYZE_SETUP`, `TRADE_BLOCKED`, `RISK_LIMIT`): never in default HTML, attributes included. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

const m = vi.hoisted(() => {
  class ScopeError extends Error {}
  return {
    ScopeError,
    requireUser: vi.fn(),
    analyze: vi.fn(),
    challenge: vi.fn(),
    timeline: vi.fn(),
    tradeHistory: vi.fn(),
    availability: vi.fn(),
    weeklyOwner: vi.fn(),
    weeklyFacts: vi.fn(),
    recentOwner: vi.fn(),
    recentFacts: vi.fn(),
    monthlyOwner: vi.fn(),
    monthlyFacts: vi.fn(),
    refresh: vi.fn(),
    actions: {
      requestTradeAnalyzeSetup: vi.fn(), requestTradeBiasChallenge: vi.fn(), requestTradeTimelineReview: vi.fn(),
      requestWeeklyAiReview: vi.fn(), requestRecentTradesAiReview: vi.fn(), requestMonthlyAiReview: vi.fn(),
    },
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.requireUser }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: m.refresh, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/ai", () => m.actions);
vi.mock("@/lib/analyze-setup-data", () => ({ loadTradeAnalyzeSetupPanel: m.analyze }));
vi.mock("@/lib/bias-challenge-data", () => ({ loadTradeBiasChallengePanel: m.challenge }));
vi.mock("@/lib/trade-timeline-review-data", () => ({ loadTradeTimelineReviewPanel: m.timeline }));
vi.mock("@/lib/ai-history", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/ai-history")>()), loadTradeAiHistory: m.tradeHistory }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability }));
vi.mock("@/lib/account-context", () => ({
  getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
  getAccountContext: async () => ({ accounts: [{ id: ACCOUNT, name: "FTMO 100K" }] }),
}));
vi.mock("@/lib/weekly-review-source", () => ({ ownedWeeklyAccount: m.weeklyOwner, loadWeeklyFacts: m.weeklyFacts, WeeklyScopeError: m.ScopeError }));
vi.mock("@/lib/recent-trades-source", () => ({ ownedRecentAccount: m.recentOwner, loadRecentFacts: m.recentFacts, RecentScopeError: m.ScopeError }));
vi.mock("@/lib/monthly-review-source", () => ({ ownedMonthlyAccount: m.monthlyOwner, loadMonthlyFacts: m.monthlyFacts, MonthlyScopeError: m.ScopeError }));

import { HELD_RESERVATION_MESSAGE } from "@/ai/availability";
import type { PreTradePanel } from "@/ai/pre-trade-draft";
import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { storedRiskLine } from "@/components/ai/panel-data";
import { periodicScopeLine, PeriodicReviewPanel } from "@/components/ai/periodic-review-panel";
import { PreTradeAiPanel } from "@/components/ai/pre-trade-ai-panel";
import { TradeReviewAiPanel } from "@/components/ai/trade-review-ai-panel";
import { type AiRequestRow, type AiResultRow, historyRow, resolvedCard, revisionMarker } from "@/lib/ai-history";
import type { TradeTimelineReviewPanel } from "@/lib/trade-timeline-review-data";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

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
const visibleText = (html: string) => decode(stripDetails(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const html = async (pending: Promise<ReactElement | null>) => {
  const element = await pending;
  return element === null ? "" : renderToStaticMarkup(element);
};
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** Visible text of the element with this id (the first element carrying it). */
function elementText(markup: string, id: string): string {
  const at = markup.indexOf(` id="${id}"`);
  if (at < 0) return "";
  const open = markup.lastIndexOf("<", at);
  const tag = /^<([a-z0-9]+)/i.exec(markup.slice(open))?.[1] ?? "";
  return visibleText(markup.slice(open, markup.indexOf(`</${tag}>`, at)));
}

/** For every inert (`aria-disabled`) button: the text of the elements its `aria-describedby` points to. */
function inertButtonDescriptions(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => tag.includes('aria-disabled="true"'))
    .map(tag => (/aria-describedby="([^"]+)"/.exec(tag)?.[1].split(" ") ?? []).map(id => elementText(markup, id)).join(" ").trim());
}

/** The "Open AI settings" link keeps a 40px (44px on touch) hit target although it looks like a text link. */
function expectSettingsLink(markup: string) {
  const link = /<a\b[^>]*href="\/settings\?account=[^"]+#ai"[^>]*>/.exec(markup)?.[0] ?? "";
  expect(link).toContain(`href="/settings?account=${ACCOUNT}#ai"`);
  expect(link).toMatch(/class="[^"]*\bmin-h-10\b[^"]*"/);
  expect(link).toMatch(/class="[^"]*pointer-coarse:min-h-11[^"]*"/);
}

const request = (n: number, id: string, contract: string, createdAt: string): AiRequestRow => ({
  id: `71000000-0000-4000-8000-00000000000${n}`, operation: { id, version: `${id}_MINI_V1`, contract, provider: "openai", model: "gpt-5.4-mini" },
  created_at: createdAt, deadline_at: "2026-09-23T13:00:00Z",
});
const done = (interpretation: unknown, at: string): AiResultRow => ({ status: "COMPLETED", interpretation, error_code: null, reservation_id: null, created_at: at });
const NOW = new Date("2026-10-18T12:00:00Z");
const enabled = { status: "ENABLED" as const, message: "AI analysis is available", deepEnabled: false };

function preTradeEntry(operation: "ANALYZE_SETUP" | "CHALLENGE_BIAS", n: number, interpretation: unknown, facts: unknown, revision: number, latest = 2) {
  const row = historyRow(operation, request(n, operation, `${operation}_V1`, `2026-09-23T12:0${n}:00Z`), done(interpretation, `2026-09-23T12:0${n}:30Z`), { holds: [], usage: [] }, NOW);
  return { ...row, revision: revisionMarker(revision, latest), card: resolvedCard(row, interpretation, facts) };
}

function preTradePanel(operation: "ANALYZE_SETUP" | "CHALLENGE_BIAS", overrides: Partial<PreTradePanel> = {}): PreTradePanel {
  return {
    operation, state: "OPEN", stateMessage: null, revision: 2, riskDecision: "BLOCKED", availability: enabled,
    estimate: { typicalMicros: operation === "ANALYZE_SETUP" ? 18_500 : 15_800, maxMicros: 60_000 }, maxEvidence: 3,
    evidence: [{ id: IMAGE, source: "TRADE_EVIDENCE", label: "ENTRY", timeframe: "M5", caption: null, recordedAt: "2026-09-23T11:00:00Z" }],
    history: [], page: 0, hasOlder: false, error: null, ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of [m.requireUser, m.analyze, m.challenge, m.timeline, m.tradeHistory, m.availability, m.weeklyOwner, m.weeklyFacts, m.recentOwner, m.recentFacts, m.monthlyOwner, m.monthlyFacts, m.refresh, ...Object.values(m.actions)]) fn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

function expectNoAiRequest() {
  for (const action of Object.values(m.actions)) expect(action).not.toHaveBeenCalled();
  expect(m.refresh).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------------------------
// Pre-trade
// ---------------------------------------------------------------------------------------------

describe("PreTradeAiPanel", () => {
  const props = { tradeId: TRADE, accountId: ACCOUNT, currentRevision: 2, riskDecision: "BLOCKED" as const, riskLine: "Requested risk 2.00% exceeds your configured maximum of 0.50%." };
  const analysis = preTradeEntry("ANALYZE_SETUP", 1, analysisOutput, analyzeSetupContext(source, []), 1);
  const challenge = preTradeEntry("CHALLENGE_BIAS", 2, challengeOutput, biasChallengeContext(source, []), 2);

  it("offers only 'Analyze blocked setup anyway' on a blocked draft, as a secondary tool with its estimate", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { history: [analysis] }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { history: [challenge] }));
    const markup = await html(PreTradeAiPanel(props));
    const text = visibleText(markup);
    expect(text).toContain("Analyze blocked setup anyway · ≈ €0.02");
    expect(markup).toMatch(/<button[^>]*class="btn btn-secondary[^"]*"[^>]*data-operation="analyze-setup" data-blocked="true"/);
    // Spec §2.4: a blocked draft has no Challenge my bias; its earlier result and history stay visible.
    expect(text).not.toContain("Challenge my bias ·");
    expect(markup).not.toContain('data-operation="challenge-bias"');
    expect(count(markup, "data-operation=")).toBe(1);
    expect(text).toContain("Bias challenge");
    expect(text).toContain("Challenge My Bias · Completed");
    expect(markup).not.toContain("btn-primary");
    expect(markup).not.toContain('aria-disabled="true"');
    expect(text).toContain("No screenshots selected. Select up to 3 in Evidence to include them.");
    expect(m.analyze).toHaveBeenCalledWith(TRADE);
    expectNoAiRequest();
  });

  it("offers both tools as secondary buttons with estimates on a draft that is ready to lock", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { riskDecision: "APPROVED" }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { riskDecision: "APPROVED", maxEvidence: 2 }));
    const markup = await html(PreTradeAiPanel({ ...props, riskDecision: "APPROVED", riskLine: "" }));
    const text = visibleText(markup);
    expect(text).toContain("Analyze setup · ≈ €0.02");
    expect(text).toContain("Challenge my bias · ≈ €0.02");
    expect(markup).toMatch(/<button[^>]*class="btn btn-secondary[^"]*"[^>]*data-operation="challenge-bias"/);
    expect(markup).not.toContain("btn-primary");
    expect(text).toContain("Select up to 2 in Evidence");
    expectNoAiRequest();
  });

  it("shows the latest result of each tool with the Risk Engine line first and the stale marker", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { history: [analysis] }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { history: [challenge] }));
    // The analysis of revision 1 keeps the verdict stored with its request; the challenge of revision 2 shows today's.
    m.requireUser.mockResolvedValue({ db: fakeDb({ bias_challenges: [{ id: analysis.technical.requestId, user_id: USER, facts: analyzeSetupContext(source, []) }] }), user: { id: USER } });
    const markup = await html(PreTradeAiPanel(props));
    const text = visibleText(markup);
    expect(count(text, "Risk Engine · Blocked — Requested risk 2.00% exceeds your configured maximum of 0.50%.")).toBe(1);
    expect(text).toContain("Risk Engine · Blocked — Requested risk exceeds maximum · as checked for draft revision 1");
    expect(text.indexOf("Risk Engine · Blocked")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text.indexOf("as checked for draft revision 1")).toBeLessThan(text.indexOf("Requested risk 2.00%"));
    expect(text).toContain("Setup analysis");
    expect(text).toContain("Bias challenge");
    expect(count(text, "Based on draft revision 1 · current revision is 2")).toBe(2); // card and history row
    expect(text).toContain("Analyze Setup · Completed · 07:01");
    expect(text).toContain("Challenge My Bias · Completed · 07:02");
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/openai/);
    expect(stripDetails(markup)).not.toMatch(ENUM);
    expect(markup).toContain(analysis.technical.requestId);
    expectNoAiRequest();
  });

  it("never shows today's verdict on an analysis of an earlier revision, even when its stored verdict is unreadable", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { history: [analysis] }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS"));
    m.requireUser.mockRejectedValue(new Error("Session expired"));
    const text = visibleText(await html(PreTradeAiPanel(props)));
    expect(text).toContain("Based on draft revision 1 · current revision is 2");
    expect(text).toContain("AI interpretation · advisory");
    expect(text).not.toContain("Risk Engine ·");
    // An analysis of the current revision needs no stored verdict, so nothing extra is read.
    m.requireUser.mockClear();
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { history: [preTradeEntry("ANALYZE_SETUP", 1, analysisOutput, analyzeSetupContext(source, []), 2)] }));
    expect(count(visibleText(await html(PreTradeAiPanel(props))), "Risk Engine · Blocked — Requested risk 2.00%")).toBe(1);
    expect(m.requireUser).not.toHaveBeenCalled();
  });

  it("reads the stored verdict in words, never as a rule code", () => {
    expect(storedRiskLine(analyzeSetupContext(source, []))).toEqual({ decision: "BLOCKED", text: "Requested risk exceeds maximum" });
    expect(storedRiskLine({ deterministic: { status: "RISK_APPROVED", issues: [] } })).toEqual({ decision: "APPROVED", text: "" });
    expect(storedRiskLine({ deterministic: { status: "TRADE_BLOCKED", issues: [{ code: "FUTURE_RULE", severity: "BLOCK" }] } })).toEqual({ decision: "BLOCKED", text: "" });
    expect(storedRiskLine({ deterministic: { status: "SOMETHING_ELSE" } })).toBeNull();
    expect(storedRiskLine(null)).toBeNull();
  });

  it("waits for a fresh check when the approval is no longer current", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { riskDecision: "APPROVED", history: [preTradeEntry("ANALYZE_SETUP", 1, analysisOutput, analyzeSetupContext(source, []), 2)] }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { riskDecision: "APPROVED" }));
    const markup = await html(PreTradeAiPanel({ ...props, riskDecision: "RECHECK", riskLine: "The strategy session changed since the last check." }));
    const text = visibleText(markup);
    expect(count(text, "Recheck risk first.")).toBe(1);
    expect(count(markup, 'aria-disabled="true"')).toBe(2);
    // The reason is shown once, and each inert button points to it for screen readers.
    expect(inertButtonDescriptions(markup)).toEqual([expect.stringContaining("Recheck risk first."), expect.stringContaining("Recheck risk first.")]);
    expect(text).toContain("Risk Engine · Recheck needed — The strategy session changed since the last check.");
    expect(text).not.toContain("anyway");
    expectNoAiRequest();
  });

  it("labels the approved draft's tool plainly and asks for the free check first when unchecked", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP"));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS"));
    const approved = visibleText(await html(PreTradeAiPanel({ ...props, riskDecision: "APPROVED", riskLine: "" })));
    expect(approved).toContain("Analyze setup · ≈ €0.02");
    expect(approved).not.toContain("anyway");
    const unchecked = await html(PreTradeAiPanel({ ...props, riskDecision: "UNCHECKED", riskLine: "" }));
    expect(count(visibleText(unchecked), "Run the free risk check first.")).toBe(1);
    expect(count(unchecked, 'aria-disabled="true"')).toBe(2);
    expect(inertButtonDescriptions(unchecked)).toEqual([expect.stringContaining("Run the free risk check first."), expect.stringContaining("Run the free risk check first.")]);
  });

  it("explains why tools cannot run and links to the account's AI settings; expired pricing never throws", async () => {
    const off = { status: "ACCOUNT_OFF" as const, message: "AI is OFF for this account. Enable it explicitly in Settings.", deepEnabled: false };
    const approved = { ...props, riskDecision: "APPROVED" as const, riskLine: "" };
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { availability: off }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { availability: off }));
    const markup = await html(PreTradeAiPanel(approved));
    expect(count(visibleText(markup), "AI is off for this trading account. Turn it on in Settings → AI.")).toBe(1);
    expect(inertButtonDescriptions(markup)).toEqual([expect.stringContaining("AI is off for this trading account."), expect.stringContaining("AI is off for this trading account.")]);
    expectSettingsLink(markup);
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { estimate: null }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { estimate: null }));
    const priced = await html(PreTradeAiPanel(approved));
    expect(visibleText(priced)).toContain("AI pricing requires review before requests can run.");
    expect(visibleText(priced)).not.toContain("≈");
    expect(count(priced, 'aria-disabled="true"')).toBe(2);
    expect(inertButtonDescriptions(priced)).toEqual([expect.stringContaining("AI pricing requires review"), expect.stringContaining("AI pricing requires review")]);
  });

  it("offers no paid tool on a blocked draft while AI can't run it, and says why", async () => {
    const off = { status: "ACCOUNT_OFF" as const, message: "AI is OFF for this account. Enable it explicitly in Settings.", deepEnabled: false };
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { availability: off }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { availability: off }));
    const markup = await html(PreTradeAiPanel(props));
    const text = visibleText(markup);
    expect(markup).not.toContain("<button");
    expect(text).not.toContain("anyway");
    expect(text).not.toContain("screenshots");
    expect(count(text, "AI is off for this trading account. Turn it on in Settings → AI.")).toBe(1);
    expectSettingsLink(markup);
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { estimate: null }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { estimate: null }));
    const priced = await html(PreTradeAiPanel(props));
    expect(priced).not.toContain("<button");
    expect(visibleText(priced)).toContain("AI pricing requires review before requests can run.");
    expect(priced).not.toContain("/settings?");
    // Only the analysis matters on a blocked draft: Challenge my bias being unavailable changes nothing.
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP"));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { availability: off }));
    const analyzable = await html(PreTradeAiPanel(props));
    expect(visibleText(analyzable)).toContain("Analyze blocked setup anyway · ≈ €0.02");
    expect(analyzable).not.toContain("/settings?");
    expectNoAiRequest();
  });

  it("never offers pre-trade tools on live-first trades and degrades when loading fails", async () => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { state: "NOT_PLANNED" }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { state: "NOT_PLANNED" }));
    expect(await html(PreTradeAiPanel(props))).toBe("");
    m.analyze.mockRejectedValue(new Error("Trade unavailable"));
    expect(visibleText(await html(PreTradeAiPanel(props)))).toContain("AI tools are unavailable");
  });

  it("keeps history but no tools once the plan is locked", async () => {
    const locked = "This plan is already locked. Earlier analyses remain available as advisory history.";
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { state: "LOCKED", stateMessage: locked, history: [analysis] }));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", { state: "LOCKED", stateMessage: locked }));
    const text = visibleText(await html(PreTradeAiPanel(props)));
    expect(text).toContain(locked);
    expect(text).not.toContain("≈ €");
    expect(text).toContain("Analyze Setup · Completed");
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", { state: "LOCKED", stateMessage: locked }));
    expect(await html(PreTradeAiPanel(props))).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// Trade review
// ---------------------------------------------------------------------------------------------

describe("TradeReviewAiPanel", () => {
  const timelineOutput = {
    headline: { text: "The entry followed the plan and management stayed calm. More detail.", sourceRefs: ["execution"] },
    thesisCheck: { assessment: "NOT_RECORDED", text: "No plan was recorded.", sourceRefs: ["strategy"] },
    executionVsPlan: { assessment: "NO_PLAN", text: "Nothing to compare.", sourceRefs: ["execution"] },
    liveManagement: { assessment: "DISCIPLINED", text: "One stop change was recorded with a reason.", sourceRefs: ["execution"] },
    patterns: [], keyLesson: { text: "Write the plan before entry.", sourceRefs: ["execution"] }, limitations: [],
  };
  const timelineRow = historyRow("REVIEW_TRADE_TIMELINE", request(3, "REVIEW_TRADE_TIMELINE", "REVIEW_TRADE_TIMELINE_V1", "2026-09-23T14:00:00Z"), done(timelineOutput, "2026-09-23T14:01:00Z"), { holds: [], usage: [] }, NOW);
  const v1Row = historyRow("REVIEW_TRADE", request(4, "REVIEW_TRADE", "REVIEW_TRADE_V1", "2026-09-22T14:00:00Z"), done(tradeReviewOutput, "2026-09-22T14:01:00Z"), { holds: [], usage: [] }, NOW);
  const panel = (overrides: Partial<TradeTimelineReviewPanel> = {}): TradeTimelineReviewPanel => ({
    closed: true, origin: "LIVE_FIRST", planStatus: "NO_PLAN_RECORDED", availability: enabled, estimate: { typicalMicros: 16_000, maxMicros: 50_000 }, maxEvidence: 4,
    evidence: [], history: [{ ...timelineRow, review: null, card: resolvedCard(timelineRow, timelineOutput, {}) }], page: 0, hasOlder: false, error: null, ...overrides,
  });
  const props = { tradeId: TRADE, accountId: ACCOUNT, closed: true, noPlan: true };

  it("offers 'Review this trade' once closed, shows the latest review and lists V1 reviews in the history", async () => {
    m.timeline.mockResolvedValue(panel());
    m.tradeHistory.mockResolvedValue({ latestRevision: null, preTrade: [], reviews: [timelineRow, v1Row], error: null });
    const markup = await html(TradeReviewAiPanel(props));
    const text = visibleText(markup);
    expect(text).toContain("Review this trade · ≈ €0.02");
    expect(markup).toMatch(/class="btn btn-secondary[^"]*"[^>]*data-operation="review-trade-timeline"/);
    expect(text).toContain("No pre-trade plan recorded");
    expect(text.indexOf("From Trading OS")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text).toContain("The entry followed the plan and management stayed calm.");
    expect(text).toContain("Live management · Disciplined");
    expect(text).toContain("Trade Review · Completed · 09:01");
    expect(text).toContain("Trade Review · Completed · 09:01 Sep 22");
    expect(text).toContain(tradeReviewOutput.planAdherence.interpretation);
    expect(text).not.toMatch(UUID);
    expect(stripDetails(markup)).not.toMatch(ENUM);
    expectNoAiRequest();
  });

  it("shows only the history while the trade is open", async () => {
    m.timeline.mockResolvedValue(panel({ closed: false, history: [] }));
    m.tradeHistory.mockResolvedValue({ latestRevision: null, preTrade: [], reviews: [v1Row], error: null });
    const text = visibleText(await html(TradeReviewAiPanel({ ...props, closed: false, noPlan: false })));
    expect(text).toContain("Close the trade to request an AI review.");
    expect(text).not.toContain("Review this trade");
    expect(text).toContain("Trade Review · Completed");
    m.tradeHistory.mockResolvedValue({ latestRevision: null, preTrade: [], reviews: [], error: null });
    expect(await html(TradeReviewAiPanel({ ...props, closed: false, noPlan: false }))).toBe("");
  });

  it("falls back to the review panel's history and explains unavailability", async () => {
    m.timeline.mockResolvedValue(panel({ availability: { status: "BUDGET_REACHED", message: "x", deepEnabled: false } }));
    m.tradeHistory.mockRejectedValue(new Error("Trade unavailable"));
    const markup = await html(TradeReviewAiPanel(props));
    expect(visibleText(markup)).toContain("This month's AI budget can't cover another request.");
    expect(markup).toContain('aria-disabled="true"');
    expect(inertButtonDescriptions(markup)).toEqual([expect.stringContaining("This month's AI budget can't cover another request.")]);
    expectSettingsLink(markup);
    expect(visibleText(markup)).toContain("Trade Review · Completed · 09:01");
    m.timeline.mockRejectedValue(new Error("Trade unavailable"));
    expect(visibleText(await html(TradeReviewAiPanel(props)))).toContain("AI review is unavailable");
  });

  it("explains a held reservation in plain words on the review button, without sending the trader to settings", async () => {
    m.timeline.mockResolvedValue(panel({ availability: { status: "ACCOUNTING_REVIEW", message: HELD_RESERVATION_MESSAGE, deepEnabled: false } }));
    m.tradeHistory.mockRejectedValue(new Error("Trade unavailable"));
    const markup = await html(TradeReviewAiPanel(props));
    expect(visibleText(markup)).toContain(HELD_RESERVATION_MESSAGE);
    expect(markup).toContain('aria-disabled="true"');
    expect(inertButtonDescriptions(markup)).toEqual([HELD_RESERVATION_MESSAGE]);
    expect(markup).not.toContain("#ai");
  });
});

// ---------------------------------------------------------------------------------------------
// Periodic reviews
// ---------------------------------------------------------------------------------------------

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const conditions: ((row: Row) => boolean)[] = [];
      let limit = Number.MAX_SAFE_INTEGER;
      const result = () => ({ data: (tables[table] ?? []).filter(row => conditions.every(condition => condition(row))).slice(0, limit), error: null });
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { conditions.push(row => row[key] === value); return chain; },
        in: (key: string, values: unknown[]) => { conditions.push(row => values.includes(row[key])); return chain; },
        order: () => chain,
        limit: (n: number) => { limit = n; return chain; },
        // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable; this fake models that interface.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return chain;
    },
  };
}

describe("PeriodicReviewPanel", () => {
  const weekStart = "2025-10-06";
  const reviewRequest = { ...request(5, "WEEKLY_REVIEW", "WEEKLY_REVIEW_V1", "2025-10-13T12:00:00Z"), user_id: USER, account_id: ACCOUNT, week_start: weekStart, facts: weeklyFacts };
  const owner = (tables: Record<string, Row[]>) => ({ db: fakeDb(tables), user: { id: USER }, account: { id: ACCOUNT, name: "Original name" } });
  const tables = () => ({
    weekly_ai_reviews: [reviewRequest, { ...reviewRequest, id: "71000000-0000-4000-8000-000000000009", week_start: "2025-09-29" }],
    weekly_ai_review_results: [{ review_id: reviewRequest.id, ...done(weeklyOutput, "2025-10-13T12:01:00Z") }],
    ai_request_reservations: [],
    ai_usage_records: [],
  });

  it("explains a held reservation on the run button", async () => {
    m.weeklyOwner.mockResolvedValue(owner(tables()));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 8 } });
    m.availability.mockResolvedValue({ status: "ACCOUNTING_REVIEW", message: HELD_RESERVATION_MESSAGE, deepEnabled: false });
    const markup = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: "2025-10-08" }));
    expect(visibleText(markup)).toContain(HELD_RESERVATION_MESSAGE);
    expect(inertButtonDescriptions(markup)).toEqual([HELD_RESERVATION_MESSAGE]);
    expectNoAiRequest();
  });

  it("states the explicit scope and the limitation, with the run button and its estimate", async () => {
    m.weeklyOwner.mockResolvedValue(owner(tables()));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 8 } });
    m.availability.mockResolvedValue(enabled);
    const markup = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: "2025-10-08" }));
    const text = visibleText(markup);
    expect(text).toContain("Weekly review");
    expect(text).toContain("FTMO 100K · Week of Oct 6–12 (UTC−5) · 8 trades");
    expect(text).toContain("Live-first and imported trades are not yet included in periodic AI reviews.");
    expect(text).toContain("Review week of Oct 6–12 · ≈ €0.02");
    expect(markup).toMatch(/class="btn btn-primary[^"]*"[^>]*data-operation="weekly-review"/);
    expect(m.weeklyFacts).toHaveBeenCalledWith(expect.objectContaining({ account: expect.objectContaining({ id: ACCOUNT }) }), weekStart);
    expect(m.availability).toHaveBeenCalledWith(ACCOUNT, "WEEKLY_REVIEW");
    expectNoAiRequest();
  });

  it("shows the period's latest review with Trading OS facts apart from the AI text, and only this period's history", async () => {
    m.weeklyOwner.mockResolvedValue(owner(tables()));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 8 } });
    m.availability.mockResolvedValue(enabled);
    const markup = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart }));
    const text = visibleText(markup);
    expect(stripDetails(markup)).not.toMatch(ENUM);
    expect(text).toContain("From Trading OS Sample 1 trade Net R +3.00R");
    expect(text.indexOf("From Trading OS")).toBeLessThan(text.indexOf("AI interpretation · advisory"));
    expect(text).toContain("Went well");
    expect(text).toContain("Weekly Review · Completed · 07:01");
    expect(count(text, "Weekly Review ·")).toBe(2); // card meta and the one history row of this week
    expect(text).not.toMatch(UUID);
  });

  it("disables the run button with the scope reason, and for an empty period", async () => {
    m.weeklyOwner.mockResolvedValue(owner(tables()));
    m.weeklyFacts.mockRejectedValue(new m.ScopeError("Choose a completed week. Weekly Review starts after Sunday ends in fixed UTC−5."));
    m.availability.mockResolvedValue(enabled);
    const incomplete = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart }));
    expect(visibleText(incomplete)).toContain("Choose a completed week.");
    expect(visibleText(incomplete)).toContain("FTMO 100K · Week of Oct 6–12 (UTC−5)");
    expect(incomplete).toContain('aria-disabled="true"');
    m.weeklyFacts.mockResolvedValue({ sample: { count: 0 } });
    expect(visibleText(await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart })))).toContain("No completed trades in this week, so there is nothing to review.");
  });

  it("rejects an invalid period and degrades for an unavailable account", async () => {
    expect(visibleText(await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: "not-a-day" })))).toContain("Choose a valid week.");
    expect(visibleText(await html(PeriodicReviewPanel({ kind: "recent", accountId: ACCOUNT, period: 15 })))).toContain("Choose 10, 20 or 30 completed trades.");
    m.weeklyOwner.mockRejectedValue(new Error("Account unavailable"));
    expect(visibleText(await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart })))).toContain("AI review is unavailable");
    expect(periodicScopeLine({ accountName: "FTMO 100K", scopeLabel: "September 2026 (UTC−5)", trades: null })).toBe("FTMO 100K · September 2026 (UTC−5)");
  });

  it("recent trades: the requested sample, the trades available and each run's own sample", async () => {
    const recentRequest = { ...request(6, "RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1", "2026-10-10T12:00:00Z"), user_id: USER, account_id: ACCOUNT, requested_sample: 20, actual_sample: 12, facts: recentFacts };
    m.recentOwner.mockResolvedValue(owner({
      recent_ai_analyses: [recentRequest, { ...recentRequest, id: "71000000-0000-4000-8000-000000000008", requested_sample: 10 }],
      recent_ai_analysis_results: [{ review_id: recentRequest.id, ...done(recentOutput, "2026-10-10T12:01:00Z") }],
      ai_request_reservations: [],
      ai_usage_records: [],
    }));
    m.recentFacts.mockResolvedValue({ facts: { sample: { actual: 12 } }, eligibleCount: 12 });
    m.availability.mockResolvedValue(enabled);
    const markup = await html(PeriodicReviewPanel({ kind: "recent", accountId: ACCOUNT, period: 20 }));
    const text = visibleText(markup);
    expect(text).toContain("Recent trades analysis");
    expect(text).toContain("FTMO 100K · Most recent 20 completed trades · 12 trades");
    expect(text).toContain("Analyze last 20 trades · ≈ €0.03");
    expect(text).toContain("Recent Trades Analysis · Completed · 07:01 Oct 10 · Last 12 trades (20 requested)");
    expect(count(text, "Recent Trades Analysis · Completed")).toBe(2);
    expect(m.recentFacts).toHaveBeenCalledWith(expect.anything(), 20);
    expect(m.availability).toHaveBeenCalledWith(ACCOUNT, "RECENT_TRADES_ANALYSIS");
    expect(stripDetails(markup)).not.toMatch(ENUM);
  });

  it("monthly: the calendar month in fixed UTC−5 with its trade count", async () => {
    const monthlyRequest = { ...request(7, "MONTHLY_REVIEW", "MONTHLY_REVIEW_V1", "2026-10-02T12:00:00Z"), user_id: USER, account_id: ACCOUNT, month_start: "2026-09-01", facts: monthlyFacts };
    m.monthlyOwner.mockResolvedValue(owner({
      monthly_ai_reviews: [monthlyRequest],
      monthly_ai_review_results: [{ review_id: monthlyRequest.id, ...done(monthlyOutput, "2026-10-02T12:01:00Z") }],
      ai_request_reservations: [],
      ai_usage_records: [],
    }));
    m.monthlyFacts.mockResolvedValue({ sample: { count: 31 } });
    m.availability.mockResolvedValue(enabled);
    const text = visibleText(await html(PeriodicReviewPanel({ kind: "monthly", accountId: ACCOUNT, period: "2026-09" })));
    expect(text).toContain("FTMO 100K · September 2026 (UTC−5) · 31 trades");
    expect(text).toContain("Review September 2026 · ≈ €0.03");
    expect(text).toContain("Monthly Review · Completed · 07:01");
    expect(text).toContain("Went well");
    expect(m.monthlyFacts).toHaveBeenCalledWith(expect.anything(), "2026-09");
    expect(visibleText(await html(PeriodicReviewPanel({ kind: "monthly", accountId: ACCOUNT, period: "2026-13" })))).toContain("Choose a valid month.");
  });
});
