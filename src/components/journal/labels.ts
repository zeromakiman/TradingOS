import type { EntryModel, Lifecycle, TradeOrigin } from "@/domain/ledger";
import type { TradeTone } from "@/domain/trade-state";
import type { StatusTone } from "@/components/ui/badge";

export { SESSION_LABELS } from "@/components/shell/session-labels";

/**
 * Trader wording of every value the Journal filters and rows show (docs/V2_ARCHITECTURE.md §2.3, §15). Raw enums never
 * reach the default UI; these maps are the only place they are translated.
 */

export const RESULT_LABELS = { WIN: "Win", LOSS: "Loss", BREAKEVEN: "Break-even", OPEN: "Open (live)" } as const;

export const STATE_LABELS: Record<Lifecycle, string> = {
  DRAFT: "Draft",
  LOCKED: "Locked",
  LIVE: "Live",
  CLOSED: "Closed · review pending",
  REVIEWED: "Reviewed",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
  DISCARDED: "Discarded",
};

/** Short state names for the filter pill ("State: Closed, Reviewed"). */
export const STATE_SHORT_LABELS: Record<Lifecycle, string> = {
  DRAFT: "Draft",
  LOCKED: "Locked",
  LIVE: "Live",
  CLOSED: "Closed",
  REVIEWED: "Reviewed",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
  DISCARDED: "Discarded",
};

export const ORIGIN_LABELS: Record<TradeOrigin, string> = { PLANNED: "Planned", LIVE_FIRST: "Live-first", IMPORTED: "Imported" };

export const MODEL_LABELS: Record<EntryModel, string> = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other model" };

export const DIRECTION_LABELS = { LONG: "Long", SHORT: "Short" } as const;

/** Trade tone → pill tone (the trade vocabulary of §2.3 uses `danger` for Blocked). */
export function pillTone(tone: TradeTone): StatusTone {
  return tone;
}

/** What the trade-date instant of a row is ("Entered 09:42"). */
export function dateSourceVerb(source: "ENTRY" | "LOCK" | "CREATED", origin: TradeOrigin): string {
  if (source === "ENTRY") return "Entered";
  if (source === "LOCK") return "Locked";
  return origin === "PLANNED" ? "Drafted" : "Recorded";
}

/** Names of URL filters in words, for the notice about a link with unreadable filters. */
export const FILTER_PARAM_NAMES: Record<string, string> = {
  from: "start date",
  to: "end date",
  closedFrom: "closed-from date",
  closedTo: "closed-to date",
  result: "result",
  state: "state",
  origin: "origin",
  model: "model",
  session: "session",
  weekday: "weekday",
  direction: "direction",
  reviewed: "review status",
  ai: "AI review",
  tag: "tag",
  instrument: "instrument",
  risk: "planned risk",
  strategy: "strategy version",
  riskPlan: "risk plan version",
  rFrom: "R range",
  rTo: "R range",
  accountFilter: "trading account",
};
