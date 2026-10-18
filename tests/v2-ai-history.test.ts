import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisOutput } from "./fixtures/analyze-setup";
import { challengeOutput } from "./fixtures/bias-challenge";
import { monthlyOutput } from "./fixtures/monthly-review";
import { recentOutput } from "./fixtures/recent-trades";
import { output as tradeReviewOutput } from "./fixtures/trade-review";
import { weeklyOutput } from "./fixtures/weekly-review";

// Compact AI history (spec §11.1): parsed by each request's stored contract version, never hidden on parse
// failure, raw identifiers only in `technical`, stale-revision markers for pre-trade analyses.

type Row = Record<string, unknown>;

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  account: "20000000-0000-4000-8000-000000000001",
  trade: "a0000000-0000-4000-8000-000000000001",
  plan: "30000000-0000-4000-8000-000000000001",
  revision1: "b0000000-0000-4000-8000-000000000001",
  revision2: "b0000000-0000-4000-8000-000000000002",
  reservation: "80000000-0000-4000-8000-000000000001",
};
const request = (n: number) => `71000000-0000-4000-8000-00000000000${n}`;

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: m.db, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
import { tradeTimelineReviewContext } from "@/ai/trade-timeline-review-context";
import {
  type AiAccounting, type AiRequestRow, historyRow, interpretationCard, loadAccountAiHistory, loadTradeAiHistory, resolveCardSources, timelineAiAnalyses, weekLabel,
} from "@/lib/ai-history";

interface Fake { tables: Record<string, Row[]>; errors: Set<string> }
let fake: Fake;

function fakeDb(state: Fake) {
  const read = (row: Row, key: string) => {
    const [column, field] = key.split("->>");
    return field ? (row[column] as Row | undefined)?.[field] : row[column];
  };
  return {
    from(table: string) {
      const conditions: ((row: Row) => boolean)[] = [];
      let limit = Number.MAX_SAFE_INTEGER;
      const result = (single: boolean) => {
        if (state.errors.has(table)) return { data: null, error: { message: "synthetic failure" } };
        const rows = (state.tables[table] ?? []).filter(row => conditions.every(condition => condition(row))).slice(0, limit);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      };
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { conditions.push(row => read(row, key) === value); return chain; },
        in: (key: string, values: unknown[]) => { conditions.push(row => values.includes(read(row, key))); return chain; },
        order: () => chain,
        limit: (count: number) => { limit = count; return chain; },
        maybeSingle: async () => result(true),
        // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable; this fake models that interface.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result(false)).then(resolve, reject),
      };
      return chain;
    },
  };
}

const operation = (id: string, contract = `${id === "RECENT_TRADES_ANALYSIS" ? "RECENT_TRADES" : id}_V1`) => ({ id, version: `${id}_MINI_V1`, contract, provider: "openai", model: "gpt-5.4-mini" });
const requestRow = (n: number, op: string, createdAt: string, extra: Row = {}): Row => ({
  id: request(n), user_id: ids.user, operation: operation(op), created_at: createdAt, deadline_at: "2026-09-23T00:00:00+00:00", ...extra,
});
const completed = (n: number, interpretation: unknown, at: string, key = "review_id"): Row => ({ [key]: request(n), status: "COMPLETED", interpretation, error_code: null, reservation_id: null, created_at: at });
const failed = (n: number, code: string, at: string, key = "review_id", reservation: string | null = null): Row => ({ [key]: request(n), status: "FAILED", interpretation: null, error_code: code, reservation_id: reservation, created_at: at });

const timelineOutput = {
  headline: { text: "The recorded entry followed the locked plan. More detail follows.", sourceRefs: ["execution"] },
  thesisCheck: { assessment: "CONSISTENT", text: "Held.", sourceRefs: ["originalPlan"] },
  executionVsPlan: { assessment: "ALIGNED", text: "Aligned.", sourceRefs: ["execution"] },
  liveManagement: { assessment: "NO_LIVE_RECORDS", text: "Nothing recorded while live.", sourceRefs: ["execution"] },
  patterns: [], keyLesson: { text: "Record the trigger.", sourceRefs: ["execution"] }, limitations: [],
};

