import { describe, expect, it } from "vitest";
import {
  addDays, compareInstants, daysInMonth, differsByMoreThan, displayDay, formatDateTime, formatDay, formatDuration, formatMonth, formatRelative,
  formatTime, instantComparer, instantMicros, isCalendarDay, isInstant, resolveTimeDisplay, STRATEGY_TIME, strategyDay, strategyDayLabel, strategyMonth,
  type TimeDisplay, toDate, weekdayIndex, zoneLabel,
} from "@/domain/time-display";

const UTC: TimeDisplay = { mode: "utc" };
const BERLIN: TimeDisplay = { mode: "local", zone: "Europe/Berlin" };
const TOKYO: TimeDisplay = { mode: "local", zone: "Asia/Tokyo" };

describe("microsecond-exact instants", () => {
  it("orders PostgreSQL microseconds across zone representations", () => {
    const later = "2026-09-01T11:00:00.000002+02:00";
    const earlier = "2026-09-01T09:00:00.000001Z";
    expect(compareInstants(later, earlier)).toBe(1);
    expect(compareInstants(earlier, later)).toBe(-1);
    expect(compareInstants("2026-09-01T09:00:00.000001Z", "2026-09-01T11:00:00.000001+02:00")).toBe(0);
    expect(instantMicros(later) - instantMicros(earlier)).toBe(1n);
  });

  it("sorts with a per-sort comparer exactly as compareInstants does, parsing each instant once, with the same errors", () => {
    // Exits spread over four years in mixed spellings, with ties across zone representations and microseconds.
    const instants = Array.from({ length: 2000 }, (_, index) => {
      const ms = Date.UTC(2022, 10, 1) + ((index * 7919) % 1500) * 86_400_000 + (index % 7) * 1000;
      const iso = new Date(ms).toISOString();
      if (index % 5 === 0) return iso.replace("Z", "000+00:00");
      if (index % 5 === 1) return `${iso.slice(0, 19)}.${String(index % 1_000_000).padStart(6, "0")}Z`;
      if (index % 5 === 2) return new Date(ms + 2 * 3_600_000).toISOString().replace("Z", "+02:00");
      return iso;
    });
    const rows = instants.map((at, index) => ({ at, id: String(index).padStart(5, "0") }));
    const compare = instantComparer();
    const fast = [...rows].sort((a, b) => compare(a.at, b.at) || (a.id < b.id ? -1 : 1));
    const exact = [...rows].sort((a, b) => compareInstants(a.at, b.at) || (a.id < b.id ? -1 : 1));
    expect(fast.map(row => row.id)).toEqual(exact.map(row => row.id));
    expect(compare("2026-09-01T09:00:00.000001Z", "2026-09-01T11:00:00.000001+02:00")).toBe(0);
    expect(compare(new Date("2026-09-01T11:00:00.001Z"), "2026-09-01T11:00:00.000999Z")).toBe(1);
    // An invalid instant fails as it does in compareInstants, and is never cached as valid.
    expect(() => compare("2026-02-30T00:00:00Z", "2026-09-01T11:00:00Z")).toThrow(RangeError);
    expect(() => compare("2026-02-30T00:00:00Z", "2026-09-01T11:00:00Z")).toThrow(RangeError);
  });

  it("accepts PostgreSQL text forms and Dates", () => {
    expect(instantMicros("2026-09-01 11:00:00+00")).toBe(instantMicros("2026-09-01T11:00:00Z"));
    expect(instantMicros("2026-09-01T11:00+0000")).toBe(instantMicros("2026-09-01T11:00:00.000000Z"));
    expect(instantMicros(new Date("2026-09-01T11:00:00.123Z"))).toBe(instantMicros("2026-09-01T11:00:00.123000Z"));
    expect(instantMicros("2026-09-01T11:00:00.1234567Z")).toBe(instantMicros("2026-09-01T11:00:00.123456Z"));
  });

  it.each(["2026-09-01T11:00:00", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-13-01T00:00:00Z", "yesterday", ""])("rejects %j", value => {
    expect(() => instantMicros(value)).toThrow(RangeError);
    expect(isInstant(value)).toBe(false);
  });

  it("detects more-than-five-minute gaps exactly", () => {
    expect(differsByMoreThan("2026-09-01T09:00:00Z", "2026-09-01T09:05:00Z", 5)).toBe(false);
    expect(differsByMoreThan("2026-09-01T09:00:00Z", "2026-09-01T09:05:00.000001Z", 5)).toBe(true);
    expect(differsByMoreThan("2026-09-01T09:05:00.000001Z", "2026-09-01T09:00:00Z", 5)).toBe(true);
  });

  it("truncates to milliseconds for Date display", () => {
    expect(toDate("2026-09-01T09:00:00.999999Z").toISOString()).toBe("2026-09-01T09:00:00.999Z");
  });

  it("validates calendar days", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2026-9-1")).toBe(false);
  });
});

