import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisOutput, ids as fixtureIds, source } from "./fixtures/analyze-setup";
import { challengeOutput } from "./fixtures/bias-challenge";

// Pre-trade AI on V2 drafts (spec §8.3, §11.3): Analyze Setup and Challenge My Bias always target the latest
// revision, accept the trade's V2 evidence and keep the V1 storage, authorization and accounting pipeline.

type Row = Record<string, unknown>;

const ids = {
  user: fixtureIds.user,
  account: fixtureIds.account,
  trade: "a0000000-0000-4000-8000-000000000001",
  revision1: "b0000000-0000-4000-8000-000000000001",
  latest: source.proposal.id,
  shotM5: "e0000000-0000-4000-8000-000000000001",
  shotEntry: "e0000000-0000-4000-8000-000000000002",
  shotRemoved: "e0000000-0000-4000-8000-000000000003",
  shotRelabelled: "e0000000-0000-4000-8000-000000000004",
  shotOtherTrade: "e0000000-0000-4000-8000-000000000005",
  legacyLatest: "e1000000-0000-4000-8000-000000000001",
  legacyRevision1: "e1000000-0000-4000-8000-000000000002",
  request: "70000000-0000-4000-8000-000000000001",
  reservation: "80000000-0000-4000-8000-000000000001",
};
const bytes = (seed: string) => Buffer.from(`synthetic-chart-${seed}`);
const digest = (seed: string) => createHash("sha256").update(bytes(seed)).digest("hex");

const m = vi.hoisted(() => ({
  db: null as unknown, load: vi.fn(), availability: vi.fn(), rpc: vi.fn(), gate: vi.fn(), reserve: vi.fn(), dispatch: vi.fn(), recheck: vi.fn(), settle: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({ db: m.db, user: { id: "10000000-0000-4000-8000-000000000001" } }) }));
vi.mock("@/lib/setup-data", () => ({ loadSetup: m.load }));
vi.mock("@/lib/ai-budget", () => ({ accountAiAvailability: m.availability, serverAiLedger: () => ({ reserve: m.reserve, dispatch: m.dispatch, recheck: m.recheck, settle: m.settle }) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({ rpc: m.rpc }) }));
vi.mock("@/ai/request-gate", () => ({ budgetedAiRequest: m.gate }));
import { operationContract } from "@/ai/operation-contract";
import { operationFor } from "@/ai/operations";
import { analyzeTradeSetup } from "@/lib/analyze-setup";
import { loadTradeAnalyzeSetupPanel } from "@/lib/analyze-setup-data";
import { challengeTradeBias } from "@/lib/bias-challenge";
import { loadTradeBiasChallengePanel } from "@/lib/bias-challenge-data";

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
      const conditions: ((row: Row) => boolean)[] = [];
      const result = (single: boolean) => {
        if (state.errors.has(table)) return { data: null, error: { message: "synthetic failure" }, count: null };
        const matching = (state.tables[table] ?? []).filter(row => conditions.every(condition => condition(row)));
        const rows = matching.slice(range[0], range[1] + 1);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: matching.length };
      };
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { query.filters.push([key, value]); conditions.push(row => read(row, key) === value); return chain; },
        in: (key: string, values: unknown[]) => { query.filters.push([key, values]); conditions.push(row => values.includes(read(row, key))); return chain; },
        order: () => chain,
        range: (from: number, to: number) => { range = [from, to]; return chain; },
        limit: () => chain,
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
    id: ids.trade, account_id: ids.account, origin: "PLANNED", created_at: "2026-09-23T06:00:00+00:00", duplicated_from: null, migrated_from: null, currency: "USD",
    revision_count: 2, latest_revision: 2, latest_proposal_id: ids.latest, latest_revision_at: "2026-09-23T07:00:00+00:00", latest_check_decision: "BLOCKED",
    latest_check_at: "2026-09-23T07:00:00+00:00", latest_check_evaluation_id: fixtureIds.event,
    plan_id: null, locked_at: null, plan_trading_day: null, strategy_version_id: null, strategy_version: null, risk_plan_version_id: null, risk_plan_version: null,
    symbol: "EURUSD", instrument_version_id: null, direction: "LONG", entry_model: "OB_FIRST_TOUCH",
    planned_entry: "1.1", planned_stop: "1.098", planned_target: "1.106", requested_risk_percent: "2", planned_rr: "3", planned_quantity: null, planned_risk: null,
    entry_price: null, entered_at: null, entry_time_known: false, entry_recorded_at: null, quantity: null, initial_stop: null, initial_risk: null, actual_initial_risk: null, oversize: null,
    exit_price: null, exited_at: null, close_recorded_at: null, fees: null, gross_pnl: null, net_pnl: null, realized_r: null, outcome: null, calculation_version: null, pnl_source: null,
    disposition: null, disposition_reason: null, legacy_decision: null, discarded_at: null, lifecycle: "DRAFT", draft_check: "BLOCKED", review_completed_at: null,
    setup_grade: null, liquidity_context: null, mss_timeframe: null, tags: [], tag_source: null,
    evidence_count: 4, cover_evidence_id: ids.shotM5, cover_evidence_kind: "V2", journal_count: 0, ai_review_count: 0, ...changes,
  };
}

