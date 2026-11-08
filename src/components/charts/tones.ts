import type { SeriesTone } from "./types";

const toneClass: Record<SeriesTone, string> = {
  "series-1": "chart-series-1",
  "series-2": "chart-series-2",
  "series-3": "chart-series-3",
  pos: "chart-series-pos",
  neg: "chart-series-neg",
};

/** CSS class that sets `--series-color` for marks, keys and dots of a series. */
export function seriesClass(tone: SeriesTone) {
  return toneClass[tone];
}

/** Fixed categorical order (never cycled): a fourth series would not be distinguishable (§13.1). */
export const SERIES_ORDER: SeriesTone[] = ["series-1", "series-2", "series-3"];
