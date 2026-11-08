import type { CalendarMode } from "@/domain/performance";

/**
 * EDGE URL parameters (docs/V2_ARCHITECTURE.md §14.6), shared by the server page and the client filter row and
 * calendar. Dimension names match the Journal's (`model`, `session`, `origin`, `instrument`, `closedFrom`,
 * `closedTo`, and `weekday`, `strategy`, `riskPlan`, `result` for the filters a link carries), so drill-down links carry
 * the same filters. Defaults (All time, Net R) are left out of URLs.
 */

export const EDGE_PATH = "/edge";

export const RANGE_PRESETS = ["all", "30d", "90d", "month", "last-month", "ytd", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  all: "All time",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  "last-month": "Last month",
  ytd: "Year to date",
  custom: "Custom range",
};

/** Calendar mode in the URL (`view`). */
export const CALENDAR_VIEW_PARAM: Record<CalendarMode, string> = { NET_R: "r", NET_PNL: "pnl", GROSS_LOSS: "loss", COUNT: "count" };

export interface EdgeUrlState {
  range: RangePreset;
  closedFrom?: string;
  closedTo?: string;
  model?: string;
  session?: string;
  origin?: string;
  instrument?: string;
  /**
   * Filters a link carries that the filter row has no control for (query.ts `linkFilterChips` names them): every link
   * of the page keeps them, and only their own chips remove them. Written with the Journal's parameter names.
   */
  weekday?: string;
  strategyVersionId?: string;
  riskPlanVersionId?: string;
  result?: string;
  /**
   * Read-only account filter of All Accounts (an account id, never shown; query.ts `accountFilterChip` names it): every
   * link of the page keeps it, and only its own chip removes it.
   */
  accountFilter?: string;
  /** Calendar month (`YYYY-MM`). */
  month?: string;
  calendar: CalendarMode;
  /** Currency of the money calendar modes. */
  currency?: string;
}

/** Search parameters of a state in a stable order; custom bounds only with the custom range. */
export function edgeParams(state: EdgeUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range !== "all") params.set("range", state.range);
  if (state.range === "custom") {
    if (state.closedFrom) params.set("closedFrom", state.closedFrom);
    if (state.closedTo) params.set("closedTo", state.closedTo);
  }
  if (state.model) params.set("model", state.model);
  if (state.session) params.set("session", state.session);
  if (state.origin) params.set("origin", state.origin.toLowerCase().replace(/_/g, "-"));
  if (state.instrument) params.set("instrument", state.instrument);
  if (state.weekday) params.set("weekday", state.weekday);
  if (state.strategyVersionId) params.set("strategy", state.strategyVersionId);
  if (state.riskPlanVersionId) params.set("riskPlan", state.riskPlanVersionId);
  if (state.result) params.set("result", state.result.toLowerCase());
  if (state.accountFilter) params.set("accountFilter", state.accountFilter);
  if (state.month) params.set("month", state.month);
  if (state.calendar !== "NET_R") params.set("view", CALENDAR_VIEW_PARAM[state.calendar]);
  if (state.currency) params.set("currency", state.currency);
  return params;
}

/** `/edge?…` for a state. */
export function edgeHref(state: EdgeUrlState): string {
  const text = edgeParams(state).toString();
  return text ? `${EDGE_PATH}?${text}` : EDGE_PATH;
}

/** `/edge?…` from filter parameters plus extra calendar parameters (the calendar's month and mode links). */
export function withParams(baseQuery: string, extra: Record<string, string | undefined>): string {
  const params = new URLSearchParams(baseQuery);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  const text = params.toString();
  return text ? `${EDGE_PATH}?${text}` : EDGE_PATH;
}
