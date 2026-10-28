import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Journal screen (docs/V2_ARCHITECTURE.md §14.5, §9.2, §13.7, §13.8, §15): the page is rendered from its real server
// components with the data loaders mocked (no database). The URL contract stays the real one (parseTradeFilters,
// journalHref), so drill-down links from EDGE, the calendar and Accounts are exercised end to end.

const m = vi.hoisted(() => ({
  listTrades: vi.fn(),
  countTrades: vi.fn(),
  context: null as unknown,
  timeDisplay: { mode: "strategy" } as { mode: "strategy" | "utc" | "local"; zone?: string },
  versionRows: { strategy_versions: [] as unknown[], risk_plan_versions: [] as unknown[] },
  dbCalls: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: vi.fn() }));
vi.mock("@/lib/ai-history", () => ({ loadTradeAiHistory: vi.fn(), timelineAiAnalyses: () => [] }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/journal",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/lib/account-context", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/account-context")>();
  // A PostgREST double for the version-name lookup: from(table).select().eq().eq().limit() → rows of that table.
  const db = {
    from: (table: "strategy_versions" | "risk_plan_versions") => {
      m.dbCalls.push(table);
      const chain = { select: () => chain, eq: () => chain, limit: async () => ({ data: m.versionRows[table], error: null }) };
      return chain;
    },
  };
  return {
    ...actual,
    currentSession: async () => ({ db, user: { id: USER } }),
    getAccountContext: async () => m.context,
    getPreferences: async () => ({ theme: "system", timeDisplay: m.timeDisplay, developerMode: false, sidebarCollapsed: false }),
  };
});
vi.mock("@/lib/trades-data", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/trades-data")>()), listTrades: m.listTrades, countTrades: m.countTrades,
}));

const USER = "10000000-0000-4000-8000-000000000001";

import JournalPage from "@/app/(app)/journal/page";
import JournalRouteLoading from "@/app/(app)/journal/loading";
import { ActiveFilterChips } from "@/components/journal/active-filter-chips";
import { FilterMenu, MoreFiltersMenu, TextForm } from "@/components/journal/filter-menu";
import { SheetForm } from "@/components/journal/filter-sheet";
import { formHref, isPlainClick, neighbourChip, searchFieldValue } from "@/components/journal/journal-nav";
import { readCursor, readTrail, trimToPage } from "@/components/journal/load-journal";
import { INSTRUMENT_PATTERN, OPTIONAL_INSTRUMENT_PATTERN, TAG_LIST_PATTERN, TAG_PATTERN } from "@/components/journal/patterns";
import type { FilterMenuView, JournalView } from "@/components/journal/types";
import { buildJournalView, datePresets, dayCountLabel, type JournalInput, rangeText, resultSummary, rowView, splitDays } from "@/components/journal/view-model";
import type { LedgerTrade } from "@/domain/ledger";
import { LEDGER_COLUMNS } from "@/domain/ledger";
import { strategyDay } from "@/domain/time-display";
import { deriveTradeState } from "@/domain/trade-state";
import type { AccountContext, ContextAccount } from "@/lib/account-context";
import {
  encodeTradeCursor, groupByTradeDay, JOURNAL_PAGE_SIZE, parseTradeFilters, TRADE_DATE_DEFINITION, type TradeFilters, type TradeListPage, type TradeListRow,
  tradeDate,
} from "@/lib/trades-data";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------
const NOW = "2026-10-23T19:00:00.000Z"; // Fri Oct 23, 14:00 UTC−5
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const STRATEGY = "30000000-0000-4000-8000-000000000001";
const RISK_PLAN = "30000000-0000-4000-8000-000000000002";
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`OB_FIRST_TOUCH`, `LIVE_FIRST`, `RISK_LIMIT`): never in visible text. */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

function account(id: string, name: string, currency: string): ContextAccount {
  return { id, name, currency, type: "EVALUATION", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "100000", createdAt: "2026-09-01T10:00:00Z", profile: "PROFILE" };
}
const ACCOUNTS = [account(FTMO, "FTMO 100K", "USD"), account(PERSONAL, "Personal 12K", "EUR")];

function allContext(accounts: ContextAccount[] = ACCOUNTS): AccountContext {
  return {
    accounts, active: accounts, archived: [], selected: { mode: "all" }, notice: null, noticeText: null, scopeAccountIds: accounts.map(a => a.id),
    formDefaultAccountId: null,
  };
}
function accountContext(selected: ContextAccount): AccountContext {
  return { ...allContext(), selected: { mode: "account", account: selected }, scopeAccountIds: [selected.id], formDefaultAccountId: selected.id };
}

function ledger(n: number, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: uuid(n), account_id: FTMO, origin: "PLANNED", created_at: "2026-10-23T12:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
    entry_time_known: false, lifecycle: "DRAFT", draft_check: "UNCHECKED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    symbol: "EURUSD", direction: "LONG", entry_model: "OB_FIRST_TOUCH", requested_risk_percent: "0.5", ...changes,
  };
}

const closedWin = ledger(1, {
  plan_id: uuid(101), locked_at: "2026-10-23T07:50:00Z", entered_at: "2026-10-23T08:05:00Z", entry_recorded_at: "2026-10-23T08:06:00Z", entry_price: "1.1",
  quantity: "0.5", exited_at: "2026-10-23T11:00:00Z", close_recorded_at: "2026-10-23T11:01:00Z", net_pnl: "1667.38", realized_r: "3.08", outcome: "WIN",
  lifecycle: "CLOSED", draft_check: null, tags: ["london", "sweep", "a-setup"], evidence_count: 3, cover_evidence_id: uuid(201), cover_evidence_kind: "V2",
  strategy_version_id: STRATEGY, strategy_version: "ICT V1.0", risk_plan_version_id: RISK_PLAN, risk_plan_version: "Risk Plan V1.1",
});
const blockedDraft = ledger(2, {
  created_at: "2026-10-23T18:44:00Z", latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T18:44:30Z", draft_check: "BLOCKED", requested_risk_percent: "1.25",
  symbol: "GBPUSD",
});
const liveFirstNoRisk = ledger(3, {
  account_id: PERSONAL, currency: "EUR", origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, symbol: "DE40", direction: "SHORT", entry_model: "OTHER",
  requested_risk_percent: null, created_at: "2026-10-22T12:10:00Z", entered_at: "2026-10-22T12:10:00Z", entry_recorded_at: "2026-10-22T12:10:00Z", entry_time_known: true,
  exited_at: "2026-10-22T14:00:00Z", close_recorded_at: "2026-10-22T14:00:00Z", net_pnl: "-295", realized_r: null, outcome: "LOSS", lifecycle: "CLOSED", draft_check: null,
});
const lockedPlan = ledger(4, {
  symbol: "XAUUSD", direction: "SHORT", plan_id: uuid(104), locked_at: "2026-10-22T15:52:00Z", lifecycle: "LOCKED", draft_check: null, entry_model: "OTE",
});

