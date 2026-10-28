import Decimal from "decimal.js";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EDGE screen (docs/V2_ARCHITECTURE.md §9.3, §13.6–13.8, §14.6): the page rendered with mocked loaders (session,
// account context, preferences and the ledger read), plus the pure URL state and presentation model behind it.

const m = vi.hoisted(() => ({
  context: null as unknown,
  preferences: { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false } as unknown,
  load: vi.fn(),
  push: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: {}, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/ai-history", () => ({ loadTradeAiHistory: vi.fn(), timelineAiAnalyses: () => [] }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: vi.fn() }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/lib/account-context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/account-context")>()),
  currentSession: async () => ({ db: {}, user: { id: "10000000-0000-4000-8000-000000000001" } }),
  getAccountContext: async () => m.context,
  getPreferences: async () => m.preferences,
}));
vi.mock("@/lib/performance-data", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/performance-data")>()),
  loadLedgerRows: m.load,
}));

import EdgeLoading from "@/app/(app)/edge/loading";
import { exportHref } from "@/app/edge/export/contract";
import EdgePage from "@/app/(app)/edge/page";
import { binSign, Histogram } from "@/components/charts/bar-chart";
import { keepPartsTogether } from "@/components/edge/breakdowns";
import { DayTrade, daySummary } from "@/components/edge/day-sheet";
import { assembleEdge, defaultCalendarMonth, type EdgeData, loadEdge } from "@/components/edge/edge-data";
import { EDGE_DESCRIPTION } from "@/components/edge/edge-screen";
import { EXPORT_NOTE } from "@/components/edge/export-menu";
import { formatDrawdownR, formatProfitFactor, formatRate, formatShare } from "@/components/edge/format";
import {
  breakdownSections, calendarModel, contributionSection, curveData, dailyData, distributionBins, exportLinks, headlineModel, noMatchDescription,
  originSection, rCoverage, scopeLabel,
} from "@/components/edge/model";
import { edgeHref, withParams } from "@/components/edge/params";
import { dayView, PerformanceCalendar, PHONE_DAY_LIMIT } from "@/components/edge/performance-calendar";
import { accountFilterChip, activeFilterCount, edgeAccountHistoryHref, edgeFilters, filterQuery, parseEdgeQuery, presetBounds } from "@/components/edge/query";
import { formatR, formatSignedMoney } from "@/domain/format";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { EARLY_SAMPLE_NOTE } from "@/domain/performance";
import { type AccountContext, type ContextAccount, resolveAccountContext } from "@/lib/account-context";
import { buildPerformance } from "@/lib/performance-data";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-23T19:00:00.000Z";
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const COVER = "50000000-0000-4000-8000-000000000001";
const STRATEGY_A = "30000000-0000-4000-8000-00000000000a";
const STRATEGY_B = "30000000-0000-4000-8000-00000000000b";
const RISK_A = "40000000-0000-4000-8000-00000000000a";
const RISK_B = "40000000-0000-4000-8000-00000000000b";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `LIVE_FIRST`, `ACTIVE_KILL_ZONE`, `FULL_CLOSE_V1`): never in default text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

function account(id: string, name: string, currency: string): ContextAccount {
  return { id, name, currency, type: "EVALUATION", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "100000", createdAt: "2026-01-01T00:00:00Z", profile: "PROFILE" };
}
const ACCOUNTS = [account(FTMO, "FTMO 100K", "USD"), account(PERSONAL, "Personal 12K", "EUR")];
const context = (stored: string): AccountContext => resolveAccountContext({ accounts: ACCOUNTS, stored, lastAccount: null, proxyNotice: false });
const ALL = context("all");
const ONE = context(FTMO);

function ledger(changes: Partial<LedgerTrade>): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: "10000000-0000-4000-8000-000000000000", account_id: FTMO, origin: "PLANNED", created_at: "2026-09-01T10:00:00Z", currency: "USD",
    revision_count: 1, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

