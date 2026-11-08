import { describe, expect, it } from "vitest";
import { nextBoundary, type Session, type SessionBoundary, strategyClock } from "@/domain/session";

// nextBoundary (spec §14.1, Today session ribbon) is a pure addition to src/domain/session.ts. It must agree with
// strategyClock exactly: the boundary is the first instant at which strategyClock reports another session, and the
// session it reports there. The strategy clock is fixed UTC−5, so no daylight-saving change anywhere moves it.

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

/** strategyClock's view of a boundary instant, in the SessionBoundary shape. */
function expected(atMs: number): SessionBoundary {
  const at = new Date(atMs).toISOString();
  const clock = strategyClock(at);
  return { at, session: clock.session, time: clock.time, day: clock.day };
}

/**
 * Sessions of every minute of a window as strategyClock reports them, and for each minute the index of the next
 * minute with another session (-1 when the change lies beyond the window).
 */
function minuteScan(startIso: string, days: number) {
  const start = Date.parse(startIso);
  const minutes = days * 1440;
  const sessions: Session[] = [];
  for (let i = 0; i < minutes; i++) sessions.push(strategyClock(new Date(start + i * MINUTE)).session);
  const next = new Array<number>(minutes).fill(-1);
  for (let i = minutes - 2; i >= 0; i--) next[i] = sessions[i + 1] !== sessions[i] ? i + 1 : next[i + 1];
  return { start, sessions, next };
}

describe("nextBoundary agrees with a minute scan of strategyClock", () => {
  // Windows around the US and EU daylight-saving changes of 2026, a leap day and a year end: the UTC−5 strategy
  // clock never moves, so every day has the same four boundaries at 06:00, 07:00, 17:00 and 23:00 UTC.
  it.each([
    ["US daylight saving starts (2026-03-08)", "2026-03-07T00:00:00Z"],
    ["EU summer time starts (2026-03-29)", "2026-03-28T00:00:00Z"],
    ["EU summer time ends (2026-10-25)", "2026-10-24T00:00:00Z"],
    ["US daylight saving ends (2026-11-01)", "2026-10-31T00:00:00Z"],
    ["a leap day (2028-02-29)", "2028-02-28T00:00:00Z"],
    ["a year end (2026-12-31)", "2026-12-30T00:00:00Z"],
  ])("around %s", (_name, startIso) => {
    const { start, sessions, next } = minuteScan(startIso, 3);
    let checked = 0;
    for (let i = 0; i < sessions.length; i++) {
      if (next[i] < 0) continue;
      const boundary = expected(start + next[i] * MINUTE);
      // Sessions only change on whole minutes: every instant of the minute has the same next boundary.
      for (const offset of [0, 1, 30_000, 59_999]) {
        const instant = start + i * MINUTE + offset;
        const input = offset % 2 === 0 ? new Date(instant).toISOString() : new Date(instant);
        const result = nextBoundary(input);
        if (result.at !== boundary.at || result.session !== boundary.session || result.time !== boundary.time || result.day !== boundary.day) {
          expect(result, new Date(instant).toISOString()).toEqual(boundary);
        }
        checked++;
      }
      expect(boundary.session).not.toBe(sessions[i]);
      expect(strategyClock(new Date(Date.parse(boundary.at) - 1)).session).toBe(sessions[i]);
    }
    // Every minute but the last hour of the window (after its final boundary, 23:00 UTC) was checked at 4 offsets.
    expect(checked).toBe((sessions.length - 60) * 4);
  });
});

