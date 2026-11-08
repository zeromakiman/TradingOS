import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { evaluateRisk } from "@/domain/risk";
import { type ExplainLookup, explainIssue, explainReport, INVALID_INPUT_FIELD_COPY, RISK_COPY, type RiskIssueInput, riskStatusLine } from "@/domain/risk-explain";
import { evaluationEnvelopeSchema, RISK_RULES, riskReportSchema, riskReportSchemaV12, type StoredRiskReport, storedRiskSchema } from "@/domain/risk-report";

const ids = {
  strategy: "00000000-0000-4000-8000-000000000001",
  plan: "00000000-0000-4000-8000-000000000002",
  instrument: "00000000-0000-4000-8000-000000000003",
  observation: "00000000-0000-4000-8000-000000000004",
};

type Issue = { code: string; severity: "BLOCK" | "WARN"; message: string; params: Record<string, string | number | null> };
const issue = (code: string, severity: "BLOCK" | "WARN" = "BLOCK", params: Issue["params"] = {}): Issue => ({ code, severity, message: `Stored engine text for ${code}.`, params });

interface ReportChanges {
  issues?: Issue[];
  calculations?: Record<string, string | null> | null;
  limits?: Record<string, unknown>;
  instrument?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  top?: Record<string, unknown>;
}

