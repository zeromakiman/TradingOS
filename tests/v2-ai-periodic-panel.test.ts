import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facts as recentFacts } from "./fixtures/recent-trades";
import { facts as weeklyFacts, weeklyOutput } from "./fixtures/weekly-review";

// The periodic review panel's run button (docs/V2_ARCHITECTURE.md §11.5): while a review of the period is still
// running, the database would refuse another one, so the button waits and says why. Loaders mocked, no provider.

type Row = Record<string, unknown>;
const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-20T12:00:00Z");

const m = vi.hoisted(() => {
  class ScopeError extends Error {}
  return {
    ScopeError, requireUser: vi.fn(), availability: vi.fn(), weeklyOwner: vi.fn(), weeklyFacts: vi.fn(), recentOwner: vi.fn(), recentFacts: vi.fn(), monthlyOwner: vi.fn(), monthlyFacts: vi.fn(),
    actions: { requestWeeklyAiReview: vi.fn(), requestRecentTradesAiReview: vi.fn(), requestMonthlyAiReview: vi.fn() },
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.requireUser }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/ai", () => m.actions);
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability }));
vi.mock("@/lib/account-context", () => ({
  getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
  getAccountContext: async () => ({ accounts: [{ id: ACCOUNT, name: "FTMO 100K", status: "ACTIVE" }] }),
}));
vi.mock("@/lib/weekly-review-source", () => ({ ownedWeeklyAccount: m.weeklyOwner, loadWeeklyFacts: m.weeklyFacts, WeeklyScopeError: m.ScopeError }));
vi.mock("@/lib/recent-trades-source", () => ({ ownedRecentAccount: m.recentOwner, loadRecentFacts: m.recentFacts, RecentScopeError: m.ScopeError }));
vi.mock("@/lib/monthly-review-source", () => ({ ownedMonthlyAccount: m.monthlyOwner, loadMonthlyFacts: m.monthlyFacts, MonthlyScopeError: m.ScopeError }));

import { PeriodicReviewPanel } from "@/components/ai/periodic-review-panel";

