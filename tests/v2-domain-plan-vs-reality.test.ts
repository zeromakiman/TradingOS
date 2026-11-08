import { describe, expect, it } from "vitest";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { entrySlippage, NO_PLAN_RECORDED, type PlanInstrument, planVsReality, sizeComparison, sizeDeviationWarning } from "@/domain/plan-vs-reality";

const EURUSD: PlanInstrument = { tickSize: "0.00001", pipSize: "0.0001", quantityStep: "0.01", quantityUnit: "lots (100,000 EUR)" };

function trade(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: "10000000-0000-4000-8000-000000000001", account_id: "20000000-0000-4000-8000-000000000001", origin: "PLANNED", created_at: "2026-09-04T12:00:00Z",
    currency: "USD", revision_count: 1, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    plan_id: "30000000-0000-4000-8000-000000000001", direction: "LONG", entry_model: "OB_FIRST_TOUCH",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", planned_quantity: "0.25", planned_risk: "50", planned_rr: "3", requested_risk_percent: "0.5",
    ...changes,
  };
}

describe("plan vs reality for planned trades (spec §8.5)", () => {
  it("S4: an oversized fill keeps planned R and shows the R on actual risk", () => {
    const result = planVsReality(trade({ entry_price: "1.1", quantity: "1", initial_stop: "1.098", actual_initial_risk: "200", oversize: true, exit_price: "1.104", net_pnl: "400", realized_r: "8" }), EURUSD, { equity: "10000", maxRiskPercent: "0.5" });
    if (result.kind !== "PLANNED") throw new Error("expected a planned comparison");
    expect(result.size).toEqual({ planned: "0.25", actual: "1.00", ratio: "4.00", oversized: true, label: "1.00 vs 0.25 lots (4.00×)" });
    expect(result.actualRisk).toBe("200");
    expect(result.realizedR).toBe("8");
    expect(result.realizedRActualRisk).toBe("2");
    expect(result.riskAtStopPercent).toBe("2.00");
    expect(result.rows.map(row => [row.key, row.planned, row.actual, row.note, row.flag])).toEqual([
      ["ENTRY", "1.10000", "1.10000", "At the planned entry", null],
      ["STOP", "1.09800", "1.09800", "The locked stop stays the R basis.", null],
      ["SIZE", "0.25", "1.00", "4.00× of plan", "OVERSIZED"],
      ["RISK", "$50.00", "$200.00", "Risk at stop 2.00% of equity", null],
      ["TARGET", "1.10600", "1.10400", null, null],
      ["RR", "3.00R", "+8.00R", null, null],
      ["MODEL", "OB first touch", "OB first touch", null, null],
    ]);
  });

  it("S5: a worse fill shows adverse slippage in ticks and pips", () => {
    const result = planVsReality(trade({ entry_price: "1.101", quantity: "0.25", actual_initial_risk: "75", exit_price: "1.098", net_pnl: "-75", realized_r: "-1.5" }), EURUSD);
    if (result.kind !== "PLANNED") throw new Error("expected a planned comparison");
    expect(result.slippage).toEqual({ ticks: "100", pips: "10", effect: "ADVERSE", label: "+100 ticks · +10.0 pips (worse than plan)" });
    expect(result.realizedR).toBe("-1.5");
    expect(result.realizedRActualRisk).toBe("-1");
    expect(result.size?.oversized).toBe(false);
    expect(result.rows.find(row => row.key === "SIZE")?.flag).toBeNull();
  });

  it("signs slippage by price and classifies its effect by direction", () => {
    expect(entrySlippage("SHORT", "1.2725", "1.2727", EURUSD)).toEqual({ ticks: "20", pips: "2", effect: "FAVORABLE", label: "+20 ticks · +2.0 pips (better than plan)" });
    expect(entrySlippage("SHORT", "1.2725", "1.27249", EURUSD)).toEqual({ ticks: "-1", pips: "-0.1", effect: "ADVERSE", label: "-1 tick · -0.1 pips (worse than plan)" });
    expect(entrySlippage("LONG", "1.1", "1.0999", { ...EURUSD, pipSize: null })).toEqual({ ticks: "-10", pips: null, effect: "FAVORABLE", label: "-10 ticks (better than plan)" });
  });

  it("never shows an oversized ratio as 1.00×", () => {
    expect(sizeComparison("1000", "1000.01", "0.01").ratio).toBe("1.01");
    expect(sizeComparison("0.3", "0.1", "0.01").ratio).toBe("0.34");
    expect(sizeComparison("0.25", "0.25", "0.01")).toMatchObject({ ratio: "1.00", oversized: false });
  });

  it("asks to confirm an oversized entry with exact copy", () => {
    expect(sizeDeviationWarning("1", "0.25", "0.01")).toBe("Actual size 1.00 exceeds the plan's 0.25 (4.00×). This will be recorded as a size deviation.");
    expect(sizeDeviationWarning("1000.01", "1000", "0.01")).toBe("Actual size 1000.01 exceeds the plan's 1000.00 (1.01×). This will be recorded as a size deviation.");
    expect(sizeDeviationWarning("0.25", "0.25", "0.01")).toBeNull();
    expect(sizeDeviationWarning("0.1", "0.25", "0.01")).toBeNull();
  });

  it("never rounds the planned RR up across its minimum", () => {
    const rr = (planned_rr: string, minRR?: string) => {
      const result = planVsReality(trade({ planned_rr }), EURUSD, { minRR });
      return result.rows.find(row => row.key === "RR")?.planned;
    };
    expect(rr("2.99666666")).toBe("2.99R");
    expect(rr("2.99666666", "3")).toBe("2.99R");
    expect(rr("3", "3")).toBe("3.00R");
    expect(rr("2.995", "2.995")).toBe("2.995R");
  });

  it("shows only the plan before entry", () => {
    const result = planVsReality(trade({ lifecycle: "LOCKED" }), EURUSD);
    if (result.kind !== "PLANNED") throw new Error("expected a planned comparison");
    expect(result.slippage).toBeNull();
    expect(result.size).toBeNull();
    expect(result.rows.every(row => row.actual === null)).toBe(true);
  });

  it("expresses risk at stop against the maximum without contradicting it", () => {
    const at = (actual: string) => {
      const result = planVsReality(trade({ entry_price: "1.1", quantity: "0.25", actual_initial_risk: actual }), EURUSD, { equity: "10000", maxRiskPercent: "0.5" });
      return result.kind === "PLANNED" ? result.riskAtStopPercent : null;
    };
    expect(at("49.99")).toBe("0.50");
    expect(at("50")).toBe("0.50");
    expect(at("50.01")).toBe("0.51");
    expect(planVsReality(trade({ actual_initial_risk: "49.99", entry_price: "1.1" }), EURUSD, { equity: "10000" }).kind === "PLANNED").toBe(true);
  });

  it("decides risk at stop by cross-multiplication, also when the percent never terminates", () => {
    const at = (actual: string) => {
      const result = planVsReality(trade({ entry_price: "1.1", quantity: "0.25", actual_initial_risk: actual }), EURUSD, { equity: "30000", maxRiskPercent: "0.33333333" });
      return result.kind === "PLANNED" ? result.riskAtStopPercent : null;
    };
    // 99.999999 × 100 = 0.33333333 × 30000 exactly: at the maximum, shown equal.
    expect(at("99.999999")).toBe("0.33333333");
    // 0.333333333…% exceeds the 8-decimal maximum: shown above it, never rounded onto it.
    expect(at("100")).toBe("0.33333334");
    expect(at("99.9999991")).toBe("0.33333334");
    expect(at("99.9999989")).toBe("0.33333333");
  });
});