let counter = 0;
/** A closed trade entered at 08:00 UTC−5 (kill zone) and exited at 10:00 UTC−5 on `day`. */
function closed(day: string, r: string | null, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  counter += 1;
  const currency = changes.currency ?? "USD";
  const net = changes.net_pnl ?? (r === null ? "-12.5" : new Decimal(r).mul(currency === "EUR" ? 30 : 50).toFixed(2));
  const sign = new Decimal(net);
  const planned = (changes.origin ?? "PLANNED") === "PLANNED";
  return ledger({
    id: `a0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, entered_at: `${day}T13:00:00Z`, exited_at: `${day}T15:00:00Z`,
    entry_recorded_at: `${day}T13:00:00Z`, close_recorded_at: `${day}T15:00:00Z`, entry_price: "1.1", exit_price: "1.102",
    realized_r: r, net_pnl: net, fees: "1.5", outcome: sign.gt(0) ? "WIN" : sign.lt(0) ? "LOSS" : "BREAKEVEN", entry_model: "OB_FIRST_TOUCH", direction: "LONG",
    symbol: "EURUSD", plan_id: planned ? "60000000-0000-4000-8000-000000000001" : null, strategy_version_id: planned ? STRATEGY_A : null,
    strategy_version: planned ? "ICT V1.0" : null, risk_plan_version_id: planned ? RISK_A : null, risk_plan_version: planned ? "Risk Plan V1.0" : null,
    requested_risk_percent: planned ? "0.5" : null, calculation_version: planned ? "FULL_CLOSE_V1" : "UNPLANNED_CLOSE_V1", ...changes,
  });
}

/** 12 planned FTMO trades, 4 planned Personal trades, 3 live-first trades (one without a risk basis). */
function dataset(): LedgerTrade[] {
  counter = 0;
  const days = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
  const rs = ["2", "-1", "1.5", "-1", "3", "-1", "0", "2.4", "-1", "1", "-0.5", "1.2"];
  const ftmo = days.map((day, index) => closed(day, rs[index], {
    entry_model: index % 3 === 0 ? "OTE" : "OB_FIRST_TOUCH", symbol: index % 4 === 0 ? "GBPUSD" : "EURUSD",
    ...(index === 9 ? { evidence_count: 3, cover_evidence_id: COVER, cover_evidence_kind: "V2" as const, review_completed_at: "2026-10-14T20:00:00Z", lifecycle: "REVIEWED" as const } : {}),
  }));
  const personal = ["2026-10-07", "2026-10-14", "2026-10-20", "2026-10-21"].map((day, index) => closed(day, ["1", "-1", "2", "-0.25"][index], {
    account_id: PERSONAL, currency: "EUR", symbol: "DE40", strategy_version_id: STRATEGY_B, risk_plan_version_id: RISK_B,
  }));
  const liveFirst = [
    closed("2026-10-19", "1.5", { origin: "LIVE_FIRST", entry_model: "OTHER" }),
    closed("2026-10-20", "-1", { origin: "LIVE_FIRST", entry_model: null }),
    closed("2026-10-21", null, { origin: "LIVE_FIRST", entry_model: null }),
  ];
  return [...ftmo, ...personal, ...liveFirst];
}

function edgeData(rows: LedgerTrade[], params: Record<string, string> = {}, ctx: AccountContext = ALL): EdgeData {
  return assembleEdge({
    now: NOW, display: { mode: "strategy" }, developerMode: false, context: ctx, query: parseEdgeQuery(params, NOW), loaded: { rows, truncated: false },
  });
}

async function renderPage(params: Record<string, string>): Promise<string> {
  const element = (await EdgePage({ searchParams: Promise.resolve(params) })) as ReactElement;
  return renderToStaticMarkup(element);
}

/** What a reader sees: text plus the attributes that are read or shown (aria-label, title, alt), Technical details removed. */
function visibleText(html: string): string {
  const withoutTechnical = html.replace(/<details class="disclosure technical-details"[\s\S]*?<\/details>/g, "");
  const attributes = [...withoutTechnical.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1]);
  const text = withoutTechnical.replace(/<[^>]+>/g, " ");
  return `${text} ${attributes.join(" ")}`
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    // Non-breaking spaces and word joiners only steer line wrapping (breakdown samples): they read as spaces / nothing.
    .replace(/⁠/g, "").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.context = ALL;
  m.load.mockReset();
  m.load.mockImplementation(async () => ({ rows: dataset(), truncated: false }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
// URL state.
// ---------------------------------------------------------------------------------------------------------------------
describe("EDGE URL state (§14.6)", () => {
  it("resolves date presets to exit days relative to the server's strategy day", () => {
    expect(presetBounds("30d", "2026-10-23")).toEqual({ closedFrom: "2026-09-24", closedTo: "2026-10-23" });
    expect(presetBounds("90d", "2026-10-23")).toEqual({ closedFrom: "2026-07-26", closedTo: "2026-10-23" });
    expect(presetBounds("month", "2026-10-23")).toEqual({ closedFrom: "2026-10-01", closedTo: "2026-10-23" });
    expect(presetBounds("last-month", "2026-03-05")).toEqual({ closedFrom: "2026-02-01", closedTo: "2026-02-28" });
    expect(presetBounds("ytd", "2026-10-23")).toEqual({ closedFrom: "2026-01-01", closedTo: "2026-10-23" });
    expect(presetBounds("all", "2026-10-23")).toEqual({});
    // 00:30 UTC on Oct 24 is still Oct 23 on the strategy clock.
    expect(parseEdgeQuery({ range: "30d" }, "2026-10-24T00:30:00Z")).toMatchObject({ closedFrom: "2026-09-24", closedTo: "2026-10-23" });
  });

  it("reads the dimensions with the Journal's names and keeps the calendar state", () => {
    const query = parseEdgeQuery({ range: "custom", closedFrom: "2026-10-20", closedTo: "2026-10-01", model: "ote", session: "active_kill_zone", origin: "live-first", instrument: "de40", month: "2026-09", view: "loss", currency: "eur" }, NOW);
    expect(query).toEqual({
      range: "custom", closedFrom: "2026-10-01", closedTo: "2026-10-20", model: "OTE", session: "ACTIVE_KILL_ZONE", origin: "LIVE_FIRST", instrument: "DE40",
      month: "2026-09", calendar: "GROSS_LOSS", currency: "EUR", invalid: [],
    });
    expect(edgeFilters(query)).toEqual({ closedFrom: "2026-10-01", closedTo: "2026-10-20", model: "OTE", session: "ACTIVE_KILL_ZONE", origin: "LIVE_FIRST", instrument: "DE40" });
    expect(activeFilterCount(query)).toBe(5);
    expect(edgeHref(query)).toBe("/edge?range=custom&closedFrom=2026-10-01&closedTo=2026-10-20&model=OTE&session=ACTIVE_KILL_ZONE&origin=live-first&instrument=DE40&month=2026-09&view=loss&currency=EUR");
    expect(filterQuery(query)).toBe("range=custom&closedFrom=2026-10-01&closedTo=2026-10-20&model=OTE&session=ACTIVE_KILL_ZONE&origin=live-first&instrument=DE40");
    expect(withParams(filterQuery(query), { month: "2026-08", view: undefined, day: "2026-08-03" })).toBe(`/edge?${filterQuery(query)}&month=2026-08&day=2026-08-03`);
  });

  it("names unreadable parameters instead of failing, and treats bare bounds as a custom range", () => {
    const query = parseEdgeQuery({ range: "forever", model: "SCALP", month: "2026-13", view: "pie", currency: "dollars", closedFrom: "2026-10-05" }, NOW);
    expect(query.invalid.sort()).toEqual(["currency", "model", "month", "range", "view"]);
    expect(query).toMatchObject({ range: "custom", closedFrom: "2026-10-05", calendar: "NET_R" });
    expect(parseEdgeQuery({}, NOW)).toEqual({ range: "all", calendar: "NET_R", invalid: [] });
    expect(parseEdgeQuery({ day: "2026-09-14" }, NOW)).toMatchObject({ month: "2026-09", day: "2026-09-14" });
  });

  it("maps the page's filters onto the CSV link: every origin, effective exit days, the page's own parameter names", () => {
    const query = parseEdgeQuery({ range: "month", model: "OTE", session: "ASIA", origin: "live-first", instrument: "EURUSD" }, NOW);
    expect(exportHref(query, FTMO)).toBe(`/edge/export?account=${FTMO}&closedFrom=2026-10-01&closedTo=2026-10-23&origin=live-first&model=OTE&session=ASIA&instrument=EURUSD`);
    // All Accounts: the file of the page first, then one per account with trades on the page.
    expect(exportLinks({ context: ALL, query, rows: dataset() }).map(link => link.label)).toEqual(["All Accounts", "FTMO 100K", "Personal 12K"]);
    expect(exportLinks({ context: ONE, query, rows: dataset() })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Loader.
// ---------------------------------------------------------------------------------------------------------------------
describe("EDGE read-only account filter (§9.2)", () => {
  const OLD = "20000000-0000-4000-8000-000000000003";
  const withArchived = resolveAccountContext({
    accounts: [...ACCOUNTS, { ...account(OLD, "Old challenge", "USD"), status: "ARCHIVED" }], stored: "all", lastAccount: null, proxyNotice: false,
  });

  it("reads it with the Journal's parser, narrows the statistics' filters and keeps it in the links the page builds", () => {
    const query = parseEdgeQuery({ accountFilter: OLD.toUpperCase(), model: "ote", month: "2026-09" }, NOW);
    expect(query).toMatchObject({ accountFilter: OLD, model: "OTE", invalid: [] });
    expect(edgeFilters(query)).toEqual({ model: "OTE", accountFilter: OLD });
    expect(activeFilterCount(query)).toBe(2);
    expect(filterQuery(query)).toBe(`model=OTE&accountFilter=${OLD}`);
    expect(exportHref(query, "all")).toContain(`accountFilter=${OLD}`);
    expect(parseEdgeQuery({ accountFilter: "Old challenge" }, NOW).invalid).toEqual(["accountFilter"]);
  });

  it("resolves it against the context: kept in All Accounts (an unknown id stays and matches nothing), dropped in an account context", () => {
    const params = { accountFilter: OLD, model: "OTE", origin: "live-first" };
    expect(parseEdgeQuery(params, NOW, withArchived)).toMatchObject({ accountFilter: OLD, model: "OTE", origin: "LIVE_FIRST" });
    const foreign = "20000000-0000-4000-8000-000000000099";
    expect(parseEdgeQuery({ accountFilter: foreign }, NOW, withArchived).accountFilter).toBe(foreign);
    // A context switch keeps the other parameters: the filter left in the URL counts nowhere, links and files lose it.
    const stale = parseEdgeQuery(params, NOW, ONE);
    expect(stale).toEqual({ range: "all", model: "OTE", origin: "LIVE_FIRST", calendar: "NET_R", invalid: [] });
    expect(activeFilterCount(stale)).toBe(2);
    expect(filterQuery(stale)).toBe("model=OTE&origin=live-first");
    expect(edgeFilters(stale)).toEqual({ model: "OTE", origin: "LIVE_FIRST" });
    expect(accountFilterChip(stale, ONE)).toBeNull();
  });

  it("shows it in words in All Accounts only, with the page without it as the way back", () => {
    const query = parseEdgeQuery({ accountFilter: OLD, model: "OTE", month: "2026-09", view: "pnl" }, NOW);
    expect(accountFilterChip(query, withArchived)).toEqual({ id: OLD, label: "Account: Old challenge · archived", removeHref: "/edge?model=OTE&view=pnl" });
    // The way back names no account, whichever filters the page has.
    const everything = parseEdgeQuery({ accountFilter: OLD, range: "30d", origin: "planned", instrument: "EURUSD", view: "count", currency: "USD" }, NOW, withArchived);
    const back = accountFilterChip(everything, withArchived)?.removeHref ?? "";
    expect(new URL(back, "http://edge.test").searchParams.has("accountFilter")).toBe(false);
    expect(back).toBe("/edge?range=30d&origin=planned&instrument=EURUSD&view=count&currency=USD");
    expect(accountFilterChip(query, ONE)).toBeNull();
    expect(accountFilterChip(parseEdgeQuery({}, NOW), withArchived)).toBeNull();
    expect(accountFilterChip(parseEdgeQuery({ accountFilter: "20000000-0000-4000-8000-000000000099" }, NOW), withArchived)?.label).toBe("Account: not available");
    expect(edgeAccountHistoryHref(OLD)).toBe(`/edge?accountFilter=${OLD}&account=all`);
  });

  it("renders one account's statistics with its chip, and every drill-down keeps the filter", async () => {
    m.context = withArchived;
    const archivedRows = [closed("2026-10-05", "1", { account_id: OLD }), closed("2026-10-06", "-1", { account_id: OLD })];
    m.load.mockImplementation(async (_db: unknown, _user: unknown, _scope: unknown, filters: { accountFilter?: string }) => ({
      rows: filters.accountFilter === OLD ? archivedRows : dataset(), truncated: false,
    }));
    const html = await renderPage({ accountFilter: OLD });
    expect(m.load).toHaveBeenCalledWith(expect.anything(), expect.any(String), { mode: "all" }, { accountFilter: OLD }, { closedOnly: true });
    const text = visibleText(html);
    expect(text).toContain("Account: Old challenge · archived");
    expect(text).toContain("Closed trades 2");
    expect(text).toContain("Reset filters");
    expect(text).not.toMatch(UUID);
    const remove = /<a[^>]*aria-label="Remove filter: Account: Old challenge · archived"[^>]*>/.exec(html)?.[0] ?? "";
    expect(remove).toContain('href="/edge"');
    const journal = [...html.matchAll(/href="(\/journal\?[^"]*)"/g)].map(match => match[1].replace(/&amp;/g, "&"));
    expect(journal.length).toBeGreaterThan(3);
    expect(journal.filter(href => new URL(href, "http://edge.test").searchParams.get("accountFilter") !== OLD)).toEqual([]);
  });

  it("keeps it when the origin breakdown removes the origin filter, so the page never widens to every account", async () => {
    m.context = withArchived;
    m.load.mockImplementation(async () => ({ rows: [closed("2026-10-05", "1", { account_id: OLD, origin: "LIVE_FIRST" })], truncated: false }));
    const html = await renderPage({ accountFilter: OLD, account: "all", origin: "live-first", month: "2026-10" });
    const clear = /<a[^>]*href="([^"]*)"[^>]*>Remove the origin filter<\/a>/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    expect(clear).toBe(`/edge?accountFilter=${OLD}`);
    expect(edgeHref({ ...parseEdgeQuery({ accountFilter: OLD, model: "OTE", origin: "live-first" }, NOW), origin: undefined })).toBe(`/edge?model=OTE&accountFilter=${OLD}`);
    // Its own chip is the only way out of it.
    const remove = /<a[^>]*aria-label="Remove filter: Account: Old challenge · archived"[^>]*>/.exec(html)?.[0] ?? "";
    expect(remove).toContain('href="/edge?origin=live-first"');
  });

  it("names the one account the statistics describe, and ignores a filter left in the URL by a switch to an account context", async () => {
    expect(scopeLabel(withArchived, { accountFilter: OLD })).toBe("Old challenge · USD · archived");
    expect(scopeLabel(withArchived, { accountFilter: PERSONAL })).toBe("Personal 12K · EUR");
    expect(scopeLabel(withArchived, { accountFilter: "20000000-0000-4000-8000-000000000099" })).toBe("All Accounts · 3 trading accounts");
    expect(scopeLabel(withArchived)).toBe("All Accounts · 3 trading accounts");
    expect(scopeLabel(ONE, { accountFilter: OLD })).toBe("FTMO 100K · USD");
    m.context = withArchived;
    m.load.mockImplementation(async () => ({ rows: [closed("2026-10-05", "1", { account_id: OLD })], truncated: false }));
    const filtered = visibleText(await renderPage({ accountFilter: OLD }));
    expect(filtered).toContain("Old challenge · USD · archived");
    expect(filtered).not.toContain("All Accounts · 3 trading accounts");
    // The header selector keeps the other parameters when it switches the context to one account.
    m.context = ONE;
    m.load.mockReset();
    m.load.mockImplementation(async () => ({ rows: [], truncated: false }));
    const data = await loadEdge({ accountFilter: OLD, model: "OTE" });
    expect(data.query.accountFilter).toBeUndefined();
    expect(data.filters).toEqual({ model: "OTE" });
    expect(m.load).toHaveBeenCalledWith(expect.anything(), expect.any(String), { mode: "account", accountId: FTMO }, { model: "OTE" }, { closedOnly: true });
    const stale = visibleText(await renderPage({ accountFilter: OLD }));
    expect(stale).toContain("No closed trades yet.");
    expect(stale).not.toContain("Reset filters");
    expect(stale).toContain("FTMO 100K · USD");
  });
});

describe("EDGE loader", () => {
  it("reads the context's closed trades once, without the instrument filter, and filters the instrument in TypeScript", async () => {
    m.context = ONE;
    const data = await loadEdge({ range: "30d", model: "OB_FIRST_TOUCH", instrument: "GBPUSD" });
    expect(m.load).toHaveBeenCalledTimes(1);
    const [, userId, scope, filters, options] = m.load.mock.calls[0];
    expect(userId).toBe("10000000-0000-4000-8000-000000000001");
    expect(scope).toEqual({ mode: "account", accountId: FTMO });
    expect(filters).toEqual({ closedFrom: "2026-09-24", closedTo: "2026-10-23", model: "OB_FIRST_TOUCH" });
    expect(options).toEqual({ closedOnly: true });
    expect(data.instruments).toEqual(["DE40", "EURUSD", "GBPUSD"]);
    expect(data.rows.every(row => row.symbol === "GBPUSD")).toBe(true);
    expect(data.view?.closedCount).toBe(3);
  });

  it("reads nothing without a trading account", async () => {
    m.context = resolveAccountContext({ accounts: [], stored: null, lastAccount: null, proxyNotice: false });
    const data = await loadEdge({});
    expect(m.load).not.toHaveBeenCalled();
    expect(data.view).toBeNull();
  });

  it("shows the calendar month of the URL, else of the latest exit, else of the range end, else the current month", () => {
    const rows = dataset();
    expect(defaultCalendarMonth(parseEdgeQuery({ month: "2026-08" }, NOW), rows, NOW)).toBe("2026-08");
    expect(defaultCalendarMonth(parseEdgeQuery({}, NOW), [closed("2026-09-30", "1")], NOW)).toBe("2026-09");
    expect(defaultCalendarMonth(parseEdgeQuery({ range: "last-month" }, NOW), [], NOW)).toBe("2026-09");
    expect(defaultCalendarMonth(parseEdgeQuery({}, NOW), [], NOW)).toBe("2026-10");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Presentation model.
// ---------------------------------------------------------------------------------------------------------------------
describe("EDGE presentation model", () => {
  it("formats ratios exactly, without floating point", () => {
    expect(formatRate("0.54838709677419354839")).toBe("54.8%");
    expect(formatRate(null)).toBe("—");
    expect(formatShare("0.725")).toBe("73%");
    expect(formatShare("-0.001")).toBe("0%");
    expect(formatProfitFactor({ profitFactor: "1.755", profitFactorState: "DEFINED" })).toBe("1.76");
    expect(formatProfitFactor({ profitFactor: null, profitFactorState: "NO_LOSSES" })).toBe("No losses");
    expect(formatDrawdownR("4.2")).toBe("-4.20R");
    expect(formatDrawdownR("0")).toBe("0.00R");
  });

  it("states the sample, the excluded trades and the All Accounts R label, and keeps money per currency", () => {
    const data = edgeData(dataset());
    const view = data.view;
    if (!view) throw new Error("expected a view");
    const headline = headlineModel(view, true);
    expect(headline.stats.map(stat => stat.label)).toEqual(["Net R", "Expectancy", "Win rate", "Profit factor", "Max R drawdown", "Closed trades"]);
    expect(headline.stats.find(stat => stat.key === "closed")).toMatchObject({ value: "19", hint: "1 without recorded risk" });
    expect(headline.money.map(money => money.currency)).toEqual(["EUR", "USD"]);
    expect(headline.notes).toEqual([
      "18 completed trades — small sample; treat differences as emerging tendencies, not conclusions.",
      "1 closed trade without a recorded risk is excluded from R statistics.",
      "R is per-trade risk units, not money.",
      "Money is shown per currency and never converted or added across currencies.",
    ]);
    expect(headline.stats.some(stat => stat.early)).toBe(false);
  });

  it("de-emphasises win rate, profit factor and expectancy below ten trades with the exact early-sample sentence", () => {
    const view = edgeData(dataset().slice(0, 3), {}, ONE).view;
    if (!view) throw new Error("expected a view");
    const headline = headlineModel(view, false);
    expect(headline.stats.filter(stat => stat.early).map(stat => stat.label)).toEqual(["Expectancy", "Win rate", "Profit factor"]);
    expect(headline.stats.find(stat => stat.key === "expectancy")?.tone).toBeNull();
    expect(headline.notes[0]).toBe(`3 completed trades. ${EARLY_SAMPLE_NOTE}`);
    expect(headline.notes).not.toContain("R is per-trade risk units, not money.");
  });

  it("links every curve point to its trade and every daily bar to the Journal of that exit day", () => {
    const data = edgeData(dataset());
    if (!data.view) throw new Error("expected a view");
    const curve = curveData(data.view, data.rows, data.context);
    expect(curve.cumulative[0]).toMatchObject({ label: "Start", value: "0", valueLabel: "0.00R" });
    expect(curve.cumulative.slice(1).every(point => point.href?.startsWith("/trades/"))).toBe(true);
    expect(curve.cumulative.at(-1)?.valueLabel).toBe(formatR(data.view.metrics.netR));
    expect(curve.cumulative[1].detail).toBe("Trade 1 · GBPUSD · Long · FTMO 100K · +2.00R on the trade");
    const daily = dailyData(data.view, data.rows);
    const oct14 = daily.r.find(point => point.key === "2026-10-14");
    expect(oct14).toMatchObject({ label: "Oct 14", value: "0", valueLabel: "0.00R" });
    expect(oct14?.href).toBe("/journal?closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed");
    expect(daily.money.map(entry => entry.currency)).toEqual(["EUR", "USD"]);
    expect(daily.money[0].data.find(point => point.key === "2026-10-14")?.valueLabel).toBe(formatSignedMoney("-30", "EUR"));
  });

  it("gives every breakdown group its N, the trades its N leaves out and its evidence label, and draws Planned vs Live-first only with ten trades per origin", () => {
    const data = edgeData(dataset());
    if (!data.view) throw new Error("expected a view");
    const sections = breakdownSections(data.view, data.rows, data.context);
    expect(sections.map(section => section.key)).toEqual(["model", "session", "weekday", "origin", "account", "riskPercent", "strategyVersion", "riskPlanVersion"]);
    const model = sections.find(section => section.key === "model");
    expect(model?.data.map(datum => [datum.label, datum.detail])).toEqual([
      ["OB first touch", "N = 12 · Emerging tendency"],
      ["OTE", "N = 4 · Insufficient evidence"],
      ["Other model", "N = 1 · Insufficient evidence"],
      // Two closed live-first trades without a model, one of them without a recorded risk: N = 1, and the other is counted.
      ["Model not recorded", "N = 1 · 1 without risk · Insufficient evidence"],
    ]);
    expect(model?.data[1].href).toBe("/journal?state=closed%2Creviewed&model=OTE");
    // Every card says what N counts when some closed trades have no recorded risk (§9.3: a visible count of the excluded).
    expect(sections.filter(section => section.key !== "account").every(section => section.sample === "19 closed trades · N counts trades with recorded risk")).toBe(true);
    const origin = sections.find(section => section.key === "origin");
    expect(origin?.data).toEqual([]);
    expect(origin?.empty?.title).toBe("Insufficient evidence");
    expect(origin?.empty?.description).toBe(
      "Planned: 16 trades with recorded risk · Live-first: 2 of 3 trades with recorded risk. Each group needs at least 10 closed trades with recorded risk before they are compared.",
    );
    const versions = sections.find(section => section.key === "riskPlanVersion");
    expect(versions?.data.map(datum => datum.label)).toEqual(["V1.0 · FTMO 100K", "V1.0 · Personal 12K", "No locked plan"]);
    expect(versions?.data.at(-1)?.detail).toBe("N = 2 · 1 without risk · Insufficient evidence");
  });

  it("states the closed trades a group's N leaves out next to every group, so a drill-down never opens more trades than it says", () => {
    const rows = dataset();
    const data = edgeData(rows);
    if (!data.view) throw new Error("expected a view");
    for (const section of breakdownSections(data.view, data.rows, data.context)) {
      for (const datum of section.data) {
        // The group's closed trades (what its Journal link lists) = N + the trades named "without risk".
        const n = Number(/N = (\d+)/.exec(datum.detail ?? "")?.[1] ?? "0");
        const excluded = Number(/(\d+) without risk/.exec(datum.detail ?? "")?.[1] ?? "0");
        const group = section.key === "account"
          ? data.view.contribution?.find(entry => `account:${entry.accountId}` === datum.key)?.closed
          : data.view.breakdowns[section.key]?.find(entry => `${entry.key}:${entry.value ?? "none"}` === datum.key)?.closed;
        expect(n + excluded, `${section.title} · ${datum.label}`).toBe(group);
      }
    }
  });

  it("lets a group's sample wrap only between its parts, never inside one or away from an amount's sign", () => {
    expect(keepPartsTogether("N = 19 · 2 without risk · +€876.81")).toBe("N = 19 · 2 without risk · +⁠€876.81");
    expect(keepPartsTogether("N = 10 · Emerging tendency")).toBe("N = 10 · Emerging tendency");
    expect(keepPartsTogether("N = 4 · -$12.50")).toBe("N = 4 · -⁠$12.50");
  });

  it("compares origins once both have ten trades with R, and explains an origin filter instead", () => {
    const rows = [...Array.from({ length: 10 }, (_, index) => closed(`2026-09-${String(index + 1).padStart(2, "0")}`, "1")),
      ...Array.from({ length: 12 }, (_, index) => closed(`2026-09-${String(index + 11).padStart(2, "0")}`, index < 10 ? "-1" : null, { origin: "LIVE_FIRST" }))];
    const data = edgeData(rows, {}, ONE);
    if (!data.view) throw new Error("expected a view");
    const compared = originSection(data.view.breakdowns.origin ?? [], data.view.metrics);
    expect(compared.empty).toBeUndefined();
    expect(compared.data.map(datum => [datum.label, datum.valueLabel, datum.detail])).toEqual([
      ["Planned", "+10.00R", "N = 10 · Emerging tendency"],
      ["Live-first", "-10.00R", "N = 10 · 2 without risk · Emerging tendency"],
    ]);
    expect(compared.sample).toBe("22 closed trades · N counts trades with recorded risk");
    const filtered = originSection(data.view.breakdowns.origin ?? [], data.view.metrics, { label: "Live-first", clearHref: "/edge" });
    expect(filtered.empty?.title).toBe("Showing Live-first trades only");
    expect(filtered.empty?.links).toEqual([{ label: "Remove the origin filter", href: "/edge" }]);
  });

  it("shows account shares only when no account subtracts from the combined net R", () => {
    const positive = edgeData(dataset().filter(row => row.origin === "PLANNED"));
    if (!positive.view) throw new Error("expected a view");
    const shares = contributionSection(positive.view);
    expect(shares.data.every(datum => /· \d+%$/.test(datum.valueLabel))).toBe(true);
    expect(shares.data[0].href).toBe(`/journal?state=closed%2Creviewed&account=${FTMO}`);
    const mixed = edgeData([closed("2026-10-01", "3"), closed("2026-10-02", "-1", { account_id: PERSONAL, currency: "EUR" })]);
    if (!mixed.view) throw new Error("expected a view");
    const section = contributionSection(mixed.view);
    expect(section.data.map(datum => datum.valueLabel)).toEqual(["+3.00R", "-1.00R"]);
    expect(section.sample).toBe("Net R per account · R is per-trade risk units, not money");
  });

  it("counts an account's trades without risk next to its N, since its P&L includes them", () => {
    const data = edgeData(dataset());
    if (!data.view) throw new Error("expected a view");
    const ftmo = contributionSection(data.view).data.find(datum => datum.label === "FTMO 100K");
    // 12 planned + 3 live-first FTMO trades: 14 with R, the 15th without; the P&L covers all 15.
    const pnl = data.rows.filter(row => row.account_id === FTMO).reduce((total, row) => total.plus(row.net_pnl ?? "0"), new Decimal(0));
    expect(ftmo?.detail).toBe(`N = 14 · 1 without risk · ${formatSignedMoney(pnl.toFixed(), "USD")}`);
  });

  it("builds calendar days with every figure, each trade's link, its screenshots link and its state", () => {
    const data = edgeData(dataset(), { month: "2026-10" });
    const calendar = calendarModel(data, filterQuery(data.query));
    if (!calendar) throw new Error("expected a calendar");
    expect(calendar.month).toBe("2026-10");
    expect(calendar.currencies).toEqual(["EUR", "USD"]);
    expect(calendar.defaultCurrency).toBe("USD");
    const oct14 = calendar.days.find(day => day.day === "2026-10-14");
    expect(oct14).toMatchObject({ label: "Wed, Oct 14", closed: 2, rTrades: 2, rLabel: "0.00R", rDetail: "0.00R", countLabel: "2 trades", withoutRisk: null });
    expect(oct14?.money.map(money => money.netLabel)).toEqual(["-€30.00", "+$50.00"]);
    const reviewed = oct14?.trades.find(trade => trade.evidenceCount === 3);
    expect(reviewed).toMatchObject({
      title: "EURUSD · Long", account: "FTMO 100K", model: "OTE", origin: "Planned", state: { label: "Reviewed", tone: "positive-muted" },
      evidenceHref: expect.stringMatching(new RegExp(`^/trades/[0-9a-f-]+#evidence-${COVER}$`)), thumbSrc: `/api/evidence/${COVER}?variant=thumb`,
    });
    expect(calendar.days.some(day => day.day === "2026-10-03")).toBe(false);
  });

  it("never lets a calendar day's R read as covering trades without a recorded risk", () => {
    const data = edgeData(dataset(), { month: "2026-10" });
    const calendar = calendarModel(data, filterQuery(data.query));
    if (!calendar) throw new Error("expected a calendar");
    // Oct 21: a Personal trade at -0.25R and a live-first trade without risk (-$12.50).
    const oct21 = calendar.days.find(day => day.day === "2026-10-21");
    expect(oct21).toMatchObject({ closed: 2, rTrades: 1, rLabel: "-0.25R", rDetail: "-0.25R (1 of 2 with risk)", withoutRisk: "1 without risk" });
    expect(rCoverage(null, 0, 3)).toBe("No recorded risk");
    expect(rCoverage("1.5", 3, 3)).toBe("+1.50R");
    if (!oct21) throw new Error("expected Oct 21");
    // Cells (every mode), the phone list and the spoken label carry the coverage; so does the day sheet's summary.
    expect(dayView(oct21, "NET_R", "USD")).toMatchObject({ primary: "-0.25R", secondary: ["-€7.50 · -$12.50", "2 trades · 1 without risk"] });
    expect(dayView(oct21, "NET_R", "USD").spoken).toBe("-0.25R (1 of 2 with risk), -€7.50 · -$12.50, 2 trades");
    expect(dayView(oct21, "NET_PNL", "USD").secondary).toEqual(["-€7.50 · -0.25R", "2 trades · 1 without risk"]);
    expect(dayView(oct21, "GROSS_LOSS", "USD").secondary).toEqual(["-€7.50 · -$12.50", "2 trades · 1 without risk · -0.25R"]);
    expect(dayView(oct21, "COUNT", "USD").secondary).toEqual(["-0.25R · 1 without risk", "-€7.50 · -$12.50"]);
    expect(daySummary(oct21)).toBe("2 closed trades · -0.25R (1 of 2 with risk) · -€7.50 · -$12.50");
    const html = renderToStaticMarkup(createElement(PerformanceCalendar, { model: calendar, initialMode: "NET_R", initialCurrency: null, initialDay: null }));
    expect(html).toContain('aria-label="Wed, Oct 21: -0.25R (1 of 2 with risk), -€7.50 · -$12.50, 2 trades. Show trades."');
    expect(html).toContain(">2 trades · 1 without risk<");
    // The table view's Net R column.
    expect(html).toContain(">-0.25R (1 of 2 with risk)<");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Rendered screen.
// ---------------------------------------------------------------------------------------------------------------------
describe("EDGE page (rendered)", () => {
  it("renders the filter row, headline, charts with questions and samples, calendar, breakdowns and definitions", async () => {
    const html = await renderPage({ month: "2026-10" });
    const text = visibleText(html);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(text).toContain("All Accounts · 2 trading accounts");
    for (const label of ["Date range", "Model", "Entry session", "Origin", "Instrument"]) expect(html).toContain(label);
    for (const option of ["All time", "Last 30 days", "Year to date", "All models", "OB first touch", "Kill zone", "Live-first", "All instruments", "DE40"]) expect(text).toContain(option);
    for (const stat of ["Net R", "Expectancy", "Win rate", "Profit factor", "Max R drawdown", "Closed trades", "Net P&L"]) expect(text).toContain(stat);
    for (const [title, question] of [
      ["Cumulative R", "Is the process compounding?"], ["R drawdown", "Where am I giving profits back?"], ["Daily net R", "Which days drive results?"],
      ["R distribution", "How are outcomes distributed?"], ["Performance calendar", "When am I winning or losing?"], ["Net R by model", "Which conditions perform?"],
      ["Account contribution", "Which account contributes most?"], ["Planned vs Live-first", "Does planning before entry change results?"],
    ]) {
      expect(text).toContain(title);
      expect(text).toContain(question);
    }
    expect(text).toContain("18 trades with recorded risk · small sample · 1 without risk excluded · R is per-trade risk units");
    // Every chart shows its sample (§13.6), the drawdown included.
    expect(text).toContain("18 trades with recorded risk · distance below the running peak");
    expect(text).toContain("Insufficient evidence");
    expect(text).toContain("R is per-trade risk units, not money.");
    expect(text).toContain("Calculation definitions");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Chart</);
    expect(html).toContain('href="/journal?state=closed%2Creviewed&amp;model=OTE"');
    expect(html).toMatch(/href="\/trades\/a0000000-0000-4000-8000-0000000000\d\d"/);
    // Calendar cells print every figure and open the day's trades.
    expect(html).toContain('aria-label="Wed, Oct 14: 0.00R, -€30.00 · +$50.00, 2 trades. Show trades."');
    // The description promises only what the page does; the headline's figures open their trades from the footer.
    expect(text).toContain(EDGE_DESCRIPTION);
    expect(EDGE_DESCRIPTION).not.toContain("Every figure");
    expect(html).toMatch(/<a[^>]*href="\/journal\?state=closed%2Creviewed"[^>]*>Open these 19 trades in the Journal/);
    expect(text).toContain("Export closed trades (CSV)");
  });

  it("names the trades without risk wherever a group, an account or a day is summarised", async () => {
    const html = await renderPage({ month: "2026-10" });
    const text = visibleText(html);
    expect(text).toContain("Model not recorded: Net R -1.00R. N = 1 · 1 without risk · Insufficient evidence");
    expect(text).toContain("Planned: 16 trades with recorded risk · Live-first: 2 of 3 trades with recorded risk.");
    expect(text).toContain("19 closed trades · N counts trades with recorded risk");
    expect(text).toMatch(/FTMO 100K: Net R \+7\.10R · \d+%\. N = 14 · 1 without risk · \+\$342\.50/);
    expect(html).toContain('aria-label="Wed, Oct 21: -0.25R (1 of 2 with risk), -€7.50 · -$12.50, 2 trades. Show trades."');
  });

  it("lays the page out for phones: section jumps, one breakdown at a time, the latest days first", async () => {
    const html = await renderPage({ month: "2026-10" });
    // Jumps to the four sections, which carry the anchors (offset below the sticky top bar).
    for (const [href, label] of [["#edge-results", "Results"], ["#edge-over-time", "Over time"], ["#edge-calendar", "Calendar"], ["#edge-breakdowns", "Breakdowns"]]) {
      expect(html).toContain(`href="${href}"`);
      expect(html).toMatch(new RegExp(`<[a-z]+(?=[^>]*id="${href.slice(1)}")(?=[^>]*class="[^"]*scroll-mt-20)[^>]*>`));
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).toContain('aria-label="Sections of this page"');
    // One breakdown picker; every card is in the HTML, all but the picked one hidden below 768px.
    expect(html).toContain(">Breakdown shown<");
    for (const [value, title] of [["model", "Net R by model"], ["session", "Net R by entry session"], ["origin", "Planned vs Live-first"], ["account", "Account contribution"], ["riskPlanVersion", "Net R by risk plan version"]]) {
      expect(html).toMatch(new RegExp(`<option value="${value}"( selected="")?>${title}</option>`));
    }
    expect(html.match(/<div class="max-md:hidden">/g)).toHaveLength(7);
    // October has 15 days with trades: the phone list shows the latest five, newest first, and offers the rest.
    const list = /aria-label="Days with closed trades, October 2026, latest first">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    expect([...list.matchAll(/data-calendar-day="([\d-]+)"/g)].map(match => match[1])).toEqual(["2026-10-21", "2026-10-20", "2026-10-19", "2026-10-16", "2026-10-15"]);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show all 15 days</);
  });

  it("returns the focus to the day that opened the sheet: every day button is findable by its day", () => {
    const data = edgeData(dataset(), { month: "2026-10" });
    const calendar = calendarModel(data, filterQuery(data.query));
    if (!calendar) throw new Error("expected a calendar");
    const html = renderToStaticMarkup(createElement(PerformanceCalendar, { model: calendar, initialMode: "NET_R", initialCurrency: null, initialDay: null }));
    // Calendar cell, phone list row (latest five) and table row of a day carry its date for the `?day=` fallback.
    expect(html.match(/data-calendar-day="2026-10-21"/g)).toHaveLength(3);
    expect(html.match(/data-calendar-day="2026-10-01"/g)).toHaveLength(2);
    expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(calendar.days.length * 2 + PHONE_DAY_LIMIT);
  });

  it("keeps month navigation as real links that dim the calendar while the next month loads", () => {
    const data = edgeData(dataset(), { month: "2026-09" });
    const calendar = calendarModel(data, filterQuery(data.query));
    if (!calendar) throw new Error("expected a calendar");
    const html = renderToStaticMarkup(createElement(PerformanceCalendar, { model: calendar, initialMode: "NET_R", initialCurrency: null, initialDay: null }));
    expect(html).toMatch(/<div class="refetch" aria-busy="false"><figure/);
    expect(html).toMatch(/<a(?=[^>]*href="\/edge\?month=2026-08")(?=[^>]*aria-label="Previous month, August 2026")[^>]*>/);
    expect(html).toMatch(/<a(?=[^>]*href="\/edge\?month=2026-10")(?=[^>]*aria-label="Next month, October 2026")[^>]*>/);
    expect(html).toMatch(/href="\/edge\?month=2026-10"[^>]*>This month</);
  });

  it("shows no raw ids, hashes or backend codes in the default view", async () => {
    const variants: Record<string, string>[] = [{ month: "2026-10" }, { origin: "live-first", view: "pnl", currency: "EUR" }, { range: "custom", closedFrom: "2020-01-01", closedTo: "2020-01-31" }];
    for (const params of variants) {
      const text = visibleText(await renderPage(params));
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(ENUM);
      expect(text).not.toMatch(/NaN|undefined|Infinity|\[object/);
    }
  });

  it("keeps calculation codes inside Technical details", async () => {
    const html = await renderPage({});
    expect(html).toContain("FULL_CLOSE_V1");
    expect(visibleText(html)).not.toContain("FULL_CLOSE_V1");
  });

  it("offers the CSV of the selected account with the page's filters, from a menu that says what the file holds", async () => {
    m.context = ONE;
    const html = await renderPage({ range: "month", model: "OTE" });
    // The menu (closed on arrival) lists the account's file below the note; its link carries the page's filters.
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>.*Export closed trades \(CSV\)/);
    const rows = dataset().filter(row => row.account_id === FTMO && row.entry_model === "OTE");
    expect(exportLinks({ context: ONE, query: parseEdgeQuery({ range: "month", model: "OTE" }, NOW), rows })).toEqual([
      { label: "FTMO 100K", detail: `${rows.length} trades · USD`, href: `/edge/export?account=${FTMO}&closedFrom=2026-10-01&closedTo=2026-10-23&model=OTE` },
    ]);
    expect(EXPORT_NOTE).toContain("planned, live-first and imported");
    expect(html).toContain("FTMO 100K · USD");
    expect(visibleText(html)).not.toContain("Account contribution");
  });

  it("offers the CSV while the page shows live-first or imported trades only: the file holds what the page shows", async () => {
    for (const origin of ["live-first", "imported"]) {
      m.context = ONE;
      const html = await renderPage({ origin, model: "OTE" });
      expect(html).toMatch(/<button(?![^>]*disabled)[^>]*aria-haspopup="menu"[^>]*>.*Export closed trades \(CSV\)/);
      expect(visibleText(html)).not.toContain("planned trades only");
    }
    expect(exportLinks({ context: ONE, query: parseEdgeQuery({ origin: "imported", model: "OTE" }, NOW), rows: dataset() })[0].href)
      .toBe(`/edge/export?account=${FTMO}&origin=imported&model=OTE`);
  });

  it("shows the empty state with the next actions before the first closed trade", async () => {
    m.load.mockImplementation(async () => ({ rows: [], truncated: false }));
    const html = await renderPage({});
    const text = visibleText(html);
    expect(text).toContain("No closed trades yet.");
    expect(text).toContain("Record or plan a trade; results appear here after you close it.");
    expect(html).toContain('href="/trades/new"');
    expect(html).toContain('href="/trades/live/new"');
    expect(text).not.toContain("Cumulative R");
    expect(text).not.toContain("Export closed trades");
  });

  it("offers to reset filters when the filters match nothing, naming the date range only when one is set", async () => {
    m.load.mockImplementation(async () => ({ rows: [], truncated: false }));
    const html = await renderPage({ range: "custom", closedFrom: "2020-01-01", closedTo: "2020-01-31" });
    const text = visibleText(html);
    expect(text).toContain("No closed trades match these filters.");
    expect(text).toContain("Custom range · Jan 1, 2020 – Jan 31, 2020. Widen the date range to see results.");
    expect(text).toContain("Reset filters");
    expect(html).toMatch(/href="\/edge"[^>]*>Reset filters</);
    const allTime = visibleText(await renderPage({ session: "ASIA" }));
    expect(allTime).toContain("No closed trades match these filters. Remove a filter to see results.");
    expect(allTime).not.toContain("every closed trade.");
    expect(noMatchDescription(parseEdgeQuery({ range: "30d", model: "OTE" }, NOW), NOW)).toBe("Last 30 days · Sep 24 – Oct 23. Widen the date range or remove a filter to see results.");
    expect(noMatchDescription(parseEdgeQuery({ range: "custom", model: "OTE" }, NOW), NOW)).toBe("Remove a filter to see results.");
  });

  it("asks for a trading account first", async () => {
    m.context = resolveAccountContext({ accounts: [], stored: null, lastAccount: null, proxyNotice: false });
    const html = await renderPage({});
    expect(visibleText(html)).toContain("Create your first trading account");
    expect(html).toContain('href="/accounts/new"');
  });

  it("says when a link's filters could not be read and when results are incomplete", async () => {
    m.load.mockImplementation(async () => ({ rows: dataset(), truncated: true }));
    const text = visibleText(await renderPage({ model: "SCALP" }));
    expect(text).toContain("Some filters in this link couldn't be read and were ignored.");
    expect(text).toContain("Only the first 20,000 closed trades are included. Narrow the date range for complete statistics.");
  });

  it("dims calendar days outside the selected range and lists every day with trades for phones", () => {
    // The ledger read applies the date range; here the fixture rows are filtered the same way.
    const inRange = dataset().filter(row => (row.exited_at ?? "") >= "2026-10-10T05:00:00Z");
    const data = edgeData(inRange, { range: "custom", closedFrom: "2026-10-10", closedTo: "2026-10-31", month: "2026-10" });
    const calendar = calendarModel(data, filterQuery(data.query));
    if (!calendar) throw new Error("expected a calendar");
    const html = renderToStaticMarkup(createElement(PerformanceCalendar, { model: calendar, initialMode: "COUNT", initialCurrency: null, initialDay: null }));
    expect(html).toContain("Days outside the selected date range are dimmed.");
    expect(html).toContain(", outside the selected date range");
    expect(html).toContain('aria-label="Days with closed trades, October 2026, latest first"');
    expect(html).toContain('data-tone="seq"');
    // No day before the range has a button.
    expect(html).not.toContain('aria-label="Thu, Oct 1:');
    // Eight days with trades: the latest five are listed, the other three one tap away.
    expect(calendar.days).toHaveLength(PHONE_DAY_LIMIT + 3);
    expect(html).toContain(`Show all ${PHONE_DAY_LIMIT + 3} days`);
  });

  it("lists each trade of a day as one 44px trade link plus a 56px screenshot link (§13.5 touch targets)", () => {
    const data = edgeData(dataset(), { month: "2026-10" });
    const calendar = calendarModel(data, filterQuery(data.query));
    const trade = calendar?.days.find(day => day.day === "2026-10-14")?.trades.find(entry => entry.evidenceCount === 3);
    if (!trade) throw new Error("expected the reviewed trade");
    const html = renderToStaticMarkup(createElement(DayTrade, { trade, multiAccount: true }));
    const links = [...html.matchAll(/<a ([^>]*)>/g)].map(match => match[1]);
    expect(links).toHaveLength(2);
    const [screenshots, row] = links;
    expect(screenshots).toContain(`href="${trade.evidenceHref}"`);
    expect(screenshots).toContain('aria-label="3 screenshots of EURUSD · Long"');
    expect(html).toContain('class="h-14 w-20');
    expect(row).toContain(`href="${trade.href}"`);
    expect(row).toMatch(/class="[^"]*min-h-11/);
    expect(visibleText(html)).not.toContain("Open trade");
    // A trade without screenshots: only the row link, and the placeholder says so.
    const plain = renderToStaticMarkup(createElement(DayTrade, { trade: { ...trade, evidenceCount: 0, evidenceHref: null, thumbSrc: null }, multiAccount: false }));
    expect(plain.match(/<a /g)).toHaveLength(1);
    expect(plain).toContain("No screenshots");
  });

  it("labels the break-even trades of the 0R bin and keeps every bin linked", () => {
    const data = edgeData(dataset());
    if (!data.view) throw new Error("expected a view");
    const bins = distributionBins(data.view, data.rows);
    const zero = bins.find(bin => bin.from === "0");
    // Oct 9 closed at exactly 0R: it shares the 0.0R to +0.5R bin, whose words now say it is break-even.
    expect(zero).toMatchObject({ label: "0.0R to +0.5R", count: 1, breakEven: 1, countLabel: "1 trade · 1 break-even (0R)" });
    expect(binSign(zero ?? { from: null, to: null, breakEven: 0 })).toBe("neutral");
    expect(bins.filter(bin => bin !== zero).every(bin => !bin.countLabel?.includes("break-even") && bin.breakEven === 0)).toBe(true);
    expect(bins.every(bin => bin.href?.startsWith("/journal?"))).toBe(true);
  });

  it("draws a 0R bin that holds only winners as profit on the page", () => {
    const data = edgeData([closed("2026-10-05", "0.3"), closed("2026-10-06", "-0.7"), closed("2026-10-07", "1.2")]);
    if (!data.view) throw new Error("expected a view");
    const bins = distributionBins(data.view, data.rows);
    const zero = bins.find(bin => bin.from === "0");
    expect(zero).toMatchObject({ count: 1, breakEven: 0, countLabel: "1 trade" });
    const html = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins }));
    const signs = [...html.matchAll(/class="chart-bar" data-sign="([a-z]+)"/g)].map(match => match[1]);
    expect(signs).toHaveLength(bins.length);
    expect(signs[bins.indexOf(zero ?? bins[0])]).toBe("pos");
    expect(signs).not.toContain("neutral");
  });

  it("dims the results while Reset filters loads, keeping a real link", async () => {
    const html = await renderPage({ session: "ASIA" });
    expect(html).toMatch(/<a[^>]*href="\/edge"[^>]*>Reset filters<\/a>/);
    expect(html).toMatch(/<div class="refetch flex flex-col gap-6" aria-busy="false">/);
  });

  it("renders a loading skeleton announced once", () => {
    const html = renderToStaticMarkup(createElement(EdgeLoading));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading EDGE");
  });

  it("builds the same statistics as the performance data layer", () => {
    const data = edgeData(dataset());
    const direct = buildPerformance(ALL, { rows: dataset(), truncated: false }, {}, NOW, { month: data.month, calendarMode: "NET_R" });
    expect(data.view?.metrics).toEqual(direct.metrics);
    expect(data.view?.money).toEqual(direct.money);
  });
});
