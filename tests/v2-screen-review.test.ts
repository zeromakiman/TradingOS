import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisOutput } from "./fixtures/analyze-setup";
import { monthlyOutput } from "./fixtures/monthly-review";
import { output as tradeReviewOutput } from "./fixtures/trade-review";
import { weeklyOutput } from "./fixtures/weekly-review";

// Review workspace (docs/V2_ARCHITECTURE.md §9.1–9.2, §11.1–11.2, §11.5, §13.7, §14.10, §15): the pages rendered with
// the session, account context, preferences and AI budget mocked, and every table read from an in-memory stand-in
// for PostgREST that applies the filters, order and limits the loaders send.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null; count: number | null };

const m = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    failing: new Set<string>(),
    queries: [] as string[],
    rpcs: [] as string[],
    context: null as unknown,
    preferences: { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false } as unknown,
    aiEnabled: false,
    accountsWithAiOff: new Set<string>(),
    /** Trades each periodic review would cover now, per kind (the panel's own scope check). */
    reviewable: { weekly: 5, recent: 8, monthly: 2 } as Record<string, number>,
    /** Pre-rendered real panels by `kind|account|period`; a stub that shows its props otherwise. */
    panels: new Map<string, unknown>(),
  };
  const field = (row: Row, column: string): unknown => {
    const [base, key] = column.split("->>");
    const value = row[base];
    if (key === undefined) return value;
    return value !== null && typeof value === "object" ? (value as Row)[key] : undefined;
  };
  const instant = /^\d{4}-\d{2}-\d{2}T/;
  const compare = (a: unknown, b: unknown): number | null => {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (typeof a === "string" && typeof b === "string" && instant.test(a) && instant.test(b)) return Date.parse(a) - Date.parse(b);
    if (typeof a === "number" && typeof b === "number") return a - b;
    const x = String(a);
    const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  /** The one logic tree the Review page sends: the history keyset cursor. */
  const cursor = (expression: string) => {
    const match = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/.exec(expression);
    if (!match) throw new Error(`Unexpected or(): ${expression}`);
    const [, at, , id] = match;
    return (row: Row) => {
      const order = compare(row.created_at, at);
      return order !== null && (order < 0 || (order === 0 && String(row.id) < id));
    };
  };
  class Query {
    private readonly filters: ((row: Row) => boolean)[] = [];
    private readonly orders: { column: string; ascending: boolean }[] = [];
    private take: number | null = null;
    private counted = false;
    private single = false;
    constructor(private readonly table: string) {}
    select(_columns?: string, options?: { count?: string }) {
      if (options?.count) this.counted = true;
      return this;
    }
    eq(column: string, expected: unknown) {
      this.filters.push(row => field(row, column) === expected);
      return this;
    }
    in(column: string, list: readonly unknown[]) {
      this.filters.push(row => list.includes(field(row, column)));
      return this;
    }
    private bound(column: string, value: unknown, test: (order: number) => boolean) {
      this.filters.push(row => {
        const order = compare(field(row, column), value);
        return order !== null && test(order);
      });
      return this;
    }
    gt(column: string, value: unknown) { return this.bound(column, value, order => order > 0); }
    gte(column: string, value: unknown) { return this.bound(column, value, order => order >= 0); }
    lt(column: string, value: unknown) { return this.bound(column, value, order => order < 0); }
    lte(column: string, value: unknown) { return this.bound(column, value, order => order <= 0); }
    not(column: string, operator: string, operand: unknown) {
      if (operator !== "is" || operand !== null) throw new Error(`Unexpected not(${operator})`);
      this.filters.push(row => field(row, column) !== null && field(row, column) !== undefined);
      return this;
    }
    filter(column: string, operator: string, operand: unknown) {
      if (operator !== "not.is" || operand !== null) throw new Error(`Unexpected filter(${operator})`);
      return this.not(column, "is", null);
    }
    or(expression: string) {
      this.filters.push(cursor(expression));
      return this;
    }
    order(column: string, options?: { ascending?: boolean }) {
      this.orders.push({ column, ascending: options?.ascending ?? true });
      return this;
    }
    limit(count: number) {
      this.take = count;
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private run(): Result {
      state.queries.push(this.table);
      if (state.failing.has(this.table)) return { data: null, error: { message: "unavailable" }, count: null };
      const rows = (state.tables[this.table] ?? []).filter(row => this.filters.every(test => test(row)));
      rows.sort((a, b) => {
        for (const { column, ascending } of this.orders) {
          const order = compare(field(a, column), field(b, column)) ?? 0;
          if (order !== 0) return ascending ? order : -order;
        }
        return 0;
      });
      const page = (this.take === null ? rows : rows.slice(0, this.take)).map(row => structuredClone(row));
      return { data: this.single ? (page[0] ?? null) : page, error: null, count: this.counted ? rows.length : null };
    }
    // biome-ignore lint/suspicious/noThenProperty: models Supabase's thenable query builder.
    then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
      return Promise.resolve(this.run()).then(onFulfilled, onRejected);
    }
  }
  const db = {
    from: (table: string) => new Query(table),
    rpc: (name: string) => {
      state.rpcs.push(name);
      return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
    },
  };
  class ScopeError extends Error {}
  return {
    state,
    db,
    ScopeError,
    USER: "10000000-0000-4000-8000-000000000001",
    push: vi.fn(),
    refresh: vi.fn(),
    actions: {
      requestTradeAnalyzeSetup: vi.fn(), requestTradeBiasChallenge: vi.fn(), requestTradeTimelineReview: vi.fn(),
      requestWeeklyAiReview: vi.fn(), requestRecentTradesAiReview: vi.fn(), requestMonthlyAiReview: vi.fn(),
    },
    /** Assigned once the test module has imported its helpers. */
    budget: (_accountId: string): unknown => null,
    panel: (_props: Row): unknown => null,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: m.db, user: { id: m.USER } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/app/actions/ai", () => m.actions);
vi.mock("@/lib/ai-budget", () => ({
  loadAiBudget: async (accountId: string) => m.budget(accountId),
  accountAiAvailability: async (accountId: string) =>
    !m.state.aiEnabled
      ? { status: "DISABLED", message: "AI analysis is currently disabled", deepEnabled: false }
      : m.state.accountsWithAiOff.has(accountId)
        ? { status: "ACCOUNT_OFF", message: "AI is OFF for this account.", deepEnabled: false }
        : { status: "ENABLED", message: "AI analysis is available", deepEnabled: false },
}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: m.refresh, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/lib/account-context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/account-context")>()),
  currentSession: async () => ({ db: m.db, user: { id: m.USER } }),
  getAccountContext: async () => m.state.context,
  getPreferences: async () => m.state.preferences,
}));
const owner = (accountId: string) => ({ db: m.db, user: { id: m.USER }, account: { id: accountId, name: "Account" } });
vi.mock("@/lib/weekly-review-source", () => ({
  ownedWeeklyAccount: async (accountId: string) => owner(accountId), loadWeeklyFacts: async () => ({ sample: { count: m.state.reviewable.weekly } }), WeeklyScopeError: m.ScopeError,
}));
vi.mock("@/lib/recent-trades-source", () => ({
  ownedRecentAccount: async (accountId: string) => owner(accountId),
  loadRecentFacts: async () => ({ facts: { sample: { actual: m.state.reviewable.recent } }, eligibleCount: m.state.reviewable.recent }),
  RecentScopeError: m.ScopeError,
}));
vi.mock("@/lib/monthly-review-source", () => ({
  ownedMonthlyAccount: async (accountId: string) => owner(accountId), loadMonthlyFacts: async () => ({ sample: { count: m.state.reviewable.monthly } }), MonthlyScopeError: m.ScopeError,
}));
vi.mock("@/components/ai/periodic-review-panel", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/ai/periodic-review-panel")>()),
  PeriodicReviewPanel: (props: Row) => m.panel(props),
}));

