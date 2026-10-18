import { describe, expect, it } from "vitest";
import type { ExecutionSyncProvider, ExternalPosition, IngestDecision, IngestOutcome, SyncCandidate, SyncConnection, SyncStore } from "@/domain/sync/contract";
import { MATCH_WINDOW_MINUTES, type MatchablePosition, matchExecution } from "@/domain/sync/match";
import { MOCK_POSITIONS, MockSyncProvider } from "@/domain/sync/mock-provider";
import { canonicalInstant, normalizeExternalPosition, normalizeSymbol, positionHash } from "@/domain/sync/normalize";
import { decisionFor, runSync } from "@/domain/sync/run-sync";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "20000000-0000-4000-8000-000000000002";
const trade = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const raw = {
  externalId: "MOCK-1", symbol: "EURUSD", direction: "BUY", volume: "0.25", entryPrice: "1.10012", enteredAt: "2026-09-15T07:05:00Z",
  exitPrice: "1.10612", exitedAt: "2026-09-15T09:40:00Z", commission: "-1.75", swap: "0", realizedPnl: "148.25", currency: "USD",
};

function normalized(changes: Record<string, unknown> = {}): ExternalPosition {
  const result = normalizeExternalPosition({ ...raw, ...changes });
  if (!result.ok) throw new Error(result.error);
  return result.position;
}

