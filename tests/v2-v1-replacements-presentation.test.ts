import Decimal from "decimal.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// V2 replacements of the V1 presentation tests tests/ui-review.test.ts, tests/ui-presentation.test.ts and
// tests/ux.test.ts (their subjects - session-ribbon, status-banner, numeric, edge-dashboard, journal page and
// src/domain/ux.ts - were V1-only and are deleted). Each block names the V1 intent it carries over; intents that existing
// V2 tests already assert are listed in docs/V2_TEST_REPLACEMENTS.md instead of being repeated here.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}), supabaseServer: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

import { signTone } from "@/components/edge/format";
import { SESSION_LABELS } from "@/components/shell/session-labels";
import { daySegments, ribbonModel } from "@/components/today/ribbon-model";
import { SessionRibbon } from "@/components/today/session-ribbon";
import { type DailyStatusContext, type DailyUsage, dailyStatusV2 } from "@/domain/daily-status";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { formatR } from "@/domain/format";
import { evaluateRisk } from "@/domain/risk";
import { type Session, strategyClock } from "@/domain/session";
import { formatDateTime, zoneLabel } from "@/domain/time-display";
import { applyLedgerFilters, type LedgerSelect, parseTradeFilters, searchSymbol } from "@/lib/trades-data";

const MINUTE = 60_000;
const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** 00:00 UTC−5 of a strategy day (05:00 UTC: the strategy clock never observes daylight saving). */
const dayStart = (day: string) => Date.parse(`${day}T05:00:00.000Z`);

