import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { type AccountMetricsInput, accountCurrencyTotals, accountMetrics, BALANCE_FROM_TRADES_LABEL, UNKNOWN_REASONS } from "@/domain/account-metrics";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";

const ACCOUNT = "20000000-0000-4000-8000-00000000000a";
const OTHER = "20000000-0000-4000-8000-00000000000b";

let counter = 0;
function trade(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  counter += 1;
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, account_id: ACCOUNT, origin: "PLANNED", created_at: "2026-09-01T10:00:00Z",
    currency: "USD", revision_count: 1, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

function closedTrade(exitedAt: string, net: string, r: string | null, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const sign = new Decimal(net);
  return trade({
    plan_id: "30000000-0000-4000-8000-000000000001", entered_at: exitedAt, entry_recorded_at: exitedAt, entry_price: "1.1", exited_at: exitedAt,
    close_recorded_at: exitedAt, net_pnl: net, realized_r: r, outcome: sign.gt(0) ? "WIN" : sign.lt(0) ? "LOSS" : "BREAKEVEN", ...changes,
  });
}

const trades = [
  closedTrade("2026-09-15T13:00:00Z", "120", "1.2"),
  closedTrade("2026-09-16T04:59:59.999999Z", "-50", "-0.5"),
  closedTrade("2026-09-02T10:00:00Z", "200", "2"),
  closedTrade("2026-09-01T04:00:00Z", "-100", "-1"),
  closedTrade("2026-09-10T10:00:00Z", "-30", null, { origin: "LIVE_FIRST", plan_id: null }),
  trade({ origin: "LIVE_FIRST", entry_recorded_at: "2026-09-15T12:00:00Z", lifecycle: "LIVE" }),
  trade({ plan_id: "30000000-0000-4000-8000-000000000002", locked_at: "2026-09-15T12:00:00Z", lifecycle: "LOCKED" }),
  closedTrade("2026-09-15T13:00:00Z", "999", "9", { account_id: OTHER }),
];

const observation = { balance: "100250.50", equity: "100300", tradingDay: "2026-09-14", recordedAt: "2026-09-14T13:00:00Z" };
const input: AccountMetricsInput = {
  account: { id: ACCOUNT, currency: "USD" },
  profile: { displayName: "FTMO 100K", broker: "FTMO", platform: "MT5", accountType: "EVALUATION", startingBalance: "100000.00", status: "ACTIVE" },
  latestObservation: observation,
  trades,
  now: "2026-09-15T14:00:00Z",
};

describe("account metrics (spec §9.4)", () => {
  const metrics = accountMetrics(input);

  it("describes the account in words", () => {
    expect(metrics).toMatchObject({
      accountId: ACCOUNT, name: "FTMO 100K", currency: "USD", broker: "FTMO",
      type: { value: "EVALUATION", label: "Evaluation" }, platform: { value: "MT5", label: "MetaTrader 5" }, status: { value: "ACTIVE", label: "Active" },
      connection: { state: "MANUAL", label: "Manual" },
    });
  });

  it("shows user-recorded values with their day", () => {
    expect(metrics.lastBalance).toEqual({ value: { amount: "100250.50", day: "2026-09-14", recordedAt: "2026-09-14T13:00:00Z", label: "Balance · recorded Sep 14" }, unknownReason: null });
    expect(metrics.lastEquity.value?.label).toBe("Equity · recorded Sep 14");
    expect(metrics.startingBalance).toEqual({ value: "100000", unknownReason: null });
  });

  it("computes realized P&L and the balance from trades, never called equity", () => {
    expect(metrics.realizedPnl).toBe("140");
    expect(metrics.balanceFromTrades).toEqual({ value: "100140", unknownReason: null });
    expect(BALANCE_FROM_TRADES_LABEL).toBe("Starting balance + realized P&L recorded in Trading OS");
    expect(BALANCE_FROM_TRADES_LABEL.toLowerCase()).not.toContain("equity");
  });

  it("buckets today and this month by the strategy day of exit", () => {
    expect(metrics.todayPnl).toBe("70");
    expect(metrics.monthPnl).toBe("240");
  });

  it("reports R statistics, counts and exclusions", () => {
    expect(metrics.cumulativeR).toEqual({ value: "1.7", unknownReason: null });
    expect(metrics.maxDrawdownR).toEqual({ value: "1", unknownReason: null });
    expect(metrics).toMatchObject({ rTrades: 4, excludedNoRiskBasis: 1, closedCount: 5, openCount: 1 });
  });

  it("marks unknown values instead of estimating them", () => {
    const empty = accountMetrics({ ...input, profile: { ...input.profile, startingBalance: null }, latestObservation: null, trades: [] });
    expect(empty.startingBalance).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.startingBalance });
    expect(empty.balanceFromTrades).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.balanceFromTrades });
    expect(empty.lastBalance).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.accountValues });
    expect(empty.cumulativeR).toEqual({ value: null, unknownReason: UNKNOWN_REASONS.rStatistics });
    expect(empty).toMatchObject({ realizedPnl: "0", todayPnl: "0", monthPnl: "0", closedCount: 0, openCount: 0 });
  });

  it("adds the year to a recorded day from another year", () => {
    const old = accountMetrics({ ...input, latestObservation: { ...observation, tradingDay: "2025-12-31" }, now: "2026-01-05T14:00:00Z" });
    expect(old.lastEquity.value?.label).toBe("Equity · recorded Dec 31, 2025");
  });
});

describe("currency totals", () => {
  it("totals money only within one currency", () => {
    const usd = accountMetrics(input);
    const usd2 = accountMetrics({ ...input, account: { id: OTHER, currency: "USD" } });
    const eur = accountMetrics({ ...input, account: { id: "20000000-0000-4000-8000-00000000000c", currency: "EUR" }, trades: [closedTrade("2026-09-15T13:00:00Z", "80", "1", { account_id: "20000000-0000-4000-8000-00000000000c", currency: "EUR" })] });
    expect(accountCurrencyTotals([usd, eur, usd2])).toEqual([
      { currency: "EUR", accounts: 1, realizedPnl: "80", todayPnl: "80", monthPnl: "80" },
      { currency: "USD", accounts: 2, realizedPnl: "1139", todayPnl: "1069", monthPnl: "1239" },
    ]);
  });
});