import ReviewHistoryLoading from "@/app/(app)/review/history/loading";
import ReviewHistoryPage from "@/app/(app)/review/history/page";
import ReviewLoading from "@/app/(app)/review/(index)/loading";
import MonthlyReviewPage from "@/app/(app)/review/monthly/page";
import ReviewPage from "@/app/(app)/review/(index)/page";
import RecentTradesReviewPage from "@/app/(app)/review/recent/page";
import WeeklyReviewPage from "@/app/(app)/review/weekly/page";
import { budgetPresentation } from "@/ai/budget";
import { PERIODIC_LIMITATION } from "@/components/ai/model";
import { contextSwitchHref } from "@/components/review/context-scope";
import { HISTORY_PAGE_SIZE, HISTORY_UNAVAILABLE } from "@/components/review/history-data";
import { decodeHistoryCursor } from "@/components/review/params";
import { EMPTY_COUNTS } from "@/components/review/periods";
import {
  INVALID_PERIOD, monthFactsPeriod, periodFacts, type ReviewView, UNAVAILABLE_ACCOUNT, UNAVAILABLE_ACCOUNT_HISTORY, weekFactsPeriod,
} from "@/components/review/review-data";
import { ReviewScreen } from "@/components/review/review-screen";
import { type ContextAccount, resolveAccountContext } from "@/lib/account-context";

const actualPanel = await vi.importActual<typeof import("@/components/ai/periodic-review-panel")>("@/components/ai/periodic-review-panel");

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------------------------------

const NOW = "2026-10-24T08:51:00.000Z"; // Saturday 03:51 UTC−5: the last completed week is Oct 12–18, the month September.
const USER = m.USER;
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const DEMO = "20000000-0000-4000-8000-000000000003";
const OLD = "20000000-0000-4000-8000-000000000004";
const DRAFT = "a0000000-0000-4000-8000-000000000001"; // GBPUSD long draft, revision 2 (analyses of revision 1 are stale)
const LIVE_FIRST = "a0000000-0000-4000-8000-000000000002"; // DE40 long, recorded live (Personal)
const LOCKED = "a0000000-0000-4000-8000-000000000003"; // EURUSD long, locked plan with a V1 trade review
const PLAN = "b0000000-0000-4000-8000-000000000001";
const PROPOSAL_1 = "c0000000-0000-4000-8000-000000000001";
const PROPOSAL_2 = "c0000000-0000-4000-8000-000000000002";
const HOLD = "d0000000-0000-4000-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`WEEKLY_REVIEW`, `LIVE_FIRST`, `HINDSIGHT_CITATION`): never in default text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

function account(id: string, name: string, currency: string, type: ContextAccount["type"], status: ContextAccount["status"] = "ACTIVE"): ContextAccount {
  return { id, name, currency, type, platform: "MANUAL", broker: null, status, startingBalance: "100000", createdAt: "2026-07-24T00:05:00Z", profile: "PROFILE" };
}
const ACCOUNTS = [account(FTMO, "FTMO 100K", "USD", "EVALUATION"), account(PERSONAL, "Personal 12K", "EUR", "PERSONAL"), account(DEMO, "Demo 100K", "USD", "DEMO")];
const context = (stored: string, lastAccount: string | null = null, accounts: readonly ContextAccount[] = ACCOUNTS) =>
  resolveAccountContext({ accounts, stored, lastAccount, proxyNotice: false });

let counter = 0;
function closed(accountId: string, origin: string, exitedAt: string, realizedR: string | null = "1.5"): Row {
  counter += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, account_id: accountId, origin, exited_at: exitedAt, realized_r: realizedR,
    symbol: "EURUSD", direction: "LONG", entered_at: exitedAt, locked_at: null, created_at: exitedAt,
  };
}

function ledger(): Row[] {
  counter = 0;
  return [
    // FTMO, week of Oct 12–18: five planned trades (the last one exits Sunday 23:00 UTC−5) and one live-first trade.
    ...["2026-10-13T15:00:00Z", "2026-10-14T15:00:00Z", "2026-10-15T15:00:00Z", "2026-10-16T15:00:00Z", "2026-10-19T04:00:00Z"].map(at => closed(FTMO, "PLANNED", at)),
    closed(FTMO, "LIVE_FIRST", "2026-10-17T15:00:00Z", null),
    // Monday 00:00 UTC−5 belongs to the running week.
    closed(FTMO, "PLANNED", "2026-10-19T05:00:00Z"),
    // September.
    closed(FTMO, "PLANNED", "2026-09-08T15:00:00Z"),
    closed(FTMO, "PLANNED", "2026-09-22T15:00:00Z"),
    // Personal: one planned and one live-first trade in the week of Oct 12–18.
    closed(PERSONAL, "PLANNED", "2026-10-14T15:00:00Z"),
    closed(PERSONAL, "LIVE_FIRST", "2026-10-15T15:00:00Z", "0.5"),
    // Trades the history links to (not closed).
    { id: DRAFT, account_id: FTMO, origin: "PLANNED", exited_at: null, realized_r: null, symbol: "GBPUSD", direction: "LONG", entered_at: null, locked_at: null, created_at: "2026-10-23T13:00:00Z" },
    { id: LIVE_FIRST, account_id: PERSONAL, origin: "LIVE_FIRST", exited_at: null, realized_r: null, symbol: "DE40", direction: "LONG", entered_at: "2026-09-17T13:00:00Z", locked_at: null, created_at: "2026-09-17T13:05:00Z" },
    { id: LOCKED, account_id: FTMO, origin: "PLANNED", exited_at: null, realized_r: null, symbol: "EURUSD", direction: "LONG", entered_at: "2026-09-25T13:00:00Z", locked_at: "2026-09-25T12:00:00Z", created_at: "2026-09-25T11:00:00Z" },
  ];
}

