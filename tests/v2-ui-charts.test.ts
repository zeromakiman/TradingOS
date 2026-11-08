import Decimal from "decimal.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { minorLabelsClass, xLabelsMinWidth } from "@/components/charts/axes";
import { binCountText, binSign, DivergingBarChart, Histogram } from "@/components/charts/bar-chart";
import { monthWeeks } from "@/components/charts/calendar";
import { CalendarHeatmap, type CalendarHeatmapProps, type CalendarValueFormat, calendarValueLabel } from "@/components/charts/calendar-heatmap";
import { formatTickMoney, formatTickNumber, formatTickR } from "@/components/charts/format";
import { HBarChart } from "@/components/charts/hbar-chart";
import { nextMarkIndex } from "@/components/charts/keyboard";
import { DrawdownChart, LineChart } from "@/components/charts/line-chart";
import {
  areaPath,
  axisLabelSlots,
  bandLayout,
  intensityLevel,
  linePath,
  niceScale,
  pointHitAreas,
  pointPositions,
  toDecimal,
  topPercent,
} from "@/components/charts/scale";
import { Sparkline } from "@/components/charts/sparkline";
import { categorySummary } from "@/components/charts/summary";
import type { CalendarHeatmapDay, ChartDatum, HistogramBin } from "@/components/charts/types";
import { calendarMonth, distributionR, type PerformanceTrade } from "@/domain/performance";

const decimals = (...values: string[]) => values.map((value) => toDecimal(value)).filter((value) => value !== null);

const datum = (index: number, value: string, valueLabel = value): ChartDatum => ({
  key: `k${index}`,
  label: `Oct ${index + 1}`,
  value,
  valueLabel,
  href: `/journal?day=2026-10-${String(index + 1).padStart(2, "0")}`,
  detail: `${index + 1} trades`,
});

const DATASETS: Record<string, string[]> = {
  empty: [],
  single: ["1.25"],
  negativeOnly: ["-0.5", "-1", "-2.75"],
  mixed: ["1", "-1", "2.5", "0", "-0.25"],
  flatZero: ["0", "0"],
};

const finite = (markup: string) => {
  expect(markup).not.toMatch(/NaN|Infinity|undefined/);
};

