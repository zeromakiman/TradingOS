import { beforeEach, describe, expect, it, vi } from "vitest";

// Today's loader (docs/V2_ARCHITECTURE.md §14.1, §2.4, §3.6, §6.3, §10): what it reads beyond `getToday()` for the plans
// waiting and the live cards. Reads go through a PostgREST double that records the columns asked for; every blocking
// sentence and amount comes from the real engine's report 1.2.

const m = vi.hoisted(() => ({ tables: {} as Record<string, unknown[]>, selects: [] as { table: string; columns: string }[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-context", () => ({ currentSession: vi.fn(), getAccountContext: vi.fn(), getPreferences: vi.fn() }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: vi.fn() }));
vi.mock("@/lib/today-data", () => ({ getToday: vi.fn() }));
vi.mock("@/lib/trades-data", () => ({ inBatches: <T,>(values: readonly T[]) => (values.length ? [[...values]] : []), journalHref: () => "/journal" }));
vi.mock("@/lib/workspace", () => ({
  INSTRUMENT_SELECT: "id", RISK_PLAN_SELECT: "id", parseInstrumentRows: (rows: unknown[]) => rows, parseRiskPlanRow: (row: unknown) => row,
  toInstrument: (row: unknown) => row,
}));

import { loadLiveManagement, loadTodayExtras, withBlockedPlanActions } from "@/components/today/load-today";
import { previewContext, previewProposal, previewRiskPlan, usageFixture } from "@/domain/fixtures";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import { deriveTradeState } from "@/domain/trade-state";
import type { Db } from "@/lib/account-context";
import type { TodayData } from "@/lib/today-data";
import type { TradeListRow } from "@/lib/trades-data";

const NOW = "2026-10-23T14:00:00Z"; // Fri Oct 23, 09:00 UTC−5 (kill zone)
const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A PostgREST double: every chain resolves to its table's rows; `select` records the columns asked for. */
function database(): Db {
  const from = (table: string) => {
    const query: Record<string, unknown> = {
      select: (columns: string) => {
        m.selects.push({ table, columns });
        return query;
      },
      eq: () => query, in: () => query, or: () => query, order: () => query, limit: () => query,
      // biome-ignore lint/suspicious/noThenProperty: Models Supabase's thenable query interface.
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => Promise.resolve({ data: m.tables[table] ?? [], error: null }).then(resolve, reject),
    };
    return query;
  };
  return { from } as unknown as Db;
}

/** The engine's report 1.2 for the preview plan on the preview account (equity 10,000, maximum 0.5%) on Oct 23. */
function report(plan: Partial<RiskContext["plan"]> = {}, usage: Partial<DailyUsage> = {}, proposal: Record<string, unknown> = {}, changes: Partial<RiskContext> = {}) {
  const context: RiskContext = {
    ...previewContext, now: NOW, observationDay: "2026-10-23", ...changes, plan: { ...previewRiskPlan, ...plan }, usage: usageFixture({ day: "2026-10-23", ...usage }),
  };
  return evaluateRisk({ ...previewProposal, narrative: "Fixture.", contractConfirmed: true, news: "CLEAR", ...proposal }, context);
}

function ledger(n: number, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: uuid(n), account_id: ACCOUNT, origin: "PLANNED", created_at: "2026-10-23T13:00:00Z", currency: "USD", revision_count: 1, latest_revision: 1,
    entry_time_known: false, lifecycle: "DRAFT", draft_check: "BLOCKED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, symbol: "EURUSD",
    direction: "LONG", entry_model: "OB_FIRST_TOUCH", latest_check_decision: "BLOCKED", latest_check_at: "2026-10-23T13:59:00Z", latest_check_evaluation_id: uuid(n + 100),
    ...changes,
  };
}

function row(trade: LedgerTrade): TradeListRow {
  return {
    id: trade.id, href: `/trades/${trade.id}`, trade, tradeAt: trade.created_at, tradeDay: "2026-10-23", tradeDateSource: "CREATED",
    account: { id: ACCOUNT, name: "FTMO 100K", currency: "USD", status: "ACTIVE" }, state: deriveTradeState(trade, { now: NOW, checkCurrent: false }), thumbnail: null,
    ai: { reviews: 0, preTradeAnalyses: 0, lastCompletedAt: null },
  } as TradeListRow;
}

/**
 * Today's data with only what the loader reads: the live cards, the plans waiting, and the account's workspace day with
 * the trading day of its latest values (`valuesDay`; null without any).
 */
function today(blocked: TradeListRow[], live: TradeListRow[] = [], valuesDay: string | null = "2026-10-22"): TodayData {
  return {
    live: live.map(entry => ({ row: entry, liveSince: entry.trade.created_at, lastJournal: null })),
    plans: { locked: [], ready: [], recheck: [], blocked, unchecked: [] },
    closedToday: [],
    accounts: [{ account: { id: ACCOUNT }, workspace: { day: "2026-10-23", observation: valuesDay === null ? null : { id: uuid(90), tradingDay: valuesDay } } }],
  } as unknown as TodayData;
}

/** A stored check of a blocked draft, as `risk_evaluations` returns it. */
const evaluation = (id: string, result: unknown) => ({
  id, result, proposal: { direction: "LONG", riskPercent: "0.5" }, risk_plan_version_id: previewRiskPlan.id, instrument_version_id: null, strategy_version_id: null,
});

beforeEach(() => {
  m.tables = {};
  m.selects = [];
});

describe("Today · plans blocked today", () => {
  // Requested 1% against a 0.5% maximum, and $100 at risk against the $20 left under a $70 daily risk cap.
  const twoReasons = ledger(1, { latest_check_evaluation_id: uuid(101) });
  // The daily trade limit is used up: only the next trading day clears it.
  const tradeLimit = ledger(2, { latest_check_evaluation_id: uuid(102), symbol: "GBPUSD" });
  // Today's account values are missing: confirming them clears it.
  const staleValues = ledger(3, { latest_check_evaluation_id: uuid(103), symbol: "USDJPY" });

  beforeEach(() => {
    m.tables.risk_evaluations = [
      evaluation(uuid(101), report({ dailyRiskCap: "70" }, { plannedRisk: "50", plannedSlots: 1 }, { riskPercent: "1" })),
      evaluation(uuid(102), report({}, { plannedSlots: 2 })),
      evaluation(uuid(103), report({}, {}, {}, { observationDay: "2026-10-22" })),
    ];
  });

  it("explains each blocked draft by its first reason with how many more its check found, and keeps every finding", async () => {
    const extras = await loadTodayExtras(database(), USER, today([row(twoReasons), row(tradeLimit), row(staleValues)]));
    expect(extras.blockingReasons.get(twoReasons.id)).toBe("Requested risk 1.00% exceeds your configured maximum of 0.50%. (+1 more)");
    expect(extras.blockingReasons.get(tradeLimit.id)).toBe("Daily trade limit reached: 2 of 2 trades already used today (2 planned, 0 recorded live).");
    // The room each daily cap had left when the check ran, exactly as the engine compared it.
    expect(extras.blockingFindings.get(twoReasons.id)).toEqual([{ code: "RISK_LIMIT" }, { code: "DAILY_RISK_LIMIT", room: "20" }]);
    expect(extras.blockingFindings.get(tradeLimit.id)).toEqual([{ code: "MAX_TRADES" }]);
    expect(extras.blockingFindings.get(staleValues.id)).toEqual([{ code: "STALE_EQUITY" }]);
  });

  it("leads a draft that no edit can clear today with the step that does, Edit draft beside it, as its trade page does", async () => {
    const data = today([row(twoReasons), row(tradeLimit), row(staleValues)]);
    const shown = withBlockedPlanActions(data, (await loadTodayExtras(database(), USER, data)).blockingFindings);
    const [edit, wait, confirm] = shown.plans.blocked.map(entry => entry.state);
    // An edit clears the risk reason: Edit draft stays the next step.
    expect(edit).toBe(data.plans.blocked[0].state);
    expect(edit.nextAction?.kind).toBe("EDIT_DRAFT");
    expect(wait.nextAction).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    expect(wait.secondaryActions.map(action => action.kind)).toEqual(["EDIT_DRAFT", "DISCARD"]);
    expect(wait.label).toBe("Blocked");
    expect(confirm.nextAction).toEqual({ kind: "CONFIRM_VALUES", label: "Confirm account values" });
    // Without findings (a check that couldn't be read) nothing changes.
    expect(withBlockedPlanActions(data, new Map())).toBe(data);
  });

  it("offers the recheck, not a second confirmation, once the account has confirmed today's values since the check", async () => {
    const data = today([row(staleValues), row(tradeLimit)], [], "2026-10-23");
    const extras = await loadTodayExtras(database(), USER, data);
    expect(extras.blockingFindings.get(staleValues.id)).toEqual([{ code: "STALE_EQUITY", valuesConfirmed: true }]);
    const [stale, wait] = withBlockedPlanActions(data, extras.blockingFindings).plans.blocked.map(entry => entry.state);
    expect(stale.nextAction).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    expect(stale.secondaryActions.map(action => action.kind)).toEqual(["EDIT_DRAFT", "DISCARD"]);
    expect(wait.nextAction?.kind).toBe("RECHECK_RISK");
    // An account without any values yet still needs them confirmed.
    const none = today([row(staleValues)], [], null);
    expect(withBlockedPlanActions(none, (await loadTodayExtras(database(), USER, none)).blockingFindings).plans.blocked[0].state.nextAction?.kind).toBe("CONFIRM_VALUES");
  });
});

describe("Today · how a live position was managed", () => {
  it("reads each stop move with its stored phase, so one journaled before the entry never reads as the current stop", async () => {
    const live = ledger(4, {
      lifecycle: "LIVE", draft_check: null, latest_check_decision: null, latest_check_at: null, plan_id: uuid(40), locked_at: "2026-10-23T13:10:00Z",
      entered_at: "2026-10-23T13:20:00Z", entry_recorded_at: "2026-10-23T13:21:00Z", entry_price: "1.1", quantity: "0.25",
    });
    m.tables.trade_journal_entries = [
      { id: uuid(41), trade_id: live.id, kind: "STOP_CHANGE", details: { price: "1.1" }, recorded_at: "2026-10-23T13:40:00Z", phase: "PRE_ENTRY" },
      { id: uuid(42), trade_id: live.id, kind: "STOP_CHANGE", details: { price: "1.0995" }, recorded_at: "2026-10-23T13:30:00Z", phase: "LIVE" },
      { id: uuid(43), trade_id: live.id, kind: "PARTIAL_CLOSE", details: { percent: "50" }, recorded_at: "2026-10-23T13:05:00Z", phase: "PRE_ENTRY" },
    ];
    const management = await loadLiveManagement(database(), USER, today([], [row(live)]));
    expect(m.selects).toEqual([{ table: "trade_journal_entries", columns: "id,trade_id,kind,details,recorded_at,phase" }]);
    expect(management.get(live.id)).toEqual({ stop: { price: "1.0995", recordedAt: "2026-10-23T13:30:00Z" }, partials: [] });
  });
});