const operation = (id: string, contract: string) => ({ id, version: `${id}_MINI_V1`, contract, provider: "openai", model: "gpt-5.4-mini" });
const deadline = (createdAt: string) => new Date(Date.parse(createdAt) + 10 * 60_000).toISOString();
function request(id: string, accountId: string, op: ReturnType<typeof operation>, createdAt: string, extra: Row = {}): Row {
  return { id, user_id: USER, account_id: accountId, operation: op, created_at: createdAt, deadline_at: deadline(createdAt), facts: {}, ...extra };
}
function result(key: string, id: string, accountId: string, status: "COMPLETED" | "FAILED", createdAt: string, extra: Row = {}): Row {
  return { [key]: id, user_id: USER, account_id: accountId, status, interpretation: null, error_code: null, reservation_id: null, created_at: createdAt, ...extra };
}

const IDS = {
  weekly: "71000000-0000-4000-8000-000000000001",
  weeklyRefused: "71000000-0000-4000-8000-000000000002",
  recent: "71000000-0000-4000-8000-000000000003",
  monthly: "71000000-0000-4000-8000-000000000004",
  analyze: "71000000-0000-4000-8000-000000000005",
  challenge: "71000000-0000-4000-8000-000000000006",
  timeline: "71000000-0000-4000-8000-000000000007",
  review: "71000000-0000-4000-8000-000000000008",
};

function aiTables(): Record<string, Row[]> {
  return {
    weekly_ai_reviews: [
      request(IDS.weekly, FTMO, operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), "2026-10-23T18:45:53.308382+00:00", { week_start: "2026-10-12" }),
      request(IDS.weeklyRefused, FTMO, operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), "2026-10-23T18:45:53.369709+00:00", { week_start: "2026-10-05" }),
    ],
    weekly_ai_review_results: [
      result("review_id", IDS.weekly, FTMO, "COMPLETED", "2026-10-23T18:46:10+00:00", { interpretation: weeklyOutput }),
      result("review_id", IDS.weeklyRefused, FTMO, "FAILED", "2026-10-23T18:46:20+00:00", { error_code: "REFUSED", reservation_id: HOLD }),
    ],
    // Still running: requested two minutes ago.
    recent_ai_analyses: [request(IDS.recent, FTMO, operation("RECENT_TRADES_ANALYSIS", "RECENT_TRADES_V1"), "2026-10-24T08:49:00.000Z", { requested_sample: 20, actual_sample: 12 })],
    recent_ai_analysis_results: [],
    monthly_ai_reviews: [request(IDS.monthly, FTMO, operation("MONTHLY_REVIEW", "MONTHLY_REVIEW_V1"), "2026-10-02T15:00:00+00:00", { month_start: "2026-09-01" })],
    monthly_ai_review_results: [result("review_id", IDS.monthly, FTMO, "COMPLETED", "2026-10-02T15:01:00+00:00", { interpretation: monthlyOutput })],
    bias_challenges: [
      request(IDS.analyze, FTMO, operation("ANALYZE_SETUP", "ANALYZE_SETUP_V1"), "2026-10-23T18:45:52.563524+00:00", { proposal_id: PROPOSAL_1 }),
      request(IDS.challenge, FTMO, operation("CHALLENGE_BIAS", "CHALLENGE_BIAS_V1"), "2026-10-23T18:45:52.602309+00:00", { proposal_id: PROPOSAL_2 }),
    ],
    bias_challenge_results: [
      result("challenge_id", IDS.analyze, FTMO, "COMPLETED", "2026-10-23T18:45:59+00:00", { interpretation: analysisOutput }),
      result("challenge_id", IDS.challenge, FTMO, "FAILED", "2026-10-23T18:46:00+00:00", { error_code: "PROPOSAL_OR_EVIDENCE_CHANGED" }),
    ],
    trade_timeline_reviews: [request(IDS.timeline, PERSONAL, operation("REVIEW_TRADE_TIMELINE", "REVIEW_TRADE_TIMELINE_V1"), "2026-10-23T18:45:53.189932+00:00", { trade_id: LIVE_FIRST })],
    trade_timeline_review_results: [result("review_id", IDS.timeline, PERSONAL, "FAILED", "2026-10-23T18:46:30+00:00", { error_code: "HINDSIGHT_CITATION" })],
    trade_ai_reviews: [request(IDS.review, FTMO, operation("REVIEW_TRADE", "REVIEW_TRADE_V1"), "2026-10-23T18:45:53.116285+00:00", { plan_id: PLAN })],
    trade_ai_review_results: [result("review_id", IDS.review, FTMO, "COMPLETED", "2026-10-23T18:46:40+00:00", { interpretation: tradeReviewOutput })],
    trade_revisions: [
      { proposal_id: PROPOSAL_1, trade_id: DRAFT, revision: 1, user_id: USER },
      { proposal_id: PROPOSAL_2, trade_id: DRAFT, revision: 2, user_id: USER },
    ],
    trade_plan_links: [{ plan_id: PLAN, trade_id: LOCKED, user_id: USER }],
    ai_request_reservations: [{ id: HOLD, operation_id: IDS.weeklyRefused, reserved_micros: 60_000, user_id: USER }],
    ai_usage_records: [{ reservation_id: HOLD, charged_micros: 0, disposition: "SETTLED", input_tokens: 0, output_tokens: 0, response_id: null, user_id: USER }],
  };
}

/** Budget models as loadAiBudget returns them: €0.13 of €10.00 used, AI on unless the account turned it off. */
function budgetModel(accountId: string) {
  const enabled = !m.state.accountsWithAiOff.has(accountId);
  const snapshot = { enabled, budgetCents: 1000, usedMicros: 130_000, heldMicros: 0, uncertain: false, period: "2026-10-01", resetAt: "2026-11-01T05:00:00.000Z" };
  const status = m.state.aiEnabled ? "ENABLED" : "DISABLED";
  return { snapshot, presentation: budgetPresentation(snapshot, status === "ENABLED"), system: { status, message: "" }, events: [], error: null };
}
m.budget = budgetModel;
m.panel = props =>
  m.state.panels.get(`${props.kind}|${props.accountId}|${props.period}`) ??
  createElement("div", { "data-stub": "periodic-panel", "data-kind": props.kind, "data-account": props.accountId, "data-period": String(props.period) });

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Page = (props: PageProps) => Promise<ReactElement>;

async function view(page: Page, params: Record<string, string | string[]> = {}): Promise<ReviewView> {
  const element = (await page({ searchParams: Promise.resolve(params) })) as ReactElement<{ view: ReviewView }>;
  return element.props.view;
}

