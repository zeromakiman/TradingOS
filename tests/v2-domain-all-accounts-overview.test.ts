import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  allAccountsOverview, balanceTotals, OVERVIEW_TRUNCATED_REASON, type OverviewAccount, overviewBounds, parseOverviewRange, pnlSeries,
} from "@/domain/all-accounts-overview";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";

// The All Accounts overview of Today (V2.1): range bounds on the UTC−5 exit day, money never added across currencies,
// unknown figures propagated, and per-account rows that add up to the cards.

const TODAY = "2026-11-11"; // a Wednesday
const FTMO: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000001", name: "FTMO 100K", currency: "USD", status: "ACTIVE" };
const MFF: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000002", name: "MFF 50K", currency: "USD", status: "ACTIVE" };
const EUR: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000003", name: "Euro demo", currency: "EUR", status: "ACTIVE" };
const EMPTY: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000004", name: "Evaluation", currency: "USD", status: "ACTIVE" };
const OLD: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000005", name: "Old", currency: "USD", status: "ARCHIVED" };
const IDLE_OLD: OverviewAccount = { id: "a0000000-0000-4000-8000-000000000006", name: "Idle old", currency: "USD", status: "ARCHIVED" };
const ACCOUNTS = [FTMO, MFF, EUR, EMPTY, OLD, IDLE_OLD];

let counter = 0;
function closed(account: OverviewAccount, exitedAt: string, r: string | null, pnl: string | null): LedgerTrade {
  counter += 1;
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  const outcome = pnl === null ? "WIN" : new Decimal(pnl).gt(0) ? "WIN" : new Decimal(pnl).lt(0) ? "LOSS" : "BREAKEVEN";
  return {
    ...blank, id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, account_id: account.id, origin: "PLANNED", created_at: exitedAt,
    currency: account.currency, revision_count: 1, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    entered_at: exitedAt, exited_at: exitedAt, realized_r: r, net_pnl: pnl, fees: "0", outcome,
  };
}

