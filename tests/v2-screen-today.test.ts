import Decimal from "decimal.js";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Today (docs/V2_ARCHITECTURE.md §14.1, §2.4, §6.5, §8.4, §9.2–9.3, §13.8, §15): the page is rendered from its real
// server components with the data loaders mocked (no database, no network). Verdicts come from the real domain
// (`dailyStatusV2`, `deriveTradeState`, `evaluateRisk`), so the screen is checked against the engine's own sentences.

const m = vi.hoisted(() => ({
  getToday: vi.fn(),
  context: null as unknown,
  timeDisplay: { mode: "strategy" } as { mode: "strategy" | "utc" | "local"; zone?: string },
  tables: {} as Record<string, unknown[]>,
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  accounts: {
    createTradingAccount: vi.fn(), recordAccountValues: vi.fn(), confirmAccountValuesUnchanged: vi.fn(), addExternalLoss: vi.fn(), removeExternalLoss: vi.fn(),
    updateProfile: vi.fn(), archiveAccount: vi.fn(), restoreAccount: vi.fn(), createInstrument: vi.fn(), createRiskPolicyVersion: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath, refresh: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/today",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/accounts", () => m.accounts);
vi.mock("@/app/actions/trades", () => ({ checkRisk: vi.fn() }));
vi.mock("@/app/actions/journal", () => ({ addJournalEntry: vi.fn() }));
vi.mock("@/lib/account-context", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/account-context")>();
  return {
    ...actual,
    currentSession: async () => ({ db: database(), user: { id: USER } }),
    getAccountContext: async () => m.context,
    getPreferences: async () => ({ theme: "system", timeDisplay: m.timeDisplay, developerMode: false, sidebarCollapsed: false }),
  };
});
vi.mock("@/lib/today-data", () => ({ getToday: m.getToday }));

const USER = "10000000-0000-4000-8000-000000000001";

/**
 * A PostgREST double: `from(table)` chains (select, eq, in, order, limit, or) and resolves to the rows of that table;
 * `maybeSingle()` resolves to the first one. `rpc` is recorded.
 */
function database() {
  const chain = (table: string) => {
    const rows = m.tables[table] ?? [];
    const result = { data: rows, error: null };
    const self: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => Promise.resolve(result).then(resolve, reject),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    for (const method of ["select", "eq", "in", "order", "limit", "or", "lte", "gte"]) self[method] = () => self;
    return self;
  };
  return { from: chain, rpc: m.rpc };
}

import TodayRouteLoading from "@/app/(app)/today/loading";
import TodayPage from "@/app/(app)/today/page";
import { saveDailyContext } from "@/app/(app)/today/actions";
import { idleState } from "@/app/actions/state";
import {
  CLOSED_EMPTY_TITLE, EARLIER_LOCKED_LABEL, EARLIER_LOCKED_NOTE, EMPTY_DAY_TITLE, LIVE_TRADE_COPY, NO_ACTIVE_TITLE, NO_R_COPY, NOTES_ALL_ACCOUNTS_COPY, NOTES_ARCHIVED_COPY, NOTES_SAVED_COPY,
  NOTES_TITLE, ONBOARDING_TITLE, PLAN_TRADE_COPY, PLANS_EMPTY_TITLE, RISK_NOT_RECORDED_HINT,
} from "@/components/today/copy";
import { daySegments, renderOutdated, ribbonModel } from "@/components/today/ribbon-model";
import { buildTodayView, OLDER_DRAFTS_INLINE } from "@/components/today/view-model";
import { ACCOUNT_TYPE_LABELS } from "@/domain/account-metrics";
import { dailyStatusV2, STALE_USAGE_HEADLINE } from "@/domain/daily-status";
import { previewInstrument, previewProposal, previewRiskPlan, usageFixture } from "@/domain/fixtures";
import type { LedgerTrade } from "@/domain/ledger";
import { LEDGER_COLUMNS } from "@/domain/ledger";
import { dayResult } from "@/domain/performance";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import { RISK_COPY } from "@/domain/risk-explain";
import { nextBoundary, strategyClock } from "@/domain/session";
import { strategyDay, strategyDayLabel } from "@/domain/time-display";
import { deriveTradeState, withBlockingFindings } from "@/domain/trade-state";
import type { AccountContext, ContextAccount } from "@/lib/account-context";
import type { LiveTradeCard, TodayAccountStatus, TodayData, TodayLosses } from "@/lib/today-data";
import { tradeDate, type TradeListRow } from "@/lib/trades-data";
import type { AccountWorkspace } from "@/lib/workspace";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-23T13:00:00.000Z"; // Fri Oct 23, 08:00 UTC−5 (Kill zone)
const DEAD_POOL_NOW = "2026-10-23T19:00:00.000Z"; // 14:00 UTC−5
const DAY = "2026-10-23";
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const OBSERVATION = "30000000-0000-4000-8000-000000000001";
const STRATEGY = "30000000-0000-4000-8000-000000000002";
const EVALUATION = "30000000-0000-4000-8000-000000000003";
const DE40 = "30000000-0000-4000-8000-000000000004";
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `LIVE_FIRST`, `STALE_EQUITY`): never in visible text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

function account(id: string, name: string, currency: string, changes: Partial<ContextAccount> = {}): ContextAccount {
  return {
    id, name, currency, type: "EVALUATION", platform: "MT5", broker: "FTMO", status: "ACTIVE", startingBalance: "100000", createdAt: "2026-09-01T10:00:00Z",
    profile: "PROFILE", ...changes,
  };
}
const FTMO_ACCOUNT = account(FTMO, "FTMO 100K", "USD");
const PERSONAL_ACCOUNT = account(PERSONAL, "Personal 12K", "EUR", { type: "PERSONAL", broker: "IC Markets", platform: "CTRADER", startingBalance: "12000" });

function allContext(accounts: ContextAccount[] = [FTMO_ACCOUNT, PERSONAL_ACCOUNT]): AccountContext {
  return {
    accounts, active: accounts.filter(item => item.status === "ACTIVE"), archived: accounts.filter(item => item.status === "ARCHIVED"), selected: { mode: "all" },
    notice: null, noticeText: null, scopeAccountIds: accounts.map(item => item.id), formDefaultAccountId: null,
  };
}
function accountContext(selected: ContextAccount = FTMO_ACCOUNT): AccountContext {
  return { ...allContext(), selected: { mode: "account", account: selected }, scopeAccountIds: [selected.id], formDefaultAccountId: selected.id };
}

const DE40_INSTRUMENT = { ...previewInstrument, id: DE40, symbol: "DE40", currency: "EUR", quantityUnit: "lots", tickSize: "0.1", pipSize: null, tickValue: "0.1", quantityStep: "0.01", minimumQuantity: "0.01" };

interface WorkspaceOptions {
  now?: string;
  usage?: Partial<DailyUsage>;
  observationDay?: string | null;
  plan?: Partial<typeof previewRiskPlan>;
  riskPlan?: boolean;
  gaps?: AccountWorkspace["gaps"];
}

function workspace(owner: ContextAccount, options: WorkspaceOptions = {}): AccountWorkspace {
  const now = options.now ?? NOW;
  const day = strategyDay(now);
  const usage = usageFixture({ day, ...options.usage });
  const observationDay = options.observationDay === undefined ? day : options.observationDay;
  const plan = { ...previewRiskPlan, maxDailyTrades: 2, dailyRiskCap: "1000", dailyLossCap: "2000", ...options.plan };
  const riskPlan = options.riskPlan === false ? null : { ...plan, effectiveDay: "2026-09-01", createdAt: "2026-09-01T10:00:00Z", overrideReason: null };
  const observation = observationDay === null ? null : {
    id: OBSERVATION, balance: owner.currency === "EUR" ? "12440.23" : "111132.01", equity: owner.currency === "EUR" ? "12440.23" : "111250.5",
    grossLossToday: null, tradingDay: observationDay, recordedAt: `${observationDay}T12:00:00Z`,
  };
  return {
    account: owner, now, day, observation, riskPlan, strategy: { id: STRATEGY, version: "ICT V1.0", rules: {} },
    instruments: owner.currency === "EUR" ? [DE40_INSTRUMENT] : [previewInstrument], usage, todaysPlans: [],
    status: riskPlan ? dailyStatusV2({ now, observationDay: observation?.tradingDay ?? null, currency: owner.currency, plan: riskPlan }, usage) : null,
    gaps: options.gaps ?? [],
  };
}

function losses(space: AccountWorkspace): TodayLosses {
  const usage = space.usage;
  return { currency: space.account.currency, realized: usage.realizedLoss, external: usage.externalLoss, legacyReported: usage.legacyReportedLoss, total: usage.lossTotal };
}
const status = (space: AccountWorkspace): TodayAccountStatus => ({ account: space.account, workspace: space, losses: losses(space) });

function ledger(n: number, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: uuid(n), account_id: FTMO, origin: "PLANNED", created_at: "2026-10-23T11:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
    latest_revision_at: "2026-10-23T11:00:00Z", entry_time_known: false, lifecycle: "DRAFT", draft_check: "UNCHECKED", tags: [], evidence_count: 0, journal_count: 0,
    ai_review_count: 0, symbol: "EURUSD", direction: "LONG", entry_model: "OB_FIRST_TOUCH", requested_risk_percent: "0.5", instrument_version_id: previewInstrument.id,
    ...changes,
  };
}