/** A query double over in-memory rows: equality and `in` filters, order ignored, limit applied. */
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

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (html: string) => decode(html.replace(/<details\b[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const html = async (pending: Promise<ReactElement | null>) => {
  const element = await pending;
  return element === null ? "" : renderToStaticMarkup(element);
};
/** The run button's tag (the paid button carries the operation token). */
const runButton = (markup: string, operation: string) => [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`data-operation="${operation}"`)) ?? "";

const operation = (id: string, contract: string) => ({ id, version: `${id}_MINI_V1`, contract, provider: "openai", model: "gpt-5.4-mini" });
const owner = (tables: Record<string, Row[]>) => ({ db: fakeDb(tables), user: { id: USER }, account: { id: ACCOUNT, name: "FTMO 100K" } });
const accounting = { ai_request_reservations: [], ai_usage_records: [], ai_uncertainty_resolutions: [] };
const enabled = { status: "ENABLED", message: "", deepEnabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.availability.mockResolvedValue(enabled);
  // The account-wide running state of Recent trades is read with the session; by default nothing runs.
  m.requireUser.mockResolvedValue({ db: fakeDb({}), user: { id: USER } });
});
afterEach(() => vi.useRealTimers());

describe("PeriodicReviewPanel run button", () => {
  const weekStart = "2026-10-12";
  const request = (id: string, createdAt: string, deadlineAt: string) => ({
    id, user_id: USER, account_id: ACCOUNT, week_start: weekStart, facts: weeklyFacts, operation: operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), created_at: createdAt, deadline_at: deadlineAt,
  });
  const completed = request("71000000-0000-4000-8000-000000000001", "2026-10-19T12:00:00Z", "2026-10-19T12:05:00Z");
  const result = { review_id: completed.id, status: "COMPLETED", interpretation: weeklyOutput, error_code: null, reservation_id: null, created_at: "2026-10-19T12:01:00Z" };

  it("waits while a review of the week is still running, says why, and runs again once it has a result", async () => {
    const running = request("71000000-0000-4000-8000-000000000002", "2026-10-20T11:58:00Z", "2026-10-20T12:03:00Z");
    m.weeklyOwner.mockResolvedValue(owner({ weekly_ai_reviews: [running, completed], weekly_ai_review_results: [result], ...accounting }));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 4 } });
    const markup = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart }));
    const text = visibleText(markup);
    expect(text).toContain("Weekly Review · In progress");
    expect(text).toContain("A review of the week of Oct 12–18 is still running. Its result will appear in the history.");
    expect(runButton(markup, "weekly-review")).toContain('aria-disabled="true"');
    expect(m.actions.requestWeeklyAiReview).not.toHaveBeenCalled();

    // The same history without the running request: the button runs.
    m.weeklyOwner.mockResolvedValue(owner({ weekly_ai_reviews: [completed], weekly_ai_review_results: [result], ...accounting }));
    const idle = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart }));
    expect(runButton(idle, "weekly-review")).not.toContain("aria-disabled");
    expect(visibleText(idle)).not.toContain("is still running");
  });

  it("a request past its deadline without a result no longer holds the button (the database lock ends with it)", async () => {
    const expired = request("71000000-0000-4000-8000-000000000003", "2026-10-20T10:00:00Z", "2026-10-20T10:05:00Z");
    m.weeklyOwner.mockResolvedValue(owner({ weekly_ai_reviews: [expired], weekly_ai_review_results: [], ...accounting }));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 4 } });
    const markup = await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart }));
    expect(runButton(markup, "weekly-review")).not.toContain("aria-disabled");
  });

  it("recent trades: an analysis of the same sample still running holds the button with the sample in words", async () => {
    const running = {
      id: "71000000-0000-4000-8000-000000000004", user_id: USER, account_id: ACCOUNT, requested_sample: 20, actual_sample: 20, facts: recentFacts,
      operation: operation("RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1"), created_at: "2026-10-20T11:59:00Z", deadline_at: "2026-10-20T12:04:00Z",
    };
    m.recentOwner.mockResolvedValue(owner({ recent_ai_analyses: [running], recent_ai_analysis_results: [], ...accounting }));
    m.recentFacts.mockResolvedValue({ facts: { sample: { actual: 20 } }, eligibleCount: 31 });
    const markup = await html(PeriodicReviewPanel({ kind: "recent", accountId: ACCOUNT, period: 20 }));
    expect(visibleText(markup)).toContain("An analysis of the last 20 trades is still running. Its result will appear in the history.");
    expect(runButton(markup, "recent-trades-analysis")).toContain('aria-disabled="true"');
  });

  describe("recent trades: one analysis runs per account, whatever its sample", () => {
    const analysis = (id: string, sample: number, createdAt: string, deadlineAt: string) => ({
      id, user_id: USER, account_id: ACCOUNT, requested_sample: sample, actual_sample: sample, facts: recentFacts,
      operation: operation("RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1"), created_at: createdAt, deadline_at: deadlineAt,
    });
    const running20 = analysis("71000000-0000-4000-8000-000000000006", 20, "2026-10-20T11:59:00Z", "2026-10-20T12:09:00Z");
    const render30 = async (tables: Record<string, Row[]>) => {
      m.recentOwner.mockResolvedValue(owner(tables));
      m.requireUser.mockResolvedValue({ db: fakeDb(tables), user: { id: USER } });
      m.recentFacts.mockResolvedValue({ facts: { sample: { actual: 30 } }, eligibleCount: 31 });
      return html(PeriodicReviewPanel({ kind: "recent", accountId: ACCOUNT, period: 30 }));
    };

    it("a running 20-trade analysis holds the 30-trade button and names the running sample", async () => {
      const markup = await render30({ recent_ai_analyses: [running20], recent_ai_analysis_results: [], ...accounting });
      const text = visibleText(markup);
      // The 30-trade history has no running row: the reason comes from the account's running analysis.
      expect(text).not.toContain("In progress");
      expect(text).toContain(
        "An analysis of the last 20 trades is still running, and an account runs one recent-trades analysis at a time. Its result will appear under 20 trades.",
      );
      expect(runButton(markup, "recent-trades-analysis")).toContain('aria-disabled="true"');
      // Read with the session and an explicit owner filter.
      expect(m.requireUser).toHaveBeenCalled();
      expect(m.actions.requestRecentTradesAiReview).not.toHaveBeenCalled();
    });

    it("an analysis that has its result, or is past its deadline, no longer holds another sample's button", async () => {
      const result = { review_id: running20.id, status: "COMPLETED", interpretation: {}, error_code: null, reservation_id: null, created_at: "2026-10-20T12:00:30Z" };
      const done = await render30({ recent_ai_analyses: [running20], recent_ai_analysis_results: [result], ...accounting });
      expect(runButton(done, "recent-trades-analysis")).not.toContain("aria-disabled");
      const expired = analysis("71000000-0000-4000-8000-000000000007", 20, "2026-10-20T11:00:00Z", "2026-10-20T11:10:00Z");
      const late = await render30({ recent_ai_analyses: [expired], recent_ai_analysis_results: [], ...accounting });
      expect(runButton(late, "recent-trades-analysis")).not.toContain("aria-disabled");
      expect(visibleText(late)).not.toContain("is still running");
    });

    it("another account's running analysis holds nothing, and an unreadable running state leaves the button to the history", async () => {
      const foreign = { ...running20, account_id: "20000000-0000-4000-8000-000000000002" };
      expect(runButton(await render30({ recent_ai_analyses: [foreign], recent_ai_analysis_results: [], ...accounting }), "recent-trades-analysis")).not.toContain("aria-disabled");
      m.recentOwner.mockResolvedValue(owner({ recent_ai_analyses: [], recent_ai_analysis_results: [], ...accounting }));
      m.requireUser.mockRejectedValue(new Error("network"));
      const markup = await html(PeriodicReviewPanel({ kind: "recent", accountId: ACCOUNT, period: 30 }));
      expect(runButton(markup, "recent-trades-analysis")).not.toContain("aria-disabled");
      expect(visibleText(markup)).not.toContain("could not be loaded");
    });
  });

  it("an account whose AI is off explains that first: the settings fix comes before waiting", async () => {
    const running = request("71000000-0000-4000-8000-000000000005", "2026-10-20T11:58:00Z", "2026-10-20T12:03:00Z");
    m.weeklyOwner.mockResolvedValue(owner({ weekly_ai_reviews: [running], weekly_ai_review_results: [], ...accounting }));
    m.weeklyFacts.mockResolvedValue({ sample: { count: 4 } });
    m.availability.mockResolvedValue({ status: "ACCOUNT_OFF", message: "Off", deepEnabled: false });
    const text = visibleText(await html(PeriodicReviewPanel({ kind: "weekly", accountId: ACCOUNT, period: weekStart })));
    expect(text).toContain("AI is off for this trading account. Turn it on in Settings → AI.");
    expect(text).not.toContain("is still running. Its result");
  });
});