const evidenceRow = (id: string, changes: Row = {}) => ({
  id, trade_id: ids.trade, user_id: ids.user, storage_path: `${ids.user}/${ids.trade}/${id}`, label: "PRE_ENTRY", timeframe: null, caption: null, original_filename: `${id}.png`,
  mime_type: "image/png", byte_size: bytes(id).length, sha256: digest(id), phase: "PRE_ENTRY", recorded_at: "2026-09-23T06:30:00+00:00", ...changes,
});
const legacyRow = (id: string, proposal: string) => ({
  id, proposal_id: proposal, user_id: ids.user, role: "H1", storage_path: `${ids.user}/${proposal}/${id}`, original_filename: "legacy.png", mime_type: "image/png",
  byte_size: bytes(id).length, sha256: digest(id), uploaded_at: "2026-09-23T06:10:00+00:00",
});

function seed(): Fake {
  const tables: Record<string, Row[]> = {
    trades: [{ id: ids.trade, user_id: ids.user }],
    trade_ledger: [ledger()],
    trade_revisions: [
      { trade_id: ids.trade, user_id: ids.user, proposal_id: ids.revision1, revision: 1 },
      { trade_id: ids.trade, user_id: ids.user, proposal_id: ids.latest, revision: 2 },
    ],
    trade_evidence: [
      evidenceRow(ids.shotM5, { timeframe: "M5" }),
      evidenceRow(ids.shotEntry, { label: "ENTRY" }),
      evidenceRow(ids.shotRemoved),
      evidenceRow(ids.shotRelabelled, { label: "OTHER" }),
      { ...evidenceRow(ids.shotOtherTrade), trade_id: "a0000000-0000-4000-8000-000000000009" },
    ],
    trade_evidence_removals: [{ evidence_id: ids.shotRemoved, trade_id: ids.trade, user_id: ids.user }],
    trade_evidence_labels: [{ id: 7, evidence_id: ids.shotRelabelled, trade_id: ids.trade, user_id: ids.user, label: "HTF", timeframe: "H4", caption: null }],
    setup_screenshots: [legacyRow(ids.legacyLatest, ids.latest), legacyRow(ids.legacyRevision1, ids.revision1)],
    setup_screenshot_removals: [],
    bias_challenges: [],
    bias_challenge_results: [],
    ai_request_reservations: [],
    ai_usage_records: [],
  };
  const files = new Map<string, Buffer>();
  for (const row of tables.trade_evidence) files.set(`trade-evidence/${row.storage_path}`, bytes(String(row.id)));
  for (const row of tables.setup_screenshots) files.set(`setup-screenshots/${row.storage_path}`, bytes(String(row.id)));
  return { tables, errors: new Set(), files, queries: [], downloads: [] };
}