describe("normalizeExternalPosition", () => {
  it("produces canonical decimals, symbols, directions and microsecond instants", () => {
    const position = normalized({ symbol: " eur/usd ", direction: "buy", volume: 0.25, entryPrice: "1.10012000", enteredAt: "2026-09-15T09:05:00.000001+02:00", swap: 0 });
    expect(position).toMatchObject({
      externalId: "MOCK-1", symbol: "EURUSD", direction: "LONG", volume: "0.25", entryPrice: "1.10012", enteredAt: "2026-09-15T07:05:00.000001Z",
      exitPrice: "1.10612", exitedAt: "2026-09-15T09:40:00.000000Z", commission: "-1.75", swap: "0", realizedPnl: "148.25", currency: "USD",
    });
    expect(position.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized({ direction: "SELL" }).direction).toBe("SHORT");
    expect(normalized({ exitPrice: null, exitedAt: null, realizedPnl: null, commission: undefined }).exitPrice).toBeNull();
  });

  it("hashes the canonical content: formatting differences are identical, real changes differ", () => {
    const a = normalized();
    expect(normalized({ entryPrice: "1.100120", volume: 0.25, symbol: "eurusd" }).payloadHash).toBe(a.payloadHash);
    expect(normalized({ exitPrice: "1.10613" }).payloadHash).not.toBe(a.payloadHash);
    const { payloadHash: _hash, ...content } = a;
    expect(positionHash(content)).toBe(a.payloadHash);
  });

  it.each([
    ["NaN volume", { volume: Number.NaN }, "Volume must be a finite number."],
    ["infinite price", { entryPrice: Number.POSITIVE_INFINITY }, "Entry price must be a finite number."],
    ["negative volume", { volume: "-1" }, "Volume must be positive."],
    ["zero price", { entryPrice: "0" }, "Entry price must be positive."],
    ["exponent text", { entryPrice: "1.1e0" }, "Entry price must be a plain decimal number."],
    ["too many price decimals", { entryPrice: "1.123456789" }, "Entry price has more than 8 decimals."],
    ["sub-cent money", { commission: "-1.755" }, "Commission has more than 2 decimals."],
    ["out-of-range money", { realizedPnl: "1000000000000" }, "Realized P&L is out of range."],
    ["bad symbol", { symbol: "EUR USD!" }, "Symbol is not a valid instrument code."],
    ["bad currency", { currency: "US" }, "Currency must be a three-letter code."],
    ["bad direction", { direction: "FLAT" }, "Direction must be long/buy or short/sell."],
    ["local time", { enteredAt: "2026-09-15T07:05:00" }, "Entry time must be a timestamp with an explicit timezone."],
    ["exit before entry", { exitedAt: "2026-09-15T07:04:59.999999Z" }, "Exit time is before the entry time."],
    ["exit price without exit time", { exitedAt: null }, "An exit price requires an exit time."],
    ["exit time without price or P&L", { exitPrice: null, realizedPnl: null }, "A closed position needs an exit price or a realized P&L."],
    ["empty id", { externalId: "  " }, "The platform position id must have 1–120 characters."],
    ["missing fields", { volume: undefined }, "The platform position is missing required fields."],
  ])("rejects %s", (_name, changes, error) => {
    const result = normalizeExternalPosition({ ...raw, ...changes });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  it("rejects future timestamps when a server time is given", () => {
    const result = normalizeExternalPosition(raw, { now: "2026-09-15T09:39:59Z" });
    expect(result).toEqual({ ok: false, externalId: "MOCK-1", error: "Timestamps cannot be in the future." });
    expect(normalizeExternalPosition(raw, { now: "2026-09-15T09:40:00Z" }).ok).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(normalizeExternalPosition(null)).toEqual({ ok: false, externalId: null, error: "The platform position is missing required fields." });
    expect(normalizeExternalPosition("MOCK-1").ok).toBe(false);
  });

  it("normalises symbols and instants", () => {
    expect(normalizeSymbol(" gbp / usd ")).toBe("GBPUSD");
    expect(normalizeSymbol("EURUSD.m")).toBe("EURUSD.M");
    expect(canonicalInstant("2026-09-15 07:05:00.5+00")).toBe("2026-09-15T07:05:00.500000Z");
  });
});

const LOCKED_AT = "2026-09-15T07:00:00Z";
function candidate(changes: Partial<SyncCandidate> = {}): SyncCandidate {
  return {
    tradeId: trade(1), accountId: ACCOUNT, origin: "PLANNED", lifecycle: "LOCKED", linked: false, symbol: "EURUSD", direction: "LONG",
    lockedAt: LOCKED_AT, plannedEntry: "1.1", plannedStop: "1.098", tickSize: "0.00001", ...changes,
  };
}
const position = (changes: Partial<MatchablePosition> = {}): MatchablePosition => ({ accountId: ACCOUNT, symbol: "EURUSD", direction: "LONG", entryPrice: "1.10005", enteredAt: "2026-09-15T07:05:00Z", ...changes });

describe("matchExecution (spec §8.6)", () => {
  it("links exactly one qualifying planned trade", () => {
    expect(matchExecution(position(), [candidate()])).toEqual({ kind: "UNIQUE", tradeId: trade(1) });
    expect(matchExecution(position(), [candidate({ lifecycle: "LIVE" })])).toEqual({ kind: "UNIQUE", tradeId: trade(1) });
  });

  it("holds ambiguous matches with sorted ids, whatever the candidate order", () => {
    const candidates = [candidate({ tradeId: trade(3) }), candidate({ tradeId: trade(1) }), candidate({ tradeId: trade(2) }), candidate({ tradeId: trade(1) })];
    const expected = { kind: "AMBIGUOUS", tradeIds: [trade(1), trade(2), trade(3)] };
    expect(matchExecution(position(), candidates)).toEqual(expected);
    expect(matchExecution(position(), [...candidates].reverse())).toEqual(expected);
  });

  it.each([
    ["another account", { accountId: OTHER_ACCOUNT }],
    ["another symbol", { symbol: "GBPUSD" }],
    ["the opposite direction", { direction: "SHORT" as const }],
    ["a live-first trade", { origin: "LIVE_FIRST" as const }],
    ["an imported trade", { origin: "IMPORTED" as const }],
    ["a draft", { lifecycle: "DRAFT" as const }],
    ["a closed trade", { lifecycle: "CLOSED" as const }],
    ["an already linked trade", { linked: true }],
    ["a lock after the entry", { lockedAt: "2026-09-15T07:05:00.000001Z" }],
    ["a lock at the entry instant", { lockedAt: "2026-09-15T07:05:00Z" }],
    ["an entry more than 30 minutes after the lock", { lockedAt: "2026-09-15T06:34:59.999999Z" }],
    ["a missing planned stop", { plannedStop: null }],
    ["an unknown tick size", { tickSize: null }],
  ])("ignores %s", (_name, changes) => expect(matchExecution(position(), [candidate(changes)])).toEqual({ kind: "NONE" }));

  it("accepts the window and price boundaries inclusively", () => {
    expect(MATCH_WINDOW_MINUTES).toBe(30);
    expect(matchExecution(position(), [candidate({ lockedAt: "2026-09-15T06:35:00Z" })]).kind).toBe("UNIQUE");
    // 25% of a 0.002 stop is 0.0005 (50 ticks) > 20 ticks.
    expect(matchExecution(position({ entryPrice: "1.1005" }), [candidate()]).kind).toBe("UNIQUE");
    expect(matchExecution(position({ entryPrice: "1.10051" }), [candidate()]).kind).toBe("NONE");
    expect(matchExecution(position({ entryPrice: "1.0995" }), [candidate()]).kind).toBe("UNIQUE");
    // A tight 0.0004 stop: 25% is 10 ticks, so the 20-tick floor applies.
    expect(matchExecution(position({ entryPrice: "1.1002" }), [candidate({ plannedStop: "1.0996" })]).kind).toBe("UNIQUE");
    expect(matchExecution(position({ entryPrice: "1.10021" }), [candidate({ plannedStop: "1.0996" })]).kind).toBe("NONE");
  });

  it("compares normalised symbols", () => {
    expect(matchExecution(position(), [candidate({ symbol: "eur/usd" })]).kind).toBe("UNIQUE");
  });

  it("maps match results to ingest decisions", () => {
    expect(decisionFor({ kind: "UNIQUE", tradeId: trade(1) })).toEqual({ kind: "LINK", tradeId: trade(1) });
    expect(decisionFor({ kind: "AMBIGUOUS", tradeIds: [trade(1), trade(2)] })).toEqual({ kind: "HOLD" });
    expect(decisionFor({ kind: "NONE" })).toEqual({ kind: "CREATE" });
  });
});

describe("MockSyncProvider", () => {
  it("is read-only and returns deterministic fixtures", async () => {
    const provider = new MockSyncProvider();
    expect(provider.readOnly).toBe(true);
    expect(provider.id).toBe("MOCK");
    expect(await provider.fetchPositions(null)).toEqual(MOCK_POSITIONS);
    expect(MOCK_POSITIONS.map(p => normalizeExternalPosition(p).ok)).toEqual([true, true, true]);
  });

  it("filters by the latest timestamp after `since`", async () => {
    const provider = new MockSyncProvider();
    expect((await provider.fetchPositions("2026-09-15T09:00:00Z")).map(p => (p as { externalId: string }).externalId)).toEqual(["MOCK-1001", "MOCK-1003"]);
    expect(await provider.fetchPositions("2026-09-16T14:05:00Z")).toEqual([]);
  });

  it("returns copies that callers cannot mutate", async () => {
    const provider = new MockSyncProvider();
    const first = (await provider.fetchPositions(null)) as { volume: string }[];
    first[0].volume = "999";
    expect(((await provider.fetchPositions(null)) as { volume: string }[])[0].volume).toBe("0.25");
  });
});

/** A stored open position seen closed with the same identity (spec §8.6). */
function closesOpenPosition(stored: ExternalPosition, next: ExternalPosition): boolean {
  return stored.exitedAt === null && next.exitedAt !== null && stored.symbol === next.symbol && stored.direction === next.direction
    && stored.volume === next.volume && stored.entryPrice === next.entryPrice && stored.enteredAt === next.enteredAt;
}

/** In-memory store with the dedup semantics of `ingest_external_execution`. */
class MemoryStore implements SyncStore {
  readonly stored = new Map<string, ExternalPosition>();
  readonly ingested: { externalId: string; decision: IngestDecision }[] = [];
  constructor(private readonly candidates: SyncCandidate[] = [], private readonly failOn: string | null = null) {}

  async listCandidates(): Promise<readonly SyncCandidate[]> {
    return this.candidates.map(c => ({ ...c, linked: c.linked || [...this.ingested].some(i => i.decision.kind === "LINK" && i.decision.tradeId === c.tradeId) }));
  }

  async ingest(position: ExternalPosition, decision: IngestDecision): Promise<IngestOutcome> {
    if (position.externalId === this.failOn) throw new Error("database password=secret unavailable");
    const existing = this.stored.get(position.externalId);
    if (existing) {
      if (existing.payloadHash === position.payloadHash) return "UNCHANGED";
      if (!closesOpenPosition(existing, position)) return "CHANGED";
      this.stored.set(position.externalId, position);
      return "CLOSED";
    }
    this.stored.set(position.externalId, position);
    this.ingested.push({ externalId: position.externalId, decision });
    return decision.kind === "CREATE" ? "CREATED" : decision.kind === "LINK" ? "LINKED" : "HELD";
  }
}

class FixedProvider implements ExecutionSyncProvider {
  readonly id = "MOCK" as const;
  readonly readOnly = true as const;
  constructor(private readonly positions: readonly unknown[]) {}
  async fetchPositions(): Promise<readonly unknown[]> {
    return structuredClone([...this.positions]);
  }
}

const connection: SyncConnection = { id: "50000000-0000-4000-8000-000000000001", accountId: ACCOUNT, accountCurrency: "USD", provider: "MOCK", syncedThrough: null };

describe("runSync", () => {
  const plannedMatch = candidate({ tradeId: trade(1), lockedAt: "2026-09-15T07:00:00Z", plannedEntry: "1.1", plannedStop: "1.098" });
  const ambiguousA = candidate({ tradeId: trade(2), symbol: "GBPUSD", direction: "SHORT", lockedAt: "2026-09-15T08:00:00Z", plannedEntry: "1.2725", plannedStop: "1.2745" });
  const ambiguousB = { ...ambiguousA, tradeId: trade(3) };

  it("links unique matches, holds ambiguous ones and imports the rest", async () => {
    const store = new MemoryStore([plannedMatch, ambiguousA, ambiguousB]);
    const report = await runSync(connection, new MockSyncProvider(), store);
    expect(report).toMatchObject({ status: "SYNCED", fetched: 3, created: 1, linked: 1, held: 1, unchanged: 0, closed: 0, changed: 0, duplicates: 0, rejected: [], syncedThrough: "2026-09-16T14:05:00.000000Z" });
    expect(report.message).toBe("Sync complete: 1 imported, 1 linked, 1 awaiting your confirmation.");
    expect(report.decisions).toEqual([
      { externalId: "MOCK-1001", decision: { kind: "LINK", tradeId: trade(1) }, outcome: "LINKED" },
      { externalId: "MOCK-1002", decision: { kind: "HOLD" }, outcome: "HELD" },
      { externalId: "MOCK-1003", decision: { kind: "CREATE" }, outcome: "CREATED" },
    ]);
  });

  it("is idempotent: a repeated sync changes nothing", async () => {
    const store = new MemoryStore([plannedMatch]);
    await runSync(connection, new MockSyncProvider(), store);
    const again = await runSync(connection, new MockSyncProvider(), store);
    expect(again).toMatchObject({ created: 0, linked: 0, held: 0, unchanged: 3 });
    expect(store.ingested).toHaveLength(3);
  });

  it("reports changed payloads for stored ids without overwriting them", async () => {
    const store = new MemoryStore();
    await runSync(connection, new FixedProvider([raw]), store);
    const report = await runSync(connection, new FixedProvider([{ ...raw, exitPrice: "1.10613" }]), store);
    expect(report).toMatchObject({ changed: 1, closed: 0 });
    expect(report.message).toBe("Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation.");
    expect(store.stored.get("MOCK-1")?.exitPrice).toBe("1.10612");
  });

  describe("a position first ingested open and later seen closed", () => {
    const open = { ...raw, exitPrice: null, exitedAt: null, realizedPnl: null };

    it("counts the appended close apart from conflicting changes and reports it", async () => {
      const store = new MemoryStore();
      const first = await runSync(connection, new FixedProvider([open]), store);
      expect(first).toMatchObject({ created: 1, closed: 0, syncedThrough: "2026-09-15T07:05:00.000000Z" });
      const closing = await runSync({ ...connection, syncedThrough: first.syncedThrough }, new FixedProvider([raw]), store);
      expect(closing).toMatchObject({ status: "SYNCED", created: 0, unchanged: 0, closed: 1, changed: 0, syncedThrough: "2026-09-15T09:40:00.000000Z" });
      expect(closing.decisions.map(d => d.outcome)).toEqual(["CLOSED"]);
      expect(closing.message).toBe("Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 1 closed.");
      expect(store.stored.get("MOCK-1")?.exitPrice).toBe("1.10612");
      expect(await runSync(connection, new FixedProvider([raw]), store)).toMatchObject({ unchanged: 1, closed: 0, changed: 0 });
    });

    it("treats a changed identity as a conflicting change, never as a close", async () => {
      const store = new MemoryStore();
      await runSync(connection, new FixedProvider([open]), store);
      const conflict = await runSync(connection, new FixedProvider([{ ...raw, entryPrice: "1.10013" }]), store);
      expect(conflict).toMatchObject({ closed: 0, changed: 1 });
      expect(store.stored.get("MOCK-1")?.exitedAt).toBeNull();
    });

    it("mentions closes next to rejections", async () => {
      const store = new MemoryStore();
      await runSync(connection, new FixedProvider([open]), store);
      const report = await runSync(connection, new FixedProvider([raw, { ...raw, externalId: "MOCK-EUR", currency: "EUR" }]), store);
      expect(report.message).toBe("Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 1 closed, 1 rejected.");
    });
  });

  it("deduplicates repeats within one fetch and keeps one version of conflicting data", async () => {
    const store = new MemoryStore();
    const report = await runSync(connection, new FixedProvider([raw, { ...raw }, { ...raw, exitPrice: "1.10613" }, { ...raw, externalId: "MOCK-2" }]), store);
    expect(report).toMatchObject({ fetched: 4, created: 2, duplicates: 1 });
    expect(report.rejected).toEqual([{ externalId: "MOCK-1", reason: "The platform reported conflicting data for the same position in one sync; the first version was kept." }]);
    const reversed = await runSync(connection, new FixedProvider([{ ...raw, externalId: "MOCK-2" }, { ...raw, exitPrice: "1.10613" }, { ...raw }, raw]), new MemoryStore());
    expect(reversed.decisions).toEqual(report.decisions);
  });

  it("is deterministic regardless of provider and candidate order", async () => {
    const forward = await runSync(connection, new FixedProvider(MOCK_POSITIONS), new MemoryStore([plannedMatch, ambiguousA, ambiguousB]));
    const backward = await runSync(connection, new FixedProvider([...MOCK_POSITIONS].reverse()), new MemoryStore([ambiguousB, ambiguousA, plannedMatch]));
    expect(backward).toEqual(forward);
  });

  it("links one planned trade at most once per run", async () => {
    const second = { ...raw, externalId: "MOCK-2", enteredAt: "2026-09-15T07:10:00Z" };
    const report = await runSync(connection, new FixedProvider([raw, second]), new MemoryStore([candidate({ plannedEntry: "1.10012" })]));
    expect(report.decisions.map(d => d.decision.kind)).toEqual(["LINK", "CREATE"]);
  });

  it("rejects invalid positions and currency mismatches without ingesting them", async () => {
    const store = new MemoryStore();
    const report = await runSync(connection, new FixedProvider([{ ...raw, volume: "-1" }, { ...raw, externalId: "MOCK-EUR", currency: "EUR" }, { nonsense: true }]), store);
    expect(report.rejected).toEqual([
      { externalId: null, reason: "The platform position is missing required fields." },
      { externalId: "MOCK-1", reason: "Volume must be positive." },
      { externalId: "MOCK-EUR", reason: "The position currency does not match the trading account." },
    ]);
    expect(store.ingested).toEqual([]);
    expect(report.status).toBe("SYNCED");
    expect(report.message).toBe("Sync complete: 0 imported, 0 linked, 0 awaiting your confirmation, 3 rejected.");
  });

  it("refuses providers that are not read-only or do not match the connection", async () => {
    const writable = { id: "MOCK", readOnly: false, fetchPositions: async () => [raw] } as unknown as ExecutionSyncProvider;
    expect(await runSync(connection, writable, new MemoryStore())).toMatchObject({ status: "ERROR", message: "Only read-only platform connections are supported. Nothing was imported.", fetched: 0 });
    expect((await runSync({ ...connection, provider: "CTRADER" }, new MockSyncProvider(), new MemoryStore())).message).toBe("This platform does not match the connection. Nothing was imported.");
  });

  it("reports provider failures without leaking details", async () => {
    const failing: ExecutionSyncProvider = { id: "MOCK", readOnly: true, fetchPositions: async () => { throw new Error("token=abc123 rejected"); } };
    const report = await runSync(connection, failing, new MemoryStore());
    expect(report).toMatchObject({ status: "ERROR", message: "The platform did not return positions. Nothing was imported.", syncedThrough: null });
    expect(JSON.stringify(report)).not.toContain("abc123");
  });

  it("stops on a store failure, keeps progress and does not advance syncedThrough", async () => {
    const store = new MemoryStore([], "MOCK-1003");
    const previous = { ...connection, syncedThrough: "2026-09-01T00:00:00.000000Z" };
    const report = await runSync(previous, new MockSyncProvider(), store);
    expect(report).toMatchObject({ status: "ERROR", message: "Sync stopped before finishing. Positions already imported are kept; run the sync again to continue.", created: 2, syncedThrough: "2026-09-01T00:00:00.000000Z" });
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("asks the provider only for positions after syncedThrough", async () => {
    const report = await runSync({ ...connection, syncedThrough: "2026-09-15T09:40:00Z" }, new MockSyncProvider(), new MemoryStore());
    expect(report.decisions.map(d => d.externalId)).toEqual(["MOCK-1003"]);
    expect(report.syncedThrough).toBe("2026-09-16T14:05:00.000000Z");
  });
});
