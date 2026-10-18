import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan as v1Plan } from "./fixtures/trade-review";

// Orchestration of the timeline-aware trade review (spec §11.4) over the real data module and a fake Supabase
// client. The budget gate, ledger, availability and trusted RPC client are mocked; no provider is ever reached.

type Row = Record<string, unknown>;

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  account: "20000000-0000-4000-8000-000000000001",
  trade: "a0000000-0000-4000-8000-000000000001",
  live: "a0000000-0000-4000-8000-000000000002",
  foreign: "a0000000-0000-4000-8000-000000000009",
  plan: "30000000-0000-4000-8000-000000000001",
  proposal: "b0000000-0000-4000-8000-000000000001",
  evaluation: "b1000000-0000-4000-8000-000000000001",
  strategy: "40000000-0000-4000-8000-000000000001",
  risk: "50000000-0000-4000-8000-000000000001",
  instrument: "60000000-0000-4000-8000-000000000001",
  preEntryNote: "c0000000-0000-4000-8000-000000000001",
  stopChange: "c0000000-0000-4000-8000-000000000002",
  lesson: "c0000000-0000-4000-8000-000000000003",
  liveNote: "c0000000-0000-4000-8000-000000000004",
  preEntryShot: "e0000000-0000-4000-8000-000000000001",
  exitShot: "e0000000-0000-4000-8000-000000000002",
  removedShot: "e0000000-0000-4000-8000-000000000003",
  relabelledShot: "e0000000-0000-4000-8000-000000000004",
  liveShot: "e0000000-0000-4000-8000-000000000005",
  legacyShot: "e1000000-0000-4000-8000-000000000001",
  removedLegacyShot: "e1000000-0000-4000-8000-000000000002",
  siblingLegacyShot: "e1000000-0000-4000-8000-000000000003",
  /** A draft of the same user that is not a revision of the reviewed trade. */
  siblingProposal: "b0000000-0000-4000-8000-000000000002",
  position: "f0000000-0000-4000-8000-000000000001",
  request: "70000000-0000-4000-8000-000000000001",
  reservation: "80000000-0000-4000-8000-000000000001",
};
const THESIS = "London swept the Asian low; waiting for an M5 order block first touch.";
const bytes = (seed: string) => Buffer.from(`synthetic-chart-${seed}`);
const digest = (seed: string) => createHash("sha256").update(bytes(seed)).digest("hex");

