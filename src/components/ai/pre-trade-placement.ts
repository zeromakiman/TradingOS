/**
 * Where the trade page shows pre-trade AI (docs/V2_ARCHITECTURE.md §8.3, §11.1, §14.4). Pure.
 *
 * - An open draft of an active account gets the tools (Analyze setup, Challenge my bias) inside its Plan section.
 * - A draft of an archived account takes no new analysis (§3.2, §9), but its earlier analyses stay readable there.
 * - Once the trade is no longer a draft (locked, live, closed, reviewed, skipped, cancelled or discarded), its
 *   analyses stay readable in full in a section of their own after the Plan: the invalidation points, weaknesses and
 *   counter-arguments matter most while the position is live and at review (V1 kept them after lock as well).
 *
 * Read-only placements are used only for a trade that has pre-trade requests, so a trade without any shows no empty
 * section and no loading placeholder.
 */

export interface PreTradePlacementInput {
  origin: string;
  lifecycle: string;
  /** The trade has an open draft revision (`TradeDetail.draft`). */
  hasDraft: boolean;
  accountArchived: boolean;
  /** Pre-trade requests in the trade's AI history (any status), or null when that history could not be read. */
  requests: number | null;
  /** Completed pre-trade analyses (the trade's AI activity read model). */
  completed: number;
}

export interface PreTradePlacement {
  /** "plan": inside the draft's Plan section. "section": a section of its own after the Plan. */
  frame: "plan" | "section";
  /** New requests can be made from here. */
  tools: boolean;
}

export function preTradePlacement(input: PreTradePlacementInput): PreTradePlacement | null {
  // Live-first and imported trades have no plan, so they never get pre-trade AI (§8.3).
  if (input.origin !== "PLANNED") return null;
  const hasAnalyses = (input.requests ?? 0) > 0 || input.completed > 0;
  if (input.lifecycle === "DRAFT") {
    if (!input.hasDraft) return null;
    if (!input.accountArchived) return { frame: "plan", tools: true };
    return hasAnalyses ? { frame: "plan", tools: false } : null;
  }
  return hasAnalyses ? { frame: "section", tools: false } : null;
}
