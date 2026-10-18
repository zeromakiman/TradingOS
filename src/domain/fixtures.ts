import Decimal from "decimal.js";
import type { DailyUsage, Instrument, Proposal, RiskContext, RiskPlan } from "./risk";

/** Synthetic preview data (the signed-out preview page and tests). Never real account data. */
export const previewInstrument: Instrument = { id: "00000000-0000-4000-8000-000000000003", symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" };
export const previewRiskPlan: RiskPlan = { id: "00000000-0000-4000-8000-000000000002", version: "Risk Plan V1.0", maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null };
export const previewProposal: Proposal = { instrumentId: previewInstrument.id, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5", narrative: "", contractConfirmed: false, news: "UNKNOWN", contradiction: false };
/** A day with nothing reserved, recorded or lost yet. */
export const previewUsage: DailyUsage = {
  day: "2026-09-04", plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0,
  realizedLoss: "0", externalLoss: "0", legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0",
};
export const previewContext: RiskContext = {
  now: "2026-09-04T14:00:00Z", strategyVersionId: "00000000-0000-4000-8000-000000000001", strategyVersion: "ICT V1.0",
  observationId: "00000000-0000-4000-8000-000000000004", observationDay: "2026-09-04", equity: "10000", currency: "USD",
  plan: previewRiskPlan, instrument: previewInstrument, usage: previewUsage, duplicate: false,
};

const exact = Decimal.clone({ precision: 100 });

/**
 * A consistent usage object: `changes` over `base`, with `lossTotal` derived as
 * greatest(legacyReportedLoss, realizedLoss + externalLoss) and `riskUnknownTrades` as full overlap of
 * the two unknown-risk counters, unless either is given explicitly.
 */
export function usageFixture(changes: Partial<DailyUsage> = {}, base: DailyUsage = previewUsage): DailyUsage {
  const merged = { ...base, ...changes };
  return {
    ...merged,
    lossTotal: changes.lossTotal ?? exact.max(merged.legacyReportedLoss ?? 0, new exact(merged.realizedLoss).plus(merged.externalLoss)).toFixed(),
    riskUnknownTrades: changes.riskUnknownTrades ?? Math.max(merged.unplannedRiskUnknown, merged.openRiskUnknown),
  };
}
