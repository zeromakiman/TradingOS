import { describe, expect, it } from "vitest";
import { LEDGER_COLUMNS, type LedgerTrade, ledgerRow } from "@/domain/ledger";

// Normative column list, copied from V2_ARCHITECTURE.md §3.12.
const SPEC_COLUMNS = `id, account_id, origin, created_at, duplicated_from, migrated_from, currency,
revision_count, latest_revision, latest_proposal_id, latest_revision_at, latest_check_decision, latest_check_at, latest_check_evaluation_id,
plan_id, locked_at, plan_trading_day, strategy_version_id, strategy_version, risk_plan_version_id, risk_plan_version,
symbol, instrument_version_id, direction, entry_model,
planned_entry, planned_stop, planned_target, requested_risk_percent, planned_rr, planned_quantity, planned_risk,
entry_price, entered_at, entry_time_known, entry_recorded_at, quantity, initial_stop, initial_risk, actual_initial_risk, oversize,
exit_price, exited_at, close_recorded_at, fees, gross_pnl, net_pnl, realized_r, outcome, calculation_version, pnl_source,
disposition, disposition_reason, legacy_decision, discarded_at,
lifecycle, draft_check, review_completed_at,
setup_grade, liquidity_context, mss_timeframe, tags, tag_source,
evidence_count, cover_evidence_id, cover_evidence_kind, journal_count, ai_review_count`.split(",").map(column => column.trim());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A closed planned trade as the view returns it (numerics as trim_scale text). */
const plannedRow = {
  id: uuid(1), account_id: uuid(2), origin: "PLANNED", created_at: "2026-09-04T13:00:00.123456+00:00", duplicated_from: null, migrated_from: null, currency: "USD",
  revision_count: 2, latest_revision: 2, latest_proposal_id: uuid(3), latest_revision_at: "2026-09-04T13:10:00+00:00", latest_check_decision: "APPROVED", latest_check_at: "2026-09-04T13:11:00+00:00", latest_check_evaluation_id: uuid(4),
  plan_id: uuid(5), locked_at: "2026-09-04T13:12:00+00:00", plan_trading_day: "2026-09-04", strategy_version_id: uuid(6), strategy_version: "ICT V1.0", risk_plan_version_id: uuid(7), risk_plan_version: "Risk Plan V1.0",
  symbol: "EURUSD", instrument_version_id: uuid(8), direction: "LONG", entry_model: "OB_FIRST_TOUCH",
  planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "50",
  entry_price: "1.1", entered_at: "2026-09-04T13:30:00+00:00", entry_time_known: true, entry_recorded_at: "2026-09-04T13:31:00+00:00", quantity: "0.25", initial_stop: "1.098", initial_risk: "50", actual_initial_risk: "50", oversize: false,
  exit_price: "1.106", exited_at: "2026-09-04T15:00:00+00:00", close_recorded_at: "2026-09-04T15:01:00+00:00", fees: "0", gross_pnl: "150", net_pnl: "150", realized_r: "3", outcome: "WIN", calculation_version: "FULL_CLOSE_V1", pnl_source: "CALCULATED",
  disposition: null, disposition_reason: null, legacy_decision: null, discarded_at: null,
  lifecycle: "CLOSED", draft_check: null, review_completed_at: null,
  setup_grade: "A", liquidity_context: "PDH", mss_timeframe: "M5", tags: ["london"], tag_source: "V2",
  evidence_count: 2, cover_evidence_id: uuid(9), cover_evidence_kind: "V2", journal_count: 3, ai_review_count: 1,
};