function listRow(trade: LedgerTrade, options: { reviews?: number } = {}): TradeListRow {
  const date = tradeDate(trade);
  const owner = ACCOUNTS.find(item => item.id === trade.account_id) ?? ACCOUNTS[0];
  return {
    id: trade.id, href: `/trades/${trade.id}`, trade, tradeAt: date.at, tradeDay: strategyDay(date.at), tradeDateSource: date.source,
    account: { id: owner.id, name: owner.name, currency: owner.currency, status: owner.status },
    state: deriveTradeState(trade, { now: NOW, checkCurrent: false }),
    thumbnail: trade.cover_evidence_id ? { kind: "V2", src: `/api/evidence/${trade.cover_evidence_id}`, thumbSrc: `/api/evidence/${trade.cover_evidence_id}?variant=thumb` } : null,
    ai: { reviews: options.reviews ?? 0, preTradeAnalyses: 0, lastCompletedAt: null },
  };
}

function listPage(rows: TradeListRow[], nextCursor: string | null = null): TradeListPage {
  return { filters: {}, rows, groups: groupByTradeDay(rows, NOW), nextCursor, dateDefinition: TRADE_DATE_DEFINITION };
}

const ROWS = () => [listRow(blockedDraft), listRow(closedWin, { reviews: 1 }), listRow(lockedPlan), listRow(liveFirstNoRisk)];
/** The Journal reads one trade past a page to know whether older trades exist and whether the last day continues. */
const FETCH = JOURNAL_PAGE_SIZE + 1;

/** `count` live trades entered one minute apart, newest first, from `start` (UTC). */
function liveTrades(count: number, start: string, first = 700): TradeListRow[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.parse(start) - index * 60_000).toISOString();
    return listRow(ledger(first + index, {
      plan_id: uuid(first + 1000 + index), locked_at: at, entered_at: at, entry_recorded_at: at, entry_price: "1.1", lifecycle: "LIVE", draft_check: null,
    }));
  });
}

