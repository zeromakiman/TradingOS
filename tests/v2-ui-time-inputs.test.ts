import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { strategyWallTime, wallTimeToInstant } from "@/components/trade/forms/live-model";
import { TimeField } from "@/components/trade/time-field";
import { instantOfWallClock, wallClockOf, wallClockZone, zoneHint, zoneTag } from "@/components/trade/time-input";
import { ZonedTimeInput } from "@/components/trade/zoned-time-input";
import { compareInstants, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";

// Every editable entry/exit time states the zone it is typed in, beside the field and in its label, and is converted
// with that same zone (V2 §5.1 authoritative times, §14.3 Record Live Trade "Earlier" in strategy time, §14.4 trade
// page times in the person's time display).

const KYIV: TimeDisplay = { mode: "local", zone: "Europe/Kyiv" };
const UTC: TimeDisplay = { mode: "utc" };
const SUMMER = "2026-07-01T09:00:00Z";
const WINTER = "2026-01-15T09:00:00Z";

describe("zone of a time field", () => {
  it("names strategy time, UTC and the local zone at the moment in question", () => {
    expect(zoneTag(STRATEGY_TIME)).toBe("UTC−5");
    expect(zoneTag(UTC)).toBe("UTC");
    expect(zoneTag(KYIV, SUMMER)).toBe("GMT+3");
    expect(zoneTag(KYIV, WINTER)).toBe("GMT+2");
    expect(zoneTag({ mode: "local", zone: "Not/AZone" }, SUMMER)).toBe("UTC");
    expect(zoneHint(STRATEGY_TIME)).toBe("UTC−5 (strategy time)");
    expect(zoneHint(KYIV, SUMMER)).toBe("GMT+3");
  });
});

describe("conversion of a typed time", () => {
  const walls = ["2026-10-23T07:30", "2026-10-23T00:00", "2026-10-23T23:59", "2028-02-29T12:00", "2026-12-31T19:00"];

  it("reads Record Live Trade's strategy time exactly like the trade page reads strategy time", () => {
    for (const wall of walls) {
      const live = wallTimeToInstant(wall);
      const page = instantOfWallClock(wall, STRATEGY_TIME);
      expect(live, wall).not.toBeNull();
      expect(page, wall).not.toBeNull();
      expect(compareInstants(live as string, page as string), wall).toBe(0);
    }
    for (const invalid of ["2026-02-30T10:00", "2026-10-23T24:00", "2026-10-23", "09:42", ""]) {
      expect(wallTimeToInstant(invalid), invalid).toBeNull();
      expect(instantOfWallClock(invalid, STRATEGY_TIME), invalid).toBeNull();
    }
  });

  it("is the fixed UTC−5 clock in strategy time, with no daylight saving", () => {
    expect(instantOfWallClock("2026-07-01T09:42", STRATEGY_TIME)).toBe("2026-07-01T14:42:00.000Z");
    expect(instantOfWallClock("2026-01-15T09:42", STRATEGY_TIME)).toBe("2026-01-15T14:42:00.000Z");
    expect(strategyWallTime("2026-10-23T13:00:00Z")).toBe("2026-10-23T08:00");
  });

  it("round-trips what the field shows in every display", () => {
    for (const display of [STRATEGY_TIME, UTC, KYIV]) {
      for (const instant of ["2026-10-23T14:42:00.000Z", "2026-03-01T05:07:00.000Z", "2026-07-15T23:59:00.000Z"]) {
        const wall = wallClockOf(instant, display);
        expect(instantOfWallClock(wall, display), `${display.mode} ${instant}`).toBe(instant);
      }
    }
  });

  it("settles local times around a daylight-saving change on one instant", () => {
    // Kyiv springs forward at 03:00 on 2026-03-29: 03:30 does not exist and moves forward with the clock, to 04:30
    // (as a JavaScript Date in that zone does), never back before the change.
    const gap = instantOfWallClock("2026-03-29T03:30", KYIV);
    expect(gap).toBe("2026-03-29T01:30:00.000Z");
    expect(wallClockOf(gap as string, KYIV)).toBe("2026-03-29T04:30");
    // It falls back at 04:00 on 2026-10-25: 03:30 happens twice and reads as one of them.
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(instantOfWallClock("2026-10-25T03:30", KYIV));
  });
});

describe("time fields state their zone", () => {
  it("shows the zone beside the value, decoratively (the label names it for assistive technology)", () => {
    const markup = renderToStaticMarkup(createElement(ZonedTimeInput, { zone: "UTC−5", id: "entry", defaultValue: "2026-10-23T07:30" }));
    expect(markup).toMatch(/^<div class="input-group"><input class="input pointer-coarse:min-h-11" type="datetime-local" step="60" id="entry" value="2026-10-23T07:30"\/>/);
    expect(markup).toContain('<span class="input-adornment input-adornment-end"><span aria-hidden="true" class="tabular-nums" data-time-zone="">UTC−5</span></span>');
  });

  it("names the zone of the trade page's Earlier entry and exit times in strategy time and in a local display", () => {
    const render = (display: TimeDisplay) =>
      renderToStaticMarkup(
        createElement(TimeField, {
          id: "entry-time",
          legend: "Entry time",
          choice: { mode: "earlier", wall: "2026-07-01T09:42" },
          onChange: () => undefined,
          display,
          nowIso: SUMMER,
        }),
      );
    const strategy = render(STRATEGY_TIME);
    expect(strategy).toContain('<label for="entry-time" class="field-label sr-only">Entry time, date and time (UTC−5)</label>');
    expect(strategy).toContain('data-time-zone="">UTC−5</span>');
    expect(strategy).toContain("Time in UTC−5 (strategy time)");
    const local = render(KYIV);
    expect(local).toContain("Entry time, date and time (GMT+3)");
    expect(local).toContain('data-time-zone="">GMT+3</span>');
    expect(local).toContain("Time in GMT+3");
  });
});

describe("zone of a typed time across a daylight-saving change", () => {
  // Kyiv is GMT+3 in summer and GMT+2 in winter: it falls back on 2026-10-25 (04:00 → 03:00) and springs forward on
  // 2026-03-29 (03:00 → 04:00), both at 01:00 UTC.
  const AFTER_FALL_BACK = "2026-10-27T12:00:00Z";
  const BEFORE_FALL_BACK = "2026-10-20T12:00:00Z";

  /** The instant a typed value and the tag beside it name together: "2026-10-24T10:00" with "GMT+3" is 07:00 UTC. */
  const namedInstant = (wall: string, tag: string) => {
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(tag);
    if (!match) throw new Error(`Unexpected zone tag ${tag}`);
    const [, sign, hours = "0", minutes = "0"] = match;
    const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
    return new Date(Date.parse(`${wall}:00Z`) - offsetMinutes * 60_000).toISOString();
  };

  it("names the offset the typed date is converted with, not the offset of today", () => {
    // Typed after the fall-back about a time before it: GMT+3, as the value is read.
    expect(wallClockZone("2026-10-24T10:00", KYIV, AFTER_FALL_BACK)).toEqual({ tag: "GMT+3", hint: "GMT+3" });
    expect(instantOfWallClock("2026-10-24T10:00", KYIV)).toBe("2026-10-24T07:00:00.000Z");
    // And the other way round.
    expect(wallClockZone("2026-10-26T10:00", KYIV, BEFORE_FALL_BACK)).toEqual({ tag: "GMT+2", hint: "GMT+2" });
    expect(instantOfWallClock("2026-10-26T10:00", KYIV)).toBe("2026-10-26T08:00:00.000Z");
    // Empty or unfinished values are named at the fallback (the page's time, or when the trade was recorded).
    expect(wallClockZone("", KYIV, AFTER_FALL_BACK).tag).toBe("GMT+2");
    expect(wallClockZone("2026-10-24T", KYIV, SUMMER).tag).toBe("GMT+3");
    // Strategy time and UTC have no daylight saving.
    expect(wallClockZone("2026-07-01T09:42", STRATEGY_TIME, WINTER)).toEqual({ tag: "UTC−5", hint: "UTC−5 (strategy time)" });
    expect(wallClockZone("2026-07-01T09:42", UTC, WINTER)).toEqual({ tag: "UTC", hint: "UTC" });
  });

  it("makes a typed time and its tag exactly the instant recorded, inside the spring gap and the autumn overlap too", () => {
    const walls = [
      "2026-03-29T02:59", "2026-03-29T03:00", "2026-03-29T03:30", "2026-03-29T04:00",
      "2026-10-25T02:59", "2026-10-25T03:00", "2026-10-25T03:30", "2026-10-25T04:00",
      "2026-10-24T10:00", "2026-10-26T10:00", "2026-07-01T09:42", "2026-01-15T09:42",
    ];
    for (const wall of walls) {
      for (const now of [AFTER_FALL_BACK, BEFORE_FALL_BACK, SUMMER, WINTER]) {
        expect(namedInstant(wall, wallClockZone(wall, KYIV, now).tag), `${wall} seen at ${now}`).toBe(instantOfWallClock(wall, KYIV));
      }
    }
    // 03:30 on the spring-forward night does not exist: it is read as GMT+2 (the clock before the change) and says so.
    expect(wallClockZone("2026-03-29T03:30", KYIV, SUMMER).tag).toBe("GMT+2");
  });

  it("labels the trade page's Earlier time with the zone of the typed date", () => {
    // The page is open after Kyiv fell back to GMT+2; the exit happened before the change, in GMT+3.
    const markup = renderToStaticMarkup(
      createElement(TimeField, {
        id: "exit-time",
        legend: "Exit time",
        choice: { mode: "earlier", wall: "2026-10-24T10:00" },
        onChange: () => undefined,
        display: KYIV,
        nowIso: AFTER_FALL_BACK,
      }),
    );
    expect(markup).toContain("Exit time, date and time (GMT+3)");
    expect(markup).toContain('data-time-zone="">GMT+3</span>');
    expect(markup).toContain("Time in GMT+3");
    expect(markup).not.toContain("GMT+2");
  });
});
