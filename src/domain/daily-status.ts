import Decimal from "decimal.js";
import { formatMoney, formatMoneyAgainst, formatMoneyExact, formatMoneyUp } from "./format";
import { type DailyUsage, dailyUsageSchema } from "./risk";
import { RISK_COPY, unplannedRiskSentence } from "./risk-explain";
import { type Session, strategyClock } from "./session";
import { formatDay, type Instant, toDate } from "./time-display";

/** The canonical daily usage contract lives with the engine (spec §6.7); re-exported for existing importers. */
export { type DailyUsage, dailyUsageSchema };

/**
 * Account-level trading status for Today (spec §14.1). Every BLOCK reason is one the Risk
 * Engine 1.2 would also block for any otherwise valid proposal in the same context (MAX_TRADES,
 * DEAD_POOL, STALE_EQUITY, DAILY_RISK_LIMIT, DAILY_LOSS_LIMIT); the Today card never invents a
 * restriction of its own. A valid proposal always has positive nominal risk, so a cap that is
 * already used up blocks it. Usage of another strategy day is never judged (stale state).
 */

const exact = Decimal.clone({ precision: 100 });

/** Structural subset of the engine's RiskContext the status needs. */
export interface DailyStatusContext {
  /** Server time, never the browser clock. */
  now: Instant;
  /** Strategy day of the latest account values; null when none were ever recorded. */
  observationDay: string | null;
  currency: string;
  plan: { maxDailyTrades: number; dailyRiskCap: string | null; dailyLossCap: string | null };
}

/** Engine rule codes, plus the Today-only `USAGE_OUT_OF_DATE` (usage of another strategy day). */
export type DailyReasonCode =
  | "MAX_TRADES" | "DEAD_POOL" | "STALE_EQUITY" | "DAILY_RISK_LIMIT" | "DAILY_LOSS_LIMIT" | "OUTSIDE_ACTIVE" | "UNPLANNED_RISK_UNKNOWN"
  | "USAGE_OUT_OF_DATE";
export type DailyActionKind = "CONFIRM_ACCOUNT_VALUES" | "ADD_ENTRY_DETAILS" | "ADD_EXTERNAL_LOSS" | "REFRESH";

export interface DailyAction {
  kind: DailyActionKind;
  label: string;
}

export interface DailyReason {
  code: DailyReasonCode;
  severity: "BLOCK" | "WARN";
  message: string;
  action?: DailyAction;
}

export interface DailyStats {
  trades: { used: number; planned: number; unplanned: number; max: number; left: number; label: string };
  risk: { used: string; cap: string | null; left: string | null; label: string };
  losses: {
    total: string; realized: string; external: string; openExposure: string; cap: string | null;
    label: string; action: DailyAction;
  };
  accountValues: { confirmedToday: boolean; observationDay: string | null; label: string; action?: DailyAction };
}

interface DailyStatusBase {
  headline: string;
  /** BLOCK first, then WARN, each in engine order. */
  reasons: DailyReason[];
  /** Strategy day of `now`. */
  day: string;
  session: Session;
  /** Strategy day the usage was computed for. */
  usageDay: string;
}

/** Usage of the current strategy day, judged like the engine would. */
export interface CurrentDailyStatus extends DailyStatusBase {
  stale: false;
  allowed: boolean;
  tone: "positive" | "warning" | "negative";
  stats: DailyStats;
}

/**
 * Usage computed for another strategy day than `now` (a render across midnight UTC−5, a cached
 * page): nothing is judged from it. No BLOCK reasons, no stats, never "You can trade"; only a
 * refresh prompt.
 */
export interface StaleDailyStatus extends DailyStatusBase {
  stale: true;
  allowed: false;
  tone: "warning";
  stats: null;
}

export type DailyStatus = CurrentDailyStatus | StaleDailyStatus;

export const STALE_USAGE_HEADLINE = "Today's usage is out of date — refresh";

const CONFIRM_ACCOUNT_VALUES: DailyAction = { kind: "CONFIRM_ACCOUNT_VALUES", label: "Confirm account values" };
const ADD_ENTRY_DETAILS: DailyAction = { kind: "ADD_ENTRY_DETAILS", label: "Add entry details" };
const ADD_EXTERNAL_LOSS: DailyAction = { kind: "ADD_EXTERNAL_LOSS", label: "Add external loss" };
const REFRESH: DailyAction = { kind: "REFRESH", label: "Refresh" };

/** Headline priority among blocks: day-long limits outrank time windows. */
const HEADLINES: readonly [DailyReasonCode, string][] = [
  ["MAX_TRADES", "Daily trade limit reached"],
  ["DAILY_LOSS_LIMIT", "Daily loss limit reached"],
  ["DAILY_RISK_LIMIT", "Daily risk cap reached"],
  ["DEAD_POOL", "Trading blocked: Dead Pool until 18:00"],
  ["STALE_EQUITY", "Trading blocked: confirm today's balance"],
];

function partsUp(value: string, currency: string): string {
  return formatMoneyUp(value, currency);
}

