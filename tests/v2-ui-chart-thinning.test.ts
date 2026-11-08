import Decimal from "decimal.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DrawdownChart, LineChart } from "@/components/charts/line-chart";
import { pointPositions, toDecimal } from "@/components/charts/scale";
import { decimatePath, deepestFall, everyNth, MARK_LIMIT, markedPositions, markStride, PATH_BUCKETS } from "@/components/charts/thinning";
import type { ChartDatum } from "@/components/charts/types";
import { formatR } from "@/domain/format";

// Long line charts (docs/V2_ARCHITECTURE.md §13): an account with thousands of closed trades must not put a mark, a
// tooltip, a link and a table row per trade into the page. Above MARK_LIMIT points only the marked points keep them, and
// the drawn line keeps every bucket's extremes; up to MARK_LIMIT points nothing changes.

const point = (position: number, value: string): ChartDatum => ({
  key: `t${position}`,
  label: `Trade ${position}`,
  value,
  valueLabel: `${value}R`,
  href: `/trades/t${position}`,
  detail: `Trade ${position} detail`,
});

/**
 * Cumulative R over `count` points: +0.1R a trade, one fall of 10R a trade after `fallFrom` (the peak) down to `trough`
 * (the deepest drawdown, below zero, so also the lowest point), then +0.1R a trade again. Exact decimal strings.
 */
function cumulative(count: number, fallFrom: number, trough: number): string[] {
  const values: string[] = [];
  let value = new Decimal(0);
  for (let position = 0; position < count; position++) {
    if (position > 0) value = value.plus(position > fallFrom && position <= trough ? "-10" : "0.1");
    values.push(value.toFixed());
  }
  return values;
}

const lineChart = (values: string[]) =>
  renderToStaticMarkup(createElement(LineChart, { title: "Cumulative R", question: "Is the process compounding?", series: [{ id: "r", name: "Cumulative R", points: values.map((value, position) => point(position, value)) }] }));

/** Every chart mark (`data-mark`) with its accessible name and link, in document order. */
function marks(markup: string): { mark: number; label: string; href: string | null; tabIndex: string | null }[] {
  return [...markup.matchAll(/<(?:a|button)\b[^>]*\bdata-mark="(\d+)"[^>]*>/g)].map((match) => ({
    mark: Number(match[1]),
    label: /aria-label="([^"]*)"/.exec(match[0])?.[1] ?? "",
    href: /href="([^"]*)"/.exec(match[0])?.[1] ?? null,
    tabIndex: /tabindex="([^"]*)"/i.exec(match[0])?.[1] ?? null,
  }));
}

const tradeOf = (label: string) => Number(/^Trade (\d+):/.exec(label)?.[1] ?? Number.NaN);