beforeEach(() => {
  fake = { tables: {}, errors: new Set() };
  m.db = fakeDb(fake);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("historyRow", () => {
  const accounting: AiAccounting = {
    holds: [{ id: ids.reservation, operation_id: request(1), reserved_micros: 59400 }],
    usage: [{ reservation_id: ids.reservation, charged_micros: 59400, disposition: "UNCERTAIN", input_tokens: null, output_tokens: null, response_id: null }],
  };
  const base = (extra: Partial<AiRequestRow> = {}): AiRequestRow => ({ id: request(1), operation: operation("REVIEW_TRADE"), created_at: "2026-09-01T13:00:00+00:00", deadline_at: "2026-09-01T13:10:00+00:00", ...extra });
  const now = new Date("2026-09-01T13:05:00Z");

  it("derives completed, in-progress and timed-out rows with a strategy-time label", () => {
    const done = historyRow("REVIEW_TRADE", base(), { status: "COMPLETED", interpretation: tradeReviewOutput, error_code: null, reservation_id: null, created_at: "2026-09-01T13:01:00+00:00" }, { holds: [], usage: [] }, now);
    expect(done).toMatchObject({ status: "COMPLETED", statusLabel: "Completed", label: "Trade Review · Completed · 08:01", completedAt: "2026-09-01T13:01:00+00:00", failureReason: null, accountingNote: null });
    expect(done.headline).toBe(tradeReviewOutput.planAdherence.interpretation);
    expect(historyRow("REVIEW_TRADE", base(), null, { holds: [], usage: [] }, now)).toMatchObject({ status: "IN_PROGRESS", label: "Trade Review · In progress · 08:00", technical: { errorCode: null } });
    expect(historyRow("REVIEW_TRADE", base(), null, { holds: [], usage: [] }, new Date("2026-09-01T13:11:00Z"))).toMatchObject({
      status: "FAILED", failureReason: "The request did not finish in time.", accountingNote: "No reservation is recorded for this attempt.", technical: { errorCode: "TIMED_OUT" },
    });
  });

  it("explains failures and accounting in plain words while technical details carry codes and amounts", () => {
    const row = historyRow("REVIEW_TRADE", base(), { status: "FAILED", interpretation: null, error_code: "ACCOUNTING_UNCERTAIN", reservation_id: ids.reservation, created_at: "2026-09-01T13:02:00+00:00" }, accounting, now);
    expect(row).toMatchObject({
      status: "FAILED", statusLabel: "Failed", failureReason: expect.stringMatching(/could not be confirmed/), accountingNote: expect.stringMatching(/uncertain/i),
      technical: { requestId: request(1), operation: "REVIEW_TRADE", operationVersion: "REVIEW_TRADE_MINI_V1", contract: "REVIEW_TRADE_V1", provider: "openai", model: "gpt-5.4-mini", errorCode: "ACCOUNTING_UNCERTAIN", reservationId: ids.reservation, reservedMicros: 59400, chargedMicros: 59400, disposition: "UNCERTAIN" },
    });
    expect(historyRow("REVIEW_TRADE", base(), { status: "FAILED", interpretation: null, error_code: "SOMETHING_NEW", reservation_id: null, created_at: "2026-09-01T13:02:00+00:00" }, { holds: [], usage: [] }, now).failureReason).toBe("The request did not complete.");
    const { technical, ...visible } = row;
    expect(technical.requestId).toBe(request(1));
    expect(JSON.stringify(visible)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|REVIEW_TRADE_V1|openai|UNCERTAIN"|59400/);
  });

  it("parses each row by its stored contract and degrades unknown or malformed results to a failed-style row", () => {
    const result = (interpretation: unknown) => ({ status: "COMPLETED" as const, interpretation, error_code: null, reservation_id: null, created_at: "2026-09-01T13:01:00+00:00" });
    expect(historyRow("REVIEW_TRADE", base({ operation: operation("REVIEW_TRADE", "REVIEW_TRADE_V2") }), result(tradeReviewOutput), { holds: [], usage: [] }, now))
      .toMatchObject({ status: "FAILED", headline: null, failureReason: "This result was saved in a format this version cannot display.", technical: { errorCode: "UNREADABLE_RESULT", contract: "REVIEW_TRADE_V2" } });
    expect(historyRow("REVIEW_TRADE", base(), result({ planAdherence: "?" }), { holds: [], usage: [] }, now)).toMatchObject({ status: "FAILED", technical: { errorCode: "UNREADABLE_RESULT" } });
    // Rows written before contracts were stored on the request fall back to the operation's first contract.
    expect(historyRow("REVIEW_TRADE", base({ operation: { id: "REVIEW_TRADE" } }), result(tradeReviewOutput), { holds: [], usage: [] }, now)).toMatchObject({ status: "COMPLETED", technical: { contract: "REVIEW_TRADE_V1" } });
  });

  it.each([
    ["ANALYZE_SETUP_V1", analysisOutput, "Setup"], ["CHALLENGE_BIAS_V1", challengeOutput, "Why your thesis might be wrong"], ["REVIEW_TRADE_V1", tradeReviewOutput, "Plan adherence"],
    ["REVIEW_TRADE_TIMELINE_V1", timelineOutput, "Trade review"], ["WEEKLY_REVIEW_V1", weeklyOutput, "Summary"], ["RECENT_TRADES_V1", recentOutput, "Summary"], ["MONTHLY_REVIEW_V1", monthlyOutput, "Summary"],
  ])("summarises %s with the domain summarizer", (contract, interpretation, headlineTitle) => {
    expect(interpretationCard(contract, interpretation)?.headlineTitle).toBe(headlineTitle);
    expect(interpretationCard(contract, { unexpected: true })).toBeNull();
  });

  it("feeds the trade timeline with compact AI items", () => {
    const row = historyRow("REVIEW_TRADE_TIMELINE", base({ operation: operation("REVIEW_TRADE_TIMELINE") }), { status: "COMPLETED", interpretation: timelineOutput, error_code: null, reservation_id: null, created_at: "2026-09-01T13:01:00+00:00" }, { holds: [], usage: [] }, now);
    expect(timelineAiAnalyses([row])).toEqual([{ id: request(1), operation: "REVIEW_TRADE_TIMELINE", status: "COMPLETED", recordedAt: "2026-09-01T13:01:00+00:00", summary: "The recorded entry followed the locked plan." }]);
  });
});

describe("resolveCardSources", () => {
  it("gives every timeline record of a trade review a friendly chip and keeps raw ids technical", () => {
    const trade = "a0000000-0000-4000-8000-000000000003";
    const journal = "c0000000-0000-4000-8000-000000000001";
    const position = "f0000000-0000-4000-8000-000000000001";
    const evidence = "e0000000-0000-4000-8000-000000000001";
    const facts = tradeTimelineReviewContext({
      trade: {
        id: trade, account_id: ids.account, origin: "LIVE_FIRST", created_at: "2026-09-02T13:00:00Z", currency: "USD", lifecycle: "CLOSED", plan_id: null, symbol: "EURUSD",
        direction: "LONG", entry_model: null, planned_quantity: null, planned_rr: null, entry_price: "1.1", entered_at: "2026-09-02T12:55:00Z", entry_recorded_at: "2026-09-02T13:00:00Z",
        quantity: "0.25", oversize: null, exit_price: "1.11", exited_at: "2026-09-02T14:00:00Z", close_recorded_at: "2026-09-02T14:01:00Z", fees: "0", net_pnl: "250",
        realized_r: null, outcome: "WIN", pnl_source: "CALCULATED",
      },
      plan: null, strategy: { id: "40000000-0000-4000-8000-000000000001", version: "ICT V1.0", rules: {} }, riskVersion: null, revisions: [], riskChecks: [], legacyEvents: [],
      journal: [{ id: journal, kind: "NOTE", body: "Holding.", details: {}, phase: "LIVE", recordedAt: "2026-09-02T13:20:00Z" }],
      positionFacts: [{ id: position, recordedAt: "2026-09-02T13:00:00Z", source: "USER", symbol: "EURUSD", direction: "LONG", entryModel: null, entryPrice: "1.1", enteredAt: "2026-09-02T12:55:00Z", quantity: "0.25", initialStop: null, riskAmount: null }],
      riskBasisSource: null, tags: { setupGrade: null, liquidityContext: null, mssTimeframe: null, tags: [], source: null, recordedAt: null },
      evidence: [{ id: evidence, label: "ENTRY", timeframe: null, storedPhase: "LIVE", recordedAt: "2026-09-02T13:05:00Z", sha256: "a".repeat(64), mimeType: "image/png", byteSize: 10 }],
    }, "2026-09-02T15:00:00Z");
    const card = interpretationCard("REVIEW_TRADE_TIMELINE_V1", {
      ...timelineOutput,
      headline: { text: "Headline.", sourceRefs: [`position:${position}`, `journal:${journal}`, `close:${trade}`, `evidence:${evidence}`] },
      thesisCheck: { assessment: "NOT_RECORDED", text: "None.", sourceRefs: ["strategy"] },
      executionVsPlan: { assessment: "NO_PLAN", text: "None.", sourceRefs: ["execution", "tags"] },
    });
    if (!card) throw new Error("card expected");
    const resolved = resolveCardSources(card, facts, facts.sourceManifest);
    expect(resolved.headline.sources.map(chip => [chip.label, chip.kind, chip.href])).toEqual([
      ["Entry details · 07:55", "event", `#entry:${trade}`],
      ["Live note · 08:20", "note", `#journal:${journal}`],
      ["Exit · 09:00", "event", `#close:${trade}`],
      ["Entry screenshot", "evidence", `#evidence-${evidence}`],
    ]);
    expect(resolved.headline.sources.map(chip => chip.technicalId)).toEqual([`position:${position}`, `journal:${journal}`, `close:${trade}`, `evidence:${evidence}`]);
    expect(resolved.full.find(section => section.id === "executionVsPlan")?.items[0].sources.map(chip => chip.label)).toEqual(["Execution", "Your tags"]);
  });
});

describe("loadTradeAiHistory", () => {
  function seed() {
    fake.tables = {
      trades: [{ id: ids.trade, user_id: ids.user }],
      trade_revisions: [
        { trade_id: ids.trade, user_id: ids.user, proposal_id: ids.revision1, revision: 1 },
        { trade_id: ids.trade, user_id: ids.user, proposal_id: ids.revision2, revision: 2 },
      ],
      trade_plan_links: [{ trade_id: ids.trade, user_id: ids.user, plan_id: ids.plan }],
      bias_challenges: [
        requestRow(1, "ANALYZE_SETUP", "2026-09-01T06:10:00+00:00", { proposal_id: ids.revision1 }),
        requestRow(2, "CHALLENGE_BIAS", "2026-09-01T06:40:00+00:00", { proposal_id: ids.revision2 }),
        requestRow(3, "ANALYZE_SETUP", "2026-09-01T06:45:00+00:00", { proposal_id: ids.revision2 }),
      ],
      bias_challenge_results: [
        completed(1, analysisOutput, "2026-09-01T06:11:00+00:00", "challenge_id"),
        completed(2, challengeOutput, "2026-09-01T06:41:00+00:00", "challenge_id"),
        failed(3, "SCREENSHOT_CHANGED", "2026-09-01T06:46:00+00:00", "challenge_id"),
      ],
      trade_ai_reviews: [requestRow(4, "REVIEW_TRADE", "2026-09-01T10:00:00+00:00", { plan_id: ids.plan })],
      trade_ai_review_results: [completed(4, tradeReviewOutput, "2026-09-01T10:01:00+00:00")],
      trade_timeline_reviews: [requestRow(5, "REVIEW_TRADE_TIMELINE", "2026-09-01T11:00:00+00:00", { trade_id: ids.trade })],
      trade_timeline_review_results: [completed(5, timelineOutput, "2026-09-01T11:01:00+00:00")],
      ai_request_reservations: [],
      ai_usage_records: [],
    };
  }

  it("groups pre-trade analyses by revision with the stale marker and lists V1 and timeline reviews newest first", async () => {
    seed();
    const history = await loadTradeAiHistory(ids.trade);
    expect(history.error).toBeNull();
    expect(history.latestRevision).toBe(2);
    expect(history.preTrade.map(group => [group.number, group.isLatestRevision, group.staleLabel, group.rows.map(row => [row.operation, row.status])])).toEqual([
      [2, true, null, [["ANALYZE_SETUP", "FAILED"], ["CHALLENGE_BIAS", "COMPLETED"]]],
      [1, false, "Based on draft revision 1 · current revision is 2", [["ANALYZE_SETUP", "COMPLETED"]]],
    ]);
    expect(history.reviews.map(row => [row.operation, row.status, row.headline])).toEqual([
      ["REVIEW_TRADE_TIMELINE", "COMPLETED", "The recorded entry followed the locked plan."],
      ["REVIEW_TRADE", "COMPLETED", tradeReviewOutput.planAdherence.interpretation],
    ]);
    const visible = [...history.preTrade.flatMap(group => group.rows), ...history.reviews].map(({ technical: _technical, ...row }) => row);
    expect(JSON.stringify(visible)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  it("throws for a trade of another user and degrades when AI history cannot be read", async () => {
    seed();
    await expect(loadTradeAiHistory("a0000000-0000-4000-8000-000000000009")).rejects.toThrow(/Trade unavailable/);
    fake.errors.add("trade_timeline_review_results");
    expect(await loadTradeAiHistory(ids.trade)).toEqual({ latestRevision: null, preTrade: [], reviews: [], error: expect.stringMatching(/unaffected/) });
  });
});

describe("loadAccountAiHistory", () => {
  function seed() {
    fake.tables = {
      accounts: [{ id: ids.account, user_id: ids.user }],
      weekly_ai_reviews: [requestRow(1, "WEEKLY_REVIEW", "2026-09-07T12:00:00+00:00", { account_id: ids.account, week_start: "2026-08-31" })],
      weekly_ai_review_results: [completed(1, weeklyOutput, "2026-09-07T12:01:00+00:00")],
      recent_ai_analyses: [requestRow(2, "RECENT_TRADES_ANALYSIS", "2026-09-08T12:00:00+00:00", { account_id: ids.account, requested_sample: 20, actual_sample: 12 })],
      recent_ai_analysis_results: [failed(2, "INPUT_LIMIT_EXCEEDED", "2026-09-08T12:01:00+00:00", "review_id", ids.reservation)],
      monthly_ai_reviews: [requestRow(3, "MONTHLY_REVIEW", "2026-09-02T12:00:00+00:00", { account_id: ids.account, month_start: "2026-08-01" })],
      monthly_ai_review_results: [completed(3, monthlyOutput, "2026-09-02T12:01:00+00:00")],
      ai_request_reservations: [{ id: ids.reservation, operation_id: request(2), user_id: ids.user, reserved_micros: 67320 }],
      ai_usage_records: [{ reservation_id: ids.reservation, user_id: ids.user, charged_micros: 67320, disposition: "UNCERTAIN" }],
    };
  }

  it("lists weekly, recent and monthly reviews newest first with their scope in words", async () => {
    seed();
    const history = await loadAccountAiHistory(ids.account);
    expect(history.rows.map(row => [row.operation, row.status, row.scopeLabel])).toEqual([
      ["RECENT_TRADES_ANALYSIS", "FAILED", "Last 12 trades (20 requested)"],
      ["WEEKLY_REVIEW", "COMPLETED", "Week of Aug 31–Sep 6"],
      ["MONTHLY_REVIEW", "COMPLETED", "August 2026"],
    ]);
    expect(history.rows[0]).toMatchObject({ failureReason: "The request was larger than the reviewed limit.", accountingNote: expect.stringMatching(/uncertain/i), technical: { reservedMicros: 67320, disposition: "UNCERTAIN" } });
    expect(history.rows[1].scope).toEqual({ kind: "WEEK", weekStart: "2026-08-31" });
  });

  it("filters by operation, limits the rows, refuses foreign accounts and degrades on read errors", async () => {
    seed();
    expect((await loadAccountAiHistory(ids.account, { operations: ["MONTHLY_REVIEW"] })).rows.map(row => row.operation)).toEqual(["MONTHLY_REVIEW"]);
    expect((await loadAccountAiHistory(ids.account, { limit: 1 })).rows.map(row => row.operation)).toEqual(["RECENT_TRADES_ANALYSIS"]);
    await expect(loadAccountAiHistory("20000000-0000-4000-8000-000000000009")).rejects.toThrow(/Account unavailable/);
    fake.errors.add("monthly_ai_reviews");
    expect(await loadAccountAiHistory(ids.account)).toEqual({ rows: [], error: expect.stringMatching(/unaffected/) });
  });

  it("labels weeks within and across months", () => {
    expect(weekLabel("2026-10-05")).toBe("Week of Oct 5–11");
    expect(weekLabel("2026-09-28")).toBe("Week of Sep 28–Oct 4");
  });
});