/** A consistent 1.2 report (ruleResults and snapshot sums derived from the inputs). */
function report12(changes: ReportChanges = {}) {
  const issues = changes.issues ?? [issue("COSTS_UNKNOWN", "WARN")];
  const blocked = issues.some(i => i.severity === "BLOCK");
  const snapshot = {
    accountObservationId: ids.observation, observationDay: "2026-09-04", equity: "10000", currency: "USD", instrumentVersionId: ids.instrument,
    plannedSlots: 0, unplannedTrades: 0, plannedRisk: "0", unplannedRisk: "0", unplannedRiskUnknown: 0,
    realizedLoss: "0", externalLoss: "0", legacyReportedLoss: null as string | null, openExposure: "0", openRiskUnknown: 0,
    ...changes.snapshot,
  };
  const limits = { maxRiskPercent: "0.5", defaultRiskPercent: "0.5", minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", maxDailyTrades: 2, dailyRiskCap: null, dailyLossCap: null, riskPlanVersion: "Risk Plan V1.0", ...changes.limits };
  const derived = {
    slotsUsed: snapshot.plannedSlots + snapshot.unplannedTrades,
    executedTrades: snapshot.unplannedTrades,
    maximumDailyTrades: limits.maxDailyTrades,
    riskConsumed: new Decimal(snapshot.plannedRisk).plus(snapshot.unplannedRisk).toFixed(),
    grossLoss: Decimal.max(snapshot.legacyReportedLoss ?? 0, new Decimal(snapshot.realizedLoss).plus(snapshot.externalLoss)).toFixed(),
    // Default: every trade without a risk basis is in both counters (full overlap).
    riskUnknownTrades: Math.max(snapshot.unplannedRiskUnknown, snapshot.openRiskUnknown),
  };
  return {
    engineVersion: "1.1", reportVersion: "1.2", evaluatedAt: "2026-09-04T14:00:00Z", tradingDay: "2026-09-04", session: "ACTIVE_KILL_ZONE",
    strategyVersionId: ids.strategy, riskPlanVersionId: ids.plan, decision: blocked ? "BLOCKED" : "APPROVED", status: blocked ? "TRADE_BLOCKED" : "RISK_APPROVED",
    issues,
    ruleResults: RISK_RULES.map(rule => {
      const found = issues.find(i => i.code === rule);
      return { rule, outcome: found ? found.severity : "PASS", message: found?.message ?? "Check passed." };
    }),
    requestedRiskPercent: "0.5", targetDistance: "0.006", sessionEligible: true,
    calculations: changes.calculations === null ? null : { budget: "50", permittedRisk: "50", stopDistance: "0.002", stopTicks: "200", stopPips: "20", plannedRR: "3", quantity: "0.25", nominalRisk: "50", plannedReward: "150", ...changes.calculations },
    limits,
    instrument: { symbol: "EURUSD", currency: "USD", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", quantityUnit: "lots (100,000 EUR)", ...changes.instrument },
    snapshot: { ...snapshot, ...derived, ...changes.snapshot },
    ...changes.top,
  };
}

function parsed12(changes: ReportChanges = {}): StoredRiskReport {
  return riskReportSchemaV12.parse(report12(changes));
}

const lockable = { ...previewProposal, narrative: "Recorded thesis.", contractConfirmed: true, news: "CLEAR" as const };

/** Stored V1 (engine 1.0) reports exactly as the V1 engine wrote them; stored history never changes. */
const v1Issue = (code: string, severity: "BLOCK" | "WARN", message: string) => ({ code, severity, message });
const V1_NOTES = [
  v1Issue("DAILY_RISK_UNCONFIGURED", "WARN", "No daily monetary risk cap is configured."),
  v1Issue("DAILY_LOSS_UNCONFIGURED", "WARN", "No daily loss cap is configured."),
  v1Issue("COSTS_UNKNOWN", "WARN", "Sizing reflects nominal stop risk; fees, gaps and slippage are not included."),
];
const V1_CALCULATIONS = { budget: "50.00", permittedRisk: "50.00", stopDistance: "0.002", stopTicks: "200", stopPips: "20.0000", plannedRR: "3.00000000", quantity: "0.25", nominalRisk: "50", plannedReward: "150" };
function v1Report(status: "RISK_APPROVED" | "TRADE_BLOCKED", issues: ReturnType<typeof v1Issue>[], calculations: typeof V1_CALCULATIONS | null) {
  return {
    engineVersion: "1.0", evaluatedAt: "2026-09-04T14:00:00Z", tradingDay: "2026-09-04", session: "ACTIVE_KILL_ZONE",
    strategyVersionId: ids.strategy, riskPlanVersionId: ids.plan, status, issues, calculations,
  };
}
const legacyBlockedRr = v1Report("TRADE_BLOCKED", [v1Issue("MIN_RR", "BLOCK", "Planned RR is below 3."), ...V1_NOTES], { ...V1_CALCULATIONS, plannedRR: "2.99500000", plannedReward: "149.75" });
const legacyInvalidEntry = v1Report("TRADE_BLOCKED", [v1Issue("INVALID_INPUT", "BLOCK", "entry: Use a positive decimal, up to 8 decimal places.")], null);
const report11 = {
  ...v1Report("RISK_APPROVED", V1_NOTES, V1_CALCULATIONS), reportVersion: "1.1", decision: "APPROVED", requestedRiskPercent: "0.5", targetDistance: "0.006", sessionEligible: true,
  snapshot: { accountObservationId: ids.observation, observationDay: "2026-09-04", equity: "10000", currency: "USD", instrumentVersionId: ids.instrument, slotsUsed: 0, executedTrades: null, maximumDailyTrades: 2, riskConsumed: "0", grossLoss: null },
  ruleResults: RISK_RULES.map(rule => ({ rule, outcome: "PASS", message: "Check passed." })),
};
const riskPlanRow: NonNullable<ExplainLookup["riskPlan"]> = { maxRiskPercent: "0.50000000", minRR: "3.00000000", dailyRiskCap: "100.00", dailyLossCap: "100.00", rrPolicy: "BLOCK", newsPolicy: "WARN", maxDailyTrades: 2 };
const instrumentRow: NonNullable<ExplainLookup["instrument"]> = { symbol: "EURUSD", currency: "USD", tickSize: "0.00001000", minimumQuantity: "0.01000000", quantityUnit: "lots (100,000 EUR)", quantityStep: "0.01000000" };
const lookup: ExplainLookup = { riskPlan: riskPlanRow, instrument: instrumentRow, strategy: "ICT V1.0" };

const detail = (code: string, severity: "BLOCK" | "WARN", report: StoredRiskReport, params: Issue["params"] = {}, extra: ExplainLookup = {}) =>
  explainIssue({ code, severity, message: "Stored engine text.", params }, report, extra).detail;

describe("report 1.2 schema (spec §6.4)", () => {
  it("accepts consistent approved and blocked reports through every stored entry point", () => {
    const approved = report12();
    const blocked = report12({ issues: [issue("RISK_LIMIT", "BLOCK", { requested: "1", maximum: "0.75" }), issue("COSTS_UNKNOWN", "WARN")] });
    for (const value of [approved, blocked]) {
      expect(riskReportSchemaV12.safeParse(value).success).toBe(true);
      expect(storedRiskSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts a blocked report without calculations (sizing stopped)", () => {
    expect(riskReportSchemaV12.safeParse(report12({ issues: [issue("MISSING_STOP")], calculations: null })).success).toBe(true);
  });

  it("keeps stored 1.1 and legacy reports readable", () => {
    expect(storedRiskSchema.safeParse(report11).success).toBe(true);
    expect(storedRiskSchema.safeParse(legacyBlockedRr).success).toBe(true);
    expect(riskReportSchema.safeParse(report12()).success).toBe(false);
  });

  it("leaves the V1 evaluation envelope contract unchanged (1.1 | legacy only)", () => {
    const envelope = (result: unknown) => ({ planId: null, evaluationId: ids.plan, result, replayed: false });
    expect(evaluationEnvelopeSchema.safeParse(envelope(report11)).success).toBe(true);
    expect(evaluationEnvelopeSchema.safeParse(envelope(report12())).success).toBe(false);
  });

  const valid = report12({ issues: [issue("MIN_RR", "BLOCK", { rr: "2.995", min: "3" })] });
  it.each([
    ["decision without a BLOCK issue", { ...report12(), decision: "BLOCKED" }],
    ["status inconsistent", { ...valid, status: "RISK_APPROVED" }],
    ["approval without calculations", { ...report12(), calculations: null }],
    ["Dead Pool marked eligible", { ...report12(), session: "DEAD_POOL" }],
    ["missing rule result", { ...report12(), ruleResults: report12().ruleResults.slice(1) }],
    ["duplicate rule result", { ...report12(), ruleResults: [...report12().ruleResults.slice(1), report12().ruleResults[1]] }],
    ["issue without matching rule outcome", { ...valid, ruleResults: report12().ruleResults }],
    ["rule outcome without an issue", { ...report12(), ruleResults: report12().ruleResults.map(r => (r.rule === "DUPLICATE" ? { ...r, outcome: "BLOCK" } : r)) }],
    ["non-canonical trailing zeros", report12({ calculations: { budget: "50.00" } })],
    ["non-canonical leading zero", report12({ limits: { maxRiskPercent: "00.5" } })],
    ["exponent notation", report12({ snapshot: { equity: "1e4" } })],
    ["unknown top-level key", { ...report12(), extra: true }],
    ["unknown nested key", report12({ limits: { surprise: "1" } })],
    ["slots not planned + unplanned", report12({ snapshot: { slotsUsed: 3 } })],
    ["executed trades not the unplanned count", report12({ snapshot: { executedTrades: 1 } })],
    ["risk consumed not planned + unplanned", report12({ snapshot: { plannedRisk: "50", riskConsumed: "49" } })],
    ["gross loss not the loss total", report12({ snapshot: { realizedLoss: "20", grossLoss: "10" } })],
    ["maximum trades differ from limits", report12({ snapshot: { maximumDailyTrades: 3 } })],
    ["default risk above maximum", report12({ limits: { defaultRiskPercent: "0.75" } })],
    ["no distinct count of trades without risk", (() => {
      const { riskUnknownTrades: _count, ...snapshot } = report12().snapshot;
      return { ...report12(), snapshot };
    })()],
    ["a distinct count below an overlapping counter", report12({ snapshot: { unplannedRiskUnknown: 1, openRiskUnknown: 2, riskUnknownTrades: 1 } })],
    ["a distinct count above both counters together", report12({ snapshot: { unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 3 } })],
    ["evaluation time without zone", report12({ top: { evaluatedAt: "2026-09-04T14:00:00" } })],
    ["nested params", report12({ issues: [{ ...issue("RISK_LIMIT"), params: { requested: { value: "1" } } as never }] })],
    ["engine version 1.0", { ...report12(), engineVersion: "1.0" }],
  ])("rejects %s", (_name, value) => {
    expect(riskReportSchemaV12.safeParse(value).success).toBe(false);
    expect(storedRiskSchema.safeParse(value).success).toBe(false);
  });

  it("uses greatest(legacy reported loss, realized + external) for the gross loss", () => {
    expect(riskReportSchemaV12.safeParse(report12({ snapshot: { realizedLoss: "20", externalLoss: "5", legacyReportedLoss: "60" } })).success).toBe(true);
    expect(riskReportSchemaV12.safeParse(report12({ snapshot: { realizedLoss: "20", externalLoss: "5", legacyReportedLoss: "60", grossLoss: "25" } })).success).toBe(false);
  });
});

describe("exact sentences for 1.2 reports (spec §6.5)", () => {
  it("RISK_LIMIT shows the requested input exactly and never as the maximum", () => {
    const report = parsed12();
    expect(detail("RISK_LIMIT", "BLOCK", report, { requested: "1", maximum: "0.75" })).toBe("Requested risk 1.00% exceeds your configured maximum of 0.75%.");
    expect(detail("RISK_LIMIT", "BLOCK", report, { requested: "0.504", maximum: "0.5" })).toBe("Requested risk 0.504% exceeds your configured maximum of 0.50%.");
    expect(detail("RISK_LIMIT", "BLOCK", report, { requested: "0.50000001", maximum: "0.5" })).toBe("Requested risk 0.50000001% exceeds your configured maximum of 0.50%.");
    expect(detail("RISK_LIMIT", "BLOCK", parsed12({ top: { requestedRiskPercent: "0.504" } }))).toBe("Requested risk 0.504% exceeds your configured maximum of 0.50%.");
  });

  it("MIN_RR never displays a blocked RR as the minimum", () => {
    expect(detail("MIN_RR", "BLOCK", parsed12({ calculations: { plannedRR: "2.995" } }))).toBe("Planned RR 2.99R is below the required minimum of 3.00R.");
    expect(detail("MIN_RR", "BLOCK", parsed12({ calculations: { plannedRR: "2.99666666" } }))).toBe("Planned RR 2.99R is below the required minimum of 3.00R.");
    expect(detail("MIN_RR", "BLOCK", parsed12(), { rr: "2.995", min: "2.996" })).toBe("Planned RR 2.995R is below the required minimum of 2.996R.");
    expect(detail("MIN_RR", "WARN", parsed12({ calculations: { plannedRR: "2.995" } }))).toBe("Planned RR 2.99R is below your 3.00R minimum. Your risk plan allows it with a warning.");
  });

  it("MAX_TRADES counts planned and live-first trades", () => {
    const report = parsed12({ snapshot: { plannedSlots: 1, unplannedTrades: 1 } });
    expect(detail("MAX_TRADES", "BLOCK", report)).toBe("Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live).");
    expect(detail("MAX_TRADES", "BLOCK", parsed12(), { used: 3, max: 2, planned: 2, unplanned: 1 })).toBe("Daily trade limit reached: 3 of 2 trades already used today (2 planned, 1 recorded live).");
  });

  it("DAILY_RISK_LIMIT shows remaining, nominal and cap consistently with the verdict", () => {
    const capped = (plannedRisk: string, nominalRisk: string) => parsed12({ limits: { dailyRiskCap: "100" }, snapshot: { plannedRisk }, calculations: { nominalRisk } });
    expect(detail("DAILY_RISK_LIMIT", "BLOCK", capped("50.01", "50"))).toBe("Remaining daily risk $49.99 is insufficient for this trade's $50.00 risk (cap $100.00).");
    expect(detail("DAILY_RISK_LIMIT", "BLOCK", capped("50.005", "49.996"))).toBe("Remaining daily risk $49.995 is insufficient for this trade's $49.996 risk (cap $100.00).");
    expect(detail("DAILY_RISK_LIMIT", "BLOCK", capped("120", "48"))).toBe("Remaining daily risk $0.00 is insufficient for this trade's $48.00 risk (cap $100.00).");
    expect(detail("DAILY_RISK_LIMIT", "BLOCK", capped("120", "0"))).toBe("Today's reserved risk $120.00 plus this trade's $0.00 would exceed your daily risk cap of $100.00.");
  });

  it("DAILY_LOSS_LIMIT rounds each part up so the shown sum exceeds the limit", () => {
    const report = (realizedLoss: string, openExposure: string, nominalRisk: string) => parsed12({ limits: { dailyLossCap: "100" }, snapshot: { realizedLoss, openExposure }, calculations: { nominalRisk } });
    expect(detail("DAILY_LOSS_LIMIT", "BLOCK", report("50", "0", "50.01"))).toBe("Today's realized losses $50.00 plus open risk $0.00 plus this trade's $50.01 would exceed your daily loss limit of $100.00.");
    expect(detail("DAILY_LOSS_LIMIT", "BLOCK", report("50.004", "49.996", "0.001"))).toBe("Today's realized losses $50.01 plus open risk $50.00 plus this trade's $0.01 would exceed your daily loss limit of $100.00.");
  });

  it("STALE_EQUITY names the last recorded day", () => {
    expect(detail("STALE_EQUITY", "BLOCK", parsed12({ snapshot: { observationDay: "2026-09-03" } }))).toBe("Confirm today's account balance before locking (last recorded Sep 3).");
    expect(detail("STALE_EQUITY", "BLOCK", parsed12({ top: { tradingDay: "2026-01-02" }, snapshot: { observationDay: "2025-12-31" } }))).toBe("Confirm today's account balance before locking (last recorded Dec 31, 2025).");
  });

  it("instrument sentences use the self-describing instrument", () => {
    const report = parsed12();
    expect(detail("MINIMUM_QUANTITY", "BLOCK", report)).toBe("Your $50.00 risk budget is too small for the minimum position size of 0.01 lots (100,000 EUR) at this stop.");
    expect(detail("OFF_TICK", "BLOCK", report)).toBe("Prices must align to the EURUSD tick size of 0.00001.");
    expect(detail("CONTRACT_UNCONFIRMED", "BLOCK", report)).toBe("Confirm that the EURUSD contract values match your broker.");
    expect(detail("INSTRUMENT_MISMATCH", "BLOCK", parsed12({ instrument: { currency: "EUR" } }))).toBe("EURUSD is valued in EUR, but this account uses USD.");
    expect(detail("INSTRUMENT_MISMATCH", "BLOCK", report)).toBe("This instrument does not belong to the selected trading account.");
  });

  it("PRICE_GEOMETRY uses the direction from params or the proposal", () => {
    const report = parsed12({ calculations: null, issues: [issue("PRICE_GEOMETRY")] });
    expect(detail("PRICE_GEOMETRY", "BLOCK", report, { direction: "LONG" })).toBe("For a long trade, the stop must be below entry and the target above entry.");
    expect(detail("PRICE_GEOMETRY", "BLOCK", report, {}, { proposal: { direction: "SHORT" } })).toBe("For a short trade, the stop must be above entry and the target below entry.");
    expect(detail("PRICE_GEOMETRY", "BLOCK", report)).toBe("The stop and the target must be on opposite sides of entry.");
  });

  it("policy and fixed sentences", () => {
    const report = parsed12();
    expect(detail("DEAD_POOL", "BLOCK", report)).toBe("Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.");
    expect(detail("OUTSIDE_ACTIVE", "WARN", report)).toBe("Outside the active kill zone (02:00–12:00 UTC−5).");
    expect(detail("MISSING_STOP", "BLOCK", report)).toBe("A stop loss is required.");
    expect(detail("DUPLICATE", "BLOCK", report)).toBe("An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today.");
    expect(detail("STRATEGY_CONTRADICTION", "BLOCK", report, { strategy: "ICT V1.0" })).toBe("Blocked because you flagged a contradiction with your ICT V1.0 rules.");
    expect(detail("STRATEGY_CONTRADICTION", "BLOCK", report)).toBe("Blocked because you flagged a contradiction with your strategy rules.");
    expect(detail("NEWS_RESTRICTED", "BLOCK", report)).toBe("You reported a restricted news window. Your risk plan blocks trading in restricted news.");
    expect(detail("NEWS_RESTRICTED", "WARN", report)).toBe("You reported a restricted news window. Your risk plan warns about trading in restricted news.");
    expect(detail("NEWS_UNKNOWN", "WARN", report)).toBe("Economic news has not been checked.");
    expect(detail("DAILY_RISK_UNCONFIGURED", "WARN", report)).toBe("No daily risk cap is configured.");
    expect(detail("DAILY_LOSS_UNCONFIGURED", "WARN", report)).toBe("No daily loss limit is configured.");
    expect(detail("COSTS_UNKNOWN", "WARN", report)).toBe("Sizing uses the stop distance only; fees, gaps and slippage are not included.");
    expect(detail("SIZING_INVARIANT", "BLOCK", report)).toBe("Position sizing failed an internal safety check. Nothing was locked.");
  });

  it("UNPLANNED_RISK_UNKNOWN counts distinct trades without recorded risk (§6.3)", () => {
    const sentence = (snapshot: Record<string, unknown>, params: Issue["params"] = {}) =>
      detail("UNPLANNED_RISK_UNKNOWN", "WARN", parsed12({ issues: [issue("UNPLANNED_RISK_UNKNOWN", "WARN", params)], snapshot }), params);
    // Entered today and still open: one trade in both counters.
    expect(sentence({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 1 })).toBe("1 live-first trade without recorded risk is not included in the daily risk totals.");
    expect(sentence({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 2, riskUnknownTrades: 2 })).toBe("2 live-first trades without recorded risk are not included in the daily risk totals.");
    expect(sentence({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 2, riskUnknownTrades: 3 })).toBe("3 live-first trades without recorded risk are not included in the daily risk totals.");
    expect(sentence({ openRiskUnknown: 1, riskUnknownTrades: 1 }, { n: 1 })).toBe("1 live-first trade without recorded risk is not included in the daily risk totals.");
    expect(sentence({ openRiskUnknown: 2, riskUnknownTrades: 2 }, { n: "2" })).toBe("2 live-first trades without recorded risk are not included in the daily risk totals.");
  });

  it("UNPLANNED_RISK_UNKNOWN falls back to the generic sentence without a usable count", () => {
    const generic = "Live-first trades without recorded risk are not included in the daily risk totals.";
    expect(detail("UNPLANNED_RISK_UNKNOWN", "WARN", parsed12())).toBe(generic);
    expect(detail("UNPLANNED_RISK_UNKNOWN", "WARN", parsed12(), { n: "1.5" })).toBe(generic);
    expect(detail("UNPLANNED_RISK_UNKNOWN", "WARN", storedRiskSchema.parse(report11))).toBe(generic);
  });

  it("INVALID_INPUT renders field-level sentences, never zod paths", () => {
    const report = parsed12({ calculations: null, issues: [issue("INVALID_INPUT")] });
    expect(detail("INVALID_INPUT", "BLOCK", report, { fields: "entry,stop" })).toBe(`${INVALID_INPUT_FIELD_COPY.entry} ${INVALID_INPUT_FIELD_COPY.stop}`);
    expect(detail("INVALID_INPUT", "BLOCK", report, { field: "narrative" })).toBe("Add your thesis: why this trade, and what would invalidate it.");
    const explained = explainReport(storedRiskSchema.parse(legacyInvalidEntry));
    expect(legacyInvalidEntry.issues[0].message).toMatch(/^entry: /);
    expect(explained.blocking[0].detail).toBe("Some trade details are missing or invalid. Review the plan and try again.");
  });

  it("never pairs values that would contradict the verdict (mismatched lookup rows)", () => {
    const legacy = storedRiskSchema.parse(legacyBlockedRr);
    expect(detail("RISK_LIMIT", "BLOCK", legacy, {}, { proposal: { riskPercent: "0.5" }, riskPlan: riskPlanRow })).toBe("Requested risk 0.50% exceeds your configured maximum.");
    expect(detail("MIN_RR", "BLOCK", legacy, {}, { riskPlan: { ...riskPlanRow, minRR: "2.5" } })).toBe("Planned RR 2.99R is below the required minimum.");
  });

  it("unknown future codes get a neutral title and never echo the code", () => {
    const explained = explainIssue({ code: "FUTURE_RULE", severity: "WARN", message: "Something new was observed." }, parsed12());
    expect(explained).toEqual({ code: "FUTURE_RULE", severity: "WARN", title: "Risk Engine finding", detail: "Something new was observed." });
  });
});

describe("1.1 and legacy reports with immutable lookup rows", () => {
  it("reconstructs RISK_LIMIT and MIN_RR", () => {
    const report = storedRiskSchema.parse({ ...report11, requestedRiskPercent: "1" });
    expect(detail("RISK_LIMIT", "BLOCK", report, {}, { riskPlan: { ...riskPlanRow, maxRiskPercent: "0.75000000" } })).toBe("Requested risk 1.00% exceeds your configured maximum of 0.75%.");
    const legacy = storedRiskSchema.parse(legacyBlockedRr);
    expect(explainReport(legacy, lookup).blocking.map(i => i.detail)).toEqual(["Planned RR 2.99R is below the required minimum of 3.00R."]);
  });

  it("degrades gracefully without lookup rows", () => {
    const legacy = storedRiskSchema.parse(legacyBlockedRr);
    expect(detail("RISK_LIMIT", "BLOCK", legacy)).toBe("Requested risk exceeds your configured maximum.");
    expect(detail("MIN_RR", "BLOCK", legacy)).toBe("Planned RR 2.99R is below the required minimum.");
    expect(detail("MAX_TRADES", "BLOCK", legacy)).toBe("Daily trade limit reached.");
    expect(detail("STALE_EQUITY", "BLOCK", legacy)).toBe("Confirm today's account balance before locking.");
    expect(detail("RISK_LIMIT", "BLOCK", legacy, {}, { proposal: { riskPercent: "0.504" }, riskPlan: riskPlanRow })).toBe("Requested risk 0.504% exceeds your configured maximum of 0.50%.");
  });

  it("uses the 1.1 snapshot for trades, daily risk and the V1 loss semantics", () => {
    const report = storedRiskSchema.parse({ ...report11, snapshot: { ...report11.snapshot, slotsUsed: 2, riskConsumed: "50.01000000000000000000000000000000", grossLoss: "50.00" } });
    expect(detail("MAX_TRADES", "BLOCK", report)).toBe("Daily trade limit reached: 2 of 2 trades already used today.");
    expect(detail("DAILY_RISK_LIMIT", "BLOCK", report, {}, lookup)).toBe("Remaining daily risk $49.99 is insufficient for this trade's $50.00 risk (cap $100.00).");
    expect(detail("DAILY_LOSS_LIMIT", "BLOCK", report, {}, lookup)).toBe("Today's reported losses $50.00 plus reserved risk $50.01 plus this trade's $50.00 would exceed your daily loss limit of $100.00.");
    expect(detail("MAX_TRADES", "BLOCK", storedRiskSchema.parse(legacyBlockedRr), {}, lookup)).toBe("Daily trade limit reached: all 2 daily trades are already used.");
  });

  it("explains the legacy daily-loss-unknown block", () => {
    expect(detail("DAILY_LOSS_UNKNOWN", "BLOCK", storedRiskSchema.parse(report11))).toBe("Your daily loss limit needs today's reported losses, which were not recorded.");
  });

  it("never explains a report with rows of another risk plan or instrument version", () => {
    const legacy = storedRiskSchema.parse(legacyBlockedRr);
    const otherVersion = "00000000-0000-4000-8000-000000000099";
    expect(legacy.riskPlanVersionId).toBe(ids.plan);
    expect(detail("MIN_RR", "BLOCK", legacy, {}, { riskPlan: { ...riskPlanRow, id: otherVersion } })).toBe("Planned RR 2.99R is below the required minimum.");
    expect(detail("MIN_RR", "BLOCK", legacy, {}, { riskPlan: { ...riskPlanRow, id: ids.plan } })).toBe("Planned RR 2.99R is below the required minimum of 3.00R.");
    const v11 = storedRiskSchema.parse(report11);
    const instrument = { ...instrumentRow, id: otherVersion };
    expect(detail("OFF_TICK", "BLOCK", v11, {}, { instrument })).toBe("Prices must align to the instrument tick size.");
    expect(detail("OFF_TICK", "BLOCK", v11, {}, { instrument: { ...instrument, id: ids.instrument } })).toBe("Prices must align to the EURUSD tick size of 0.00001.");
    // Legacy reports do not name their instrument version; the row keyed by the proposal is used.
    expect(detail("OFF_TICK", "BLOCK", legacy, {}, { instrument })).toBe("Prices must align to the EURUSD tick size of 0.00001.");
  });

  it("explains legacy instrument findings from the instrument row", () => {
    const legacy = storedRiskSchema.parse(legacyBlockedRr);
    expect(detail("OFF_TICK", "BLOCK", legacy, {}, lookup)).toBe("Prices must align to the EURUSD tick size of 0.00001.");
    expect(detail("MINIMUM_QUANTITY", "BLOCK", legacy, {}, lookup)).toBe("Your $50.00 risk budget is too small for the minimum position size of 0.01 lots (100,000 EUR) at this stop.");
    expect(detail("STRATEGY_CONTRADICTION", "BLOCK", legacy, {}, lookup)).toBe("Blocked because you flagged a contradiction with your ICT V1.0 rules.");
  });
});

describe("report display order and status line", () => {
  const report = parsed12({
    issues: [
      issue("MIN_RR", "BLOCK"), issue("OUTSIDE_ACTIVE", "WARN"), issue("RISK_LIMIT", "BLOCK", { requested: "1", maximum: "0.5" }),
      issue("NEWS_UNKNOWN", "WARN"), issue("DAILY_RISK_UNCONFIGURED", "WARN"), issue("DAILY_LOSS_UNCONFIGURED", "WARN"), issue("COSTS_UNKNOWN", "WARN"),
    ],
    calculations: { plannedRR: "2.995" },
    top: { session: "ASIA" },
  });

  it("lists BLOCK first in engine order, then WARN, with notes collapsed", () => {
    const explained = explainReport(report);
    expect(explained.decision).toBe("BLOCKED");
    expect(explained.blocking.map(i => i.code)).toEqual(["MIN_RR", "RISK_LIMIT"]);
    expect(explained.warnings.map(i => i.code)).toEqual(["OUTSIDE_ACTIVE", "NEWS_UNKNOWN"]);
    expect(explained.notes.map(i => i.code)).toEqual(["DAILY_RISK_UNCONFIGURED", "DAILY_LOSS_UNCONFIGURED", "COSTS_UNKNOWN"]);
  });

  it("leads AI cards with the Risk Engine status", () => {
    expect(riskStatusLine(report)).toBe("Risk Engine · Blocked — Planned RR below minimum");
    expect(riskStatusLine(parsed12({ issues: [issue("RISK_LIMIT")] }))).toBe("Risk Engine · Blocked — Requested risk exceeds maximum");
    expect(riskStatusLine(parsed12())).toBe("Risk Engine · Approved");
    expect(explainReport(storedRiskSchema.parse(evaluateRisk(lockable, previewContext))).decision).toBe("APPROVED");
  });

  it("never shows rule codes or field paths in titles or sentences", () => {
    const codes = [...Object.keys(RISK_COPY), "FUTURE_RULE"];
    const reports: StoredRiskReport[] = [report, parsed12({ limits: { dailyRiskCap: "100", dailyLossCap: "100" } }), storedRiskSchema.parse(legacyBlockedRr), storedRiskSchema.parse(report11)];
    for (const target of reports) {
      for (const code of codes) {
        for (const severity of ["BLOCK", "WARN"] as const) {
          const input: RiskIssueInput = { code, severity, message: code === "FUTURE_RULE" ? "A new finding." : `${code}: entry: raw text` };
          const { title, detail: sentence } = explainIssue(input, target, lookup);
          for (const text of [title, sentence]) {
            expect(text).not.toMatch(/\b[A-Z]{2,}_[A-Z_]{2,}\b/);
            expect(text).not.toMatch(/\b(entry|stop|target|riskPercent|narrative|instrumentId):/);
          }
        }
      }
    }
  });
});
