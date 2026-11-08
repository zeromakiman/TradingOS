import { beforeEach, describe, expect, it, vi } from "vitest";
import { ids, periodicSourcesV2, periodicTables, planId, tradeRecordId } from "./fixtures/periodic-v2";
import { periodicDb, type PeriodicDbState } from "./helpers/periodic-db";

// MONTHLY_REVIEW_FACTS_V2 loading (src/lib/monthly-review-source.ts): one completed calendar month (fixed UTC−5) of
// the owner's account, detailed with the journal entries, events and tags recorded within the month, or the explicit
// deterministic summary when the month is larger than one detailed review; explicit bounds and the pre-flight refusal.

const m = vi.hoisted(() => ({ auth: vi.fn(), state: { rows: {}, queries: [], errors: new Set<string>() } as PeriodicDbState }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.auth }));
import { operationAllowedSources } from "@/ai/citation-sources";
import { loadMonthlyFacts, MonthlyScopeError, ownedMonthlyAccount } from "@/lib/monthly-review-source";

const month = "2026-08";
const MONTH_START = "2026-08-01T05:00:00.000Z";
const MONTH_END = "2026-09-01T05:00:00.000Z";
const sources = (count = 3, journal = 3, body?: string) => periodicSourcesV2(count, { start: "2026-08-04T08:00:00.000Z", stepMinutes: 300, journal, body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
  m.state.queries = [];
  m.state.errors.clear();
  m.state.rows = periodicTables(sources());
  m.auth.mockResolvedValue({ db: periodicDb(m.state), user: { id: ids.user } });
});

const load = async () => loadMonthlyFacts(await ownedMonthlyAccount(ids.account), month);
const detailed = (facts: Awaited<ReturnType<typeof load>>) => {
  if (facts.mode !== "DETAILED") throw new Error("Expected a detailed month");
  return facts;
};