// 10:00 UTC−5 (15:00 UTC) on each day, later hours on the same strategy day.
const at = (day: string, hour = 15) => `${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const TRADES = [
  closed(FTMO, at(TODAY), "2", "1000"),
  closed(FTMO, at(TODAY, 16), "-1", "-500"),
  closed(MFF, at(TODAY, 17), "1", "250.5"),
  closed(EUR, at(TODAY, 18), "1.5", "300"),
  closed(OLD, at(TODAY, 19), null, "-20"),
  closed(FTMO, at("2026-11-09"), "3", "1500"), // Monday: this week
  closed(MFF, at("2026-11-02"), "-1", "-250"), // earlier this month
  closed(EUR, at("2026-03-01"), "2", "400"), // earlier this year
];

describe("range", () => {
  it("reads d/w/m/y/all, defaulting to today, and bounds periods by the strategy calendar", () => {
    expect(parseOverviewRange(undefined)).toBe("d");
    expect(parseOverviewRange(["W"])).toBe("w");
    expect(parseOverviewRange("decade")).toBe("d");
    expect(overviewBounds("d", TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(overviewBounds("w", TODAY)).toEqual({ from: "2026-11-09", to: TODAY });
    expect(overviewBounds("w", "2026-11-09")).toEqual({ from: "2026-11-09", to: "2026-11-09" });
    expect(overviewBounds("w", "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(overviewBounds("m", TODAY)).toEqual({ from: "2026-11-01", to: TODAY });
    expect(overviewBounds("y", TODAY)).toEqual({ from: "2026-01-01", to: TODAY });
    expect(overviewBounds("all", TODAY)).toEqual({ from: null, to: TODAY });
  });

  it("counts trades by their UTC−5 exit day, whatever the read returned", () => {
    // 03:00 UTC on Nov 12 is still Nov 11 in UTC−5; 04:00 UTC on Nov 11 is Nov 10.
    const edge = [closed(FTMO, "2026-11-12T03:00:00Z", "1", "10"), closed(FTMO, "2026-11-11T04:00:00Z", "1", "10")];
    expect(allAccountsOverview({ range: "d", today: TODAY, trades: edge, accounts: [FTMO], truncated: false, balances: [] }).trades).toBe(1);
  });
});

describe("figures", () => {
  const day = allAccountsOverview({ range: "d", today: TODAY, trades: TRADES, accounts: ACCOUNTS, truncated: false, balances: [] });

  it("keeps P&L per currency and combines R, win rate and trades", () => {
    expect(day.pnl).toEqual([{ currency: "EUR", netPnl: "300", trades: 1 }, { currency: "USD", netPnl: "730.5", trades: 4 }]);
    expect(day).toMatchObject({ trades: 5, rTrades: 4, excludedNoRiskBasis: 1, wins: 3, losses: 1, totalR: "3.5", averageR: "0.875", winRate: "0.75" });
  });

  it("lists every active account and archived ones with trades, and the rows add up to the cards", () => {
    expect(day.rows.map(row => [row.account.name, row.trades, row.netPnl, row.netR])).toEqual([
      ["FTMO 100K", 2, "500", "1"], ["MFF 50K", 1, "250.5", "1"], ["Euro demo", 1, "300", "1.5"], ["Evaluation", 0, "0", "0"], ["Old", 1, "-20", null],
    ]);
    expect(day.rows.reduce((sum, row) => sum + row.trades, 0)).toBe(day.trades);
    expect(day.rows.reduce((sum, row) => sum.plus(row.netR ?? 0), new Decimal(0)).toFixed()).toBe(day.totalR);
    for (const entry of day.pnl) {
      const rows = day.rows.filter(row => row.account.currency === entry.currency);
      expect(rows.reduce((sum, row) => sum.plus(row.netPnl ?? 0), new Decimal(0)).toFixed()).toBe(entry.netPnl);
    }
  });

  it("widens with the period", () => {
    const counts = (["d", "w", "m", "y", "all"] as const).map(range => allAccountsOverview({ range, today: TODAY, trades: TRADES, accounts: ACCOUNTS, truncated: false, balances: [] }).trades);
    expect(counts).toEqual([5, 6, 7, 8, 8]);
  });

  it("propagates an unknown P&L instead of a partial sum, and shows nothing from a partial read", () => {
    const missing = allAccountsOverview({ range: "d", today: TODAY, trades: [...TRADES.slice(0, 2), closed(FTMO, at(TODAY, 20), "1", null)], accounts: [FTMO], truncated: false, balances: [] });
    expect(missing.pnl).toEqual([{ currency: "USD", netPnl: null, trades: 3 }]);
    expect(missing.rows[0].netPnl).toBeNull();
    expect(missing.series).toEqual([{ currency: "USD", points: [], incomplete: true }]);
    const partial = allAccountsOverview({ range: "all", today: TODAY, trades: TRADES, accounts: ACCOUNTS, truncated: true, balances: [] });
    expect(partial).toMatchObject({ unknownReason: OVERVIEW_TRUNCATED_REASON, pnl: [], totalR: null, winRate: null, series: [] });
    expect(partial.rows.every(row => row.netPnl === null && row.netR === null)).toBe(true);
  });

  it("starts empty periods at zero", () => {
    const none = allAccountsOverview({ range: "d", today: TODAY, trades: [], accounts: [FTMO], truncated: false, balances: [] });
    expect(none).toMatchObject({ trades: 0, totalR: "0", averageR: null, winRate: null, pnl: [], series: [] });
  });
});

describe("chart and balances", () => {
  it("draws one cumulative line per currency: per exit for a day, per strategy day otherwise", () => {
    const today = pnlSeries(TRADES.slice(0, 3), "d");
    expect(today.map(series => series.currency)).toEqual(["USD"]);
    expect(today[0].points.map(point => [point.kind, point.cumulative])).toEqual([["start", "0"], ["trade", "1000"], ["trade", "500"], ["trade", "750.5"]]);
    const month = pnlSeries(TRADES.filter(trade => trade.currency === "USD"), "m");
    expect(month[0].points.map(point => [point.at, point.cumulative, point.trades])).toEqual([
      [null, "0", 0], ["2026-11-02", "-250", 1], ["2026-11-09", "1250", 1], [TODAY, "1980.5", 4],
    ]);
  });

  it("sums recorded balances within one currency only, with the days they were recorded", () => {
    expect(balanceTotals([
      { accountId: FTMO.id, currency: "USD", balance: "100000", day: "2026-11-10" },
      { accountId: MFF.id, currency: "USD", balance: "50000.25", day: "2026-11-08" },
      { accountId: EUR.id, currency: "EUR", balance: "10000", day: "2026-11-11" },
    ])).toEqual([
      { currency: "EUR", total: "10000", accounts: 1, firstDay: "2026-11-11", lastDay: "2026-11-11" },
      { currency: "USD", total: "150000.25", accounts: 2, firstDay: "2026-11-08", lastDay: "2026-11-10" },
    ]);
  });
});