async function render(page: Page, params: Record<string, string | string[]> = {}, options: { realPanel?: boolean } = {}): Promise<string> {
  const loaded = await view(page, params);
  if (options.realPanel && loaded.content.kind === "periodic") {
    const { panel } = loaded.content;
    m.state.panels.set(`${panel.kind}|${panel.accountId}|${panel.period}`, await actualPanel.PeriodicReviewPanel({ ...panel, developerMode: loaded.developerMode }));
  }
  return renderToStaticMarkup(createElement(ReviewScreen, { view: loaded }));
}

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
/** Text plus the attributes a reader hears or sees (aria-label, title, alt, placeholder), collapsed details removed. */
function visibleText(html: string): string {
  const shown = stripDetails(html);
  const attributes = [...shown.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1]);
  return decode(`${shown.replace(/<[^>]+>/g, " ")} ${attributes.join(" ")}`).replace(/\s+/g, " ").trim();
}
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map(match => decode(match[1]));
/** The opening tag of the link to `href` (attribute order is React's business). */
const linkTag = (html: string, href: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]).find(tag => decode(/\shref="([^"]*)"/.exec(tag)?.[1] ?? "") === href) ?? "";
const selectHtml = (html: string, name: string) => new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1];
const options = (html: string, name: string) =>
  [...(selectHtml(html, name) ?? "").matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(match => [match[1], decode(match[2])]);
/** Server-rendered selects mark the chosen option. */
const selected = (html: string, name: string) => {
  const tag = [...(selectHtml(html, name) ?? "").matchAll(/<option\b[^>]*>/g)].map(match => match[0]).find(option => option.includes('selected=""'));
  return tag ? (/value="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
};
const stub = (html: string) => /<div data-stub="periodic-panel" data-kind="([^"]*)" data-account="([^"]*)" data-period="([^"]*)"/.exec(html)?.slice(1) ?? null;
/** The context ReviewContextScope compares links against (`all` or an account id); null without the scope. */
const scopeContext = (html: string) => /<div class="[^"]*" data-account-context="([^"]*)"/.exec(html)?.[1] ?? null;
const ORIGIN = "http://127.0.0.1:3000";
/** What a plain click on the link does inside the page: a full load (context switch) or a client-side navigation. */
const clickLoads = (html: string, href: string) => {
  const current = scopeContext(html);
  if (current === null) throw new Error("The page has no context scope.");
  return contextSwitchHref(href, current, `${ORIGIN}/review/weekly`) === null ? "client" : "full";
};
/** Rows of the facts block with their tone, as `value label · note (tone)`. */
const factRows = (html: string) =>
  [...html.matchAll(/<li class="[^"]*" data-tone="([^"]*)">([\s\S]*?)<\/li>/g)].map(([, tone, row]) => `${visibleText(row)} (${tone})`);
const SOURCES = "Uses each trade's original plan, risk version, entry and exit, plus its journal entries and tags (weekly and monthly reviews read only those recorded within the period). Long notes are shortened; screenshots are not included.";

function expectCleanText(html: string) {
  const text = visibleText(html);
  expect(text).not.toMatch(UUID);
  expect(text).not.toMatch(ENUM);
  expect(html.match(/<h1\b/g) ?? []).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.state.tables = { trade_ledger: ledger(), ...aiTables() };
  m.state.failing.clear();
  m.state.queries.length = 0;
  m.state.rpcs.length = 0;
  m.state.context = context(FTMO);
  m.state.preferences = { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false };
  m.state.aiEnabled = false;
  m.state.accountsWithAiOff = new Set([DEMO]);
  m.state.reviewable = { weekly: 5, recent: 8, monthly: 2 };
  m.state.panels.clear();
  m.push.mockReset();
  for (const action of Object.values(m.actions)) action.mockReset();
});

afterEach(() => {
  // Nothing on this page may ever request AI by itself (§8.3): no action ran, no RPC was called.
  for (const action of Object.values(m.actions)) expect(action).not.toHaveBeenCalled();
  expect(m.state.rpcs).toEqual([]);
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
// Periodic tabs.
// ---------------------------------------------------------------------------------------------------------------------

describe("Weekly review of the selected account", () => {
  it("opens on the last completed week with what Trading OS recorded for it", async () => {
    const html = await render(WeeklyReviewPage);
    expectCleanText(html);
    const text = visibleText(html);
    expect(text).toContain("FTMO 100K · USD");
    expect(linkTag(html, "/review/weekly")).toContain('aria-current="page"');
    // Picker: completed weeks since the account started, counts of planned trades, review marks (failed attempts don't count).
    expect(selected(html, "week")).toBe("2026-10-12");
    expect(options(html, "week").slice(0, 3)).toEqual([
      ["2026-10-12", "Oct 12–18 · 5 trades · reviewed"],
      ["2026-10-05", "Oct 5–11 · nothing to review"],
      ["2026-09-28", "Sep 28–Oct 4 · nothing to review"],
    ]);
    expect(options(html, "week").at(-1)).toEqual(["2026-07-20", "Jul 20–26 · nothing to review"]);
    expect(linkTag(html, "/review/weekly?week=2026-10-05")).toContain('aria-label="Previous week, Oct 5–11"');
    expect(html).not.toContain('rel="next"');
    // Facts: what the review covers and what it leaves out, with the Journal beside the heading.
    expect(text).toContain("Closed Oct 12–18 Open in Journal 5 planned trades included 1 live-first trade not included");
    expect(factRows(html)).toEqual(["5 planned trades included (included)", "1 live-first trade not included (excluded)"]);
    expect(hrefs(html)).toContain("/journal?closedFrom=2026-10-12&closedTo=2026-10-18");
    // The link's accessible name starts with its visible text (WCAG 2.5.3) and says which trades it opens.
    expect(linkTag(html, "/journal?closedFrom=2026-10-12&closedTo=2026-10-18")).toContain('aria-label="Open in Journal: trades closed Oct 12–18"');
    // The panel reviews exactly this account and week.
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-12"]);
    // Budget and how it works, with the cost the button shows.
    expect(text).toContain("AI usage this month · €0.13 of €10.00 · €9.87 left · resets Nov 1");
    expect(text).toContain("How weekly reviews work");
    // What the review reads, including what it can't see yet (the periodic facts carry no journal entries or screenshots).
    expect(text).toContain(`Covers the planned trades you closed from Monday 00:00 to Sunday 24:00 (fixed UTC−5). ${SOURCES} A week can be reviewed once it has ended.`);
    expect(text).not.toContain("recorded events");
    expect(text).toContain("Nothing is sent when this page opens. A review runs only when you click its button.");
    expect(text).toMatch(/Typically ≈ €0\.02 per request\. At most €0\.\d\d is reserved while it runs; unused funds are released\./);
    expect(hrefs(html)).toContain(`/settings?account=${FTMO}#ai`);
  });

  it("serves the Weekly tab at /review too", async () => {
    const html = await render(ReviewPage);
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-12"]);
    expect(linkTag(html, "/review/weekly")).toContain('aria-current="page"');
  });

  it("normalises a week link to its Monday and steps both ways inside the account's history", async () => {
    const html = await render(WeeklyReviewPage, { week: "2026-09-30" });
    expect(selected(html, "week")).toBe("2026-09-28");
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-09-28"]);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/review/weekly?week=2026-09-21", "/review/weekly?week=2026-10-05"]));
  });

  it("says when a week link could not be read and shows the last completed week", async () => {
    const html = await render(WeeklyReviewPage, { week: "next-tuesday" });
    expect(visibleText(html)).toContain(INVALID_PERIOD.weekly);
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-12"]);
  });

  it("keeps the review usable when the trade counts can't be read", async () => {
    m.state.failing.add("trade_ledger");
    const html = await render(WeeklyReviewPage);
    expect(visibleText(html)).toContain("Trade counts for this period are unavailable right now.");
    expect(options(html, "week")[0]).toEqual(["2026-10-12", "Oct 12–18 · reviewed"]);
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-12"]);
  });
});

describe("the real review panel on the page (§8.3, §11.2, §11.5)", () => {
  it("states the limitation and shows the estimate; with AI turned off for the deployment it cannot run", async () => {
    const html = await render(WeeklyReviewPage, {}, { realPanel: true });
    expectCleanText(html);
    const text = visibleText(html);
    expect(text).toContain(PERIODIC_LIMITATION);
    expect(text).toContain("FTMO 100K · Week of Oct 12–18 (UTC−5) · 5 trades");
    const button = /<button[^>]*data-operation="weekly-review"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    expect(text).toContain("Review week of Oct 12–18 · ≈ €0.02");
    expect(text).toContain("AI analysis is turned off for this deployment.");
    expect(text).toContain("Unavailable");
    // The earlier completed review of this week is shown as a concise card and in the period's history.
    expect(text).toContain("Weekly Review · Completed");
  });

  it("is ready to run (on click only) when AI is on for the account", async () => {
    m.state.aiEnabled = true;
    const html = await render(WeeklyReviewPage, {}, { realPanel: true });
    const button = /<button[^>]*data-operation="weekly-review"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).not.toContain("aria-disabled");
    expect(html).toContain('data-budget-status="On"');
  });

  it("sends the trader to AI settings when AI is off for the account", async () => {
    m.state.aiEnabled = true;
    m.state.context = context(DEMO);
    const html = await render(WeeklyReviewPage, {}, { realPanel: true });
    expect(visibleText(html)).toContain("AI is off for this trading account. Turn it on in Settings → AI.");
    expect(html).toContain('data-budget-status="Off"');
    expect(visibleText(html)).toContain("Closed Oct 12–18 0 closed trades nothing to review");
  });
});

