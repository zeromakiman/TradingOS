import Decimal from "decimal.js";
import { instantMicros } from "../time-display";
import type { ExternalPosition, MatchResult, SyncCandidate } from "./contract";
import { normalizeSymbol } from "./normalize";

/**
 * Deterministic automatic matching (spec §8.6). A candidate qualifies only when it is a planned
 * trade of the same account, symbol and direction, LOCKED or LIVE, not yet linked, locked before
 * the external entry, entered at most 30 minutes after the lock, and filled within
 * max(20 ticks, 25% of the planned stop distance) of the planned entry. Exactly one qualifying
 * candidate links automatically; several stay unlinked for the user to confirm.
 */

export const MATCH_WINDOW_MINUTES = 30;
export const MATCH_MIN_TICKS = 20;
export const MATCH_STOP_FRACTION = "0.25";

const WINDOW_MICROS = BigInt(MATCH_WINDOW_MINUTES) * 60_000_000n;

export type MatchablePosition = Pick<ExternalPosition, "symbol" | "direction" | "entryPrice" | "enteredAt"> & { accountId: string };

function qualifies(position: MatchablePosition, candidate: SyncCandidate, entered: bigint): boolean {
  if (candidate.accountId !== position.accountId || candidate.origin !== "PLANNED" || candidate.linked) return false;
  if (candidate.lifecycle !== "LOCKED" && candidate.lifecycle !== "LIVE") return false;
  if (candidate.symbol === null || normalizeSymbol(candidate.symbol) !== position.symbol || candidate.direction !== position.direction) return false;
  if (candidate.lockedAt === null || candidate.plannedEntry === null || candidate.plannedStop === null || candidate.tickSize === null) return false;
  const elapsed = entered - instantMicros(candidate.lockedAt);
  if (elapsed <= 0n || elapsed > WINDOW_MICROS) return false;
  const plannedEntry = new Decimal(candidate.plannedEntry);
  const tolerance = Decimal.max(new Decimal(candidate.tickSize).mul(MATCH_MIN_TICKS), plannedEntry.minus(candidate.plannedStop).abs().mul(MATCH_STOP_FRACTION));
  return new Decimal(position.entryPrice).minus(plannedEntry).abs().lte(tolerance);
}

export function matchExecution(position: MatchablePosition, candidates: readonly SyncCandidate[]): MatchResult {
  const entered = instantMicros(position.enteredAt);
  const tradeIds = [...new Set(candidates.filter(candidate => qualifies(position, candidate, entered)).map(candidate => candidate.tradeId))].sort();
  if (tradeIds.length === 1) return { kind: "UNIQUE", tradeId: tradeIds[0] };
  return tradeIds.length > 1 ? { kind: "AMBIGUOUS", tradeIds } : { kind: "NONE" };
}
