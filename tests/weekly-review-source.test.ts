import { beforeEach, describe, expect, it, vi } from "vitest";
import { ids, periodicSourcesV2, periodicTables, planId, tradeRecordId, typicalPeriodicSources } from "./fixtures/periodic-v2";
import { periodicDb, type PeriodicDbState } from "./helpers/periodic-db";

// WEEKLY_REVIEW_FACTS_V2 loading (src/lib/weekly-review-source.ts): one completed Monday week (fixed UTC−5) of the
// owner's account, its completed planned trades by exit time, the journal entries, events and tags that occurred and
// were recorded within the week, explicit bounds and the whole-request pre-flight refusal.

const m = vi.hoisted(() => ({ auth: vi.fn(), state: { rows: {}, queries: [], errors: new Set<string>() } as PeriodicDbState }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: m.auth }));
import { operationAllowedSources } from "@/ai/citation-sources";
import { PERIODIC_V2_LIMITS } from "@/ai/periodic-limits";
import {
  loadWeeklyFacts, ownedWeeklyAccount, WEEKLY_NEXT_STEP, WEEKLY_TOO_MANY_RECORDS, WEEKLY_TOO_MANY_TRADES, WeeklyScopeError, weeklyTooLarge,
} from "@/lib/weekly-review-source";

const week = "2026-08-31";
const WEEK_START = "2026-08-31T05:00:00.000Z";
const WEEK_END = "2026-09-07T05:00:00.000Z";
/** Three trades on Tuesday, each with a journal entry before entry, while live and after close. */
const sources = (count = 3, journal = 3, body?: string) => periodicSourcesV2(count, { start: "2026-09-01T08:00:00.000Z", stepMinutes: 90, journal, body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
  m.state.queries = [];
  m.state.errors.clear();
  m.state.rows = periodicTables(sources());
  m.auth.mockResolvedValue({ db: periodicDb(m.state), user: { id: ids.user } });
});

const load = async () => loadWeeklyFacts(await ownedWeeklyAccount(ids.account), week);