describe("monthly owner-scoped bounded database selection", () => {
  it("uses the authenticated owner with no fallback to another account", async () => {
    await expect(ownedMonthlyAccount(ids.image)).rejects.toThrow(/unavailable/);
    m.state.rows.accounts[0].user_id = ids.image;
    await expect(ownedMonthlyAccount(ids.account)).rejects.toThrow(/unavailable/);
  });

  it("signed-out access cannot read source data", async () => {
    m.auth.mockRejectedValueOnce(new Error("signed out"));
    await expect(load()).rejects.toThrow();
    expect(m.state.queries).toEqual([]);
  });

  it("excludes foreign, prior-month, next-month and open trades in database selection", async () => {
    const t = m.state.rows.journal_analytics[0];
    m.state.rows.journal_analytics.push({ ...t, id: ids.image, account_id: ids.image }, { ...t, id: ids.event, exited_at: "2026-08-01T04:59:59.999Z" },
      { ...t, id: ids.review, exited_at: MONTH_END }, { ...t, id: ids.user, status: "TAKEN" });
    const facts = detailed(await load());
    expect(facts.version).toBe("MONTHLY_REVIEW_FACTS_V2");
    expect(facts.trades.map(trade => trade.tradeId)).toEqual([planId(0), planId(1), planId(2)]);
    expect(m.state.queries.find(q => q.table === "journal_analytics")).toMatchObject({
      limit: 121, filters: [["eq", "account_id", ids.account], ["eq", "status", "CLOSED"], ["gte", "exited_at", MONTH_START], ["lt", "exited_at", MONTH_END]],
    });
  });

  it("queries only original versions, the selected plans and their V2 records; never screenshots", async () => {
    await load();
    expect(m.state.queries.map(q => q.table)).toEqual([
      "accounts", "journal_analytics", "trade_plans", "strategy_versions", "risk_plan_versions", "trade_events", "trade_ledger", "trade_journal_entries", "trade_tag_sets",
    ]);
    for (const query of m.state.queries.slice(2)) {
      expect(query.filters).toContainEqual(["eq", "account_id", ids.account]);
      if (query.table !== "trade_ledger") expect(query.filters).toContainEqual(["eq", "user_id", ids.user]);
    }
    expect(m.state.queries.find(q => q.table === "trade_plans")?.filters).toContainEqual(["in", "id", [planId(0), planId(1), planId(2)]]);
    for (const table of ["trade_journal_entries", "trade_tag_sets"]) {
      expect(m.state.queries.find(q => q.table === table)?.filters).toEqual(expect.arrayContaining([["gte", "recorded_at", MONTH_START], ["lt", "recorded_at", MONTH_END]]));
    }
  });

  it("excludes events of unrelated trades, out-of-month times, later backfilled notes and the lock/entry/close events", async () => {
    const note = m.state.rows.trade_events.find(row => row.event_type === "NOTE_ADDED");
    m.state.rows.trade_events.push({ ...note, id: ids.image, plan_id: ids.image }, { ...note, id: ids.event, occurred_at: MONTH_END }, { ...note, id: ids.review, recorded_at: "2026-09-04T05:00:00.000Z" });
    const facts = detailed(await load());
    expect(facts.trades[0].events?.map(event => event.event_type)).toEqual(["NOTE_ADDED"]);
    expect(JSON.stringify(facts)).not.toContain("plan_id");
    expect(JSON.stringify(facts)).not.toMatch(/TRADE_OPENED|TRADE_CLOSED|PLAN_LOCKED/);
  });

  it("details journal entries with their timing and cites trades by their V2 identity", async () => {
    const facts = detailed(await load());
    // Each journal entry is one row: [id, kind, recordedAt, timing, text, extra].
    expect(facts.trades[0].journal?.map(row => row[3])).toEqual(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
    const allowed = operationAllowedSources("MONTHLY_REVIEW", facts);
    expect(allowed.slice(0, 5)).toEqual(["period", "sample", "edge", "models", "sessions"]);
    expect(allowed).toContain(`trade:${tradeRecordId(2)}`);
    expect(allowed).toContain(`journal:${facts.trades[2].journal?.[2][0]}`);
    expect(facts).not.toHaveProperty("sourceManifest");
  });

  it("empty month reads no version, event or journal history", async () => {
    m.state.rows.journal_analytics = [];
    expect((await load()).trades).toEqual([]);
    expect(m.state.queries).toHaveLength(2);
  });

  it.each(["trade_events", "trade_ledger", "trade_journal_entries", "trade_tag_sets"])("fails closed when %s is unavailable", async table => {
    m.state.errors.add(table);
    await expect(load()).rejects.toThrow(/unavailable/);
  });

  it("missing original versions cannot silently drop a trade", async () => {
    m.state.rows.strategy_versions = [];
    await expect(load()).rejects.toThrow(/Original/);
  });

  it("a future or current month is rejected before querying trades", async () => {
    await expect(loadMonthlyFacts(await ownedMonthlyAccount(ids.account), "2099-12")).rejects.toThrow(/completed/);
    expect(m.state.queries).toHaveLength(1);
  });
});

describe("bounds: refuse or summarize explicitly, nothing is omitted", () => {
  it("over 120 trades fails before context enrichment", async () => {
    m.state.rows = periodicTables(periodicSourcesV2(121, { start: "2026-08-02T06:00:00.000Z", stepMinutes: 300, journal: 0 }));
    const error = await load().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(MonthlyScopeError);
    expect((error as Error).message).toMatch(/120-trade/);
    expect(m.state.queries).toHaveLength(2);
  });

  it("a few trades with more records than one detailed review are summarized from exact counts, never truncated", async () => {
    m.state.rows = periodicTables(sources(3, 170));
    const facts = await load();
    if (facts.mode !== "DETERMINISTIC SUMMARY") throw new Error("Expected a summary");
    expect(facts.sample.tradeIds).toEqual([planId(0), planId(1), planId(2)]);
    expect(facts.omitted).toEqual({ individualTradeDetails: 3, journalEntries: 510, eventDetails: 3, strategyDefinitions: 1, riskDefinitions: 1 });
    // The detailed read stops at its bound; the summary then counts every record of the month without reading one.
    const detailedReads = m.state.queries.filter(q => q.table === "trade_journal_entries" && !q.head);
    expect(detailedReads.every(q => (q.limit ?? Number.POSITIVE_INFINITY) <= 91)).toBe(true);
    expect(m.state.queries.filter(q => q.head).map(q => q.table)).toEqual(["trade_events", "trade_journal_entries"]);
  });

  it("120 trades with 600 journal entries are the deterministic summary of every trade; no record is read", async () => {
    const month120 = periodicSourcesV2(120, { start: "2026-08-01T06:00:00.000Z", stepMinutes: 360, journal: 5 });
    m.state.rows = periodicTables(month120);
    const facts = await load();
    if (facts.mode !== "DETERMINISTIC SUMMARY") throw new Error("Expected a summary");
    expect(facts.sample.tradeIds).toEqual(month120.map(source => source.plan.id));
    expect(facts.trades).toEqual(facts.sample.tradeIds.map(tradeId => ({ tradeId })));
    expect(facts.omitted).toEqual({ individualTradeDetails: 120, journalEntries: 600, eventDetails: 120, strategyDefinitions: 1, riskDefinitions: 1 });
    expect(facts.strategyVersions).toEqual([{ id: month120[0].strategy.id, version: month120[0].strategy.version }]);
    // Only counts: no plan, version, tag, event or journal row of the month is read.
    expect(m.state.queries.map(q => [q.table, q.head ?? false])).toEqual([
      ["accounts", false], ["journal_analytics", false], ["trade_events", true], ["trade_ledger", false], ["trade_journal_entries", true],
    ]);
    const [events, journal] = m.state.queries.filter(q => q.head);
    expect(events.filters).toEqual(expect.arrayContaining([
      ["eq", "account_id", ids.account], ["eq", "user_id", ids.user], ["not_in", "event_type", "(PLAN_LOCKED,TRADE_OPENED,TRADE_CLOSED)"],
      ["gte", "occurred_at", MONTH_START], ["lt", "occurred_at", MONTH_END], ["gte", "recorded_at", MONTH_START], ["lt", "recorded_at", MONTH_END],
    ]));
    expect(journal.filters).toEqual(expect.arrayContaining([["eq", "account_id", ids.account], ["eq", "user_id", ids.user], ["gte", "recorded_at", MONTH_START], ["lt", "recorded_at", MONTH_END]]));
    expect(operationAllowedSources("MONTHLY_REVIEW", facts)).toEqual(["period", "sample", "edge", "models", "sessions"]);
  });

  it("the summary counts only records of the month: later backfilled and out-of-month records are not counted", async () => {
    const month = periodicSourcesV2(40, { start: "2026-08-02T06:00:00.000Z", stepMinutes: 360, journal: 1 });
    m.state.rows = periodicTables(month);
    const [entry] = m.state.rows.trade_journal_entries;
    const [note] = m.state.rows.trade_events.filter(row => row.event_type === "NOTE_ADDED");
    m.state.rows.trade_journal_entries.push({ ...entry, id: ids.review, recorded_at: "2026-09-04T05:00:00.000Z" });
    m.state.rows.trade_events.push({ ...note, id: ids.event, recorded_at: "2026-09-04T05:00:00.000Z" }, { ...note, id: ids.image, plan_id: ids.image });
    const facts = await load();
    if (facts.mode !== "DETERMINISTIC SUMMARY") throw new Error("Expected a summary");
    expect(facts.omitted).toMatchObject({ individualTradeDetails: 40, journalEntries: 40, eventDetails: 40 });
  });

  it("a summary month whose trade lacks its V2 identity or whose counts are unavailable fails closed", async () => {
    m.state.rows = periodicTables(sources(31, 1));
    m.state.rows.trade_ledger.pop();
    await expect(load()).rejects.toThrow(/Original/);
    m.state.rows = periodicTables(sources(31, 1));
    m.state.errors.add("trade_journal_entries");
    await expect(load()).rejects.toThrow(/unavailable/);
  });

  it("a month larger than one detailed review is the explicit deterministic summary of every trade", async () => {
    m.state.rows = periodicTables(sources(31, 1));
    const facts = await load();
    expect(facts.mode).toBe("DETERMINISTIC SUMMARY");
    expect(facts.sample.tradeIds).toHaveLength(31);
    expect(facts.trades).toEqual(facts.sample.tradeIds.map(tradeId => ({ tradeId })));
    if (facts.mode !== "DETERMINISTIC SUMMARY") throw new Error("Expected a summary");
    expect(facts.omitted).toMatchObject({ individualTradeDetails: 31, journalEntries: 31, eventDetails: 31 });
    // Summary mode cites only the deterministic aggregates.
    expect(operationAllowedSources("MONTHLY_REVIEW", facts)).toEqual(["period", "sample", "edge", "models", "sessions"]);
  });

  it("dense detail that would not fit is summarized instead of truncated", async () => {
    m.state.rows = periodicTables(sources(30, 2, "Detailed management note ".repeat(200)));
    m.state.rows.trade_plans = m.state.rows.trade_plans.map(row => ({ ...row, proposal: { ...(row.proposal as object), narrative: "Thesis ".repeat(1000) } }));
    m.state.rows.trade_tag_sets = m.state.rows.trade_tag_sets.map(row => ({ ...row, tags: Array.from({ length: 12 }, (_, k) => `${k}-${"t".repeat(30)}`) }));
    const facts = await load();
    expect(facts.mode).toBe("DETERMINISTIC SUMMARY");
    expect(JSON.stringify(facts)).not.toContain("Detailed management note");
  });
});