const selectedOutput = { ...analysisOutput, evidenceStatus: "SELECTED_NOT_INDEPENDENTLY_VERIFIED" as const };
const rpcNames = () => m.rpc.mock.calls.map(call => call[0]);
const rpcArgs = (name: string) => m.rpc.mock.calls.find(call => call[0] === name)?.[1];
type LedgerApi = { reserve: (r: { id: string }) => Promise<void>; dispatch: (...a: string[]) => Promise<void>; recheck: (...a: string[]) => Promise<void> };
const runLedger = async (ledgerApi: LedgerApi) => {
  await ledgerApi.reserve({ id: ids.reservation });
  await ledgerApi.dispatch(ids.reservation, ids.user, "hash");
  await ledgerApi.recheck(ids.reservation, ids.user, "hash");
};
const respond = (output: unknown) => async (_input: unknown, _owner: unknown, ledgerApi: LedgerApi) => {
  await runLedger(ledgerApi);
  return { output: structuredClone(output) };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "mock-only");
  fake = seed();
  m.db = fakeDb(fake);
  m.load.mockResolvedValue({ ...structuredClone(source), user: { id: ids.user }, db: m.db, lock: null, screenshots: [], removals: [] });
  m.availability.mockResolvedValue({ status: "ENABLED", message: "AI analysis is available", deepEnabled: false });
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "start_bias_challenge" ? true : null, error: null }));
  m.gate.mockImplementation(respond(analysisOutput));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("V2 pre-trade requests: nothing is written or sent unless the latest draft can be analysed", () => {
  it("validates ids, selection size and duplicates before any database access", async () => {
    await expect(analyzeTradeSetup(ids.trade, "bad", [])).rejects.toThrow();
    await expect(analyzeTradeSetup(ids.trade, ids.request, Array(4).fill(ids.shotM5))).rejects.toThrow();
    await expect(challengeTradeBias(ids.trade, ids.request, [ids.shotM5, ids.shotM5])).rejects.toThrow(/Duplicate/);
    await expect(analyzeTradeSetup(ids.trade, ids.request, [], 0)).rejects.toThrow();
    expect(fake.queries).toEqual([]);
  });

  it("refuses trades of other users", async () => {
    await expect(analyzeTradeSetup("a0000000-0000-4000-8000-000000000009", ids.request, [])).rejects.toThrow(/Trade unavailable/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["a live-first trade", { origin: "LIVE_FIRST", revision_count: 0, latest_revision: null, latest_proposal_id: null, latest_revision_at: null, lifecycle: "LIVE", draft_check: null }, "NOT_PLANNED"],
    ["a locked plan", { plan_id: "30000000-0000-4000-8000-000000000099", lifecycle: "LOCKED", draft_check: null }, "LOCKED"],
    ["a discarded draft", { discarded_at: "2026-09-23T08:00:00+00:00", lifecycle: "DISCARDED", draft_check: null }, "NOT_DRAFT"],
    ["a legacy skipped draft", { legacy_decision: "SKIPPED", lifecycle: "SKIPPED", draft_check: null }, "NOT_DRAFT"],
  ])("%s returns %s without loading the proposal, writing or calling the provider", async (_label, changes, status) => {
    fake.tables.trade_ledger = [ledger(changes)];
    expect(await analyzeTradeSetup(ids.trade, ids.request, [])).toMatchObject({ status });
    expect(await challengeTradeBias(ids.trade, ids.request, [])).toMatchObject({ status });
    expect(m.availability).not.toHaveBeenCalled();
    expect(m.load).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a request made for a revision the page no longer shows", async () => {
    expect(await analyzeTradeSetup(ids.trade, ids.request, [], 1)).toMatchObject({ status: "DRAFT_CHANGED" });
    expect(m.load).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each(["DISABLED", "ACCOUNT_OFF", "BUDGET_REACHED", "CONFIGURATION_ERROR"])("%s blocks before the proposal is loaded", async status => {
    m.availability.mockResolvedValue({ status, message: "Blocked", deepEnabled: false });
    expect(await challengeTradeBias(ids.trade, ids.request, [ids.shotM5])).toEqual({ status, message: "Blocked" });
    expect(m.availability).toHaveBeenCalledWith(ids.account, "CHALLENGE_BIAS");
    expect(m.load).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.gate).not.toHaveBeenCalled();
  });

  it.each([
    ["removed evidence", ids.shotRemoved],
    ["another trade's evidence", ids.shotOtherTrade],
    ["a legacy screenshot of an earlier revision", ids.legacyRevision1],
    ["an unknown id", "e9000000-0000-4000-8000-000000000001"],
  ])("rejects %s before any download or write", async (_label, evidenceId) => {
    expect(await analyzeTradeSetup(ids.trade, ids.request, [evidenceId])).toMatchObject({ status: "EVIDENCE_UNAVAILABLE" });
    expect(fake.downloads).toEqual([]);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a V1 lock that bypassed the trade model still counts as locked", async () => {
    m.load.mockResolvedValue({ ...structuredClone(source), user: { id: ids.user }, db: m.db, lock: { plan_id: "30000000-0000-4000-8000-000000000099" }, screenshots: [], removals: [] });
    expect(await analyzeTradeSetup(ids.trade, ids.request, [])).toMatchObject({ status: "LOCKED" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses facts beyond the bounded pre-trade size", async () => {
    m.load.mockResolvedValue({ ...structuredClone(source), strategy: { ...source.strategy, rules: { notes: "x".repeat(70_000) } }, user: { id: ids.user }, db: m.db, lock: null });
    expect(await analyzeTradeSetup(ids.trade, ids.request, [])).toMatchObject({ status: "SCOPE_LIMIT" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("V2 pre-trade requests: lifecycle", () => {
  it("analyses the latest revision with V2 and legacy evidence downloaded from their own buckets", async () => {
    m.gate.mockImplementation(respond(selectedOutput));
    expect(await analyzeTradeSetup(ids.trade, ids.request, [ids.shotM5, ids.shotEntry, ids.legacyLatest], 2)).toMatchObject({ status: "COMPLETED" });
    expect(m.load).toHaveBeenCalledWith(ids.latest);
    expect(rpcNames()).toEqual(["start_bias_challenge", "authorize_bias_challenge", "authorize_bias_challenge", "authorize_bias_challenge", "finish_bias_challenge"]);
    const start = rpcArgs("start_bias_challenge");
    const sent = m.gate.mock.calls[0][0];
    expect(start).toMatchObject({ p_id: ids.request, p_user_id: ids.user, p_proposal_id: ids.latest, p_operation: { id: "ANALYZE_SETUP" } });
    expect(start.p_facts).toEqual(sent.context);
    expect(start.p_contract).toEqual(operationContract(operationFor("ANALYZE_SETUP"), sent.context));
    expect(start.p_contract.version).toBe("ANALYZE_SETUP_CITATIONS_V2");
    expect(sent.context).toMatchObject({ version: "ANALYZE_SETUP_FACTS_V1", proposalId: ids.latest });
    expect(sent.context.selectedEvidence).toEqual([
      { id: ids.shotM5, role: "M5", sha256: digest(ids.shotM5), mimeType: "image/png", bytes: bytes(ids.shotM5).length },
      { id: ids.shotEntry, role: "ENTRY", sha256: digest(ids.shotEntry), mimeType: "image/png", bytes: bytes(ids.shotEntry).length },
      { id: ids.legacyLatest, role: "H1", sha256: digest(ids.legacyLatest), mimeType: "image/png", bytes: bytes(ids.legacyLatest).length },
    ]);
    expect(sent.images.map((image: Row) => [image.sourceId, image.role])).toEqual([[`evidence:${ids.shotM5}`, "M5"], [`evidence:${ids.shotEntry}`, "ENTRY"], [`evidence:${ids.legacyLatest}`, "H1"]]);
    expect(fake.downloads).toEqual([
      { bucket: "trade-evidence", path: `${ids.user}/${ids.trade}/${ids.shotM5}` },
      { bucket: "trade-evidence", path: `${ids.user}/${ids.trade}/${ids.shotEntry}` },
      { bucket: "setup-screenshots", path: `${ids.user}/${ids.latest}/${ids.legacyLatest}` },
    ]);
    expect(JSON.stringify(sent.context)).not.toMatch(/storage|\.png"/);
    expect(m.reserve.mock.invocationCallOrder[0]).toBeGreaterThan(m.rpc.mock.invocationCallOrder[1]);
    expect(rpcArgs("finish_bias_challenge")).toEqual({
      p_id: ids.request, p_user_id: ids.user, p_status: "COMPLETED", p_interpretation: selectedOutput, p_error: null, p_raw: selectedOutput, p_reservation_id: ids.reservation,
    });
  });

  it("challenges the latest revision with the relabelled role of an evidence item", async () => {
    m.gate.mockImplementation(respond(challengeOutput));
    expect(await challengeTradeBias(ids.trade, ids.request, [ids.shotRelabelled])).toMatchObject({ status: "COMPLETED" });
    const sent = m.gate.mock.calls[0][0];
    expect(rpcArgs("start_bias_challenge")).toMatchObject({ p_proposal_id: ids.latest, p_operation: { id: "CHALLENGE_BIAS" } });
    expect(sent.context).toMatchObject({ version: "CHALLENGE_BIAS_FACTS_V1", selectedEvidence: [{ id: ids.shotRelabelled, role: "H4" }] });
    expect(rpcArgs("start_bias_challenge").p_contract.version).toBe("CHALLENGE_BIAS_CITATIONS_V2");
  });

  it.each([
    ["NOT_LATEST_REVISION: Only the latest draft revision (revision 3) can be analysed", "DRAFT_CHANGED"],
    ["PLAN_LOCKED: Plan already locked", "LOCKED"],
    ["Plan already locked", "LOCKED"],
    ["DRAFT_DISCARDED: This draft was discarded", "NOT_DRAFT"],
    ["Challenge already running", "IN_PROGRESS"],
  ])("maps the start refusal %j to %s without dispatch", async (message, status) => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message } });
    expect(await analyzeTradeSetup(ids.trade, ids.request, [])).toMatchObject({ status });
    expect(m.gate).not.toHaveBeenCalled();
  });

  it("an unexpected start failure throws without retrying", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "Proposal not found" } });
    await expect(challengeTradeBias(ids.trade, ids.request, [])).rejects.toThrow(/Unable to start the challenge/);
    expect(m.gate).not.toHaveBeenCalled();
  });

  it("a replayed request id never reaches the provider again", async () => {
    m.rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await analyzeTradeSetup(ids.trade, ids.request, [ids.shotM5])).toMatchObject({ status: "RECORDED" });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(fake.downloads).toEqual([]);
    expect(m.gate).not.toHaveBeenCalled();
  });

  it("changed evidence bytes fail the attempt before any reservation", async () => {
    fake.files.set(`trade-evidence/${ids.user}/${ids.trade}/${ids.shotM5}`, Buffer.from("tampered"));
    expect(await analyzeTradeSetup(ids.trade, ids.request, [ids.shotM5])).toMatchObject({ status: "FAILED" });
    expect(m.gate).not.toHaveBeenCalled();
    expect(rpcArgs("finish_bias_challenge")).toMatchObject({ p_status: "FAILED", p_error: "SCREENSHOT_CHANGED", p_reservation_id: null });
  });

  it("a draft or evidence change caught by authorization stops before the reservation", async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "start_bias_challenge" ? true : null, error: name === "authorize_bias_challenge" ? { message: "NOT_LATEST_REVISION: ..." } : null }));
    expect(await challengeTradeBias(ids.trade, ids.request, [])).toMatchObject({ status: "FAILED" });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(rpcArgs("finish_bias_challenge")).toMatchObject({ p_error: "PROPOSAL_OR_EVIDENCE_CHANGED", p_reservation_id: null });
  });

  it.each([
    [analyzeTradeSetup, { ...analysisOutput, decision: "APPROVED" }, "INVALID_ANALYSIS_OUTPUT"],
    [challengeTradeBias, { ...challengeOutput, invalidation: [{ text: "Take the trade.", sourceRefs: ["proposal"] }] }, "INVALID_CHALLENGE_OUTPUT"],
    [analyzeTradeSetup, selectedOutput, "INVALID_ANALYSIS_OUTPUT"],
  ])("persists invalid output %# as FAILED with the raw output and its reservation", async (run, output, code) => {
    m.gate.mockImplementation(respond(output));
    expect(await run(ids.trade, ids.request, [])).toMatchObject({ status: "FAILED" });
    expect(rpcArgs("finish_bias_challenge")).toMatchObject({ p_status: "FAILED", p_interpretation: null, p_error: code, p_raw: output, p_reservation_id: ids.reservation });
  });

  it.each([[analyzeTradeSetup, "ANALYSIS_FAILED"], [challengeTradeBias, "CHALLENGE_FAILED"]])("a provider failure is recorded once as %#", async (run, code) => {
    m.gate.mockRejectedValue(new Error("network"));
    expect(await run(ids.trade, ids.request, [])).toMatchObject({ status: "FAILED" });
    expect(m.gate).toHaveBeenCalledTimes(1);
    expect(rpcArgs("finish_bias_challenge")).toMatchObject({ p_error: code });
  });

  it("a finish persistence failure is reported without another generation", async () => {
    m.rpc.mockImplementation(async (name: string) => (name === "start_bias_challenge" ? { data: true, error: null } : name === "finish_bias_challenge" ? { data: null, error: { message: "down" } } : { data: null, error: null }));
    await expect(analyzeTradeSetup(ids.trade, ids.request, [])).rejects.toThrow(/finish saving/);
    expect(m.gate).toHaveBeenCalledTimes(1);
  });
});