describe("weekly owner-scoped bounded database selection", () => {
  it("uses the authenticated owner with no fallback to another account", async () => {
    await expect(ownedWeeklyAccount(ids.image)).rejects.toThrow(/unavailable/);
    m.state.rows.accounts[0].user_id = ids.image;
    await expect(ownedWeeklyAccount(ids.account)).rejects.toThrow(/unavailable/);
  });

  it("signed-out access cannot read source data", async () => {
    m.auth.mockRejectedValueOnce(new Error("signed out"));
    await expect(load()).rejects.toThrow();
    expect(m.state.queries).toEqual([]);
  });

  it("excludes foreign, prior-week, next-week and open trades in database selection", async () => {
    const t = m.state.rows.journal_analytics[0];
    m.state.rows.journal_analytics.push({ ...t, id: ids.image, account_id: ids.image }, { ...t, id: ids.event, exited_at: "2026-08-31T04:59:59.999Z" },
      { ...t, id: ids.review, exited_at: WEEK_END }, { ...t, id: ids.user, status: "TAKEN" });
    const facts = await load();
    expect(facts.version).toBe("WEEKLY_REVIEW_FACTS_V2");
    expect(facts.trades.map(trade => trade.tradeId)).toEqual([planId(0), planId(1), planId(2)]);
    expect(m.state.queries.find(q => q.table === "journal_analytics")).toMatchObject({
      limit: 21, filters: [["eq", "account_id", ids.account], ["eq", "status", "CLOSED"], ["gte", "exited_at", WEEK_START], ["lt", "exited_at", WEEK_END]],
    });
  });

  it("queries only original versions, the selected plans and their V2 records; never screenshots", async () => {
    const facts = await load();
    expect(m.state.queries.map(q => q.table)).toEqual([
      "accounts", "journal_analytics", "trade_plans", "strategy_versions", "risk_plan_versions", "trade_events", "trade_ledger", "trade_journal_entries", "trade_tag_sets",
    ]);
    for (const query of m.state.queries.slice(2)) {
      expect(query.filters).toContainEqual(["eq", "account_id", ids.account]);
      if (query.table !== "trade_ledger") expect(query.filters).toContainEqual(["eq", "user_id", ids.user]);
    }
    expect(m.state.queries.find(q => q.table === "trade_plans")?.filters).toContainEqual(["in", "id", [planId(0), planId(1), planId(2)]]);
    for (const table of ["trade_journal_entries", "trade_tag_sets"]) {
      expect(m.state.queries.find(q => q.table === table)?.filters).toEqual(expect.arrayContaining([["gte", "recorded_at", WEEK_START], ["lt", "recorded_at", WEEK_END]]));
    }
    expect(facts.trades.map(trade => trade.tradeRecordId)).toEqual([tradeRecordId(0), tradeRecordId(1), tradeRecordId(2)]);
  });

  it("excludes events of unrelated trades, out-of-week times, later backfilled notes and the lock/entry/close events", async () => {
    const note = m.state.rows.trade_events.find(row => row.event_type === "NOTE_ADDED");
    m.state.rows.trade_events.push({ ...note, id: ids.image, plan_id: ids.image }, { ...note, id: ids.event, occurred_at: WEEK_END }, { ...note, id: ids.review, recorded_at: "2026-09-10T05:00:00.000Z" });
    const facts = await load();
    expect(facts.trades[0].events?.map(event => event.event_type)).toEqual(["NOTE_ADDED"]);
    expect(JSON.stringify(facts)).not.toContain("plan_id");
    expect(JSON.stringify(facts)).not.toMatch(/TRADE_OPENED|TRADE_CLOSED|PLAN_LOCKED/);
  });

  it("includes journal entries and tags recorded within the week only, each with its timing band", async () => {
    const entry = m.state.rows.trade_journal_entries[0];
    m.state.rows.trade_journal_entries.push({ ...entry, id: ids.image, recorded_at: WEEK_END }, { ...entry, id: ids.event, recorded_at: "2026-08-30T00:00:00.000Z" });
    const tag = m.state.rows.trade_tag_sets[0];
    m.state.rows.trade_tag_sets.push({ ...tag, id: 9999, setup_grade: "INVALID", recorded_at: "2026-09-08T00:00:00.000Z" });
    const facts = await load();
    // Each journal entry is one row: [id, kind, recordedAt, timing, text, extra].
    expect(facts.trades[0].journal?.map(row => row[3])).toEqual(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
    expect(JSON.stringify(facts)).not.toContain(ids.image);
    expect(facts.trades[0].tags).toMatchObject({ setupGrade: "A", source: "V2" });
    // Legacy V1 tags have no recording time, so they can never be shown as within the week: the trade lists no tags.
    m.state.rows.trade_tag_sets = [];
    m.state.rows.journal_analytics = m.state.rows.journal_analytics.map(row => ({ ...row, setup_grade: "A+", tag_source: "V1" }));
    expect((await load()).trades[0]).not.toHaveProperty("tags");
  });

  it("cites every included trade, journal entry and note canonically", async () => {
    const facts = await load();
    const allowed = operationAllowedSources("WEEKLY_REVIEW", facts);
    expect(allowed.slice(0, 3)).toEqual(["period", "sample", "edge"]);
    expect(allowed).toEqual(expect.arrayContaining([`trade:${tradeRecordId(0)}`, ...facts.trades.flatMap(t => (t.journal ?? []).map(row => `journal:${row[0]}`))]));
    expect(facts).not.toHaveProperty("sourceManifest");
  });

  it("empty week reads no version, event or journal history", async () => {
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

  it("a future or current week is rejected before querying trades", async () => {
    await expect(loadWeeklyFacts(await ownedWeeklyAccount(ids.account), "2099-12-21")).rejects.toThrow(/completed/);
    expect(m.state.queries).toHaveLength(1);
  });
});

describe("bounds refuse, nothing is omitted", () => {
  it("over 20 trades fails before context enrichment", async () => {
    m.state.rows = periodicTables(sources(21, 0));
    const error = await load().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(WeeklyScopeError);
    expect((error as Error).message).toBe(WEEKLY_TOO_MANY_TRADES);
    expect(WEEKLY_TOO_MANY_TRADES).toMatch(/more than 20 completed trades, and a weekly review covers at most 20\. Nothing was sent and no trade was left out\./);
    expect(m.state.queries).toHaveLength(2);
  });

  it("over 70 journal entries and events is not silently truncated", async () => {
    m.state.rows = periodicTables(sources(3, 24));
    await expect(load()).rejects.toThrow(WEEKLY_TOO_MANY_RECORDS);
    expect(WEEKLY_TOO_MANY_RECORDS).toMatch(/more than 70 journal entries and events, and a weekly review reads at most 70\. Nothing was sent and no record was left out\./);
  });

  it("every refusal states the bound as a rule of the review, never as what fits, and names what the trader can still do", () => {
    expect(WEEKLY_NEXT_STEP).toBe("You can still review each of its trades with Review this trade on the trade's page.");
    expect(weeklyTooLarge(20, 50)).toBe(
      "This week's 20 trades with 50 journal entries and events hold more text than one weekly review can include; long theses and notes take more room. Nothing was sent and no record was left out. You can still review each of its trades with Review this trade on the trade's page.",
    );
    expect(weeklyTooLarge(1, 1)).toContain("This week's 1 trade with 1 journal entry or event hold");
    for (const copy of [WEEKLY_TOO_MANY_TRADES, WEEKLY_TOO_MANY_RECORDS, weeklyTooLarge(20, 50)]) {
      expect(copy).toContain("Nothing was sent");
      expect(copy.endsWith(` ${WEEKLY_NEXT_STEP}`)).toBe(true);
      // A bound is not a capacity: within 70 records a week of long theses and notes can still be too large.
      expect(copy).not.toMatch(/the most one review can|more than one review can include|silently/);
    }
  });

  it("measured capacity: typically journaled 20-trade weeks fit until the record bound; above it, or above 20 trades, the bound refuses first", async () => {
    // The seeded traders' journaling (55–110 characters per entry, a thesis of typical length, tags on every trade).
    const typical = (count: number, records: number) => periodicTables(typicalPeriodicSources(count, records, "2026-09-01T06:00:00.000Z", 300));
    const { trades, records } = PERIODIC_V2_LIMITS.WEEKLY_REVIEW;
    for (const perTrade of [1, 2, 3]) {
      m.state.rows = typical(trades, trades * perTrade);
      const facts = await load();
      expect(facts.trades).toHaveLength(trades);
      expect(facts.trades.reduce((n, trade) => n + (trade.journal?.length ?? 0), 0)).toBe(trades * perTrade);
    }
    m.state.rows = typical(trades, records);
    expect((await load()).trades).toHaveLength(trades);
    // Four entries per trade would fit the input limit (22.8k of 24k measured on seeded traders) but are above the bound.
    m.state.rows = typical(trades, trades * 4);
    await expect(load()).rejects.toThrow(WEEKLY_TOO_MANY_RECORDS);
    m.state.rows = typical(trades + 1, (trades + 1) * 2);
    m.state.queries = [];
    await expect(load()).rejects.toThrow(WEEKLY_TOO_MANY_TRADES);
    expect(m.state.queries.map(q => q.table)).toEqual(["accounts", "journal_analytics"]);
  });

  it("a full week with a note per trade fits; the same week with long journals is refused as a whole before anything is written", async () => {
    m.state.rows = periodicTables(periodicSourcesV2(20, { start: "2026-09-01T08:00:00.000Z", stepMinutes: 60, journal: 1 }));
    expect((await load()).trades).toHaveLength(20);
    // Within the record bound (70) but not within one request: every journal text at its bound, long theses, many tags.
    m.state.rows = periodicTables(periodicSourcesV2(20, { start: "2026-09-01T08:00:00.000Z", stepMinutes: 60, journal: 3, body: "Live note ".repeat(100) }));
    m.state.rows.trade_journal_entries = m.state.rows.trade_journal_entries.slice(0, 50);
    m.state.rows.trade_tag_sets = m.state.rows.trade_tag_sets.map(row => ({ ...row, tags: Array.from({ length: 12 }, (_, k) => `${k}-${"t".repeat(30)}`) }));
    m.state.rows.trade_plans = m.state.rows.trade_plans.map(row => ({ ...row, proposal: { ...(row.proposal as object), narrative: "Thesis ".repeat(1000) } }));
    m.state.queries = [];
    const records = m.state.rows.trade_journal_entries.length + m.state.rows.trade_events.filter(row => !["PLAN_LOCKED", "TRADE_OPENED", "TRADE_CLOSED"].includes(String(row.event_type))).length;
    expect(records).toBeLessThanOrEqual(PERIODIC_V2_LIMITS.WEEKLY_REVIEW.records);
    // The refusal says what the week holds and why it is too much, and what the trader can still do.
    await expect(load()).rejects.toThrow(weeklyTooLarge(20, records));
    expect(m.state.queries.map(q => q.table)).not.toContain("weekly_ai_reviews");
  });
});