describe("chart scales", () => {
  it.each(Object.entries(DATASETS))("produce finite, ordered domains for %s data", (_, values) => {
    const scale = niceScale(decimals(...values));
    expect(scale.min.lt(scale.max)).toBe(true);
    expect(scale.step.isPositive()).toBe(true);
    expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
    expect(scale.ticks.some((tick) => tick.isZero())).toBe(true);
    for (const value of decimals(...values)) {
      expect(value.gte(scale.min) && value.lte(scale.max)).toBe(true);
      const top = topPercent(value, scale);
      expect(Number.isFinite(top) && top >= 0 && top <= 100).toBe(true);
    }
  });

  it("chooses round steps without floating-point artefacts", () => {
    const scale = niceScale(decimals("0.1", "0.3"));
    expect(scale.ticks.map((tick) => tick.toFixed())).toEqual(["0", "0.1", "0.2", "0.3"]);
    expect(niceScale(decimals("3"), { integer: true, flat: { min: "0", max: "1" } }).ticks.every((tick) => tick.isInteger())).toBe(true);
  });

  it("leaves room for direct labels beyond the data, never on the zero side", () => {
    const room = (values: string[], includeZero = true) => {
      const scale = niceScale(decimals(...values), { includeZero, headroom: 0.15 });
      return [scale.min.toFixed(), scale.max.toFixed()];
    };
    expect(room(["0", "15"])).toEqual(["0", "20"]);
    expect(room(["-1.5", "0"])).toEqual(["-2", "0"]);
    expect(room(["-1", "2"])).toEqual(["-2", "3"]);
    expect(room(["100000", "105000"], false)).toEqual(["98000", "106000"]);
    expect(room(["0", "0"])).toEqual(["-1", "1"]);
  });

  it("pads a constant non-zero series when zero is not required", () => {
    const scale = niceScale(decimals("100000", "100000"), { includeZero: false });
    expect(scale.min.lt(100000) && scale.max.gt(100000)).toBe(true);
  });

  it("lays out points, bands and hit areas for any count", () => {
    expect(pointPositions(0)).toEqual([]);
    expect(pointPositions(1)).toEqual([50]);
    expect(pointPositions(3)).toEqual([0, 50, 100]);
    expect(bandLayout(4)).toEqual({ band: 25, centers: [12.5, 37.5, 62.5, 87.5] });
    expect(pointHitAreas([0, 50, 100])).toEqual([
      { left: 0, width: 25 },
      { left: 25, width: 50 },
      { left: 75, width: 25 },
    ]);
    expect(axisLabelSlots(1)).toEqual([{ index: 0, minor: false }]);
    const slots = axisLabelSlots(30);
    expect(slots[0]).toEqual({ index: 0, minor: false });
    expect(slots.at(-1)).toEqual({ index: 29, minor: false });
    expect(slots.length).toBeLessThanOrEqual(6);
  });

  it("builds paths only from two points up, with finite coordinates", () => {
    expect(linePath([])).toBe("");
    expect(linePath([{ x: 50, y: 20 }])).toBe("");
    expect(areaPath([{ x: 50, y: 20 }], 100)).toBe("");
    const path = linePath([
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
    expect(path).toBe("M0.00 1000.00 L1000.00 0.00");
    finite(areaPath([{ x: 0, y: 40 }, { x: 100, y: 60 }], 50));
  });

  it("buckets heatmap intensity by cross-multiplication", () => {
    const max = toDecimal("4");
    if (!max) throw new Error("fixture");
    const level = (value: string) => intensityLevel(toDecimal(value) ?? max, max);
    expect(level("0")).toBe(0);
    expect(level("0.5")).toBe(1);
    expect(level("1")).toBe(1);
    expect(level("1.0000001")).toBe(2);
    expect(level("-2")).toBe(2);
    expect(level("3")).toBe(3);
    expect(level("4")).toBe(4);
  });

  it("formats axis ticks exactly", () => {
    expect(formatTickR("1.5")).toBe("+1.5R");
    expect(formatTickR("0")).toBe("0R");
    expect(formatTickR("-1")).toBe("-1R");
    expect(formatTickNumber("-2.50")).toBe("-2.5");
    expect(formatTickMoney("USD")("1200")).toBe("$1.2K");
    expect(formatTickMoney("EUR")("-500")).toBe("-€500");
  });

  it("formats money ticks with exactly the precision the step needs", () => {
    const usd = formatTickMoney("USD");
    // Fine steps print the full amount; currency fractions use the minor unit.
    expect(["99950", "100000", "100050", "100100"].map((tick) => usd(tick, "50"))).toEqual(["$99,950", "$100,000", "$100,050", "$100,100"]);
    expect(usd("12.5", "0.5")).toBe("$12.50");
    expect(usd("-25", "5")).toBe("-$25");
    // Steps of 1,000 and more use compact units with the step's decimals in that unit.
    expect(["98000", "100000", "102000"].map((tick) => usd(tick, "2000"))).toEqual(["$98K", "$100K", "$102K"]);
    expect(["100000", "102500", "105000"].map((tick) => usd(tick, "2500"))).toEqual(["$100.0K", "$102.5K", "$105.0K"]);
    expect(["750000", "1000000", "1250000"].map((tick) => usd(tick, "250000"))).toEqual(["$750K", "$1.00M", "$1.25M"]);
    expect(usd("0", "250000")).toBe("$0");
    expect(formatTickMoney("JPY")("1500", "500")).toBe("¥1,500");
  });
});

describe("LineChart and DrawdownChart", () => {
  const series = (values: string[]) => [{ id: "r", name: "Cumulative R", points: values.map((value, index) => datum(index, value, `${value}R`)) }];

  it("shows an intentional empty state without a table or plot", () => {
    const markup = renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R", question: "Is the process compounding?", series: series([]), empty: { title: "No closed trades yet.", description: "Record or plan a trade; results appear here after you close it." } }));
    expect(markup).toContain("No closed trades yet.");
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("chart-svg");
    expect(markup).not.toContain("chart-hit");
    finite(markup);
  });

  it.each(["single", "negativeOnly", "mixed", "flatZero"])("renders %s data with finite geometry, a table view and drill-down links", (name) => {
    const values = DATASETS[name];
    const markup = renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R", question: "Is the process compounding?", sample: `${values.length} closed trades`, series: series(values), formatTick: formatTickR }));
    finite(markup);
    expect(markup).toContain("Is the process compounding?");
    expect(markup).toContain("<table");
    expect(markup).toContain('aria-pressed="true">Chart</button>');
    expect(markup.match(/class="chart-hit"/g)).toHaveLength(values.length);
    for (let index = 0; index < values.length; index++) expect(markup).toContain(`href="/journal?day=2026-10-${String(index + 1).padStart(2, "0")}"`);
    expect(markup).toContain(`${values.length} closed trades`);
    if (values.length > 1) expect(markup).toMatch(/<path class="chart-area" d="M[\d. LZ]+"/);
  });

  it("puts every series in one tooltip, legend and table, and keeps one mark in the tab order", () => {
    const markup = renderToStaticMarkup(
      createElement(LineChart, {
        title: "Cumulative R by account",
        question: "Is the process compounding?",
        series: [
          { id: "a", name: "FTMO 100K", points: [datum(0, "1"), datum(1, "2")] },
          { id: "b", name: "Personal", points: [datum(0, "-1"), datum(1, "0.5")] },
        ],
      }),
    );
    expect(markup).toContain("chart-legend");
    expect(markup).toContain('aria-label="Oct 2: FTMO 100K 2, Personal 0.5"');
    expect(markup.match(/tabindex="0"/gi)).toHaveLength(1);
    expect(markup).toContain('<th class="ui-table-th" scope="col" data-align="end">Personal</th>');
  });

  it("draws at most three series and lists any further series in the table", () => {
    const series = ["A", "B", "C", "D"].map((name, offset) => ({ id: name, name: `Account ${name}`, points: [datum(0, String(offset)), datum(1, String(offset + 1))] }));
    const markup = renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R by account", question: "Is each account compounding?", series }));
    finite(markup);
    expect(markup.match(/<path class="chart-line"/g)).toHaveLength(3);
    expect(markup).toContain(">Account D</th>");
    expect(markup).toContain("+1 more series in the table");
    const legend = /<ul class="chart-legend"[^>]*>(.*?)<\/ul>/.exec(markup)?.[1] ?? "";
    expect(legend).toContain("Account C");
    expect(legend).not.toContain("Account D");
  });

  it("draws drawdown below zero and labels the deepest point", () => {
    const markup = renderToStaticMarkup(createElement(DrawdownChart, { title: "R drawdown", question: "Where am I giving profits back?", points: ["0", "-1", "-2.5", "-0.5"].map((value, index) => datum(index, value, `${value}R`)) }));
    finite(markup);
    expect(markup).toContain("chart-series-neg");
    expect(markup).toMatch(/class="chart-direct-label"[^>]*>-2.50R</);
  });

  it("plots the domain's drawdown distances (≥ 0) below zero as well", () => {
    const yTicks = (markup: string) => [...markup.matchAll(/class="chart-y-tick"[^>]*>([^<]*)</g)].map((match) => match[1]);
    const signed = renderToStaticMarkup(createElement(DrawdownChart, { title: "R drawdown", question: "Where?", points: ["0", "-1", "-2.5"].map((value, index) => datum(index, value)), formatTick: formatTickR }));
    const distances = renderToStaticMarkup(createElement(DrawdownChart, { title: "R drawdown", question: "Where?", points: ["0", "1", "2.5"].map((value, index) => datum(index, value)), formatTick: formatTickR }));
    expect(yTicks(distances)).toEqual(yTicks(signed));
    expect(yTicks(distances).every((tick) => tick === "0R" || tick.startsWith("-"))).toBe(true);
    const paths = (markup: string) => [...markup.matchAll(/<path class="chart-line" d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths(distances)).toEqual(paths(signed));
    // Labels, tooltips, accessible names and the table show the plotted (non-positive) values.
    const labels = (markup: string) => [...markup.matchAll(/(?:aria-label="Oct \d+: |class="chart-direct-label"[^>]*>|data-align="end">)([+-]?\d[\d.]*R)/g)].map((match) => match[1]);
    expect(labels(distances)).toEqual(labels(signed));
    expect(labels(distances)).toEqual(expect.arrayContaining(["0.00R", "-1.00R", "-2.50R"]));
    expect(labels(distances).every((label) => label === "0.00R" || label.startsWith("-"))).toBe(true);
    expect(distances).not.toMatch(/\+\d[\d.]*R/);
  });

  it("formats drawdown labels with the chart's formatter", () => {
    const markup = renderToStaticMarkup(createElement(DrawdownChart, { title: "Drawdown", question: "Where?", name: "Drawdown", points: ["0", "250"].map((value, index) => datum(index, value)), formatValue: (signed: string) => `${signed} USD` }));
    expect(markup).toContain('aria-label="Oct 2: -250 USD. 2 trades"');
    expect(markup).toContain('<td class="ui-table-td" data-align="end">-250 USD</td>');
  });

  it("keeps money axis labels distinct for a large balance with a narrow range", () => {
    const balances = ["100000", "100030", "100080", "100045"];
    const markup = renderToStaticMarkup(
      createElement(LineChart, {
        title: "Balance from trades",
        question: "How has the balance moved?",
        series: [{ id: "balance", name: "Balance from trades", points: balances.map((value, index) => datum(index, value)) }],
        includeZero: false,
        formatTick: formatTickMoney("USD"),
      }),
    );
    const ticks = [...markup.matchAll(/class="chart-y-tick"[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(ticks).toEqual(["$99,950", "$100,000", "$100,050", "$100,100"]);
    // The gutter widens so full amounts are not cut off.
    expect(markup).toMatch(/class="chart" style="--chart-gutter:\d+(\.\d+)?rem"/);
  });

  it("leaves gaps for unknown values instead of plotting them", () => {
    const points = [datum(0, "1"), { ...datum(1, "0"), value: null, valueLabel: "—" }, datum(2, "2"), datum(3, "1.5")];
    const markup = renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R", question: "Is the process compounding?", series: [{ id: "r", name: "Cumulative R", points }] }));
    finite(markup);
    const line = /<path class="chart-line" d="([^"]+)"/.exec(markup)?.[1] ?? "";
    expect(line).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    // The point before the gap has no segment, so it is drawn as a dot next to the end dot.
    expect(markup.match(/class="chart-dot chart-series-1"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Oct 2: —. 2 trades"');
  });
});

describe("Bar charts", () => {
  it.each(["single", "negativeOnly", "mixed"])("renders diverging bars for %s data", (name) => {
    const values = DATASETS[name];
    const markup = renderToStaticMarkup(createElement(DivergingBarChart, { title: "Daily net R", question: "Which days drive results?", data: values.map((value, index) => datum(index, value)), valueName: "Net R", formatTick: formatTickR }));
    finite(markup);
    expect(markup.match(/class="chart-bar"/g)).toHaveLength(values.length);
    if (values.some((value) => value.startsWith("-"))) expect(markup).toContain('data-sign="neg"');
    expect(markup).toContain("<table");
    expect(markup).toContain('href="/journal?day=2026-10-01"');
  });

  it("shows the empty state for no days", () => {
    const markup = renderToStaticMarkup(createElement(DivergingBarChart, { title: "Daily net R", question: "Which days drive results?", data: [] }));
    expect(markup).toContain("Nothing to chart yet.");
  });

  it("colours histogram bins by side of zero and links each bin", () => {
    const bins: HistogramBin[] = [
      { key: "a", label: "−1.0R to −0.5R", from: "-1", to: "-0.5", count: 3, breakEven: 0, href: "/journal?r=-1" },
      { key: "b", label: "−0.5R to 0R", from: "-0.5", to: "0", count: 0, breakEven: 0 },
      // Starts at 0R but holds no break-even trade: profit.
      { key: "c", label: "0R to 0.5R", from: "0", to: "0.5", count: 1, breakEven: 0 },
      { key: "d", label: "−0.25R to 0.25R", from: "-0.25", to: "0.25", count: 2, breakEven: 0 },
    ];
    const markup = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins, formatEdge: formatTickR }));
    finite(markup);
    expect(markup).toContain('data-sign="neg"');
    expect(markup).toContain('data-sign="pos"');
    expect(markup).toContain('data-sign="zero"');
    expect(markup).toContain('data-sign="neutral"');
    expect(markup).toContain('href="/journal?r=-1"');
    expect(markup).toContain("<table");
    const empty = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins: bins.map((bin) => ({ ...bin, count: 0 })) }));
    expect(empty).toContain("Nothing to chart yet.");
  });

  it("accepts the domain's distribution bins, including open-ended edge bins without keys", () => {
    // Shape of distributionR(...).bins: contiguous, with open-ended outer bins.
    const bins = [
      { from: null, to: "-1", label: "Below -1.0R", count: 1, breakEven: 0, tradeIds: ["a"] },
      { from: "-1", to: "-0.5", label: "-1.0R to -0.5R", count: 0, breakEven: 0, tradeIds: [] },
      { from: "-0.5", to: "0", label: "-0.5R to 0.0R", count: 2, breakEven: 0, tradeIds: ["b", "c"] },
      { from: "0", to: null, label: "0.0R and above", count: 1, breakEven: 0, tradeIds: ["d"] },
    ];
    const markup = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins, formatEdge: formatTickR }));
    finite(markup);
    expect(markup).not.toMatch(/null|open:/);
    expect(markup.match(/class="chart-bar"/g)).toHaveLength(4);
    expect(markup.match(/data-sign="neg"/g)).toHaveLength(2);
    expect(markup.match(/data-sign="zero"/g)).toHaveLength(1);
    expect(markup.match(/data-sign="pos"/g)).toHaveLength(1);
    const edges = [...markup.matchAll(/class="chart-x-tick"[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(edges).toEqual(["-1R", "-0.5R", "0R"]);
    expect(markup).toContain("Below -1.0R");
    expect(markup).toContain("0.0R and above");
  });

  it("draws no bar for an unknown value but keeps its row, label and table entry", () => {
    const data = [datum(0, "2", "+2.00R"), { ...datum(1, "0"), value: null, valueLabel: "—" }];
    const bars = renderToStaticMarkup(createElement(DivergingBarChart, { title: "Daily net R", question: "Which days drive results?", data }));
    finite(bars);
    expect(bars.match(/class="chart-bar"/g)).toHaveLength(1);
    const rows = renderToStaticMarkup(createElement(HBarChart, { title: "Net R by model", question: "Which conditions perform?", data }));
    finite(rows);
    expect(rows.match(/class="hbar-bar"/g)).toHaveLength(1);
    expect(rows.match(/class="hbar-row[ "]/g)).toHaveLength(2);
    expect(rows).toContain(">—<");
  });

  it("renders signed horizontal bars with values at the tips", () => {
    const markup = renderToStaticMarkup(
      createElement(HBarChart, {
        title: "Net R by model",
        question: "Which conditions perform?",
        data: [datum(0, "3.5", "+3.50R"), datum(1, "-1.25", "−1.25R"), datum(2, "0", "0.00R")],
        valueName: "Net R",
      }),
    );
    finite(markup);
    expect(markup).toContain('data-sign="pos"');
    expect(markup).toContain('data-sign="neg"');
    expect(markup).toContain(">+3.50R<");
    expect(markup).toContain('href="/journal?day=2026-10-02"');
    expect(markup).toContain("<table");
  });
});

describe("CalendarHeatmap", () => {
  it("builds Monday-first weeks", () => {
    const weeks = monthWeeks("2026-10");
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]).toEqual({ date: "2026-10-01", day: 1 });
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(() => monthWeeks("2026-13")).toThrow();
  });

  it("colours days by result, links them and lists them in the table", () => {
    const markup = renderToStaticMarkup(
      createElement(CalendarHeatmap, {
        title: "Calendar",
        question: "When am I winning or losing?",
        month: "2026-10",
        mode: "NET_R",
        valueName: "Net R",
        today: "2026-10-14",
        days: [
          { day: "2026-10-05", value: "2", detail: "2 trades", href: "/journal?day=2026-10-05" },
          { day: "2026-10-06", value: "-1", detail: "1 trade", href: "/journal?day=2026-10-06" },
          { day: "2026-10-07", value: "0", detail: "1 trade" },
        ],
        modeLinks: [
          { href: "/edge?calendar=netR", label: "Net R", current: true },
          { href: "/edge?calendar=count", label: "Trade count" },
        ],
        previousMonth: { href: "/edge?month=2026-09", label: "September 2026" },
      }),
    );
    finite(markup);
    expect(markup).toMatch(/href="\/journal\?day=2026-10-05"[^>]*data-tone="pos"[^>]*data-level="4"|data-tone="pos"[^>]*data-level="4"[^>]*href/);
    expect(markup).toContain('data-tone="neg"');
    expect(markup).toContain('data-today="true"');
    expect(markup).toContain("Mon, Oct 5: Net R +2.00R. 2 trades");
    expect(markup).toContain("Tue, Oct 6: Net R -1.00R. 1 trade");
    expect(markup).toContain("October 2026: 3 days with results; best Oct 5 +2.00R; worst Oct 6 -1.00R.");
    expect(markup).toContain('<td class="ui-table-td" data-align="end">-1.00R</td>');
    expect(markup).toContain('aria-label="September 2026"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("<table");
    expect(markup.match(/class="calendar-cell heat"/g)).toHaveLength(31);
  });

  it("gives every day with a result a visible value and a non-colour cue for narrow screens", () => {
    const markup = renderToStaticMarkup(
      createElement(CalendarHeatmap, {
        title: "Calendar",
        question: "When am I winning or losing?",
        month: "2026-10",
        mode: "NET_R",
        days: [
          { day: "2026-10-05", value: "2" },
          { day: "2026-10-06", value: "-1.5" },
          { day: "2026-10-07", value: "0" },
        ],
      }),
    );
    const cells = [...markup.matchAll(/<a [^>]*class="calendar-cell heat"[^>]*>(.*?)<\/a>|<button [^>]*class="calendar-cell heat"[^>]*>(.*?)<\/button>/g)].map((match) => match[0]);
    const content = (day: number) => cells[day - 1].replace(/<[^>]+>/g, "|");
    expect(cells).toHaveLength(31);
    expect(cells[4]).toContain('data-tone="pos"');
    expect(content(5)).toContain("|+2.00R|");
    expect(cells[4]).toContain('<span class="calendar-cue" aria-hidden="true">+</span>');
    expect(cells[5]).toContain('data-tone="neg"');
    expect(content(6)).toContain("|-1.50R|");
    expect(cells[5]).toContain('<span class="calendar-cue" aria-hidden="true">−</span>');
    expect(content(7)).toContain("|0.00R|");
    expect(cells[6]).toContain('<span class="calendar-cue" aria-hidden="true">0</span>');
    // Every coloured cell carries words as well as colour.
    for (const cell of cells.filter((html) => html.includes("data-tone="))) expect(cell).toMatch(/class="calendar-cue" aria-hidden="true">[+−0-9]/);
    expect(cells[0]).not.toContain("calendar-cue");
    const count = renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When?", month: "2026-10", mode: "COUNT", days: [{ day: "2026-10-05", value: "3" }, { day: "2026-10-06", value: "1" }] }));
    expect(count).toContain('<span class="calendar-value">3 trades</span><span class="calendar-cue" aria-hidden="true">3</span>');
    expect(count).toContain('<span class="calendar-value">1 trade</span>');
  });

  it("never shows a raw decimal: each mode formats its values with the domain formatters", () => {
    const results: CalendarHeatmapDay[] = [
      { day: "2026-10-05", value: "120.5", detail: "2 trades" },
      { day: "2026-10-06", value: "-40.125", detail: "1 trade" },
      { day: "2026-10-07", value: "0.0030000", detail: "1 trade" },
    ];
    const losses: CalendarHeatmapDay[] = [
      { day: "2026-10-05", value: "50" },
      { day: "2026-10-06", value: "120.5" },
    ];
    const render = (format: CalendarValueFormat, days = results) =>
      renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When am I winning or losing?", month: "2026-10", valueName: "Result", days, ...format }));
    const shown = (markup: string) => [...markup.matchAll(/<span class="calendar-value">([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(shown(render({ mode: "NET_R" }))).toEqual(["+120.50R", "-40.13R", "+0.003R"]);
    expect(shown(render({ mode: "NET_PNL", currency: "USD" }))).toEqual(["+$120.50", "-$40.13", "$0.00"]);
    expect(shown(render({ mode: "NET_PNL", currency: "EUR" }))).toEqual(["+€120.50", "-€40.13", "€0.00"]);
    expect(shown(render({ mode: "GROSS_LOSS", currency: "USD" }, losses))).toEqual(["$50.00", "$120.50"]);
    for (const markup of [render({ mode: "NET_R" }), render({ mode: "NET_PNL", currency: "USD" }), render({ mode: "GROSS_LOSS", currency: "USD" }, losses)]) {
      expect(markup).not.toMatch(/120\.5(?!0)|40\.125|0\.0030000/);
    }
    // The same words reach the readout (accessible name), the table and the text summary.
    const pnl = render({ mode: "NET_PNL", currency: "USD" });
    expect(pnl).toContain("Mon, Oct 5: Result +$120.50. 2 trades");
    expect(pnl).toContain('<td class="ui-table-td" data-align="end">-$40.13</td>');
    expect(pnl).toContain("October 2026: 3 days with results; best Oct 5 +$120.50; worst Oct 6 -$40.13.");
    expect(calendarValueLabel(new Decimal("2"), { mode: "COUNT" })).toBe("2 trades");
    expect(calendarValueLabel(new Decimal("1"), { mode: "COUNT" })).toBe("1 trade");
    expect(calendarValueLabel(new Decimal("-0"), { mode: "NET_PNL", currency: "USD" })).toBe("$0.00");
    expect(calendarValueLabel(new Decimal("-0"), { mode: "NET_R" })).toBe("0.00R");
  });

  it("accepts calendarMonth(...).days as is and formats money in the month's currency", () => {
    const trade = (id: string, exitedAt: string, netPnl: string, realizedR: string): PerformanceTrade => ({
      id,
      account_id: "acc-1",
      origin: "PLANNED",
      currency: "USD",
      symbol: "EURUSD",
      direction: "LONG",
      entry_model: "OTE",
      entered_at: exitedAt,
      exited_at: exitedAt,
      realized_r: realizedR,
      net_pnl: netPnl,
      fees: "0",
      outcome: netPnl.startsWith("-") ? "LOSS" : "WIN",
      requested_risk_percent: "0.5",
      strategy_version_id: null,
      strategy_version: null,
      risk_plan_version_id: null,
      risk_plan_version: null,
    });
    const trades = [trade("t1", "2026-10-05T15:00:00Z", "120.5", "1.205"), trade("t2", "2026-10-05T16:00:00Z", "-20", "-0.2"), trade("t3", "2026-10-06T15:00:00Z", "-40", "-0.4")];
    const month = calendarMonth(trades, "2026-10", "NET_PNL");
    expect(month.currency).toBe("USD");
    const markup = renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When am I winning or losing?", month: month.month, mode: "NET_PNL", currency: "USD", valueName: "Net P&L", days: month.days }));
    finite(markup);
    expect(markup).toContain('<span class="calendar-value">+$100.50</span>');
    expect(markup).toContain('<span class="calendar-value">-$40.00</span>');
    expect(markup).not.toMatch(/>100\.5</);
  });

  it("explains an empty month instead of hiding the calendar", () => {
    const markup = renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When am I winning or losing?", month: "2026-02", mode: "COUNT", days: [] }));
    expect(markup).toContain("No closed trades this month.");
    expect(markup.match(/class="calendar-cell heat"/g)).toHaveLength(28);
  });

  it("accepts the domain's calendar cells and colours loss and count modes with one hue", () => {
    // Shape of calendarMonth(...).days: extra fields are ignored, days outside the month too.
    const domainDays = [
      { day: "2026-10-05", inMonth: true, closed: 2, rTrades: 2, value: "120.5", money: [], tradeIds: ["t1", "t2"] },
      { day: "2026-10-06", inMonth: true, closed: 1, rTrades: 1, value: "40", money: [], tradeIds: ["t3"] },
      { day: "2026-09-30", inMonth: false, closed: 1, rTrades: 1, value: "999", money: [], tradeIds: ["t4"] },
    ];
    const loss = renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When am I winning or losing?", month: "2026-10", mode: "GROSS_LOSS", currency: "USD", valueName: "Gross realized loss", days: domainDays }));
    finite(loss);
    expect(loss.match(/data-tone="neg" data-level="\d" data-mark=/g)).toHaveLength(2);
    expect(loss).not.toContain('data-tone="pos"');
    expect(loss).toContain("Mon, Oct 5: Gross realized loss $120.50");
    expect(loss).toContain('<span class="calendar-value">$40.00</span>');
    expect(loss).not.toMatch(/120\.5(?!0)|999/);
    expect(loss).toContain("Larger loss");
    const count = renderToStaticMarkup(createElement(CalendarHeatmap, { title: "Calendar", question: "When am I winning or losing?", month: "2026-10", mode: "COUNT", days: [{ day: "2026-10-05", value: "3" }] }));
    expect(count).toMatch(/data-tone="seq" data-level="4"/);
    expect(count).toContain("More trades");
  });

  it("requires a currency for the money modes", () => {
    const base = { title: "Calendar", question: "When am I winning or losing?", month: "2026-10", days: [] };
    // @ts-expect-error Net P&L is per currency (§9.3), so the chart must be told which one.
    const missing: CalendarHeatmapProps = { ...base, mode: "NET_PNL" };
    const named: CalendarHeatmapProps = { ...base, mode: "NET_PNL", currency: "EUR" };
    expect([missing.mode, named.currency]).toEqual(["NET_PNL", "EUR"]);
  });
});

describe("Text summaries", () => {
  const byModel: ChartDatum[] = [
    { key: "OB_FIRST_TOUCH", label: "OB first touch", value: "6.8", valueLabel: "+6.80R", detail: "N = 12 · Emerging tendency" },
    { key: "OTE", label: "OTE", value: "-1.35", valueLabel: "-1.35R", detail: "N = 8 · Insufficient evidence" },
    { key: "OTHER", label: "Other", value: "0.4", valueLabel: "+0.40R", detail: "N = 3 · Insufficient evidence" },
  ];

  it("names each extreme group with its sample size and evidence label (§13.8)", () => {
    expect(categorySummary("Net R by model", byModel)).toBe(
      "Net R by model: 3 entries. Highest OB first touch +6.80R (N = 12 · Emerging tendency); lowest OTE -1.35R (N = 8 · Insufficient evidence).",
    );
    expect(categorySummary("Net R by model", byModel.slice(0, 1))).toBe("Net R by model: OB first touch +6.80R (N = 12 · Emerging tendency).");
    expect(categorySummary("Daily net R", [datum(0, "1", "+1.00R"), datum(1, "-1", "-1.00R")])).toBe("Daily net R: 2 entries. Highest Oct 1 +1.00R (1 trades); lowest Oct 2 -1.00R (2 trades).");
    expect(categorySummary("Daily net R", [{ key: "a", label: "Oct 1", value: "1", valueLabel: "+1.00R" }])).toBe("Daily net R: Oct 1 +1.00R.");
  });

  it("puts that summary on the breakdown chart for screen readers", () => {
    const markup = renderToStaticMarkup(createElement(HBarChart, { title: "Net R by model", question: "Which conditions perform?", data: byModel, valueName: "Net R" }));
    expect(markup).toMatch(/<span id="[^"]+" class="sr-only">Net R by model: 3 entries\. Highest OB first touch \+6\.80R \(N = 12 · Emerging tendency\); lowest OTE -1\.35R \(N = 8 · Insufficient evidence\)\.<\/span>/);
  });
});

describe("Chart keyboard navigation", () => {
  it("moves by one mark with the left and right arrows and stops at both ends", () => {
    expect(nextMarkIndex("ArrowRight", 0, 5)).toBe(1);
    expect(nextMarkIndex("ArrowLeft", 3, 5)).toBe(2);
    expect(nextMarkIndex("ArrowRight", 4, 5)).toBe(4);
    expect(nextMarkIndex("ArrowLeft", 0, 5)).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nextMarkIndex("Home", 3, 5)).toBe(0);
    expect(nextMarkIndex("End", 1, 5)).toBe(4);
  });

  it("moves by a row with the up and down arrows (a week in the calendar)", () => {
    expect(nextMarkIndex("ArrowDown", 2, 31, 7)).toBe(9);
    expect(nextMarkIndex("ArrowUp", 9, 31, 7)).toBe(2);
    expect(nextMarkIndex("ArrowUp", 3, 31, 7)).toBe(0);
    expect(nextMarkIndex("ArrowDown", 27, 31, 7)).toBe(30);
    // A single row moves one mark at a time.
    expect(nextMarkIndex("ArrowDown", 2, 5)).toBe(3);
    expect(nextMarkIndex("ArrowUp", 2, 5)).toBe(1);
  });

  it("leaves other keys, and charts without marks, to the browser", () => {
    expect(nextMarkIndex("Enter", 2, 5)).toBeNull();
    expect(nextMarkIndex("Tab", 2, 5)).toBeNull();
    expect(nextMarkIndex("a", 2, 5)).toBeNull();
    expect(nextMarkIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("Sparkline", () => {
  it.each(Object.entries(DATASETS))("stays finite for %s data", (_, values) => {
    const markup = renderToStaticMarkup(createElement(Sparkline, { values, label: "Net R, last 12 weeks" }));
    finite(markup);
    expect(markup).toContain("<title>Net R, last 12 weeks</title>");
  });
});

describe("Horizontal bars in narrow containers (phones, narrow cards)", () => {
  const mixed = [datum(0, "3.5", "+3.50R"), datum(1, "-1.25", "−1.25R"), datum(2, "0.5", "+0.50R")];
  const render = (data: ChartDatum[]) => renderToStaticMarkup(createElement(HBarChart, { title: "Net R by model", question: "Which conditions perform?", data, valueName: "Net R" }));

  it("measures the list, not the page, and stacks each row below 32rem: name and value above a full-width bar", () => {
    const markup = render(mixed);
    finite(markup);
    expect(markup).toContain('class="hbar-list @container"');
    expect(markup.match(/class="hbar-row @max-\[32rem\]:grid-cols-\[minmax\(0,1fr\)_auto\][^"]*"/g)).toHaveLength(3);
    // Mixed signs reserve label room on both sides of the track, only side by side.
    expect(markup.match(/class="hbar-track ml-18 mr-18 @max-\[32rem\]:col-span-2 @max-\[32rem\]:mx-0"/g)).toHaveLength(3);
    // Stacked rows show the value beside the name and hide the tip label, so the bar gets the whole width.
    expect(markup).toMatch(/<span class="hidden [^"]*@max-\[32rem\]:block" aria-hidden="true">\+3\.50R<\/span>/);
    expect(markup.match(/class="hbar-value @max-\[32rem\]:hidden"/g)).toHaveLength(3);
    // The value is announced once, through the row's accessible name.
    expect(markup).toContain('aria-label="Oct 1: Net R +3.50R. 1 trades"');
  });

  it("reserves label room only on the side that has bars", () => {
    const markup = render([datum(0, "3.5", "+3.50R"), datum(1, "1", "+1.00R")]);
    expect(markup).toContain('class="hbar-track mr-18 @max-[32rem]:col-span-2 @max-[32rem]:mx-0"');
    expect(markup).not.toContain("ml-18");
  });

  it("never cuts a group's sample line off: it wraps at every width, only between its parts, with its text unchanged", () => {
    const detail = "N = 27 · 1 without risk · Emerging tendency";
    const markup = render([{ ...datum(0, "1.5", "+1.50R"), detail }, { ...datum(1, "-0.5", "−0.50R"), detail: "N = 3" }]);
    // Desktop included (§13.8): the evidence label in a 176px label column is no longer ellipsized.
    expect(markup).toContain(
      '<span class="hbar-detail whitespace-normal"><span class="inline-block wrap-anywhere">N = 27 ·</span> <span class="inline-block wrap-anywhere">1 without risk ·</span> <span class="inline-block wrap-anywhere">Emerging tendency</span></span>',
    );
    expect(markup).toContain('<span class="hbar-detail whitespace-normal"><span class="inline-block wrap-anywhere">N = 3</span></span>');
    expect(markup).not.toContain("@max-[32rem]:whitespace-normal");
    const shown = /<span class="hbar-detail[^"]*">((?:<span[^>]*>[^<]*<\/span> ?)+)<\/span>/.exec(markup)?.[1].replace(/<[^>]+>/g, "");
    expect(shown).toBe(detail);
  });
});

describe("Time axis labels", () => {
  const labels = (texts: string[]) =>
    texts.map((text, index) => ({ key: `x${index}`, text, x: Math.round((index / (texts.length - 1)) * 100), minor: index > 0 && index < texts.length - 1 }));

  it("computes the narrowest plot where neighbours keep a gap, counting the inward reach of the edge labels", () => {
    // Two edge labels: each reaches inwards by its whole width (6 × 0.42rem), plus the 0.75rem gap.
    expect(xLabelsMinWidth([{ text: "Oct 14", x: 0 }, { text: "Oct 21", x: 100 }])).toBeCloseTo(5.79, 2);
    // A centred label 25% before the right-aligned last one: half its width plus the last label's whole width.
    expect(xLabelsMinWidth([{ text: "Oct 14", x: 75 }, { text: "Oct 21", x: 100 }])).toBeCloseTo((1.26 + 2.52 + 0.75) / 0.25, 2);
  });

  it("hides the in-between labels of axes narrower than they need, keeping the first and last", () => {
    const five = labels(["Start", "Oct 6", "Oct 9", "Oct 14", "Oct 21"]);
    const needed = xLabelsMinWidth(five);
    expect(needed).toBeGreaterThan(16);
    const hide = minorLabelsClass(five);
    const threshold = Number(/@max-\[(\d+)rem\]/.exec(hide)?.[1]);
    expect(threshold).toBeGreaterThanOrEqual(needed);
    expect(hide).toBe(`@max-[${threshold}rem]:[&>[data-minor]]:hidden`);
    expect(minorLabelsClass(labels(["Oct 1", "Oct 31"]))).toBe("");
    // Far too many long labels for any card: the in-between ones never show.
    expect(minorLabelsClass(labels(Array.from({ length: 30 }, (_, index) => `Week ${index + 1} of the year`)))).toBe("[&>[data-minor]]:hidden");
  });

  it("makes the axis a size container whose labels hide by its own width", () => {
    const points = ["0", "1", "-0.5", "2", "1.5", "3", "2.5"].map((value, index) => datum(index, value));
    const markup = renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R", question: "Is the process compounding?", series: [{ id: "r", name: "Cumulative R", points }] }));
    expect(markup).toContain('<div class="chart-x-axis @container" aria-hidden="true"><div class="absolute inset-0');
    expect(markup).toMatch(/class="chart-x-tick"[^>]*data-minor="true"/);
    expect(markup).toMatch(/class="chart-x-tick" data-edge="end"[^>]*>Oct 7</);
  });
});

describe("R distribution: break-even trades are neither profit nor loss (0R bin)", () => {
  const ledger = (id: string, realized: string) =>
    ({ id, realized_r: realized, exited_at: "2026-10-14T15:00:00Z", lifecycle: "CLOSED", net_pnl: "0", currency: "USD" }) as unknown as PerformanceTrade;

  it("counts the break-even trades of the bin that starts at 0R", () => {
    const result = distributionR([ledger("a", "0"), ledger("b", "0.00000000"), ledger("c", "0.25"), ledger("d", "-0.25"), ledger("e", "1")]);
    const bin = (from: string) => result.bins.find((entry) => entry.from === from);
    expect(bin("0")).toMatchObject({ to: "0.5", count: 3, breakEven: 2, label: "0.0R to +0.5R" });
    expect(bin("-0.5")).toMatchObject({ count: 1, breakEven: 0 });
    expect(bin("1")).toMatchObject({ count: 1, breakEven: 0 });
    expect(result.bins.every((entry) => entry.from === "0" || entry.breakEven === 0)).toBe(true);
  });

  it("draws the bin starting at 0R in the neutral tone while it holds break-even trades, and as profit with none", () => {
    expect(binSign({ from: "0", to: "0.5", breakEven: 2 })).toBe("neutral");
    expect(binSign({ from: "0", to: "0.5", breakEven: 0 })).toBe("pos");
    expect(binSign({ from: "0", to: null, breakEven: 1 })).toBe("neutral");
    expect(binSign({ from: "0", to: null, breakEven: 0 })).toBe("pos");
    // An unreadable count cannot show that the bin holds only winners.
    expect(binSign({ from: "0", to: "0.5", breakEven: Number.NaN })).toBe("neutral");
    expect(binSign({ from: "0.5", to: "1", breakEven: 0 })).toBe("pos");
    expect(binSign({ from: "-0.5", to: "0", breakEven: 0 })).toBe("neg");
  });

  it("requires every bin to carry its break-even count, so a consumer mapping the domain's bins cannot drop it", () => {
    // @ts-expect-error `breakEven` is required: without it a 0R bin of winners could only be drawn neutral.
    const dropped: HistogramBin = { label: "0.0R to +0.5R", from: "0", to: "0.5", count: 2 };
    // At run time a bin without a readable count is still never drawn as profit.
    expect(binSign(dropped)).toBe("neutral");
  });

  it("draws the domain's 0R bin as profit when it holds only winners, and neutral once it holds a break-even trade", () => {
    const tones = (trades: PerformanceTrade[]) => {
      // As a screen passes them on: the domain's bins with a drill-down link each.
      const bins: HistogramBin[] = distributionR(trades).bins.map((bin) => ({ ...bin, href: `/journal?rFrom=${bin.from}` }));
      const markup = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins, formatEdge: formatTickR }));
      return { markup, signs: [...markup.matchAll(/class="chart-bar" data-sign="(\w+)"/g)].map((match) => match[1]) };
    };
    const winners = [ledger("a", "0.25"), ledger("b", "0.3"), ledger("c", "-0.4"), ledger("d", "1.2")];
    const onlyWinners = tones(winners);
    // −0.5R to 0R, 0R to +0.5R (two winners), +0.5R to +1R (empty), +1R to +1.5R.
    expect(onlyWinners.signs).toEqual(["neg", "pos", "zero", "pos"]);
    expect(onlyWinners.markup).toContain('aria-label="0.0R to +0.5R: Trades 2"');
    const withBreakEven = tones([...winners, ledger("e", "0")]);
    expect(withBreakEven.signs).toEqual(["neg", "neutral", "zero", "pos"]);
    expect(withBreakEven.markup).toContain('aria-label="0.0R to +0.5R: Trades 3 (1 at 0R)"');
  });

  it("names the break-even trades in the chart, its table and the accessible names", () => {
    const bins: HistogramBin[] = [
      { label: "-0.5R to 0.0R", from: "-0.5", to: "0", count: 1, breakEven: 0 },
      { label: "0.0R to +0.5R", from: "0", to: "0.5", count: 3, breakEven: 2 },
      { label: "+0.5R to +1.0R", from: "0.5", to: "1", count: 1, breakEven: 0 },
    ];
    expect(binCountText(bins[1])).toBe("3 (2 at 0R)");
    expect(binCountText({ count: 3, breakEven: 2, countLabel: "3 trades · 2 break-even (0R)" })).toBe("3 trades · 2 break-even (0R)");
    const markup = renderToStaticMarkup(createElement(Histogram, { title: "R distribution", question: "How are outcomes distributed?", bins, formatEdge: formatTickR }));
    finite(markup);
    expect(markup.match(/class="chart-bar" data-sign="neutral"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="0.0R to +0.5R: Trades 3 (2 at 0R)"');
    expect(markup).toMatch(/<td[^>]*>3 \(2 at 0R\)<\/td>/);
    // The text summary counts the bin in the same words.
    expect(markup).toContain(">R distribution: 5 outcomes in 3 bins; most frequent 0.0R to +0.5R: 3 (2 at 0R).</span>");
  });
});
