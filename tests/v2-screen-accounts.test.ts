import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Accounts screens (docs/V2_ARCHITECTURE.md §9, §14.7–14.9, §15): the workspace summary, the account dashboard and the
// Manage page, rendered on the server with mocked loaders and actions. No database, no network.

const m = vi.hoisted(() => ({
  overview: vi.fn(),
  dashboard: vi.fn(),
  manage: vi.fn(),
  connection: vi.fn(),
  context: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  // The loaders' reads (accounts-data's own logic runs for real in "Accounts loaders").
  ledgerRows: vi.fn(),
  workspace: vi.fn(),
  ledgerPage: vi.fn(),
  decorate: vi.fn(),
  pathname: "/accounts/new",
  actions: {
    createTradingAccount: vi.fn(), updateProfile: vi.fn(), archiveAccount: vi.fn(), restoreAccount: vi.fn(), createInstrument: vi.fn(), recordAccountValues: vi.fn(),
    confirmAccountValuesUnchanged: vi.fn(), addExternalLoss: vi.fn(), removeExternalLoss: vi.fn(), createRiskPolicyVersion: vi.fn(),
  },
  connectionActions: { createMockConnection: vi.fn(), disconnectConnection: vi.fn(), runMockSync: vi.fn(), linkExecution: vi.fn(), unlinkExecution: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: {}, user: { id: "user" } }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: m.push, replace: vi.fn(), refresh: m.refresh, prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => m.pathname,
}));
vi.mock("@/app/actions/accounts", () => m.actions);
vi.mock("@/app/actions/connections", () => m.connectionActions);
vi.mock("@/lib/account-context", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/account-context")>()),
  getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
  getAccountContext: m.context,
}));
vi.mock("@/lib/accounts-data", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/accounts-data")>()),
  getAccountsOverview: m.overview,
  getAccountDashboard: m.dashboard,
  getAccountManage: m.manage,
}));
vi.mock("@/components/accounts/connection-data", () => ({ loadConnectionDetails: m.connection }));
vi.mock("@/lib/performance-data", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/performance-data")>()), loadLedgerRows: m.ledgerRows }));
vi.mock("@/lib/workspace", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/workspace")>()), loadAccountWorkspace: m.workspace }));
vi.mock("@/lib/trades-data", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/trades-data")>()),
  loadLedgerPage: m.ledgerPage,
  decorateTrades: m.decorate,
}));

import AccountDashboardPage, { generateMetadata as dashboardMetadata } from "@/app/(app)/accounts/[id]/page";
import ManageAccountPage from "@/app/(app)/accounts/[id]/manage/page";
import NewAccountPage from "@/app/(app)/accounts/new/page";
import AccountsPage from "@/app/(app)/accounts/page";
import { AccountDashboardView, dashboardHref, parseCalendarMode, recordedOn } from "@/components/accounts/account-dashboard";
import { AccountsOverviewView, combinedR, connectionLabel } from "@/components/accounts/accounts-overview";
import type { ConnectionDetails } from "@/components/accounts/connection-data";
import { contextSwitchTarget } from "@/components/accounts/context-switch-scope";
import {
  ACTIVE_ACCOUNTS_HEADING, ARCHIVE_COPY, ARCHIVED_DASHBOARD_COPY, ARCHIVED_VALUES_COPY, accountDashboardHref, CONFIRM_UNCHANGED, EXTERNAL_LOSS_HELPER,
  EXTERNAL_LOSSES_TITLE, IMMEDIATE_OPTION_COPY, manageHref, MANUAL_CONNECTION_COPY, parseManageTab, R_UNITS_NOTE, tickValueNote, UPDATE_VALUES, VERSIONING_COPY,
} from "@/components/accounts/copy";
import { CreateAccountForm, DEFAULT_PLAN_NOTE, focusAfterCreated } from "@/components/accounts/create-account-form";
import { focusElement, restoreFocusAfterDialog, restoreFocusWhenGone } from "@/components/accounts/focus";
import { type InstrumentDraft, InstrumentForm, instrumentDraftKey } from "@/components/accounts/manage-instrument-form";
import { ManageView, type ManageViewProps } from "@/components/accounts/manage-view";
import { checkField, checkForm, type FieldRule } from "@/components/accounts/form-checks";
import { fieldError } from "@/components/accounts/use-account-action";
import { prefetchFor } from "@/components/ui/links";
import { accountCurrencyTotals, accountMetrics, BALANCE_FROM_TRADES_LABEL, UNKNOWN_REASONS } from "@/domain/account-metrics";
import { dailyStatusV2 } from "@/domain/daily-status";
import { formatR } from "@/domain/format";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { breakdown, dailySeries, drawdownSeries, equityCurveR, isClosed } from "@/domain/performance";
import type { DailyUsage, Instrument } from "@/domain/risk";
import { deriveTradeState } from "@/domain/trade-state";
import { type ContextAccount, resolveAccountContext } from "@/lib/account-context";
import {
  type AccountDashboard, type AccountManage, type AccountsOverview, type AccountSummary, balanceCurve, loadAccountDashboard, loadAccountsOverview, minimumRrWarning,
  riskPlanTimeline,
} from "@/lib/accounts-data";
import { breakdownHref, closedOnHref, linkedCalendar, MAX_LEDGER_ROWS } from "@/lib/performance-data";
import type { AccountConnectionState, ExternalExecution, PlatformConnection, PlatformOption } from "@/lib/sync-service";
import { journalHref, type TradeListRow } from "@/lib/trades-data";
import type { AccountWorkspace, WorkspaceObservation, WorkspaceRiskPlan } from "@/lib/workspace";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------------------------------
const FTMO = "a1000000-0000-4000-8000-000000000001";
const DEMO = "a1000000-0000-4000-8000-000000000002";
const PERSONAL = "a1000000-0000-4000-8000-000000000003";
const OLD = "a1000000-0000-4000-8000-000000000004";
/** Fri Oct 23, 14:00 UTC−5. */
const NOW = "2026-10-23T19:00:00.000Z";
const TODAY = "2026-10-23";
const STRATEGY = { mode: "strategy" } as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `LIVE_FIRST`, `MAX_TRADES`): never in visible text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const MANUAL: AccountConnectionState = { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null };

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const render = (element: ReactElement) => renderToStaticMarkup(element);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function expectClean(markup: string) {
  const text = visibleText(markup);
  expect(text).not.toMatch(UUID);
  expect(text).not.toMatch(ENUM);
  expect(count(markup, "<h1")).toBe(1);
}

function account(id: string, overrides: Partial<ContextAccount> = {}): ContextAccount {
  return {
    id, name: "FTMO 100K", currency: "USD", type: "EVALUATION", platform: "MT5", broker: "FTMO", status: "ACTIVE", startingBalance: "100000",
    createdAt: "2026-07-23T12:00:00Z", profile: "PROFILE", ...overrides,
  };
}

let sequence = 0;
function trade(overrides: Partial<LedgerTrade>): LedgerTrade {
  sequence += 1;
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null]));
  return {
    ...blank,
    id: `b${String(sequence).padStart(7, "0")}-0000-4000-8000-000000000000`,
    account_id: FTMO, origin: "PLANNED", created_at: "2026-10-01T12:00:00Z", currency: "USD", revision_count: 1, entry_time_known: true, oversize: false,
    lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, symbol: "EURUSD", direction: "LONG", entry_model: "OTE",
    ...overrides,
  } as LedgerTrade;
}

/** A closed planned trade entered two hours before its exit. */
function closedTrade(accountId: string, exitedAt: string, r: string | null, pnl: string, overrides: Partial<LedgerTrade> = {}): LedgerTrade {
  const exit = new Date(exitedAt);
  const entry = new Date(exit.getTime() - 2 * 3_600_000).toISOString();
  return trade({
    account_id: accountId, plan_id: `c${String(sequence + 1).padStart(7, "0")}-0000-4000-8000-000000000000`, locked_at: entry, entered_at: entry, entry_recorded_at: entry,
    entry_price: "1.1", exited_at: exitedAt, close_recorded_at: exitedAt, net_pnl: pnl, realized_r: r, requested_risk_percent: "0.5",
    outcome: pnl.startsWith("-") ? "LOSS" : pnl === "0" ? "BREAKEVEN" : "WIN", lifecycle: "CLOSED", ...overrides,
  });
}

function observation(tradingDay: string, balance = "101000", equity = "100950"): WorkspaceObservation {
  return { id: "d1000000-0000-4000-8000-000000000001", balance, equity, grossLossToday: null, tradingDay, recordedAt: `${tradingDay}T13:00:00Z` };
}

/** `complete: false`: the account's read stopped at the row limit (its trade figures are unknown). */
function metricsFor(target: ContextAccount, trades: LedgerTrade[], latest: WorkspaceObservation | null, complete = true) {
  return accountMetrics({
    account: { id: target.id, currency: target.currency },
    profile: { displayName: target.name, broker: target.broker, platform: target.platform, accountType: target.type, startingBalance: target.startingBalance, status: target.status },
    latestObservation: latest ? { balance: latest.balance, equity: latest.equity, tradingDay: latest.tradingDay, recordedAt: latest.recordedAt } : null,
    trades,
    tradesComplete: complete,
    now: NOW,
  });
}

function summary(target: ContextAccount, trades: LedgerTrade[], latest: WorkspaceObservation | null, complete = true): AccountSummary {
  return {
    account: target, metrics: metricsFor(target, trades, latest, complete), connection: MANUAL, href: accountDashboardHref(target), manageHref: `/accounts/${target.id}/manage`,
  };
}

const ftmo = account(FTMO);
const demo = account(DEMO, { name: "Demo 100K", type: "DEMO", platform: "MANUAL", broker: null });
const personal = account(PERSONAL, { name: "Personal 12K", currency: "EUR", type: "PERSONAL", platform: "CTRADER", broker: "IC Markets", startingBalance: null });
const archived = account(OLD, { name: "Old challenge", status: "ARCHIVED" });

const overviewTrades = [
  closedTrade(FTMO, "2026-10-23T15:00:00Z", "2", "1000"),
  closedTrade(FTMO, "2026-10-16T15:00:00Z", "-1", "-500"),
  closedTrade(DEMO, "2026-10-20T15:00:00Z", "1", "400", { account_id: DEMO }),
  trade({ account_id: DEMO, origin: "LIVE_FIRST", lifecycle: "LIVE", entered_at: "2026-10-23T14:00:00Z", entry_recorded_at: "2026-10-23T14:00:00Z", entry_price: "1.1" }),
];

function overviewFixture(accounts: ContextAccount[] = [ftmo, demo, personal, archived]): AccountsOverview {
  const summaries = accounts.map(item =>
    summary(item, overviewTrades, item.id === FTMO ? observation(TODAY) : item.id === DEMO ? observation("2026-10-16", "100400", "100380") : item.id === OLD ? observation("2026-08-01") : null),
  );
  const active = summaries.filter(item => item.account.status === "ACTIVE");
  return {
    context: resolveAccountContext({ accounts, stored: "all", lastAccount: null, proxyNotice: false }),
    now: NOW,
    active,
    archived: summaries.filter(item => item.account.status === "ARCHIVED"),
    totals: accountCurrencyTotals(active.map(item => item.metrics)),
  };
}

