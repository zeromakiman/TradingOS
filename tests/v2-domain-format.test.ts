import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  formatAgainst, formatDecimal, formatMoney, formatMoneyAgainst, formatMoneyExact, formatPercent, formatPrice, formatQuantity, formatR,
  formatSignedMoney, formatSignedMoneyList, plural, scaleOf, stripZeros,
} from "@/domain/format";

const SQL_98 = "98.00000000000000000000000000000000";

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

describe("exact decimal text", () => {
  it.each([
    [SQL_98, "98"], ["0.50000000", "0.5"], ["1.10000", "1.1"], ["-0", "0"], ["0.000", "0"], ["-12.3400", "-12.34"], ["007.50", "7.5"],
  ])("stripZeros(%s) = %s", (value, expected) => expect(stripZeros(value)).toBe(expected));

  it("reads numbers and Decimal instances without exponent notation", () => {
    expect(stripZeros(0.1)).toBe("0.1");
    expect(stripZeros(1e-7)).toBe("0.0000001");
    expect(stripZeros(new Decimal("2.50"))).toBe("2.5");
  });

  it.each(["abc", "", "1e5", "NaN", "Infinity", "1.", ".5", "1,000"])("rejects non-decimal text %j", value => {
    expect(() => stripZeros(value)).toThrow(TypeError);
  });

  it("rejects non-finite numbers", () => {
    expect(() => formatDecimal(Number.NaN)).toThrow();
    expect(() => formatR(Number.POSITIVE_INFINITY)).toThrow();
  });

  it.each([["0.50000000", 1], ["3", 0], ["0.00001000", 5], [SQL_98, 0], ["2.99666666", 8]])("scaleOf(%s) = %s", (value, scale) => {
    expect(scaleOf(value)).toBe(scale);
  });
});

