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
  type AiAccounting, type AiRequestRow, historyRow, interpretationCard, loadAccounting, loadTradeAiHistory, resolveCardSources, timelineAiAnalyses, weekLabel,
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
  // Loaders read the clock (in-progress rows, budget months): pinned after every stored deadline.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
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
      status: "FAILED", failureReason: "The request did not finish in time.", accountingNote: "Nothing was charged for this attempt.", technical: { errorCode: "TIMED_OUT" },
    });
  });

  it("explains failures and accounting in plain words while technical details carry codes and amounts", () => {
    const row = historyRow("REVIEW_TRADE", base(), { status: "FAILED", interpretation: null, error_code: "ACCOUNTING_UNCERTAIN", reservation_id: ids.reservation, created_at: "2026-09-01T13:02:00+00:00" }, accounting, now);
    expect(row).toMatchObject({
      status: "FAILED", statusLabel: "Failed", failureReason: "The AI provider's usage could not be confirmed.",
      accountingNote: "The amount held for this attempt stays until an accounting review confirms the cost or releases it; nothing beyond it was charged.",
      technical: { requestId: request(1), operation: "REVIEW_TRADE", operationVersion: "REVIEW_TRADE_MINI_V1", contract: "REVIEW_TRADE_V1", provider: "openai", model: "gpt-5.4-mini", errorCode: "ACCOUNTING_UNCERTAIN", reservationId: ids.reservation, reservedMicros: 59400, chargedMicros: 59400, disposition: "UNCERTAIN", accountingReview: null },
    });
    expect(historyRow("REVIEW_TRADE", base(), { status: "FAILED", interpretation: null, error_code: "SOMETHING_NEW", reservation_id: null, created_at: "2026-09-01T13:02:00+00:00" }, { holds: [], usage: [] }, now).failureReason).toBe("The request did not complete.");
    const { technical, ...visible } = row;
    expect(technical.requestId).toBe(request(1));
    expect(JSON.stringify(visible)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|REVIEW_TRADE_V1|openai|UNCERTAIN"|59400/);
  });

  it("states the outcome of an accounting review of an unconfirmed cost, while the stored UNCERTAIN record stays as it was", () => {
    const result = { status: "FAILED" as const, interpretation: null, error_code: "ACCOUNTING_UNCERTAIN", reservation_id: ids.reservation, created_at: "2026-09-01T13:02:00+00:00" };
    const reviewed = (decision: "NO_PROVIDER_USAGE_CONFIRMED" | "USAGE_CONFIRMED", reconciled: number, released: number, additional: number, reservation = ids.reservation) =>
      historyRow("REVIEW_TRADE", base(), result, {
        ...accounting,
        reviews: [{ reservation_id: reservation, decision, reconciled_micros: reconciled, released_micros: released, additional_micros: additional, created_at: "2026-09-03T10:00:00+00:00" }],
      }, now);
    const released = reviewed("NO_PROVIDER_USAGE_CONFIRMED", 0, 59400, 0);
    expect(released).toMatchObject({
      failureReason: "The AI provider's usage could not be confirmed.",
      accountingNote: "Reviewed: the AI provider recorded no usage for this attempt, so nothing was charged and the held amount was released.",
      technical: {
        disposition: "UNCERTAIN", chargedMicros: 59400,
        accountingReview: { decision: "NO_PROVIDER_USAGE_CONFIRMED", reconciledMicros: 0, releasedMicros: 59400, additionalMicros: 0, reviewedAt: "2026-09-03T10:00:00+00:00" },
      },
    });
    // Whole cents, rounded up like the budget: 21,000 µ€ is €0.03.
    expect(reviewed("USAGE_CONFIRMED", 21000, 38400, 0).accountingNote).toBe("Reviewed: the confirmed cost of €0.03 is recorded, and the rest of the held amount was released.");
    expect(reviewed("USAGE_CONFIRMED", 59400, 0, 0).accountingNote).toBe("Reviewed: the confirmed cost of €0.06 is recorded.");
    // A cost above the hold states no separately rounded difference: 10,600 µ€ (€0.0106) would read as "€0.02 more".
    // The exact amounts stay in Technical details.
    const above = reviewed("USAGE_CONFIRMED", 70000, 0, 10600);
    expect(above.accountingNote).toBe("Reviewed: the confirmed cost of €0.07 is recorded. It was more than the amount held for this attempt, and all of it counts toward the AI budget.");
    expect(above.accountingNote?.match(/€\d+\.\d+/g)).toEqual(["€0.07"]);
    expect(above.technical.accountingReview).toMatchObject({ reconciledMicros: 70000, additionalMicros: 10600 });
    // A review of another hold changes nothing here.
    expect(reviewed("NO_PROVIDER_USAGE_CONFIRMED", 0, 59400, 0, "80000000-0000-4000-8000-000000000009")).toMatchObject({
      accountingNote: "The amount held for this attempt stays until an accounting review confirms the cost or releases it; nothing beyond it was charged.", technical: { accountingReview: null },
    });
    for (const row of [released, reviewed("USAGE_CONFIRMED", 21000, 38400, 0)]) expect(row.accountingNote).not.toMatch(/reserv|UNCERTAIN|USAGE_CONFIRMED/);
  });

  it("words a hold without a usage record by its budget month: nothing can review it, the monthly reset releases it", () => {
    // AI_ACCOUNTING_PERSISTENCE_FAILED: the usage record could not be written, so only the hold exists.
    const held: AiAccounting = { holds: [{ id: ids.reservation, operation_id: request(1), reserved_micros: 59400, period: "2026-09-01" }], usage: [] };
    const result = { status: "FAILED" as const, interpretation: null, error_code: "AI_ACCOUNTING_PERSISTENCE_FAILED", reservation_id: ids.reservation, created_at: "2026-09-01T13:02:00+00:00" };
    const during = historyRow("REVIEW_TRADE", base(), result, held, new Date("2026-09-20T12:00:00Z"));
    expect(during).toMatchObject({
      failureReason: "The cost of this request could not be recorded.",
      accountingNote: "The amount held for this attempt counts toward the AI budget of September 2026 until it resets on Oct 1; nothing beyond it was charged.",
      technical: { holdPeriod: "2026-09-01", holdExpired: false, disposition: null },
    });
    // The budget month ends at 00:00 fixed UTC−5: 04:59 UTC on Oct 1 is still September.
    expect(historyRow("REVIEW_TRADE", base(), result, held, new Date("2026-10-01T04:59:00Z")).technical.holdExpired).toBe(false);
    const after = historyRow("REVIEW_TRADE", base(), result, held, new Date("2026-10-01T05:00:00Z"));
    expect(after).toMatchObject({
      accountingNote: "The amount held for this attempt counted toward the AI budget of September 2026 only and was released when it reset on Oct 1; nothing beyond it was charged.",
      technical: { holdExpired: true },
    });
    // No promise of a review that cannot happen (private.resolve_ai_uncertainty resolves usage records only), and no
    // "reservation" wording in the default view.
    for (const row of [during, after]) expect(`${row.failureReason} ${row.accountingNote}`).not.toMatch(/review|reserv/i);
    // A hold that has a usage record never counts as released by the reset.
    expect(historyRow("REVIEW_TRADE", base(), result, { ...held, usage: [{ reservation_id: ids.reservation, charged_micros: 59400, disposition: "UNCERTAIN" }] }, new Date("2026-11-02T12:00:00Z")).technical.holdExpired).toBe(false);
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

  it("resolves the card of every completed review, V1 included, only when asked; the compact read needs no facts", async () => {
    seed();
    // The compact read (trade timeline) selects no facts: rows without them still load.
    const compact = await loadTradeAiHistory(ids.trade);
    expect(compact.error).toBeNull();
    expect(compact.reviews.map(row => row.card)).toEqual([undefined, undefined]);
    for (const row of [...fake.tables.trade_ai_reviews, ...fake.tables.trade_timeline_reviews]) row.facts = {};
    const full = await loadTradeAiHistory(ids.trade, { cards: true });
    expect(full.error).toBeNull();
    expect(full.reviews.map(row => [row.operation, row.card?.headlineTitle])).toEqual([["REVIEW_TRADE_TIMELINE", "Trade review"], ["REVIEW_TRADE", "Plan adherence"]]);
    // The V1 review keeps its own shape: six dimension chips and its lessons.
    expect(full.reviews[1].card?.chips).toHaveLength(6);
    expect(full.reviews[1].card?.full.map(section => section.title)).toContain("Lessons");
  });

  it("throws for a trade of another user and degrades when AI history cannot be read", async () => {
    seed();
    await expect(loadTradeAiHistory("a0000000-0000-4000-8000-000000000009")).rejects.toThrow(/Trade unavailable/);
    fake.errors.add("trade_timeline_review_results");
    expect(await loadTradeAiHistory(ids.trade)).toEqual({ latestRevision: null, preTrade: [], reviews: [], error: expect.stringMatching(/unaffected/) });
  });
});

describe("loadAccounting", () => {
  // Every live AI history (the trade page, the pre-trade and periodic panels, Review → History) reads its holds,
  // usage records and accounting reviews here, then words them with historyRow.
  const recent: AiRequestRow = { id: request(2), operation: operation("RECENT_TRADES_ANALYSIS"), created_at: "2026-09-08T12:00:00+00:00", deadline_at: "2026-09-08T12:10:00+00:00" };
  const result = { status: "FAILED" as const, interpretation: null, error_code: "INPUT_LIMIT_EXCEEDED", reservation_id: ids.reservation, created_at: "2026-09-08T12:01:00+00:00" };
  const load = (requestIds: readonly string[] = [request(2)]) => loadAccounting(m.db as Parameters<typeof loadAccounting>[0], ids.user, requestIds);
  function seed() {
    fake.tables = {
      ai_request_reservations: [
        { id: ids.reservation, operation_id: request(2), user_id: ids.user, reserved_micros: 67320 },
        // Never read: another user's hold (RLS, and the explicit owner filter).
        { id: "80000000-0000-4000-8000-000000000009", operation_id: request(2), user_id: "10000000-0000-4000-8000-000000000009", reserved_micros: 1 },
      ],
      ai_usage_records: [{ reservation_id: ids.reservation, user_id: ids.user, charged_micros: 67320, disposition: "UNCERTAIN" }],
    };
  }

  it("reads nothing without requests and only the owner's holds", async () => {
    seed();
    expect(await load([])).toEqual({ holds: [], usage: [], reviews: [] });
    expect((await load()).holds.map(hold => hold.id)).toEqual([ids.reservation]);
    fake.errors.add("ai_usage_records");
    await expect(load()).rejects.toThrow(/^AI accounting unavailable$/);
  });

  it("reads the owner's terminal accounting review of an unconfirmed cost and says what it settled", async () => {
    seed();
    fake.tables.ai_uncertainty_resolutions = [
      // Keeping the cost unconfirmed is no outcome: the hold stays.
      { reservation_id: ids.reservation, user_id: ids.user, decision: "KEEP_UNCERTAIN", reconciled_micros: 67320, released_micros: 0, additional_micros: 0, created_at: "2026-09-09T10:00:00+00:00" },
      // Never read: another user's row (RLS, and the explicit owner filter).
      { reservation_id: ids.reservation, user_id: "10000000-0000-4000-8000-000000000009", decision: "USAGE_CONFIRMED", reconciled_micros: 1, released_micros: 67319, additional_micros: 0, created_at: "2026-09-09T11:00:00+00:00" },
    ];
    const kept = await load();
    expect(kept.reviews).toEqual([]);
    expect(historyRow("RECENT_TRADES_ANALYSIS", recent, result, kept)).toMatchObject({
      failureReason: "The request was larger than the reviewed limit.", accountingNote: "The amount held for this attempt stays until an accounting review confirms the cost or releases it; nothing beyond it was charged.",
      technical: { reservedMicros: 67320, disposition: "UNCERTAIN", accountingReview: null },
    });
    fake.tables.ai_uncertainty_resolutions.push({
      reservation_id: ids.reservation, user_id: ids.user, decision: "NO_PROVIDER_USAGE_CONFIRMED", reconciled_micros: 0, released_micros: 67320, additional_micros: 0, created_at: "2026-09-10T10:00:00+00:00",
    });
    expect(historyRow("RECENT_TRADES_ANALYSIS", recent, result, await load())).toMatchObject({
      failureReason: "The request was larger than the reviewed limit.",
      accountingNote: "Reviewed: the AI provider recorded no usage for this attempt, so nothing was charged and the held amount was released.",
      technical: { disposition: "UNCERTAIN", chargedMicros: 67320, accountingReview: { decision: "NO_PROVIDER_USAGE_CONFIRMED", reconciledMicros: 0, releasedMicros: 67320 } },
    });
    // The review ledger fails like every other accounting read; each history turns that into its own message.
    fake.errors.add("ai_uncertainty_resolutions");
    await expect(load()).rejects.toThrow(/^AI accounting unavailable$/);
  });
});

describe("weekLabel", () => {
  it("labels weeks within and across months", () => {
    expect(weekLabel("2026-10-05")).toBe("Week of Oct 5–11");
    expect(weekLabel("2026-09-28")).toBe("Week of Sep 28–Oct 4");
  });
});