describe("nextBoundary on a trading day (fixed UTC−5)", () => {
  it.each([
    ["2026-09-04T14:00:00Z", "2026-09-04T17:00:00.000Z", "DEAD_POOL", "12:00", "2026-09-04"],
    ["2026-09-04T16:59:59.999Z", "2026-09-04T17:00:00.000Z", "DEAD_POOL", "12:00", "2026-09-04"],
    // An instant exactly on a boundary already belongs to the new session: the following boundary is next.
    ["2026-09-04T17:00:00Z", "2026-09-04T23:00:00.000Z", "ASIA", "18:00", "2026-09-04"],
    ["2026-09-04T22:59:59.999Z", "2026-09-04T23:00:00.000Z", "ASIA", "18:00", "2026-09-04"],
    // Asia runs across the UTC−5 midnight (05:00 UTC), which is not a boundary.
    ["2026-09-04T23:00:00Z", "2026-09-05T06:00:00.000Z", "JUDAS", "01:00", "2026-09-05"],
    ["2026-09-05T04:59:59.999Z", "2026-09-05T06:00:00.000Z", "JUDAS", "01:00", "2026-09-05"],
    ["2026-09-05T05:00:00Z", "2026-09-05T06:00:00.000Z", "JUDAS", "01:00", "2026-09-05"],
    ["2026-09-05T06:00:00Z", "2026-09-05T07:00:00.000Z", "ACTIVE_KILL_ZONE", "02:00", "2026-09-05"],
    // Microsecond server timestamps are read like strategyClock reads them (milliseconds).
    ["2026-09-05T06:59:59.999999Z", "2026-09-05T07:00:00.000Z", "ACTIVE_KILL_ZONE", "02:00", "2026-09-05"],
    ["2026-09-05T07:00:00Z", "2026-09-05T17:00:00.000Z", "DEAD_POOL", "12:00", "2026-09-05"],
    // Before the Unix epoch the same arithmetic holds.
    ["1969-12-31T12:00:00Z", "1969-12-31T17:00:00.000Z", "DEAD_POOL", "12:00", "1969-12-31"],
  ] as const)("after %s the next session starts at %s (%s, %s UTC−5 on %s)", (instant, at, session, time, day) => {
    expect(nextBoundary(instant)).toEqual({ at, session, time, day });
    expect(strategyClock(at)).toEqual({ day, time, session });
  });

  it("names the boundary that ends the current session, as the Dead Pool headline needs", () => {
    for (const now of ["2026-09-04T17:00:00Z", "2026-09-04T19:30:00Z", "2026-09-04T22:59:00Z"]) {
      expect(strategyClock(now).session).toBe("DEAD_POOL");
      expect(nextBoundary(now)).toMatchObject({ session: "ASIA", time: "18:00" });
    }
  });

  it("treats equivalent explicit offsets and Date objects identically", () => {
    const reference = nextBoundary("2026-09-04T12:00:00-05:00");
    expect(reference).toEqual({ at: "2026-09-04T23:00:00.000Z", session: "ASIA", time: "18:00", day: "2026-09-04" });
    expect(nextBoundary("2026-09-04T19:00:00+02:00")).toEqual(reference);
    expect(nextBoundary("2026-09-04T17:00:00.000Z")).toEqual(reference);
    expect(nextBoundary(new Date(Date.UTC(2026, 8, 4, 17)))).toEqual(reference);
  });

  it("walks a whole year as one fixed cycle of four boundaries per day, at the same UTC times", () => {
    const cycle: [Session, string, string][] = [
      ["JUDAS", "06:00", "01:00"], ["ACTIVE_KILL_ZONE", "07:00", "02:00"], ["DEAD_POOL", "17:00", "12:00"], ["ASIA", "23:00", "18:00"],
    ];
    let boundary = nextBoundary("2026-01-01T05:30:00Z");
    expect(boundary.at).toBe("2026-01-01T06:00:00.000Z");
    const first = Date.parse(boundary.at);
    for (let n = 0; n < 365 * 4; n++) {
      const [session, utc, strategy] = cycle[n % 4];
      const day = Math.floor(n / 4);
      expect({ session: boundary.session, utc: boundary.at.slice(11, 16), time: boundary.time }).toEqual({ session, utc, time: strategy });
      expect(boundary.day).toBe(new Date(first + day * DAY).toISOString().slice(0, 10));
      boundary = nextBoundary(boundary.at);
    }
    expect(boundary.at).toBe("2027-01-01T06:00:00.000Z");
  });
});

describe("nextBoundary input contract (same as strategyClock)", () => {
  it.each(["2026-09-04T14:00:00", "2026-09-04 14:00", "2026-09-04"])("requires an explicit zone: %s", value => {
    expect(() => nextBoundary(value)).toThrow("An explicit timezone is required.");
    expect(() => strategyClock(value)).toThrow("An explicit timezone is required.");
  });

  it.each(["2026-13-01T00:00:00Z", "not a timestampZ", "2026-02-30T25:00:00+00:00"])("rejects an invalid instant: %s", value => {
    expect(() => nextBoundary(value)).toThrow("Invalid timestamp.");
    expect(() => strategyClock(value)).toThrow("Invalid timestamp.");
  });

  it("rejects an invalid Date", () => {
    expect(() => nextBoundary(new Date(Number.NaN))).toThrow("Invalid timestamp.");
    expect(() => strategyClock(new Date(Number.NaN))).toThrow("Invalid timestamp.");
  });

  it("returns an ISO instant that strategyClock accepts", () => {
    const boundary = nextBoundary(new Date("2026-09-04T14:00:00Z"));
    expect(boundary.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(() => strategyClock(boundary.at)).not.toThrow();
  });
});
