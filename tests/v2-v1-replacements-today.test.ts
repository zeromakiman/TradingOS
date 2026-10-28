import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// V2 replacement of the V1 status-banner tests (tests/ui-review.test.ts "renders the authoritative active label and
// binding reasons together", tests/ux.test.ts "keeps active-trade continuation while new locks are blocked",
// tests/ui-presentation.test.ts "separates active work from an idle ready day without hiding a restriction"): when new
// trades are blocked, Today states the block with every binding reason in the engine's words and still leads with the
// live trade and every action that manages it. Rendered from the real Today page with the data loader mocked.

const m = vi.hoisted(() => ({ getToday: vi.fn(), context: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/today",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/accounts", () => ({
  createTradingAccount: vi.fn(), recordAccountValues: vi.fn(), confirmAccountValuesUnchanged: vi.fn(), addExternalLoss: vi.fn(), removeExternalLoss: vi.fn(),
  updateProfile: vi.fn(), archiveAccount: vi.fn(), restoreAccount: vi.fn(), createInstrument: vi.fn(), createRiskPolicyVersion: vi.fn(),
}));
vi.mock("@/app/actions/trades", () => ({ checkRisk: vi.fn() }));
vi.mock("@/app/actions/journal", () => ({ addJournalEntry: vi.fn() }));
vi.mock("@/lib/account-context", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/account-context")>();
  const empty = () => {
    const self: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    for (const method of ["select", "eq", "in", "order", "limit", "or", "lte", "gte"]) self[method] = () => self;
    return self;
  };
  return {
    ...actual,
    currentSession: async () => ({ db: { from: empty, rpc: vi.fn() }, user: { id: "10000000-0000-4000-8000-000000000001" } }),
    getAccountContext: async () => m.context,
    getPreferences: async () => ({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false }),
  };
});
vi.mock("@/lib/today-data", () => ({ getToday: m.getToday }));

import TodayPage from "@/app/(app)/today/page";
import { dailyStatusV2 } from "@/domain/daily-status";
import { previewInstrument, previewRiskPlan, usageFixture } from "@/domain/fixtures";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { dayResult } from "@/domain/performance";
import { RISK_COPY } from "@/domain/risk-explain";
import { nextBoundary, strategyClock } from "@/domain/session";
import { strategyDay, strategyDayLabel } from "@/domain/time-display";
import { deriveTradeState } from "@/domain/trade-state";
import type { AccountContext, ContextAccount } from "@/lib/account-context";
import type { LiveTradeCard, TodayAccountStatus, TodayData } from "@/lib/today-data";
import { tradeDate, type TradeListRow } from "@/lib/trades-data";
import type { AccountWorkspace } from "@/lib/workspace";

const DEAD_POOL_NOW = "2026-10-23T19:00:00.000Z"; // Fri Oct 23, 14:00 UTC−5
const FTMO = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";

const FTMO_ACCOUNT: ContextAccount = {
  id: FTMO, name: "FTMO 100K", currency: "USD", type: "EVALUATION", platform: "MT5", broker: "FTMO", status: "ACTIVE", startingBalance: "100000",
  createdAt: "2026-09-01T10:00:00Z", profile: "PROFILE",
};
const CONTEXT: AccountContext = {
  accounts: [FTMO_ACCOUNT], active: [FTMO_ACCOUNT], archived: [], selected: { mode: "account", account: FTMO_ACCOUNT }, notice: null, noticeText: null,
  scopeAccountIds: [FTMO], formDefaultAccountId: FTMO,
};

function workspace(now: string, plannedSlots: number): AccountWorkspace {
  const day = strategyDay(now);
  const usage = usageFixture({ day, plannedSlots, plannedRisk: "1000" });
  const plan = { ...previewRiskPlan, maxDailyTrades: 2, dailyRiskCap: null, dailyLossCap: null };
  return {
    account: FTMO_ACCOUNT, now, day, usage, todaysPlans: [], gaps: [],
    observation: { id: "30000000-0000-4000-8000-000000000001", balance: "100000", equity: "100000", grossLossToday: null, tradingDay: day, recordedAt: `${day}T12:00:00Z` },
    riskPlan: { ...plan, effectiveDay: "2026-09-01", createdAt: "2026-09-01T10:00:00Z", overrideReason: null },
    strategy: { id: "30000000-0000-4000-8000-000000000002", version: "ICT V1.0", rules: {} },
    instruments: [previewInstrument],
    status: dailyStatusV2({ now, observationDay: day, currency: "USD", plan }, usage),
  };
}

const live: LedgerTrade = {
  ...(Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade),
  id: TRADE, account_id: FTMO, origin: "PLANNED", created_at: "2026-10-23T11:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
  latest_revision_at: "2026-10-23T11:00:00Z", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, symbol: "EURUSD", direction: "LONG",
  entry_model: "OB_FIRST_TOUCH", requested_risk_percent: "0.5", instrument_version_id: previewInstrument.id, plan_id: "a0000000-0000-4000-8000-000000000101",
  locked_at: "2026-10-23T11:30:00Z", entered_at: "2026-10-23T12:05:00Z", entry_recorded_at: "2026-10-23T12:06:00Z", entry_time_known: true, entry_price: "1.1",
  quantity: "0.5", initial_stop: "1.098", initial_risk: "500", planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", lifecycle: "LIVE", draft_check: null,
};

function row(trade: LedgerTrade, now: string): TradeListRow {
  const date = tradeDate(trade);
  return {
    id: trade.id, href: `/trades/${trade.id}`, trade, tradeAt: date.at, tradeDay: strategyDay(date.at), tradeDateSource: date.source,
    account: { id: FTMO, name: FTMO_ACCOUNT.name, currency: "USD", status: "ACTIVE" }, state: deriveTradeState(trade, { now, checkCurrent: false }), thumbnail: null,
    ai: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null },
  };
}