describe("live-first and imported trades", () => {
  it("never fabricate a planned column", () => {
    const result = planVsReality(trade({
      origin: "LIVE_FIRST", plan_id: null, planned_entry: null, planned_stop: null, planned_target: null, planned_quantity: null, planned_risk: null, planned_rr: null,
      entry_model: "OTHER", entry_price: "1.1", initial_stop: "1.098", quantity: "0.5", initial_risk: "100", exit_price: "1.102", realized_r: "1", net_pnl: "100",
    }), EURUSD);
    expect(result.kind).toBe("NO_PLAN");
    if (result.kind !== "NO_PLAN") return;
    expect(result.message).toBe(NO_PLAN_RECORDED);
    expect(NO_PLAN_RECORDED).toBe("No pre-trade plan recorded");
    expect(result.rows.every(row => row.planned === null)).toBe(true);
    expect(result.rows.map(row => row.actual)).toEqual(["1.10000", "1.09800", "0.50", "$100.00", "1.10200", "+1.00R", "Other"]);
  });

  it("show unknown details as missing", () => {
    const result = planVsReality(trade({ origin: "IMPORTED", plan_id: null, planned_entry: null, entry_model: null }), null);
    expect(result.rows.map(row => row.actual)).toEqual([null, null, null, null, null, null, null]);
  });
});