/** `Sep 3`, with the year when it differs from `today`'s. */
function dayLabel(day: string, today: string): string {
  return formatDay(day, undefined, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

function staleStatus(usage: DailyUsage, day: string, session: Session): StaleDailyStatus {
  return {
    stale: true,
    allowed: false,
    headline: STALE_USAGE_HEADLINE,
    tone: "warning",
    reasons: [{
      code: "USAGE_OUT_OF_DATE", severity: "WARN", action: REFRESH,
      message: `Daily usage was computed for ${dayLabel(usage.day, day)}, not for today (${dayLabel(day, day)}). Refresh to see today's trades, risk and losses.`,
    }],
    day,
    session,
    usageDay: usage.day,
    stats: null,
  };
}

export function dailyStatusV2(context: DailyStatusContext, rawUsage: DailyUsage): DailyStatus {
  const usage = dailyUsageSchema.parse(rawUsage);
  const clock = strategyClock(toDate(context.now));
  if (usage.day !== clock.day) return staleStatus(usage, clock.day, clock.session);
  const { plan, currency } = context;
  const used = usage.plannedSlots + usage.unplannedTrades;
  const riskUsed = new exact(usage.plannedRisk).plus(usage.unplannedRisk);
  const lossAndOpen = new exact(usage.lossTotal).plus(usage.openExposure);
  const reasons: DailyReason[] = [];

  if (used >= plan.maxDailyTrades) {
    reasons.push({ code: "MAX_TRADES", severity: "BLOCK", message: `Daily trade limit reached: ${used} of ${plan.maxDailyTrades} trades already used today (${usage.plannedSlots} planned, ${usage.unplannedTrades} recorded live).` });
  }
  if (clock.session === "DEAD_POOL") reasons.push({ code: "DEAD_POOL", severity: "BLOCK", message: RISK_COPY.DEAD_POOL.sentence });
  if (context.observationDay !== clock.day) {
    const lastRecorded = context.observationDay ? ` (last recorded ${dayLabel(context.observationDay, clock.day)})` : "";
    reasons.push({ code: "STALE_EQUITY", severity: "BLOCK", message: `Confirm today's account balance before locking${lastRecorded}.`, action: CONFIRM_ACCOUNT_VALUES });
  }
  if (plan.dailyRiskCap !== null && riskUsed.gte(plan.dailyRiskCap)) {
    // "Reached" means used ≥ cap, so the shown amount is rounded down and still reads as reaching the cap.
    reasons.push({ code: "DAILY_RISK_LIMIT", severity: "BLOCK", message: `Daily risk cap reached: ${formatMoneyAgainst(riskUsed.toFixed(), plan.dailyRiskCap, currency, "min", true)} of ${formatMoneyExact(plan.dailyRiskCap, currency)} already reserved today.` });
  }
  if (plan.dailyLossCap !== null && lossAndOpen.gte(plan.dailyLossCap)) {
    // Rounding both parts up keeps their displayed sum at or above the displayed limit.
    reasons.push({ code: "DAILY_LOSS_LIMIT", severity: "BLOCK", message: `Daily loss limit reached: today's losses ${partsUp(usage.lossTotal, currency)} plus open risk ${partsUp(usage.openExposure, currency)} use your ${formatMoneyExact(plan.dailyLossCap, currency)} limit.` });
  }
  if (clock.session === "ASIA" || clock.session === "JUDAS") reasons.push({ code: "OUTSIDE_ACTIVE", severity: "WARN", message: RISK_COPY.OUTSIDE_ACTIVE.sentence });
  if (usage.riskUnknownTrades > 0) {
    reasons.push({ code: "UNPLANNED_RISK_UNKNOWN", severity: "WARN", message: unplannedRiskSentence(usage.riskUnknownTrades), action: ADD_ENTRY_DETAILS });
  }

  const blocks = reasons.filter(reason => reason.severity === "BLOCK");
  const warnings = reasons.filter(reason => reason.severity === "WARN");
  const headline = HEADLINES.find(([code]) => blocks.some(reason => reason.code === code))?.[1] ?? "You can trade";
  const riskLeft = plan.dailyRiskCap === null ? null : exact.max(0, new exact(plan.dailyRiskCap).minus(riskUsed));
  const confirmedToday = context.observationDay === clock.day;
  const external = new exact(usage.externalLoss);

  return {
    stale: false,
    allowed: blocks.length === 0,
    headline,
    tone: blocks.length ? "negative" : warnings.length ? "warning" : "positive",
    reasons: [...blocks, ...warnings],
    day: clock.day,
    session: clock.session,
    usageDay: usage.day,
    stats: {
      trades: {
        used, planned: usage.plannedSlots, unplanned: usage.unplannedTrades, max: plan.maxDailyTrades,
        left: Math.max(0, plan.maxDailyTrades - used), label: `${Math.max(0, plan.maxDailyTrades - used)} of ${plan.maxDailyTrades}`,
      },
      risk: {
        used: riskUsed.toFixed(), cap: plan.dailyRiskCap, left: riskLeft?.toFixed() ?? null,
        // Remaining risk rounds down so the card never promises more room than the engine allows.
        label: riskLeft === null ? "No daily cap" : `${formatMoneyExact(riskLeft.toDecimalPlaces(2, exact.ROUND_FLOOR).toFixed(), currency)} left`,
      },
      losses: {
        total: usage.lossTotal, realized: usage.realizedLoss, external: usage.externalLoss, openExposure: usage.openExposure, cap: plan.dailyLossCap,
        label: external.isZero()
          ? `Realized losses today ${formatMoney(usage.realizedLoss, currency)}`
          : `Realized losses today ${formatMoney(usage.realizedLoss, currency)} + ${formatMoney(usage.externalLoss, currency)} external`,
        action: ADD_EXTERNAL_LOSS,
      },
      accountValues: confirmedToday
        ? { confirmedToday, observationDay: context.observationDay, label: "Balance confirmed today" }
        : { confirmedToday, observationDay: context.observationDay, label: "Confirm today's balance", action: CONFIRM_ACCOUNT_VALUES },
    },
  };
}
