import { beforeEach, describe, expect, it, vi } from "vitest";
import { ids, periodicSourcesV2, periodicTables, planId, tradeRecordId, typicalPeriodicSources } from "./fixtures/periodic-v2";
import { periodicDb, type PeriodicDbState } from "./helpers/periodic-db";

// RECENT_TRADES_FACTS_V2 loading (src/lib/recent-trades-source.ts): the exact newest N completed planned trades of the
// owner's account, their original versions, V2 journal entries and tags up to the capture time, explicit bounds and
// the whole-request pre-flight refusal. Every query is owner- and account-scoped.

const m = vi.hoisted(() => ({ auth: vi.fn(), state: { rows: {}, queries: [], errors: new Set<string>() } as PeriodicDbState }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.auth }));
import { operationAllowedSources } from "@/ai/citation-sources";
import { PERIODIC_V2_LIMITS } from "@/ai/periodic-limits";
import { loadRecentFacts, ownedRecentAccount, RECENT_TOO_LARGE_SMALLEST, RecentScopeError, recentTooLarge, recentTooManyRecords } from "@/lib/recent-trades-source";

const NOW = "2026-09-23T12:00:00.000Z";
const sources = () => periodicSourcesV2(35, { start: "2026-08-01T08:00:00.000Z", stepMinutes: 600, journal: 2 });
/** Selection needs trades, not detail: one journal entry per trade keeps the newest 30 within one request. */
const light = () => periodicSourcesV2(35, { start: "2026-08-01T08:00:00.000Z", stepMinutes: 600, journal: 1 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  m.state.queries = [];
  m.state.errors.clear();
  m.state.rows = periodicTables(sources());
  m.auth.mockResolvedValue({ db: periodicDb(m.state), user: { id: ids.user } });
});

const load = async (n: unknown = 20) => loadRecentFacts(await ownedRecentAccount(ids.account), n);
const newest = (n: number) => Array.from({ length: n }, (_, i) => planId(34 - i));