/** Vertices of an SVG path made of M/L commands (closing area segments included). */
function vertices(d: string): { x: number; y: number }[] {
  return [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

const pathOf = (markup: string, className: string) => new RegExp(`<path class="${className}[^"]*" d="([^"]+)"`).exec(markup)?.[1] ?? "";

const bodyRows = (markup: string) => /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(markup)?.[1].match(/<tr[ >]/g)?.length ?? 0;

/** The positions a thinned chart of `count` points marks: the last of each run, the first point and `extra`. */
function expectedMarks(count: number, ...extra: number[]): number[] {
  const stride = Math.ceil(count / MARK_LIMIT);
  const ends = Array.from({ length: Math.ceil(count / stride) }, (_, run) => Math.min(count - 1, run * stride + stride - 1));
  return [...new Set([0, ...ends, ...extra])].sort((a, b) => a - b);
}

describe("Marking rule (thinning.ts)", () => {
  it("keeps one point per run of ceil(count / 300), the last of each run, plus the first, the last and the kept positions", () => {
    expect(markStride(300)).toBe(1);
    expect(markStride(301)).toBe(2);
    expect(markStride(19_901)).toBe(67);
    const positions = markedPositions(1000, [501, null, 5000, -1]);
    expect(positions).toEqual(expectedMarks(1000, 501));
    expect(positions[0]).toBe(0);
    expect(positions.at(-1)).toBe(999);
    expect(positions).toContain(501);
    // One mark per run of four: positions 3, 7, 11, … and no other position of a run (except the kept ones).
    expect(positions.filter((position) => position % 4 === 3)).toHaveLength(250);
    expect(positions.filter((position) => position % 4 !== 3)).toEqual([0, 501]);
    // A partial last run still ends at the last point.
    expect(markedPositions(1001).at(-1)).toBe(1000);
    expect(markedPositions(1001)).toHaveLength(1 + 251);
  });

  it("marks every position up to 300 points", () => {
    expect(markedPositions(300, [7])).toEqual(Array.from({ length: 300 }, (_, position) => position));
    expect(markedPositions(0)).toEqual([]);
  });

  it("finds the trough of the largest fall below a running peak, exactly, skipping missing values", () => {
    const values = (...list: (string | null)[]) => list.map((value) => toDecimal(value));
    expect(deepestFall(values("0", "2", "1", "3", "0.5", "4", "3.9"))).toBe(4);
    expect(deepestFall(values("0", "1", null, "-1", "5"))).toBe(3);
    expect(deepestFall(values("0", "1", "2"))).toBeNull();
    expect(deepestFall(values())).toBeNull();
    // Exact comparison: a fall of 0.3 beats one of 0.29999999999999999 that floating point would tie.
    expect(deepestFall(values("1", "0.70000000000000001", "2", "1.7"))).toBe(3);
  });

  it("says in plain words which points are listed", () => {
    expect(everyNth(19_901)).toBe("Every 67th of 19,901 points");
    expect(everyNth(301)).toBe("Every 2nd of 301 points");
    expect(everyNth(1201)).toBe("Every 5th of 1,201 points");
    expect(everyNth(6301)).toBe("Every 22nd of 6,301 points");
    expect(everyNth(3300)).toBe("Every 11th of 3,300 points");
  });
});

describe("Path decimation (thinning.ts)", () => {
  it("keeps the first, last, lowest and highest point of every x-bucket, in order", () => {
    const count = 20_000;
    const xs = pointPositions(count);
    // A deterministic zig-zag with spikes, so every bucket has interior extremes.
    const points = xs.map((x, position) => ({ x, y: 50 + 30 * Math.sin(position / 7) + (position % 97 === 0 ? 15 : 0) - (position % 89 === 0 ? 15 : 0), position }));
    const kept = decimatePath(points);
    expect(kept.length).toBeLessThanOrEqual(PATH_BUCKETS * 4);
    expect(kept.length).toBeLessThan(count);
    // Original order, no duplicates.
    expect(kept.map((entry) => entry.position)).toEqual([...new Set(kept.map((entry) => entry.position))].sort((a, b) => a - b));
    const bucketOf = (x: number) => Math.min(PATH_BUCKETS - 1, Math.floor((x / 100) * PATH_BUCKETS));
    const buckets = new Map<number, typeof points>();
    for (const entry of points) buckets.set(bucketOf(entry.x), [...(buckets.get(bucketOf(entry.x)) ?? []), entry]);
    const keptPositions = new Set(kept.map((entry) => entry.position));
    for (const members of buckets.values()) {
      const ys = members.map((entry) => entry.y);
      const inBucket = members.filter((entry) => keptPositions.has(entry.position));
      expect(inBucket.length).toBeLessThanOrEqual(4);
      expect(keptPositions.has(members[0].position) && keptPositions.has(members.at(-1)?.position ?? -1)).toBe(true);
      expect(inBucket.some((entry) => entry.y === Math.min(...ys))).toBe(true);
      expect(inBucket.some((entry) => entry.y === Math.max(...ys))).toBe(true);
    }
    // The global extremes are always drawn.
    const ys = points.map((entry) => entry.y);
    expect(Math.min(...kept.map((entry) => entry.y))).toBe(Math.min(...ys));
    expect(Math.max(...kept.map((entry) => entry.y))).toBe(Math.max(...ys));
  });

  it("returns a run with at most one point per bucket unchanged", () => {
    const points = pointPositions(PATH_BUCKETS).map((x, position) => ({ x, y: position % 3 }));
    expect(decimatePath(points)).toEqual(points);
    expect(decimatePath([])).toEqual([]);
  });
});

describe("LineChart above 300 points", () => {
  const COUNT = 6000; // stride 20
  const PEAK = 2950; // 295R
  const TROUGH = 3001; // -215R, not the last of a run (3001 % 20 = 1)
  const values = cumulative(COUNT, PEAK, TROUGH);
  const markup = lineChart(values);
  const listed = marks(markup);
  const expected = expectedMarks(COUNT, TROUGH);

  it("keeps a mark only for the marked points: one per run, the first, the last and the deepest drawdown", () => {
    expect(listed).toHaveLength(expected.length);
    expect(listed.length).toBeLessThanOrEqual(MARK_LIMIT + 2);
    expect(listed.map((entry) => entry.mark)).toEqual(expected.map((_, mark) => mark));
    expect(listed.map((entry) => tradeOf(entry.label))).toEqual(expected);
    expect(listed[0].label).toBe("Trade 0: 0R. Trade 0 detail");
    expect(listed.at(-1)?.label).toBe(`Trade ${COUNT - 1}: ${values[COUNT - 1]}R. Trade ${COUNT - 1} detail`);
    expect(listed.some((entry) => entry.label === `Trade ${TROUGH}: ${values[TROUGH]}R. Trade ${TROUGH} detail`)).toBe(true);
    // Only the last mark is in the tab order; the arrow keys reach the rest.
    expect(listed.filter((entry) => entry.tabIndex === "0").map((entry) => tradeOf(entry.label))).toEqual([COUNT - 1]);
    expect(markup).toContain('aria-label="Cumulative R: every 20th of 6,000 points. Use the arrow keys to move between them."');
  });

  it("links each mark (data-mark = index in the marked list) to the trade at its real position", () => {
    for (const entry of listed) expect(entry.href).toBe(`/trades/t${expected[entry.mark]}`);
    // The accessible name (the tooltip's words) and the link name the same point.
    for (const entry of listed) expect(entry.href).toBe(`/trades/t${tradeOf(entry.label)}`);
  });

  it("draws a min/max-decimated line and area that still reach the deepest drawdown and the high", () => {
    const line = vertices(pathOf(markup, "chart-line"));
    expect(line.length).toBeLessThanOrEqual(PATH_BUCKETS * 4);
    expect(line.length).toBeLessThan(COUNT / 2);
    const xs = pointPositions(COUNT);
    const view = (percent: number) => Number((Math.round(percent * 10 * 100) / 100).toFixed(2));
    // The lowest drawn vertex (largest y) is the trough of the deepest drawdown, the highest its peak: the fall is drawn
    // at full depth however many points share a pixel column.
    const lowest = line.reduce((best, vertex) => (vertex.y > best.y ? vertex : best));
    const highest = line.reduce((best, vertex) => (vertex.y < best.y ? vertex : best));
    expect(lowest.x).toBe(view(xs[TROUGH]));
    expect(highest.x).toBe(view(xs[PEAK]));
    expect(line[0].x).toBe(0);
    expect(line.at(-1)?.x).toBe(1000);
    const area = vertices(pathOf(markup, "chart-area"));
    expect(area.length).toBe(line.length + 2);
  });

  it("lists only the marked rows in its table, under a visible caption that says which and where every trade is", () => {
    expect(bodyRows(markup)).toBe(expected.length);
    const caption = /<caption class="([^"]*)">([\s\S]*?)<\/caption>/.exec(markup);
    expect(caption?.[1]).toBe("ui-table-caption");
    expect(caption?.[2]).toContain('<span class="sr-only">Cumulative R. </span>');
    expect(caption?.[2]).toContain("Every 20th of 6,000 points, with the first point and the deepest drawdown. The Journal lists every trade.");
    const rowLinks = [.../<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(markup)?.[1].matchAll(/href="\/trades\/t(\d+)"/g) ?? []].map((match) => Number(match[1]));
    expect(rowLinks).toEqual(expected);
    // The text summary still covers every point.
    expect(markup).toContain(`Cumulative R: ${COUNT} points from Trade 0 to Trade ${COUNT - 1}.`);
  });

  it("thins from 301 points and names the deepest drawdown only when there is one", () => {
    const rising = lineChart(Array.from({ length: 301 }, (_, position) => String(position)));
    expect(marks(rising)).toHaveLength(expectedMarks(301).length);
    expect(rising).toContain("Every 2nd of 301 points, with the first point. The Journal lists every trade.");
  });

  it("thins a drawdown chart the same way and keeps its deepest point marked and labelled", () => {
    let peak = new Decimal(0);
    const drawdown = values.map((value, position) => {
      peak = Decimal.max(peak, value);
      return { key: `t${position}`, label: `Trade ${position}`, value: peak.minus(value).toFixed(), href: `/trades/t${position}` };
    });
    const chart = renderToStaticMarkup(createElement(DrawdownChart, { title: "R drawdown", question: "Where am I giving profits back?", points: drawdown }));
    const drawn = marks(chart);
    expect(drawn.map((entry) => tradeOf(entry.label))).toEqual(expected);
    expect(drawn.find((entry) => tradeOf(entry.label) === TROUGH)?.label).toBe(`Trade ${TROUGH}: ${formatR("-510")}`);
    expect(chart).toMatch(/class="chart-direct-label"[^>]*>-510\.00R</);
    expect(vertices(pathOf(chart, "chart-line")).length).toBeLessThanOrEqual(PATH_BUCKETS * 4);
    expect(bodyRows(chart)).toBe(expected.length);
  });
});

describe("LineChart up to 300 points (unchanged)", () => {
  it("keeps a mark, a link, a vertex and a table row for every point, and the caption stays the hidden title", () => {
    const values = cumulative(300, 100, 140);
    const markup = lineChart(values);
    const listed = marks(markup);
    expect(listed.map((entry) => entry.mark)).toEqual(Array.from({ length: 300 }, (_, position) => position));
    expect(listed.map((entry) => entry.href)).toEqual(Array.from({ length: 300 }, (_, position) => `/trades/t${position}`));
    expect(vertices(pathOf(markup, "chart-line"))).toHaveLength(300);
    expect(bodyRows(markup)).toBe(300);
    expect(markup).toContain('<caption class="ui-table-caption sr-only">Cumulative R</caption>');
    expect(markup).toContain('aria-label="Cumulative R: data points. Use the arrow keys to move between them."');
    expect(markup).not.toContain("Every ");
  });
});