function today(now: string, plannedSlots: number, liveTrades: LedgerTrade[]): TodayData {
  const day = strategyDay(now);
  const space = workspace(now, plannedSlots);
  const status: TodayAccountStatus = {
    account: FTMO_ACCOUNT, workspace: space,
    losses: { currency: "USD", realized: space.usage.realizedLoss, external: space.usage.externalLoss, legacyReported: space.usage.legacyReportedLoss, total: space.usage.lossTotal },
  };
  const cards: LiveTradeCard[] = liveTrades.map(trade => ({ row: row(trade, now), liveSince: trade.entered_at ?? trade.created_at, lastJournal: null }));
  return {
    now, day, dayLabel: strategyDayLabel(day), session: strategyClock(now).session, boundary: nextBoundary(now), context: CONTEXT, accounts: [status], live: cards,
    plans: { ready: [], blocked: [], recheck: [], unchecked: [], locked: [] }, closedToday: [], result: dayResult([], day), losses: [status.losses], dailyContext: null,
    truncated: { live: false, locked: false, drafts: false, closed: false }, empty: cards.length === 0,
  };
}

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = (html: string) => decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<\/?(span|a|strong|em|b|abbr)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const render = async () => renderToStaticMarkup((await TodayPage()) as ReactElement);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(DEAD_POOL_NOW));
  m.context = CONTEXT;
});
afterEach(() => vi.useRealTimers());

describe("Today keeps live trades manageable while new trades are blocked", () => {
  it("states the block with every binding reason and still leads with the live trade and its actions", async () => {
    m.getToday.mockResolvedValue(today(DEAD_POOL_NOW, 2, [live]));
    const html = await render();
    const text = visibleText(html);
    // The authoritative status and every reason that binds, in the engine's own sentences, BLOCK first.
    expect(text).toContain("Daily trade limit reached");
    expect(text).toContain("Daily trade limit reached: 2 of 2 trades already used today (2 planned, 0 recorded live).");
    expect(text).toContain(RISK_COPY.DEAD_POOL.sentence);
    expect(text).toContain("Trades left 0 of 2");
    // Active work is not hidden by the restriction: the live trade comes first, with every way to manage it.
    expect(html.indexOf("today-live-title")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("today-live-title")).toBeLessThan(html.indexOf("today-status-title"));
    expect(text).toContain("EURUSD · Long Live");
    expect(html).toContain('aria-label="Add note: EURUSD · Long"');
    expect(html).toContain('aria-label="Paste screenshot: EURUSD · Long"');
    expect(html).toContain(`href="/trades/${TRADE}#close-trade"`);
    expect(html).toContain(`href="/trades/${TRADE}"`);
  });

  it("an idle blocked day shows the restriction without inventing active work", async () => {
    m.getToday.mockResolvedValue(today(DEAD_POOL_NOW, 2, []));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("Daily trade limit reached");
    expect(html).not.toContain("today-live-title");
    expect(html).not.toContain("Add note:");
  });
});