describe("latest completed owner-only selection", () => {
  it.each([10, 20, 30])("selects exactly newest %s of 35 across weeks, in stable descending order", async n => {
    m.state.rows = periodicTables(light());
    const result = await load(n);
    expect(result.eligibleCount).toBe(35);
    expect(result.facts.version).toBe("RECENT_TRADES_FACTS_V2");
    expect(result.facts.sample).toMatchObject({ requested: n, actual: n, tradeIds: newest(n) });
    expect(result.facts.trades.map(t => t.tradeId)).toEqual(newest(n));
    expect(m.state.queries.find(q => q.table === "journal_analytics")?.orders).toEqual([["exited_at", false], ["id", true]]);
  });

  it("defaults to 20", async () => expect((await load()).facts.sample.requested).toBe(20));

  it("fewer than requested uses every eligible trade and states the limit", async () => {
    m.state.rows.journal_analytics = m.state.rows.journal_analytics.slice(0, 7);
    const result = await load(20);
    expect(result.eligibleCount).toBe(7);
    expect(result.facts.sample).toMatchObject({ actual: 7, fewerThanRequested: true });
    expect(result.facts.sample.caveat).toContain("Fewer completed trades");
  });

  it("exact timestamp ties use UUID ascending, even if source insertion order differs", async () => {
    m.state.rows.journal_analytics = m.state.rows.journal_analytics.slice(0, 12).reverse().map(t => ({ ...t, exited_at: "2026-09-20T00:00:00.000Z" }));
    expect((await load(10)).facts.sample.tradeIds).toEqual(Array.from({ length: 10 }, (_, i) => planId(i)));
  });

  it("excludes open, skipped, cancelled, foreign and future trades without leaking history", async () => {
    m.state.rows = periodicTables(light());
    const base = m.state.rows.journal_analytics[0];
    for (const status of ["TAKEN", "LOCKED", "CANCELLED", "SKIPPED"]) m.state.rows.journal_analytics.push({ ...base, id: ids.image, status });
    m.state.rows.journal_analytics.push({ ...base, id: ids.image, account_id: ids.image, exited_at: "2026-09-21T00:00:00.000Z" }, { ...base, id: ids.event, exited_at: "2099-01-01T00:00:00.000Z" });
    const result = await load(30);
    expect(result.eligibleCount).toBe(35);
    expect(result.facts.sample.tradeIds).not.toContain(ids.image);
    expect(result.facts.sample.tradeIds).not.toContain(ids.event);
  });

  it("reads only the sample's own records: versions, events, V2 identities, journal entries and tags; never screenshots", async () => {
    const result = await load(10);
    expect(m.state.queries.map(q => q.table)).toEqual([
      "accounts", "journal_analytics", "trade_plans", "strategy_versions", "risk_plan_versions", "trade_events", "trade_ledger", "trade_journal_entries", "trade_tag_sets",
    ]);
    for (const query of m.state.queries.slice(2)) {
      expect(query.filters).toContainEqual(["eq", "account_id", ids.account]);
      // trade_ledger has no user column: RLS of its base tables applies (security_invoker).
      if (query.table !== "trade_ledger") expect(query.filters).toContainEqual(["eq", "user_id", ids.user]);
    }
    const planIds = result.facts.sample.tradeIds;
    const recordIds = result.facts.trades.map(t => t.tradeRecordId);
    expect(m.state.queries.find(q => q.table === "trade_events")?.filters).toContainEqual(["in", "plan_id", planIds]);
    expect(m.state.queries.find(q => q.table === "trade_ledger")?.filters).toContainEqual(["in", "plan_id", planIds]);
    for (const table of ["trade_journal_entries", "trade_tag_sets"]) {
      const filters = m.state.queries.find(q => q.table === table)?.filters ?? [];
      const byTrade = filters.find(([kind, key]) => kind === "in" && key === "trade_id")?.[2] as string[] | undefined;
      expect([...(byTrade ?? [])].sort()).toEqual([...recordIds].sort());
      expect(filters).toContainEqual(["lte", "recorded_at", NOW]);
    }
    expect(recordIds).toEqual(newest(10).map(id => tradeRecordId(Number(id.slice(-12)) - 1)));
    expect(result.facts.trades).toHaveLength(10);
  });

  it("foreign/signed-out account cannot read a sample or silently fall back", async () => {
    await expect(ownedRecentAccount(ids.image)).rejects.toThrow();
    m.state.rows.accounts[0].user_id = ids.image;
    await expect(ownedRecentAccount(ids.account)).rejects.toThrow();
    m.auth.mockRejectedValueOnce(new Error("signed out"));
    await expect(load()).rejects.toThrow();
  });

  it("empty sample has no context enrichment", async () => {
    m.state.rows.journal_analytics = [];
    const result = await load();
    expect(result.facts.sample.actual).toBe(0);
    expect(m.state.queries.map(q => q.table)).toEqual(["accounts", "journal_analytics"]);
  });

  it.each([0, 11, 40, "20.0", null])("rejects unsupported sample %s", async n => {
    await expect(load(n)).rejects.toThrow();
  });

  it("missing original version or V2 identity cannot silently remove an included trade", async () => {
    const rows = structuredClone(m.state.rows);
    m.state.rows.strategy_versions = [];
    await expect(load()).rejects.toThrow(/Original/);
    m.state.rows = structuredClone(rows);
    m.state.rows.trade_ledger = m.state.rows.trade_ledger.filter(row => row.plan_id !== planId(34));
    await expect(load(30)).rejects.toThrow(/Original/);
  });

  it.each(["trade_events", "trade_ledger", "trade_journal_entries", "trade_tag_sets", "trade_plans"])("a database error in %s fails closed", async table => {
    m.state.errors.add(table);
    await expect(load()).rejects.toThrow(/unavailable/);
  });
});