const m = vi.hoisted(() => ({
  db: null as unknown, availability: vi.fn(), rpc: vi.fn(), gate: vi.fn(), reserve: vi.fn(), dispatch: vi.fn(), recheck: vi.fn(), settle: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: m.db, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability, serverAiLedger: () => ({ reserve: m.reserve, dispatch: m.dispatch, recheck: m.recheck, settle: m.settle }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({ rpc: m.rpc }) }));
vi.mock("@/ai/request-gate", () => ({ budgetedAiRequest: m.gate }));
import { operationContract } from "@/ai/operation-contract";
import { operationFor } from "@/ai/operations";
import { ProviderError } from "@/ai/provider";
import { loadTradeTimelineReviewPanel } from "@/lib/trade-timeline-review-data";
import { reviewTradeTimeline } from "@/lib/trade-timeline-review";

interface Fake {
  tables: Record<string, Row[]>;
  errors: Set<string>;
  files: Map<string, Buffer>;
  queries: { table: string; filters: [string, unknown][] }[];
  downloads: { bucket: string; path: string }[];
}
let fake: Fake;

function fakeDb(state: Fake) {
  const read = (row: Row, key: string) => {
    const [column, field] = key.split("->>");
    return field ? (row[column] as Row | undefined)?.[field] : row[column];
  };
  return {
    from(table: string) {
      const query = { table, filters: [] as [string, unknown][] };
      state.queries.push(query);
      let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];
      let limit = Number.MAX_SAFE_INTEGER;
      const conditions: ((row: Row) => boolean)[] = [];
      const result = (single: boolean) => {
        if (state.errors.has(table)) return { data: null, error: { message: "synthetic failure" }, count: null };
        const matching = (state.tables[table] ?? []).filter(row => conditions.every(condition => condition(row)));
        const rows = matching.slice(range[0], Math.min(range[1] + 1, range[0] + limit));
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: matching.length };
      };
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { query.filters.push([key, value]); conditions.push(row => read(row, key) === value); return chain; },
        in: (key: string, values: unknown[]) => { query.filters.push([key, values]); conditions.push(row => values.includes(read(row, key))); return chain; },
        order: () => chain,
        range: (from: number, to: number) => { range = [from, to]; return chain; },
        limit: (count: number) => { limit = count; return chain; },
        maybeSingle: async () => result(true),
        // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable; this fake models that interface.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result(false)).then(resolve, reject),
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          state.downloads.push({ bucket, path });
          const file = state.files.get(`${bucket}/${path}`);
          return file ? { data: new Blob([new Uint8Array(file)]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  };
}

function ledger(changes: Row = {}): Row {
  return {
    id: ids.trade, account_id: ids.account, origin: "PLANNED", created_at: "2026-09-01T06:00:00+00:00", duplicated_from: null, migrated_from: null, currency: "USD",
    revision_count: 1, latest_revision: 1, latest_proposal_id: ids.proposal, latest_revision_at: "2026-09-01T06:00:00+00:00", latest_check_decision: null, latest_check_at: null, latest_check_evaluation_id: null,
    plan_id: ids.plan, locked_at: "2026-09-01T07:00:00+00:00", plan_trading_day: "2026-09-01", strategy_version_id: ids.strategy, strategy_version: "ICT V1.0",
    risk_plan_version_id: ids.risk, risk_plan_version: "Risk Plan V1.0", symbol: "EURUSD", instrument_version_id: ids.instrument, direction: "LONG", entry_model: "OB_FIRST_TOUCH",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "0.5", planned_rr: "3", planned_quantity: "0.25", planned_risk: "50",
    entry_price: "1.1", entered_at: "2026-09-01T08:00:00+00:00", entry_time_known: true, entry_recorded_at: "2026-09-01T08:01:00+00:00", quantity: "0.25", initial_stop: "1.098",
    initial_risk: "50", actual_initial_risk: "50", oversize: false, exit_price: "1.106", exited_at: "2026-09-01T09:00:00+00:00", close_recorded_at: "2026-09-01T09:02:00+00:00",
    fees: "0", gross_pnl: "150", net_pnl: "150", realized_r: "3", outcome: "WIN", calculation_version: "FULL_CLOSE_V1", pnl_source: "CALCULATED",
    disposition: null, disposition_reason: null, legacy_decision: null, discarded_at: null, lifecycle: "CLOSED", draft_check: null, review_completed_at: null,
    setup_grade: "A", liquidity_context: null, mss_timeframe: null, tags: ["patient"], tag_source: "V2",
    evidence_count: 4, cover_evidence_id: ids.preEntryShot, cover_evidence_kind: "V2", journal_count: 3, ai_review_count: 0, ...changes,
  };
}

const liveLedger = () => ledger({
  id: ids.live, origin: "LIVE_FIRST", created_at: "2026-09-02T08:00:00+00:00", revision_count: 0, latest_revision: null, latest_proposal_id: null, latest_revision_at: null,
  plan_id: null, locked_at: null, plan_trading_day: null, strategy_version_id: null, strategy_version: null, risk_plan_version_id: null, risk_plan_version: null,
  planned_entry: null, planned_stop: null, planned_target: null, requested_risk_percent: null, planned_rr: null, planned_quantity: null, planned_risk: null,
  entered_at: "2026-09-02T07:55:00+00:00", entry_recorded_at: "2026-09-02T08:00:00+00:00", oversize: null, exited_at: "2026-09-02T09:00:00+00:00",
  close_recorded_at: "2026-09-02T09:01:00+00:00", net_pnl: "-40", gross_pnl: null, realized_r: "-0.8", outcome: "LOSS", calculation_version: "UNPLANNED_CLOSE_V1",
  pnl_source: "USER_REPORTED", setup_grade: null, tags: [], tag_source: null, cover_evidence_id: null, cover_evidence_kind: null,
});

const evidenceRow = (id: string, trade: string, changes: Row) => ({
  id, trade_id: trade, user_id: ids.user, storage_path: `${ids.user}/${trade}/${id}`, label: "OTHER", timeframe: null, caption: null, original_filename: `${id}.png`,
  mime_type: "image/png", byte_size: bytes(id).length, sha256: digest(id), phase: "PRE_ENTRY", recorded_at: "2026-09-01T06:45:00+00:00", ...changes,
});
const screenshotRow = (id: string, proposal: string, uploadedAt: string) => ({
  id, proposal_id: proposal, user_id: ids.user, role: "H1", storage_path: `${ids.user}/${proposal}/${id}`, original_filename: "legacy.png",
  mime_type: "image/png", byte_size: bytes(id).length, sha256: digest(id), uploaded_at: uploadedAt,
});

function seed(): Fake {
  const proposal = { ...v1Plan.proposal, narrative: THESIS };
  const tables: Record<string, Row[]> = {
    trades: [{ id: ids.trade, user_id: ids.user }, { id: ids.live, user_id: ids.user }],
    trade_ledger: [ledger(), liveLedger()],
    trade_revisions: [{ trade_id: ids.trade, user_id: ids.user, proposal_id: ids.proposal, revision: 1, created_at: "2026-09-01T06:00:00+00:00" }],
    trade_plans: [{ id: ids.plan, user_id: ids.user, proposal, risk_result: v1Plan.risk_result, nominal_risk: "50", locked_at: "2026-09-01T07:00:00+00:00", trading_day: "2026-09-01" }],
    strategy_versions: [{ id: ids.strategy, user_id: ids.user, account_id: ids.account, version: "ICT V1.0", rules: { minimum_rr: "3" }, created_at: "2026-01-01T00:00:00+00:00" }],
    risk_plan_versions: [{
      id: ids.risk, user_id: ids.user, version: "Risk Plan V1.0", effective_day: "2026-01-01", max_risk_percent: "0.5", default_risk_percent: null, max_daily_trades: 2,
      min_rr: "3", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: null,
    }],
    trade_events: [],
    trade_journal_entries: [
      { id: ids.preEntryNote, trade_id: ids.trade, user_id: ids.user, kind: "NOTE", body: "Waiting for the M5 shift.", details: {}, phase: "PRE_ENTRY", recorded_at: "2026-09-01T07:30:00+00:00" },
      { id: ids.stopChange, trade_id: ids.trade, user_id: ids.user, kind: "STOP_CHANGE", body: null, details: { price: "1.099" }, phase: "LIVE", recorded_at: "2026-09-01T08:30:00+00:00" },
      { id: ids.lesson, trade_id: ids.trade, user_id: ids.user, kind: "LESSON", body: "I knew it would reverse.", details: {}, phase: "POST_TRADE", recorded_at: "2026-09-01T09:30:00+00:00" },
      { id: ids.liveNote, trade_id: ids.live, user_id: ids.user, kind: "DECISION", body: "Holding the pullback.", details: {}, phase: "LIVE", recorded_at: "2026-09-02T08:20:00+00:00" },
    ],
    trade_position_facts: [{
      id: ids.position, trade_id: ids.live, user_id: ids.user, recorded_at: "2026-09-02T08:00:00+00:00", source: "USER", symbol: "EURUSD", direction: "LONG", entry_model: null,
      entry_price: "1.1", entered_at: "2026-09-02T07:55:00+00:00", quantity: "0.25", initial_stop: "1.098", risk_amount: "50",
    }],
    trade_unplanned_closes: [{ trade_id: ids.live, user_id: ids.user, risk_basis_source: "USER_REPORTED" }],
    trade_tag_sets: [{ id: 1, trade_id: ids.trade, user_id: ids.user, recorded_at: "2026-09-01T09:45:00+00:00" }],
    trade_tag_revisions: [],
    setup_proposals: [{ id: ids.proposal, user_id: ids.user, proposal }],
    setup_risk_checks: [{ id: 1, proposal_id: ids.proposal, user_id: ids.user, risk: { id: ids.evaluation, result: v1Plan.risk_result, recorded_at: "2026-09-01T06:00:01+00:00" } }],
    trade_evidence: [
      evidenceRow(ids.preEntryShot, ids.trade, { label: "PRE_ENTRY", timeframe: "M5" }),
      evidenceRow(ids.removedShot, ids.trade, {}),
      evidenceRow(ids.relabelledShot, ids.trade, { recorded_at: "2026-09-01T06:46:00+00:00" }),
      evidenceRow(ids.exitShot, ids.trade, { label: "EXIT", phase: "POST_TRADE", recorded_at: "2026-09-01T09:10:00+00:00" }),
      evidenceRow(ids.liveShot, ids.live, { label: "ENTRY", timeframe: "M5", phase: "LIVE", recorded_at: "2026-09-02T08:02:00+00:00" }),
    ],
    trade_evidence_removals: [{ evidence_id: ids.removedShot, trade_id: ids.trade, user_id: ids.user }],
    trade_evidence_labels: [{ id: 1, evidence_id: ids.relabelledShot, trade_id: ids.trade, user_id: ids.user, label: "HTF", timeframe: "H4", caption: "Weekly context" }],
    setup_screenshots: [
      screenshotRow(ids.legacyShot, ids.proposal, "2026-09-01T06:50:00+00:00"),
      screenshotRow(ids.removedLegacyShot, ids.proposal, "2026-09-01T06:51:00+00:00"),
      screenshotRow(ids.siblingLegacyShot, ids.siblingProposal, "2026-09-01T06:52:00+00:00"),
    ],
    setup_screenshot_removals: [{ screenshot_id: ids.removedLegacyShot, proposal_id: ids.proposal, user_id: ids.user }],
    trade_timeline_reviews: [],
    trade_timeline_review_results: [],
    ai_request_reservations: [],
    ai_usage_records: [],
  };
  const files = new Map<string, Buffer>();
  for (const row of tables.trade_evidence) files.set(`trade-evidence/${row.storage_path}`, bytes(String(row.id)));
  for (const row of tables.setup_screenshots) files.set(`setup-screenshots/${row.storage_path}`, bytes(String(row.id)));
  return { tables, errors: new Set(), files, queries: [], downloads: [] };
}

const plannedOutput = {
  headline: { text: "The recorded entry followed the locked plan.", sourceRefs: ["execution", "originalPlan"] },
  thesisCheck: { assessment: "CONSISTENT", text: "The pre-entry note matches the locked thesis.", sourceRefs: ["originalPlan", `journal:${ids.preEntryNote}`, `evidence:${ids.preEntryShot}`] },
  executionVsPlan: { assessment: "ALIGNED", text: "Entry and size match the plan.", sourceRefs: ["execution"] },
  liveManagement: { assessment: "DISCIPLINED", text: "One recorded stop change.", sourceRefs: [`journal:${ids.stopChange}`] },
  patterns: [],
  keyLesson: { text: "Keep recording the trigger before the entry.", sourceRefs: [`journal:${ids.preEntryNote}`] },
  limitations: [],
};
const liveOutput = {
  ...plannedOutput,
  headline: { text: "No pre-trade plan was recorded.", sourceRefs: ["execution"] },
  thesisCheck: { assessment: "NOT_RECORDED", text: "No thesis was recorded before execution.", sourceRefs: ["strategy"] },
  executionVsPlan: { assessment: "NO_PLAN", text: "Nothing to compare with.", sourceRefs: ["execution"] },
  liveManagement: { assessment: "DISCIPLINED", text: "One decision while live.", sourceRefs: [`journal:${ids.liveNote}`] },
  keyLesson: { text: "Record the thesis at entry.", sourceRefs: ["execution"] },
};

const rpcNames = () => m.rpc.mock.calls.map(call => call[0]);
const rpcArgs = (name: string) => m.rpc.mock.calls.find(call => call[0] === name)?.[1];
const ledgerCalls = async (_input: unknown, _owner: unknown, ledgerApi: { reserve: (r: { id: string }) => Promise<void>; dispatch: (...a: string[]) => Promise<void>; recheck: (...a: string[]) => Promise<void> }) => {
  await ledgerApi.reserve({ id: ids.reservation });
  await ledgerApi.dispatch(ids.reservation, ids.user, "hash");
  await ledgerApi.recheck(ids.reservation, ids.user, "hash");
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  fake = seed();
  m.db = fakeDb(fake);
  m.availability.mockResolvedValue({ status: "ENABLED", message: "AI analysis is available", deepEnabled: false });
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "start_trade_timeline_review" ? true : null, error: null }));
  m.gate.mockImplementation(async (input: unknown, owner: unknown, ledgerApi: Parameters<typeof ledgerCalls>[2]) => {
    await ledgerCalls(input, owner, ledgerApi);
    return { output: structuredClone(plannedOutput), model: "gpt-5.4-mini", usage: { input_tokens: 9000, output_tokens: 900 }, responseId: "resp_mock" };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("reviewTradeTimeline: nothing is written or sent unless the request can run", () => {
  it("validates ids and the selection before any database access", async () => {
    await expect(reviewTradeTimeline(ids.trade, "not-a-uuid", [])).rejects.toThrow();
    await expect(reviewTradeTimeline(ids.trade, ids.request, Array(5).fill(ids.preEntryShot))).rejects.toThrow();
    await expect(reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot, ids.preEntryShot])).rejects.toThrow(/Duplicate/);
    expect(fake.queries).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses trades of other users without privileged writes", async () => {
    await expect(reviewTradeTimeline(ids.foreign, ids.request, [])).rejects.toThrow(/Trade unavailable/);
    expect(fake.queries[0]).toEqual({ table: "trades", filters: [["id", ids.foreign], ["user_id", ids.user]] });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it("requires a closed trade", async () => {
    fake.tables.trade_ledger = [ledger({ lifecycle: "LIVE", exit_price: null, exited_at: null, close_recorded_at: null, outcome: null, net_pnl: null, gross_pnl: null, realized_r: null, fees: null, calculation_version: null, pnl_source: null })];
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status: "NOT_CLOSED" });
    expect(m.availability).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each(["DISABLED", "ACCOUNT_OFF", "BUDGET_REACHED", "CONFIGURATION_ERROR"])("%s returns without loading records, writing or calling the provider", async status => {
    m.availability.mockResolvedValue({ status, message: "Blocked", deepEnabled: false });
    expect(await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot])).toEqual({ status, message: "Blocked" });
    expect(m.availability).toHaveBeenCalledWith(ids.account, "REVIEW_TRADE_TIMELINE");
    expect(fake.queries.map(query => query.table)).toEqual(["trades", "trade_ledger"]);
    expect(fake.downloads).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each([
    ["removed", ids.removedShot],
    ["another trade's", ids.liveShot],
    ["removed legacy", ids.removedLegacyShot],
    ["another draft's legacy", ids.siblingLegacyShot],
    ["unknown", "e9000000-0000-4000-8000-000000000001"],
  ])("rejects %s evidence before any download or write", async (_label, evidenceId) => {
    expect(await reviewTradeTimeline(ids.trade, ids.request, [evidenceId])).toMatchObject({ status: "EVIDENCE_UNAVAILABLE" });
    expect(fake.downloads).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses trades whose records exceed one bounded review, without truncating them", async () => {
    fake.tables.trade_journal_entries = Array.from({ length: 40 }, (_, index) => ({
      id: `c1000000-0000-4000-8000-${String(index).padStart(12, "0")}`, trade_id: ids.trade, user_id: ids.user, kind: "NOTE", body: "Note", details: {}, phase: "LIVE", recorded_at: "2026-09-01T08:30:00+00:00",
    }));
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status: "SCOPE_LIMIT", message: expect.stringMatching(/at most 40/) });
    fake.tables.trade_journal_entries = Array.from({ length: 201 }, (_, index) => ({ ...fake.tables.trade_journal_entries[0], id: `c2000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status: "SCOPE_LIMIT" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("reviewTradeTimeline: request lifecycle", () => {
  it("stores the facts and manifest-bound contract, authorizes before every ledger step and appends the result", async () => {
    const result = await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot, ids.legacyShot, ids.exitShot]);
    expect(result).toMatchObject({ status: "COMPLETED" });
    expect(rpcNames()).toEqual(["start_trade_timeline_review", "authorize_trade_timeline_review", "authorize_trade_timeline_review", "authorize_trade_timeline_review", "finish_trade_timeline_review"]);
    const start = rpcArgs("start_trade_timeline_review");
    const sent = m.gate.mock.calls[0][0];
    expect(start).toMatchObject({ p_id: ids.request, p_user_id: ids.user, p_trade_id: ids.trade, p_operation: { id: "REVIEW_TRADE_TIMELINE", contract: "REVIEW_TRADE_TIMELINE_V1" } });
    expect(start.p_facts).toEqual(sent.context);
    expect(start.p_hash).toBe(createHash("sha256").update(JSON.stringify(start.p_facts)).digest("hex"));
    expect(start.p_contract).toEqual(operationContract(operationFor("REVIEW_TRADE_TIMELINE"), sent.context));
    expect(sent.context).toMatchObject({ version: "REVIEW_TRADE_TIMELINE_FACTS_V1", tradeId: ids.trade, origin: "PLANNED", planStatus: "LOCKED_PLAN" });
    expect(sent.context.evidence.map((item: Row) => [item.id, item.timing])).toEqual([[ids.preEntryShot, "BEFORE_ENTRY"], [ids.legacyShot, "BEFORE_ENTRY"], [ids.exitShot, "AFTER_CLOSE"]]);
    expect(sent.images.map((image: Row) => [image.sourceId, image.role])).toEqual([[`evidence:${ids.preEntryShot}`, "M5"], [`evidence:${ids.legacyShot}`, "H1"], [`evidence:${ids.exitShot}`, "EXIT"]]);
    expect(fake.downloads).toEqual([
      { bucket: "trade-evidence", path: `${ids.user}/${ids.trade}/${ids.preEntryShot}` },
      { bucket: "setup-screenshots", path: `${ids.user}/${ids.proposal}/${ids.legacyShot}` },
      { bucket: "trade-evidence", path: `${ids.user}/${ids.trade}/${ids.exitShot}` },
    ]);
    expect(JSON.stringify(sent.context)).not.toMatch(/storage_path|setup-screenshots|trade-evidence|\.png/);
    expect(sent.prior).toEqual([]);
    expect(m.gate.mock.calls[0][1]).toEqual({ userId: ids.user, accountId: ids.account, operationId: ids.request, stage: "A", operation: "REVIEW_TRADE_TIMELINE" });
    expect(m.reserve).toHaveBeenCalledWith({ id: ids.reservation });
    expect(m.reserve.mock.invocationCallOrder[0]).toBeGreaterThan(m.rpc.mock.invocationCallOrder[1]);
    expect(rpcArgs("finish_trade_timeline_review")).toEqual({
      p_id: ids.request, p_user_id: ids.user, p_status: "COMPLETED", p_interpretation: plannedOutput, p_error: null, p_raw: plannedOutput, p_reservation_id: ids.reservation,
    });
  });

  it("reviews a live-first trade with NO_PLAN_RECORDED facts", async () => {
    m.gate.mockImplementation(async (input: unknown, owner: unknown, ledgerApi: Parameters<typeof ledgerCalls>[2]) => {
      await ledgerCalls(input, owner, ledgerApi);
      return { output: structuredClone(liveOutput) };
    });
    expect(await reviewTradeTimeline(ids.live, ids.request, [ids.liveShot])).toMatchObject({ status: "COMPLETED" });
    const facts = m.gate.mock.calls[0][0].context;
    expect(facts).toMatchObject({ origin: "LIVE_FIRST", planStatus: "NO_PLAN_RECORDED", plan: null, riskVersion: null, deterministic: null });
    expect(facts.execution).toMatchObject({ riskBasisSource: "USER_REPORTED", currency: "USD" });
    expect(facts.timeline.every((item: Row) => item.timing !== "BEFORE_ENTRY")).toBe(true);
    expect(fake.queries.some(query => query.table === "trade_plans")).toBe(false);
  });

  it("a replayed request id is recorded once and never reaches the provider again", async () => {
    m.rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot])).toMatchObject({ status: "RECORDED" });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(fake.downloads).toEqual([]);
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each([
    ["REVIEW_IN_PROGRESS: Review already running", "IN_PROGRESS"],
    ["NOT_CLOSED: Close the trade before review", "NOT_CLOSED"],
    ["EVIDENCE_CHANGED: Selected evidence changed", "EVIDENCE_UNAVAILABLE"],
  ])("maps the start refusal %j to %s without dispatch", async (message, status) => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message } });
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status });
    expect(m.gate).not.toHaveBeenCalled();
  });

  it("an unexpected start failure is not retried and exposes no database detail", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "SCOPE_MISMATCH: Review facts do not describe this trade" } });
    await expect(reviewTradeTimeline(ids.trade, ids.request, [])).rejects.toThrow(/Unable to start the review/);
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each([
    ["changed bytes", (state: Fake) => state.files.set(`trade-evidence/${ids.user}/${ids.trade}/${ids.preEntryShot}`, Buffer.from("tampered")), "SCREENSHOT_CHANGED"],
    ["a missing file", (state: Fake) => state.files.delete(`trade-evidence/${ids.user}/${ids.trade}/${ids.preEntryShot}`), "SCREENSHOT_UNAVAILABLE"],
  ])("%s fails the attempt before any reservation", async (_label, mutate, code) => {
    mutate(fake);
    expect(await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot])).toMatchObject({ status: "FAILED" });
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(rpcArgs("finish_trade_timeline_review")).toMatchObject({ p_status: "FAILED", p_error: code, p_interpretation: null, p_reservation_id: null });
  });

  it.each([
    ["a hindsight thesis citation", { thesisCheck: { ...plannedOutput.thesisCheck, sourceRefs: [`journal:${ids.lesson}`] } }, "HINDSIGHT_CITATION"],
    ["a foreign citation", { headline: { ...plannedOutput.headline, sourceRefs: ["trade:a0000000-0000-4000-8000-000000000009"] } }, "FOREIGN_REVIEW_SOURCE"],
    ["a decision field", { decision: "APPROVED" }, "INVALID_REVIEW_OUTPUT"],
    ["a trading directive", { keyLesson: { ...plannedOutput.keyLesson, text: "Take the trade sooner." } }, "TRADING_DIRECTIVE"],
    ["a no-plan contradiction", { executionVsPlan: { ...plannedOutput.executionVsPlan, assessment: "NO_PLAN" } }, "NO_PLAN_CONTRADICTION"],
  ])("persists %s as FAILED with the raw output and the charged reservation", async (_label, change, code) => {
    const raw = { ...structuredClone(plannedOutput), ...change };
    const before = structuredClone(raw);
    m.gate.mockImplementation(async (input: unknown, owner: unknown, ledgerApi: Parameters<typeof ledgerCalls>[2]) => {
      await ledgerCalls(input, owner, ledgerApi);
      return { output: raw };
    });
    expect(await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot])).toMatchObject({ status: "FAILED" });
    expect(rpcArgs("finish_trade_timeline_review")).toEqual({
      p_id: ids.request, p_user_id: ids.user, p_status: "FAILED", p_interpretation: null, p_error: code, p_raw: before, p_reservation_id: ids.reservation,
    });
    expect(raw).toEqual(before);
    expect(m.gate).toHaveBeenCalledTimes(1);
  });

  it("a trade or evidence change caught by authorization stops before the reservation", async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "start_trade_timeline_review" ? true : null, error: name === "authorize_trade_timeline_review" ? { message: "EVIDENCE_CHANGED: Selected evidence changed" } : null }));
    m.gate.mockImplementation(async (_input: unknown, _owner: unknown, ledgerApi: Parameters<typeof ledgerCalls>[2]) => {
      await ledgerApi.reserve({ id: ids.reservation });
      return { output: plannedOutput };
    });
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status: "FAILED" });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(rpcArgs("finish_trade_timeline_review")).toMatchObject({ p_error: "TRADE_OR_EVIDENCE_CHANGED", p_reservation_id: null });
  });

  it.each([
    [new ProviderError("ACCOUNTING_UNCERTAIN"), "ACCOUNTING_UNCERTAIN"],
    [new Error("network"), "REVIEW_FAILED"],
  ])("records provider or accounting failure %s without retrying", async (error, code) => {
    m.gate.mockRejectedValue(error);
    expect(await reviewTradeTimeline(ids.trade, ids.request, [])).toMatchObject({ status: "FAILED" });
    expect(m.gate).toHaveBeenCalledTimes(1);
    expect(rpcArgs("finish_trade_timeline_review")).toMatchObject({ p_status: "FAILED", p_error: code, p_raw: null });
  });

  it("a finish persistence failure is reported and never triggers another generation", async () => {
    m.rpc.mockImplementation(async (name: string) => (name === "start_trade_timeline_review" ? { data: true, error: null } : name === "finish_trade_timeline_review" ? { data: null, error: { message: "down" } } : { data: null, error: null }));
    await expect(reviewTradeTimeline(ids.trade, ids.request, [])).rejects.toThrow(/finish saving/);
    expect(m.gate).toHaveBeenCalledTimes(1);
  });
});

describe("loadTradeTimelineReviewPanel", () => {
  function historyRows() {
    const base = { trade_id: ids.trade, user_id: ids.user, deadline_at: "2026-09-01T10:10:00+00:00" };
    const operation = { id: "REVIEW_TRADE_TIMELINE", version: "REVIEW_TRADE_TIMELINE_MINI_V1", contract: "REVIEW_TRADE_TIMELINE_V1", provider: "openai", model: "gpt-5.4-mini" };
    return [
      { ...base, id: "71000000-0000-4000-8000-000000000001", operation, created_at: "2026-09-01T10:05:00+00:00", deadline_at: "2999-01-01T00:00:00+00:00" },
      { ...base, id: "71000000-0000-4000-8000-000000000002", operation, created_at: "2026-09-01T10:04:00+00:00" },
      { ...base, id: "71000000-0000-4000-8000-000000000003", operation: { ...operation, contract: "REVIEW_TRADE_TIMELINE_V9" }, created_at: "2026-09-01T10:03:00+00:00" },
      { ...base, id: "71000000-0000-4000-8000-000000000004", operation, created_at: "2026-09-01T10:02:00+00:00" },
      { ...base, id: "71000000-0000-4000-8000-000000000005", operation, created_at: "2026-09-01T10:01:00+00:00" },
      { ...base, id: "71000000-0000-4000-8000-000000000006", operation, created_at: "2026-09-01T10:00:00+00:00" },
    ];
  }

  it("lists selectable evidence with timing and parses every history row by its stored contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const requests = historyRows();
    const facts = (await (async () => {
      await reviewTradeTimeline(ids.trade, ids.request, [ids.preEntryShot]);
      return m.gate.mock.calls[0][0].context;
    })());
    fake.tables.trade_timeline_reviews = requests.map(row => ({ ...row, facts }));
    fake.tables.trade_timeline_review_results = [
      { review_id: requests[1].id, status: "COMPLETED", interpretation: plannedOutput, error_code: null, reservation_id: ids.reservation, created_at: "2026-09-01T10:04:30+00:00" },
      { review_id: requests[2].id, status: "COMPLETED", interpretation: plannedOutput, error_code: null, reservation_id: null, created_at: "2026-09-01T10:03:30+00:00" },
      { review_id: requests[3].id, status: "COMPLETED", interpretation: { headline: "not the contract" }, error_code: null, reservation_id: null, created_at: "2026-09-01T10:02:30+00:00" },
      { review_id: requests[4].id, status: "FAILED", interpretation: null, error_code: "HINDSIGHT_CITATION", reservation_id: null, created_at: "2026-09-01T10:01:30+00:00" },
    ];
    fake.tables.ai_request_reservations = [{ id: ids.reservation, operation_id: requests[1].id, user_id: ids.user, reserved_micros: 47520 }];
    fake.tables.ai_usage_records = [{ reservation_id: ids.reservation, user_id: ids.user, charged_micros: 16000, disposition: "SETTLED", input_tokens: 9000, output_tokens: 900, response_id: "resp_mock" }];
    vi.clearAllMocks();

    const panel = await loadTradeTimelineReviewPanel(ids.trade);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(panel).toMatchObject({ closed: true, origin: "PLANNED", planStatus: "LOCKED_PLAN", maxEvidence: 4, estimate: { typicalMicros: 16000, maxMicros: 47520 }, error: null, hasOlder: false });
    expect(panel.evidence.map(item => [item.id, item.source, item.label, item.timeframe, item.timing])).toEqual([
      [ids.preEntryShot, "TRADE_EVIDENCE", "PRE_ENTRY", "M5", "BEFORE_ENTRY"],
      [ids.relabelledShot, "TRADE_EVIDENCE", "HTF", "H4", "BEFORE_ENTRY"],
      [ids.exitShot, "TRADE_EVIDENCE", "EXIT", null, "AFTER_CLOSE"],
      [ids.legacyShot, "LEGACY_SCREENSHOT", "HTF", "H1", "BEFORE_ENTRY"],
    ]);
    expect(panel.history.map(row => [row.status, row.technical.errorCode])).toEqual([
      ["IN_PROGRESS", null], ["COMPLETED", null], ["FAILED", "UNREADABLE_RESULT"], ["FAILED", "UNREADABLE_RESULT"], ["FAILED", "HINDSIGHT_CITATION"], ["FAILED", "TIMED_OUT"],
    ]);
    const completed = panel.history[1];
    expect(completed.review).toEqual(plannedOutput);
    expect(completed.headline).toBe("The recorded entry followed the locked plan.");
    expect(completed.card?.chips.map(chip => [chip.id, chip.assessmentLabel])).toEqual([["thesisCheck", "Consistent"], ["executionVsPlan", "Aligned"], ["liveManagement", "Disciplined"]]);
    expect(completed.card?.sections.find(section => section.id === "thesisCheck")?.items[0].sources.map(source => source.label)).toEqual(["Trade plan", "Pre-entry note · 02:30", "M5 chart"]);
    expect(completed.technical).toMatchObject({ reservationId: ids.reservation, reservedMicros: 47520, chargedMicros: 16000, disposition: "SETTLED", inputTokens: 9000, responseId: "resp_mock", contract: "REVIEW_TRADE_TIMELINE_V1" });
    expect(panel.history[4].failureReason).toBe("The AI supported the thesis check with records made after entry.");
    expect(panel.history[2]).toMatchObject({ card: null, review: null, failureReason: "This result was saved in a format this version cannot display." });
    const { technical: _technical, card: _card, review: _review, ...visible } = completed;
    expect(JSON.stringify(visible)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("keeps the trade page usable when AI history cannot be loaded or pricing has expired", async () => {
    fake.errors.add("trade_timeline_reviews");
    const failed = await loadTradeTimelineReviewPanel(ids.trade);
    expect(failed).toMatchObject({ availability: { status: "CONFIGURATION_ERROR" }, history: [], evidence: [], closed: true, error: expect.stringMatching(/unaffected/) });
    fake.errors.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    expect((await loadTradeTimelineReviewPanel(ids.trade)).estimate).toBeNull();
  });
});