describe("All Accounts: the review scope stays one explicit account (§9.1, §11.5)", () => {
  it("asks which account to review when none was used recently", async () => {
    m.state.context = context("all");
    const html = await render(WeeklyReviewPage);
    expectCleanText(html);
    const text = visibleText(html);
    expect(text).toContain("All Accounts · 3 trading accounts");
    expect(text).toContain("Choose a trading account");
    expect(text).toContain("FTMO 100K Evaluation · USD Week of Oct 12–18 · 5 planned trades · reviewed");
    expect(text).toContain("Personal 12K Personal · EUR Week of Oct 12–18 · 1 planned trade");
    expect(text).toContain("Demo 100K Demo · USD Week of Oct 12–18 · nothing to review");
    expect(text).toContain(PERIODIC_LIMITATION);
    expect(hrefs(html)).toEqual(expect.arrayContaining([`/review/weekly?reviewAccount=${FTMO}`, `/review/weekly?reviewAccount=${PERSONAL}`, `/review/weekly?reviewAccount=${DEMO}`]));
    expect(text).toMatch(/FTMO 100K[^·]*·[^·]*USD.*AI Unavailable €0\.13 of €10\.00 · €9.87 left/);
    expect(text).toMatch(/Demo 100K.*AI Off/);
    expect(stub(html)).toBeNull();
  });

  it("says what the recent-trades sample would take from each account", async () => {
    m.state.context = context("all");
    const html = await render(RecentTradesReviewPage);
    expectCleanText(html);
    const text = visibleText(html);
    expect(text).toContain("FTMO 100K Evaluation · USD Last 20 trades · All 8 planned trades");
    expect(text).toContain("Personal 12K Personal · EUR Last 20 trades · 1 planned trade");
    expect(text).toContain("Demo 100K Demo · USD Last 20 trades · No completed planned trades yet");
    m.state.tables.trade_ledger.push(...Array.from({ length: 30 }, (_, index) => closed(FTMO, "PLANNED", `2026-08-${String(index % 28 + 1).padStart(2, "0")}T15:00:00Z`)));
    const sampled = visibleText(await render(RecentTradesReviewPage, { sample: "10" }));
    expect(sampled).toContain("FTMO 100K Evaluation · USD Last 10 trades · Latest 10 of 38 planned trades");
    expect(sampled).toContain("Personal 12K Personal · EUR Last 10 trades · 1 planned trade");
  });

  it("keeps the period of the link in every account choice", async () => {
    m.state.context = context("all");
    const html = await render(MonthlyReviewPage, { month: "2026-08" });
    expect(hrefs(html)).toContain(`/review/monthly?month=2026-08&reviewAccount=${PERSONAL}`);
    expect(visibleText(html)).toContain("August 2026");
  });

  it("reviews the account chosen inside the page without changing the context", async () => {
    m.state.context = context("all");
    const html = await render(WeeklyReviewPage, { reviewAccount: PERSONAL, week: "2026-10-14" });
    expectCleanText(html);
    expect(selected(html, "reviewAccount")).toBe(PERSONAL);
    expect(options(html, "reviewAccount")).toEqual([[FTMO, "FTMO 100K · USD"], [PERSONAL, "Personal 12K · EUR"], [DEMO, "Demo 100K · USD"]]);
    expect(stub(html)).toEqual(["weekly", PERSONAL, "2026-10-12"]);
    expect(visibleText(html)).toContain("Closed Oct 12–18 Open in Journal 1 planned trade included 1 live-first trade not included");
    const links = hrefs(html);
    // Journal links switch the context explicitly; the review links keep the in-page choice and the week.
    expect(links).toContain(`/journal?closedFrom=2026-10-12&closedTo=2026-10-18&account=${PERSONAL}`);
    expect(links).toEqual(expect.arrayContaining([`/review/recent?reviewAccount=${PERSONAL}`, `/review/monthly?reviewAccount=${PERSONAL}`, "/review/history"]));
    expect(links).toContain(`/review/weekly?week=2026-10-05&reviewAccount=${PERSONAL}`);
  });

  it("starts on the most recently used active account, like Plan Trade", async () => {
    m.state.context = context("all", PERSONAL);
    const html = await render(WeeklyReviewPage);
    expect(selected(html, "reviewAccount")).toBe(PERSONAL);
    expect(stub(html)).toEqual(["weekly", PERSONAL, "2026-10-12"]);
  });

  it("reviews the only trading account directly, without a picker that has nothing to choose", async () => {
    m.state.context = context("all", null, [ACCOUNTS[0]]);
    const html = await render(WeeklyReviewPage);
    expectCleanText(html);
    expect(visibleText(html)).toContain("All Accounts · 1 trading account");
    expect(selectHtml(html, "reviewAccount")).toBeUndefined();
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-12"]);
    // Links keep the account explicit, so the review never depends on which account is remembered.
    expect(hrefs(html)).toContain(`/review/weekly?week=2026-10-05&reviewAccount=${FTMO}`);
  });

  it("never falls back to another account when the chosen one is unavailable", async () => {
    m.state.context = context("all", PERSONAL);
    for (const reviewAccount of ["20000000-0000-4000-8000-0000000000ff", "personal"]) {
      const html = await render(WeeklyReviewPage, { reviewAccount });
      expect(visibleText(html)).toContain(UNAVAILABLE_ACCOUNT);
      expect(visibleText(html)).toContain("Choose a trading account");
      expect(stub(html)).toBeNull();
    }
  });

  it("lists archived accounts apart; they keep their history and can still be reviewed", async () => {
    m.state.context = context("all", null, [...ACCOUNTS, account(OLD, "Old Prop 50K", "USD", "FUNDED", "ARCHIVED")]);
    const chooser = await render(WeeklyReviewPage);
    expect(visibleText(chooser)).toContain("Archived accounts (1)");
    const html = await render(WeeklyReviewPage, { reviewAccount: OLD });
    expect(html).toMatch(/<optgroup label="Archived"><option value="20000000-0000-4000-8000-000000000004"[^>]*>Old Prop 50K · USD<\/option><\/optgroup>/);
    expect(selected(html, "reviewAccount")).toBe(OLD);
    expect(stub(html)).toEqual(["weekly", OLD, "2026-10-12"]);
  });
});