/** A live-first trade: no plan, nothing fabricated in the planned columns, unknown entry time. */
const liveFirstRow = {
  ...plannedRow, id: uuid(11), origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, latest_revision_at: null,
  latest_check_decision: null, latest_check_at: null, latest_check_evaluation_id: null, plan_id: null, locked_at: null, plan_trading_day: null,
  strategy_version_id: null, strategy_version: null, risk_plan_version_id: null, risk_plan_version: null, instrument_version_id: null, entry_model: "OTHER",
  planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null,
  entry_price: null, entered_at: null, entry_time_known: false, quantity: null, initial_stop: null, initial_risk: null, actual_initial_risk: null, oversize: null,
  exit_price: null, exited_at: null, close_recorded_at: null, fees: null, gross_pnl: null, net_pnl: null, realized_r: null, outcome: null, calculation_version: null, pnl_source: null,
  lifecycle: "LIVE", setup_grade: null, liquidity_context: null, mss_timeframe: null, tags: null, tag_source: null, evidence_count: 0, cover_evidence_id: null, cover_evidence_kind: null, journal_count: 0, ai_review_count: 0,
};

describe("trade_ledger row contract (spec §3.12)", () => {
  it("names exactly the normative columns, in order", () => {
    expect(SPEC_COLUMNS).toHaveLength(68);
    expect([...LEDGER_COLUMNS]).toEqual(SPEC_COLUMNS);
    expect(Object.keys(ledgerRow.shape)).toEqual(SPEC_COLUMNS);
  });

  it("parses a closed planned trade with numerics as exact text", () => {
    const trade: LedgerTrade = ledgerRow.parse(plannedRow);
    expect(trade.realized_r).toBe("3");
    expect(typeof trade.planned_risk).toBe("string");
    expect(trade.tags).toEqual(["london"]);
  });

  it("parses a live-first trade with null planned values and no tag set", () => {
    const trade = ledgerRow.parse(liveFirstRow);
    expect(trade.planned_entry).toBeNull();
    expect(trade.tags).toEqual([]);
    expect(trade.entry_time_known).toBe(false);
  });

  it("parses an imported trade with a user-reported or imported P&L and no risk basis", () => {
    const imported = { ...liveFirstRow, id: uuid(12), origin: "IMPORTED", entry_price: "1.1", entered_at: "2026-09-04T13:30:00Z", entry_time_known: true, exited_at: "2026-09-04T14:00:00Z", close_recorded_at: "2026-09-04T14:05:00Z", net_pnl: "-12.5", fees: "1.75", outcome: "LOSS", calculation_version: "UNPLANNED_CLOSE_V1", pnl_source: "IMPORTED", lifecycle: "CLOSED" };
    expect(ledgerRow.parse(imported).realized_r).toBeNull();
  });

  it("keeps long SQL-scale decimals and negatives exact", () => {
    const trade = ledgerRow.parse({ ...plannedRow, realized_r: "-0.00333333333333333333333333333333", net_pnl: "-0.01" });
    expect(trade.realized_r).toBe("-0.00333333333333333333333333333333");
  });

  it.each([
    ["a JavaScript number for a numeric column", { ...plannedRow, realized_r: 3 }],
    ["exponent text", { ...plannedRow, net_pnl: "1e2" }],
    ["a missing column", Object.fromEntries(Object.entries(plannedRow).filter(([key]) => key !== "oversize"))],
    ["an unknown column", { ...plannedRow, status: "CLOSED" }],
    ["an unknown lifecycle", { ...plannedRow, lifecycle: "OPEN" }],
    ["an unknown origin", { ...plannedRow, origin: "MANUAL" }],
    ["a timestamp without zone", { ...plannedRow, exited_at: "2026-09-04T15:00:00" }],
    ["an impossible day", { ...plannedRow, plan_trading_day: "2026-02-30" }],
    ["a negative count", { ...plannedRow, evidence_count: -1 }],
    ["a lowercase currency", { ...plannedRow, currency: "usd" }],
  ])("rejects %s", (_name, row) => expect(ledgerRow.safeParse(row).success).toBe(false));

  it("parses pages of rows", () => {
    expect([plannedRow, liveFirstRow].map(row => ledgerRow.parse(row).origin)).toEqual(["PLANNED", "LIVE_FIRST"]);
    expect(() => [plannedRow, { ...plannedRow, id: "not-a-uuid" }].map(row => ledgerRow.parse(row))).toThrow();
  });
});
