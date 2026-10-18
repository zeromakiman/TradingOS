import { compareInstants, type Instant, instantMicros } from "../time-display";
import type { ExecutionSyncProvider, ExternalPosition, IngestDecision, IngestOutcome, MatchResult, SyncConnection, SyncReport, SyncStore } from "./contract";
import { matchExecution } from "./match";
import { instantFromMicros, normalizeExternalPosition } from "./normalize";

/**
 * Sync orchestration: fetch → validate → de-duplicate → match → ingest, in a deterministic
 * order (entry time, then external id). Ingest is idempotent on the server, so a failed run
 * can simply be repeated; `syncedThrough` only advances after a complete batch.
 */

const MESSAGES = {
  notReadOnly: "Only read-only platform connections are supported. Nothing was imported.",
  providerMismatch: "This platform does not match the connection. Nothing was imported.",
  fetchFailed: "The platform did not return positions. Nothing was imported.",
  storeFailed: "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue.",
  conflict: "The platform reported conflicting data for the same position in one sync; the first version was kept.",
  currency: "The position currency does not match the trading account.",
} as const;

export function decisionFor(match: MatchResult): IngestDecision {
  if (match.kind === "UNIQUE") return { kind: "LINK", tradeId: match.tradeId };
  return match.kind === "AMBIGUOUS" ? { kind: "HOLD" } : { kind: "CREATE" };
}

function emptyReport(connection: SyncConnection, status: SyncReport["status"], message: string): SyncReport {
  return {
    connectionId: connection.id, status, message, fetched: 0, created: 0, linked: 0, held: 0, unchanged: 0, closed: 0, changed: 0,
    duplicates: 0, rejected: [], decisions: [], syncedThrough: connection.syncedThrough,
  };
}

function summary(report: SyncReport): string {
  const parts = [`${report.created} imported`, `${report.linked} linked`, `${report.held} awaiting your confirmation`];
  if (report.closed) parts.push(`${report.closed} closed`);
  if (report.rejected.length) parts.push(`${report.rejected.length} rejected`);
  return `Sync complete: ${parts.join(", ")}.`;
}

function countOutcome(report: SyncReport, outcome: IngestOutcome): void {
  switch (outcome) {
    case "CREATED": report.created += 1; break;
    case "LINKED": report.linked += 1; break;
    case "HELD": report.held += 1; break;
    case "UNCHANGED": report.unchanged += 1; break;
    case "CLOSED": report.closed += 1; break;
    case "CHANGED": report.changed += 1; break;
  }
}

function byEntryThenId(a: ExternalPosition, b: ExternalPosition): number {
  return compareInstants(a.enteredAt, b.enteredAt) || (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0);
}

export async function runSync(connection: SyncConnection, provider: ExecutionSyncProvider, store: SyncStore, options: { now?: Instant } = {}): Promise<SyncReport> {
  if ((provider as { readOnly: unknown }).readOnly !== true) return emptyReport(connection, "ERROR", MESSAGES.notReadOnly);
  if (provider.id !== connection.provider) return emptyReport(connection, "ERROR", MESSAGES.providerMismatch);

  let raw: readonly unknown[];
  try {
    raw = await provider.fetchPositions(connection.syncedThrough);
  } catch {
    return emptyReport(connection, "ERROR", MESSAGES.fetchFailed);
  }
  if (!Array.isArray(raw)) return emptyReport(connection, "ERROR", MESSAGES.fetchFailed);

  const report = emptyReport(connection, "SYNCED", "");
  report.fetched = raw.length;

  // Validate, then keep one version per external id; the choice is independent of input order.
  const byId = new Map<string, ExternalPosition[]>();
  for (const item of raw) {
    const result = normalizeExternalPosition(item, options);
    if (!result.ok) {
      report.rejected.push({ externalId: result.externalId, reason: result.error });
    } else if (result.position.currency !== connection.accountCurrency) {
      report.rejected.push({ externalId: result.position.externalId, reason: MESSAGES.currency });
    } else {
      const versions = byId.get(result.position.externalId) ?? [];
      versions.push(result.position);
      byId.set(result.position.externalId, versions);
    }
  }
  const positions: ExternalPosition[] = [];
  for (const [externalId, versions] of byId) {
    const sorted = [...versions].sort((a, b) => (a.payloadHash < b.payloadHash ? -1 : a.payloadHash > b.payloadHash ? 1 : 0));
    positions.push(sorted[0]);
    for (const other of sorted.slice(1)) {
      if (other.payloadHash === sorted[0].payloadHash) report.duplicates += 1;
      else report.rejected.push({ externalId, reason: MESSAGES.conflict });
    }
  }
  positions.sort(byEntryThenId);
  report.rejected.sort((a, b) => ((a.externalId ?? "") < (b.externalId ?? "") ? -1 : (a.externalId ?? "") > (b.externalId ?? "") ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const linkedInRun = new Set<string>();
  let latest: bigint | null = connection.syncedThrough === null ? null : instantMicros(connection.syncedThrough);
  for (const position of positions) {
    try {
      const candidates = (await store.listCandidates(position)).filter(candidate => !linkedInRun.has(candidate.tradeId));
      const decision = decisionFor(matchExecution({ ...position, accountId: connection.accountId }, candidates));
      const outcome = await store.ingest(position, decision);
      if (outcome === "LINKED" && decision.kind === "LINK") linkedInRun.add(decision.tradeId);
      report.decisions.push({ externalId: position.externalId, decision, outcome });
      countOutcome(report, outcome);
    } catch {
      return { ...report, status: "ERROR", message: MESSAGES.storeFailed, syncedThrough: connection.syncedThrough };
    }
    const positionLatest = instantMicros(position.exitedAt ?? position.enteredAt);
    if (latest === null || positionLatest > latest) latest = positionLatest;
  }

  return { ...report, message: summary(report), syncedThrough: latest === null ? null : instantFromMicros(latest) };
}
