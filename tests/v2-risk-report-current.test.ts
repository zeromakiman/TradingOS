import { afterEach, describe, expect, it, vi } from "vitest";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import { isRiskReportCurrent, RISK_RULES, riskReportSchema, riskReportSchemaV12, storedRiskSchema } from "@/domain/risk-report";

// Spec §2.2 / §6.4: whether a stored check still describes the present is decided from the stored report, the
// server context (usage of the strategy day) and the server time the page passes in, never the browser clock (C8).

const NOW = previewContext.now; // 2026-09-04T14:00:00Z, active kill zone of 2026-09-04
const lockable = { ...previewProposal, narrative: "Freshness check.", contractConfirmed: true, news: "CLEAR" as const };
const observationId = previewContext.observationId;

function checked(usage: Partial<DailyUsage> = {}, changes: Partial<RiskContext> = {}) {
  const context: RiskContext = { ...previewContext, ...changes, usage: usageFixture(usage, changes.usage ?? previewContext.usage) };
  return { context, report: riskReportSchemaV12.parse(evaluateRisk(lockable, context)) };
}

afterEach(() => { vi.useRealTimers(); });

describe("isRiskReportCurrent for report 1.2", () => {
  it("is current for the same context at the server time of the check, with any identifier case and a Date", () => {
    const { context, report } = checked();
    expect(report.decision).toBe("APPROVED");
    expect(isRiskReportCurrent(report, context, observationId, NOW)).toBe(true);
    expect(isRiskReportCurrent(report, context, observationId, new Date(NOW))).toBe(true);
    const upper: RiskContext = {
      ...context, strategyVersionId: context.strategyVersionId.toUpperCase(), plan: { ...context.plan, id: context.plan.id.toUpperCase() },
      instrument: { ...context.instrument, id: context.instrument.id.toUpperCase() },
    };
    expect(isRiskReportCurrent(report, upper, observationId.toUpperCase(), NOW)).toBe(true);
  });

  it("decides with the server time passed in, never the browser clock or context.now (C8)", () => {
    const { context, report } = checked();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    expect(isRiskReportCurrent(report, context, observationId, NOW)).toBe(true);
    // A Dead Pool context.now does not matter; a Dead Pool `now` does.
    expect(isRiskReportCurrent(report, { ...context, now: "2026-09-04T18:00:00Z" }, observationId, NOW)).toBe(true);
    expect(isRiskReportCurrent(report, context, observationId, "2026-09-04T18:00:00Z")).toBe(false);
  });

  it("is not current in another session of the same strategy day", () => {
    const judas = checked({}, { now: "2026-09-04T06:30:00Z" });
    expect(judas.report.session).toBe("JUDAS");
    expect(isRiskReportCurrent(judas.report, judas.context, observationId, "2026-09-04T06:59:59.999Z")).toBe(true);
    expect(isRiskReportCurrent(judas.report, judas.context, observationId, "2026-09-04T07:00:00Z")).toBe(false);
  });

  it("is not current when the usage was computed for another strategy day than now, even with equal values", () => {
    const { context, report } = checked();
    expect(isRiskReportCurrent(report, { ...context, usage: { ...context.usage, day: "2026-09-03" } }, observationId, NOW)).toBe(false);
    // Across midnight UTC−5 the report's own day is over as well.
    expect(isRiskReportCurrent(report, { ...context, usage: { ...context.usage, day: "2026-09-05" } }, observationId, "2026-09-05T07:00:00Z")).toBe(false);
  });

  it("compares the distinct count of trades without recorded risk", () => {
    const { context, report } = checked({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 1 });
    expect(report.issues.find(issue => issue.code === "UNPLANNED_RISK_UNKNOWN")?.params).toEqual({ n: 1 });
    expect(isRiskReportCurrent(report, context, observationId, NOW)).toBe(true);
    const second = usageFixture({ riskUnknownTrades: 2 }, context.usage);
    expect(isRiskReportCurrent(report, { ...context, usage: second }, observationId, NOW)).toBe(false);
  });

  it("compares usage values exactly, whatever their scale", () => {
    const { context, report } = checked({ plannedSlots: 1, plannedRisk: "50", openExposure: "50", realizedLoss: "12.5", legacyReportedLoss: "20" });
    expect(report.snapshot).toMatchObject({ plannedRisk: "50", openExposure: "50", realizedLoss: "12.5", legacyReportedLoss: "20", grossLoss: "20" });
    const sqlScale = usageFixture({
      plannedRisk: "50.00000000000000000000000000000000", openExposure: "50.00", realizedLoss: "12.50", legacyReportedLoss: "20.00", lossTotal: "20.00",
    }, context.usage);
    expect(isRiskReportCurrent(report, { ...context, usage: sqlScale }, observationId, NOW)).toBe(true);
    for (const change of [{ legacyReportedLoss: null }, { legacyReportedLoss: "20.01" }, { realizedLoss: "12.51" }, { openExposure: "49.99" }] as const) {
      expect(isRiskReportCurrent(report, { ...context, usage: usageFixture(change, context.usage) }, observationId, NOW), JSON.stringify(change)).toBe(false);
    }
  });
});