describe("links that switch the trading-account context load in full, so the header follows (§9.2)", () => {
  /** Links on the page that a plain click loads in full. */
  const fullLoads = (html: string) => hrefs(html).filter(href => clickLoads(html, href) === "full");

  it("loads the Journal drill-down and AI settings in full from All Accounts; choices inside the page stay client-side", async () => {
    m.state.context = context("all");
    const html = await render(WeeklyReviewPage, { reviewAccount: FTMO });
    expect(scopeContext(html)).toBe("all");
    expect(fullLoads(html)).toEqual([`/journal?closedFrom=2026-10-12&closedTo=2026-10-18&account=${FTMO}`, `/settings?account=${FTMO}#ai`]);
    for (const href of [`/review/weekly?week=2026-10-05&reviewAccount=${FTMO}`, `/review/monthly?reviewAccount=${FTMO}`, "/review/history"]) {
      expect(hrefs(html)).toContain(href);
      expect(clickLoads(html, href)).toBe("client");
    }
    // The chooser's rows pick the account inside the page: nothing switches the context there.
    const chooser = await render(WeeklyReviewPage);
    expect(fullLoads(chooser)).toEqual([]);
  });

  it("keeps links client-side when they open the selected account", async () => {
    for (const page of [WeeklyReviewPage, RecentTradesReviewPage, MonthlyReviewPage]) {
      const html = await render(page);
      expect(scopeContext(html)).toBe(FTMO);
      expect(hrefs(html)).toContain(`/settings?account=${FTMO}#ai`);
      expect(fullLoads(html)).toEqual([]);
    }
  });

  it("also loads the review panel's own 'Open AI settings' in full when it switches the context", async () => {
    m.state.aiEnabled = true;
    m.state.context = context("all");
    const html = await render(WeeklyReviewPage, { reviewAccount: DEMO }, { realPanel: true });
    expect(visibleText(html)).toContain("Open AI settings");
    expect(fullLoads(html)).toEqual([`/settings?account=${DEMO}#ai`, `/settings?account=${DEMO}#ai`]);
  });

  it("loads 'Show every account' in full from an account context, and one account's AI settings from All Accounts", async () => {
    m.state.context = context(PERSONAL);
    const personal = await render(ReviewHistoryPage);
    expect(scopeContext(personal)).toBe(PERSONAL);
    expect(fullLoads(personal)).toEqual(["/review/history?account=all"]);
    m.state.context = context("all");
    const filtered = await render(ReviewHistoryPage, { reviewAccount: FTMO });
    expect(fullLoads(filtered)).toEqual([`/settings?account=${FTMO}#ai`]);
    // Every account's budgets open Settings → AI, which lists them all: no context to switch.
    const all = await render(ReviewHistoryPage);
    expect(hrefs(all)).toContain("/settings#ai");
    expect(fullLoads(all)).toEqual([]);
  });
});

describe("Recent trades and Monthly", () => {
  it("offers 10, 20 or 30 trades and says what the sample takes", async () => {
    const html = await render(RecentTradesReviewPage, { sample: "10" });
    expectCleanText(html);
    const text = visibleText(html);
    expect(linkTag(html, "/review/recent?sample=10")).toContain('aria-current="true"');
    expect(linkTag(html, "/review/recent?sample=20")).not.toContain("aria-current");
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/review/recent?sample=20", "/review/recent?sample=30"]));
    // 8 planned FTMO trades with a recorded R have closed so far (the one exiting in the running week included).
    expect(text).toContain("Completed so far Open in Journal 8 planned trades all 8 included 1 live-first trade not included");
    expect(linkTag(html, "/journal?state=closed%2Creviewed")).toContain('aria-label="Open in Journal: closed trades"');
    expect(stub(html)).toEqual(["recent", FTMO, "10"]);
    expect(text).toContain("How recent-trades analysis works");
    expect(text).toContain(
      `Covers your most recent completed planned trades with a recorded R, newest first: 10, 20 or 30 of them. ${SOURCES} The sample is taken when you ask, so a later analysis can include newer trades.`,
    );
  });

  it("takes the latest trades when more have closed than the sample holds", async () => {
    m.state.tables.trade_ledger.push(...Array.from({ length: 30 }, (_, index) => closed(FTMO, "PLANNED", `2026-08-${String(index % 28 + 1).padStart(2, "0")}T15:00:00Z`)));
    const html = await render(RecentTradesReviewPage);
    expect(visibleText(html)).toContain("38 planned trades the latest 20 are included");
    expect(stub(html)).toEqual(["recent", FTMO, "20"]);
  });

  it("opens Monthly on the last completed month with the months since the account started", async () => {
    const html = await render(MonthlyReviewPage);
    expectCleanText(html);
    expect(selected(html, "month")).toBe("2026-09");
    expect(options(html, "month")).toEqual([
      ["2026-09", "September 2026 · 2 trades · reviewed"],
      ["2026-08", "August 2026 · nothing to review"],
      ["2026-07", "July 2026 · nothing to review"],
    ]);
    expect(visibleText(html)).toContain("Closed in September 2026 Open in Journal 2 planned trades included");
    expect(hrefs(html)).toContain("/journal?closedFrom=2026-09-01&closedTo=2026-09-30");
    expect(stub(html)).toEqual(["monthly", FTMO, "2026-09"]);
    expect(visibleText(html)).toContain(
      `Covers the planned trades you closed in the calendar month (fixed UTC−5). ${SOURCES} A month can be reviewed from the 1st of the next month.`,
    );
    expect(visibleText(html)).not.toContain("recorded events");
  });
});

