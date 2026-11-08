import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisOutput } from "./fixtures/analyze-setup";
import { challengeOutput, source } from "./fixtures/bias-challenge";
import { facts as monthlyFacts, monthlyOutput } from "./fixtures/monthly-review";
import { facts as recentFacts, recentOutput } from "./fixtures/recent-trades";
import { events, plan, risk, strategy, trade, output as tradeReviewOutput } from "./fixtures/trade-review";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// V2 replacements of tests whose V1 subjects are deleted:
// - tests/ai-failure-accounting-ui.test.ts (V1 panels of the six AI operations): a failed attempt states its actual
//   accounting outcome for every operation and outcome, keeps codes and versions in Technical details, never rewrites
//   the stored rows, and historical facts without a source manifest stay readable;
// - tests/{weekly,recent,monthly}-review-actions-data.test.ts (V1 loaders src/lib/*-review-data.ts): the V2 periodic
//   loader reads history only for the owner, account and period, keeps saved history when the period's trades can't
//   be read, degrades to a message when history can't be read, and never converts a refused account into another;
// - tests/ai-disabled.test.ts (V1 SetupControls): with AI off for the deployment or misconfigured, the pre-trade tools
//   stay visible but inert, say why, raise no alert and request nothing.

type Row = Record<string, unknown>;
const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000009";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const RESERVATION = "80000000-0000-4000-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

const m = vi.hoisted(() => {
  class ScopeError extends Error {}
  return {
    ScopeError,
    reads: [] as { table: string; filters: [string, unknown][] }[],
    availability: vi.fn(),
    weeklyOwner: vi.fn(), weeklyFacts: vi.fn(), recentOwner: vi.fn(), recentFacts: vi.fn(), monthlyOwner: vi.fn(), monthlyFacts: vi.fn(),
    analyze: vi.fn(), challenge: vi.fn(),
    actions: {
      requestTradeAnalyzeSetup: vi.fn(), requestTradeBiasChallenge: vi.fn(), requestTradeTimelineReview: vi.fn(),
      requestWeeklyAiReview: vi.fn(), requestRecentTradesAiReview: vi.fn(), requestMonthlyAiReview: vi.fn(),
    },
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: { from: () => ({}) }, user: { id: USER } }) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/ai", () => m.actions);
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability }));
vi.mock("@/lib/account-context", () => ({
  getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
  getAccountContext: async () => ({ accounts: [{ id: ACCOUNT, name: "FTMO 100K" }] }),
}));
vi.mock("@/lib/weekly-review-source", () => ({ ownedWeeklyAccount: m.weeklyOwner, loadWeeklyFacts: m.weeklyFacts, WeeklyScopeError: m.ScopeError }));
vi.mock("@/lib/recent-trades-source", () => ({ ownedRecentAccount: m.recentOwner, loadRecentFacts: m.recentFacts, RecentScopeError: m.ScopeError }));
vi.mock("@/lib/monthly-review-source", () => ({ ownedMonthlyAccount: m.monthlyOwner, loadMonthlyFacts: m.monthlyFacts, MonthlyScopeError: m.ScopeError }));
vi.mock("@/lib/analyze-setup-data", () => ({ loadTradeAnalyzeSetupPanel: m.analyze }));
vi.mock("@/lib/bias-challenge-data", () => ({ loadTradeBiasChallengePanel: m.challenge }));

import type { PreTradePanel } from "@/ai/pre-trade-draft";
import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { tradeReviewContext } from "@/ai/trade-review-context";
import { AiHistoryList } from "@/components/ai/ai-history-list";
import { failureAccountingText } from "@/components/ai/model";
import { loadPeriodicAi } from "@/components/ai/panel-data";
import { PeriodicReviewPanel } from "@/components/ai/periodic-review-panel";
import { PreTradeAiPanel } from "@/components/ai/pre-trade-ai-panel";
import { type AiAccounting, type AiHistoryOperation, type AiRequestRow, type AiResultRow, aiFailureReason, historyRow, resolvedCard } from "@/lib/ai-history";