// ---------------------------------------------------------------------------------------------------------------------
// V1 SessionRibbon, nextTransition and sessionSegments (ui-review.test.ts, ui-presentation.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe("session ribbon never contradicts the strategy clock", () => {
  // US and EU daylight-saving changes, a year end and a leap day: the fixed UTC−5 clock must not move on any of them.
  const DAYS = ["2026-03-08", "2026-03-29", "2026-09-07", "2026-10-25", "2026-11-01", "2026-12-31", "2028-02-29"];

  it.each(DAYS)("tiles %s from 00:00 to 24:00 exactly once, each segment agreeing with the clock at both ends", day => {
    const segments = daySegments(day);
    expect(segments.map(segment => segment.session)).toEqual(["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL", "ASIA"]);
    expect(segments[0].from).toBe(0);
    expect(segments.at(-1)?.to).toBe(1440);
    for (let index = 1; index < segments.length; index++) expect(segments[index].from).toBe(segments[index - 1].to);
    expect(segments.reduce((total, segment) => total + (segment.to - segment.from), 0)).toBe(1440);
    for (const segment of segments) {
      expect(segment.label).toBe(SESSION_LABELS[segment.session]);
      for (const minute of [segment.from, segment.to - 1]) expect(strategyClock(new Date(dayStart(day) + minute * MINUTE)).session).toBe(segment.session);
    }
  });

  it("announces, for every minute of a day, the first session change and never the session already running", () => {
    for (let minute = 0; minute < 1440; minute++) {
      const now = dayStart("2026-09-07") + minute * MINUTE;
      const current = strategyClock(new Date(now));
      const { next, session, segments } = ribbonModel(now);
      expect(session).toBe(current.session);
      expect(next.session).not.toBe(current.session);
      const boundary = Date.parse(next.at);
      expect(strategyClock(new Date(boundary)).session).toBe(next.session);
      expect(strategyClock(new Date(boundary - 1)).session).toBe(current.session);
      expect(next.nextDay).toBe(strategyClock(new Date(boundary)).day !== current.day);
      expect(segments.filter(segment => segment.current)).toHaveLength(1);
      expect(segments.find(segment => segment.current)?.session).toBe(current.session);
    }
  });

  it.each([
    ["00:30", "Judas", "01:00", false],
    ["01:30", "Kill zone", "02:00", false],
    ["06:00", "Dead Pool", "12:00", false],
    ["13:00", "Asia", "18:00", false],
    ["18:00", "Judas", "01:00", true],
    ["23:59", "Judas", "01:00", true],
  ] as const)("at %s UTC−5 the next session is %s at %s (next day: %s)", (time, label, at, nextDay) => {
    const [hours, minutes] = time.split(":").map(Number);
    const model = ribbonModel(dayStart("2026-09-07") + (hours * 60 + minutes) * MINUTE);
    expect(model.next).toMatchObject({ label, time: at, nextDay });
  });

  it.each(["2026-12-31T23:59:59.999-05:00", "2026-03-08T00:30:24-05:00", "2026-11-01T23:30:45-05:00"])(
    "renders the next session, its time and 'tomorrow' only when it falls on the next strategy day, at %s",
    instant => {
      const nowIso = new Date(instant).toISOString();
      const model = ribbonModel(Date.parse(nowIso));
      const html = renderToStaticMarkup(createElement(SessionRibbon, { nowIso }));
      const text = visibleText(html);
      expect(text).toContain(`Next: ${model.next.label} at ${model.next.time}${model.next.nextDay ? " tomorrow" : ""}`);
      expect(text).toContain(`${model.time} UTC−5 ${model.sessionLabel}`);
      // The screen-reader summary names every segment of the day with its exact boundaries.
      for (const segment of model.segments) expect(text).toContain(`${segment.label} ${segment.fromLabel}–${segment.toLabel}`);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// V1 dailyStatus / StatusBanner / statusTier (ux.test.ts, ui-presentation.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe("the daily trading status interprets the engine's limits and never replaces them", () => {
  const DAY = "2026-09-07";
  const usage = (changes: Partial<DailyUsage> = {}, day = DAY) => usageFixture({ day, ...changes });
  const context = (changes: Omit<Partial<DailyStatusContext>, "plan"> & { plan?: Partial<DailyStatusContext["plan"]> } = {}): DailyStatusContext => ({
    now: "2026-09-07T14:00:00Z", observationDay: DAY, currency: "USD", ...changes, plan: { maxDailyTrades: 2, dailyRiskCap: null, dailyLossCap: null, ...changes.plan },
  });
  const lockable = { ...previewProposal, narrative: "Replacement of the V1 permission-tier test.", contractConfirmed: true, news: "CLEAR" as const };
  const engine = (ctx: DailyStatusContext, daily: DailyUsage) => evaluateRisk(lockable, {
    ...previewContext, now: String(ctx.now), observationDay: ctx.observationDay ?? "2000-01-01", usage: daily,
    plan: { ...previewContext.plan, maxDailyTrades: ctx.plan.maxDailyTrades, dailyRiskCap: ctx.plan.dailyRiskCap, dailyLossCap: ctx.plan.dailyLossCap },
  });
  const current = (ctx: DailyStatusContext, daily: DailyUsage) => {
    const status = dailyStatusV2(ctx, daily);
    if (status.stale) throw new Error("Expected usage of the current strategy day.");
    return status;
  };

  it("flags yesterday's account values exactly at the strategy midnight, and the engine agrees", () => {
    // 23:59:59.999999 UTC−5 (Asia, so only the outside-kill-zone warning) and 00:00 UTC−5 of the next strategy day.
    const before = current(context({ now: "2026-09-08T04:59:59.999999Z" }), usage());
    expect(before.allowed).toBe(true);
    expect(before.reasons.filter(reason => reason.severity === "BLOCK")).toEqual([]);
    const after = context({ now: "2026-09-08T05:00:00Z" });
    const status = current(after, usage({}, "2026-09-08"));
    expect(status.allowed).toBe(false);
    expect(status.reasons.filter(reason => reason.severity === "BLOCK")).toEqual([
      expect.objectContaining({ code: "STALE_EQUITY", action: { kind: "CONFIRM_ACCOUNT_VALUES", label: "Confirm account values" } }),
    ]);
    expect(engine(after, usage({}, "2026-09-08")).status).toBe("TRADE_BLOCKED");
  });

  it("needs no reported loss for a configured daily loss limit: with no losses today the day is clear", () => {
    const capped = context({ plan: { dailyLossCap: "100", dailyRiskCap: "100" } });
    expect(current(capped, usage())).toMatchObject({ allowed: true, reasons: [] });
    expect(engine(capped, usage()).status).toBe("RISK_APPROVED");
  });

  it("never shows a negative number of trades left, even past the limit", () => {
    const over = current(context(), usage({ plannedSlots: 5 }));
    expect(over.allowed).toBe(false);
    expect(over.stats.trades).toMatchObject({ used: 5, left: 0, label: "0 of 2" });
  });

  it("keeps an approved plan's own check separate: a clear day is not an approval of any plan", () => {
    expect(current(context(), usage())).toMatchObject({ allowed: true, headline: "You can trade", reasons: [] });
    const blockedPlan = evaluateRisk({ ...lockable, riskPercent: "5" }, { ...previewContext, now: "2026-09-07T14:00:00Z", observationDay: DAY, usage: usage() });
    expect(blockedPlan.status).toBe("TRADE_BLOCKED");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// V1 formatR + rTone (ui-review.test.ts, ui-presentation.test.ts, ux.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe("R values keep their exact sign in text and tone", () => {
  it.each([
    ["0.00001", "+0.00001R", "pos"],
    ["-0.00001", "-0.00001R", "neg"],
    ["-0", "0.00R", "zero"],
    ["0", "0.00R", "zero"],
    ["2.71", "+2.71R", "pos"],
    ["-1", "-1.00R", "neg"],
    ["999999999999.123456", "+999999999999.12R", "pos"],
  ] as const)("%s reads %s with the %s tone, the same from text and from a Decimal", (value, text, tone) => {
    expect(formatR(value)).toBe(text);
    expect(formatR(new Decimal(value))).toBe(text);
    expect(signTone(value)).toBe(tone);
    // The tone never contradicts the printed sign.
    expect(text.startsWith("+") ? "pos" : text.startsWith("-") ? "neg" : "zero").toBe(tone);
  });

  it("shows an unknown R as a dash with no tone", () => {
    expect(formatR(null)).toBe("—");
    expect(signTone(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// V1 utcTime (ux.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe("times with an explicit offset convert to the chosen display", () => {
  it("labels UTC and converts a UTC−5 instant", () => {
    const UTC = { mode: "utc" } as const;
    expect(formatDateTime("2026-09-07T10:30:00-05:00", UTC, { year: true })).toBe("Sep 7, 2026, 15:30");
    expect(formatDateTime("2026-09-07T10:30:00-05:00")).toBe("Sep 7, 10:30");
    expect(zoneLabel(UTC)).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// V1 journalFilters / journalQuery (ux.test.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe("Journal URL filters", () => {
  it("names unsupported values and impossible dates, ignores them, and keeps the valid ones", () => {
    const { filters, invalid } = parseTradeFilters({ state: "deleted", result: "profit", from: "2026-02-30", to: "2026-09-08", q: "  EURUSD  ", model: "ote" });
    expect(invalid.sort()).toEqual(["from", "result", "state"]);
    expect(filters).toEqual({ to: "2026-09-08", q: "EURUSD", model: "OTE" });
  });

  /** A query builder that records every filter call (PostgREST's builder is chainable). */
  function recorder() {
    const calls: [string, unknown[]][] = [];
    const query: LedgerSelect = new Proxy({} as LedgerSelect, {
      get: (_target, method) => (...args: unknown[]) => {
        calls.push([String(method), args]);
        return query;
      },
    });
    return { calls, query };
  }

  it("strips PostgREST filter syntax from a search, so it can only ever match an instrument", () => {
    expect(searchSymbol("EURUSD),id.eq.*")).toBe("EURUSDID.EQ.");
    expect(searchSymbol("a,b(c)d*e\"f'g")).toBe("ABCDEFG");
    const q = "EURUSD),id.eq.*,user_id.neq.x";
    const { calls, query } = recorder();
    applyLedgerFilters(query, { mode: "all" }, { q }, null);
    const or = calls.filter(([method]) => method === "or");
    expect(or).toHaveLength(1);
    const condition = String(or[0][1][0]);
    // One condition only: no comma, parenthesis, quote or wildcard from the search reaches the filter.
    expect(condition).toBe(`symbol.ilike.*${searchSymbol(q)}*`);
    expect(searchSymbol(q)).toMatch(/^[A-Z0-9._/-]{1,20}$/);
    expect(condition.split(",")).toHaveLength(1);
  });

  it("matches nothing for a search without an instrument part or a matching record, instead of everything", () => {
    const { calls, query } = recorder();
    applyLedgerFilters(query, { mode: "all" }, { q: "%%%" }, []);
    // Trades in Deleted trades (0020) are left out of every ledger read first.
    expect(calls).toEqual([["is", ["trashed_at", null]], ["in", ["id", []]]]);
  });
});

/** Sessions the V1 ribbon listed, in clock order: a compile-time check that the V2 type still has exactly these. */
const SESSIONS: readonly Session[] = ["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL"];
describe("session wording", () => {
  it("names every session in trader words, never as its enum", () => {
    expect(SESSIONS.map(session => SESSION_LABELS[session])).toEqual(["Asia", "Judas", "Kill zone", "Dead Pool"]);
  });
});