function plan(id: string, version: string, createdAt: string, effectiveDay: string, overrides: Partial<WorkspaceRiskPlan> = {}): WorkspaceRiskPlan {
  return {
    id, version, maxRiskPercent: "0.75", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: "2000",
    dailyLossCap: null, effectiveDay, createdAt, overrideReason: null, ...overrides,
  };
}

const PLANS = [
  plan("e1000000-0000-4000-8000-000000000001", "Risk Plan V1.0", "2026-07-23T12:00:00Z", "2026-07-23", { defaultRiskPercent: null, maxRiskPercent: "0.5" }),
  plan("e1000000-0000-4000-8000-000000000002", "Risk Plan V1.1", "2026-10-01T12:00:00Z", "2026-10-02", { minRR: "2.5", rrPolicy: "WARN", overrideReason: null }),
  plan("e1000000-0000-4000-8000-000000000003", "Risk Plan V1.2", "2026-10-23T14:00:00Z", "2026-10-24", { maxRiskPercent: "1", dailyLossCap: "5000" }),
];

const INSTRUMENT: Instrument = {
  id: "f1000000-0000-4000-8000-000000000001", symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1",
  quantityStep: "0.01", minimumQuantity: "0.01",
};

function usage(overrides: Partial<DailyUsage> = {}): DailyUsage {
  return {
    day: TODAY, plannedSlots: 1, plannedRisk: "500", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0",
    legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0", ...overrides,
  };
}

function workspace(target: ContextAccount, latest: WorkspaceObservation | null, overrides: Partial<AccountWorkspace> = {}): AccountWorkspace {
  const riskPlan = PLANS[1];
  return {
    account: target, now: NOW, day: TODAY, observation: latest, riskPlan, strategy: { id: "f2000000-0000-4000-8000-000000000001", version: "ICT V1.0", rules: {} },
    instruments: [INSTRUMENT], usage: usage(), todaysPlans: [],
    status: dailyStatusV2({ now: NOW, observationDay: latest?.tradingDay ?? null, currency: target.currency, plan: riskPlan }, usage()), gaps: [], ...overrides,
  };
}

function listRow(item: LedgerTrade): TradeListRow {
  const at = item.entered_at ?? item.created_at;
  return {
    id: item.id, href: `/trades/${item.id}`, trade: item, tradeAt: at, tradeDay: at.slice(0, 10), tradeDateSource: "ENTRY",
    account: { id: item.account_id, name: "FTMO 100K", currency: item.currency, status: "ACTIVE" }, state: deriveTradeState(item, { now: NOW, checkCurrent: false }),
    thumbnail: null, ai: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null },
  };
}

const dashboardTrades = [
  closedTrade(FTMO, "2026-10-14T15:00:00Z", "1.5", "750", { entry_model: "OB_FIRST_TOUCH" }),
  closedTrade(FTMO, "2026-10-20T15:00:00Z", "-1", "-500"),
  closedTrade(FTMO, "2026-10-22T15:00:00Z", "2", "1000", { symbol: "GBPUSD", direction: "SHORT" }),
  // Live-first, closed, entry time unknown and no risk recorded: no R, no session.
  closedTrade(FTMO, "2026-10-21T15:00:00Z", null, "-120", { origin: "LIVE_FIRST", plan_id: null, locked_at: null, entered_at: null, entry_time_known: false, requested_risk_percent: null }),
];
const liveTrade = trade({ origin: "LIVE_FIRST", lifecycle: "LIVE", entered_at: "2026-10-23T17:30:00Z", entry_recorded_at: "2026-10-23T17:31:00Z", entry_price: "1.1", symbol: "XAUUSD" });

