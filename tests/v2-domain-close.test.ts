import { describe, expect, it } from "vitest";
import { calculatedClose, reportedClose } from "@/domain/close-preview";
import { formatR } from "@/domain/format";
import { averageExit, closeLegs, journalDecimal, journalPercent, livePartialCloses, onTick, type PartialCloseRecord, type SplitClose } from "@/domain/partial-closes";
import type { TimelineItem } from "@/domain/timeline";

// The close's result before it is recorded (docs/V2_ARCHITECTURE.md §3.4–3.5, FULL_CLOSE_V1 and UNPLANNED_CLOSE_V1),
// and the one exit price a close records when the journal knows the partial closes (§3.6, spec §60.17). Exact decimal
// text in and out; the values the database stores for the same inputs are checked in v2-close-preview-parity.

const FX = { tickSize: "0.00001", tickValue: "1" };

describe("close preview (the database's close math, before the close)", () => {
  it("works out a planned long: gross = ticks × tick value × size, net = gross − fees, R = net ÷ locked risk", () => {
    // The reviewed trade: 1.25 lots from 1.10000, $250 locked risk, out at 1.10400 is +$500.00 and +2.00R.
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1.25", ...FX }, "1.10400", "0", "250"))
      .toEqual({ grossPnl: "500", netPnl: "500", realizedR: "2", outcome: "WIN" });
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1.25", ...FX }, "1.09900", "7.5", "250"))
      .toEqual({ grossPnl: "-125", netPnl: "-132.5", realizedR: "-0.53", outcome: "LOSS" });
    // Breakeven is a zero net after fees, not a zero gross.
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1", ...FX }, "1.10002", "2", "100")).toMatchObject({ grossPnl: "2", netPnl: "0", outcome: "BREAKEVEN", realizedR: "0" });
  });

  it("turns the sign for a short and keeps R exact (the display rounds it)", () => {
    const short = calculatedClose({ direction: "SHORT", entryPrice: "1.33494", quantity: "5.23", ...FX }, "1.33297", "12.5", "1061.69");
    expect(short).toMatchObject({ grossPnl: "1030.31", netPnl: "1017.81", outcome: "WIN" });
    expect(short?.realizedR?.startsWith("0.95866966817055826088594599176784")).toBe(true);
    expect(formatR(short?.realizedR)).toBe("+0.96R");
    // A contract whose tick is not 1 point: DE40 with tick 0.5 worth 12.5 EUR.
    expect(calculatedClose({ direction: "SHORT", entryPrice: "23476.5", quantity: "2", tickSize: "0.5", tickValue: "12.5" }, "23400", "0", "500"))
      .toEqual({ grossPnl: "3825", netPnl: "3825", realizedR: "7.65", outcome: "WIN" });
  });

  it("takes a reported net P&L as it is, and has no R without a risk basis", () => {
    expect(reportedClose("-295.5", "100")).toEqual({ grossPnl: null, netPnl: "-295.5", realizedR: "-2.955", outcome: "LOSS" });
    expect(reportedClose("42.50", null)).toEqual({ grossPnl: null, netPnl: "42.5", realizedR: null, outcome: "WIN" });
    expect(reportedClose("0", "50")).toEqual({ grossPnl: null, netPnl: "0", realizedR: "0", outcome: "BREAKEVEN" });
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1", ...FX }, "1.1001", "0", null)?.realizedR).toBeNull();
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1", ...FX }, "1.1001", "0", "0")?.realizedR).toBeNull();
  });

  it("previews nothing from a value that is not a decimal, rather than a wrong result", () => {
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1", ...FX }, "1,1", "0", "100")).toBeNull();
    expect(calculatedClose({ direction: "LONG", entryPrice: "1.1", quantity: "1", tickSize: "0", tickValue: "1" }, "1.2", "0", "100")).toBeNull();
    expect(reportedClose("abc", "100")).toBeNull();
  });
});

const record = (id: string, recordedAt: string, details: Partial<PartialCloseRecord>): PartialCloseRecord => ({ id, recordedAt, price: null, quantity: null, percent: null, ...details });
const FIRST = "2026-10-23T09:00:00Z";
const SECOND = "2026-10-23T09:30:00Z";
const THIRD = "2026-10-23T10:00:00Z";

describe("partial closes the journal recorded while the trade was live", () => {
  it("reads only positive journal decimals and percents of 0 < p < 100", () => {
    expect(journalDecimal("1.33291")).toBe("1.33291");
    for (const value of ["0", "0.0", "1e5", "-1", "1.123456789", 5, null, undefined]) expect(journalDecimal(value), String(value)).toBeNull();
    expect(journalPercent("30")).toBe("30");
    expect(journalPercent("99.5")).toBe("99.5");
    for (const value of ["0", "100", "150", "-5", "30%", 30]) expect(journalPercent(value), String(value)).toBeNull();
  });

  it("takes partial-close entries stored while live, oldest first, never notes, other phases or pre-entry rows", () => {
    const item = (id: string, recordedAt: string, changes: Partial<TimelineItem>): TimelineItem => ({
      id, kind: "JOURNAL", journalKind: "PARTIAL_CLOSE", at: recordedAt, recordedAt, timing: "WHILE_LIVE", flags: [], title: "Partial close", source: id, timeLabel: "", details: {}, ...changes,
    });
    const timeline: TimelineItem[] = [
      item("journal:b", SECOND, { details: { quantity: "1.00", price: "1.33250" } }),
      item("journal:a", FIRST, { details: { percent: "30", price: "1.33291" } }),
      // Stored before the entry was recorded: never management of this position (Today reads LIVE rows only too).
      item("journal:c", THIRD, { details: { percent: "50", price: "1.33" }, flags: ["RECORDED_AFTER_EXECUTION_BEGAN"] }),
      item("journal:d", THIRD, { details: { percent: "50", price: "1.33" }, timing: "BEFORE_ENTRY" }),
      item("journal:e", THIRD, { journalKind: "NOTE", details: {} }),
      item("journal:f", THIRD, { kind: "TRADE_EVENT", journalKind: undefined, details: { percent: "50" } }),
    ];
    expect(livePartialCloses(timeline)).toEqual([
      { id: "journal:a", recordedAt: FIRST, price: "1.33291", quantity: null, percent: "30" },
      { id: "journal:b", recordedAt: SECOND, price: "1.33250", quantity: "1.00", percent: null },
    ]);
  });
});

