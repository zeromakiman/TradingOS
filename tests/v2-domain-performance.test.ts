import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { type JournalTrade, metrics, sampleLabel as v1SampleLabel } from "@/domain/analytics";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import {
  accountContribution, breakdown, calendarMonth, dailySeries, dayResult, distributionR, drawdownSeries, EARLY_SAMPLE_NOTE, equityCurveR, groupEvidence,
  isEarlySample, moneyByCurrency, rMetrics, sampleCaveat, sampleLabel,
} from "@/domain/performance";

const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";

function ledger(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: "10000000-0000-4000-8000-000000000001", account_id: ACCOUNT_A, origin: "PLANNED", created_at: "2026-09-01T10:00:00Z",
    currency: "USD", revision_count: 1, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

let counter = 0;
function closed(r: string | null, exitedAt: string, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  counter += 1;
  const net = changes.net_pnl ?? (r === null ? "-10" : new Decimal(r).mul(50).toFixed());
  const sign = new Decimal(net);
  return ledger({
    id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, entered_at: exitedAt, exited_at: exitedAt, realized_r: r, net_pnl: net, fees: "0",
    outcome: sign.gt(0) ? "WIN" : sign.lt(0) ? "LOSS" : "BREAKEVEN", entry_model: "OB_FIRST_TOUCH", direction: "LONG", symbol: "EURUSD", ...changes,
  });
}

/** The same trade as the V1 `journal_analytics` row consumed by `metrics()`. */
function asV1(trade: LedgerTrade): JournalTrade {
  const isClosed = trade.outcome !== null && trade.exited_at !== null;
  return {
    id: trade.id, account_id: trade.account_id, locked_at: "2026-01-01T00:00:00Z", strategy_version_id: "30000000-0000-4000-8000-000000000001",
    risk_plan_version_id: "40000000-0000-4000-8000-000000000001", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0", instrument: "EURUSD",
    entry_model: "OB_FIRST_TOUCH", direction: "LONG", planned_entry: "1.1", initial_stop: "1.098", planned_quantity: "0.25", initial_risk: "50", risk_percent: "0.5",
    strategy_offset: -300, status: isClosed ? "CLOSED" : "TAKEN", execution_id: trade.id, entry_price: "1.1", quantity: "0.25", entered_at: trade.entered_at,
    exit_price: isClosed ? "1.102" : null, exited_at: trade.exited_at, realized_r: trade.realized_r, outcome: trade.outcome, fees: trade.fees, net_pnl: trade.net_pnl,
    setup_grade: null, liquidity_context: null, mss_timeframe: null, tag_source: null,
  };
}

const asNumber = (value: string | null) => (value === null ? null : new Decimal(value).toNumber());

function generated(seed: number, size: number): LedgerTrade[] {
  let state = seed;
  const random = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
  const exits: string[] = [];
  return Array.from({ length: size }, () => {
    const base = Date.UTC(2026, 8, 1) + Math.floor(random() * 30 * 86_400_000);
    const micros = String(Math.floor(random() * 1_000_000)).padStart(6, "0");
    // Some exact ties on purpose: order then falls back to the id.
    const exit = exits.length && random() < 0.1 ? exits[Math.floor(random() * exits.length)] : `${new Date(base).toISOString().slice(0, 19)}.${micros}Z`;
    exits.push(exit);
    const kind = random();
    const r = kind < 0.08 ? "0" : kind < 0.12 ? null : kind < 0.15 ? new Decimal(random()).div(1000).neg().toFixed(32) : new Decimal(random() * 8 - 3).toFixed(Math.floor(random() * 33));
    const open = random() < 0.08;
    const id = `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
    const net = r === null ? "-12.5" : new Decimal(r).mul(50).toFixed(2);
    const sign = new Decimal(net);
    return ledger({
      id, account_id: random() < 0.5 ? ACCOUNT_A : ACCOUNT_B, entered_at: open ? exit : exit, exited_at: open ? null : exit, realized_r: open ? null : r,
      net_pnl: open ? null : net, fees: open ? null : "0", outcome: open ? null : sign.gt(0) ? "WIN" : sign.lt(0) ? "LOSS" : "BREAKEVEN",
    });
  });
}

describe("rMetrics matches V1 metrics() exactly", () => {
  it.each([[1, 0], [2, 1], [3, 7], [4, 60], [5, 400], [6, 1500]])("seed %i with %i trades", (seed, size) => {
    const trades = generated(seed, size);
    const v1 = metrics(trades.map(asV1));
    const v2 = rMetrics(trades);
    expect({ total: v2.total, completed: v2.completed, wins: v2.wins, losses: v2.losses, breakevens: v2.breakevens, currentStreak: v2.currentStreak, maxWins: v2.maxWins, maxLosses: v2.maxLosses, sample: v2.sample, profitFactorState: v2.profitFactorState })
      .toEqual({ total: v1.total, completed: v1.completed, wins: v1.wins, losses: v1.losses, breakevens: v1.breakevens, currentStreak: v1.currentStreak, maxWins: v1.maxWins, maxLosses: v1.maxLosses, sample: v1.sample, profitFactorState: v1.profitFactorState });
    for (const field of ["winRate", "lossRate", "avgWinner", "avgLoser", "averageR", "netR", "expectancy", "profitFactor", "maxDrawdown", "currentDrawdown", "best", "worst"] as const) {
      expect(asNumber(v2[field]), field).toBe(v1[field]);
    }
    expect(equityCurveR(trades).map(p => [p.at, asNumber(p.cumulativeR), asNumber(p.peakR), asNumber(p.drawdownR)])).toEqual(v1.curve.map(p => [p.date, p.cumulativeR, p.peakR, p.drawdownR]));
    expect(v2.excludedNoRiskBasis).toBe(trades.filter(t => t.exited_at !== null && t.outcome !== null && t.realized_r === null).length);
  });

  it("is independent of input order", () => {
    const trades = generated(9, 200);
    expect(rMetrics([...trades].reverse())).toEqual(rMetrics(trades));
  });

  it("handles empty data without fake rates", () => {
    const empty = rMetrics([]);
    expect(empty).toMatchObject({ completed: 0, netR: null, winRate: null, profitFactor: null, profitFactorState: "NO_DATA", maxDrawdown: null, sample: "NO DATA" });
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
    expect(equityCurveR([])).toEqual([{ sequence: 0, tradeId: null, at: null, r: null, cumulativeR: "0", peakR: "0", drawdownR: "0", value: 0 }]);
  });

  it("excludes trades without a risk basis from R statistics with an explicit count", () => {
    const trades = [closed("2", "2026-09-02T10:00:00Z"), closed(null, "2026-09-03T10:00:00Z", { origin: "LIVE_FIRST" }), ledger({ exited_at: null, outcome: null, lifecycle: "LIVE" })];
    expect(rMetrics(trades)).toMatchObject({ total: 3, closed: 2, completed: 1, excludedNoRiskBasis: 1, netR: "2" });
  });

  it("keeps exact decimals as text", () => {
    const m = rMetrics([closed("1", "2026-09-02T10:00:00Z"), closed("1", "2026-09-03T10:00:00Z"), closed("-1", "2026-09-04T10:00:00Z")]);
    expect(m.winRate).toBe("0.6666666666666666666666666666666666666667");
    expect(m.profitFactor).toBe("2");
    expect(m.maxDrawdown).toBe("1");
  });
});

describe("money is grouped by currency only", () => {
  it("never sums across currencies", () => {
    const trades = [
      closed("1", "2026-09-02T10:00:00Z", { net_pnl: "100.25", fees: "1.5" }),
      closed("-1", "2026-09-02T11:00:00Z", { net_pnl: "-40", fees: "1" }),
      closed("2", "2026-09-02T12:00:00Z", { currency: "EUR", account_id: ACCOUNT_B, net_pnl: "380" }),
      ledger({ exited_at: null, outcome: null, net_pnl: null, lifecycle: "LIVE" }),
    ];
    expect(moneyByCurrency(trades)).toEqual([
      { currency: "EUR", closed: 1, netPnl: "380", grossProfit: "380", grossLoss: "0", fees: "0" },
      { currency: "USD", closed: 2, netPnl: "60.25", grossProfit: "100.25", grossLoss: "40", fees: "2.5" },
    ]);
  });
});

describe("series", () => {
  const trades = [closed("2", "2026-09-02T10:00:00Z"), closed("-1", "2026-09-03T10:00:00Z"), closed("-2", "2026-09-04T10:00:00Z"), closed("1", "2026-09-05T10:00:00Z")];

  it("draws the R drawdown below zero", () => {
    expect(drawdownSeries(trades).map(point => [point.drawdownR, point.value])).toEqual([["0", 0], ["0", 0], ["1", -1], ["3", -3], ["2", -2]]);
  });

  it("groups daily results by the strategy day of exit", () => {
    const series = dailySeries([
      closed("1", "2026-09-02T04:59:59.999999Z", { net_pnl: "50" }),
      closed("-1", "2026-09-02T05:00:00Z", { net_pnl: "-50" }),
      closed(null, "2026-09-02T06:00:00Z", { net_pnl: "-20", currency: "EUR" }),
    ]);
    expect(series.map(day => [day.day, day.closed, day.rTrades, day.excluded, day.netR, day.money])).toEqual([
      ["2026-09-01", 1, 1, 0, "1", [{ currency: "USD", netPnl: "50", grossLoss: "0" }]],
      ["2026-09-02", 2, 1, 1, "-1", [{ currency: "EUR", netPnl: "-20", grossLoss: "20" }, { currency: "USD", netPnl: "-50", grossLoss: "50" }]],
    ]);
  });
});

describe("dayResult", () => {
  it("sums one strategy day's closed trades in R and per currency", () => {
    const trades = [
      closed("2", "2026-09-15T13:00:00Z", { net_pnl: "100" }),
      closed("-0.8", "2026-09-16T04:59:59.999999Z", { net_pnl: "-40" }),
      closed(null, "2026-09-15T14:00:00Z", { net_pnl: "-10", currency: "EUR", origin: "LIVE_FIRST" }),
      closed("5", "2026-09-16T05:00:00Z", { net_pnl: "250" }),
    ];
    const result = dayResult(trades, "2026-09-15");
    expect(result).toMatchObject({ day: "2026-09-15", closed: 3, rTrades: 2, losingTrades: 2, netR: "1.2", label: "+1.20R · -€10.00 · +$60.00" });
    expect(dayResult(trades, "2026-09-14")).toMatchObject({ closed: 0, netR: null, money: [], label: "—" });
  });
});

describe("calendarMonth by strategy day of exit (UTC−5)", () => {
  const trades = [
    closed("2", "2026-09-01T04:59:59.999999Z", { net_pnl: "100" }),
    closed("1.5", "2026-09-01T05:00:00Z", { net_pnl: "75" }),
    closed("-1", "2026-09-01T16:00:00Z", { net_pnl: "-50" }),
    closed(null, "2026-09-15T14:00:00Z", { net_pnl: "-30", origin: "LIVE_FIRST" }),
    closed("3", "2026-10-01T04:59:59Z", { currency: "EUR", account_id: ACCOUNT_B, net_pnl: "150" }),
    closed("4", "2026-10-01T05:00:00Z", { net_pnl: "200" }),
  ];

  it("builds Monday-first weeks covering the month", () => {
    const month = calendarMonth(trades, "2026-09", "NET_R");
    expect(month.weeks).toHaveLength(5);
    expect(month.weeks.every(week => week.length === 7)).toBe(true);
    expect(month.weeks[0][0]).toMatchObject({ day: "2026-08-31", inMonth: false, value: null });
    expect(month.weeks[4][6].day).toBe("2026-10-04");
    expect(month.days).toHaveLength(30);
  });

  it("assigns exits to the UTC−5 day and sums R per day", () => {
    const month = calendarMonth(trades, "2026-09", "NET_R");
    const day = (d: string) => month.days.find(cell => cell.day === d);
    expect(day("2026-09-01")).toMatchObject({ closed: 2, rTrades: 2, value: "0.5" });
    expect(day("2026-09-15")).toMatchObject({ closed: 1, rTrades: 0, value: null });
    expect(day("2026-09-30")).toMatchObject({ closed: 1, value: "3" });
    expect(month.closed).toBe(4);
    expect(month.total).toBe("3.5");
    expect(month.extent).toEqual({ min: "0.5", max: "3" });
    expect(calendarMonth(trades, "2026-08", "NET_R").days.find(cell => cell.day === "2026-08-31")?.value).toBe("2");
  });

  it("keeps money modes in one currency", () => {
    const mixed = calendarMonth(trades, "2026-09", "NET_PNL");
    expect(mixed.currencies).toEqual(["EUR", "USD"]);
    expect(mixed.currency).toBeNull();
    expect(mixed.days.every(cell => cell.value === null)).toBe(true);
    const usd = calendarMonth(trades, "2026-09", "NET_PNL", { currency: "USD" });
    expect(usd.days.find(cell => cell.day === "2026-09-01")?.value).toBe("25");
    expect(usd.days.find(cell => cell.day === "2026-09-30")?.value).toBeNull();
    expect(usd.total).toBe("-5");
    const loss = calendarMonth(trades, "2026-09", "GROSS_LOSS", { currency: "USD" });
    expect(loss.days.find(cell => cell.day === "2026-09-01")?.value).toBe("50");
    expect(loss.days.find(cell => cell.day === "2026-09-15")?.value).toBe("30");
    const single = calendarMonth(trades.filter(t => t.currency === "USD"), "2026-09", "NET_PNL");
    expect(single.currency).toBe("USD");
  });

  it("counts trades", () => {
    const count = calendarMonth(trades, "2026-09", "COUNT");
    expect(count.days.find(cell => cell.day === "2026-09-01")).toMatchObject({ value: "2", tradeIds: [trades[1].id, trades[2].id] });
    expect(count.days.find(cell => cell.day === "2026-09-02")?.value).toBeNull();
  });

  it("handles leap February and rejects invalid months", () => {
    expect(calendarMonth([], "2028-02", "COUNT").days).toHaveLength(29);
    expect(calendarMonth([], "2028-02", "COUNT").total).toBeNull();
    expect(() => calendarMonth([], "2026-13", "COUNT")).toThrow();
  });
});

describe("distributionR (0.5R bins)", () => {
  const values = ["1", "1.49", "-0.5", "-0.0002", "0", "3", "-12", "15"];
  const result = distributionR([...values.map((r, i) => closed(r, `2026-09-0${(i % 9) + 1}T10:00:00Z`)), closed(null, "2026-09-09T10:00:00Z")]);
  const bin = (from: string | null) => result.bins.find(b => b.from === from);

  it("uses left-closed bins and contiguous empty bins", () => {
    expect(bin("1")).toMatchObject({ to: "1.5", count: 2, label: "+1.0R to +1.5R" });
    expect(bin("-0.5")).toMatchObject({ to: "0", count: 2, label: "-0.5R to 0.0R" });
    expect(bin("0")).toMatchObject({ count: 1, label: "0.0R to +0.5R" });
    expect(bin("3")?.count).toBe(1);
    expect(bin("2")?.count).toBe(0);
    expect(result.count).toBe(8);
    expect(result.excludedNoRiskBasis).toBe(1);
  });

  it("collects outliers in open-ended edge bins", () => {
    expect(result.bins[0]).toMatchObject({ from: null, to: "-10", count: 1, label: "Below -10.0R" });
    expect(result.bins.at(-1)).toMatchObject({ from: "10", to: null, count: 1, label: "+10.0R and above" });
    expect(result.bins).toHaveLength(42);
    expect(distributionR([])).toEqual({ bins: [], count: 0, excludedNoRiskBasis: 0 });
  });
});

describe("breakdowns with per-group N", () => {
  const trades = [
    ...Array.from({ length: 10 }, (_, i) => closed(i % 2 ? "1" : "-1", `2026-09-${String(i + 1).padStart(2, "0")}T14:00:00Z`, { entry_model: "OTE", requested_risk_percent: "0.50000000" })),
    ...Array.from({ length: 3 }, (_, i) => closed("2", `2026-09-0${i + 1}T23:30:00Z`, { entry_model: "OB_FIRST_TOUCH", requested_risk_percent: "0.25", origin: "LIVE_FIRST", account_id: ACCOUNT_B })),
    closed(null, "2026-09-20T14:00:00Z", { entry_model: null, entered_at: null, requested_risk_percent: null, origin: "IMPORTED" }),
    ledger({ exited_at: null, outcome: null, lifecycle: "LIVE", entry_model: "OTE" }),
  ];

  it("groups by model in a fixed order with evidence labels", () => {
    const groups = breakdown(trades, "model");
    expect(groups.map(g => [g.value, g.label, g.closed, g.metrics.completed, g.evidence, g.evidenceLabel])).toEqual([
      ["OB_FIRST_TOUCH", "OB first touch", 3, 3, "INSUFFICIENT", "Insufficient evidence"],
      ["OTE", "OTE", 10, 10, "EMERGING", "Emerging tendency"],
      [null, "Unknown", 1, 0, "INSUFFICIENT", "Insufficient evidence"],
    ]);
  });

  it("groups by strategy session and weekday of the entry", () => {
    expect(breakdown(trades, "session").map(g => [g.label, g.closed])).toEqual([["Asia", 3], ["Kill zone", 10], ["Unknown", 1]]);
    expect(breakdown(trades, "weekday").map(g => g.value)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", null]);
  });

  it("groups by origin, planned risk and account", () => {
    expect(breakdown(trades, "origin").map(g => g.label)).toEqual(["Planned", "Live-first", "Imported"]);
    expect(breakdown(trades, "riskPercent").map(g => [g.value, g.label])).toEqual([["0.25", "0.25%"], ["0.5", "0.50%"], [null, "No planned risk"]]);
    expect(breakdown(trades, "account", { accountNames: { [ACCOUNT_A]: "FTMO 100K" } }).map(g => g.label)).toEqual(["FTMO 100K", "Trading account"]);
  });

  it("states group evidence at the documented thresholds", () => {
    expect([9, 10, 29, 30].map(n => groupEvidence(n).label)).toEqual(["Insufficient evidence", "Emerging tendency", "Emerging tendency", null]);
  });
});

describe("account contribution", () => {
  it("reports net R, own-currency P&L and share of the combined net R", () => {
    const trades = [
      closed("3", "2026-09-02T10:00:00Z", { net_pnl: "300" }),
      closed("1", "2026-09-03T10:00:00Z", { account_id: ACCOUNT_B, currency: "EUR", net_pnl: "80" }),
    ];
    const rows = accountContribution(trades, [{ id: ACCOUNT_A, name: "FTMO 100K", currency: "USD" }, { id: ACCOUNT_B, name: "Demo EUR", currency: "EUR" }, { id: "20000000-0000-4000-8000-00000000000c", name: "Empty", currency: "GBP" }]);
    expect(rows.map(r => [r.name, r.currency, r.closed, r.netR, r.netPnl, r.shareOfNetR])).toEqual([
      ["FTMO 100K", "USD", 1, "3", "300", "0.75"],
      ["Demo EUR", "EUR", 1, "1", "80", "0.25"],
      ["Empty", "GBP", 0, null, null, null],
    ]);
  });

  it("does not compute shares of a non-positive total", () => {
    const rows = accountContribution([closed("-2", "2026-09-02T10:00:00Z"), closed("1", "2026-09-03T10:00:00Z", { account_id: ACCOUNT_B })]);
    expect(rows.map(r => r.shareOfNetR)).toEqual([null, null]);
  });
});

describe("sample size in words (spec §13.8)", () => {
  it("uses the V1 bands", () => {
    for (let n = 0; n <= 150; n++) expect(sampleLabel(n)).toBe(v1SampleLabel(n));
  });

  it("explains each band", () => {
    expect(sampleCaveat(0)).toBe("No completed trades yet.");
    expect(sampleCaveat(1)).toBe("1 completed trade — early sample; more data is needed before drawing conclusions.");
    expect(sampleCaveat(3)).toBe("3 completed trades — early sample; more data is needed before drawing conclusions.");
    expect(sampleCaveat(12)).toBe("12 completed trades — small sample; treat differences as emerging tendencies, not conclusions.");
    expect(sampleCaveat(45)).toBe("45 completed trades — developing sample; results can still change materially.");
    expect(sampleCaveat(120)).toBe("120 completed trades — larger sample; figures describe the past and are not a forecast.");
    expect(EARLY_SAMPLE_NOTE).toBe("Early sample — more data is needed before drawing strong conclusions.");
    expect([isEarlySample(9), isEarlySample(10)]).toEqual([true, false]);
  });
});
