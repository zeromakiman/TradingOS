import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  type CurrentDailyStatus, type DailyStatus, type DailyStatusContext, type DailyUsage, dailyStatusV2, dailyUsageSchema, STALE_USAGE_HEADLINE,
} from "@/domain/daily-status";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { evaluateRisk, type RiskContext } from "@/domain/risk";
import { strategyDay } from "@/domain/time-display";

const DAY = "2026-09-04";
const KILL_ZONE = "2026-09-04T14:00:00Z";
const validProposal = { ...previewProposal, narrative: "Invariant check.", contractConfirmed: true, news: "CLEAR" as const };

/** A consistent usage object for `DAY`; trades without a risk basis default to full overlap of the two counters. */
function usage(changes: Partial<DailyUsage> = {}): DailyUsage {
  const base = {
    day: DAY, plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0,
    realizedLoss: "0", externalLoss: "0", legacyReportedLoss: null as string | null, openExposure: "0", openRiskUnknown: 0,
    ...changes,
  };
  const lossTotal = Decimal.max(base.legacyReportedLoss ?? 0, new Decimal(base.realizedLoss).plus(base.externalLoss)).toFixed();
  return {
    ...base,
    riskUnknownTrades: changes.riskUnknownTrades ?? Math.max(base.unplannedRiskUnknown, base.openRiskUnknown),
    lossTotal: changes.lossTotal ?? lossTotal,
  };
}

function context(changes: Omit<Partial<DailyStatusContext>, "plan"> & { plan?: Partial<DailyStatusContext["plan"]> } = {}): DailyStatusContext {
  return {
    now: changes.now ?? KILL_ZONE,
    observationDay: changes.observationDay === undefined ? DAY : changes.observationDay,
    currency: "USD",
    plan: { maxDailyTrades: 2, dailyRiskCap: null, dailyLossCap: null, ...changes.plan },
  };
}

function current(status: DailyStatus): CurrentDailyStatus {
  if (status.stale) throw new Error("Expected usage of the current strategy day.");
  return status;
}

/** Status of usage computed for the strategy day of `now`. */
function status(ctx: DailyStatusContext = context(), daily: DailyUsage = usage()): CurrentDailyStatus {
  return current(dailyStatusV2(ctx, daily));
}

/**
 * The same account state as an engine context (RiskContext v2, spec §6.7). The usage must belong to the
 * strategy day of `now`, as the server computes it; the engine 1.2 reads slots, reserved risk, losses and
 * open risk from it directly.
 */