describe("policy and user inputs are exact, padded to 2 dp (spec §6.6)", () => {
  it.each([
    ["0.5", "0.50"], ["0.504", "0.504"], ["0.755", "0.755"], ["0.50000000", "0.50"], ["3", "3.00"], ["0.50000001", "0.50000001"], [SQL_98, "98.00"],
  ])("formatDecimal(%s) = %s", (value, expected) => expect(formatDecimal(value)).toBe(expected));

  it.each([["0.504", "0.504%"], ["0.50000000", "0.50%"], ["0.004", "0.004%"], ["1", "1.00%"], ["0.755", "0.755%"]])("formatPercent(%s) = %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });

  it("prices use the instrument tick scale and never drop an off-tick digit", () => {
    expect(formatPrice("1.1", "0.00001")).toBe("1.10000");
    expect(formatPrice("1.10000000", "0.00001000")).toBe("1.10000");
    expect(formatPrice("1.100001", "0.00001")).toBe("1.100001");
    expect(formatPrice("4500", "1")).toBe("4500");
    expect(formatPrice("4500.5", "0.25")).toBe("4500.50");
    expect(formatPrice("1.1", null)).toBe("1.1");
  });

  it("quantities use the step scale", () => {
    expect(formatQuantity("1", "0.01")).toBe("1.00");
    expect(formatQuantity("0.25000000", "0.01")).toBe("0.25");
    expect(formatQuantity("0.123", "0.01")).toBe("0.123");
    expect(formatQuantity("2")).toBe("2");
  });
});

describe("formatR — one R formatter everywhere (spec §6.6)", () => {
  it.each([
    ["1.005", "+1.01R"], ["1.01", "+1.01R"], ["-1", "-1.00R"], ["0", "0.00R"], ["-0", "0.00R"], ["0.003", "+0.003R"], ["-0.0002", "-0.0002R"],
    ["3.00000000000000000000000000000000", "+3.00R"], ["-0.005", "-0.01R"], ["0.0049999", "+0.005R"], ["0.00333333333333333333333333333333", "+0.0033R"],
    ["-0.004", "-0.004R"], ["-0.00001", "-0.00001R"], ["0.000049", "+0.00005R"], ["12.345", "+12.35R"],
  ])("formatR(%s) = %s", (value, expected) => expect(formatR(value)).toBe(expected));

  it("renders R = 1.005 identically from text, number and Decimal (summary, table and chart agree)", () => {
    expect(new Set([formatR("1.005"), formatR(new Decimal("1.005")), formatR("1.00500000000000000000000000000000")])).toEqual(new Set(["+1.01R"]));
  });

  it("returns an em dash for unknown R", () => {
    expect(formatR(null)).toBe("—");
    expect(formatR(undefined)).toBe("—");
  });

  it("never renders a non-zero R as zero or as -0.00R", () => {
    const random = seeded(11);
    for (let i = 0; i < 2000; i++) {
      const magnitude = new Decimal(random()).mul(new Decimal(10).pow(-Math.floor(random() * 9))).toDecimalPlaces(12);
      if (magnitude.isZero()) continue;
      for (const value of [magnitude, magnitude.neg()]) {
        const text = formatR(value.toFixed());
        expect(text).not.toMatch(/^[+-]?0(\.0+)?R$/);
        expect(text.startsWith(value.isNegative() ? "-" : "+")).toBe(true);
      }
    }
  });
});

describe("formatAgainst — displayed comparison agrees with the verdict (spec §6.6)", () => {
  it.each([
    ["2.995", "3", "min", false, "2.99"],
    ["2.99500000", "3", "min", false, "2.99"],
    ["2.99666666", "3", "min", false, "2.99"],
    ["3", "3", "min", true, "3.00"],
    ["3.005", "3", "min", true, "3.00"],
    ["2.995", "2.995", "min", true, "2.995"],
    ["2.995", "2.996", "min", false, "2.995"],
    ["0.504", "0.5", "max", false, "0.51"],
    ["0.50000001", "0.5", "max", false, "0.51"],
    ["0.4999", "0.5", "max", true, "0.50"],
    ["0.755", "0.755", "max", true, "0.755"],
    ["0.76", "0.755", "max", false, "0.760"],
  ] as const)("formatAgainst(%s, %s, %s, %s) = %s", (value, threshold, rule, passes, expected) => {
    expect(formatAgainst(value, threshold, rule, passes)).toBe(expected);
  });

  it("shows equality as equal and passing: 4.00 vs 4.00", () => {
    expect(formatAgainst("4", "4", "min", true)).toBe("4.00");
    expect(formatDecimal("4")).toBe("4.00");
    expect(formatAgainst("4.00000000", "4.00000000", "max", true)).toBe("4.00");
  });

  it("falls back to the exact value when the inputs contradict the verdict", () => {
    expect(formatAgainst("2.5", "3", "min", true)).toBe("2.50");
    expect(formatAgainst("0.6", "0.5", "max", true)).toBe("0.60");
  });

  it("agrees with the exact verdict for random values on both sides of a threshold", () => {
    const random = seeded(7);
    for (let i = 0; i < 3000; i++) {
      const threshold = new Decimal(random() * 10).toDecimalPlaces(Math.floor(random() * 6));
      const value = threshold.plus(new Decimal(random() - 0.5).mul(new Decimal(10).pow(-Math.floor(random() * 9)))).toDecimalPlaces(Math.floor(random() * 10) + 1);
      for (const rule of ["min", "max"] as const) {
        const passes = rule === "min" ? value.gte(threshold) : value.lte(threshold);
        const shown = new Decimal(formatAgainst(value.toFixed(), threshold.toFixed(), rule, passes));
        const shownThreshold = new Decimal(formatDecimal(threshold.toFixed()));
        expect(rule === "min" ? shown.gte(shownThreshold) : shown.lte(shownThreshold)).toBe(passes);
      }
    }
  });
});

describe("money (spec §6.6, §9.3)", () => {
  it("formats long SQL-scale strings with the currency at 2 dp", () => {
    expect(formatMoney(SQL_98, "USD")).toBe("$98.00");
    expect(formatMoney("1234.5", "EUR")).toBe("€1,234.50");
    expect(formatMoney("-50", "USD")).toBe("-$50.00");
    expect(formatMoney("1234", "JPY")).toBe("¥1,234.00");
  });

  it("rounds half-up for display only and never shows a negative zero", () => {
    expect(formatMoney("0.005", "USD")).toBe("$0.01");
    expect(formatMoney("-0.005", "USD")).toBe("-$0.01");
    expect(formatMoney("-0.004", "USD")).toBe("$0.00");
    expect(formatSignedMoney("-0.004", "USD")).toBe("$0.00");
  });

  it("keeps every digit of large amounts (no binary floating point)", () => {
    expect(formatMoney("12345678901234567.125", "USD")).toBe("$12,345,678,901,234,567.13");
  });

  it("signs results", () => {
    expect(formatSignedMoney("1420", "USD")).toBe("+$1,420.00");
    expect(formatSignedMoney("-50", "USD")).toBe("-$50.00");
    expect(formatSignedMoney("0", "USD")).toBe("$0.00");
  });

  it("lists money per currency without converting", () => {
    expect(formatSignedMoneyList([{ currency: "USD", amount: "1420" }, { currency: "EUR", amount: "380" }])).toBe("+$1,420.00 · +€380.00");
    expect(formatSignedMoneyList([])).toBe("—");
  });

  it("shows thresholds exactly and compared money in the verdict direction", () => {
    expect(formatMoneyExact("49.995", "USD")).toBe("$49.995");
    expect(formatMoneyExact("100", "USD")).toBe("$100.00");
    expect(formatMoneyAgainst("50.001", "50", "USD", "max", false)).toBe("$50.01");
    expect(formatMoneyAgainst("49.996", "49.995", "USD", "max", false)).toBe("$49.996");
    expect(formatMoneyAgainst("100", "100", "USD", "min", true)).toBe("$100.00");
  });

  it("rejects invalid currency codes", () => {
    expect(() => formatMoney("1", "usd")).toThrow(RangeError);
    expect(() => formatMoney("1", "US")).toThrow(RangeError);
  });
});

describe("counts", () => {
  it("pluralises", () => {
    expect(plural(1, "trade")).toBe("1 trade");
    expect(plural(0, "trade")).toBe("0 trades");
    expect(plural(3, "completed trade")).toBe("3 completed trades");
  });
});