async function render(params: Record<string, string | string[]> = {}): Promise<string> {
  const element = (await JournalPage({ searchParams: Promise.resolve(params) })) as ReactElement;
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
const paramsOf = (href: string) => new URL(href, "http://journal.test").searchParams;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.context = allContext();
  m.timeDisplay = { mode: "strategy" };
  m.versionRows = { strategy_versions: [], risk_plan_versions: [] };
  m.dbCalls = [];
  m.listTrades.mockReset();
  m.listTrades.mockResolvedValue(listPage(ROWS()));
  // Without counts the paging copy states only what the page itself proves.
  m.countTrades.mockReset();
  m.countTrades.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------------------------------
describe("Journal list", () => {
  it("groups trades by trade date with today/yesterday, the date definition and every row column in words", async () => {
    const html = await render();
    const text = visibleText(html);
    expect(m.listTrades).toHaveBeenCalledWith({}, null, FETCH);
    expect(html).toContain("<h1");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text).toContain("Journal");
    expect(text).toContain("All Accounts");
    expect(text).toMatch(/Today · Fri, Oct 23/);
    expect(text).toMatch(/Yesterday · Thu, Oct 22/);
    expect(text).not.toContain("(UTC−5)"); // strategy display: the day headers need no zone
    expect(text).toContain(TRADE_DATE_DEFINITION);
    expect(text).toContain("Times in UTC−5");
    // Row facts: instrument + direction, time source, account (All Accounts), model, planned risk, R, P&L, state, origin.
    expect(text).toContain("EURUSD · Long");
    expect(text).toContain("Entered 03:05");
    expect(text).toContain("Drafted 13:44");
    expect(text).toContain("Locked 10:52");
    expect(text).toContain("Entered 07:10");
    expect(text).toContain("Entered 03:05 · FTMO 100K");
    expect(text).toContain("Entered 07:10 · Personal 12K");
    expect(text).toContain("OB first touch");
    expect(text).toContain("0.50%");
    expect(text).toContain("+3.08R");
    expect(text).toContain("+$1,667.38");
    expect(text).toContain("-€295.00");
    expect(text).toContain("Blocked");
    expect(text).toContain("Closed · review pending");
    expect(text).toContain("Locked · waiting for entry");
    expect(text).toContain("Live-first");
    expect(text).toContain("Planned");
    expect(text).toContain("AI-reviewed");
    expect(text).toContain("london");
    expect(text).toContain("+1");
    expect(text).toContain("Tags: london, sweep, a-setup"); // screen readers get every tag, not "+1"
    expect(text).toContain("No pre-trade plan recorded");
    expect(text).toContain("Realized R not available: no risk was recorded");
    expect(html).toContain(`href="/trades/${closedWin.id}"`);
    expect(html).toContain(`src="/api/evidence/${uuid(201)}?variant=thumb"`);
    expect(text).toContain("3 screenshots");
    expect(text).toContain("No screenshot");
    // The live-first badge explains itself.
    expect(html).toContain('title="No pre-trade plan was recorded before execution."');
  });

  it("explains how trades are dated once per page, with a control that opens on click, tap and keyboard alike", async () => {
    // Twelve days of trades: still one control (no tab stop per day header), described by the definition itself.
    const rows = Array.from({ length: 12 }, (_, day) => liveTrades(1, `2026-10-${String(23 - day).padStart(2, "0")}T14:00:00.000Z`, 800 + day)[0]);
    m.listTrades.mockResolvedValue(listPage(rows));
    const html = await render();
    expect(html.match(/<h3/g)).toHaveLength(12);
    expect(html.match(/How trades are dated/g)).toHaveLength(1);
    const button = /<button[^>]*aria-describedby="([^"]+)"[^>]*>(?:(?!<\/button>)[\s\S])*How trades are dated<\/button>/.exec(html);
    expect(button).not.toBeNull();
    expect(button?.[0]).toContain('aria-haspopup="dialog"'); // a popover trigger, not a hover-only tooltip
    expect(html).toContain(`id="${button?.[1]}" class="sr-only">${TRADE_DATE_DEFINITION}<`);
  });

  it("never shows raw ids, hashes or backend codes in visible text", async () => {
    const text = visibleText(await render({ state: "closed,reviewed", model: "OB_FIRST_TOUCH", session: "ACTIVE_KILL_ZONE", origin: "live-first", strategy: STRATEGY }));
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(ENUM);
    expect(text).not.toMatch(/\b(LIVE_FIRST|PLANNED|REVIEWED|DRAFT|BLOCKED|LOCKED)\b/);
  });

  it("keeps the account column out of rows in a single-account context and names the account in the header", async () => {
    m.context = accountContext(ACCOUNTS[0]);
    const text = visibleText(await render());
    expect(text).toContain("FTMO 100K · Every trade");
    expect(text).not.toContain("Personal 12K");
    expect(text).toContain("Entered 03:05");
    expect(text).not.toContain("Entered 03:05 · FTMO 100K");
  });

  it("formats times in the person's time display while grouping by strategy day, dating times that fall on another day", async () => {
    m.timeDisplay = { mode: "utc" };
    // Entered 21:30 UTC−5 on Thu Oct 22, which is 02:30 on Fri Oct 23 in UTC.
    const lateEntry = listRow(ledger(5, {
      plan_id: uuid(105), locked_at: "2026-10-23T02:00:00Z", entered_at: "2026-10-23T02:30:00Z", entry_recorded_at: "2026-10-23T02:31:00Z", entry_price: "1.1",
      lifecycle: "LIVE", draft_check: null,
    }));
    const rows = ROWS();
    m.listTrades.mockResolvedValue(listPage([...rows.slice(0, 2), lateEntry, ...rows.slice(2)]));
    const text = visibleText(await render());
    expect(text).toContain("Entered 08:05");
    expect(text).toContain("Drafted 18:44"); // 13:44 UTC−5, same calendar day in UTC
    expect(text).toContain("Entered Oct 23, 02:30");
    expect(text).toContain("Times in UTC");
    // The headers name the clock their days belong to, so "Today" can't be read as today in UTC.
    expect(text).toMatch(/Today · Fri, Oct 23 \(UTC−5\)/);
    expect(text).toMatch(/Yesterday · Thu, Oct 22 \(UTC−5\) 3 trades/);
    expect(text).toContain("Times are shown in UTC. A time that falls on a different day there shows its date.");
  });

  it("dates local times past midnight under their strategy day (Asia/Tokyo, UTC+9)", async () => {
    m.timeDisplay = { mode: "local", zone: "Asia/Tokyo" };
    const html = await render();
    const text = visibleText(html);
    // Draft at 18:44Z: Fri Oct 23 13:44 UTC−5 (its group), but Sat Oct 24 03:44 in Tokyo.
    expect(text).toContain("Drafted Oct 24, 03:44");
    // Entered 08:05Z: 17:05 in Tokyo on the same Friday; no date needed.
    expect(text).toContain("Entered 17:05");
    expect(text).not.toContain("Entered Oct 23, 17:05");
    // Locked 15:52Z on Thu Oct 22 (UTC−5): 00:52 on Fri Oct 23 in Tokyo.
    expect(text).toContain("Locked Oct 23, 00:52");
    expect(text).toContain("Entered 21:10");
    expect(text).toMatch(/Today · Fri, Oct 23 \(UTC−5\)/);
    expect(text).toContain("Times in Asia/Tokyo");
    const draft = rowView(listRow(blockedDraft), { mode: "all", accountName: null, hasAccounts: true }, { mode: "local", zone: "Asia/Tokyo" });
    expect(draft.timeLabel).toBe("Drafted Oct 24, 03:44");
  });

  it("links Older through the reader's own cursor when the read stopped at its scan limit, without claiming the day continues", async () => {
    // Fewer than a page came back, with a cursor: `listTrades` stopped scanning; older trades may or may not exist.
    const cursor = encodeTradeCursor({ t: liveFirstNoRisk.entered_at as string, id: liveFirstNoRisk.id });
    m.listTrades.mockResolvedValue(listPage(ROWS(), cursor));
    const first = await render({ model: "OTE" });
    expect(m.listTrades).toHaveBeenLastCalledWith({ model: "OTE" }, null, FETCH);
    expect(visibleText(first)).not.toContain("more on the next page");
    expect(visibleText(first)).toContain("Page 1 · 50 per page");
    const older = hrefs(first).find(href => paramsOf(href).get("cursor") === cursor);
    expect(older).toBeDefined();
    expect(paramsOf(older as string).get("back")).toBe("0");
    expect(paramsOf(older as string).get("model")).toBe("OTE");

    m.listTrades.mockResolvedValue(listPage(ROWS()));
    const second = await render({ model: "OTE", cursor, back: "0" });
    expect(m.listTrades).toHaveBeenLastCalledWith({ model: "OTE" }, cursor, FETCH);
    expect(visibleText(second)).toContain("Page 2 · 50 per page");
    expect(hrefs(second)).toContain("/journal?model=OTE");
    expect(visibleText(second)).toContain("Newer");
  });

  it("keeps every row in query order across the strategy midnight and says the last day continues only when it does", async () => {
    // 49 trades a microsecond after the UTC−5 midnight, two a microsecond before it: the 51st (not shown) proves that
    // the last day, Tue Sep 15, continues on the next page.
    const trades = Array.from({ length: FETCH }, (_, index) => ledger(500 + index, {
      plan_id: uuid(600 + index), locked_at: "2026-09-15T12:00:00Z", lifecycle: "LOCKED", draft_check: null,
      ...(index < 49 ? { entered_at: "2026-09-16T05:00:00.000001Z", entry_recorded_at: "2026-09-16T05:00:01Z", entry_price: "1.1", lifecycle: "LIVE" as const } : {}),
    }));
    const rows = trades.slice(0, 49).map(trade => listRow(trade)).concat(trades.slice(49).map(trade => listRow({ ...trade, locked_at: "2026-09-16T04:59:59.999999Z" })));
    const scanCursor = encodeTradeCursor({ t: "2026-09-16T04:00:00Z", id: uuid(999) });
    m.listTrades.mockResolvedValue(listPage(rows, scanCursor));
    const html = await render({ model: "OB_FIRST_TOUCH" });
    const links = [...html.matchAll(/href="\/trades\/([0-9a-f-]+)"/g)].map(match => match[1]);
    expect(links).toEqual(rows.slice(0, 50).map(row => row.id));
    expect(new Set(links).size).toBe(50);
    const text = visibleText(html);
    expect(text).toContain("Wed, Sep 16");
    expect(text).toContain("Tue, Sep 15");
    expect(text).toContain("49 trades");
    expect(text).toContain("1 trade · more on the next page");
    expect(text).toContain("50 matching trades on this page");
    expect(text).toContain("Older");
    // "Newer" is shown disabled on the first page (no link).
    expect(html).toMatch(/<span class="[^"]*" aria-disabled="true">.*Newer/);
    // The next page starts right after the 50th trade shown (not where the reader stopped).
    const cursor = encodeTradeCursor({ t: "2026-09-16T04:59:59.999999Z", id: rows[49].id });
    expect(hrefs(html).some(href => paramsOf(href).get("cursor") === cursor && paramsOf(href).get("model") === "OB_FIRST_TOUCH")).toBe(true);
    expect(hrefs(html).some(href => paramsOf(href).get("cursor") === scanCursor)).toBe(false);
  });

  it("does not claim the last day continues when the next page starts on an earlier day", async () => {
    // Fifty trades on Fri Sep 11, the 51st on Thu Sep 10 (the seeded case the review found).
    const rows = [...liveTrades(50, "2026-09-11T20:00:00.000Z"), ...liveTrades(1, "2026-09-10T20:00:00.000Z", 900)];
    m.listTrades.mockResolvedValue(listPage(rows));
    const text = visibleText(await render());
    expect(text).toContain("Fri, Sep 11 50 trades");
    expect(text).not.toContain("more on the next page");
    expect(text).not.toContain("Thu, Sep 10");
    expect(text).toContain("50 trades on this page");
    expect(text).toContain("Older");
  });

  it("trims a read of one trade past the page and keeps the reader's cursor otherwise", () => {
    const now = "2026-10-23T19:00:00.000Z";
    const sameDay = trimToPage(listPage(liveTrades(FETCH, "2026-10-23T18:00:00.000Z")), now, { mode: "strategy" });
    expect(sameDay.page.rows).toHaveLength(JOURNAL_PAGE_SIZE);
    expect(sameDay.page.groups.flatMap(group => group.rows)).toHaveLength(JOURNAL_PAGE_SIZE);
    expect(sameDay.lastDayContinues).toBe(true);
    const last = sameDay.page.rows[JOURNAL_PAGE_SIZE - 1];
    expect(sameDay.page.nextCursor).toBe(encodeTradeCursor({ t: last.tradeAt, id: last.id }));
    // Exactly a page: no next page unless the reader itself returned a cursor (scan limit).
    const exact = trimToPage(listPage(liveTrades(JOURNAL_PAGE_SIZE, "2026-10-23T18:00:00.000Z")), now, { mode: "strategy" });
    expect(exact).toMatchObject({ lastDayContinues: false, page: { nextCursor: null } });
    expect(exact.page.rows).toHaveLength(JOURNAL_PAGE_SIZE);
    const scan = encodeTradeCursor({ t: now, id: uuid(9) });
    expect(trimToPage(listPage(ROWS(), scan), now, { mode: "strategy" })).toMatchObject({ lastDayContinues: false, page: { nextCursor: scan } });
  });

  it("ignores cursors and trails it did not write", async () => {
    expect(readCursor({ cursor: "not-a-cursor" })).toBeNull();
    const cursor = encodeTradeCursor({ t: NOW, id: uuid(9) });
    expect(readCursor({ cursor })).toBe(cursor);
    expect(readTrail({ back: `0,${cursor}` })).toEqual(["0", cursor]);
    expect(readTrail({ back: "0,garbage" })).toEqual([]);
    const html = await render({ cursor, back: "garbage" });
    expect(visibleText(html)).toContain("Newest");
    expect(visibleText(html)).not.toContain("Page 2");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Filters (URL state, drill-down links)
// ---------------------------------------------------------------------------------------------------------------------
describe("Journal filters", () => {
  it("keeps drill-down links from EDGE, the calendar and Accounts working and visible as removable chips", async () => {
    const params = {
      from: "2026-10-01", to: "2026-10-23", state: "closed,reviewed", model: "OTE", weekday: "Tuesday", rFrom: "-1.5", rTo: "0", risk: "0.5",
      closedFrom: "2026-10-14", closedTo: "2026-10-14", direction: "long", strategy: STRATEGY, riskPlan: RISK_PLAN, session: "ACTIVE_KILL_ZONE", tag: "london",
    };
    const html = await render(params);
    const text = visibleText(html);
    const [filters] = m.listTrades.mock.calls[0] as [TradeFilters, string | null];
    expect(filters).toMatchObject({ from: "2026-10-01", to: "2026-10-23", states: ["CLOSED", "REVIEWED"], model: "OTE", weekday: "Tuesday", rFrom: "-1.5", rTo: "0", riskPercent: "0.5", session: "ACTIVE_KILL_ZONE", tags: ["london"] });
    // Menus show their value; filters without a menu become chips; mobile shows every filter as a chip.
    expect(text).toContain("Date: This month");
    expect(text).toContain("State: Closed, Reviewed");
    expect(text).toContain("Model: OTE");
    expect(text).toContain("Session: Kill zone");
    expect(text).toContain("Tags: london");
    expect(text).toContain("Tag: london");
    expect(text).toContain("Entry weekday: Tuesday");
    expect(text).toContain("Realized R: -1.50R to 0.00R");
    expect(text).toContain("Planned risk: 0.50%");
    expect(text).toContain("Closed Oct 14");
    expect(text).toContain("Direction: Long");
    expect(text).toContain("Strategy: ICT V1.0");
    expect(text).toContain("Risk Plan V1.1");
    expect(text).toContain("Clear all");
    expect(m.dbCalls).toEqual([]); // names came from the matching rows
    // Removing one filter keeps every other one.
    const removeWeekday = hrefs(html).map(paramsOf).find(search => !search.has("weekday") && search.get("model") === "OTE" && search.get("closedFrom") === "2026-10-14");
    expect(removeWeekday).toBeDefined();
    const kept = parseTradeFilters(removeWeekday as URLSearchParams).filters;
    expect(kept).toMatchObject({ states: ["CLOSED", "REVIEWED"], riskPercent: "0.5", strategyVersionId: STRATEGY, riskPlanVersionId: RISK_PLAN });
    expect(kept.weekday).toBeUndefined();
    expect(html).toContain('aria-label="Remove filter: Model: OTE"');
    expect(hrefs(html)).toContain("/journal");
  });

  it("reads version names for drill-down filters when no row carries them, and never shows the id", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    m.versionRows = { strategy_versions: [{ id: STRATEGY, version: "ICT V1.0" }], risk_plan_versions: [{ id: RISK_PLAN, version: "Risk Plan V1.2" }] };
    const text = visibleText(await render({ strategy: STRATEGY, riskPlan: RISK_PLAN }));
    expect(m.dbCalls.sort()).toEqual(["risk_plan_versions", "strategy_versions"]);
    expect(text).toContain("Strategy: ICT V1.0");
    expect(text).toContain("Risk Plan V1.2");
    expect(text).not.toMatch(UUID);
  });

  it("falls back to neutral wording when a version name cannot be read", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    const text = visibleText(await render({ strategy: STRATEGY }));
    expect(text).toContain("Strategy: selected version");
    expect(text).not.toMatch(UUID);
  });

  it("search keeps the other filters as hidden fields and offers a clear link", async () => {
    const html = await render({ q: "london", result: "win" });
    expect(m.listTrades).toHaveBeenCalledWith({ q: "london", result: "WIN" }, null, FETCH);
    expect(html).toMatch(/<search[^>]*>/);
    expect(html).toContain('name="q"');
    expect(html).toContain('value="london"');
    expect(html).toMatch(/<input type="hidden" name="result" value="win"\/>/);
    expect(html).toContain('aria-label="Clear search"');
    expect(hrefs(html)).toContain("/journal?result=win");
  });

  it("names unreadable filters in words and ignores them", async () => {
    const text = visibleText(await render({ result: "maybe", rFrom: "abc", model: "OTE" }));
    expect(m.listTrades).toHaveBeenCalledWith({ model: "OTE" }, null, FETCH);
    // Worded for a link and for a typed value alike.
    expect(text).toContain("Some filters couldn't be read and were ignored (result, R range).");
    expect(text).not.toContain("in this link");
  });

  it("validates typed instruments and tags in the field with patterns browsers can compile", () => {
    // Browsers compile `pattern` as /^(?:…)$/v; an invalid one silently turns validation off. Older engines use u.
    const compile = (pattern: string, flags: "u" | "v") => new RegExp(`^(?:${pattern})$`, flags);
    const view = buildJournalView(input());
    const formPatterns = [...view.filters.menus, ...view.filters.moreMenus].flatMap(menu => (menu.form?.kind === "text" ? [menu.form.pattern] : []));
    expect(formPatterns).toEqual([TAG_PATTERN, INSTRUMENT_PATTERN]);
    for (const pattern of [TAG_PATTERN, INSTRUMENT_PATTERN, OPTIONAL_INSTRUMENT_PATTERN, TAG_LIST_PATTERN]) {
      expect(() => compile(pattern, "v")).not.toThrow();
      expect(() => compile(pattern, "u")).not.toThrow();
    }
    // Every pattern accepts what the server reads and rejects what it would ignore.
    const instrument = compile(INSTRUMENT_PATTERN, "v");
    const readsInstrument = (value: string) => parseTradeFilters({ instrument: value }).filters.instrument !== undefined;
    for (const value of ["EURUSD", "eurusd", "BTC/USD", "US30.cash", "DE40", " XAUUSD "]) {
      expect([value, instrument.test(value)]).toEqual([value, true]);
      expect([value, readsInstrument(value)]).toEqual([value, true]);
    }
    for (const value of ["EUR USD!", "EUR USD", "/EURUSD", "-X", "ÄBC", "A".repeat(21), " "]) {
      expect([value, instrument.test(value)]).toEqual([value, false]);
      expect([value, readsInstrument(value)]).toEqual([value, false]);
    }
    const tag = compile(TAG_PATTERN, "v");
    const readsTags = (value: string) => parseTradeFilters({ tag: value }).invalid.length === 0;
    for (const value of ["news", "News Week", " london ", "a-setup", "fvg_2", "x".repeat(32)]) {
      expect([value, tag.test(value), readsTags(value)]).toEqual([value, true, true]);
    }
    for (const value of ["news!", "-news", "#fomo", "x".repeat(33), "news, london"]) {
      expect([value, tag.test(value)]).toEqual([value, false]);
    }
    // The mobile sheet's optional fields: comma lists of tags; blank means no filter.
    const list = compile(TAG_LIST_PATTERN, "v");
    for (const value of ["news, london", "news,london", "news, ", ", news", "news,,london", "price action, a-setup", " ", ","]) {
      expect([value, list.test(value), readsTags(value)]).toEqual([value, true, true]);
    }
    for (const value of ["news; london", "news, #fomo", "-news"]) {
      expect([value, list.test(value), readsTags(value)]).toEqual([value, false, false]);
    }
    expect(compile(OPTIONAL_INSTRUMENT_PATTERN, "v").test(" ")).toBe(true);
    expect(compile(OPTIONAL_INSTRUMENT_PATTERN, "v").test("EUR USD!")).toBe(false);
    // Long hostile input is answered at once (no backtracking blow-up while typing).
    const started = performance.now();
    list.test(`${Array.from({ length: 60 }, () => "ab  ").join(",")}#`);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("puts the patterns on the desktop forms and the mobile sheet", () => {
    const view = buildJournalView(input());
    const form = (key: FilterMenuView["key"]) => {
      const menu = view.filters.menus.find(item => item.key === key);
      if (menu?.form?.kind !== "text") throw new Error(`${key} has no text form`);
      return renderToStaticMarkup(createElement(TextForm, { form: menu.form, inputRef: { current: null }, onDone: () => undefined, onPick: () => undefined }));
    };
    expect(form("instrument")).toContain(`pattern="${INSTRUMENT_PATTERN}"`);
    expect(form("instrument")).toContain('title="Letters, digits and . _ / - only, up to 20 characters."');
    expect(form("tags")).toContain(`pattern="${TAG_PATTERN}"`);
    const sheet = renderToStaticMarkup(createElement(SheetForm, { sheet: view.filters.sheet, clearHref: null, onDone: () => undefined }));
    const field = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(sheet)?.[0] ?? "";
    expect(field("tag")).toContain(`pattern="${TAG_LIST_PATTERN}"`);
    expect(field("instrument")).toContain(`pattern="${OPTIONAL_INSTRUMENT_PATTERN}"`);
  });

  it("explains an impossible date range instead of loading", async () => {
    const text = visibleText(await render({ from: "2026-10-20", to: "2026-10-01" }));
    expect(m.listTrades).not.toHaveBeenCalled();
    expect(text).toContain("The start date (Oct 20) is after the end date (Oct 1). Choose a start date on or before the end date.");
    expect(text).toContain("No trades match these filters.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Empty states and next actions
// ---------------------------------------------------------------------------------------------------------------------
describe("Journal empty states", () => {
  it("first run without a trading account points to creating one", async () => {
    m.context = allContext([]);
    const html = await render();
    expect(m.listTrades).not.toHaveBeenCalled();
    expect(visibleText(html)).toContain("Create your first trading account.");
    expect(hrefs(html)).toContain("/accounts/new");
  });

  it("an empty journal offers Plan trade and Record live trade", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    const html = await render();
    const text = visibleText(html);
    expect(text).toContain("No trades yet.");
    expect(text).toContain("Plan trade");
    expect(text).toContain("Record live trade");
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/trades/new", "/trades/live/new"]));
    // Nothing to filter yet: no search box or filter pills.
    expect(html).not.toContain('name="q"');
    expect(text).not.toContain("More filters");
  });

  it("an empty account also offers All Accounts (switching the context explicitly)", async () => {
    m.context = accountContext(ACCOUNTS[1]);
    m.listTrades.mockResolvedValue(listPage([]));
    const html = await render();
    expect(visibleText(html)).toContain("No trades in Personal 12K yet.");
    expect(hrefs(html)).toContain("/journal?account=all");
  });

  it("no matches offers clearing the filters, and searching All Accounts from one account", async () => {
    m.context = accountContext(ACCOUNTS[0]);
    m.listTrades.mockResolvedValue(listPage([]));
    const html = await render({ result: "win", tag: "news" });
    const text = visibleText(html);
    expect(text).toContain("No trades match these filters.");
    expect(text).toContain("Clear all filters");
    expect(text).toContain("Search All Accounts");
    expect(hrefs(html)).toContain("/journal?result=win&tag=news&account=all");
    // The filters that explain the empty list stay on screen, and the outcome is announced.
    expect(html).toContain('name="q"');
    expect(html).toMatch(/aria-live="polite">No trades match these filters\.</);
  });

  it("a search without matches explains what search covers", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    const text = visibleText(await render({ q: "zzzz" }));
    expect(text).toContain("No trades match “zzzz”.");
    expect(text).toContain("Search looks at instruments, tags and journal notes.");
    expect(text).toContain("Clear search");
  });

  it("past the last page leads back to the newest trades", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    const cursor = encodeTradeCursor({ t: NOW, id: uuid(9) });
    const html = await render({ cursor, back: "0", model: "OTE" });
    expect(visibleText(html)).toContain("No more trades.");
    expect(visibleText(html)).toContain("Back to newest");
    expect(hrefs(html)).toContain("/journal?model=OTE");
  });

  it("the route loading state is a labelled skeleton of the list", () => {
    const html = renderToStaticMarkup(createElement(JournalRouteLoading));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading trades");
    expect(html).toContain("skeleton");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Exact counts and the read-only account filter
// ---------------------------------------------------------------------------------------------------------------------
const OLD = "20000000-0000-4000-8000-000000000003";
const OLD_CHALLENGE: ContextAccount = { ...account(OLD, "Old challenge", "USD"), status: "ARCHIVED" };

describe("Journal paging copy with exact counts (§14.5)", () => {
  // Ten trades on Fri Oct 23 and 41 on Thu Oct 22: the page shows 50, and the 51st proves Thursday continues.
  const firstPage = () => [...liveTrades(10, "2026-10-23T18:00:00.000Z"), ...liveTrades(41, "2026-10-22T18:00:00.000Z", 900)];

  it("states the exact total across pages and counts the day a page shares with the next one", async () => {
    m.listTrades.mockResolvedValue(listPage(firstPage()));
    m.countTrades.mockResolvedValue({ total: 93, days: new Map([["2026-10-22", 44]]) });
    const text = visibleText(await render());
    expect(m.countTrades).toHaveBeenCalledWith({}, ["2026-10-22"]);
    expect(text).toContain("Showing 50 of 93 trades");
    expect(text).not.toContain("on this page");
    expect(text).toContain("Today · Fri, Oct 23 10 trades");
    expect(text).toContain("40 of 44 trades · more on the next page");
  });

  it("names the part of a day that started on the previous page", async () => {
    const shown = firstPage().slice(0, JOURNAL_PAGE_SIZE);
    const cursor = encodeTradeCursor({ t: shown[shown.length - 1].tradeAt, id: shown[shown.length - 1].id });
    m.listTrades.mockResolvedValue(listPage([...liveTrades(4, "2026-10-22T16:00:00.000Z", 950), ...liveTrades(10, "2026-10-21T18:00:00.000Z", 960)]));
    m.countTrades.mockResolvedValue({ total: 93, days: new Map([["2026-10-22", 44]]) });
    const text = visibleText(await render({ cursor, back: "0" }));
    expect(m.countTrades).toHaveBeenCalledWith({}, ["2026-10-22"]);
    expect(text).toContain("Showing 14 of 93 trades");
    expect(text).toContain("4 of 44 trades · more on the previous page");
    expect(text).toContain("Wed, Oct 21 10 trades");
  });

  it("filtered lists say matching trades; a single page needs no count; without counts the page keeps its own wording", async () => {
    m.listTrades.mockResolvedValue(listPage(firstPage()));
    m.countTrades.mockResolvedValue({ total: 61, days: new Map([["2026-10-22", 51]]) });
    expect(visibleText(await render({ model: "OB_FIRST_TOUCH" }))).toContain("Showing 50 of 61 matching trades");
    expect(m.countTrades).toHaveBeenLastCalledWith({ model: "OB_FIRST_TOUCH" }, ["2026-10-22"]);
    m.countTrades.mockClear();
    m.listTrades.mockResolvedValue(listPage(ROWS()));
    expect(visibleText(await render())).toContain("4 trades");
    expect(m.countTrades).not.toHaveBeenCalled();
    // A count that cannot be read never breaks the list: the copy states only what the page proves.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.listTrades.mockResolvedValue(listPage(firstPage()));
    m.countTrades.mockRejectedValue(new Error("count failed"));
    const text = visibleText(await render());
    expect(text).toContain("50 trades on this page");
    expect(text).toContain("40 trades · more on the next page");
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "data_read_failed", status: 500 }));
    log.mockRestore();
  });

  it("words counts exactly: totals only when known and consistent, a day's split only where it is", () => {
    expect(resultSummary(4, "trade", false, 93)).toBe("4 trades");
    expect(resultSummary(50, "trade", true, 93)).toBe("Showing 50 of 93 trades");
    expect(resultSummary(1, "matching trade", true, 51)).toBe("Showing 1 of 51 matching trades");
    expect(resultSummary(50, "trade", true, null)).toBe("50 trades on this page");
    expect(resultSummary(50, "trade", true, 40)).toBe("50 trades on this page");
    expect(dayCountLabel(12, 12, false, false)).toBe("12 trades");
    expect(dayCountLabel(12, 14, false, true)).toBe("12 of 14 trades · more on the next page");
    expect(dayCountLabel(2, 14, true, false)).toBe("2 of 14 trades · more on the previous page");
    expect(dayCountLabel(50, 120, true, true)).toBe("50 of 120 trades · more on the previous and next pages");
    expect(dayCountLabel(1, undefined, false, true)).toBe("1 trade · more on the next page");
    const page = listPage(firstPage().slice(0, JOURNAL_PAGE_SIZE));
    expect(splitDays(page, null, true)).toEqual({ first: null, last: "2026-10-22" });
    expect(splitDays(page, encodeTradeCursor({ t: "2026-10-23T23:00:00.000Z", id: uuid(1) }), false)).toEqual({ first: "2026-10-23", last: null });
    expect(splitDays(page, encodeTradeCursor({ t: "2026-10-24T18:00:00.000Z", id: uuid(1) }), false)).toEqual({ first: null, last: null });
  });
});

describe("Journal read-only account filter (§9.2)", () => {
  beforeEach(() => {
    m.context = allContext([...ACCOUNTS, OLD_CHALLENGE]);
  });

  it("lists one account of All Accounts, archived ones included, named in words and removable", async () => {
    const html = await render({ accountFilter: OLD.toUpperCase(), state: "closed" });
    const text = visibleText(html);
    expect(m.listTrades).toHaveBeenCalledWith({ accountFilter: OLD, states: ["CLOSED"] }, null, FETCH);
    expect(text).toContain("Old challenge (archived) · Every trade");
    expect(text).toContain("Account: Old challenge · archived");
    expect(text).not.toMatch(UUID);
    expect(html).toContain('aria-label="Remove filter: Account: Old challenge · archived"');
    // Removing it keeps the other filters; every other link keeps it.
    const links = hrefs(html).filter(href => href.startsWith("/journal"));
    expect(links).toContain("/journal?state=closed");
    expect(links.filter(href => href !== "/journal" && href !== "/journal?state=closed").every(href => paramsOf(href).get("accountFilter") === OLD)).toBe(true);
    expect(html).toContain(`name="accountFilter" value="${OLD}"`);
  });

  it("combines with All Accounts only: an account context lists its own trades, without the filter", async () => {
    m.context = accountContext(ACCOUNTS[0]);
    const text = visibleText(await render({ accountFilter: OLD }));
    expect(m.listTrades).toHaveBeenCalledWith({}, null, FETCH);
    expect(text).toContain("FTMO 100K · Every trade");
    expect(text).not.toContain("Account: ");
  });

  it("says when the account is not the user's: the filter matches nothing and is shown without its id", async () => {
    const foreign = "20000000-0000-4000-8000-000000000099";
    m.listTrades.mockResolvedValue(listPage([]));
    const text = visibleText(await render({ accountFilter: foreign }));
    expect(m.listTrades).toHaveBeenCalledWith({ accountFilter: foreign }, null, FETCH);
    expect(text).toContain("That trading account isn't available, so no trade matches the account filter.");
    expect(text).toContain("Account: not available");
    expect(text).toContain("No trades match these filters.");
    expect(text).not.toMatch(UUID);
    expect(visibleText(await render({ accountFilter: "Old challenge" }))).toContain("Some filters couldn't be read and were ignored (trading account).");
  });

  it("keeps the account filter when the mobile sheet is applied", () => {
    const sheet = buildJournalView(input({ filters: { accountFilter: OLD, model: "OTE" }, accountFilter: { kind: "account", account: OLD_CHALLENGE } })).filters.sheet;
    expect(sheet.hidden).toContainEqual({ name: "accountFilter", value: OLD });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// View model and client pieces
// ---------------------------------------------------------------------------------------------------------------------
function input(changes: Partial<JournalInput> = {}): JournalInput {
  return {
    filters: {}, invalid: [], context: { mode: "all", accountName: null, hasAccounts: true }, display: { mode: "strategy" }, now: NOW,
    page: listPage(ROWS()), lastDayContinues: false, cursor: null, trail: [], versionNames: { strategy: null, riskPlan: null }, ...changes,
  };
}

describe("Journal view model", () => {
  it("date presets end today (strategy day) and name custom ranges in words", () => {
    const presets = datePresets("2026-10-23");
    expect(presets.map(preset => preset.label)).toEqual(["Today", "Yesterday", "Last 7 days", "Last 30 days", "This month", "Last month", "This year"]);
    expect(presets.find(preset => preset.key === "7d")).toMatchObject({ from: "2026-10-17", to: "2026-10-23" });
    expect(presets.find(preset => preset.key === "last-month")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(rangeText("2026-10-01", "2026-10-14", "2026-10-23")).toBe("Oct 1 – Oct 14");
    expect(rangeText("2025-12-30", undefined, "2026-10-23")).toBe("Since Dec 30, 2025");
    expect(rangeText(undefined, "2026-10-14", "2026-10-23")).toBe("Until Oct 14");
  });

  it("every menu option links to exactly the filters it names", () => {
    const view = buildJournalView(input({ filters: { states: ["CLOSED"], tags: ["london"] } }));
    const menus = [...view.filters.menus, ...view.filters.moreMenus];
    const option = (key: FilterMenuView["key"], label: string) => menus.find(menu => menu.key === key)?.options.find(item => item.label === label);
    const parse = (href: string | undefined) => parseTradeFilters(paramsOf(href ?? "")).filters;
    expect(parse(option("state", "Reviewed")?.href)).toEqual({ states: ["CLOSED", "REVIEWED"], tags: ["london"] });
    expect(parse(option("state", "Closed · review pending")?.href)).toEqual({ tags: ["london"] });
    expect(parse(option("result", "Break-even")?.href)).toEqual({ result: "BREAKEVEN", states: ["CLOSED"], tags: ["london"] });
    expect(parse(option("origin", "Live-first")?.href)).toMatchObject({ origin: "LIVE_FIRST" });
    expect(parse(option("review", "Review pending")?.href)).toMatchObject({ reviewed: false });
    expect(parse(option("ai", "AI-reviewed")?.href)).toMatchObject({ aiReviewed: true });
    expect(parse(option("tags", "london")?.href)).toEqual({ states: ["CLOSED"] });
    expect(view.filters.moreMenus.map(menu => menu.key)).toEqual(["origin", "session", "review", "ai"]);
    // Quick picks come from the trades on the page.
    const tagMenu = menus.find(menu => menu.key === "tags");
    expect(tagMenu?.form?.kind === "text" && tagMenu.form.suggestions.map(item => item.label)).toEqual(["a-setup", "sweep"]);
  });

  it("the mobile sheet submits back exactly the applied filters", () => {
    const filters: TradeFilters = {
      from: "2026-10-01", to: "2026-10-23", result: "LOSS", states: ["REVIEWED", "CLOSED"], origin: "LIVE_FIRST", model: "OB_FIRST_TOUCH", session: "ASIA",
      reviewed: true, aiReviewed: false, tags: ["london", "news"], instrument: "EURUSD", q: "fomo", weekday: "Tuesday", rFrom: "1",
    };
    const sheet = buildJournalView(input({ filters })).filters.sheet;
    const entries: [string, string][] = [
      ["from", sheet.date.from], ["to", sheet.date.to],
      ...sheet.groups.flatMap(group => group.options.filter(option => option.checked).map(option => [group.name, option.value] as [string, string])),
      ["tag", sheet.tags], ["instrument", sheet.instrument], ...sheet.hidden.map(field => [field.name, field.value] as [string, string]),
    ];
    const submitted = parseTradeFilters(paramsOf(formHref(entries))).filters;
    expect(submitted).toEqual({ ...filters, states: ["CLOSED", "REVIEWED"] });
    expect(sheet.activeCount).toBe(12);
  });

  it("rows never fabricate values: no plan → no planned risk, no close → no result", () => {
    const row = rowView(listRow(liveFirstNoRisk), { mode: "account", accountName: "Personal 12K", hasAccounts: true }, { mode: "strategy" });
    expect(row.plannedRisk).toMatchObject({ text: "—", srText: "No pre-trade plan recorded" });
    expect(row.realizedR).toMatchObject({ text: "—", pending: false });
    expect(row.pnl).toMatchObject({ text: "-€295.00", tone: "neg" });
    expect(row.accountName).toBeNull();
    expect(row.origin).toEqual({ label: "Live-first", title: "No pre-trade plan was recorded before execution." });
    const draft = rowView(listRow(blockedDraft), { mode: "all", accountName: null, hasAccounts: true }, { mode: "strategy" });
    expect(draft.realizedR).toMatchObject({ text: "—", pending: true, srText: "No result yet" });
    expect(draft.pnl).toMatchObject({ text: "—", srText: "No result yet" });
    expect(draft.state).toEqual({ label: "Blocked", tone: "danger" });
    expect(draft.timeLabel).toBe("Drafted 13:44");
  });

  it("tells screen readers that skipped, cancelled and discarded trades will have no result (not that one is pending)", () => {
    const context = { mode: "all", accountName: null, hasAccounts: true } as const;
    const ended = (lifecycle: LedgerTrade["lifecycle"], changes: Partial<LedgerTrade> = {}) =>
      rowView(listRow({ ...lockedPlan, lifecycle, ...changes }), context, { mode: "strategy" });
    for (const lifecycle of ["SKIPPED", "CANCELLED"] as const) {
      expect(ended(lifecycle).realizedR).toMatchObject({ text: "—", srText: "No result: plan not taken" });
      expect(ended(lifecycle).pnl).toMatchObject({ text: "—", srText: "No result: plan not taken" });
    }
    const discarded = ended("DISCARDED", { plan_id: null, locked_at: null, requested_risk_percent: null });
    expect(discarded.realizedR).toMatchObject({ srText: "No result: draft discarded" });
    expect(discarded.pnl).toMatchObject({ srText: "No result: draft discarded" });
    expect(discarded.plannedRisk).toMatchObject({ text: "—", srText: "No planned risk" });
    for (const lifecycle of ["DRAFT", "LOCKED", "LIVE"] as const) {
      expect(ended(lifecycle).pnl.srText).toBe("No result yet");
    }
  });

  it("the result summary says when the list is filtered or paged", () => {
    expect(buildJournalView(input()).resultSummary).toBe("4 trades");
    expect(buildJournalView(input({ filters: { model: "OTE" } })).resultSummary).toBe("4 matching trades");
    expect(buildJournalView(input({ page: listPage(ROWS(), encodeTradeCursor({ t: NOW, id: uuid(9) })) })).resultSummary).toBe("4 trades on this page");
  });
});

describe("Journal client pieces", () => {
  const view: JournalView = buildJournalView(input({ filters: { result: "WIN", origin: "IMPORTED" } }));

  it("an active filter pill shows its value and a remove link; More filters renders as a pill", () => {
    const result = view.filters.menus.find(menu => menu.key === "result") as FilterMenuView;
    const html = renderToStaticMarkup(createElement(FilterMenu, { menu: result }));
    expect(visibleText(html)).toContain("Result: Win");
    expect(html).toContain('aria-label="Remove filter: Result: Win"');
    expect(html).toContain('href="/journal?origin=imported"');
    const more = renderToStaticMarkup(createElement(MoreFiltersMenu, { menus: view.filters.moreMenus }));
    expect(visibleText(more)).toContain("More filters");
    expect(more).toContain('aria-haspopup="dialog"');
  });

  it("filter forms drop empty fields and keep repeated ones", () => {
    expect(formHref([["q", " london "], ["result", ""], ["state", "closed"], ["state", "reviewed"], ["from", ""]])).toBe("/journal?q=london&state=closed&state=reviewed");
    expect(formHref([["q", ""]])).toBe("/journal");
    expect(isPlainClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false })).toBe(true);
    expect(isPlainClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false })).toBe(false);
  });

  it("keeps the search field in step with the applied search without overwriting what the person is typing", () => {
    // "Clear all" or Back changed the search; the field still shows the old one: show the new one, focused or not.
    expect(searchFieldValue({ shown: "london", previous: "london", applied: "", focused: true })).toBe("");
    expect(searchFieldValue({ shown: "london", previous: "london", applied: "news", focused: false })).toBe("news");
    // Enter applied "lon" while the person kept typing: keep their text.
    expect(searchFieldValue({ shown: "london", previous: "", applied: "lon", focused: true })).toBe("london");
    // An unsent edit in a field that lost focus gives way to the applied search.
    expect(searchFieldValue({ shown: "lond", previous: "london", applied: "", focused: false })).toBe("");
  });

  it("moves focus from a removed chip to the chip that takes its place, else the one before, else a control that stays", () => {
    expect(neighbourChip(0, 3)).toBe(1);
    expect(neighbourChip(1, 3)).toBe(2);
    expect(neighbourChip(2, 3)).toBe(1);
    expect(neighbourChip(0, 1)).toBeNull();
  });

  it("renders active-filter chips as Journal links with remove buttons named after their filter", () => {
    const html = renderToStaticMarkup(createElement(ActiveFilterChips, { chips: view.filters.allChips, label: "Active filters", clearHref: "/journal", onEmpty: () => undefined }));
    expect(html).toContain('aria-label="Active filters"');
    expect(html).toContain('aria-label="Remove filter: Result: Win"');
    expect(html).toContain('aria-label="Remove filter: Origin: Imported"');
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/journal?origin=imported", "/journal?result=win", "/journal"]));
    expect(visibleText(html)).toContain("Clear all");
    expect(renderToStaticMarkup(createElement(ActiveFilterChips, { chips: [], label: "Active filters", onEmpty: () => undefined }))).toBe("");
  });

  it("empty-state actions that clear filters stay links to the cleared list", async () => {
    m.listTrades.mockResolvedValue(listPage([]));
    const html = await render({ q: "zzzz" });
    expect(html).toMatch(/<a [^>]*href="\/journal"[^>]*>Clear search<\/a>/);
  });
});