describe("a week or month that is still running (reachable by link)", () => {
  it("counts the running week's trades so far and never calls them included", async () => {
    const html = await render(WeeklyReviewPage, { week: "2026-10-19" });
    expectCleanText(html);
    const text = visibleText(html);
    // The trade exiting Monday 00:00 UTC−5 belongs to the running week.
    expect(text).toContain("Closed so far, Oct 19–25 Open in Journal 1 planned trade week not finished");
    expect(factRows(html)).toEqual(["1 planned trade week not finished (pending)"]);
    expect(text).not.toMatch(/planned trades? included/);
    expect(hrefs(html)).toContain("/journal?closedFrom=2026-10-19&closedTo=2026-10-25");
    expect(options(html, "week")[0]).toEqual(["2026-10-19", "Oct 19–25 · not finished"]);
    // The panel itself explains that only a completed week can be reviewed.
    expect(stub(html)).toEqual(["weekly", FTMO, "2026-10-19"]);
  });

  it("counts the running month's trades so far, live-first trades still left out", async () => {
    const html = await render(MonthlyReviewPage, { month: "2026-10" });
    expectCleanText(html);
    expect(visibleText(html)).toContain("Closed so far in October 2026 Open in Journal 6 planned trades month not finished 1 live-first trade not included");
    expect(factRows(html)).toEqual(["6 planned trades month not finished (pending)", "1 live-first trade not included (excluded)"]);
    expect(visibleText(html)).not.toMatch(/planned trades? included/);
  });

  it("says a running period with nothing closed yet is not finished rather than empty", async () => {
    m.state.context = context(DEMO);
    const html = await render(WeeklyReviewPage, { week: "2026-10-19" });
    expect(visibleText(html)).toContain("Closed so far, Oct 19–25 0 closed trades week not finished");
    expect(factRows(html)).toEqual(["0 closed trades week not finished (pending)"]);
    expect(hrefs(html).some(href => href.startsWith("/journal"))).toBe(false);
  });

  it("marks a running period in the account chooser too", async () => {
    m.state.context = context("all");
    const text = visibleText(await render(WeeklyReviewPage, { week: "2026-10-19" }));
    expect(text).toContain("FTMO 100K Evaluation · USD Week of Oct 19–25 · 1 planned trade so far · not finished");
    expect(text).toContain("Personal 12K Personal · EUR Week of Oct 19–25 · no planned trades so far · not finished");
  });

  it("builds the facts of finished and running periods the same way everywhere", () => {
    expect(weekFactsPeriod("2026-10-12", "2026-10-12")).toEqual({ heading: "Closed Oct 12–18", unfinished: null });
    expect(weekFactsPeriod("2026-10-19", "2026-10-12")).toEqual({ heading: "Closed so far, Oct 19–25", unfinished: "week not finished" });
    expect(monthFactsPeriod("2026-09", "2026-09")).toEqual({ heading: "Closed in September 2026", unfinished: null });
    expect(monthFactsPeriod("2026-10", "2026-09")).toEqual({ heading: "Closed so far in October 2026", unfinished: "month not finished" });
    const journal = { href: "/journal", label: "Open in Journal", description: "Open in Journal: trades", switchesContext: false };
    const running = weekFactsPeriod("2026-10-19", "2026-10-12");
    expect(periodFacts(running, { planned: 0, liveFirst: 2, imported: 0 }, journal).rows).toEqual([
      { value: "0", label: "planned trades", note: "week not finished", tone: "pending" },
      { value: "2", label: "live-first trades", note: "not included", tone: "excluded" },
    ]);
    expect(periodFacts(running, EMPTY_COUNTS, journal)).toEqual({ heading: "Closed so far, Oct 19–25", rows: [{ value: "0", label: "closed trades", note: "week not finished", tone: "pending" }], journal: null });
    const finished = weekFactsPeriod("2026-10-12", "2026-10-12");
    expect(periodFacts(finished, { planned: 0, liveFirst: 0, imported: 1 }, journal).rows).toEqual([
      { value: "0", label: "planned trades", note: "nothing to review", tone: "neutral" },
      { value: "1", label: "imported trade", note: "not included", tone: "excluded" },
    ]);
    expect(periodFacts(finished, EMPTY_COUNTS, journal).rows).toEqual([{ value: "0", label: "closed trades", note: "nothing to review", tone: "neutral" }]);
  });
});