const livePlanned = ledger(1, {
  plan_id: uuid(101), locked_at: "2026-10-23T11:30:00Z", entered_at: "2026-10-23T12:05:00Z", entry_recorded_at: "2026-10-23T12:06:00Z", entry_time_known: true,
  entry_price: "1.1", quantity: "0.5", initial_stop: "1.098", initial_risk: "500", planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106",
  lifecycle: "LIVE", draft_check: null, evidence_count: 2,
});
const liveFirstNoRisk = ledger(2, {
  account_id: PERSONAL, currency: "EUR", origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_revision_at: null, symbol: "DE40", direction: "SHORT",
  entry_model: null, requested_risk_percent: null, instrument_version_id: DE40, created_at: "2026-10-23T12:40:00Z", lifecycle: "LIVE", draft_check: null,
});
const lockedPlan = ledger(3, {
  symbol: "XAUUSD", direction: "SHORT", entry_model: "OTE", plan_id: uuid(103), locked_at: "2026-10-23T08:52:00Z", lifecycle: "LOCKED", draft_check: null,
  planned_entry: "2415.5", planned_stop: "2420", planned_target: "2400", planned_risk: "500", instrument_version_id: null,
});
const blockedDraft = ledger(4, {
  symbol: "GBPUSD", requested_risk_percent: "1", latest_revision: 2, latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T12:44:30Z",
  latest_check_evaluation_id: EVALUATION, draft_check: "BLOCKED", planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106",
});
const readyDraft = ledger(5, {
  latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T12:50:00Z", latest_check_evaluation_id: uuid(205), draft_check: "APPROVED", planned_risk: "500",
  planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106",
});
const uncheckedDraft = ledger(6, { symbol: "GBPUSD", direction: "SHORT", created_at: "2026-10-23T12:58:00Z", latest_revision_at: "2026-10-23T12:58:00Z" });
const closedWin = ledger(7, {
  plan_id: uuid(107), locked_at: "2026-10-23T07:50:00Z", entered_at: "2026-10-23T08:05:00Z", entry_recorded_at: "2026-10-23T08:06:00Z", entry_price: "1.1",
  quantity: "0.5", exited_at: "2026-10-23T11:20:00Z", close_recorded_at: "2026-10-23T11:21:00Z", net_pnl: "120", realized_r: "1.2", outcome: "WIN",
  lifecycle: "CLOSED", draft_check: null, initial_risk: "100",
});
const closedLossEur = ledger(8, {
  account_id: PERSONAL, currency: "EUR", origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, symbol: "DE40", direction: "SHORT", entry_model: null,
  entered_at: "2026-10-23T09:00:00Z", entry_recorded_at: "2026-10-23T09:00:00Z", entry_time_known: true, exited_at: "2026-10-23T10:00:00Z",
  close_recorded_at: "2026-10-23T10:00:00Z", net_pnl: "-40", realized_r: null, outcome: "LOSS", lifecycle: "CLOSED", draft_check: null, instrument_version_id: DE40,
});

function row(trade: LedgerTrade, checkCurrent = false): TradeListRow {
  const date = tradeDate(trade);
  const owner = trade.account_id === PERSONAL ? PERSONAL_ACCOUNT : FTMO_ACCOUNT;
  return {
    id: trade.id, href: `/trades/${trade.id}`, trade, tradeAt: date.at, tradeDay: strategyDay(date.at), tradeDateSource: date.source,
    account: { id: owner.id, name: owner.name, currency: owner.currency, status: owner.status },
    state: deriveTradeState(trade, { now: NOW, checkCurrent }), thumbnail: null, ai: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null },
  };
}

function liveCard(trade: LedgerTrade, lastJournal: LiveTradeCard["lastJournal"] = null): LiveTradeCard {
  return { row: row(trade), liveSince: trade.entered_at ?? trade.entry_recorded_at ?? trade.created_at, lastJournal };
}

interface DataOptions {
  now?: string;
  context?: AccountContext;
  accounts?: TodayAccountStatus[];
  live?: LiveTradeCard[];
  locked?: LedgerTrade[];
  drafts?: { ready?: LedgerTrade[]; blocked?: LedgerTrade[]; recheck?: LedgerTrade[]; unchecked?: LedgerTrade[] };
  closed?: LedgerTrade[];
  dailyContext?: TodayData["dailyContext"];
  truncated?: Partial<TodayData["truncated"]>;
  /** Losses the loader adds for accounts without a status row (All Accounts: an archived account that closed a trade today). */
  outsideLosses?: TodayLosses[];
}

function todayData(options: DataOptions = {}): TodayData {
  const now = options.now ?? NOW;
  const day = strategyDay(now);
  const context = options.context ?? accountContext();
  const accounts = options.accounts ?? [status(workspace(FTMO_ACCOUNT, { now }))];
  const live = options.live ?? [];
  const drafts = { ready: [], blocked: [], recheck: [], unchecked: [], ...options.drafts };
  const closed = options.closed ?? [];
  const plans = {
    ready: drafts.ready.map(trade => row(trade, true)), blocked: drafts.blocked.map(trade => row(trade)), recheck: drafts.recheck.map(trade => row(trade)),
    unchecked: drafts.unchecked.map(trade => row(trade)), locked: (options.locked ?? []).map(trade => row(trade)),
  };
  const byCurrency = new Map<string, TodayLosses>();
  for (const losses of [...accounts.map(entry => entry.losses), ...(options.outsideLosses ?? [])]) {
    const sum = byCurrency.get(losses.currency);
    byCurrency.set(losses.currency, sum ? {
      ...sum, realized: new Decimal(sum.realized).plus(losses.realized).toFixed(), external: new Decimal(sum.external).plus(losses.external).toFixed(),
      total: new Decimal(sum.total).plus(losses.total).toFixed(),
    } : losses);
  }
  const waiting = Object.values(plans).reduce((count, rows) => count + rows.length, 0);
  return {
    now, day, dayLabel: strategyDayLabel(day), session: strategyClock(now).session, boundary: nextBoundary(now), context, accounts, live, plans,
    closedToday: closed.map(trade => row(trade)), result: dayResult(closed, day), losses: [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)), dailyContext: options.dailyContext ?? null,
    truncated: { live: false, locked: false, drafts: false, closed: false, ...options.truncated },
    empty: live.length === 0 && waiting === 0 && closed.length === 0,
  };
}

/** The stored 1.2 report of the blocked draft: requested risk 1% above the 0.5% maximum. */
function blockedReport() {
  const context: RiskContext = {
    now: NOW, strategyVersionId: STRATEGY, strategyVersion: "ICT V1.0", observationId: OBSERVATION, observationDay: DAY, equity: "100000", currency: "USD",
    plan: { ...previewRiskPlan, maxDailyTrades: 2 }, instrument: previewInstrument, usage: usageFixture({ day: DAY }), duplicate: false,
  };
  return evaluateRisk({ ...previewProposal, riskPercent: "1", narrative: "Blocked fixture.", contractConfirmed: true, news: "CLEAR" }, context);
}