describe("V2 pre-trade panels", () => {
  const operation = (id: string) => ({ id, version: `${id}_MINI_V1`, contract: `${id}_V1`, provider: "openai", model: "gpt-5.4-mini" });
  function history() {
    const factsLatest = { version: "ANALYZE_SETUP_FACTS_V1", proposalId: ids.latest, currentThesis: "Thesis", deterministic: { status: "TRADE_BLOCKED" } };
    fake.tables.bias_challenges = [
      { id: "71000000-0000-4000-8000-000000000001", user_id: ids.user, proposal_id: ids.latest, operation: operation("ANALYZE_SETUP"), facts: factsLatest, created_at: "2026-09-23T08:00:00+00:00", deadline_at: "2026-09-23T08:10:00+00:00" },
      { id: "71000000-0000-4000-8000-000000000002", user_id: ids.user, proposal_id: ids.latest, operation: operation("CHALLENGE_BIAS"), facts: factsLatest, created_at: "2026-09-23T07:59:00+00:00", deadline_at: "2026-09-23T08:09:00+00:00" },
      { id: "71000000-0000-4000-8000-000000000003", user_id: ids.user, proposal_id: ids.revision1, operation: operation("ANALYZE_SETUP"), facts: { ...factsLatest, proposalId: ids.revision1 }, created_at: "2026-09-23T06:20:00+00:00", deadline_at: "2026-09-23T06:30:00+00:00" },
      { id: "71000000-0000-4000-8000-000000000004", user_id: ids.user, proposal_id: ids.revision1, operation: operation("ANALYZE_SETUP"), facts: factsLatest, created_at: "2026-09-23T06:10:00+00:00", deadline_at: "2026-09-23T06:20:00+00:00" },
    ];
    fake.tables.bias_challenge_results = [
      { challenge_id: "71000000-0000-4000-8000-000000000001", status: "COMPLETED", interpretation: analysisOutput, error_code: null, reservation_id: null, created_at: "2026-09-23T08:01:00+00:00" },
      { challenge_id: "71000000-0000-4000-8000-000000000002", status: "COMPLETED", interpretation: challengeOutput, error_code: null, reservation_id: null, created_at: "2026-09-23T08:00:30+00:00" },
      { challenge_id: "71000000-0000-4000-8000-000000000003", status: "COMPLETED", interpretation: { setupStructure: "old shape" }, error_code: null, reservation_id: null, created_at: "2026-09-23T06:21:00+00:00" },
      { challenge_id: "71000000-0000-4000-8000-000000000004", status: "FAILED", interpretation: null, error_code: "SCREENSHOT_CHANGED", reservation_id: null, created_at: "2026-09-23T06:11:00+00:00" },
    ];
  }

  it("shows the latest revision, the Risk Engine decision, eligible evidence and this operation's history across revisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    history();
    const panel = await loadTradeAnalyzeSetupPanel(ids.trade);
    expect(m.gate).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(panel).toMatchObject({ operation: "ANALYZE_SETUP", state: "OPEN", stateMessage: null, revision: 2, riskDecision: "BLOCKED", maxEvidence: 3, estimate: { typicalMicros: 18500, maxMicros: 45540 }, error: null, hasOlder: false });
    expect(panel.evidence.map(item => [item.id, item.source, item.label, item.timeframe])).toEqual([
      [ids.shotM5, "TRADE_EVIDENCE", "PRE_ENTRY", "M5"], [ids.shotEntry, "TRADE_EVIDENCE", "ENTRY", null], [ids.shotRelabelled, "TRADE_EVIDENCE", "HTF", "H4"],
      [ids.legacyLatest, "LEGACY_SCREENSHOT", "HTF", "H1"],
    ]);
    expect(fake.queries.find(query => query.table === "bias_challenges")?.filters).toEqual([["operation->>id", "ANALYZE_SETUP"], ["proposal_id", [ids.revision1, ids.latest]], ["user_id", ids.user]]);
    expect(panel.history.map(row => [row.status, row.revision.number, row.revision.isLatestRevision, row.revision.staleLabel, row.technical.errorCode])).toEqual([
      ["COMPLETED", 2, true, null, null],
      ["FAILED", 1, false, "Based on draft revision 1 · current revision is 2", "UNREADABLE_RESULT"],
      ["FAILED", 1, false, "Based on draft revision 1 · current revision is 2", "SCREENSHOT_CHANGED"],
    ]);
    expect(panel.history[0].card?.headline.sources.map(chip => chip.label)).toEqual(["Trade plan", "Your thesis"]);
    expect(panel.history[0].headline).toMatch(/^The recorded long proposal defines entry, stop and target\./);
  });

  it("keeps history readable on locked trades but offers no evidence, and degrades on storage errors", async () => {
    history();
    fake.tables.trade_ledger = [ledger({ plan_id: "30000000-0000-4000-8000-000000000099", lifecycle: "LOCKED", draft_check: null })];
    const locked = await loadTradeBiasChallengePanel(ids.trade);
    expect(locked).toMatchObject({ operation: "CHALLENGE_BIAS", state: "LOCKED", stateMessage: expect.stringMatching(/already locked/), evidence: [] });
    expect(locked.history.map(row => row.status)).toEqual(["COMPLETED"]);
    expect(locked.history[0].card?.headlineTitle).toBe("Why your thesis might be wrong");
    fake.errors.add("bias_challenges");
    expect(await loadTradeBiasChallengePanel(ids.trade)).toMatchObject({ availability: { status: "CONFIGURATION_ERROR" }, history: [], evidence: [], error: expect.stringMatching(/unaffected/) });
  });
});