describe("the one exit price of a position closed in parts", () => {
  const thirty = record("a", FIRST, { percent: "30", price: "1.33291" });

  it("asks for the rest's exit once every partial close has a price and an amount", () => {
    expect(closeLegs([], { quantity: "5.23" })).toEqual({ kind: "NONE" });
    // 30% of 5.23 lots is 1.569 lots: the share is the percent itself, the size only describes it.
    expect(closeLegs([thirty], { quantity: "5.23" })).toEqual({
      kind: "SPLIT", legs: [{ id: "a", recordedAt: FIRST, price: "1.33291", quantity: "1.569", percent: "30" }], position: "5.23", remaining: "3.661", remainingPercent: "70",
    });
    const sizes = closeLegs([record("a", FIRST, { quantity: "1.5", price: "1.33291" }), record("b", SECOND, { quantity: "1", price: "1.3325" })], { quantity: "5.23" });
    expect(sizes).toMatchObject({ kind: "SPLIT", remaining: "2.73", remainingPercent: null });
    // A first percent and later sizes add up exactly too.
    expect(closeLegs([thirty, record("b", SECOND, { quantity: "1", price: "1.3325" })], { quantity: "5.23" })).toMatchObject({ kind: "SPLIT", remaining: "2.661" });
  });

  it("leaves the average to the trader when the journal can't say what was closed at which price", () => {
    const reason = (records: PartialCloseRecord[], quantity: string | null = "5.23", complete = true) => {
      const legs = closeLegs(records, { quantity }, complete);
      return legs.kind === "AVERAGE" ? legs.reason : legs.kind;
    };
    expect(reason([record("a", FIRST, { percent: "30" })])).toBe("NO_PRICE");
    expect(reason([record("a", FIRST, { price: "1.33291" })])).toBe("NO_AMOUNT");
    // A later percent may be of the original or of the remaining size: never guessed.
    expect(reason([record("a", FIRST, { quantity: "1", price: "1.3325" }), record("b", SECOND, { percent: "50", price: "1.333" })])).toBe("LATER_PERCENT");
    expect(reason([thirty, record("b", SECOND, { percent: "50", price: "1.333" })])).toBe("LATER_PERCENT");
    expect(reason([thirty], null)).toBe("NO_SIZE");
    expect(reason([record("a", FIRST, { quantity: "6", price: "1.333" })])).toBe("BEYOND_POSITION");
    expect(reason([thirty], "5.23", false)).toBe("UNREAD");
    // Partial closes covering the whole position give its average exit; the trader still checks it.
    const whole = closeLegs([record("a", FIRST, { quantity: "2", price: "1.101" }), record("b", SECOND, { quantity: "3.23", price: "1.102" })], { quantity: "5.23" });
    expect(whole).toMatchObject({ kind: "AVERAGE", reason: "WHOLE_POSITION" });
    expect(whole.kind === "AVERAGE" && whole.average?.startsWith("1.1016175908221797323135755258126195")).toBe(true);
    expect(whole.kind === "AVERAGE" && onTick(whole.average ?? "", "0.00001")).toBe("1.10162");
  });

  it("works out the volume-weighted average of every leg and records it on the tick", () => {
    const split = closeLegs([thirty], { quantity: "5.23" }) as SplitClose;
    // 30% at 1.33291 and 70% at 1.33300: 1.332973, recorded as 1.33297. Typing the rest's price as the exit instead
    // would record 1.33300 for the whole position.
    expect(averageExit(split, "1.33300", "0.00001")).toEqual({ exact: "1.332973", price: "1.33297" });
    const sizes = closeLegs([record("a", FIRST, { quantity: "1.5", price: "1.33291" })], { quantity: "5.23" }) as SplitClose;
    expect(averageExit(sizes, "1.333", "0.00001")?.price).toBe("1.33297");
    expect(averageExit(sizes, "1.333", "0.00001")?.exact.startsWith("1.332974187380497131931166347992")).toBe(true);
    // Halves round up to the next tick.
    const half = closeLegs([record("a", FIRST, { percent: "50", price: "1.1" })], { quantity: "1" }) as SplitClose;
    expect(averageExit(half, "1.10001", "0.00001")).toEqual({ exact: "1.100005", price: "1.10001" });
    for (const rest of ["", "0", "-1.1", "1,1", "abc"]) expect(averageExit(split, rest, "0.00001"), rest).toBeNull();
  });

  it("puts a price on the tick, and keeps at most 8 decimals without one", () => {
    expect(onTick("1.332973", "0.00001")).toBe("1.33297");
    expect(onTick("1.3329751", "0.00001")).toBe("1.33298");
    expect(onTick("23476.24", "0.5")).toBe("23476");
    expect(onTick("23476.25", "0.5")).toBe("23476.5");
    expect(onTick("1.1234567891", null)).toBe("1.12345679");
    expect(onTick("0.000001", "0.00001")).toBeNull();
    expect(onTick("not a price", "0.00001")).toBeNull();
  });
});
