import { z } from "zod";
import { compareInstants } from "@/domain/time-display";

/**
 * How a live position has been managed so far (docs/V2_ARCHITECTURE.md §3.6, §14.1): its newest stop move and its
 * partial closes, read from the trade's journal entries. Partial closes are journal records, not accounting events
 * (§3.6), and a moved stop never changes the R basis, so these only describe the position; they never recompute risk.
 * Pure: the loader reads the rows, the view model formats them.
 */

export const MANAGEMENT_KINDS = ["STOP_CHANGE", "PARTIAL_CLOSE"] as const;

export const managementRow = z.object({
  id: z.uuid(),
  trade_id: z.uuid(),
  kind: z.enum(MANAGEMENT_KINDS),
  details: z.record(z.string(), z.unknown()),
  recorded_at: z.string(),
});
export type ManagementRow = z.output<typeof managementRow>;

export interface StopMove {
  /** Exact decimal text. */
  price: string;
  recordedAt: string;
}

export interface PartialClose {
  percent: string | null;
  quantity: string | null;
  price: string | null;
  recordedAt: string;
}

export interface LiveManagement {
  /** The newest stop move with a price, or null when the journal records none. */
  stop: StopMove | null;
  /** Partial closes, newest first. */
  partials: PartialClose[];
}

/** Positive decimal text as the journal stores it (§3.6), else null. */
const DECIMAL = /^\d+(\.\d+)?$/;
function decimalOf(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

/** Newest first: recorded time (microsecond-exact), then id, as the journal orders its entries. */
function newestFirst(a: ManagementRow, b: ManagementRow): number {
  return compareInstants(b.recorded_at, a.recorded_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** The management of each trade that has any. */
export function summarizeManagement(rows: readonly ManagementRow[]): Map<string, LiveManagement> {
  const result = new Map<string, LiveManagement>();
  for (const row of [...rows].sort(newestFirst)) {
    const entry = result.get(row.trade_id) ?? { stop: null, partials: [] };
    if (row.kind === "STOP_CHANGE") {
      const price = decimalOf(row.details.price);
      if (price !== null && entry.stop === null) entry.stop = { price, recordedAt: row.recorded_at };
    } else {
      entry.partials.push({
        percent: decimalOf(row.details.percent), quantity: decimalOf(row.details.quantity), price: decimalOf(row.details.price), recordedAt: row.recorded_at,
      });
    }
    result.set(row.trade_id, entry);
  }
  return result;
}