function dashboardFixture(options: { latest?: WorkspaceObservation | null; target?: ContextAccount; workspace?: Partial<AccountWorkspace> } = {}): AccountDashboard {
  const target = options.target ?? ftmo;
  const latest = options.latest === undefined ? observation(TODAY) : options.latest;
  const closed = dashboardTrades.filter(isClosed);
  const drill = { base: {}, account: target.id };
  const names = { [target.id]: target.name };
  return {
    account: target,
    now: NOW,
    metrics: metricsFor(target, [...dashboardTrades, liveTrade], latest),
    connection: MANUAL,
    workspace: workspace(target, latest, options.workspace),
    balanceCurve: balanceCurve(target.startingBalance, closed),
    curve: equityCurveR(closed),
    drawdown: drawdownSeries(closed),
    daily: dailySeries(closed).map(point => ({ ...point, href: closedOnHref(point.day, drill) })),
    calendar: linkedCalendar(closed, "2026-10", "NET_R", drill),
    recentTrades: [liveTrade, ...dashboardTrades].map(listRow),
    liveTrades: [listRow(liveTrade)],
    breakdowns: {
      model: breakdown(closed, "model", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
      session: breakdown(closed, "session", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
    },
    riskPlans: riskPlanTimeline(PLANS, TODAY),
    links: { journal: journalHref({}, { account: target.id }), edge: `/edge?account=${target.id}`, manage: `/accounts/${target.id}/manage` },
    truncated: false,
  };
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { provider: "CTRADER", name: "cTrader", available: false, note: "Read-only sync planned for V2.1" },
  { provider: "MT5", name: "MetaTrader 5", available: false, note: "Bridge planned for V2.2" },
];
const MOCK_OPTION: PlatformOption = { provider: "MOCK", name: "Mock platform", available: true, note: "Developer simulation with sample positions; never contacts a real platform." };

function manageFixture(overrides: Partial<AccountManage> = {}): AccountManage {
  const plans = riskPlanTimeline(PLANS, TODAY);
  const active = plans.find(item => item.status === "ACTIVE") ?? null;
  return {
    account: ftmo,
    now: NOW,
    day: TODAY,
    startingBalance: "100000",
    profileHistory: [
      { recordedAt: "2026-10-01T12:00:00Z", name: "FTMO 100K", broker: "FTMO", platform: "MT5", type: "EVALUATION", startingBalance: "100000", status: "ACTIVE", source: "USER" },
      { recordedAt: "2026-07-23T12:00:00Z", name: "FTMO Challenge", broker: null, platform: "MANUAL", type: "DEMO", startingBalance: "100000", status: "ACTIVE", source: "MIGRATION" },
    ],
    values: { latest: observation("2026-10-22"), confirmedToday: false, history: [observation("2026-10-22"), observation("2026-10-21", "100500", "100500")] },
    externalLosses: {
      today: [
        { id: "a2000000-0000-4000-8000-000000000001", tradingDay: TODAY, amount: "75", note: "cTrader scalp", recordedAt: "2026-10-23T14:00:00Z", removedAt: null, removalReason: null },
        { id: "a2000000-0000-4000-8000-000000000002", tradingDay: TODAY, amount: "40", note: null, recordedAt: "2026-10-23T13:00:00Z", removedAt: "2026-10-23T13:30:00Z", removalReason: "Entered twice" },
      ],
      recent: [
        { id: "a2000000-0000-4000-8000-000000000001", tradingDay: TODAY, amount: "75", note: "cTrader scalp", recordedAt: "2026-10-23T14:00:00Z", removedAt: null, removalReason: null },
        { id: "a2000000-0000-4000-8000-000000000003", tradingDay: "2026-10-20", amount: "120.5", note: "MT4 account", recordedAt: "2026-10-20T14:00:00Z", removedAt: null, removalReason: null },
      ],
      todayTotal: "75",
    },
    riskPlans: plans,
    activeRiskPlan: active,
    strategy: { version: "ICT V1.0", minimumRR: "3", warning: minimumRrWarning(active?.minRR ?? null, "3") },
    instruments: [
      { ...INSTRUMENT, createdAt: "2026-10-01T12:00:00Z", current: true },
      { ...INSTRUMENT, id: "f1000000-0000-4000-8000-000000000002", symbol: "GBPUSD", createdAt: "2026-09-01T12:00:00Z", current: true },
      { ...INSTRUMENT, id: "f1000000-0000-4000-8000-000000000003", tickValue: "0.9", createdAt: "2026-07-23T12:00:00Z", current: false },
    ],
    connection: MANUAL,
    platformOptions: PLATFORM_OPTIONS,
    archived: false,
    ...overrides,
  };
}

function manageView(tab: ManageViewProps["tab"], props: Partial<ManageViewProps> = {}) {
  return render(createElement(ManageView, { manage: manageFixture(), display: STRATEGY, tab, connection: null, instrumentDraft: null, ...props }));
}

const execution = (n: number, overrides: Partial<ExternalExecution> = {}): ExternalExecution => ({
  id: `a3000000-0000-4000-8000-00000000000${n}`, accountId: FTMO, connectionId: "a4000000-0000-4000-8000-000000000001", provider: "MOCK", connectionLabel: "Mock platform",
  externalId: `POS-${n}`, symbol: "EURUSD", direction: "LONG", volume: "0.5", entryPrice: "1.08512", enteredAt: "2026-10-22T13:00:00Z", exitPrice: null, exitedAt: null,
  commission: null, swap: null, realizedPnl: null, currency: "USD", payloadHash: "f".repeat(64), receivedAt: "2026-10-22T13:05:00Z", closeReceivedAt: null,
  linkedTradeId: null, linkMethod: null, linkedAt: null, warningCount: 0, lastWarningMessage: null, lastWarningAt: null, ...overrides,
});

beforeEach(() => {
  for (const fn of [
    m.overview, m.dashboard, m.manage, m.connection, m.context, m.push, m.refresh, m.ledgerRows, m.workspace, m.ledgerPage, m.decorate, ...Object.values(m.actions),
    ...Object.values(m.connectionActions),
  ]) fn.mockReset();
  m.context.mockResolvedValue(resolveAccountContext({ accounts: [ftmo, demo, personal, archived], stored: "all", lastAccount: null, proxyNotice: false }));
  m.pathname = "/accounts/new";
});

// ---------------------------------------------------------------------------------------------------------------------
// Accounts workspace (§14.7).
// ---------------------------------------------------------------------------------------------------------------------
describe("Accounts workspace", () => {
  it("lists each account with recorded values, today, month, cumulative R, trades and status, without raw ids or codes", () => {
    const markup = render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY }));
    const text = visibleText(markup);
    expectClean(markup);
    for (const header of ["Account", "Platform", "Currency", "Recorded balance", "Today", "This month", "Cumulative R", "Trades", "Status"]) expect(text).toContain(header);
    expect(text).toContain("FTMO 100K");
    expect(text).toContain("Evaluation · FTMO");
    expect(text).toContain("MetaTrader 5");
    expect(text).toContain("Manual");
    expect(text).toContain("$101,000.00");
    expect(text).toContain("Equity $100,950.00 · recorded today");
    // Demo's values are from an earlier day: the date is shown, never "today".
    expect(text).toContain("recorded Oct 16");
    expect(text).toContain("+$1,000.00");
    expect(text).toContain("+2.00R");
    expect(text).toContain("1 live");
    expect(markup).toContain(`href="/accounts/${FTMO}?account=${FTMO}"`);
  });

  it("opens an active account's dashboard as the context (never prefetched, loaded in full when it switches); an archived one keeps the context", () => {
    const markup = render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY }));
    const links = [...markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(match => [decode(match[2]), decode(match[1])]);
    // Desktop rows and phone cards.
    for (const target of [ftmo, demo, personal]) expect(links.filter(([name]) => name === target.name).map(([, href]) => href)).toEqual(Array(2).fill(`/accounts/${target.id}?account=${target.id}`));
    expect(links.filter(([name]) => name === "Old challenge").map(([, href]) => href)).toEqual([`/accounts/${OLD}`, `/accounts/${OLD}`]);
    expect(accountDashboardHref({ id: DEMO, status: "ACTIVE" })).toBe(`/accounts/${DEMO}?account=${DEMO}`);
    expect(accountDashboardHref({ id: OLD, status: "ARCHIVED" })).toBe(`/accounts/${OLD}`);
    expect(prefetchFor(accountDashboardHref(demo), undefined)).toBe(false);
    // From All Accounts (this overview's context) the click loads the dashboard in full, so the header names the account.
    expect(contextSwitchTarget(accountDashboardHref(demo), "all", "http://127.0.0.1:3000/accounts")).toBe(`http://127.0.0.1:3000/accounts/${DEMO}?account=${DEMO}`);
    expect(contextSwitchTarget(accountDashboardHref(demo), DEMO, "http://127.0.0.1:3000/accounts")).toBeNull();
  });

  it("shows “—” with the reason for an account whose trades could not all be read, and in every total that would include it (never a partial sum)", () => {
    const active = [summary(ftmo, overviewTrades, observation(TODAY), false), summary(demo, overviewTrades, observation("2026-10-16", "100400", "100380")), summary(personal, overviewTrades, null)];
    const overview: AccountsOverview = { ...overviewFixture([ftmo, demo, personal]), active, archived: [], totals: accountCurrencyTotals(active.map(item => item.metrics)) };
    const markup = render(createElement(AccountsOverviewView, { overview, display: STRATEGY }));
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("Some results are not added up");
    expect(text).toContain(`FTMO 100K has more than ${MAX_LEDGER_ROWS.toLocaleString("en-US")} trades, more than this page can add up.`);
    // FTMO's Today, This month, Cumulative R and Trades, in its table row and its phone card.
    expect(count(markup, `aria-label="Not known. ${UNKNOWN_REASONS.tooManyTrades}"`)).toBe(8);
    // Total USD's Today and This month and the combined R, in the table footer and the phone totals card.
    expect(count(markup, `aria-label="Not known. ${UNKNOWN_REASONS.tooManyTradesTotal}"`)).toBe(6);
    // FTMO's +$1,000.00 today (part of its trades) appears nowhere, alone or in a total; what was recorded, and Demo, stay.
    expect(text).not.toContain("+$1,000.00");
    expect(text).toContain("$101,000.00");
    expect(text).toContain("+$400.00");
    expect(combinedR(active.map(item => item.metrics))).toEqual({ netR: { value: null, unknownReason: UNKNOWN_REASONS.tooManyTradesTotal }, excluded: 0 });
    // Without such an account there is no notice.
    expect(visibleText(render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY })))).not.toContain("Some results are not added up");
  });

  it("totals money only within a currency shared by several accounts and adds R across accounts with its label", () => {
    const markup = render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY }));
    const text = visibleText(markup);
    expect(text).toContain("Total USD · 2 accounts");
    // Personal is the only EUR account: a total would repeat its row.
    expect(text).not.toContain("Total EUR");
    // FTMO +$1,000.00 today, Demo nothing today.
    expect(text).toMatch(/Total USD · 2 accounts Not added up \+\$1,000\.00 \+\$900\.00/);
    expect(text).toContain("All active accounts");
    expect(text).toContain(R_UNITS_NOTE);
    // +1R (FTMO) + 1R (Demo).
    expect(text).toContain("+2.00R");
    expect(count(text, "Total USD")).toBe(2);
  });

  it("shows unknown values as a dash with the reason, never an estimate", () => {
    const markup = render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY }));
    expect(markup).toContain('aria-label="Not known. No account values have been recorded yet."');
    expect(markup).toContain('aria-label="Not known. No closed trades with a recorded risk yet."');
  });

  it("keeps archived accounts in a collapsed group with Restore", () => {
    const markup = render(createElement(AccountsOverviewView, { overview: overviewFixture(), display: STRATEGY }));
    const details = /<details\b([^>]*)>([\s\S]*?)<\/details>/.exec(markup);
    expect(details).not.toBeNull();
    expect(details?.[1]).not.toMatch(/\bopen\b/);
    expect(visibleText(details?.[2] ?? "")).toContain("Archived accounts · 1");
    expect(visibleText(details?.[2] ?? "")).toContain("Old challenge");
    expect(markup).toContain('aria-label="Actions for Old challenge"');
    expect(visibleText(markup.replace(/<details[\s\S]*<\/details>/, ""))).not.toContain("Old challenge");
  });

  it("explains the empty workspace and offers New account", () => {
    const empty: AccountsOverview = { ...overviewFixture([]), active: [], archived: [], totals: [] };
    const markup = render(createElement(AccountsOverviewView, { overview: empty, display: STRATEGY }));
    const text = visibleText(markup);
    expect(text).toContain("No trading accounts yet.");
    expect(text).toContain("Create your first trading account");
    expect(count(markup, 'href="/accounts/new"')).toBe(2);
  });

  it("names the connection state in words", () => {
    expect(connectionLabel(MANUAL, STRATEGY)).toBe("Manual");
    expect(connectionLabel({ mode: "SYNCED", connection: null, lastSyncedAt: "2026-10-23T14:42:00Z", message: null }, STRATEGY)).toBe("Last synced Oct 23, 09:42");
    expect(connectionLabel({ mode: "ERROR", connection: null, lastSyncedAt: null, message: "Down" }, STRATEGY)).toBe("Sync error");
  });

  it("renders the page from the overview loader", async () => {
    m.overview.mockResolvedValue(overviewFixture());
    const markup = render(await AccountsPage());
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(visibleText(markup)).toContain("Active accounts");
    expectClean(markup);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// New account (§3.2, §14.12).
// ---------------------------------------------------------------------------------------------------------------------
describe("New trading account", () => {
  it("offers every create field, the currency allow-list and the default plan in words", () => {
    const markup = render(createElement(CreateAccountForm));
    const text = visibleText(markup);
    for (const name of ["name", "accountType", "currency", "broker", "platform", "balance", "startingBalance"]) expect(markup).toContain(`name="${name}"`);
    expect(markup).not.toContain('name="equity"');
    expect(text).toContain("Equity equals balance");
    expect(count(markup, "<option")).toBe(5 + 18 + 6);
    expect(markup).toContain('<option value="JPY">JPY — Japanese yen</option>');
    expect(text).toContain(DEFAULT_PLAN_NOTE);
    expect(text).toContain("Create trading account");
    expect(text).not.toMatch(ENUM);
    expect(m.actions.createTradingAccount).not.toHaveBeenCalled();
  });

  it("is a page with one heading, the form and what happens next", () => {
    const markup = render(NewAccountPage());
    const text = visibleText(markup);
    expect(text).toContain("New trading account");
    expect(text).toContain("After you create it");
    expect(text).toContain("Create trading account");
    expectClean(markup);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Account dashboard (§14.8).
// ---------------------------------------------------------------------------------------------------------------------
describe("Account dashboard", () => {
  const view = (dashboard: AccountDashboard, mode: "NET_R" | "NET_PNL" = "NET_R") =>
    render(createElement(AccountDashboardView, { dashboard, display: STRATEGY, month: "2026-10", mode, currentContext: "all" }));
  const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map(match => decode(match[1]));

  it("shows the value cards with the exact Balance from trades label and never calls it equity", () => {
    const markup = view(dashboardFixture());
    const text = visibleText(markup);
    expectClean(markup);
    for (const label of ["Recorded balance", "Recorded equity", "Starting balance", "Realized P&L", "Balance from trades"]) expect(text).toContain(label);
    expect(text).toContain(BALANCE_FROM_TRADES_LABEL);
    // 750 - 500 + 1000 - 120.
    expect(text).toContain("+$1,130.00");
    expect(text).toContain("$101,130.00");
    const stat = text.slice(text.indexOf("Balance from trades"), text.indexOf("Results"));
    expect(stat).not.toMatch(/equity/i);
    expect(text).toContain("Recorded today");
  });

  it("charts balance from trades, cumulative R, R drawdown and daily P&L with drill-downs to trades and days", () => {
    const dashboard = dashboardFixture();
    const markup = view(dashboard);
    const text = visibleText(markup);
    for (const title of ["Balance from trades", "Cumulative R", "R drawdown", "Daily P&L", "Calendar"]) expect(text).toContain(title);
    for (const question of ["Is the process compounding?", "Where am I giving profits back?", "Which days drive results?", "When am I winning or losing?"]) expect(text).toContain(question);
    // Points open their trade; days open the Journal of that day, switching to this account.
    expect(markup).toContain(`href="/trades/${dashboardTrades[0].id}"`);
    expect(markup).toMatch(/href="\/journal\?closedFrom=2026-10-20&amp;closedTo=2026-10-20[^"]*account=a1000000-0000-4000-8000-000000000001"/);
    expect(text).toContain("3 trades with R · 1 without recorded risk not shown");
    // The calendar mode switch keeps the month.
    expect(markup).toContain(`href="/accounts/${FTMO}?month=2026-10&amp;mode=net-pnl#calendar"`);
  });

  it("lists live and recent trades, model and session groups and the risk plan history", () => {
    const markup = view(dashboardFixture());
    const text = visibleText(markup);
    expect(text).toContain("XAUUSD · Long");
    expect(text).toContain("Live-first");
    expect(text).toContain("Open 1h 30m");
    expect(text).toContain("GBPUSD · Short");
    expect(text).toContain("OB first touch");
    expect(text).toContain("Kill zone");
    expect(text).toContain("Entry time not recorded");
    expect(text).toContain("Risk Plan V1.1");
    expect(text).toContain("Starts tomorrow");
    expect(text).toContain("Earlier versions · 1");
    expect(markup).toContain(`href="${manageHref(FTMO, "risk-policy")}"`);
  });

  it("puts the next action first: confirm unchanged values when today's balance is missing", () => {
    const stale = view(dashboardFixture({ latest: observation("2026-10-22") }));
    const text = visibleText(stale);
    expect(text).toContain("Today on this account");
    expect(text).toContain(CONFIRM_UNCHANGED);
    expect(text).toContain("Enter new values");
    expect(text).toContain("Recorded Oct 22");
    expect(stale).toContain(`href="${manageHref(FTMO, "account-values")}"`);
    const fresh = visibleText(view(dashboardFixture()));
    expect(fresh).not.toContain(CONFIRM_UNCHANGED);
    expect(fresh).toContain("Balance confirmed today");
  });

  it("states archived accounts and missing instruments in words, with their action", () => {
    const archivedView = visibleText(view(dashboardFixture({ target: { ...ftmo, status: "ARCHIVED" } })));
    expect(archivedView).toContain("This account is archived.");
    expect(archivedView).toContain("Restore in Manage");
    expect(archivedView).not.toContain("Today on this account");
    const noInstruments = view(dashboardFixture({ workspace: { instruments: [], gaps: ["INSTRUMENTS"] } }));
    expect(visibleText(noInstruments)).toContain("No instruments yet.");
    expect(noInstruments).toContain(`href="${manageHref(FTMO, "instruments")}"`);
  });

  it("replaces empty charts with one explanation while no trade is closed, and offers Plan Trade and Record Live Trade once", () => {
    const empty: AccountDashboard = {
      ...dashboardFixture(), metrics: metricsFor(ftmo, [], observation(TODAY)), balanceCurve: balanceCurve("100000", []), curve: equityCurveR([]), drawdown: [], daily: [],
      recentTrades: [], liveTrades: [], breakdowns: { model: [], session: [] },
    };
    const markup = view(empty);
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("No closed trades on this account yet.");
    for (const title of ["Cumulative R", "R drawdown", "Daily P&L", "When am I winning or losing?", "Recent trades", "Results"]) expect(text).not.toContain(title);
    // The header's pair plans on this account; the explanation does not repeat it.
    expect(count(markup, `href="/trades/new?account=${FTMO}"`)).toBe(1);
    expect(count(markup, `href="/trades/live/new?account=${FTMO}"`)).toBe(1);
    expect(count(text, "Plan Trade")).toBe(1);
    expect(count(text, "Record Live Trade")).toBe(1);
    const explanation = /<section[^>]*aria-labelledby="no-results"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(visibleText(explanation)).toContain("appear after the first trade is closed");
    expect(explanation).not.toContain("<a ");
    // An archived account offers no new trade.
    const archivedEmpty = view({ ...empty, account: { ...ftmo, status: "ARCHIVED" } });
    expect(archivedEmpty).not.toContain("/trades/new");
    expect(archivedEmpty).not.toContain("/trades/live/new");
  });

  it("never estimates balance from trades without a starting balance", () => {
    const target = { ...ftmo, startingBalance: null };
    const text = visibleText(view(dashboardFixture({ target })));
    expect(text).toContain("Needs a starting balance.");
    expect(text).toContain("Trading OS does not estimate one.");
  });

  it("puts live trades right under today's status while any are open, and says what today's counts are", () => {
    const markup = view(dashboardFixture());
    const text = visibleText(markup);
    expect(count(markup, 'id="live-trades"')).toBe(1);
    const at = (needle: string) => markup.indexOf(needle);
    // Today → Live trades → Account values → charts → calendar → recent trades.
    expect(at('id="account-today"')).toBeLessThan(at('id="live-trades"'));
    expect(at('id="live-trades"')).toBeLessThan(at('id="account-values-heading"'));
    expect(at('id="account-values-heading"')).toBeLessThan(at('id="account-charts"'));
    expect(at('id="calendar"')).toBeLessThan(at('id="recent-trades"'));
    expect(text).toContain("Live trades Open a trade to add to its journal or close it. 1 live XAUUSD · Long");
    expect(text).toContain("Used today: 1 planned · 0 recorded live");
    // Without live trades the card keeps its place next to Recent trades and says so.
    const quiet = view({ ...dashboardFixture(), liveTrades: [] });
    expect(quiet.indexOf('id="live-trades"')).toBeGreaterThan(quiet.indexOf('id="calendar"'));
    expect(visibleText(quiet)).toContain("No live trades on this account.");
  });

  it("never links to a switch to an archived account: its history opens in All Accounts with the read-only account filter", () => {
    const active = hrefs(view(dashboardFixture()));
    // An active account's Journal, EDGE and day drill-downs switch the context to it.
    expect(active.filter(href => href.includes(`account=${FTMO}`)).length).toBeGreaterThanOrEqual(5);
    expect(active.some(href => href.includes("accountFilter="))).toBe(false);
    const markup = view(dashboardFixture({ target: { ...ftmo, status: "ARCHIVED" } }));
    const text = visibleText(markup);
    expectClean(markup);
    const links = hrefs(markup);
    // Every context a link names is All Accounts: the archived account is never the context.
    const contexts = links.flatMap(href => new URL(href, "http://x").searchParams.getAll("account"));
    expect(contexts.length).toBeGreaterThanOrEqual(5);
    expect(new Set(contexts)).toEqual(new Set(["all"]));
    // Journal, EDGE, day and group drill-downs all carry the account filter, combined with All Accounts.
    const history = links.filter(href => href.startsWith("/journal") || href.startsWith("/edge"));
    expect(history.length).toBeGreaterThanOrEqual(5);
    for (const href of history) {
      const params = new URL(href, "http://x").searchParams;
      expect(params.get("accountFilter"), href).toBe(FTMO);
      expect(params.get("account"), href).toBe("all");
    }
    expect(links).toContain(`/journal?accountFilter=${FTMO}&account=all`);
    expect(links).toContain(`/edge?accountFilter=${FTMO}&account=all`);
    expect(links).toContain(`/journal?accountFilter=${FTMO}&closedFrom=2026-10-14&closedTo=2026-10-14&state=closed%2Creviewed&account=all`);
    expect(text).toContain(ARCHIVED_DASHBOARD_COPY);
    expect(ARCHIVED_DASHBOARD_COPY).not.toContain("restore it to filter");
    expect(text).toContain("All in Journal");
    expect(text).not.toContain("Update values");
    expect(markup).toContain('aria-label="Account links"');
    // Points still open their trades; days open the account's trades of that day.
    expect(links).toContain(`/trades/${dashboardTrades[0].id}`);
    expect(text).toContain("Click a point to open its trade, or a day to list its trades in the Journal.");
    // The empty state of an archived account offers no new trade, and no link switches to it.
    const empty = view({ ...dashboardFixture({ target: { ...ftmo, status: "ARCHIVED" } }), metrics: metricsFor(ftmo, [], null), recentTrades: [], liveTrades: [] });
    expect(hrefs(empty).some(href => href.includes("/trades/new") || href.includes("/trades/live/new"))).toBe(false);
    expect(hrefs(empty).flatMap(href => new URL(href, "http://x").searchParams.getAll("account")).every(value => value === "all")).toBe(true);
  });

  it("loads a link that switches to another trading-account context in full, so the header shows the new context", () => {
    const base = `http://127.0.0.1:3000/accounts/${FTMO}`;
    const journal = journalHref({}, { account: FTMO });
    expect(contextSwitchTarget(journal, "all", base)).toBe(`http://127.0.0.1:3000${journal}`);
    expect(contextSwitchTarget(`/trades/new?account=${FTMO.toUpperCase()}`, DEMO, base)).toBe(`http://127.0.0.1:3000/trades/new?account=${FTMO.toUpperCase()}`);
    expect(contextSwitchTarget("/journal?account=all", FTMO, base)).toBe("http://127.0.0.1:3000/journal?account=all");
    // Already the context: a client-side navigation keeps the right header.
    expect(contextSwitchTarget(journal, FTMO, base)).toBeNull();
    expect(contextSwitchTarget(`/journal?account=${FTMO.toUpperCase()}`, FTMO, base)).toBeNull();
    // Links that don't switch the context, and other sites, are left alone.
    expect(contextSwitchTarget(`/trades/${dashboardTrades[0].id}`, "all", base)).toBeNull();
    expect(contextSwitchTarget(dashboardHref(FTMO, "2026-09", "NET_PNL"), "all", base)).toBeNull();
    expect(contextSwitchTarget(`https://example.com/journal?account=${FTMO}`, "all", base)).toBeNull();
    expect(contextSwitchTarget("http://[bad", "all", base)).toBeNull();
  });

  it("parses calendar modes and builds month links", () => {
    expect(parseCalendarMode("net-pnl")).toBe("NET_PNL");
    expect(parseCalendarMode("loss")).toBe("GROSS_LOSS");
    expect(parseCalendarMode(["trades"])).toBe("COUNT");
    expect(parseCalendarMode("NET_PNL")).toBe("NET_R");
    expect(parseCalendarMode(undefined)).toBe("NET_R");
    expect(dashboardHref(FTMO, "2026-09", "NET_R")).toBe(`/accounts/${FTMO}?month=2026-09#calendar`);
    expect(recordedOn(TODAY, TODAY)).toBe("Recorded today");
    expect(recordedOn("2025-12-30", TODAY)).toBe("Recorded Dec 30, 2025");
  });

  it("loads the requested month and mode, and answers 404 for an account that isn't the user's", async () => {
    m.dashboard.mockResolvedValue(dashboardFixture());
    const markup = render(await AccountDashboardPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({ month: "2026-09", mode: "net-pnl" }) }));
    expect(m.dashboard).toHaveBeenCalledWith(FTMO, "2026-09", "NET_PNL");
    expect(m.context).toHaveBeenCalled();
    expectClean(markup);
    await AccountDashboardPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({ month: "2026-13" }) });
    expect(m.dashboard).toHaveBeenLastCalledWith(FTMO, expect.stringMatching(/^\d{4}-\d{2}$/), "NET_R");
    expect(m.dashboard.mock.lastCall?.[1]).not.toBe("2026-13");
    m.dashboard.mockResolvedValue(null);
    await expect(AccountDashboardPage({ params: Promise.resolve({ id: "elsewhere" }), searchParams: Promise.resolve({}) })).rejects.toThrow();
  });

  it("titles the page with the account name", async () => {
    expect(await dashboardMetadata({ params: Promise.resolve({ id: FTMO.toUpperCase() }) })).toEqual({ title: "FTMO 100K · Accounts · Trading OS" });
    expect(await dashboardMetadata({ params: Promise.resolve({ id: "unknown" }) })).toEqual({ title: "Account · Trading OS" });
  });

  it("plans and records live trades on the account on screen, whatever the header's context (§9.2, 60.11)", () => {
    const header = (markup: string) => /<header[\s\S]*?<\/header>/.exec(markup)?.[0] ?? "";
    for (const currentContext of ["all", DEMO]) {
      const markup = header(render(createElement(AccountDashboardView, { dashboard: dashboardFixture(), display: STRATEGY, month: "2026-10", mode: "NET_R", currentContext })));
      // Named as in the top bar and the forms they open.
      expect(visibleText(markup)).toContain("Plan Trade Record Live Trade Journal Manage");
      expect(markup).toContain(`href="/trades/new?account=${FTMO}"`);
      expect(markup).toContain(`href="/trades/live/new?account=${FTMO}"`);
      expect(markup).toContain('aria-label="Plan Trade on FTMO 100K"');
      expect(markup).toContain('aria-label="Record Live Trade on FTMO 100K"');
    }
    // From another context, following them loads the form in full with this account as the context.
    expect(contextSwitchTarget(`/trades/new?account=${FTMO}`, DEMO, `http://127.0.0.1:3000/accounts/${FTMO}`)).toBe(`http://127.0.0.1:3000/trades/new?account=${FTMO}`);
    // An archived account takes no new trades.
    const archivedHeader = header(view(dashboardFixture({ target: { ...ftmo, status: "ARCHIVED" } })));
    expect(archivedHeader).not.toContain("/trades/new");
    expect(archivedHeader).not.toContain("/trades/live/new");
  });

  it("says how many trades of a group, day or calendar day have no recorded risk next to their R (§9.3)", () => {
    const trades = [
      closedTrade(FTMO, "2026-10-20T15:00:00Z", "-1", "-500"),
      // Live-first, no risk recorded: in the day's and the group's P&L and counts, not in their R.
      closedTrade(FTMO, "2026-10-20T16:00:00Z", null, "-30", { origin: "LIVE_FIRST", plan_id: null, locked_at: null, requested_risk_percent: null }),
      closedTrade(FTMO, "2026-10-22T15:00:00Z", "2", "1000", { entry_model: "OB_FIRST_TOUCH" }),
    ];
    const drill = { base: {}, account: FTMO };
    const names = { [FTMO]: ftmo.name };
    const dashboard: AccountDashboard = {
      ...dashboardFixture(), metrics: metricsFor(ftmo, trades, observation(TODAY)), balanceCurve: balanceCurve("100000", trades), curve: equityCurveR(trades),
      drawdown: drawdownSeries(trades), daily: dailySeries(trades).map(point => ({ ...point, href: closedOnHref(point.day, drill) })),
      calendar: linkedCalendar(trades, "2026-10", "NET_R", drill),
      breakdowns: {
        model: breakdown(trades, "model", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
        session: breakdown(trades, "session", { accountNames: names }).map(group => ({ ...group, href: breakdownHref(group, drill) })),
      },
    };
    const text = visibleText(view(dashboard));
    // Groups: N and the evidence label count the trades with a recorded risk; the others are counted next to them.
    expect(text).toContain("OTE N = 1 · 1 without risk · Insufficient evidence");
    expect(text).toContain("OB first touch N = 1 · Insufficient evidence");
    expect(text).toContain("3 closed trades · N counts trades with recorded risk");
    expect(text).not.toMatch(/\d+ trades? · insufficient evidence/i);
    // Daily P&L: the bar is both trades' P&L, its R covers one of them.
    expect(text).toContain(`2 trades · ${formatR("-1")} (1 of 2 with risk)`);
    expect(text).toContain(`1 trade · ${formatR("2")}`);
    // Calendar (table view): the day's net R and how many of its closed trades have no risk.
    expect(text).toContain("2 closed trades · 1 without risk");
  });

  it("adds up every trade of the account or none: “—” with the reason and no result or chart from part of its trades", () => {
    const drill = { base: {}, account: FTMO };
    const dashboard: AccountDashboard = {
      ...dashboardFixture(), truncated: true, metrics: metricsFor(ftmo, dashboardTrades, observation(TODAY), false), balanceCurve: balanceCurve("100000", []),
      curve: equityCurveR([]), drawdown: drawdownSeries([]), daily: [], calendar: linkedCalendar([], "2026-10", "NET_R", drill), breakdowns: { model: [], session: [] },
    };
    const markup = view(dashboard);
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("More trades than this page can add up.");
    expect(text).toContain(`This account has more than ${MAX_LEDGER_ROWS.toLocaleString("en-US")} live and closed trades.`);
    for (const title of ["Results", "Performance", "Cumulative R", "R drawdown", "Daily P&L", "When am I winning or losing?", "Model and session", "No closed trades on this account yet."]) {
      expect(text).not.toContain(title);
    }
    expect(text).not.toContain("first 20,000");
    // Realized P&L and Balance from trades: "—" with the reason; what the trader recorded stays.
    expect(count(markup, `aria-label="Not known. ${UNKNOWN_REASONS.tooManyTrades}"`)).toBe(2);
    expect(text).not.toContain("+$1,130.00");
    expect(text).toContain("Recorded balance $101,000.00");
    // Recent and live trades are separate reads and stay; EDGE and the Journal show the trades for a date range.
    expect(text).toContain("Recent trades");
    expect(text).toContain("GBPUSD · Short");
    const links = hrefs(markup);
    expect(links).toContain(`/edge?account=${FTMO}`);
    expect(links).toContain(journalHref({}, { account: FTMO }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Loaders (§9.4): every trade of an account, or none of its trade figures.
// ---------------------------------------------------------------------------------------------------------------------
describe("Accounts loaders", () => {
  /** PostgREST double: every query of a table answers its rows (the reads the tests care about are mocked above). */
  function fakeDb(tables: Record<string, unknown[]> = {}) {
    const query = (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "gt", "not", "is", "order", "limit"]) chain[method] = () => chain;
      // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject);
      return chain;
    };
    return { from: query } as never;
  }
  /**
   * PostgREST double of the ledger reads, for the real loadLedgerRows: the account and lifecycle filters, the id keyset
   * and the page size it asks for, rows in id order. Every other table answers no rows. `ledgerEq` collects the columns
   * of every equality filter sent to the ledger.
   */
  function ledgerDb(rows: readonly LedgerTrade[], ledgerEq: string[] = []) {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const query = (table: string) => {
      const keep: ((row: LedgerTrade) => boolean)[] = [];
      let limit = Number.POSITIVE_INFINITY;
      const filter = (test: (row: LedgerTrade) => boolean) => {
        keep.push(test);
        return chain;
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: keyof LedgerTrade, value: unknown) => {
          if (table === "trade_ledger") ledgerEq.push(column);
          return filter(row => row[column] === value);
        },
        in: (column: keyof LedgerTrade, values: readonly unknown[]) => filter(row => values.includes(row[column])),
        gt: (column: keyof LedgerTrade, value: string) => filter(row => String(row[column]) > value),
        // The open-trade anti-joins (`is.null` on embedded outcomes and closes) of the dashboard's live list.
        is: () => chain,
        order: () => chain,
        limit: (count: number) => {
          limit = count;
          return chain;
        },
      };
      // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const data = table === "trade_ledger" ? sorted.filter(row => keep.every(test => test(row))).slice(0, limit) : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return chain;
    };
    return { from: query } as never;
  }
  const lifecycles = ["LIVE", "CLOSED", "REVIEWED"];
  /** One row more than the ledger read limit may be asked for: exactly MAX_LEDGER_ROWS trades are read in full. */
  const ledgerOptions = { lifecycles, maxRows: MAX_LEDGER_ROWS + 1 };
  const ofAccount = (accountId: string) => overviewTrades.filter(trade => trade.account_id === accountId);
  /** `count` closed trades of +1 each, ids ascending from `prefix`. */
  const bulkClosed = (accountId: string, prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => closedTrade(accountId, "2026-10-21T15:00:00Z", "1", "1", { id: `${prefix}${index.toString(16).padStart(7, "0")}-0000-4000-8000-000000000000` }));

  it("reads each account's trades on their own: one with more than a read holds has its figures and the totals with it unknown, the others stay known", async () => {
    m.ledgerRows.mockImplementation(async (_db: unknown, _user: string, scope: { mode: string; accountId?: string }) =>
      // A shared read would stop somewhere among every account's trades; FTMO alone has more than one read holds.
      scope.mode !== "account" ? { rows: overviewTrades.slice(0, 2), truncated: true }
        : scope.accountId === FTMO ? { rows: ofAccount(FTMO).slice(0, 1), truncated: true }
        : { rows: ofAccount(scope.accountId ?? ""), truncated: false },
    );
    const context = resolveAccountContext({ accounts: [ftmo, demo, personal, archived], stored: "all", lastAccount: null, proxyNotice: false });
    const overview = await loadAccountsOverview(fakeDb(), "user", context, NOW);
    expect(m.ledgerRows.mock.calls.map(call => (call[2] as { accountId: string }).accountId).sort()).toEqual([FTMO, DEMO, PERSONAL, OLD].sort());
    for (const call of m.ledgerRows.mock.calls) {
      expect(call[2]).toMatchObject({ mode: "account" });
      expect(call[4]).toEqual(ledgerOptions);
    }
    const byId = new Map([...overview.active, ...overview.archived].map(item => [item.account.id, item] as const));
    expect(byId.get(FTMO)?.metrics).toMatchObject({ tradesUnknown: UNKNOWN_REASONS.tooManyTrades, realizedPnl: null, todayPnl: null, monthPnl: null, closedCount: null, openCount: null });
    expect(byId.get(FTMO)?.metrics.cumulativeR).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.tooManyTrades });
    expect(byId.get(FTMO)?.metrics.balanceFromTrades).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.tooManyTrades });
    expect(byId.get(DEMO)?.metrics).toMatchObject({ tradesUnknown: null, realizedPnl: "400", todayPnl: "0", monthPnl: "400", closedCount: 1, openCount: 1 });
    expect(overview.totals).toEqual([
      { currency: "EUR", accounts: 1, realizedPnl: "0", todayPnl: "0", monthPnl: "0" },
      { currency: "USD", accounts: 2, realizedPnl: null, todayPnl: null, monthPnl: null },
    ]);
    // Opening an active account makes it the context; an archived one never can be.
    expect(byId.get(DEMO)?.href).toBe(`/accounts/${DEMO}?account=${DEMO}`);
    expect(byId.get(OLD)?.href).toBe(`/accounts/${OLD}`);
  });

  it("draws no result or chart from part of an account's trades, and still lists its recent trades", async () => {
    const partial = [closedTrade(FTMO, "2026-10-23T15:00:00Z", "2", "100"), closedTrade(FTMO, "2026-10-20T15:00:00Z", "-1", "-40")];
    m.ledgerRows.mockResolvedValue({ rows: partial, truncated: true });
    m.workspace.mockResolvedValue(workspace(ftmo, observation(TODAY)));
    m.ledgerPage.mockResolvedValue({ rows: dashboardTrades, nextCursor: null, scanned: dashboardTrades.length });
    m.decorate.mockImplementation(async (_deps: unknown, rows: LedgerTrade[]) => rows.map(listRow));
    const context = resolveAccountContext({ accounts: [ftmo, demo], stored: "all", lastAccount: null, proxyNotice: false });
    const dashboard = await loadAccountDashboard(fakeDb(), "user", context, ftmo, NOW);
    expect(m.ledgerRows).toHaveBeenCalledWith(expect.anything(), "user", { mode: "account", accountId: FTMO }, {}, ledgerOptions);
    expect(dashboard.truncated).toBe(true);
    expect(dashboard.metrics).toMatchObject({ tradesUnknown: UNKNOWN_REASONS.tooManyTrades, realizedPnl: null, todayPnl: null, closedCount: null });
    expect(dashboard.metrics.balanceFromTrades).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.tooManyTrades });
    expect([...dashboard.curve, ...dashboard.drawdown, ...(dashboard.balanceCurve ?? [])].filter(point => point.tradeId !== null)).toEqual([]);
    expect(dashboard.daily).toEqual([]);
    expect(dashboard.calendar.closed).toBe(0);
    expect(dashboard.breakdowns).toEqual({ model: [], session: [], customModel: [] });
    expect(dashboard.recentTrades).toHaveLength(dashboardTrades.length);
    // Complete reads keep every figure and series.
    m.ledgerRows.mockResolvedValue({ rows: partial, truncated: false });
    const complete = await loadAccountDashboard(fakeDb(), "user", context, ftmo, NOW);
    expect(complete.metrics).toMatchObject({ tradesUnknown: null, realizedPnl: "60", closedCount: 2 });
    expect(complete.daily).toHaveLength(2);
  });

  it("adds up an account with exactly MAX_LEDGER_ROWS trades in full; one more is “more than 20,000”, even when read whole", async () => {
    // The real keyset read (500-row pages) over the double: 20,000 rows fill 40 pages, the 20,001st is on a 41st page.
    const { loadLedgerRows } = await vi.importActual<typeof import("@/lib/performance-data")>("@/lib/performance-data");
    m.ledgerRows.mockImplementation(loadLedgerRows);
    const exact = bulkClosed(FTMO, "e", MAX_LEDGER_ROWS);
    const more = bulkClosed(DEMO, "f", MAX_LEDGER_ROWS + 1);
    const context = resolveAccountContext({ accounts: [ftmo, demo], stored: "all", lastAccount: null, proxyNotice: false });
    const overview = await loadAccountsOverview(ledgerDb([...exact, ...more]), "user", context, NOW);
    const [ftmoSummary, demoSummary] = overview.active;
    expect(ftmoSummary.metrics).toMatchObject({ tradesUnknown: null, closedCount: MAX_LEDGER_ROWS, realizedPnl: String(MAX_LEDGER_ROWS), rTrades: MAX_LEDGER_ROWS });
    expect(ftmoSummary.metrics.cumulativeR).toEqual({ value: String(MAX_LEDGER_ROWS), unknownReason: null });
    expect(demoSummary.metrics).toMatchObject({ tradesUnknown: UNKNOWN_REASONS.tooManyTrades, closedCount: null, realizedPnl: null });
    expect(overview.totals).toEqual([{ currency: "USD", accounts: 2, realizedPnl: null, todayPnl: null, monthPnl: null }]);
    // The notice names only the account that does have more than 20,000 trades.
    const text = visibleText(render(createElement(AccountsOverviewView, { overview, display: STRATEGY })));
    expect(text).toContain(`Demo 100K has more than ${MAX_LEDGER_ROWS.toLocaleString("en-US")} trades`);
    expect(text).not.toContain("FTMO 100K has more than");
    // The dashboard of the account at the limit adds up and draws every trade; the one above it neither.
    m.workspace.mockResolvedValue(workspace(ftmo, observation(TODAY)));
    m.ledgerPage.mockResolvedValue({ rows: [], nextCursor: null, scanned: 0 });
    m.decorate.mockResolvedValue([]);
    const ledgerEq: string[] = [];
    const atLimit = await loadAccountDashboard(ledgerDb(exact, ledgerEq), "user", context, ftmo, NOW);
    // The live list comes from the open trades' keys: no ledger read filters on the lifecycle the view derives per row.
    expect(ledgerEq).not.toContain("lifecycle");
    expect(atLimit.truncated).toBe(false);
    expect(atLimit.metrics).toMatchObject({ tradesUnknown: null, closedCount: MAX_LEDGER_ROWS });
    expect(atLimit.curve).toHaveLength(MAX_LEDGER_ROWS + 1);
    const above = await loadAccountDashboard(ledgerDb(more), "user", context, demo, NOW);
    expect(above.truncated).toBe(true);
    expect(above.metrics).toMatchObject({ tradesUnknown: UNKNOWN_REASONS.tooManyTrades, closedCount: null });
    expect(above.curve.filter(point => point.tradeId !== null)).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Risk plan versions (§3.10 precedence, §14.9 labels).
// ---------------------------------------------------------------------------------------------------------------------
describe("Risk plan history", () => {
  const c9 = [
    plan("e2000000-0000-4000-8000-000000000001", "Risk Plan V1.0", "2026-10-01T12:00:00Z", "2026-10-01"),
    // A loosening scheduled for Oct 30 on Oct 29...
    plan("e2000000-0000-4000-8000-000000000002", "Risk Plan V1.1", "2026-10-29T15:00:00Z", "2026-10-30", { maxRiskPercent: "1" }),
    // ...then an immediate tightening the same day: the loosening never applies on any day (private.active_risk_plan).
    plan("e2000000-0000-4000-8000-000000000003", "Risk Plan V1.2", "2026-10-29T16:00:00Z", "2026-10-29", { maxRiskPercent: "0.5", overrideReason: "Two full losses" }),
  ];
  const labels = (plans: WorkspaceRiskPlan[], day: string) => riskPlanTimeline(plans, day).map(item => `${item.version}: ${item.statusLabel}`);

  it("labels a version a later change overtook “Replaced before it started” on every day, also once its own day has come (C9)", () => {
    for (const day of ["2026-10-29", "2026-10-30", "2026-10-31", "2027-01-04"]) {
      expect(labels(c9, day), day).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced before it started", "Risk Plan V1.0: Replaced"]);
    }
    // The dashboard's earlier versions say so after the loosening's day.
    const markup = render(createElement(AccountDashboardView, { dashboard: { ...dashboardFixture(), riskPlans: riskPlanTimeline(c9, "2026-10-31") }, display: STRATEGY, month: "2026-10", mode: "NET_R", currentContext: "all" }));
    expect(visibleText(markup)).toContain("Earlier versions · 2");
    expect(visibleText(markup)).toContain("Replaced before it started");
  });

  it("orders versions created at the same instant by id, as the database does (created_at desc, id desc)", () => {
    const sameInstant = { ...c9[1], createdAt: c9[2].createdAt };
    expect(labels([c9[0], sameInstant, c9[2]], "2026-10-29")).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced before it started", "Risk Plan V1.0: Replaced"]);
    // With the higher id the loosening is the newer version: it takes effect on its day and the tightening was in effect before it.
    const newerById = { ...sameInstant, id: "e2000000-0000-4000-8000-000000000009" };
    expect(labels([c9[0], newerById, c9[2]], "2026-10-29")).toEqual(["Risk Plan V1.1: Starts tomorrow", "Risk Plan V1.2: Active", "Risk Plan V1.0: Replaced"]);
    expect(labels([c9[0], newerById, c9[2]], "2026-10-30")).toEqual(["Risk Plan V1.1: Active", "Risk Plan V1.2: Replaced", "Risk Plan V1.0: Replaced"]);
  });

  it("keeps the labels of versions that did take effect", () => {
    // V1.1 took effect on Oct 2 and was replaced by V1.2 on Oct 24; before that, V1.2 starts tomorrow.
    expect(labels(PLANS, TODAY)).toEqual(["Risk Plan V1.2: Starts tomorrow", "Risk Plan V1.1: Active", "Risk Plan V1.0: Replaced"]);
    expect(labels(PLANS, "2026-10-24")).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced", "Risk Plan V1.0: Replaced"]);
  });

  it("says “Replaced” of a version replaced during its own first day: it governed the checks made before that (60.20)", () => {
    const start = plan("e3000000-0000-4000-8000-000000000001", "Risk Plan V1.0", "2026-10-01T12:00:00Z", "2026-10-01");
    // Two immediate changes on Oct 31, at 09:00 and 11:00 UTC−5: a plan locked between them keeps V1.1.
    const first = plan("e3000000-0000-4000-8000-000000000002", "Risk Plan V1.1", "2026-10-31T14:00:00Z", "2026-10-31", { overrideReason: "First full loss" });
    const second = plan("e3000000-0000-4000-8000-000000000003", "Risk Plan V1.2", "2026-10-31T16:00:00Z", "2026-10-31", { overrideReason: "Second full loss" });
    for (const day of ["2026-10-31", "2026-11-01", "2027-01-04"]) {
      expect(labels([start, first, second], day), day).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced", "Risk Plan V1.0: Replaced"]);
    }
    // An immediate change on the day the account was created: the first version governed the checks before it.
    const created = plan("e3000000-0000-4000-8000-000000000004", "Risk Plan V1.0", "2026-10-31T13:00:00Z", "2026-10-31");
    expect(labels([created, first], "2026-10-31")).toEqual(["Risk Plan V1.1: Active", "Risk Plan V1.0: Replaced"]);
    // A version scheduled for Nov 2 and replaced at 09:00 UTC−5 that day governed the first nine hours of its day.
    const scheduled = plan("e3000000-0000-4000-8000-000000000005", "Risk Plan V1.1", "2026-10-31T15:00:00Z", "2026-11-02", { maxRiskPercent: "1" });
    const midday = plan("e3000000-0000-4000-8000-000000000006", "Risk Plan V1.2", "2026-11-02T14:00:00Z", "2026-11-02", { overrideReason: "Tighten after a loss" });
    expect(labels([start, scheduled], "2026-11-01")).toEqual(["Risk Plan V1.1: Starts tomorrow", "Risk Plan V1.0: Active"]);
    for (const day of ["2026-11-02", "2026-11-03"]) {
      expect(labels([start, scheduled, midday], day), day).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced", "Risk Plan V1.0: Replaced"]);
    }
    // The dashboard's earlier versions say so.
    const markup = render(createElement(AccountDashboardView, { dashboard: { ...dashboardFixture(), riskPlans: riskPlanTimeline([start, first, second], "2026-11-01") }, display: STRATEGY, month: "2026-10", mode: "NET_R", currentContext: "all" }));
    expect(visibleText(markup)).toContain("Earlier versions · 2");
    expect(visibleText(markup)).not.toContain("Replaced before it started");
  });

  it("calls a version never in effect only when a newer one already applied at the first instant it could", () => {
    // Created at the same instant (one transaction): the higher id applies from that instant, the other never does.
    const lower = plan("e4000000-0000-4000-8000-000000000001", "Risk Plan V1.1", "2026-10-31T14:00:00Z", "2026-10-31");
    const higher = plan("e4000000-0000-4000-8000-000000000002", "Risk Plan V1.2", "2026-10-31T14:00:00Z", "2026-10-31");
    expect(labels([lower, higher], "2026-11-01")).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced before it started"]);
    // A newer version created at the very instant a scheduled version's day begins (00:00 UTC−5) applies from it;
    // one created a microsecond later leaves that microsecond to the scheduled version.
    const scheduled = plan("e4000000-0000-4000-8000-000000000003", "Risk Plan V1.1", "2026-10-31T15:00:00Z", "2026-11-02");
    const atDayStart = plan("e4000000-0000-4000-8000-000000000004", "Risk Plan V1.2", "2026-11-02T05:00:00Z", "2026-11-02");
    expect(labels([scheduled, atDayStart], "2026-11-03")).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced before it started"]);
    expect(labels([scheduled, { ...atDayStart, createdAt: "2026-11-02T05:00:00.000001Z" }], "2026-11-03")).toEqual(["Risk Plan V1.2: Active", "Risk Plan V1.1: Replaced"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Manage (§14.9).
// ---------------------------------------------------------------------------------------------------------------------
describe("Manage account", () => {
  it("goes back to an active account's dashboard as the context, and to an archived one's without switching (§9.2)", () => {
    const back = (markup: string) => /<header[\s\S]*?<a [^>]*href="([^"]*)"/.exec(markup)?.[1];
    expect(back(manageView("profile"))).toBe(`/accounts/${FTMO}?account=${FTMO}`);
    const archivedManage = render(createElement(ManageView, {
      manage: manageFixture({ account: { ...ftmo, status: "ARCHIVED" }, archived: true }), display: STRATEGY, tab: "profile", connection: null, instrumentDraft: null,
    }));
    expect(back(archivedManage)).toBe(`/accounts/${FTMO}`);
  });

  it("links every section as a tab, the current one marked", () => {
    const markup = manageView("risk-policy");
    for (const label of ["Profile", "Account values", "External losses", "Risk policy", "Instruments", "Connection"]) expect(visibleText(markup)).toContain(label);
    const current = [...markup.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map(match => match[0]);
    expect(current).toHaveLength(2);
    for (const tag of current) expect(tag).toContain(`href="/accounts/${FTMO}/manage?tab=risk-policy"`);
    expect(parseManageTab("external-losses")).toBe("external-losses");
    expect(parseManageTab(["account-values"])).toBe("account-values");
    expect(parseManageTab("delete-everything")).toBe("profile");
    expect(manageHref(FTMO)).toBe(`/accounts/${FTMO}/manage`);
  });

  it("Profile: edits the profile and archives with the confirmation copy; history in words", () => {
    const markup = manageView("profile");
    const text = visibleText(markup);
    expectClean(markup);
    for (const name of ["displayName", "accountType", "broker", "platform", "startingBalance"]) expect(markup).toContain(`name="${name}"`);
    expect(markup).toContain('value="100000.00"');
    expect(text).toContain(ARCHIVE_COPY);
    expect(text).toContain("Archive account…");
    expect(text).toContain("Profile history · 2 versions");
    expect(text).toContain("Set up from earlier data");
    const restored = visibleText(manageView("profile", { manage: manageFixture({ account: { ...ftmo, status: "ARCHIVED" }, archived: true }) }));
    expect(restored).toContain("Restore account…");
    expect(restored).toContain("This account is archived.");
  });

  it("Account values: one-click Confirm unchanged when today's values are missing, the update form and the history", () => {
    const markup = manageView("account-values");
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("Confirm today's balance.");
    expect(text).toContain(CONFIRM_UNCHANGED);
    expect(text).toContain(UPDATE_VALUES);
    expect(markup).toContain('name="balance"');
    expect(markup).toContain('name="equity"');
    expect(text).toContain("Thu, Oct 22, 2026");
    const confirmed = manageFixture({ values: { latest: observation(TODAY), confirmedToday: true, history: [observation(TODAY)] } });
    const confirmedText = visibleText(manageView("account-values", { manage: confirmed }));
    expect(confirmedText).toContain("Balance confirmed today.");
    expect(confirmedText).not.toContain(CONFIRM_UNCHANGED);
  });

  it("Account values of an archived account: the values and history, without a confirmation request or a form", () => {
    const archivedManage = manageFixture({ account: { ...ftmo, status: "ARCHIVED" }, archived: true });
    const markup = manageView("account-values", { manage: archivedManage });
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("$101,000.00");
    expect(text).toContain("Thu, Oct 22, 2026");
    expect(text).toContain(ARCHIVED_VALUES_COPY);
    expect(text).not.toContain("Confirm today's balance.");
    expect(text).not.toContain("Plans can't be locked");
    expect(text).not.toContain(CONFIRM_UNCHANGED);
    expect(markup).not.toContain('name="balance"');
    expect(markup).not.toContain('name="equity"');
    // No values at all: no request to record them either.
    const none = visibleText(manageView("account-values", { manage: { ...archivedManage, values: { latest: null, confirmedToday: false, history: [] } } }));
    expect(none).toContain("No account values yet.");
    expect(none).not.toContain("plans can be locked");
  });

  it("External losses: today's total, the helper copy, remove with a reason, removed entries kept", () => {
    const markup = manageView("external-losses");
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain(EXTERNAL_LOSSES_TITLE);
    expect(text).toContain("Add external loss");
    expect(text).toContain(EXTERNAL_LOSS_HELPER);
    // A synced position counts only once its close is on a trade (V2_1_GAPS.md §1.2): the note must not say every synced loss is counted.
    expect(text).toContain("Don't add losses already recorded on a trade in Trading OS (imported trades included): they are counted. A synced platform position counts only once its close is recorded on a trade.");
    expect(text).not.toContain("recorded or synced");
    expect(text).toContain("$75.00");
    expect(text).toContain("cTrader scalp");
    expect(markup).toContain('aria-label="Remove the external loss of $75.00"');
    expect(text).toContain("Removed");
    expect(text).toContain("Entered twice");
    // Earlier days list only earlier entries.
    expect(text).toContain("$120.50");
    expect(text).toContain("MT4 account");
    expect(markup).toContain('name="amount"');
    expect(markup).toContain('name="note"');
  });

  it("Risk policy: current version, scheduled 'Starts tomorrow', strategy minimum warning, versioning and the override reason", () => {
    const markup = manageView("risk-policy");
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("Current: Risk Plan V1.1");
    expect(text).toContain("Risk Plan V1.2 · Starts tomorrow");
    expect(text).toContain("Strategy minimum");
    expect(text).toContain("Your risk plan's minimum RR of 2.50R is below the strategy's documented 3.00R.");
    expect(text).toContain(VERSIONING_COPY);
    expect(text).toContain("Immediately");
    expect(text).toContain("Requires a reason");
    // An immediate version stays in effect until a newer one (effective day = today), it is not an override for today.
    expect(IMMEDIATE_OPTION_COPY).toBe("Applies from now on, today included, until you create another version. Requires a reason.");
    expect(text).toContain(`Immediately ${IMMEDIATE_OPTION_COPY}`);
    expect(text).not.toMatch(/override for today/i);
    expect(text).toContain("Prefilled from Risk Plan V1.2 (starts tomorrow).");
    for (const name of ["defaultRiskPercent", "maxRiskPercent", "maxDailyTrades", "minRR", "rrPolicy", "newsPolicy", "dailyRiskCap", "dailyLossCap", "timing"]) {
      expect(markup).toContain(`name="${name}"`);
    }
    // Exact policy values: never rounded (0.50%, 0.75%), caps as money.
    expect(text).toContain("0.50%");
    expect(text).toContain("$2,000.00");
    expect(text).toContain("Replaced");
  });

  it("Instruments: latest versions, earlier versions collapsed, the account-currency tick value note and a prefilled new version", () => {
    const markup = manageView("instruments");
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("EURUSD");
    expect(text).toContain("GBPUSD");
    expect(text).toContain("Tick value (USD)");
    expect(text).toContain("Earlier versions · 1");
    expect(text).toContain(tickValueNote("USD"));
    expect(markup).toContain(`href="/accounts/${FTMO}/manage?tab=instruments&amp;symbol=EURUSD#add-instrument"`);
    const draft = manageView("instruments", {
      instrumentDraft: {
        versionId: INSTRUMENT.id, symbol: "EURUSD", quantityUnit: "lots", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01",
      },
    });
    expect(visibleText(draft)).toContain("New version of EURUSD");
    expect(draft).toContain('value="EURUSD"');
  });

  it("Instruments: every prefill is its own form, so New version of another symbol or Start empty never keeps earlier contract values", () => {
    const xau: InstrumentDraft = {
      versionId: "f1000000-0000-4000-8000-000000000010", symbol: "XAUUSD", quantityUnit: "lots (100 oz)", tickSize: "0.01", pipSize: "0.1", tickValue: "1",
      quantityStep: "0.01", minimumQuantity: "0.01",
    };
    const us100: InstrumentDraft = {
      versionId: "f1000000-0000-4000-8000-000000000011", symbol: "US100", quantityUnit: "lots ($1 per point)", tickSize: "0.1", pipSize: "1", tickValue: "0.1",
      quantityStep: "0.1", minimumQuantity: "0.1",
    };
    const form = (initial: InstrumentDraft | null) => InstrumentForm({ accountId: FTMO, currency: "USD", initial });
    // React remounts an element whose key changes: fresh fields (and no earlier feedback) for each symbol and for Start empty.
    expect(new Set([form(us100).key, form(xau).key, form(null).key]).size).toBe(3);
    expect(form(null).key).toBe(instrumentDraftKey(null));
    // A saved version of the same symbol keeps the form (its success message); the fields refill from the new version.
    expect(form({ ...xau, versionId: "f1000000-0000-4000-8000-000000000012", tickValue: "1.5" }).key).toBe(form(xau).key);
    const markup = manageView("instruments", { instrumentDraft: xau });
    expectClean(markup);
    expect(visibleText(markup)).toContain("New version of XAUUSD");
    for (const [name, value] of Object.entries({ tickSize: "0.01", pipSize: "0.1", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" })) {
      expect(markup).toContain(`<input type="hidden" name="${name}" value="${value}"/>`);
    }
  });

  it("Connection: Manual with planned providers, never claiming connectivity", () => {
    const markup = manageView("connection");
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("Manual");
    expect(text).toContain(MANUAL_CONNECTION_COPY);
    expect(text).toContain("cTrader");
    expect(text).toContain("Read-only sync planned for V2.1");
    expect(text).toContain("MetaTrader 5");
    expect(text).toContain("Bridge planned for V2.2");
    expect(text).toContain("Read-only: account, positions, deals, balances. Trading OS never requests trading permission.");
    expect(text).toContain("No unmatched executions.");
    expect(text).not.toContain("Mock platform");
    expect(text).not.toContain("Simulate sync");
  });

  it("Connection: unmatched executions offer Link with suggested trades; linked ones Unlink, except imported trades", () => {
    const details: ConnectionDetails = {
      unmatched: [{
        execution: execution(1),
        candidates: [{
          tradeId: "b9000000-0000-4000-8000-000000000001", accountId: FTMO, origin: "PLANNED", lifecycle: "LIVE", linked: false, symbol: "EURUSD", direction: "LONG",
          lockedAt: "2026-10-22T12:50:00Z", plannedEntry: "1.085", plannedStop: "1.083", tickSize: "0.00001", suggested: true,
        }],
      }],
      moreUnmatched: false,
      linked: [
        execution(2, { linkedTradeId: "b9000000-0000-4000-8000-000000000002", linkMethod: "USER", exitPrice: "1.0871", exitedAt: "2026-10-22T15:00:00Z", realizedPnl: "120" }),
        execution(3, { linkedTradeId: "b9000000-0000-4000-8000-000000000003", linkMethod: "IMPORT_CREATED" }),
      ],
    };
    const markup = manageView("connection", { connection: details });
    const text = visibleText(markup);
    expectClean(markup);
    expect(text).toContain("EURUSD Long · 0.5");
    expect(text).toContain("Entry 1.08512 · Oct 22, 08:00");
    // The plan's instrument and direction are the execution's own; its lock time and entry tell plans apart.
    expect(text).toContain("Locked Oct 22, 07:50 · entry 1.08500 · suggested");
    expect(text).toContain("Link");
    expect(count(text, "Unlink")).toBe(1);
    expect(text).toContain("Imported trade");
    expect(text).toContain("+$120.00");
    expect(markup).toContain('href="/trades/b9000000-0000-4000-8000-000000000002"');
  });

  it("Connection: the developer mock platform appears only when enabled", () => {
    const enabled = manageFixture({ platformOptions: [...PLATFORM_OPTIONS, MOCK_OPTION] });
    expect(visibleText(manageView("connection", { manage: enabled }))).toContain("Connect mock platform");
    const connection: PlatformConnection = {
      id: "a4000000-0000-4000-8000-000000000001", accountId: FTMO, provider: "MOCK", label: "Mock platform", externalAccountRef: "•••• 4821", createdAt: "2026-10-20T12:00:00Z",
      currency: "USD", status: "SYNCED", statusMessage: "Imported 2 positions.", statusAt: "2026-10-23T14:00:00Z", syncedThrough: "2026-10-23T14:00:00Z",
      lastSyncedAt: "2026-10-23T14:00:00Z", warningCount: 0, lastWarningAt: null, executionCount: 3, unmatchedCount: 1,
    };
    const connected = manageFixture({ platformOptions: [...PLATFORM_OPTIONS, MOCK_OPTION], connection: { mode: "SYNCED", connection, lastSyncedAt: connection.lastSyncedAt, message: null } });
    const text = visibleText(manageView("connection", { manage: connected }));
    expect(text).toContain("Last synced Oct 23, 09:00");
    expect(text).toContain("Simulate sync");
    expect(text).toContain("Disconnect");
    expect(text).not.toContain("Connect mock platform");
    expect(text).toContain("3 executions received · 1 waiting for you");
  });

  it("loads connection details only on the Connection tab and answers 404 for a foreign account", async () => {
    m.manage.mockResolvedValue(manageFixture());
    m.connection.mockResolvedValue({ unmatched: [], moreUnmatched: false, linked: [] });
    const profile = render(await ManageAccountPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({}) }));
    expect(m.connection).not.toHaveBeenCalled();
    expect(visibleText(profile)).toContain("Manage FTMO 100K");
    render(await ManageAccountPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({ tab: "connection" }) }));
    expect(m.connection).toHaveBeenCalledWith(FTMO);
    const prefilled = render(await ManageAccountPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({ tab: "instruments", symbol: " gbpusd " }) }));
    expect(visibleText(prefilled)).toContain("New version of GBPUSD");
    expect(prefilled).toContain('value="GBPUSD"');
    const unknown = render(await ManageAccountPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({ tab: "instruments", symbol: "XAUUSD" }) }));
    expect(visibleText(unknown)).not.toContain("New version of");
    expect(visibleText(unknown)).toContain("Add instrument");
    m.manage.mockResolvedValue(null);
    await expect(ManageAccountPage({ params: Promise.resolve({ id: FTMO }), searchParams: Promise.resolve({}) })).rejects.toThrow();
  });
});

describe("form helpers", () => {
  it("checks numbers exactly as the actions accept them, before anything is sent", () => {
    const money: FieldRule = { kind: "money", message: "money" };
    expect(["100", "0.01", "25000.50", "999999999999.99"].map(value => checkField(value, money))).toEqual([true, true, true, true]);
    expect(["", "0", "0.00", "1.234", "abc", "-5", "1,5", "1e3", "1000000000000"].map(value => checkField(value, money))).toEqual(Array(9).fill(false));
    expect(checkField("", { ...money, optional: true })).toBe(true);
    const percent: FieldRule = { kind: "decimal", max: "100", message: "percent" };
    expect(["0.5", "100", "0.00000001"].map(value => checkField(value, percent))).toEqual([true, true, true]);
    expect(["100.5", "0", "0.000000001", "x"].map(value => checkField(value, percent))).toEqual([false, false, false, false]);
    expect(checkField("eurusd", { kind: "symbol", message: "symbol" })).toBe(true);
    expect(checkField("", { kind: "symbol", message: "symbol" })).toBe(false);
    expect(["1", "100"].map(value => checkField(value, { kind: "whole", min: 1, max: 100, message: "trades" }))).toEqual([true, true]);
    expect(["0", "101", "2.5", ""].map(value => checkField(value, { kind: "whole", min: 1, max: 100, message: "trades" }))).toEqual([false, false, false, false]);
    const form = new FormData();
    form.set("name", "  ");
    form.set("balance", "abc");
    form.set("broker", "");
    expect(checkForm(form, { name: { kind: "text", max: 100, message: "Name it." }, balance: money, broker: { kind: "text", max: 100, optional: true, message: "Broker." } }))
      .toEqual({ name: "Name it.", balance: "money" });
  });

  it("gives focus back once the dialog is gone, making a heading focusable first", () => {
    const frames: FrameRequestCallback[] = [];
    let dialogOpen = true;
    const doc = { activeElement: null as unknown, querySelector: () => (dialogOpen ? {} : null) };
    vi.stubGlobal("window", { requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback) });
    vi.stubGlobal("document", doc);
    const attributes = new Map<string, string>();
    const heading = {
      isConnected: true, tabIndex: -1, hasAttribute: (name: string) => attributes.has(name), setAttribute: (name: string, value: string) => attributes.set(name, value),
      focus: vi.fn(() => {
        doc.activeElement = heading;
      }),
    };
    const runFrame = () => frames.shift()?.(0);
    try {
      restoreFocusAfterDialog(() => heading as unknown as HTMLElement);
      runFrame();
      runFrame();
      // While a dialog is open (its focus trap would pull focus back), nothing moves.
      expect(heading.focus).not.toHaveBeenCalled();
      dialogOpen = false;
      runFrame();
      expect(heading.focus).toHaveBeenCalledTimes(1);
      expect(attributes.get("tabindex")).toBe("-1");
      expect(frames).toHaveLength(0);
      // A button keeps its own tab order; a removed element is never focused.
      const button = { isConnected: true, tabIndex: 0, hasAttribute: () => false, setAttribute: vi.fn(), focus: vi.fn() };
      focusElement(button as unknown as HTMLElement);
      expect(button.setAttribute).not.toHaveBeenCalled();
      expect(focusElement({ ...button, isConnected: false } as unknown as HTMLElement)).toBe(false);
      expect(focusElement(null)).toBe(false);
      expect(ACTIVE_ACCOUNTS_HEADING).toBe("accounts-active");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves focus to the section title once a confirmed control has left the page, only when focus went with it", () => {
    const frames: FrameRequestCallback[] = [];
    const body = { isConnected: true };
    const doc = { activeElement: null as unknown, body, querySelector: () => null };
    vi.stubGlobal("window", { requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback) });
    vi.stubGlobal("document", doc);
    const title = {
      isConnected: true, tabIndex: -1, hasAttribute: () => true, setAttribute: vi.fn(),
      focus: vi.fn(() => {
        doc.activeElement = title;
      }),
    };
    const target = () => title as unknown as HTMLElement;
    const runFrames = (n: number) => {
      for (let index = 0; index < n; index += 1) frames.shift()?.(0);
    };
    try {
      // The result arrives while the button is still on the page and focused: nothing moves for as long as it stays.
      const control = { isConnected: true };
      doc.activeElement = { isConnected: true };
      restoreFocusWhenGone(control as unknown as Element, target);
      runFrames(5);
      expect(title.focus).not.toHaveBeenCalled();
      // The page update removes it a few frames later and the browser leaves focus on the body: the title gets it.
      control.isConnected = false;
      doc.activeElement = body;
      runFrames(1);
      expect(title.focus).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(0);
      // Already gone when the result arrives (its ref is cleared): the next frame moves focus.
      title.focus.mockClear();
      doc.activeElement = body;
      restoreFocusWhenGone(null, target);
      runFrames(1);
      expect(title.focus).toHaveBeenCalledTimes(1);
      // Focus the person moved elsewhere in the meantime stays there.
      title.focus.mockClear();
      const leaving = { isConnected: true };
      restoreFocusWhenGone(leaving as unknown as Element, target);
      doc.activeElement = { isConnected: true };
      leaving.isConnected = false;
      runFrames(1);
      expect(title.focus).not.toHaveBeenCalled();
      // A control that is still there after the wait keeps its focus, and the wait ends.
      restoreFocusWhenGone({ isConnected: true } as unknown as Element, target);
      runFrames(200);
      expect(title.focus).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands focus to the new screen once Today's onboarding form has left the page with it (§13.5)", () => {
    const frames: FrameRequestCallback[] = [];
    const body = { isConnected: true };
    const heading = (name: string) => {
      const element = {
        name, isConnected: true, tabIndex: -1, hasAttribute: () => false, setAttribute: vi.fn(),
        focus: vi.fn(() => {
          doc.activeElement = element;
        }),
      };
      return element;
    };
    const status = heading("today-status-title");
    const title = heading("main h1");
    const ids = new Map<string, unknown>([["today-status-title", status]]);
    const doc = { activeElement: null as unknown, body, getElementById: (id: string) => ids.get(id) ?? null, querySelector: (selector: string) => (selector === "main h1" ? title : null) };
    vi.stubGlobal("window", { requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback) });
    vi.stubGlobal("document", doc);
    const runFrames = (n: number) => {
      for (let index = 0; index < n; index += 1) frames.shift()?.(0);
    };
    try {
      // The account was created; the refresh has not replaced the onboarding yet, and its button keeps focus.
      const form = { isConnected: true };
      doc.activeElement = { isConnected: true };
      focusAfterCreated(form as unknown as Element, "today-status-title");
      runFrames(10);
      expect(status.focus).not.toHaveBeenCalled();
      // The normal Today arrives without the form; the browser left focus on the body: the trading status takes it.
      form.isConnected = false;
      doc.activeElement = body;
      runFrames(1);
      expect(status.focus).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(0);
      // Without that heading on the new screen, the page's own heading takes focus.
      ids.clear();
      doc.activeElement = body;
      focusAfterCreated(null, "today-status-title");
      runFrames(1);
      expect(title.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads field errors of an error state only", () => {
    expect(fieldError({ status: "error", message: "Check", fieldErrors: { amount: "Amount must be positive." } }, "amount")).toBe("Amount must be positive.");
    expect(fieldError({ status: "success" }, "amount")).toBeUndefined();
    expect(fieldError({ status: "idle" }, "amount")).toBeUndefined();
  });
});