function engineContext(ctx: DailyStatusContext, daily: DailyUsage): RiskContext {
  expect(daily.day).toBe(strategyDay(ctx.now));
  return {
    ...previewContext,
    now: String(ctx.now),
    observationDay: ctx.observationDay ?? "2000-01-01",
    plan: { ...previewContext.plan, maxDailyTrades: ctx.plan.maxDailyTrades, dailyRiskCap: ctx.plan.dailyRiskCap, dailyLossCap: ctx.plan.dailyLossCap },
    usage: daily,
  };
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function assertEngineAgrees(ctx: DailyStatusContext, daily: DailyUsage) {
  const result = evaluateRisk(validProposal, engineContext(ctx, daily));
  const judged = status(ctx, daily);
  const engineBlocks = new Set(result.issues.filter(i => i.severity === "BLOCK").map(i => i.code));
  for (const reason of judged.reasons.filter(r => r.severity === "BLOCK")) {
    expect(result.status).toBe("TRADE_BLOCKED");
    expect(engineBlocks.has(reason.code)).toBe(true);
  }
  return { status: judged, result };
}

describe("dailyStatusV2 (spec §14.1)", () => {
  it("reports a clear day", () => {
    expect(status()).toMatchObject({ stale: false, allowed: true, headline: "You can trade", tone: "positive", reasons: [], day: DAY, usageDay: DAY, session: "ACTIVE_KILL_ZONE" });
    expect(evaluateRisk(validProposal, engineContext(context(), usage())).status).toBe("RISK_APPROVED");
  });

  it("counts planned and live-first trades toward the daily limit", () => {
    const limited = status(context(), usage({ plannedSlots: 1, unplannedTrades: 1 }));
    expect(limited.allowed).toBe(false);
    expect(limited.headline).toBe("Daily trade limit reached");
    expect(limited.tone).toBe("negative");
    expect(limited.reasons).toEqual([{ code: "MAX_TRADES", severity: "BLOCK", message: "Daily trade limit reached: 2 of 2 trades already used today (1 planned, 1 recorded live)." }]);
    expect(limited.stats.trades).toMatchObject({ used: 2, left: 0, label: "0 of 2" });
    expect(status(context(), usage({ plannedSlots: 1 })).stats.trades.label).toBe("1 of 2");
  });

  it("blocks Dead Pool from 12:00 UTC−5 to the microsecond", () => {
    expect(status(context({ now: "2026-09-04T16:59:59.999999Z" })).allowed).toBe(true);
    const deadPool = status(context({ now: "2026-09-04T17:00:00Z" }));
    expect(deadPool.headline).toBe("Trading blocked: Dead Pool until 18:00");
    expect(deadPool.reasons[0]).toEqual({ code: "DEAD_POOL", severity: "BLOCK", message: "Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00." });
  });

  it("asks to confirm stale or missing account values, with an action", () => {
    const stale = status(context({ observationDay: "2026-09-03" }));
    expect(stale.headline).toBe("Trading blocked: confirm today's balance");
    expect(stale.reasons).toEqual([{
      code: "STALE_EQUITY", severity: "BLOCK", message: "Confirm today's account balance before locking (last recorded Sep 3).",
      action: { kind: "CONFIRM_ACCOUNT_VALUES", label: "Confirm account values" },
    }]);
    expect(stale.stats.accountValues).toMatchObject({ confirmedToday: false, label: "Confirm today's balance", action: { kind: "CONFIRM_ACCOUNT_VALUES" } });
    expect(status(context({ observationDay: null })).reasons[0].message).toBe("Confirm today's account balance before locking.");
    const newYear = status(context({ now: "2026-01-02T14:00:00Z", observationDay: "2025-12-31" }), usage({ day: "2026-01-02" }));
    expect(newYear.reasons[0].message).toBe("Confirm today's account balance before locking (last recorded Dec 31, 2025).");
    expect(status().stats.accountValues).toEqual({ confirmedToday: true, observationDay: DAY, label: "Balance confirmed today" });
  });

  it("blocks when the daily risk cap is reached, not before", () => {
    const capped = context({ plan: { dailyRiskCap: "100" } });
    expect(status(capped, usage({ plannedRisk: "60", unplannedRisk: "39.99" })).allowed).toBe(true);
    const reached = status(capped, usage({ plannedRisk: "60", unplannedRisk: "40" }));
    expect(reached.headline).toBe("Daily risk cap reached");
    expect(reached.reasons[0].message).toBe("Daily risk cap reached: $100.00 of $100.00 already reserved today.");
    expect(reached.stats.risk).toMatchObject({ used: "100", cap: "100", left: "0", label: "$0.00 left" });
  });

  it("never promises more remaining risk than the engine allows", () => {
    const capped = status(context({ plan: { dailyRiskCap: "100" } }), usage({ plannedRisk: "50.005" }));
    expect(capped.stats.risk.left).toBe("49.995");
    expect(capped.stats.risk.label).toBe("$49.99 left");
    expect(status().stats.risk.label).toBe("No daily cap");
  });

  it("blocks when realized/external losses plus open risk reach the loss limit", () => {
    const capped = context({ plan: { dailyLossCap: "100" } });
    expect(status(capped, usage({ realizedLoss: "30", externalLoss: "20", openExposure: "49.99" })).allowed).toBe(true);
    const reached = status(capped, usage({ realizedLoss: "30", externalLoss: "20", openExposure: "50" }));
    expect(reached.headline).toBe("Daily loss limit reached");
    expect(reached.reasons[0].message).toBe("Daily loss limit reached: today's losses $50.00 plus open risk $50.00 use your $100.00 limit.");
    const precise = status(capped, usage({ realizedLoss: "50.004", openExposure: "49.996" }));
    expect(precise.reasons[0].message).toBe("Daily loss limit reached: today's losses $50.01 plus open risk $50.00 use your $100.00 limit.");
  });

  it("uses greatest(legacy reported loss, realized + external) and labels external losses", () => {
    expect(status(context({ plan: { dailyLossCap: "100" } }), usage({ realizedLoss: "20", legacyReportedLoss: "100" })).reasons.map(r => r.code)).toEqual(["DAILY_LOSS_LIMIT"]);
    expect(status(context(), usage({ realizedLoss: "50" })).stats.losses.label).toBe("Realized losses today $50.00");
    const external = status(context(), usage({ realizedLoss: "50", externalLoss: "20" }));
    expect(external.stats.losses).toMatchObject({ total: "70", label: "Realized losses today $50.00 + $20.00 external", action: { kind: "ADD_EXTERNAL_LOSS", label: "Add external loss" } });
  });

  it("warns outside the kill zone and about live-first trades without risk, without blocking", () => {
    // One trade entered today and still open is in both counters: it is one trade.
    const asia = status(context({ now: "2026-09-04T23:30:00Z" }), usage({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 1 }));
    expect(asia).toMatchObject({ allowed: true, headline: "You can trade", tone: "warning" });
    expect(asia.reasons).toEqual([
      { code: "OUTSIDE_ACTIVE", severity: "WARN", message: "Outside the active kill zone (02:00–12:00 UTC−5)." },
      { code: "UNPLANNED_RISK_UNKNOWN", severity: "WARN", message: "1 live-first trade without recorded risk is not included in the daily risk totals.", action: { kind: "ADD_ENTRY_DETAILS", label: "Add entry details" } },
    ]);
    expect(status(context({ now: "2026-09-05T06:30:00Z", observationDay: "2026-09-05" }), usage({ day: "2026-09-05" })).reasons.map(r => r.code)).toEqual(["OUTSIDE_ACTIVE"]);
  });

  it("counts distinct trades without recorded risk, never the sum of the overlapping counters", () => {
    // Closed today without a basis (entered today, not open) + open since yesterday without a basis: two trades.
    const two = status(context(), usage({ unplannedTrades: 1, unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 2 }));
    expect(two.reasons.map(r => r.message)).toEqual(["2 live-first trades without recorded risk are not included in the daily risk totals."]);
    const openOnly = status(context(), usage({ openRiskUnknown: 1 }));
    expect(openOnly.reasons.map(r => r.message)).toEqual(["1 live-first trade without recorded risk is not included in the daily risk totals."]);
    expect(status(context(), usage({ unplannedTrades: 1, unplannedRisk: "40" })).reasons).toEqual([]);
  });

  it("orders BLOCK before WARN and picks the most lasting headline", () => {
    const blocked = status(context({ now: "2026-09-04T17:30:00Z", observationDay: "2026-09-03" }), usage({ plannedSlots: 2, openRiskUnknown: 1 }));
    expect(blocked.reasons.map(r => r.code)).toEqual(["MAX_TRADES", "DEAD_POOL", "STALE_EQUITY", "UNPLANNED_RISK_UNKNOWN"]);
    expect(blocked.headline).toBe("Daily trade limit reached");
    expect(status(context({ now: "2026-09-04T17:30:00Z", observationDay: "2026-09-03" })).headline).toBe("Trading blocked: Dead Pool until 18:00");
  });
});

describe("usage of another strategy day (stale)", () => {
  const refresh = { kind: "REFRESH", label: "Refresh" };

  it("never judges yesterday's usage: no blocks, no stats, a refresh prompt", () => {
    const stale = dailyStatusV2(context(), usage({ day: "2026-09-03", plannedSlots: 2 }));
    expect(stale).toEqual({
      stale: true, allowed: false, headline: STALE_USAGE_HEADLINE, tone: "warning", day: DAY, usageDay: "2026-09-03", session: "ACTIVE_KILL_ZONE", stats: null,
      reasons: [{
        code: "USAGE_OUT_OF_DATE", severity: "WARN", action: refresh,
        message: "Daily usage was computed for Sep 3, not for today (Sep 4). Refresh to see today's trades, risk and losses.",
      }],
    });
    expect(STALE_USAGE_HEADLINE).toBe("Today's usage is out of date — refresh");
  });

  it("switches exactly at midnight UTC−5, in both directions", () => {
    expect(dailyStatusV2(context({ now: "2026-09-05T04:59:59.999999Z" }), usage()).stale).toBe(false);
    const afterMidnight = dailyStatusV2(context({ now: "2026-09-05T05:00:00Z" }), usage({ plannedSlots: 2, realizedLoss: "500" }));
    expect(afterMidnight).toMatchObject({ stale: true, allowed: false, tone: "warning", headline: STALE_USAGE_HEADLINE, day: "2026-09-05" });
    expect(afterMidnight.reasons.some(r => r.severity === "BLOCK")).toBe(false);
    // A page clock taken before usage of the next day was computed is just as out of date.
    expect(dailyStatusV2(context({ now: "2026-09-04T04:59:59Z" }), usage()).stale).toBe(true);
  });

  it("names the year when the usage is from another year", () => {
    const stale = dailyStatusV2(context({ now: "2026-01-01T14:00:00Z" }), usage({ day: "2025-12-31" }));
    expect(stale.reasons[0].message).toBe("Daily usage was computed for Dec 31, 2025, not for today (Jan 1). Refresh to see today's trades, risk and losses.");
    expect(stale.headline).not.toBe("You can trade");
  });
});

describe("daily usage contract (spec §6.2, §6.7)", () => {
  it("accepts exactly the RPC keys", () => {
    expect(dailyUsageSchema.safeParse(usage({ realizedLoss: "12.5" })).success).toBe(true);
    expect(Object.keys(dailyUsageSchema.parse(usage())).sort()).toEqual([
      "day", "externalLoss", "legacyReportedLoss", "lossTotal", "openExposure", "openRiskUnknown", "plannedRisk", "plannedSlots",
      "realizedLoss", "riskUnknownTrades", "unplannedRisk", "unplannedRiskUnknown", "unplannedTrades",
    ]);
  });

  it.each([
    ["an unknown key", { ...usage(), executedTrades: 0 }],
    ["a missing day", (({ day: _day, ...rest }) => rest)(usage())],
    ["an impossible day", { ...usage(), day: "2026-02-30" }],
    ["an instant instead of a day", { ...usage(), day: "2026-09-04T00:00:00Z" }],
    ["a missing distinct count", (({ riskUnknownTrades: _count, ...rest }) => rest)(usage())],
    ["a distinct count below an overlapping counter", usage({ unplannedRiskUnknown: 1, openRiskUnknown: 2, riskUnknownTrades: 1 })],
    ["a distinct count above both counters together", usage({ unplannedRiskUnknown: 1, openRiskUnknown: 1, riskUnknownTrades: 3 })],
    ["an inconsistent loss total", { ...usage({ realizedLoss: "10" }), lossTotal: "9" }],
    ["a number for money", { ...usage(), plannedRisk: 50 }],
    ["a negative count", { ...usage(), plannedSlots: -1 }],
  ])("rejects %s", (_name, value) => {
    expect(dailyUsageSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the overlap bounds of the distinct count", () => {
    expect(dailyUsageSchema.safeParse(usage({ unplannedRiskUnknown: 2, openRiskUnknown: 1, riskUnknownTrades: 2 })).success).toBe(true);
    expect(dailyUsageSchema.safeParse(usage({ unplannedRiskUnknown: 2, openRiskUnknown: 1, riskUnknownTrades: 3 })).success).toBe(true);
  });

  it("refuses to judge an invalid usage object", () => {
    expect(() => dailyStatusV2(context(), { ...usage(), lossTotal: "1" })).toThrow();
    expect(() => dailyStatusV2(context(), { ...usage(), extra: true } as DailyUsage)).toThrow();
  });
});

describe("invariant: every BLOCK reason also blocks an otherwise valid proposal in the engine", () => {
  it.each([
    ["trade limit", context(), usage({ plannedSlots: 1, unplannedTrades: 1 })],
    ["trade limit by live-first trades only", context(), usage({ unplannedTrades: 2 })],
    ["Dead Pool", context({ now: "2026-09-04T17:00:00Z" }), usage()],
    ["stale account values", context({ observationDay: "2026-09-03" }), usage()],
    ["no account values", context({ observationDay: null }), usage()],
    ["risk cap reached exactly", context({ plan: { dailyRiskCap: "100" } }), usage({ plannedRisk: "60", unplannedRisk: "40" })],
    ["risk cap exceeded", context({ plan: { dailyRiskCap: "100" } }), usage({ plannedRisk: "150" })],
    ["loss limit reached exactly", context({ plan: { dailyLossCap: "100" } }), usage({ realizedLoss: "30", externalLoss: "20", openExposure: "50" })],
    ["loss limit with planned reservations", context({ plan: { dailyLossCap: "100" } }), usage({ plannedSlots: 1, plannedRisk: "50", realizedLoss: "60", openExposure: "40" })],
    ["legacy reported loss", context({ plan: { dailyLossCap: "100" } }), usage({ legacyReportedLoss: "100" })],
  ])("%s", (_name, ctx, daily) => {
    const { status: judged } = assertEngineAgrees(ctx, daily);
    expect(judged.allowed).toBe(false);
  });

  it("holds over seeded random account states", () => {
    const random = seeded(20260904);
    const cents = (max: number) => new Decimal(Math.floor(random() * max * 100)).div(100).toFixed();
    // Caps are positive in the database (check > 0).
    const cap = () => (random() < 0.5 ? null : new Decimal(cents(200)).plus("0.01").toFixed());
    let blocked = 0;
    for (let i = 0; i < 400; i++) {
      const minutes = Math.floor(random() * 1440);
      const now = new Date(Date.parse(`${DAY}T05:00:00Z`) + minutes * 60_000).toISOString();
      const ctx = context({
        now,
        observationDay: random() < 0.15 ? "2026-09-03" : DAY,
        plan: { maxDailyTrades: 1 + Math.floor(random() * 3), dailyRiskCap: cap(), dailyLossCap: cap() },
      });
      const daily = usage({
        plannedSlots: Math.floor(random() * 3), unplannedTrades: Math.floor(random() * 2), plannedRisk: cents(120), unplannedRisk: cents(60),
        realizedLoss: cents(80), externalLoss: random() < 0.3 ? cents(40) : "0", openExposure: cents(80), legacyReportedLoss: random() < 0.2 ? cents(150) : null,
        unplannedRiskUnknown: Math.floor(random() * 2), openRiskUnknown: Math.floor(random() * 2),
      });
      const { status: judged } = assertEngineAgrees(ctx, daily);
      if (!judged.allowed) blocked++;
    }
    expect(blocked).toBeGreaterThan(50);
  });
});
