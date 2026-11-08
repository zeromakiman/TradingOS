import { instantMicros } from "../time-display";
import type { ExecutionSyncProvider } from "./contract";

/**
 * Deterministic mock platform for developer "Simulate sync" and tests. Fixtures are synthetic
 * (USD account, standard EURUSD/GBPUSD contracts: 1 tick × 1 lot = $1) and never change.
 */

export interface MockPositionFixture {
  externalId: string;
  symbol: string;
  direction: string;
  volume: string;
  entryPrice: string;
  enteredAt: string;
  exitPrice: string | null;
  exitedAt: string | null;
  commission: string | null;
  swap: string | null;
  realizedPnl: string | null;
  currency: string;
}

export const MOCK_POSITIONS: readonly MockPositionFixture[] = Object.freeze([
  // Closed winner: 600 ticks × 0.25 lots = $150.00 gross, $1.75 commission.
  { externalId: "MOCK-1001", symbol: "EURUSD", direction: "BUY", volume: "0.25", entryPrice: "1.10012", enteredAt: "2026-09-15T07:05:00Z", exitPrice: "1.10612", exitedAt: "2026-09-15T09:40:00Z", commission: "-1.75", swap: "0", realizedPnl: "148.25", currency: "USD" },
  // Still open.
  { externalId: "MOCK-1002", symbol: "GBPUSD", direction: "SELL", volume: "0.10", entryPrice: "1.27250", enteredAt: "2026-09-15T08:15:00Z", exitPrice: null, exitedAt: null, commission: null, swap: null, realizedPnl: null, currency: "USD" },
  // Closed loser: −100 ticks × 0.50 lots = −$50.00 gross, $3.50 commission.
  { externalId: "MOCK-1003", symbol: "EURUSD", direction: "SELL", volume: "0.50", entryPrice: "1.09875", enteredAt: "2026-09-16T13:30:00Z", exitPrice: "1.09975", exitedAt: "2026-09-16T14:05:00Z", commission: "-3.50", swap: "0", realizedPnl: "-53.50", currency: "USD" },
].map(fixture => Object.freeze(fixture)));

function latestTime(fixture: unknown): bigint | null {
  if (typeof fixture !== "object" || fixture === null) return null;
  const { enteredAt, exitedAt } = fixture as { enteredAt?: unknown; exitedAt?: unknown };
  try {
    const times = [enteredAt, exitedAt].filter((value): value is string => typeof value === "string").map(value => instantMicros(value));
    return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
  } catch {
    return null;
  }
}

export class MockSyncProvider implements ExecutionSyncProvider {
  readonly id = "MOCK" as const;
  readonly readOnly = true as const;
  private readonly fixtures: readonly unknown[];

  constructor(fixtures: readonly unknown[] = MOCK_POSITIONS) {
    this.fixtures = structuredClone([...fixtures]);
  }

  /** Positions whose latest timestamp is after `since`; malformed fixtures are always returned so validation reports them. */
  async fetchPositions(since: string | null): Promise<unknown[]> {
    const threshold = since === null ? null : instantMicros(since);
    return structuredClone(this.fixtures.filter(fixture => {
      const latest = latestTime(fixture);
      return threshold === null || latest === null || latest > threshold;
    }));
  }
}