describe("strategy clock is fixed UTC−5 (no DST)", () => {
  it("rolls the strategy day at 05:00 UTC to the microsecond", () => {
    expect(strategyDay("2026-09-05T04:59:59.999999Z")).toBe("2026-09-04");
    expect(strategyDay("2026-09-05T05:00:00Z")).toBe("2026-09-05");
    expect(strategyMonth("2026-10-01T04:59:59Z")).toBe("2026-09");
    expect(strategyMonth("2026-10-01T05:00:00Z")).toBe("2026-10");
  });

  it("formats strategy, UTC and local time from the same instant", () => {
    const instant = "2026-10-14T14:42:30Z";
    expect(formatTime(instant)).toBe("09:42");
    expect(formatTime(instant, STRATEGY_TIME)).toBe("09:42");
    expect(formatTime(instant, UTC)).toBe("14:42");
    expect(formatTime(instant, BERLIN)).toBe("16:42");
    expect(formatTime(instant, TOKYO)).toBe("23:42");
  });

  it("follows DST only in local mode", () => {
    expect(formatTime("2026-10-24T12:00:00Z", BERLIN)).toBe("14:00");
    expect(formatTime("2026-10-26T12:00:00Z", BERLIN)).toBe("13:00");
    expect(formatTime("2026-10-24T12:00:00Z")).toBe("07:00");
    expect(formatTime("2026-11-02T12:00:00Z")).toBe("07:00");
  });

  it("never rounds a minute up", () => {
    expect(formatTime("2026-10-14T14:59:59.999999Z", UTC)).toBe("14:59");
  });

  it("formats days and date-times", () => {
    expect(formatDay("2026-10-14")).toBe("Oct 14");
    expect(formatDay("2026-10-14", STRATEGY_TIME, { weekday: true, year: true })).toBe("Wed, Oct 14, 2026");
    expect(formatDay("2026-10-14T03:00:00Z")).toBe("Oct 13");
    expect(formatDay("2026-10-14T03:00:00Z", UTC)).toBe("Oct 14");
    expect(formatDay("2026-10-14T23:30:00Z", TOKYO, { weekday: true })).toBe("Thu, Oct 15");
    expect(displayDay("2026-10-14T23:30:00Z", TOKYO)).toBe("2026-10-15");
    expect(formatDateTime("2026-10-14T14:42:00Z")).toBe("Oct 14, 09:42");
    expect(formatDateTime("2026-10-14T14:42:00Z", UTC, { year: true })).toBe("Oct 14, 2026, 14:42");
    expect(formatMonth("2026-10")).toBe("October 2026");
    expect(() => formatMonth("2026-13")).toThrow();
  });

  it("labels the strategy day for headers", () => {
    expect(strategyDayLabel("2026-10-14T03:00:00Z")).toBe("Tue, Oct 13 (UTC−5)");
    expect(strategyDayLabel("2026-10-14")).toBe("Wed, Oct 14 (UTC−5)");
    expect(strategyDayLabel("2026-10-14", { year: true })).toBe("Wed, Oct 14, 2026 (UTC−5)");
  });

  it("labels zones", () => {
    expect(zoneLabel(STRATEGY_TIME)).toBe("UTC−5");
    expect(zoneLabel(UTC)).toBe("UTC");
    expect(zoneLabel(BERLIN)).toBe("Europe/Berlin");
    expect(zoneLabel(BERLIN, "2026-07-01T12:00:00Z")).toMatch(/GMT\+2|CEST/);
  });
});

describe("relative time uses an explicit server now", () => {
  const now = "2026-10-14T12:00:00Z";
  it.each([
    ["2026-10-14T11:59:30Z", "just now"],
    ["2026-10-14T11:55:00Z", "5 min ago"],
    ["2026-10-14T09:00:00Z", "3 h ago"],
    ["2026-10-13T11:00:00Z", "1 day ago"],
    ["2026-10-10T12:00:00Z", "4 days ago"],
    ["2026-10-14T12:10:00Z", "in 10 min"],
    ["2026-10-06T12:00:00Z", "Oct 6"],
  ])("%s → %s", (instant, expected) => expect(formatRelative(instant, now)).toBe(expected));

  it("formats durations", () => {
    expect(formatDuration("2026-10-14T09:00:00Z", "2026-10-14T09:45:59Z")).toBe("45m");
    expect(formatDuration("2026-10-14T09:00:00Z", "2026-10-14T11:15:00Z")).toBe("2h 15m");
    expect(formatDuration("2026-10-14T09:00:00Z", "2026-10-14T11:00:00Z")).toBe("2h");
    expect(formatDuration("2026-10-10T08:00:00Z", "2026-10-13T12:30:00Z")).toBe("3d 4h");
    expect(formatDuration("2026-10-14T09:00:00Z", "2026-10-14T09:00:30Z")).toBe("<1m");
    expect(formatDuration("2026-10-14T09:00:00Z", "2026-10-14T08:00:00Z")).toBe("<1m");
  });
});

describe("display preference parsing", () => {
  it("falls back to strategy time for anything invalid", () => {
    expect(resolveTimeDisplay(undefined)).toEqual(STRATEGY_TIME);
    expect(resolveTimeDisplay("bogus", "Europe/Berlin")).toEqual(STRATEGY_TIME);
    expect(resolveTimeDisplay("local", "Not/AZone")).toEqual(STRATEGY_TIME);
    expect(resolveTimeDisplay("local", null)).toEqual(STRATEGY_TIME);
    expect(resolveTimeDisplay("utc")).toEqual({ mode: "utc" });
    expect(resolveTimeDisplay("local", "Europe/Berlin")).toEqual(BERLIN);
  });

  it("refuses to format with an unknown zone", () => {
    expect(() => formatTime("2026-10-14T12:00:00Z", { mode: "local", zone: "Mars/Olympus" })).toThrow(RangeError);
  });
});

describe("calendar arithmetic", () => {
  it("adds days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("indexes weekdays from Monday", () => {
    expect(weekdayIndex("2026-09-07")).toBe(0);
    expect(weekdayIndex("2026-09-13")).toBe(6);
  });
  it("counts days in a month", () => {
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2026-10")).toBe(31);
  });
});