/** Collapses every `<details>` element to its summary: what a reader sees by default. */
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
const detailsText = (html: string) => decode([...html.matchAll(/<details\b[\s\S]*?<\/details>/g)].map(match => match[0]).join(" ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

/** A PostgREST double that records every filter and can fail a table. */
function fakeDb(tables: Record<string, Row[]>, failing: ReadonlySet<string> = new Set()) {
  return {
    from(table: string) {
      const read = { table, filters: [] as [string, unknown][] };
      m.reads.push(read);
      const rows = () => (tables[table] ?? []).filter(row => read.filters.every(([key, value]) => (Array.isArray(value) ? value.includes(row[key]) : row[key] === value)));
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { read.filters.push([key, value]); return chain; },
        in: (key: string, values: unknown[]) => { read.filters.push([key, values]); return chain; },
        order: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable; this fake models that interface.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(failing.has(table) ? { data: null, error: { message: "SECRET relation detail" } } : { data: rows(), error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

const NOW = new Date("2026-10-18T12:00:00Z");
const enabled = { status: "ENABLED" as const, message: "AI analysis is available", deepEnabled: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.reads.length = 0;
  for (const fn of [m.availability, m.weeklyOwner, m.weeklyFacts, m.recentOwner, m.recentFacts, m.monthlyOwner, m.monthlyFacts, m.analyze, m.challenge, ...Object.values(m.actions)]) fn.mockReset();
  m.availability.mockResolvedValue(enabled);
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------------
// Failed attempts: every operation, every accounting outcome
// ---------------------------------------------------------------------------------------------------------------------
const OPERATIONS: [AiHistoryOperation, string][] = [
  ["ANALYZE_SETUP", "ANALYZE_SETUP_V1"], ["CHALLENGE_BIAS", "CHALLENGE_BIAS_V1"], ["REVIEW_TRADE", "REVIEW_TRADE_V1"], ["REVIEW_TRADE_TIMELINE", "REVIEW_TRADE_TIMELINE_V1"],
  ["WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"], ["RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1"], ["MONTHLY_REVIEW", "MONTHLY_REVIEW_V1"],
];

type ReviewDecision = "NO_PROVIDER_USAGE_CONFIRMED" | "USAGE_CONFIRMED";
/** What followed the attempt: the budget month of its hold, and the accounting review of an unconfirmed cost. */
interface Aftermath {
  period?: string;
  /** decision, reconciled, released and additional micro-euros. */
  review?: [ReviewDecision, number, number, number];
}

/** Accounting states of a failed attempt and what any honest wording of each must say. */
const OUTCOMES: [string, string | null | undefined, RegExp[], Aftermath][] = [
  ["settled", "SETTLED", [/recorded/i, /released/i], {}],
  ["uncertain", "UNCERTAIN", [/held/i, /until an accounting review confirms the cost or releases it/i, /nothing beyond it was charged/i], {}],
  // The stored UNCERTAIN record never changes; the review that followed it is what the budget applies.
  ["uncertain, then reviewed: no provider usage", "UNCERTAIN", [/^Reviewed/, /nothing was charged/i, /released/i], { review: ["NO_PROVIDER_USAGE_CONFIRMED", 0, 59_400, 0] }],
  ["uncertain, then reviewed: cost confirmed", "UNCERTAIN", [/^Reviewed/, /€0.03/, /released/i], { review: ["USAGE_CONFIRMED", 21_000, 38_400, 0] }],
  ["cancelled", "CANCELLED", [/nothing was charged/i, /released/i], {}],
  // No usage record: nothing can review the hold; it counts toward its own month until the budget resets.
  ["not reconciled", null, [/held/i, /October 2026/, /until it resets on Nov 1/, /nothing beyond it was charged/i], { period: "2026-10-01" }],
  ["not reconciled, from an earlier month", null, [/held/i, /September 2026/, /released when it reset on Oct 1/, /nothing beyond it was charged/i], { period: "2026-09-01" }],
  ["an unknown disposition", "SOMETHING_NEW", [/not settled/i, /held/i], {}],
  ["no reservation", undefined, [/nothing was charged/i], {}],
];

function failedAttempt(operation: AiHistoryOperation, contract: string, disposition: string | null | undefined, aftermath: Aftermath = {}) {
  const request: AiRequestRow = {
    id: "71000000-0000-4000-8000-000000000001", operation: { id: operation, version: "HISTORICAL_VERSION", contract, provider: "openai", model: "gpt-5.4-mini" },
    created_at: "2026-09-23T12:00:00Z", deadline_at: "2026-09-23T12:10:00Z",
  };
  const held = disposition !== undefined;
  const result: AiResultRow = { status: "FAILED", interpretation: null, error_code: "INVALID_OUTPUT", reservation_id: held ? RESERVATION : null, created_at: "2026-09-23T12:01:00Z" };
  const review = aftermath.review;
  const accounting: AiAccounting = {
    holds: held ? [{ id: RESERVATION, operation_id: request.id, reserved_micros: 59_400, period: aftermath.period ?? "2026-09-01" }] : [],
    usage: held && disposition !== null ? [{ reservation_id: RESERVATION, charged_micros: disposition === "UNCERTAIN" ? 59_400 : 1_000, disposition }] : [],
    reviews: review
      ? [{ reservation_id: RESERVATION, decision: review[0], reconciled_micros: review[1], released_micros: review[2], additional_micros: review[3], created_at: "2026-10-02T10:00:00Z" }]
      : [],
  };
  return { request, result, accounting };
}

describe("a failed AI attempt states its actual accounting outcome, for every operation", () => {
  for (const [operation, contract] of OPERATIONS) {
    it.each(OUTCOMES)(`${operation}: %s`, (_label, disposition, wording, aftermath) => {
      const attempt = failedAttempt(operation, contract, disposition, aftermath);
      const stored = structuredClone(attempt);
      const row = historyRow(operation, attempt.request, attempt.result, attempt.accounting, NOW);
      const html = renderToStaticMarkup(createElement(AiHistoryList, { rows: [row] }));
      const text = visibleText(html);
      expect(row.status).toBe("FAILED");
      expect(text).toContain(`${row.operationLabel} · Failed`);
      expect(text).toContain(aiFailureReason("INVALID_OUTPUT"));
      const accountingText = failureAccountingText(row.technical);
      expect(text).toContain(accountingText);
      expect(row.accountingNote).toBe(accountingText);
      for (const pattern of wording) expect(accountingText).toMatch(pattern);
      // Default view: words only. Codes, versions and accounting values stay in Technical details (kept in the HTML).
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(ENUM);
      expect(text).not.toMatch(/reserv/i);
      const technical = detailsText(html);
      expect(technical).toContain("INVALID_OUTPUT");
      expect(technical).toContain("HISTORICAL_VERSION");
      if (disposition) expect(technical).toContain(disposition);
      if (disposition !== undefined) expect(technical).toContain(RESERVATION);
      if (aftermath.review) expect(technical).toContain(aftermath.review[0]);
      // Reading history never rewrites it.
      expect(attempt).toEqual(stored);
    });
  }

  it("never words two different outcomes the same way", () => {
    const texts = OUTCOMES.filter(([label]) => label !== "an unknown disposition").map(([, disposition, , aftermath]) => {
      const attempt = failedAttempt("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1", disposition, aftermath);
      return failureAccountingText(historyRow("WEEKLY_REVIEW", attempt.request, attempt.result, attempt.accounting, NOW).technical);
    });
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("history written before source manifests existed stays readable", () => {
  const withoutManifest = (facts: object) => Object.fromEntries(Object.entries(facts).filter(([key]) => key !== "sourceManifest"));
  const cases: [AiHistoryOperation, string, unknown, object][] = [
    ["ANALYZE_SETUP", "ANALYZE_SETUP_V1", analysisOutput, analyzeSetupContext(source, [])],
    ["CHALLENGE_BIAS", "CHALLENGE_BIAS_V1", challengeOutput, biasChallengeContext(source, [])],
    ["REVIEW_TRADE", "REVIEW_TRADE_V1", tradeReviewOutput, tradeReviewContext(plan, trade, strategy, risk, events, [])],
    ["WEEKLY_REVIEW", "WEEKLY_REVIEW_V1", weeklyOutput, weeklyFacts],
    ["RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1", recentOutput, recentFacts],
    ["MONTHLY_REVIEW", "MONTHLY_REVIEW_V1", monthlyOutput, monthlyFacts],
  ];

  it.each(cases)("%s renders a completed result from facts without a manifest, leaving the facts untouched", (operation, contract, output, facts) => {
    const legacy = withoutManifest(facts);
    const stored = structuredClone(legacy);
    const request: AiRequestRow = { id: "71000000-0000-4000-8000-000000000002", operation: { id: operation, version: "HISTORICAL_VERSION", contract }, created_at: "2026-09-23T12:00:00Z", deadline_at: "2026-09-23T12:10:00Z" };
    const row = historyRow(operation, request, { status: "COMPLETED", interpretation: output, error_code: null, reservation_id: null, created_at: "2026-09-23T12:01:00Z" }, { holds: [], usage: [] }, NOW);
    expect(row.status).toBe("COMPLETED");
    const card = resolvedCard(row, output, legacy);
    expect(card).not.toBeNull();
    expect(card?.headline.text.length).toBeGreaterThan(0);
    // Sources resolve to friendly chips or a neutral one; a raw id is never the visible label.
    for (const section of card?.sections ?? []) for (const item of section.items) for (const chip of item.sources) expect(chip.label).not.toMatch(UUID);
    expect(legacy).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Periodic reviews: the V2 loader of the weekly, recent and monthly panels
// ---------------------------------------------------------------------------------------------------------------------
const owner = (tables: Record<string, Row[]>, failing?: ReadonlySet<string>) => ({ db: fakeDb(tables, failing), user: { id: USER }, account: { id: ACCOUNT, name: "FTMO 100K" } });
const operation = (id: string, contract: string) => ({ id, version: `${id}_MINI_V1`, contract, provider: "openai", model: "gpt-5.4-mini" });
const done = (key: string, id: string, interpretation: unknown) => ({ [key]: id, status: "COMPLETED", interpretation, error_code: null, reservation_id: null, created_at: "2026-10-13T12:01:00Z" });

const PERIODIC = {
  weekly: {
    period: "2025-10-08", requests: "weekly_ai_reviews", results: "weekly_ai_review_results", column: "week_start", value: "2025-10-06", other: "2025-09-29",
    operation: operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), facts: weeklyFacts, output: weeklyOutput,
    owned: () => m.weeklyOwner, load: () => m.weeklyFacts, loaded: { sample: { count: 8 } },
  },
  recent: {
    period: 20, requests: "recent_ai_analyses", results: "recent_ai_analysis_results", column: "requested_sample", value: 20, other: 10,
    operation: operation("RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1"), facts: recentFacts, output: recentOutput,
    owned: () => m.recentOwner, load: () => m.recentFacts, loaded: { facts: { sample: { actual: 12 } }, eligibleCount: 12 },
  },
  monthly: {
    period: "2026-09", requests: "monthly_ai_reviews", results: "monthly_ai_review_results", column: "month_start", value: "2026-09-01", other: "2026-08-01",
    operation: operation("MONTHLY_REVIEW", "MONTHLY_REVIEW_V1"), facts: monthlyFacts, output: monthlyOutput,
    owned: () => m.monthlyOwner, load: () => m.monthlyFacts, loaded: { sample: { count: 31 } },
  },
} as const;

function periodicTables(kind: keyof typeof PERIODIC) {
  const p = PERIODIC[kind];
  const base = { user_id: USER, account_id: ACCOUNT, operation: p.operation, facts: p.facts, created_at: "2026-10-13T12:00:00Z", deadline_at: "2026-10-13T12:10:00Z", requested_sample: 20, actual_sample: 12 };
  const mine = { ...base, id: "71000000-0000-4000-8000-000000000003", [p.column]: p.value };
  return {
    [p.requests]: [
      mine,
      { ...base, id: "71000000-0000-4000-8000-000000000004", [p.column]: p.other },
      { ...base, id: "71000000-0000-4000-8000-000000000005", [p.column]: p.value, account_id: OTHER },
      { ...base, id: "71000000-0000-4000-8000-000000000006", [p.column]: p.value, user_id: "10000000-0000-4000-8000-000000000009" },
    ],
    [p.results]: [done("review_id", mine.id, p.output)],
    ai_request_reservations: [],
    ai_usage_records: [],
  };
}

describe("periodic AI reviews read only the owner's history of that account and period", () => {
  it.each(Object.keys(PERIODIC) as (keyof typeof PERIODIC)[])("%s", async kind => {
    const p = PERIODIC[kind];
    p.owned().mockResolvedValue(owner(periodicTables(kind)));
    p.load().mockResolvedValue(p.loaded);
    const data = await loadPeriodicAi(kind, ACCOUNT, p.period);
    expect(data.history.map(row => row.technical.requestId)).toEqual(["71000000-0000-4000-8000-000000000003"]);
    expect(data.history[0].status).toBe("COMPLETED");
    expect(data.error).toBeNull();
    const read = m.reads.find(entry => entry.table === p.requests);
    expect(read?.filters).toEqual(expect.arrayContaining([["account_id", ACCOUNT], ["user_id", USER], [p.column, p.value]]));
    expect(m.availability).toHaveBeenCalledWith(ACCOUNT, p.operation.id);
    for (const action of Object.values(m.actions)) expect(action).not.toHaveBeenCalled();
  });
});

describe("periodic AI reviews degrade without losing saved history", () => {
  it.each(Object.keys(PERIODIC) as (keyof typeof PERIODIC)[])("%s: unreadable period trades keep the saved history and disable a new run", async kind => {
    const p = PERIODIC[kind];
    p.owned().mockResolvedValue(owner(periodicTables(kind)));
    p.load().mockRejectedValue(new Error("SECRET source failure"));
    const data = await loadPeriodicAi(kind, ACCOUNT, p.period);
    expect(data.trades).toBeNull();
    expect(data.scopeError).toBe("This period's trades could not be read. Nothing can be sent.");
    expect(data.history).toHaveLength(1);
    expect(data.error).toBeNull();
  });

  it.each(Object.keys(PERIODIC) as (keyof typeof PERIODIC)[])("%s: unreadable history becomes a message, never a broken page", async kind => {
    const p = PERIODIC[kind];
    p.owned().mockResolvedValue(owner(periodicTables(kind), new Set([p.requests])));
    p.load().mockResolvedValue(p.loaded);
    const data = await loadPeriodicAi(kind, ACCOUNT, p.period);
    expect(data.history).toEqual([]);
    expect(data.error).toBe("AI history is unavailable right now. Trading records are unaffected.");
    expect(data.scopeError).toBeNull();
    expect(data.availability.status).toBe("ENABLED");
  });

  it.each(Object.keys(PERIODIC) as (keyof typeof PERIODIC)[])("%s: a refused account is an error, never another account's history", async kind => {
    const p = PERIODIC[kind];
    p.owned().mockRejectedValue(new Error("Account unavailable"));
    await expect(loadPeriodicAi(kind, ACCOUNT, p.period)).rejects.toThrow();
    expect(m.reads).toEqual([]);
    expect(m.availability).not.toHaveBeenCalled();
  });

  it("shows the saved review with the run button inert when the week's trades can't be read", async () => {
    m.weeklyOwner.mockResolvedValue(owner(periodicTables("weekly")));
    m.weeklyFacts.mockRejectedValue(new Error("unavailable"));
    const markup = renderToStaticMarkup((await PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: "2025-10-08" })) as ReactElement);
    const text = visibleText(markup);
    expect(text).toContain("This period's trades could not be read. Nothing can be sent.");
    expect(text).toContain("Weekly Review · Completed");
    expect(markup).toContain('aria-disabled="true"');
    expect(text).not.toContain("SECRET");
    for (const action of Object.values(m.actions)) expect(action).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pre-trade tools while AI is off for the deployment or misconfigured
// ---------------------------------------------------------------------------------------------------------------------
function preTradePanel(operationId: "ANALYZE_SETUP" | "CHALLENGE_BIAS", availability: PreTradePanel["availability"]): PreTradePanel {
  return {
    operation: operationId, state: "OPEN", stateMessage: null, revision: 2, riskDecision: "APPROVED", availability,
    estimate: { typicalMicros: operationId === "ANALYZE_SETUP" ? 18_500 : 15_800, maxMicros: 60_000 }, maxEvidence: 3,
    evidence: [{ id: "50000000-0000-4000-8000-000000000001", source: "TRADE_EVIDENCE", label: "ENTRY", timeframe: "M5", caption: null, recordedAt: "2026-09-23T11:00:00Z" }],
    history: [], page: 0, hasOlder: false, error: null,
  };
}

describe("pre-trade AI tools while AI cannot run", () => {
  it.each([
    ["off for this deployment", { status: "DISABLED" as const, message: "AI analysis is currently disabled", deepEnabled: false }, "AI analysis is turned off for this deployment."],
    ["misconfigured", { status: "CONFIGURATION_ERROR" as const, message: "AI configuration error", deepEnabled: false }, "AI is unavailable right now. Other Trading OS workflows are unaffected."],
  ])("%s: both tools stay visible but inert, say why, raise no alert and request nothing", async (_label, availability, reason) => {
    m.analyze.mockResolvedValue(preTradePanel("ANALYZE_SETUP", availability));
    m.challenge.mockResolvedValue(preTradePanel("CHALLENGE_BIAS", availability));
    const markup = renderToStaticMarkup((await PreTradeAiPanel({ tradeId: TRADE, accountId: ACCOUNT, currentRevision: 2, riskDecision: "APPROVED", riskLine: "" })) as ReactElement);
    const text = visibleText(markup);
    expect(text).toContain(reason);
    const buttons = [...markup.matchAll(/<button\b[^>]*data-operation="[^"]+"[^>]*>/g)].map(match => match[0]);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toContain('aria-disabled="true"');
    expect(markup).not.toContain('role="alert"');
    // Nothing in Settings can fix a deployment-level state: no settings link is offered for it.
    expect(markup).not.toContain("/settings?account=");
    expect(stripDetails(markup)).not.toMatch(ENUM);
    for (const action of Object.values(m.actions)) expect(action).not.toHaveBeenCalled();
  });
});