describe("isRiskReportCurrent for stored 1.1 and legacy reports", () => {
  const legacy = {
    engineVersion: "1.0", evaluatedAt: NOW, tradingDay: "2026-09-04", session: "ACTIVE_KILL_ZONE", strategyVersionId: previewContext.strategyVersionId,
    riskPlanVersionId: previewContext.plan.id, status: "RISK_APPROVED", issues: [],
    calculations: { budget: "50.00", permittedRisk: "50.00", stopDistance: "0.002", stopTicks: "200", stopPips: "20.0000", plannedRR: "3.00000000", quantity: "0.25", nominalRisk: "50", plannedReward: "150" },
  };
  const v11 = riskReportSchema.parse({
    ...legacy, reportVersion: "1.1", decision: "APPROVED", requestedRiskPercent: "0.5", targetDistance: "0.006", sessionEligible: true,
    snapshot: { accountObservationId: observationId, observationDay: "2026-09-04", equity: "10000.00", currency: "USD", instrumentVersionId: previewContext.instrument.id,
      slotsUsed: 1, executedTrades: null, maximumDailyTrades: 2, riskConsumed: "50.00000000000000000000000000000000", grossLoss: null },
    ruleResults: RISK_RULES.map(rule => ({ rule, outcome: "PASS", message: "Check passed." })),
  });

  it("never treats a 1.1 approval as current, even when its day, session, versions, slots and reserved risk still match", () => {
    const today = usageFixture({ plannedSlots: 1, plannedRisk: "50" });
    expect(isRiskReportCurrent(v11, { ...previewContext, usage: today }, observationId, NOW)).toBe(false);
    expect(isRiskReportCurrent(v11, { ...previewContext, usage: usageFixture({ unplannedTrades: 1, unplannedRisk: "20" }, today) }, observationId, NOW)).toBe(false);
    expect(isRiskReportCurrent(v11, { ...previewContext, usage: usageFixture({ plannedSlots: 2, plannedRisk: "100" }, today) }, observationId, NOW)).toBe(false);
    expect(isRiskReportCurrent(v11, { ...previewContext, usage: { ...today, day: "2026-09-03" } }, observationId, NOW)).toBe(false);
    expect(isRiskReportCurrent(v11, { ...previewContext, usage: today }, observationId, "2026-09-04T17:00:00Z")).toBe(false);
    // The 1.2 check of the same proposal in the same context is current: only the engine version decides here.
    const { context, report } = checked({ plannedSlots: 1, plannedRisk: "50" });
    expect(report.decision).toBe("APPROVED");
    expect(isRiskReportCurrent(report, context, observationId, NOW)).toBe(true);
  });

  it("would otherwise show 'Ready to lock' for a plan that engine 1.2 blocks at the lock (loss limit 100)", () => {
    // Stored by engine 1.0 on the deploy day: V1 typed gross loss 0 + 50 reserved + nominal 50 = 100 <= 100, APPROVED.
    const approved = riskReportSchema.parse({
      ...v11, evaluatedAt: "2026-09-04T13:30:00Z",
      issues: [{ code: "DAILY_RISK_UNCONFIGURED", severity: "WARN", message: "No daily monetary risk cap is configured." }],
      snapshot: { ...v11.snapshot, slotsUsed: 1, riskConsumed: "50.00000000000000000000000000000000", grossLoss: "0.00" },
    });
    const limited = { ...previewContext, plan: { ...previewContext.plan, dailyLossCap: "100" } };
    // Same slots and reserved risk after the deploy; engine 1.2 also reads open exposure and recorded losses.
    for (const usage of [
      usageFixture({ plannedSlots: 1, plannedRisk: "50", openExposure: "110", legacyReportedLoss: "0" }),
      usageFixture({ plannedSlots: 1, plannedRisk: "50", openExposure: "50", externalLoss: "20", legacyReportedLoss: "0" }),
    ]) {
      const context = { ...limited, usage };
      const lock = evaluateRisk(lockable, context);
      expect(lock.decision, JSON.stringify(usage)).toBe("BLOCKED");
      expect(lock.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code)).toEqual(["DAILY_LOSS_LIMIT"]);
      expect(lock.snapshot).toMatchObject({ slotsUsed: approved.snapshot.slotsUsed, riskConsumed: "50" });
      expect(isRiskReportCurrent(approved, context, observationId, NOW), JSON.stringify(usage)).toBe(false);
    }
  });

  it("never treats a legacy 1.0 report, or a check without an observation, as current", () => {
    expect(isRiskReportCurrent(storedRiskSchema.parse(legacy), previewContext, observationId, NOW)).toBe(false);
    const { context, report } = checked();
    expect(isRiskReportCurrent(report, context, undefined, NOW)).toBe(false);
  });
});