function instrumentRow(instrument: typeof previewInstrument) {
  return {
    id: instrument.id, symbol: instrument.symbol, currency: instrument.currency, quantity_unit: instrument.quantityUnit, tick_size: instrument.tickSize,
    pip_size: instrument.pipSize, tick_value: instrument.tickValue, quantity_step: instrument.quantityStep, minimum_quantity: instrument.minimumQuantity,
    created_at: "2026-09-01T10:00:00Z",
  };
}

async function render(): Promise<string> {
  const element = (await TodayPage()) as ReactElement;
  return renderToStaticMarkup(element);
}

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
/** Text a person (or a screen reader) gets: markup and attributes removed; inline elements join, blocks separate. */
function visibleText(html: string): string {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<\/?(span|a|strong|em|b|abbr)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ");
  return decode(text).replace(/\s+/g, " ");
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => decode(match[1]));

function busyDay(): TodayData {
  return todayData({
    live: [liveCard(livePlanned, { kind: "STOP_CHANGE", body: "Stop to break-even after the push.", details: { price: "1.1" }, recordedAt: "2026-10-23T12:40:00Z", source: "JOURNAL" })],
    locked: [lockedPlan],
    drafts: { ready: [readyDraft], blocked: [blockedDraft], unchecked: [uncheckedDraft] },
    closed: [closedWin],
    accounts: [status(workspace(FTMO_ACCOUNT, { usage: { plannedSlots: 1, plannedRisk: "500", realizedLoss: "50", externalLoss: "25" } }))],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.context = accountContext();
  m.timeDisplay = { mode: "strategy" };
  m.tables = {
    risk_evaluations: [{
      id: EVALUATION, result: blockedReport(), proposal: { direction: "LONG", riskPercent: "1" }, risk_plan_version_id: previewRiskPlan.id,
      instrument_version_id: previewInstrument.id, strategy_version_id: STRATEGY,
    }],
    instrument_versions: [instrumentRow(previewInstrument), instrumentRow(DE40_INSTRUMENT)],
    risk_plan_versions: [],
    strategy_versions: [],
  };
  m.rpc.mockReset();
  m.revalidatePath.mockReset();
  m.getToday.mockReset();
  m.getToday.mockResolvedValue(busyDay());
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------------
// One account in context
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · one trading account", () => {
  it("answers can I trade, what is left and today's result, with the strategy day and one h1", async () => {
    const html = await render();
    const text = visibleText(html);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text).toContain("Fri, Oct 23 (UTC−5)");
    expect(text).toContain("FTMO 100K · Evaluation · FTMO · USD");
    // Status card: headline, then the five numbers.
    expect(text).toContain("Trading status · FTMO 100K");
    expect(text).toContain("You can trade");
    expect(text).toContain("Trades left 1 of 2");
    expect(text).toContain("1 used: 1 planned, 0 recorded live");
    expect(text).toContain("Risk left $500.00");
    expect(text).toContain("$500.00 of $1,000.00 cap reserved");
    expect(text).toContain("Today's result +1.20R +$120.00");
    expect(text).toContain("1 closed trade");
    expect(text).toContain("Realized losses today $50.00");
    expect(text).toContain("+ $25.00 external");
    expect(text).toContain("Daily loss limit $2,000.00");
    expect(text).toContain("Add external loss");
    expect(text).toContain("Balance confirmed today");
    expect(text).toContain("Balance $111,132.01");
    expect(text).toContain("Equity $111,250.50");
  });

  it("shows live trades first with entry at tick scale, live duration, risk and the last journal item, plus the inline actions", async () => {
    const html = await render();
    const text = visibleText(html);
    // Live trades lead: their section comes before the status card.
    expect(html.indexOf("today-live-title")).toBeLessThan(html.indexOf("today-status-title"));
    expect(text).toContain("Live trades 1");
    expect(text).toContain("EURUSD · Long Live Planned");
    expect(text).toContain("Entered 07:05 · 2 screenshots");
    expect(text).toContain("55m live");
    expect(text).toContain("Entry 1.10000");
    expect(text).toContain("Size 0.50 lots");
    expect(text).toContain("Initial stop 1.09800");
    // The R denominator, which a moved stop or a partial close never changes.
    expect(text).toContain("Initial risk $500.00 1R · 0.50% planned");
    expect(text).toContain("Stop moved to 1.10000 07:40 · 20 min ago Stop to break-even after the push.");
    expect(html).toContain('aria-label="Add note: EURUSD · Long"');
    expect(html).toContain('aria-label="Paste screenshot: EURUSD · Long"');
    expect(hrefs(html)).toContain(`/trades/${livePlanned.id}#close-trade`);
    expect(hrefs(html)).toContain(`/trades/${livePlanned.id}`);
    // Phones: the quick-action dock for the trade in view.
    expect(html).toContain('aria-label="Quick actions for a live trade"');
  });

  it("lists plans waiting with one next action each and the first blocking reason of a blocked draft", async () => {
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Plans waiting 4");
    expect(text).toContain("1 locked · 3 drafts today");
    expect(text).toContain("XAUUSD · Short Locked · waiting for entry");
    expect(text).toContain("Locked 03:52 · Entry 2415.5 · Stop 2420 · Target 2400 · Risk 0.50% ($500.00)");
    expect(hrefs(html)).toContain(`/trades/${lockedPlan.id}#record-entry`);
    expect(text).toContain("Ready to lock");
    expect(text).toContain("Approved 07:50");
    expect(html).toContain(`aria-label="Lock plan: EURUSD · Long"`);
    expect(text).toContain("GBPUSD · Long Blocked");
    expect(text).toContain("Checked 07:44 · revision 2");
    // The engine's own sentence (spec §6.5), explained from the stored 1.2 report.
    expect(text).toContain("Blocked: Requested risk 1.00% exceeds your configured maximum of 0.50%.");
    expect(hrefs(html)).toContain(`/trades/${blockedDraft.id}/edit`);
    expect(text).toContain("GBPUSD · Short Draft");
    expect(text).toContain("Drafted 07:58 · not checked yet");
    expect(html).toContain('aria-label="Check risk (free): GBPUSD · Short"');
    // Order: locked, ready, blocked, unchecked.
    const order = [lockedPlan, readyDraft, blockedDraft, uncheckedDraft].map(trade => html.indexOf(`/trades/${trade.id}`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("offers Recheck risk for an approval that is no longer current and flags a fill above the planned size", async () => {
    const recheck = ledger(9, { symbol: "USDJPY", latest_check_decision: "APPROVED", latest_check_at: "2026-10-23T11:20:00Z", latest_check_evaluation_id: uuid(209), draft_check: "APPROVED" });
    const oversized = { ...livePlanned, oversize: true };
    m.getToday.mockResolvedValue(todayData({ live: [liveCard(oversized)], drafts: { recheck: [recheck] } }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("USDJPY · Long Recheck needed");
    expect(text).toContain("Last approved 06:20");
    expect(html).toContain('aria-label="Recheck risk: USDJPY · Long"');
    expect(text).toContain("Size above plan");
  });

  it("keeps the phone dock for live trades only", async () => {
    m.getToday.mockResolvedValue(todayData({ closed: [closedWin] }));
    const html = await render();
    expect(html).not.toContain("Quick actions for a live trade");
    expect(visibleText(html)).not.toContain("Live trades");
  });

  it("lists today's closed trades with R, P&L in the account currency and Write review", async () => {
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Closed today 1");
    expect(text).toContain("Exit 06:20");
    expect(text).toContain("+1.20R +$120.00 Closed · review pending");
    expect(hrefs(html)).toContain(`/trades/${closedWin.id}#review`);
  });

  it("never shows raw ids, hashes, rule codes or enums in visible text", async () => {
    const text = visibleText(await render());
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(ENUM);
    expect(text).not.toMatch(/\b(LIVE_FIRST|PLANNED|DRAFT|BLOCKED|LOCKED|APPROVED|RISK_LIMIT|KILL_ZONE)\b/);
  });

  it("offers no paid AI action and runs nothing on load (identical with AI on or off)", async () => {
    const html = await render();
    expect(html).not.toContain("≈");
    expect(html).not.toMatch(/Analyze|Challenge my bias|Review this trade with AI/);
  });

  it("formats times in the person's time display while the day stays the UTC−5 strategy day", async () => {
    m.timeDisplay = { mode: "utc" };
    const text = visibleText(await render());
    expect(text).toContain("Fri, Oct 23 (UTC−5)");
    expect(text).toContain("Times in UTC");
    expect(text).toContain("Entered 12:05");
    expect(text).toContain("Exit 11:20");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Trading status states
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · trading status", () => {
  it("blocks in the Dead Pool with the engine's sentence and the boundary in the ribbon", async () => {
    vi.setSystemTime(new Date(DEAD_POOL_NOW));
    m.getToday.mockResolvedValue(todayData({ now: DEAD_POOL_NOW, accounts: [status(workspace(FTMO_ACCOUNT, { now: DEAD_POOL_NOW }))], closed: [closedWin] }));
    const text = visibleText(await render());
    expect(text).toContain("Trading blocked: Dead Pool until 18:00");
    expect(text).toContain(`Blocking ${RISK_COPY.DEAD_POOL.sentence}`);
    expect(text).toContain("Next: Asia at 18:00, in 4h");
    expect(text).toContain("Dead Pool 12:00–18:00");
  });

  it("asks to confirm today's balance with one click, or new values, when the last values are from another day", async () => {
    m.getToday.mockResolvedValue(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { observationDay: "2026-10-22" }))], closed: [closedWin] }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Trading blocked: confirm today's balance");
    expect(text).toContain("Blocking Confirm today's account balance before locking (last recorded Oct 22).");
    // The one-click confirmation names the values it records (spec §8.4).
    expect(html).toContain('aria-label="Confirm unchanged: FTMO 100K, Balance $111,132.01 · Equity $111,250.50 (recorded Oct 22)"');
    expect(html).toContain('aria-label="Update values: FTMO 100K"');
    expect(text).toContain("Confirm today's balance");
    expect(text).toContain("Recorded Oct 22");
  });

  it("says when the daily trade limit is reached and that no trades are left", async () => {
    m.getToday.mockResolvedValue(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { usage: { plannedSlots: 1, unplannedTrades: 1 } }))], closed: [closedWin] }));
    const text = visibleText(await render());
    expect(text).toContain("Daily trade limit reached");
    expect(text).toContain("Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live).");
    expect(text).toContain("Trades left 0 of 2");
  });

  it("never judges usage of another strategy day: only a refresh, no numbers", async () => {
    m.getToday.mockResolvedValue(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { usage: { day: "2026-10-22" } }))], closed: [closedWin] }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain(STALE_USAGE_HEADLINE);
    expect(text).toContain("Daily usage was computed for Oct 22, not for today (Oct 23).");
    expect(text).toContain("Refresh");
    expect(text).not.toContain("Trades left");
    expect(text).not.toContain("You can trade");
  });

  it("explains a missing risk plan and missing instruments with the way to fix them", async () => {
    m.getToday.mockResolvedValue(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { riskPlan: false, gaps: ["RISK_PLAN", "INSTRUMENTS"] }))], closed: [closedWin] }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Set up a risk plan to trade");
    expect(text).toContain("This account has no risk plan yet. Create one to check and lock plans.");
    expect(hrefs(html)).toContain(`/accounts/${FTMO}/manage?tab=risk-policy`);
    expect(hrefs(html)).toContain(`/accounts/${FTMO}/manage?tab=instruments`);
  });

  it("counts an earlier manual loss total toward the limit when it is larger, and says so", async () => {
    m.getToday.mockResolvedValue(todayData({
      accounts: [status(workspace(FTMO_ACCOUNT, { usage: { realizedLoss: "20", legacyReportedLoss: "80" } }))], closed: [closedWin],
    }));
    const text = visibleText(await render());
    expect(text).toContain("Realized losses today $20.00");
    expect(text).toContain("Counted toward the limit: $80.00, from an earlier manual entry.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Live-first trades without risk
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · live-first positions", () => {
  it("shows what is not recorded, why R needs a risk, and the way to add entry details", async () => {
    m.context = accountContext(PERSONAL_ACCOUNT);
    m.getToday.mockResolvedValue(todayData({
      context: accountContext(PERSONAL_ACCOUNT), live: [liveCard(liveFirstNoRisk)],
      accounts: [status(workspace(PERSONAL_ACCOUNT, { usage: { unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 1 } }))],
    }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("DE40 · Short Live Live-first");
    expect(html).toContain('title="No pre-trade plan was recorded before execution."');
    expect(text).toContain("Recorded 07:40 · entry time not recorded");
    expect(text).toContain("Entry Not recorded");
    expect(text).toContain("Initial risk Not recorded");
    expect(text).toContain(RISK_NOT_RECORDED_HINT);
    expect(text).toContain("No journal entries yet.");
    expect(hrefs(html).filter(href => href === `/trades/${liveFirstNoRisk.id}#entry-details`).length).toBeGreaterThanOrEqual(2);
    // The engine's warning carries the same way to fix it.
    expect(text).toContain("Warning 1 live-first trade without recorded risk is not included in the daily risk totals.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// All Accounts
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · All Accounts", () => {
  beforeEach(() => {
    m.context = allContext();
    m.getToday.mockResolvedValue(todayData({
      context: allContext(),
      accounts: [
        status(workspace(FTMO_ACCOUNT)),
        status(workspace(PERSONAL_ACCOUNT, { observationDay: "2026-10-22", usage: { realizedLoss: "40" }, plan: { dailyRiskCap: null } })),
      ],
      live: [liveCard(livePlanned), liveCard(liveFirstNoRisk)],
      closed: [closedWin, closedLossEur],
    }));
  });

  it("shows one compact row per active account and the day across accounts without converting money", async () => {
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("All Accounts · 2 active trading accounts");
    expect(text).toContain("Trading status · All Accounts");
    expect(text).toContain("1 of 2 accounts blocked");
    expect(text).toContain("R is per-trade risk units, not money.");
    // R across accounts first, then money per currency (ordered by currency code), never converted.
    expect(text).toContain("Today's result +1.20R -€40.00 +$120.00");
    expect(text).toContain("2 trades closed today · 1 without R");
    expect(text).toContain("Realized losses today €40.00 · $0.00");
    expect(text).toContain("FTMO 100K Evaluation · FTMO · USD");
    expect(text).toContain("Personal 12K Personal · IC Markets · EUR");
    expect(text).toContain("Trading blocked: confirm today's balance");
    expect(text).toContain("Risk left No daily cap");
    expect(html).toContain('aria-label="More actions for Personal 12K"');
    expect(hrefs(html)).toContain(`/today?account=${FTMO}`);
    expect(hrefs(html)).toContain(`/today?account=${PERSONAL}`);
  });

  it("names the account on every live, waiting and closed row", async () => {
    const text = visibleText(await render());
    expect(text).toContain("FTMO 100K · Entered 07:05");
    expect(text).toContain("Personal 12K · Recorded 07:40");
    expect(text).toContain("Personal 12K · Exit 05:00");
    expect(text).toContain(NO_R_COPY);
  });

  it("counts a loss an archived account closed today in today's realized losses, as in today's result, and says so", async () => {
    // Archiving leaves a live position to be closed; the archived account then has no row below the summary.
    const archived = { ...PERSONAL_ACCOUNT, status: "ARCHIVED" as const };
    m.context = allContext([FTMO_ACCOUNT, archived]);
    // The loader adds the archived account's losses from its daily usage: the €40.00 trade and €12.50 entered as external.
    const archivedLosses = { currency: "EUR", realized: "40", external: "12.5", legacyReported: null, total: "52.5" };
    m.getToday.mockResolvedValue(todayData({
      context: allContext([FTMO_ACCOUNT, archived]), accounts: [status(workspace(FTMO_ACCOUNT))], closed: [closedWin, closedLossEur], outsideLosses: [archivedLosses],
    }));
    const text = visibleText(await render());
    expect(text).toContain("All Accounts · 1 active trading account");
    expect(text).toContain("Today's result +1.20R -€40.00 +$120.00");
    expect(text).toContain("2 trades closed today · 1 without R · 1 on an archived account");
    expect(text).toContain("Realized losses today €52.50 · $0.00 Including external losses");
  });

  it("links to each account's notes instead of mixing them", async () => {
    const html = await render();
    expect(visibleText(html)).toContain(NOTES_ALL_ACCOUNTS_COPY);
    expect(html).not.toContain('name="narrative"');
  });

  it("never shows raw ids or enums", async () => {
    const text = visibleText(await render());
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(ENUM);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Account names of up to 100 characters (the create form, the profile rename and the database all allow them)
// ---------------------------------------------------------------------------------------------------------------------
// (The trade header's and the trade forms' account chips: tests/v2-ui-account-name-chips.test.ts.)
describe("100-character account names on a phone (Today)", () => {
  const LONG_FTMO = "FTMO Challenge Phase 2 · 200K Swing (Aggressive) · EURUSD and GBPUSD focus · London and NY sessions.";
  const LONG_PERSONAL = "Personal IC Markets 12K · cTrader · DE40 and NAS100 index scalps · no news trading · Mon to Fri only";
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** Every element whose whole text is `name` (with a separator around it): its opening tag's attributes. */
  const nameBoxes = (html: string, name: string) =>
    [...html.matchAll(new RegExp(`<(\\w+)((?:\\s[^>]*)?)>[ ]?(?:<!-- -->)?${escapeRegExp(name)}(?:<!-- -->)?[ ·]*</\\1>`, "g"))].map(match => match[2]);

  it("cuts every account name Today prints with an ellipsis instead of widening the screen, and keeps the whole name in its tooltip", async () => {
    expect([LONG_FTMO.length, LONG_PERSONAL.length]).toEqual([100, 100]);
    const ftmo = { ...FTMO_ACCOUNT, name: LONG_FTMO };
    const personal = { ...PERSONAL_ACCOUNT, name: LONG_PERSONAL };
    const names: Record<string, string> = { [FTMO]: LONG_FTMO, [PERSONAL]: LONG_PERSONAL };
    const data = todayData({
      context: allContext([ftmo, personal]),
      accounts: [status(workspace(ftmo)), status(workspace(personal, { usage: { realizedLoss: "40" } }))],
      live: [liveCard(livePlanned), liveCard(liveFirstNoRisk)],
      locked: [lockedPlan],
      closed: [closedWin, closedLossEur],
    });
    const rename = (row: TradeListRow): TradeListRow => ({ ...row, account: { ...row.account, name: names[row.account.id] } });
    data.live = data.live.map(card => ({ ...card, row: rename(card.row) }));
    data.plans = { ...data.plans, locked: data.plans.locked.map(rename) };
    data.closedToday = data.closedToday.map(rename);
    m.context = allContext([ftmo, personal]);
    m.getToday.mockResolvedValue(data);
    const html = await render();

    // Live cards, the waiting plan, the closed rows, the status rows and the notes chips all name their account.
    const boxes = [...nameBoxes(html, LONG_FTMO), ...nameBoxes(html, LONG_PERSONAL)];
    expect(boxes.length).toBeGreaterThanOrEqual(9);
    for (const attributes of boxes) {
      expect(attributes).toMatch(/class="[^"]*\btruncate\b/);
      expect(attributes).toMatch(new RegExp(`title="[^"]*(${escapeRegExp(LONG_FTMO)}|${escapeRegExp(LONG_PERSONAL)})"`));
    }
    // A name inside a line of facts never gets wider than that line.
    const inLine = boxes.filter(attributes => /\binline-block\b/.test(attributes));
    expect(inLine.length).toBeGreaterThanOrEqual(5);
    for (const attributes of inLine) expect(attributes).toMatch(/\bmax-w-full\b/);
    // Each notes chip shrinks to the card's width: the list item and its link may not grow past it.
    const chips = html.slice(html.indexOf('aria-label="Write today&#x27;s plan for"'));
    expect(chips.match(/<li class="max-w-full min-w-0"><a [^>]*class="[^"]*\bmax-w-full\b[^"]*"/g)).toHaveLength(2);
    // The text a person (or a screen reader) gets keeps the whole name.
    const text = visibleText(html);
    expect(text).toContain(`${LONG_FTMO} · Entered 07:05`);
    expect(text).toContain(`${LONG_PERSONAL} · Exit 05:00`);
  });

  it("shows the selected account's whole name in the page header and the status card, wrapping even a name without spaces", async () => {
    const unbroken = "Demo_100K_MetaTrader5_Raw_Spread_EURUSD_GBPUSD_XAUUSD_London_and_NewYork_sessions_only_no_news_trade";
    expect(unbroken.length).toBe(100);
    const demo = { ...FTMO_ACCOUNT, name: unbroken };
    m.context = accountContext(demo);
    m.getToday.mockResolvedValue(todayData({ context: accountContext(demo), accounts: [status(workspace(demo))] }));
    const html = await render();
    expect(html).toMatch(new RegExp(`<span class="[^"]*\\bbreak-words\\b[^"]*">${unbroken}</span>`));
    expect(html).toMatch(new RegExp(`<h2 [^>]*class="[^"]*\\bbreak-words\\b[^"]*">(?:(?!</h2>)[\\s\\S])*${unbroken}</h2>`));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Empty day, onboarding, archived accounts, lists
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · starting points and empty states", () => {
  it("leads an empty day with Plan Trade and Record Live Trade, one line each", async () => {
    m.getToday.mockResolvedValue(todayData());
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain(EMPTY_DAY_TITLE);
    expect(text).toContain(`Plan Trade ${PLAN_TRADE_COPY}`);
    expect(text).toContain(`Record Live Trade ${LIVE_TRADE_COPY}`);
    expect(hrefs(html)).toContain("/trades/new");
    expect(hrefs(html)).toContain("/trades/live/new");
    expect(text).not.toContain("Plans waiting");
    expect(text).not.toContain("Live trades");
  });

  it("explains empty lists on a day with some activity", async () => {
    m.getToday.mockResolvedValue(todayData({ live: [liveCard(livePlanned)] }));
    const text = visibleText(await render());
    expect(text).toContain(PLANS_EMPTY_TITLE);
    expect(text).toContain(CLOSED_EMPTY_TITLE);
  });

  it("onboards a person without any trading account with the account form", async () => {
    m.context = allContext([]);
    const html = await render();
    const text = visibleText(html);
    expect(m.getToday).not.toHaveBeenCalled();
    expect(text).toContain(ONBOARDING_TITLE);
    expect(html).toContain('aria-label="Create trading account"');
    expect(text).toContain("Account name");
    expect(text).toContain("Current balance");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("shows the way back when every account is archived", async () => {
    m.context = allContext([{ ...FTMO_ACCOUNT, status: "ARCHIVED" }]);
    const html = await render();
    expect(m.getToday).not.toHaveBeenCalled();
    expect(visibleText(html)).toContain(NO_ACTIVE_TITLE);
    expect(hrefs(html)).toContain("/accounts");
    expect(hrefs(html)).toContain("/accounts/new");
  });

  it("lists a few older drafts under their own label and folds many away", async () => {
    const older = (n: number) => ledger(300 + n, { created_at: "2026-10-20T12:00:00Z", latest_revision_at: "2026-10-20T12:00:00Z", symbol: `SYM${n}` });
    m.getToday.mockResolvedValue(todayData({ drafts: { unchecked: [uncheckedDraft, older(1), older(2)] } }));
    let html = await render();
    expect(visibleText(html)).toContain("Older drafts · not touched today");
    expect(html).not.toMatch(/<details[^>]*>\s*<summary[^>]*>[^<]*Older drafts/);
    expect(visibleText(html)).toContain("1 draft today · 2 older drafts");

    const many = Array.from({ length: OLDER_DRAFTS_INLINE + 2 }, (_, index) => older(index + 1));
    m.getToday.mockResolvedValue(todayData({ drafts: { unchecked: many } }));
    html = await render();
    expect(visibleText(html)).toContain(`Older drafts · not touched today (${OLDER_DRAFTS_INLINE + 2})`);
    expect(html).toContain("<details");
  });

  it("says when a list reached its bound and points to the Journal", async () => {
    m.getToday.mockResolvedValue(todayData({ locked: [lockedPlan], live: [liveCard(livePlanned)], truncated: { drafts: true, live: true } }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Today shows the newest plans and drafts.");
    expect(text).toContain("Every live trade in the Journal");
    expect(hrefs(html)).toContain("/journal?state=draft%2Clocked");
    expect(hrefs(html)).toContain("/journal?state=live");
  });

  it("keeps today's plan · notes with the saved text and when it was saved", async () => {
    m.getToday.mockResolvedValue(todayData({ live: [liveCard(livePlanned)], dailyContext: { narrative: "Bias: bearish below 1.1650.", recordedAt: "2026-10-23T11:10:00Z" } }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain(NOTES_TITLE);
    expect(text).toContain("Saved 06:10");
    expect(html).toContain("Bias: bearish below 1.1650.");
    expect(html).toMatch(/<details[^>]*open/);
  });

  it("renders a loading state shaped like the screen", () => {
    const html = renderToStaticMarkup(TodayRouteLoading());
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Today");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// How live positions were managed, plans from earlier days, and what Confirm unchanged records
// ---------------------------------------------------------------------------------------------------------------------
const managementEntry = (n: number, tradeId: string, kind: "STOP_CHANGE" | "PARTIAL_CLOSE", details: Record<string, string>, recordedAt: string) => ({
  id: uuid(500 + n), trade_id: tradeId, kind, details, recorded_at: recordedAt,
});
/** The opening tag of the link to `href`. */
const anchorTo = (html: string, href: string) => html.match(new RegExp(`<a [^>]*href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`))?.[0] ?? "";

describe("Today · how a live position was managed", () => {
  it("shows the stop as moved (at entry, with the initial stop), what was closed, and the initial risk as 1R", async () => {
    m.tables.trade_journal_entries = [
      managementEntry(1, livePlanned.id, "STOP_CHANGE", { price: "1.099" }, "2026-10-23T12:20:00Z"),
      managementEntry(2, livePlanned.id, "STOP_CHANGE", { price: "1.1" }, "2026-10-23T12:40:00Z"),
      managementEntry(3, livePlanned.id, "PARTIAL_CLOSE", { percent: "30", price: "1.104" }, "2026-10-23T12:30:00Z"),
    ];
    const text = visibleText(await render());
    expect(text).toContain("Size 0.50 lots 30% closed");
    // The newest move wins: the stop sits at the entry price, and the initial stop stays in view.
    expect(text).toContain("Stop 1.10000 At entry Moved 07:40 Initial 1.09800");
    expect(text).not.toContain("Initial stop 1.09800");
    expect(text).toContain("Initial risk $500.00 1R · 0.50% planned");
  });

  it("adds closed sizes exactly, never adds percentages, and keeps the initial stop while the stop never moved", async () => {
    m.tables.trade_journal_entries = [
      managementEntry(1, livePlanned.id, "PARTIAL_CLOSE", { quantity: "0.1" }, "2026-10-23T12:20:00Z"),
      managementEntry(2, livePlanned.id, "PARTIAL_CLOSE", { quantity: "0.15" }, "2026-10-23T12:30:00Z"),
    ];
    let text = visibleText(await render());
    expect(text).toContain("Size 0.50 lots 0.25 lots closed");
    expect(text).toContain("Initial stop 1.09800");

    m.tables.trade_journal_entries = [
      managementEntry(1, livePlanned.id, "PARTIAL_CLOSE", { percent: "30" }, "2026-10-23T12:20:00Z"),
      managementEntry(2, livePlanned.id, "PARTIAL_CLOSE", { percent: "50" }, "2026-10-23T12:30:00Z"),
    ];
    text = visibleText(await render());
    expect(text).toContain("Size 0.50 lots 2 partial closes");
  });

  it("still renders every blocking reason, with the initial stop labelled as such, when the journal can't be read", async () => {
    m.tables.trade_journal_entries = [{ id: "not-a-journal-row" }];
    const text = visibleText(await render());
    expect(text).toContain("Initial stop 1.09800");
    expect(text).toContain("Blocked: Requested risk 1.00% exceeds your configured maximum of 0.50%.");
  });

  it("labels the phone dock's link with what it does", async () => {
    const html = await render();
    const dock = html.slice(html.indexOf('aria-label="Quick actions for a live trade"'));
    expect(dock).toMatch(/>Close trade<\/a>/);
  });
});

describe("Today · plans from an earlier day", () => {
  const staleBlocked = ledger(10, {
    symbol: "GBPUSD", requested_risk_percent: "1", latest_revision: 2, created_at: "2026-10-22T13:00:00Z", latest_revision_at: "2026-10-22T14:00:00Z",
    latest_check_decision: "BLOCKED", latest_check_at: "2026-10-22T14:00:30Z", latest_check_evaluation_id: EVALUATION, draft_check: "BLOCKED",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106",
  });
  const earlierLocked = ledger(11, {
    symbol: "XAUUSD", direction: "SHORT", entry_model: "OTE", plan_id: uuid(111), locked_at: "2026-10-22T15:52:00Z", plan_trading_day: "2026-10-22",
    lifecycle: "LOCKED", draft_check: null, planned_entry: "2415.5", planned_stop: "2420", planned_target: "2400", planned_risk: "500", instrument_version_id: null,
  });

  it("says a block found on an earlier day describes that day, and offers the free re-check as its next step", async () => {
    m.getToday.mockResolvedValue(todayData({ drafts: { blocked: [blockedDraft, staleBlocked] } }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("When checked on Oct 22: Requested risk 1.00% exceeds your configured maximum of 0.50%.");
    expect(html).toContain('aria-label="Recheck risk: GBPUSD · Long"');
    // Edit draft stays beside it as the quieter choice.
    expect(anchorTo(html, `/trades/${staleBlocked.id}/edit`)).toContain("btn-ghost");
    // A block found today keeps its reason as a block, with Edit draft as its next step.
    expect(text).toContain("Blocked: Requested risk 1.00% exceeds your configured maximum of 0.50%.");
    expect(anchorTo(html, `/trades/${blockedDraft.id}/edit`)).toContain("btn-secondary");
    expect(html.match(/aria-label="Recheck risk: /g)).toHaveLength(1);
  });

  it("leads a draft blocked today only by what no edit clears with the step that does, Edit draft beside it, as its trade page does", async () => {
    const deadPool = { ...blockedDraft, id: uuid(13), symbol: "USDJPY" };
    const data = todayData({ drafts: { blocked: [blockedDraft, deadPool] } });
    // The loader gives each blocked draft the findings of its check (`withBlockedPlanActions`, tests/v2-screen-today-loader.test.ts).
    const findings: Record<string, { code: string }[]> = { [blockedDraft.id]: [{ code: "STALE_EQUITY" }], [deadPool.id]: [{ code: "DEAD_POOL" }] };
    data.plans.blocked = data.plans.blocked.map(entry => ({ ...entry, state: withBlockingFindings(entry.state, findings[entry.id]) }));
    m.getToday.mockResolvedValue(data);
    const html = await render();
    // Stale account values: confirmed on the account's Manage screen, the trade page's own link.
    const confirm = html.match(/<a [^>]*aria-label="Confirm account values: GBPUSD · Long"[^>]*>/)?.[0] ?? "";
    expect(confirm).toContain(`href="/accounts/${FTMO}/manage?tab=account-values"`);
    expect(confirm).toContain("btn-secondary");
    expect(html).not.toContain('aria-label="Open: GBPUSD · Long"');
    // Dead Pool: the free recheck once it ends.
    expect(html).toContain('aria-label="Recheck risk: USDJPY · Long"');
    for (const draft of [blockedDraft, deadPool]) expect(anchorTo(html, `/trades/${draft.id}/edit`)).toContain("btn-ghost");
  });

  it("offers no check and no edit on an archived account's draft blocked on an earlier day, as the trade page does", async () => {
    const archivedAccount = { ...PERSONAL_ACCOUNT, status: "ARCHIVED" as const };
    const frozen = { ...staleBlocked, id: uuid(12), account_id: PERSONAL, currency: "EUR", symbol: "DE40", instrument_version_id: DE40 };
    m.context = allContext([FTMO_ACCOUNT, archivedAccount]);
    const data = todayData({ context: allContext([FTMO_ACCOUNT, archivedAccount]), drafts: { blocked: [staleBlocked, frozen] } });
    // The data layer derives every row's state with its account's status (src/lib/trades-data.ts).
    data.plans.blocked = data.plans.blocked.map(entry => entry.id === frozen.id
      ? { ...entry, account: { ...entry.account, status: "ARCHIVED" as const }, state: deriveTradeState(frozen, { now: NOW, checkCurrent: false, accountArchived: true }) }
      : entry);
    m.getToday.mockResolvedValue(data);
    const html = await render();
    expect(visibleText(html)).toContain("DE40 · Long Account archived");
    // The database refuses its check and its revision (ACCOUNT_ARCHIVED): neither is offered.
    expect(html).not.toContain(`/trades/${frozen.id}/edit`);
    expect(html).not.toContain('aria-label="Recheck risk: DE40 · Long"');
    // The active account's draft keeps the free recheck first, with Edit draft beside it.
    expect(html).toContain('aria-label="Recheck risk: GBPUSD · Long"');
    expect(anchorTo(html, `/trades/${staleBlocked.id}/edit`)).toContain("btn-ghost");
  });

  it("lists plans locked on an earlier day apart from today's, with Record entry as a choice beside Skip", async () => {
    m.getToday.mockResolvedValue(todayData({ locked: [lockedPlan, earlierLocked] }));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("1 locked · 1 locked earlier");
    expect(text).toContain(`${EARLIER_LOCKED_LABEL} ${EARLIER_LOCKED_NOTE}`);
    expect(text).toContain("Locked Oct 22, 10:52 · Entry 2415.5");
    expect(html).toContain('aria-label="Skip this trade: XAUUSD · Short"');
    expect(anchorTo(html, `/trades/${lockedPlan.id}#record-entry`)).toContain("btn-primary");
    expect(anchorTo(html, `/trades/${earlierLocked.id}#record-entry`)).toContain("btn-secondary");
    // Today's plan first, then the earlier one under its label.
    expect(html.indexOf(`/trades/${lockedPlan.id}`)).toBeLessThan(html.indexOf(EARLIER_LOCKED_LABEL));
    expect(html.indexOf(EARLIER_LOCKED_LABEL)).toBeLessThan(html.indexOf(`/trades/${earlierLocked.id}`));
  });

  it("folds many plans locked on earlier days away", async () => {
    const many = Array.from({ length: OLDER_DRAFTS_INLINE + 1 }, (_, index) => ({ ...earlierLocked, id: uuid(400 + index), plan_id: uuid(600 + index) }));
    m.getToday.mockResolvedValue(todayData({ locked: many }));
    const html = await render();
    expect(visibleText(html)).toContain(`${EARLIER_LOCKED_LABEL} (${OLDER_DRAFTS_INLINE + 1})`);
    expect(html).toContain("<details");
  });
});

describe("Today · Confirm unchanged shows what it records", () => {
  it("puts the values and their day beside the button of an All Accounts row, and into its accessible name", async () => {
    m.context = allContext();
    m.getToday.mockResolvedValue(todayData({
      context: allContext(),
      accounts: [status(workspace(FTMO_ACCOUNT)), status(workspace(PERSONAL_ACCOUNT, { observationDay: "2026-10-22" }))],
      closed: [closedWin],
    }));
    const html = await render();
    const text = visibleText(html);
    // Wide rows: the button, then the values it records; phones: the values first, then the button.
    expect(text).toContain("Confirm unchanged Balance €12,440.23 · Equity €12,440.23 Recorded Oct 22");
    expect(text).toContain("Balance €12,440.23 · Equity €12,440.23 Recorded Oct 22 Confirm unchanged");
    expect(html).toContain('aria-label="Confirm unchanged: Personal 12K, Balance €12,440.23 · Equity €12,440.23 (recorded Oct 22)"');
    // The row's name link is where focus goes once the confirmed reason leaves.
    expect(html).toContain(`id="today-account-${PERSONAL}"`);
  });

  it("opens the account's dialogs from buttons that announce a dialog", async () => {
    const html = await render();
    expect(html).toContain('aria-haspopup="dialog" aria-label="Add external loss: FTMO 100K"');
    expect(html).toContain('aria-haspopup="dialog" aria-label="Update values: FTMO 100K"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// View model and session ribbon (pure)
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · view model", () => {
  const view = (data: TodayData) => buildTodayView({ data, display: { mode: "strategy" }, instruments: new Map(), blockingReasons: new Map(), requestKey: () => uuid(999) });

  it("rounds risk left down so it never promises more room than the engine allows", () => {
    const data = todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { usage: { plannedRisk: "333.337" }, plan: { dailyRiskCap: "1000" } }))] });
    const stats = view(data).status[0].stats;
    expect(stats?.risk.values[0].text).toBe("$666.66");
    expect(stats?.risk.hint).toBe("$333.33 of $1,000.00 cap reserved");
  });

  it("shows money at risk rounded up to the cent, as the trade page and the engine do: a plan's risk at the stop, a position's 1R", () => {
    const draft = { ...readyDraft, planned_risk: "530.452" };
    const live = { ...livePlanned, initial_risk: "530.452" };
    const model = view(todayData({ live: [liveCard(live)], drafts: { ready: [draft] } }));
    expect(model.plans.current.find(entry => entry.id === draft.id)?.meta).toContain("Risk 0.50% ($530.46)");
    expect(model.live[0].facts.find(fact => fact.label === "Initial risk")?.value).toBe("$530.46");
    // Whole cents stay as they are.
    expect(view(todayData({ live: [liveCard(livePlanned)] })).live[0].facts.find(fact => fact.label === "Initial risk")?.value).toBe("$500.00");
  });

  it("keeps today's losses on their side of the daily loss limit shown beside them", () => {
    const losses = (usage: Partial<DailyUsage>) => view(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { usage, plan: { dailyLossCap: "500" } }))] })).status[0].stats?.losses;
    // Just under the limit: rounding half-up would print the limit itself while trading is still allowed.
    const under = losses({ realizedLoss: "499.996" });
    expect([under?.realized, under?.combined, under?.limit]).toEqual(["$499.99", "$499.99", "Daily loss limit $500.00"]);
    // Reaching it reads as reaching it.
    const reached = losses({ realizedLoss: "480", externalLoss: "20.004" });
    expect([reached?.realized, reached?.combined]).toEqual(["$480.00", "$500.00"]);
    // Without a loss limit, plain money.
    const none = view(todayData({ accounts: [status(workspace(FTMO_ACCOUNT, { usage: { realizedLoss: "12.345" }, plan: { dailyLossCap: null } }))] })).status[0].stats?.losses;
    expect([none?.realized, none?.limit]).toEqual(["$12.35", "No daily loss limit"]);
  });

  it("rounds today's losses half up like the day's result, the summary and the account dashboard, away from the limit", () => {
    // DE40 at 1.85 lots closed for −26.825: every other figure of the same loss reads €26.83.
    const closedHalfCent = { ...closedLossEur, net_pnl: "-26.825", realized_r: "-0.52" };
    const data = todayData({
      context: allContext(),
      accounts: [
        status(workspace(FTMO_ACCOUNT)),
        status(workspace(PERSONAL_ACCOUNT, { usage: { realizedLoss: "26.825" }, plan: { dailyLossCap: "150" } })),
      ],
      closed: [closedHalfCent],
    });
    const model = view(data);
    const personal = model.status.find(row => row.accountId === PERSONAL)?.stats;
    expect([personal?.losses.realized, personal?.losses.combined, personal?.losses.limit]).toEqual(["€26.83", "€26.83", "Daily loss limit €150.00"]);
    expect(personal?.result.values.map(value => value.text)).toEqual(["-0.52R", "-€26.83"]);
    expect(model.summary?.losses).toBe("€26.83 · $0.00");
    // Half up still never crosses the limit: €149.995 is under a €150 limit, €150 reaches it.
    const near = (realizedLoss: string) => view(todayData({ accounts: [status(workspace(PERSONAL_ACCOUNT, { usage: { realizedLoss }, plan: { dailyLossCap: "150" } }))] })).status[0].stats?.losses.realized;
    expect([near("149.994"), near("149.995"), near("150"), near("150.005")]).toEqual(["€149.99", "€149.99", "€150.00", "€150.01"]);
  });

  it("adds realized and external losses per account and keeps currencies apart", () => {
    const data = todayData({
      context: allContext(),
      accounts: [status(workspace(FTMO_ACCOUNT, { usage: { realizedLoss: "10.5", externalLoss: "4.25" } })), status(workspace(PERSONAL_ACCOUNT, { usage: { realizedLoss: "7" } }))],
    });
    const model = view(data);
    expect(model.status[0].stats?.losses.combined).toBe("$14.75");
    expect(model.summary?.losses).toBe("€7.00 · $14.75");
  });

  it("covers the same accounts in both figures of the day: an archived account's trades closed today count in the losses too", () => {
    const archived = { ...PERSONAL_ACCOUNT, status: "ARCHIVED" as const };
    const demo = account("20000000-0000-4000-8000-000000000003", "Demo 100K", "USD", { status: "ARCHIVED" });
    const on = (owner: ContextAccount, trade: LedgerTrade): LedgerTrade => ({ ...trade, account_id: owner.id, currency: owner.currency });
    // Archived accounts finish the positions they hold; they have no status row (no workspace) in All Accounts.
    const eurLoss = on(archived, closedLossEur);
    const eurWin = on(archived, { ...closedLossEur, id: uuid(20), net_pnl: "15.5", outcome: "WIN" });
    const usdLoss = on(demo, { ...closedLossEur, id: uuid(21), net_pnl: "-295", realized_r: "-0.7867" });
    const yesterday = on(demo, { ...closedLossEur, id: uuid(22), net_pnl: "-1000", exited_at: "2026-10-22T15:00:00Z" });
    // Their losses come from their daily usage, as a row's do (src/lib/today-data.ts): Demo also has $85 entered as external.
    const loss = (currency: string, realized: string, external = "0") => ({ currency, realized, external, legacyReported: null, total: new Decimal(realized).plus(external).toFixed() });
    const data = todayData({
      context: allContext([FTMO_ACCOUNT, archived, demo]),
      accounts: [status(workspace(FTMO_ACCOUNT, { usage: { realizedLoss: "10.5", externalLoss: "4.25" } }))],
      closed: [closedWin, eurLoss, eurWin, usdLoss, yesterday],
      outsideLosses: [loss("EUR", "40"), loss("USD", "295", "85")],
    });
    const model = view(data);
    // The result counts today's exits only: +€15.50 − €40.00 and +$120.00 − $295.00.
    expect(model.summary?.money.map(value => value.text)).toEqual(["-€24.50", "-$175.00"]);
    // The active row's figures and the archived accounts', realized and external, per currency.
    expect(model.summary?.losses).toBe("€40.00 · $394.75");
    expect(model.summary?.detail).toBe("4 trades closed today · 2 without R · 3 on archived accounts");
    expect(model.status.map(row => row.stats?.losses.combined)).toEqual(["$14.75"]);

    const one = todayData({ context: allContext([FTMO_ACCOUNT, archived]), accounts: [status(workspace(FTMO_ACCOUNT))], closed: [closedWin, eurWin], outsideLosses: [loss("EUR", "0")] });
    expect(view(one).summary?.losses).toBe("€0.00 · $0.00");
    expect(view(one).summary?.detail).toBe("2 trades closed today · 1 without R · 1 on an archived account");
  });

  it("labels account types in words", () => {
    expect(view(todayData()).context.detail).toBe(`${ACCOUNT_TYPE_LABELS.EVALUATION} · FTMO · USD`);
  });

  it("walks the strategy day through its sessions with exact boundaries", () => {
    const segments = daySegments(DAY).map(segment => `${segment.label} ${segment.fromLabel}–${segment.toLabel}`);
    expect(segments).toEqual(["Asia 00:00–01:00", "Judas 01:00–02:00", "Kill zone 02:00–12:00", "Dead Pool 12:00–18:00", "Asia 18:00–24:00"]);
    const model = ribbonModel(Date.parse(NOW));
    expect(model.sessionLabel).toBe("Kill zone");
    expect(model.segments.find(segment => segment.current)?.label).toBe("Kill zone");
    expect(model.next).toMatchObject({ label: "Dead Pool", time: "12:00", countdown: "4h", nextDay: false });
    expect(ribbonModel(Date.parse("2026-10-23T23:30:00Z")).next).toMatchObject({ label: "Judas", time: "01:00", nextDay: true });
  });

  it("asks for a fresh render once a session boundary or the strategy midnight has passed", () => {
    expect(renderOutdated(NOW, Date.parse(NOW) + 60_000)).toBe(false);
    expect(renderOutdated(NOW, Date.parse("2026-10-23T17:00:00Z"))).toBe(true);
    expect(renderOutdated("2026-10-23T23:30:00Z", Date.parse("2026-10-24T05:00:01Z"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Today's plan · notes action
// ---------------------------------------------------------------------------------------------------------------------
describe("Today · saveDailyContext", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const accountRows = (status: "ACTIVE" | "ARCHIVED" = "ACTIVE") => ({
    accounts: [{ id: FTMO, name: "FTMO 100K", currency: "USD", created_at: "2026-09-01T10:00:00Z" }],
    account_profiles: [{ id: 1, account_id: FTMO, display_name: "FTMO 100K", broker: "FTMO", platform: "MT5", account_type: "EVALUATION", starting_balance: "100000", status }],
  });

  beforeEach(() => {
    m.rpc.mockImplementation(async (name: string) => (name === "trading_os_schema" ? { data: "2.0", error: null } : { data: uuid(900), error: null }));
  });

  it("saves the notes as a new revision with plain line breaks and refreshes Today", async () => {
    m.tables = accountRows();
    const result = await saveDailyContext(idleState, form({ accountId: FTMO.toUpperCase(), narrative: "Bias: short\r\nLevels: PDH" }));
    expect(result).toEqual({ status: "success", message: NOTES_SAVED_COPY });
    expect(m.rpc).toHaveBeenCalledWith("save_daily_context", { p_account_id: FTMO, p_narrative: "Bias: short\nLevels: PDH" });
    expect(m.revalidatePath).toHaveBeenCalledWith("/today");
  });

  it("refuses notes over 20,000 characters, unknown or archived accounts, and an outdated database", async () => {
    m.tables = accountRows();
    const long = await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x".repeat(20_001) }));
    expect(long).toMatchObject({ status: "error", fieldErrors: { narrative: "Keep today's plan to 20,000 characters." } });

    m.tables = { accounts: [], account_profiles: [] };
    expect(await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x" }))).toMatchObject({ status: "error", fieldErrors: { accountId: expect.any(String) } });

    m.tables = accountRows("ARCHIVED");
    expect(await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x" }))).toMatchObject({ status: "error", message: expect.stringContaining("archived") });

    m.rpc.mockImplementation(async () => ({ data: "1.0", error: null }));
    m.tables = accountRows();
    expect(await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x" }))).toMatchObject({ status: "error", message: expect.stringContaining("Database update required") });
    expect(m.rpc).not.toHaveBeenCalledWith("save_daily_context", expect.anything());
  });

  it("maps database errors to human copy and never shows them raw", async () => {
    m.tables = accountRows();
    m.rpc.mockImplementation(async (name: string) => (name === "trading_os_schema" ? { data: "2.0", error: null } : { data: null, error: { message: "Account not found" } }));
    expect(await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x" }))).toEqual({ status: "error", message: "That trading account isn't available." });
  });

  it("gives the archived-account copy when the database refuses an account archived after the page's check", async () => {
    // Active when the action read it, archived by the time save_daily_context ran (another tab): the RPC refuses (0015).
    m.tables = accountRows();
    m.rpc.mockImplementation(async (name: string) => (name === "trading_os_schema" ? { data: "2.0", error: null }
      : { data: null, error: { message: "ACCOUNT_ARCHIVED: This trading account is archived; restore it to add new trades or records" } }));
    expect(await saveDailyContext(idleState, form({ accountId: FTMO, narrative: "x" })))
      .toEqual({ status: "error", message: NOTES_ARCHIVED_COPY, fieldErrors: { accountId: NOTES_ARCHIVED_COPY } });
    expect(m.revalidatePath).not.toHaveBeenCalledWith("/today");
  });
});
