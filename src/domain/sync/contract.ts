import type { Lifecycle, TradeOrigin } from "../ledger";

/**
 * Execution sync contract (spec §8.6). Connections are read-only by construction: a provider can
 * only report executions; Trading OS never requests trading permission. V2 ships the mock
 * provider only.
 */

export type SyncProviderId = "CTRADER" | "MT5" | "MOCK";
export type Direction = "LONG" | "SHORT";

export interface ExecutionSyncProvider {
  readonly id: SyncProviderId;
  /** Capability flag; `runSync` refuses any provider that is not read-only. */
  readonly readOnly: true;
  /**
   * Positions opened or closed after `since` (exclusive), oldest first is not required.
   * Results are untrusted provider data and are validated by `normalizeExternalPosition`.
   */
  fetchPositions(since: string | null): Promise<readonly unknown[]>;
}

/** A provider position after validation: canonical decimals, normalised symbol, microsecond-exact instants. */
export interface ExternalPosition {
  externalId: string;
  symbol: string;
  direction: Direction;
  volume: string;
  entryPrice: string;
  /** Canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  enteredAt: string;
  exitPrice: string | null;
  exitedAt: string | null;
  commission: string | null;
  swap: string | null;
  realizedPnl: string | null;
  currency: string;
  /** sha256 (hex) of the canonical position; identical payloads are a no-op on ingest. */
  payloadHash: string;
}

export interface SyncConnection {
  id: string;
  accountId: string;
  accountCurrency: string;
  provider: SyncProviderId;
  /** Latest provider time already ingested; null before the first sync. */
  syncedThrough: string | null;
}

/** A trade the store offers for automatic linking. */
export interface SyncCandidate {
  tradeId: string;
  accountId: string;
  origin: TradeOrigin;
  lifecycle: Lifecycle;
  /** Already linked to an external execution. */
  linked: boolean;
  symbol: string | null;
  direction: Direction | null;
  lockedAt: string | null;
  plannedEntry: string | null;
  plannedStop: string | null;
  tickSize: string | null;
}

export type MatchResult =
  | { kind: "UNIQUE"; tradeId: string }
  | { kind: "AMBIGUOUS"; tradeIds: string[] }
  | { kind: "NONE" };

/** Mirrors `ingest_external_execution(p_decision)`. */
export type IngestDecision =
  | { kind: "CREATE" }
  | { kind: "LINK"; tradeId: string }
  | { kind: "HOLD" };

/**
 * Store outcome: CREATED an imported trade, LINKED to a planned trade, HELD unlinked (ambiguous),
 * UNCHANGED (identical payload already stored), CLOSED (a stored open position is now closed with
 * the same identity — symbol, direction, volume, entry price and time: the close was appended, and an
 * imported trade created from it was closed) or CHANGED (any other different payload for a stored
 * id was recorded as a warning and never overwrote the original).
 */
export type IngestOutcome = "CREATED" | "LINKED" | "HELD" | "UNCHANGED" | "CLOSED" | "CHANGED";

export interface SyncStore {
  listCandidates(position: ExternalPosition): Promise<readonly SyncCandidate[]>;
  /** Throws `IngestRefused` when the account takes no new position for now; any other error stops the run. */
  ingest(position: ExternalPosition, decision: IngestDecision): Promise<IngestOutcome>;
}

/** Why a store refused one position while the rest of the batch stays valid. */
export type IngestRefusal = "ACCOUNT_ARCHIVED";

/**
 * A store's refusal of one new position that the account cannot take now (an archived account takes no new imported
 * trade). Nothing of that position was stored. `runSync` reports it in `deferred`, keeps ingesting the other positions
 * (closes of positions already imported, links, holds) and keeps `syncedThrough`, so the next sync after a restore
 * fetches the position again.
 */
export class IngestRefused extends Error {
  constructor(readonly refusal: IngestRefusal) {
    super(refusal);
    this.name = "IngestRefused";
  }
}

export interface SyncDecisionRecord {
  externalId: string;
  decision: IngestDecision;
  outcome: IngestOutcome;
}

export interface SyncRejection {
  externalId: string | null;
  reason: string;
}

export interface SyncReport {
  connectionId: string;
  status: "SYNCED" | "ERROR";
  /** Human message without secrets (≤ 300 characters). */
  message: string;
  fetched: number;
  created: number;
  linked: number;
  held: number;
  unchanged: number;
  /** Platform closes appended to stored open positions. */
  closed: number;
  /** Conflicting payloads for stored ids, recorded as warnings only. */
  changed: number;
  /** Identical repeats of a position within one fetch. */
  duplicates: number;
  rejected: SyncRejection[];
  /** New positions the account refused for now (it is archived); fetched again by the next sync. */
  deferred: SyncRejection[];
  decisions: SyncDecisionRecord[];
  /** Advances only when the whole batch was processed and nothing was deferred. */
  syncedThrough: string | null;
}