describe("empty and loading states (§13.7)", () => {
  it("guides a trader without accounts to create one", async () => {
    m.state.context = context("all", null, []);
    for (const page of [WeeklyReviewPage, ReviewHistoryPage]) {
      const html = await render(page);
      expect(visibleText(html)).toContain("Create your first trading account");
      expect(hrefs(html)).toContain("/accounts/new");
    }
    expect(m.state.queries.filter(table => table === "trade_ledger")).toEqual([]);
  });

  it("keeps the title and marks the tab while a tab loads", () => {
    const weekly = renderToStaticMarkup(createElement(ReviewLoading));
    expect(weekly).toContain('role="status"');
    expect(visibleText(weekly)).toContain("Loading review");
    expect(weekly).toMatch(/<span class="tab" data-state="active">Weekly<\/span>/);
    // The same phone wording as the real tabs, so nothing jumps when the page arrives.
    expect(weekly).toContain('<span class="tab"><span aria-hidden="true" class="sm:hidden">Recent</span><span class="max-sm:sr-only">Recent trades</span></span>');
    const history = renderToStaticMarkup(createElement(ReviewHistoryLoading));
    expect(history).toMatch(/<span class="tab" data-state="active">History<\/span>/);
  });

  it("fits the four tabs on a phone: 'Recent trades' reads 'Recent' there and keeps its full accessible name", async () => {
    const html = await render(RecentTradesReviewPage);
    const tab = new RegExp(`${linkTag(html, "/review/recent").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)</a>`).exec(html)?.[1];
    expect(linkTag(html, "/review/recent")).toContain('aria-current="page"');
    expect(tab).toBe('<span aria-hidden="true" class="sm:hidden">Recent</span><span class="max-sm:sr-only">Recent trades</span>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------------------------------------------------------

describe("History: every AI analysis across the trader's accounts (§11.1, §14.10)", () => {
  it("lists periodic reviews and trade analyses compactly, newest first, linking each to what it looked at", async () => {
    m.state.context = context("all");
    const html = await render(ReviewHistoryPage);
    expectCleanText(html);
    const text = visibleText(html);
    // Day groups in the trader's display; the running analysis first.
    expect(text).toMatch(/Today Recent Trades Analysis · In progress · 03:49 Last 12 trades \(20 requested\) · FTMO 100K Still running\. Refresh to see the result\. Yesterday/);
    const order = [
      "Weekly Review · Failed · 13:46",
      "Weekly Review · Completed · 13:46",
      "Trade Review · Failed · 13:46",
      "Trade Review · Completed · 13:46",
      "Challenge My Bias · Failed · 13:46",
      "Analyze Setup · Completed · 13:45",
      "Fri, Oct 2",
      "Monthly Review · Completed · 10:01",
    ];
    const positions = order.map(label => text.indexOf(label));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // What each analysis looked at, in trader words, with its account.
    expect(text).toContain("Week of Oct 12–18 · FTMO 100K");
    expect(text).toContain("DE40 long · Sep 17 · Personal 12K");
    expect(text).toContain("EURUSD long · Sep 25 · FTMO 100K");
    expect(text).toContain("GBPUSD long · Oct 23 · FTMO 100K");
    const links = hrefs(html);
    expect(links).toEqual(
      expect.arrayContaining([
        `/review/weekly?week=2026-10-12&reviewAccount=${FTMO}`,
        `/review/weekly?week=2026-10-05&reviewAccount=${FTMO}`,
        `/review/recent?sample=20&reviewAccount=${FTMO}`,
        `/review/monthly?month=2026-09&reviewAccount=${FTMO}`,
        `/trades/${DRAFT}`,
        `/trades/${LIVE_FIRST}`,
        `/trades/${LOCKED}`,
      ]),
    );
    // An analysis of an earlier draft revision is never presented as current.
    expect(text).toContain("Based on draft revision 1 · current revision is 2");
    // Failures in plain words, with what they cost.
    expect(text).toContain("The AI provider declined the request. The cost is recorded; unused funds were released.");
    expect(text).toContain("The AI supported the thesis check with records made after entry. Nothing was charged for this attempt.");
    expect(text).toContain("The draft or its screenshots changed before the request was sent. Nothing was charged for this attempt.");
    // Raw ids, codes and versions only inside the collapsed Technical details.
    expect(html.match(/class="disclosure technical-details[^"]*"/g) ?? []).toHaveLength(1);
    const technical = /<details class="disclosure technical-details[^"]*"[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    for (const id of Object.values(IDS)) expect(technical).toContain(id);
    expect(technical).toContain("HINDSIGHT_CITATION");
    // Budgets of every active account.
    expect(text).toContain("AI budgets this month");
    expect(text).toContain("FTMO 100K Unavailable €0.13 of €10.00 · €9.87 left");
    expect(text).toContain("Demo 100K Off");
  });

  it("filters by kind and by account inside the page, and offers a way back", async () => {
    m.state.context = context("all");
    const trades = visibleText(await render(ReviewHistoryPage, { kind: "trade" }));
    expect(trades).not.toContain("Weekly Review");
    expect(trades).toContain("Analyze Setup · Completed");
    const personal = await render(ReviewHistoryPage, { kind: "trade", reviewAccount: PERSONAL });
    const text = visibleText(personal);
    expect(text).toContain("Every trade analysis of Personal 12K, newest first.");
    expect(text).toContain("Trade Review · Failed");
    expect(text).not.toContain("GBPUSD long");
    expect(text).not.toContain("EURUSD long");
    expect(selected(personal, "reviewAccount")).toBe(PERSONAL);
    expect(hrefs(personal)).toEqual(expect.arrayContaining([`/review/history?reviewAccount=${PERSONAL}`, `/review/history?kind=periodic&reviewAccount=${PERSONAL}`]));
    const empty = await render(ReviewHistoryPage, { kind: "periodic", reviewAccount: DEMO });
    expect(visibleText(empty)).toContain("No analyses match this view.");
    expect(hrefs(empty)).toContain("/review/history");
  });

  it("covers the selected account only in an account context, with a way to every account", async () => {
    m.state.context = context(PERSONAL);
    const html = await render(ReviewHistoryPage);
    const text = visibleText(html);
    expect(text).toContain("Analyses of your other accounts are listed in All Accounts. Show every account");
    expect(text).toContain("Every AI analysis of Personal 12K, newest first: periodic reviews and the analyses run on single trades.");
    expect(hrefs(html)).toContain("/review/history?account=all");
    expect(text).toContain("DE40 long · Sep 17");
    expect(text).not.toContain("Weekly Review");
    expect(selected(html, "reviewAccount")).toBeNull();
    expect(text).toContain("AI budget");
  });

  it("pages through long histories with an exact cursor", async () => {
    m.state.context = context(FTMO);
    const base = Date.parse("2026-10-20T12:00:00Z");
    for (let index = 0; index < 35; index += 1) {
      const id = `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      m.state.tables.weekly_ai_reviews.push(request(id, FTMO, operation("WEEKLY_REVIEW", "WEEKLY_REVIEW_V1"), new Date(base - index * 60_000).toISOString(), { week_start: "2026-09-28" }));
    }
    const first = await view(ReviewHistoryPage);
    if (first.content.kind !== "history") throw new Error("expected history");
    expect(first.content.count).toBe(HISTORY_PAGE_SIZE);
    expect(first.content.newestHref).toBeNull();
    const older = first.content.olderHref ?? "";
    const before = new URL(older, "http://x.invalid").searchParams.get("before") ?? "";
    expect(decodeHistoryCursor(before)).not.toBeNull();
    const second = await view(ReviewHistoryPage, { before });
    if (second.content.kind !== "history") throw new Error("expected history");
    // 35 + 7 seeded FTMO analyses (the Personal timeline review is outside this context) = 42: 30 + 12.
    expect(second.content.count).toBe(12);
    expect(second.content.olderHref).toBeNull();
    expect(second.content.newestHref).toBe("/review/history");
    const ids = [first, second].flatMap(page => (page.content.kind === "history" ? page.content.groups.flatMap(group => group.entries.map(entry => entry.technical.requestId)) : []));
    expect(new Set(ids).size).toBe(42);
    const html = renderToStaticMarkup(createElement(ReviewScreen, { view: second }));
    expect(visibleText(html)).toContain("12 analyses on this page");
  });

  it("explains an empty history and a history that can't be read", async () => {
    m.state.context = context(DEMO);
    expect(visibleText(await render(ReviewHistoryPage))).toContain("No AI analyses yet.");
    m.state.failing.add("weekly_ai_reviews");
    const html = await render(ReviewHistoryPage, { reviewAccount: FTMO });
    expect(visibleText(html)).toContain(HISTORY_UNAVAILABLE);
  });

  it("says when the account of a History link is unavailable and shows every account", async () => {
    m.state.context = context("all");
    const html = await render(ReviewHistoryPage, { reviewAccount: "20000000-0000-4000-8000-0000000000ff" });
    expect(visibleText(html)).toContain(UNAVAILABLE_ACCOUNT_HISTORY);
    expect(visibleText(html)).toContain("Weekly Review · Completed");
  });

  it("opens Technical details by default in developer mode", async () => {
    m.state.preferences = { theme: "system", timeDisplay: { mode: "utc" }, developerMode: true, sidebarCollapsed: false };
    const html = await render(ReviewHistoryPage);
    expect(html).toMatch(/<details class="disclosure technical-details[^"]*"[^>]*open=""/);
    // Times follow the trader's display (UTC here).
    expect(visibleText(html)).toContain("Weekly Review · Completed · 18:46");
  });
});