describe("V2 journal entries, events and tags", () => {
  it("carries every journal entry with its timing band, V1 notes with theirs, and leaves out lock/entry/close events", async () => {
    const { facts } = await load(10);
    const trade = facts.trades[0];
    // Each journal entry is one row: [id, kind, recordedAt, timing, text, extra].
    expect(trade.journal?.map(row => row[3])).toEqual(["BEFORE_ENTRY", "WHILE_LIVE"]);
    expect(trade.journal?.[0]).toEqual([expect.any(String), "NOTE", expect.any(String), "BEFORE_ENTRY", expect.stringContaining("Journal entry 1")]);
    expect(trade.events?.map(event => event.event_type)).toEqual(["NOTE_ADDED"]);
    expect(trade.events?.[0]).toMatchObject({ timing: "WHILE_LIVE", payload: { note: expect.stringContaining("Waited for confirmation") } });
    expect(m.state.queries.find(q => q.table === "trade_events")?.filters).toContainEqual(["not_in", "event_type", "(PLAN_LOCKED,TRADE_OPENED,TRADE_CLOSED)"]);
    expect(JSON.stringify(facts)).not.toMatch(/PLAN_LOCKED|TRADE_OPENED|TRADE_CLOSED/);
  });

  it("an after-close note is labelled AFTER_CLOSE, never as pre-entry evidence", async () => {
    m.state.rows = periodicTables(periodicSourcesV2(10, { start: "2026-08-01T08:00:00.000Z", stepMinutes: 600, journal: 3 }));
    const { facts } = await load(10);
    for (const trade of facts.trades) expect(trade.journal?.map(row => row[3])).toEqual(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
    expect(facts.scope).toMatch(/AFTER_CLOSE records are hindsight explanations/);
  });

  it("shortens long journal texts explicitly and keeps the full record count", async () => {
    m.state.rows = periodicTables(periodicSourcesV2(10, { start: "2026-08-01T08:00:00.000Z", stepMinutes: 600, journal: 2, body: "Long note ".repeat(500) }));
    const { facts } = await load(10);
    const [, , , , text, extra] = facts.trades[0].journal?.[0] ?? [];
    expect(extra).toEqual({ textShortened: true });
    expect([...(text ?? "")].length).toBeLessThanOrEqual(200);
    expect(facts.trades.reduce((n, t) => n + (t.journal?.length ?? 0), 0)).toBe(20);
  });

  it("uses the latest V2 tag set recorded by the capture time, and the legacy V1 tags only when a trade has none", async () => {
    const tags = m.state.rows.trade_tag_sets;
    tags.push({ ...tags.at(-1), id: 5000, setup_grade: "B", recorded_at: "2026-09-22T00:00:00.000Z" });
    m.state.rows.trade_tag_sets = tags.filter(row => row.trade_id !== tradeRecordId(33));
    m.state.rows.journal_analytics = m.state.rows.journal_analytics.map(row => row.id === planId(33) ? { ...row, setup_grade: "C", tag_source: "V1" } : row);
    const { facts } = await load(10);
    expect(facts.trades[0].tags).toMatchObject({ setupGrade: "B", source: "V2", timing: "AFTER_CLOSE" });
    expect(facts.trades[1].tags).toMatchObject({ setupGrade: "C", source: "V1" });
    expect(facts.trades[1].tags).not.toHaveProperty("timing");
  });

  it("cites trades by their V2 identity and every journal entry and note by its own id", async () => {
    const { facts } = await load(10);
    const allowed = operationAllowedSources("RECENT_TRADES_ANALYSIS", facts);
    expect(allowed).toContain(`trade:${tradeRecordId(34)}`);
    expect(allowed).not.toContain(`trade:${planId(34)}`);
    for (const row of facts.trades.flatMap(t => t.journal ?? [])) expect(allowed).toContain(`journal:${row[0]}`);
    for (const event of facts.trades.flatMap(t => t.events ?? [])) expect(allowed).toContain(`event:${event.id}`);
    // The ids are listed once, in the response schema: the facts carry neither a manifest nor a sourceRefs list.
    expect(facts).not.toHaveProperty("sourceRefs");
    expect(facts).not.toHaveProperty("sourceManifest");
  });
});

describe("bounds refuse, nothing is omitted", () => {
  it.each([[10, 150], [20, 120], [30, 120]] as const)("the last %s trades are read with at most %s journal entries and events", async (n, max) => {
    expect(PERIODIC_V2_LIMITS.RECENT_TRADES_ANALYSIS.records[n]).toBe(max);
    const perTrade = Math.ceil((max + 1) / n);
    m.state.rows = periodicTables(periodicSourcesV2(35, { start: "2026-08-01T08:00:00.000Z", stepMinutes: 600, journal: perTrade - 1 }));
    const result = await load(n).then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(RecentScopeError);
    const message = (result as Error).message;
    if (n === 10) {
      // The smallest sample cannot be made smaller: no impossible next step is suggested.
      expect(message).toMatch(new RegExp(`^Even the 10 most recent trades have more than ${max} journal entries and events.*no record was left out`));
      expect(message).not.toMatch(/fewer trades/i);
    } else {
      // The largest smaller sample that fits one request is named, never a vague "fewer trades": the newest 20 of these
      // trades carry 100 records (within 120), the newest 10 of the 20-trade case 70 (within 150).
      const fits = n === 30 ? 20 : 10;
      expect(message).toBe(recentTooManyRecords(n, fits));
      expect(message).toMatch(new RegExp(`^The last ${n} trades have more than ${max} journal entries and events.*but the last ${fits} fit: choose ${fits} trades.*no record was left out`));
      expect((await load(fits)).facts.trades).toHaveLength(fits);
    }
    expect(m.state.queries.map(q => q.table)).not.toContain("recent_ai_analyses");
  });

  it("a sample above its record bound names the largest smaller sample within both its own bound and one request", async () => {
    // 160 typical entries over 35 trades: the newest 30 carry 135 (above 120), the newest 20 carry 85 and fit.
    m.state.rows = periodicTables(typicalPeriodicSources(35, 160, "2026-08-01T08:00:00.000Z"));
    const refused = await load(30).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(RecentScopeError);
    expect((refused as Error).message).toBe(recentTooManyRecords(30, 20));
    expect(recentTooManyRecords(30, 20)).toBe(
      "The last 30 trades have more than 120 journal entries and events, more than one analysis of 30 trades can include, but the last 20 fit: choose 20 trades. Nothing was sent; no record was left out.",
    );
    // The smaller sample is read with its own owner- and account-scoped queries, and nothing is written.
    const journalReads = m.state.queries.filter(q => q.table === "trade_journal_entries");
    expect(journalReads).toHaveLength(2);
    for (const query of journalReads) expect(query.filters).toContainEqual(["eq", "user_id", ids.user]);
    expect(m.state.queries.map(q => q.table)).not.toContain("recent_ai_analyses");
    // What the refusal names really loads.
    const { facts } = await load(20);
    expect(facts.trades.reduce((n, t) => n + (t.journal?.length ?? 0), 0)).toBe(85);
  });

  it("a sample above its record bound whose smaller samples are above theirs too suggests no impossible step", async () => {
    // Sixteen entries for every trade: even the newest 10 carry 160, above their bound of 150.
    m.state.rows = periodicTables(typicalPeriodicSources(35, 35 * 16, "2026-08-01T08:00:00.000Z"));
    for (const n of [30, 20] as const) {
      const refused = await load(n).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(RecentScopeError);
      expect((refused as Error).message).toBe(RECENT_TOO_LARGE_SMALLEST);
      expect(recentTooManyRecords(n, null)).toBe(RECENT_TOO_LARGE_SMALLEST);
    }
    await expect(load(10)).rejects.toThrow(recentTooManyRecords(10, null));
  });

  it("the last 30 typically journaled trades load as one request, about three journal entries each", async () => {
    m.state.rows = periodicTables(typicalPeriodicSources(35, 105, "2026-08-01T08:00:00.000Z"));
    const { facts } = await load(30);
    expect(facts.trades).toHaveLength(30);
    expect(facts.trades.reduce((n, t) => n + (t.journal?.length ?? 0), 0)).toBe(90);
  });

  it("refuses a sample whose whole request would not fit, before anything is written, and names the largest sample that fits", async () => {
    // Four typical journal entries for every trade: within the record bound of 30 trades, but not within one request.
    m.state.rows = periodicTables(typicalPeriodicSources(35, 140, "2026-08-01T08:00:00.000Z"));
    expect((await load(20)).facts.trades).toHaveLength(20);
    const refused = await load(30).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(RecentScopeError);
    expect((refused as Error).message).toBe(recentTooLarge(30, 20));
    expect(recentTooLarge(30, 20)).toBe("The last 30 trades carry more recorded detail than one analysis can include, but the last 20 fit: choose 20 trades. Nothing was sent and no record was left out.");
    // A long strategy definition (carried once, whatever the sample) keeps the facts under the byte bound while even
    // the 10 latest trades exceed 32,000 tokens: no smaller sample is offered.
    m.state.rows.strategy_versions = m.state.rows.strategy_versions.map(row => ({ ...row, rules: { ...(row.rules as object), definition: "r".repeat(80_000) } }));
    await expect(load(20)).rejects.toThrow(RECENT_TOO_LARGE_SMALLEST);
    expect(m.state.queries.map(q => q.table)).not.toContain("recent_ai_analyses");
  });

  it("offers ten trades when twenty do not fit either", async () => {
    m.state.rows = periodicTables(typicalPeriodicSources(35, 140, "2026-08-01T08:00:00.000Z"));
    m.state.rows.strategy_versions = m.state.rows.strategy_versions.map(row => ({ ...row, rules: { ...(row.rules as object), definition: "r".repeat(56_000) } }));
    const refused = await load(30).then(() => null, (error: unknown) => error);
    expect((refused as Error).message).toBe(recentTooLarge(30, 10));
    await expect(load(20)).rejects.toThrow(recentTooLarge(20, 10));
    expect((await load(10)).facts.trades).toHaveLength(10);
  });

  it("the smallest sample's pre-flight refusal names no impossible next step", async () => {
    m.state.rows.strategy_versions = m.state.rows.strategy_versions.map(row => ({ ...row, rules: { ...(row.rules as object), definition: "r".repeat(100_000) } }));
    const result = await load(10).then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(RecentScopeError);
    expect((result as Error).message).toBe(RECENT_TOO_LARGE_SMALLEST);
    expect(RECENT_TOO_LARGE_SMALLEST).not.toMatch(/fewer trades|choose/i);
    expect(recentTooLarge(10, null)).toBe(RECENT_TOO_LARGE_SMALLEST);
    expect(recentTooLarge(30, null)).toBe(RECENT_TOO_LARGE_SMALLEST);
  });
});
