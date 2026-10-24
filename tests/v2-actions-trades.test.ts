import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// V2 trade and journal server actions (docs/V2_ARCHITECTURE.md §2.4–2.5, §3.4–3.8, §8, §12.2, §13.10): schema gate
// first, zod validation with field copy, exact RPC arguments, human copy for every SQL error prefix, revalidation of
// the affected routes, the oversize confirmation of §8.5, and unstable_rethrow before any error handling.

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  revalidate: vi.fn(),
  rethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
  }),
  log: vi.fn(),
  copy: vi.fn(),
  session: null as unknown,
  sessionError: null as Error | null,
  cookieSets: [] as [string, string, Record<string, unknown>][],
  headers: new Map<string, string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ unstable_rethrow: m.rethrow }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => { m.cookieSets.push([name, value, options]); },
    delete: () => undefined,
  }),
  headers: async () => ({ get: (name: string) => m.headers.get(name) ?? null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: async () => {
    if (m.sessionError) throw m.sessionError;
    return m.session;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.log }));
vi.mock("@/lib/evidence", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/evidence")>()), copyEvidenceForDuplicate: m.copy }));

import { addJournalEntry } from "@/app/actions/journal";
import { errorCode, idleState, rpcErrorCopy, SCHEMA_ERROR_COPY, SQL_ERROR_COPY } from "@/app/actions/state";
import { SCHEMA_OUTDATED_MESSAGE } from "@/lib/schema-gate";
import {
  checkRisk, closeLiveTrade, closePlannedTrade, completeLiveEntry, completeReview, createPlannedTrade, discardDraft, duplicateDraft, lockPlan, recordEntry,
  recordLiveTrade, relabelEvidence, removeEvidence, reopenReview, reviseDraft, setDisposition, setTags,
} from "@/app/actions/trades";
import { evaluateRisk } from "@/domain/risk";
import { INVALID_INPUT_FIELD_COPY } from "@/domain/risk-explain";

// ---------------------------------------------------------------------------------------------------------------------
class Chain {
  private readonly predicates: ((row: Row) => boolean)[] = [];
  private single = false;
  constructor(private readonly rows: Row[]) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.predicates.push(row => row[column] === value); return this; }
  in(column: string, values: unknown[]): this { this.predicates.push(row => values.includes(row[column])); return this; }
  lte(column: string, value: string): this { this.predicates.push(row => String(row[column]) <= value); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): this { this.single = true; return this; }
  private run() {
    const rows = this.rows.filter(row => this.predicates.every(predicate => predicate(row)));
    return { data: this.single ? rows[0] ?? null : rows, error: null };
  }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: unknown; error: null }) => A): Promise<A> {
    return Promise.resolve(this.run()).then(resolve);
  }
}

class ActionDb {
  readonly results: Record<string, (args: Row) => { data: unknown; error: { message: string; code?: string } | null }> = {
    trading_os_schema: () => ({ data: "2.0", error: null }),
  };
  readonly rpc = vi.fn(async (fn: string, args: Row = {}) => this.results[fn]?.(args) ?? { data: null, error: { message: `unexpected rpc ${fn}` } });
  constructor(readonly tables: Record<string, Row[]> = {}) {}
  from(table: string): Chain { return new Chain(this.tables[table] ?? []); }
  calls(fn: string): Row[] { return this.rpc.mock.calls.filter(call => call[0] === fn).map(call => call[1] as Row); }
  writes(): string[] { return this.rpc.mock.calls.map(call => call[0]).filter(fn => fn !== "trading_os_schema"); }
}

const USER = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const NEW_TRADE = "a0000000-0000-4000-8000-000000000002";
const KEY = "70000000-0000-4000-8000-000000000001";
const RISK = "40000000-0000-4000-8000-000000000001";
const OBS = "60000000-0000-4000-8000-000000000001";
const INSTRUMENT = "30000000-0000-4000-8000-000000000001";
const EVIDENCE = "e0000000-0000-4000-8000-000000000001";
const PROPOSAL = {
  instrumentId: INSTRUMENT, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5",
  narrative: "Sweep of Asia low into H4 order block.", contractConfirmed: true, news: "CLEAR", contradiction: false,
};
const SCHEMA_OUTDATED = "Database update required — this deployment expects Trading OS database version 2.0. No changes were made.";
const FAILED = "The request failed. Nothing was changed. Please try again.";

function report(proposal: Row = PROPOSAL) {
  return evaluateRisk(proposal, {
    now: "2026-10-14T14:00:00.000Z", strategyVersionId: "50000000-0000-4000-8000-000000000001", strategyVersion: "ICT V1.0", observationId: OBS, observationDay: "2026-10-14",
    equity: "10000", currency: "USD",
    plan: { id: RISK, version: "Risk Plan V1.0", maxRiskPercent: "0.5", defaultRiskPercent: null, maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyRiskCap: null, dailyLossCap: null },
    instrument: { id: INSTRUMENT, symbol: "EURUSD", currency: "USD", quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" },
    usage: { day: "2026-10-14", plannedSlots: 0, plannedRisk: "0", unplannedTrades: 0, unplannedRisk: "0", unplannedRiskUnknown: 0, realizedLoss: "0", externalLoss: "0", legacyReportedLoss: null, openExposure: "0", openRiskUnknown: 0, riskUnknownTrades: 0, lossTotal: "0" },
    duplicate: false,
  });
}

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.set(key, value);
  }
  return data;
}

const accountTables = (status: "ACTIVE" | "ARCHIVED" = "ACTIVE"): Record<string, Row[]> => ({
  accounts: [{ id: ACCOUNT, user_id: USER, name: "FTMO", currency: "USD", created_at: "2026-09-01T10:00:00.000Z" }],
  account_profiles: [{ id: 1, account_id: ACCOUNT, user_id: USER, display_name: "FTMO", broker: null, platform: "MANUAL", account_type: "DEMO", starting_balance: null, status }],
});

let db: ActionDb;
function useDb(tables: Record<string, Row[]> = accountTables()): ActionDb {
  db = new ActionDb(tables);
  m.session = { db, user: { id: USER, email: "trader@example.test" } };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.cookieSets.length = 0;
  m.headers.clear();
  m.sessionError = null;
  useDb();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------------
describe("schema gate (§13.10)", () => {
  const actions: [string, (prev: never, data: FormData) => Promise<unknown>, () => FormData][] = [
    ["createPlannedTrade", createPlannedTrade, () => form({ accountId: ACCOUNT, requestKey: KEY, riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(PROPOSAL) })],
    ["reviseDraft", reviseDraft, () => form({ tradeId: TRADE, requestKey: KEY, expectedRevision: "1", riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(PROPOSAL) })],
    ["duplicateDraft", duplicateDraft, () => form({ tradeId: TRADE, requestKey: KEY })],
    ["discardDraft", discardDraft, () => form({ tradeId: TRADE })],
    ["checkRisk", checkRisk, () => form({ tradeId: TRADE })],
    ["lockPlan", lockPlan, () => form({ tradeId: TRADE, expectedRevision: "1" })],
    ["recordEntry", recordEntry, () => form({ tradeId: TRADE, entry: "1.1", quantity: "0.25" })],
    ["closePlannedTrade", closePlannedTrade, () => form({ tradeId: TRADE, exit: "1.106" })],
    ["setDisposition", setDisposition, () => form({ tradeId: TRADE, status: "SKIPPED", reason: "News" })],
    ["recordLiveTrade", recordLiveTrade, () => form({ accountId: ACCOUNT, requestKey: KEY, symbol: "EURUSD", direction: "LONG" })],
    ["completeLiveEntry", completeLiveEntry, () => form({ tradeId: TRADE, requestKey: KEY, entryPrice: "1.1" })],
    ["closeLiveTrade", closeLiveTrade, () => form({ tradeId: TRADE, netPnl: "10" })],
    ["setTags", setTags, () => form({ tradeId: TRADE, tags: "fomo" })],
    ["completeReview", completeReview, () => form({ tradeId: TRADE })],
    ["reopenReview", reopenReview, () => form({ tradeId: TRADE })],
    ["removeEvidence", removeEvidence, () => form({ evidenceId: EVIDENCE, kind: "V2" })],
    ["relabelEvidence", relabelEvidence, () => form({ evidenceId: EVIDENCE, label: "ENTRY" })],
    ["addJournalEntry", addJournalEntry, () => form({ tradeId: TRADE, kind: "NOTE", body: "Hi", requestKey: KEY })],
  ];

  it.each(actions)("%s refuses to write against a database without the 2.0 marker", async (_name, action, data) => {
    db.results.trading_os_schema = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await action(idleState as never, data())).toEqual({ status: "error", message: SCHEMA_OUTDATED });
    expect(db.writes()).toEqual([]);
    expect(m.revalidate).not.toHaveBeenCalled();
    expect(m.cookieSets).toEqual([]);
  });

  it("rethrows framework control flow (sign-in redirects) before handling errors", async () => {
    m.sessionError = new Error("NEXT_REDIRECT");
    await expect(createPlannedTrade(idleState, form({}))).rejects.toThrow("NEXT_REDIRECT");
    expect(m.rethrow).toHaveBeenCalledWith(m.sessionError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("error copy (§0.6)", () => {
  it("maps stable prefixes, legacy messages and a missing function; never echoes raw text", () => {
    expect(errorCode({ message: "DRAFT_CHANGED: The draft changed (latest revision 3)" })).toBe("DRAFT_CHANGED");
    expect(rpcErrorCopy({ message: "Screenshot not found" })).toBe(SQL_ERROR_COPY.EVIDENCE_NOT_FOUND);
    expect(rpcErrorCopy({ message: "Authentication required" })).toBe("Your session has ended. Sign in again to continue.");
    expect(rpcErrorCopy({ code: "PGRST202", message: "Could not find the function public.lock_trade" })).toBe(SCHEMA_ERROR_COPY);
    expect(rpcErrorCopy({ message: "SOMETHING_NEW: internal detail" })).toBe(FAILED);
    expect(rpcErrorCopy({ message: "duplicate key value violates unique constraint" })).toBe(FAILED);
    expect(rpcErrorCopy({ message: "INVALID_TIME: The exit time must not be before the entry time" })).toBe("The exit time can't be before the entry time.");
    expect(SCHEMA_ERROR_COPY).toBe(SCHEMA_OUTDATED_MESSAGE);
    for (const copy of Object.values(SQL_ERROR_COPY)) expect(copy).not.toMatch(/[A-Z]{3,}_[A-Z_]+|p_[a-z]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("drafts", () => {
  const createForm = (proposal: unknown = PROPOSAL) => form({ accountId: ACCOUNT, requestKey: KEY, riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(proposal) });

  it("creates a draft with the exact RPC arguments, remembers the account and revalidates the trade", async () => {
    m.headers.set("origin", "https://trading.example");
    const blocked = report({ ...PROPOSAL, riskPercent: "0.504" });
    db.results.create_planned_trade = () => ({ data: { tradeId: TRADE, proposalId: KEY, revision: 1, evaluationId: KEY, result: blocked }, error: null });
    const result = await createPlannedTrade(idleState, createForm({ ...PROPOSAL, riskPercent: "0.504" }));
    expect(result).toEqual({
      status: "success",
      message: "Draft saved. Risk check: Blocked — Requested risk 0.504% exceeds your configured maximum of 0.50%.",
      data: { tradeId: TRADE, revision: 1, decision: "BLOCKED" },
    });
    expect(db.calls("create_planned_trade")).toEqual([{
      p_account_id: ACCOUNT, p_proposal: { ...PROPOSAL, riskPercent: "0.504" }, p_request_key: KEY, p_expected_risk_id: RISK, p_expected_observation_id: OBS,
    }]);
    expect(m.cookieSets).toEqual([["tos_last_account", ACCOUNT, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 34560000, secure: true }]]);
    expect(m.revalidate.mock.calls.map(call => call[0])).toEqual([`/trades/${TRADE}`, "/today", "/journal"]);
  });

  it("returns field-level copy for an incomplete plan and never calls the database", async () => {
    const result = await createPlannedTrade(idleState, createForm({ ...PROPOSAL, entry: "abc", narrative: "  " }));
    expect(result).toEqual({
      status: "error", message: "Some values need attention. Check the highlighted fields.",
      fieldErrors: { entry: INVALID_INPUT_FIELD_COPY.entry, narrative: INVALID_INPUT_FIELD_COPY.narrative },
    });
    expect((await createPlannedTrade(idleState, form({ accountId: "x", proposal: "{" }))).status).toBe("error");
    expect(db.writes()).toEqual([]);
  });

  it("refuses new trades on an archived account", async () => {
    useDb(accountTables("ARCHIVED"));
    const result = await createPlannedTrade(idleState, createForm());
    expect(result).toMatchObject({ status: "error", message: "This trading account is archived. Restore it in Manage account before planning or recording trades." });
    expect(db.writes()).toEqual([]);
  });

  it.each([
    ["CONTEXT_CHANGED: Account or risk plan changed. Refresh and recheck.", "Your account values or risk plan changed since this page loaded. Reload and check again.", undefined],
    ["IDEMPOTENCY_CONFLICT: This request key was already used for a different trade", "This form was already submitted and saved with different values. Reload the page to see what was saved before submitting again.", undefined],
    ["INVALID_INPUT: instrumentId must reference an instrument of this account", "Some values were not accepted. Check the form and try again.", { instrumentId: "Choose an instrument from this trading account." }],
    ["ACCOUNT_INCOMPLETE: Account configuration is incomplete", "This trading account needs account values, a risk plan and an instrument before a plan can be checked.", undefined],
  ])("maps %s to human copy", async (sql, copy, fieldErrors) => {
    db.results.create_planned_trade = () => ({ data: null, error: { message: sql, code: "P0001" } });
    const result = await createPlannedTrade(idleState, createForm());
    expect(result).toEqual(fieldErrors ? { status: "error", message: copy, fieldErrors } : { status: "error", message: copy });
    expect(JSON.stringify(result)).not.toMatch(/[A-Z]{4,}_[A-Z]+:/);
    expect(m.log).not.toHaveBeenCalled();
  });

  it("never shows an unknown database error; logs a fixed event", async () => {
    db.results.create_planned_trade = () => ({ data: null, error: { message: "permission denied for table secret_internal" } });
    expect(await createPlannedTrade(idleState, createForm())).toEqual({ status: "error", message: FAILED });
    expect(m.log).toHaveBeenCalledWith("database_write_failed");
  });

  it("revises the latest revision and maps a concurrent edit", async () => {
    const approved = report();
    db.results.revise_trade_draft = () => ({ data: { tradeId: TRADE, proposalId: KEY, revision: 3, evaluationId: KEY, result: approved }, error: null });
    const data = form({ tradeId: TRADE, requestKey: KEY, expectedRevision: "2", riskPlanId: RISK, observationId: OBS, proposal: JSON.stringify(PROPOSAL) });
    expect(await reviseDraft(idleState, data)).toEqual({
      status: "success", message: "Saved as revision 3. The free risk check approved it.", data: { tradeId: TRADE, revision: 3, decision: "APPROVED" },
    });
    expect(db.calls("revise_trade_draft")[0]).toEqual({
      p_trade_id: TRADE, p_proposal: PROPOSAL, p_request_key: KEY, p_expected_revision: 2, p_expected_risk_id: RISK, p_expected_observation_id: OBS,
    });
    expect(m.revalidate.mock.calls.map(call => call[0])).toContain(`/trades/${TRADE}/edit`);
    db.results.revise_trade_draft = () => ({ data: null, error: { message: "DRAFT_CHANGED: The draft changed since it was loaded (latest revision 3)" } });
    expect(await reviseDraft(idleState, data)).toEqual({ status: "error", message: "This draft changed since you opened it. Reload to see the latest revision." });
  });

  it("duplicates with the account's current risk plan and values, then copies Before-entry evidence", async () => {
    useDb({
      ...accountTables(),
      trades: [{ id: TRADE, user_id: USER, account_id: ACCOUNT }],
      risk_plan_versions: [{ id: RISK, account_id: ACCOUNT, user_id: USER, version: "Risk Plan V1.0", effective_day: "2026-10-01", created_at: "2026-10-01T10:00:00.000Z", max_risk_percent: "0.5", default_risk_percent: null, max_daily_trades: 2, min_rr: "3", rr_policy: "BLOCK", news_policy: "WARN", daily_risk_cap: null, daily_loss_cap: null, override_reason: null }],
      account_observations: [{ id: OBS, account_id: ACCOUNT, user_id: USER, balance: "10000.00", equity: "10000.00", gross_loss_today: null, trading_day: "2026-10-14", recorded_at: "2026-10-14T12:00:00.000Z" }],
    });
    db.results.duplicate_trade_draft = () => ({ data: { tradeId: NEW_TRADE, proposalId: KEY }, error: null });
    m.copy.mockResolvedValue({ copied: 2, skipped: 0, failed: 0 });
    expect(await duplicateDraft(idleState, form({ tradeId: TRADE, requestKey: KEY }))).toEqual({
      status: "success", message: "Draft duplicated with 2 pre-entry screenshots. News is reset to \"Not checked\".",
      data: { tradeId: NEW_TRADE, copiedEvidence: 2, evidenceNotCopied: 0 },
    });
    expect(db.calls("duplicate_trade_draft")[0]).toEqual({ p_trade_id: TRADE, p_request_key: KEY, p_expected_risk_id: RISK, p_expected_observation_id: OBS });
    expect(m.copy).toHaveBeenCalledWith(TRADE, NEW_TRADE);
    m.copy.mockRejectedValue(new Error("storage down"));
    expect(await duplicateDraft(idleState, form({ tradeId: TRADE, requestKey: KEY }))).toMatchObject({
      status: "success", message: "Draft duplicated. Its screenshots could not be copied; add them again on the new draft.", data: { tradeId: NEW_TRADE },
    });
  });

  it("discards with an optional reason and maps a non-draft", async () => {
    db.results.discard_trade_draft = () => ({ data: {}, error: null });
    expect(await discardDraft(idleState, form({ tradeId: TRADE, reason: "  Changed my mind " }))).toMatchObject({ status: "success" });
    expect(db.calls("discard_trade_draft")[0]).toEqual({ p_trade_id: TRADE, p_reason: "Changed my mind", p_request_key: null });
    db.results.discard_trade_draft = () => ({ data: null, error: { message: "DRAFT_NOT_EDITABLE: Only drafts can be discarded" } });
    expect(await discardDraft(idleState, form({ tradeId: TRADE }))).toEqual({ status: "error", message: "Only drafts can be discarded." });
  });

  it("explains a blocked check and refuses to report a blocked lock as success", async () => {
    const blocked = report({ ...PROPOSAL, target: "1.10599" });
    db.results.check_trade_risk = () => ({ data: { planId: null, evaluationId: KEY, result: blocked, replayed: false, tradeId: TRADE }, error: null });
    expect(await checkRisk(idleState, form({ tradeId: TRADE }))).toEqual({
      status: "success", message: "Risk check: Blocked — Planned RR 2.99R is below the required minimum of 3.00R.", data: { decision: "BLOCKED" },
    });
    db.results.lock_trade = () => ({ data: { planId: null, evaluationId: KEY, result: blocked, replayed: false, tradeId: TRADE }, error: null });
    expect(await lockPlan(idleState, form({ tradeId: TRADE, expectedRevision: "2" }))).toEqual({
      status: "error", message: "Not locked. Risk check: Blocked — Planned RR 2.99R is below the required minimum of 3.00R.",
    });
    expect(db.calls("lock_trade")[0]).toEqual({ p_trade_id: TRADE, p_expected_revision: 2 });
    db.results.lock_trade = () => ({ data: { planId: KEY, evaluationId: KEY, result: report(), replayed: false, tradeId: TRADE }, error: null });
    expect(await lockPlan(idleState, form({ tradeId: TRADE, expectedRevision: "2" }))).toMatchObject({ status: "success", data: { locked: true } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("planned execution (§8.5)", () => {
  const withPlan = () => useDb({
    ...accountTables(),
    trade_ledger: [{ id: TRADE, planned_quantity: "0.25", instrument_version_id: INSTRUMENT }],
    instrument_versions: [{ id: INSTRUMENT, user_id: USER, quantity_step: "0.01000000" }],
  });

  it("requires an explicit confirmation before recording a size above the plan", async () => {
    withPlan();
    const result = await recordEntry(idleState, form({ tradeId: TRADE, entry: "1.10000", quantity: "0.5" }));
    const copy = "Actual size 0.50 exceeds the plan's 0.25 (2.00×). This will be recorded as a size deviation.";
    expect(result).toEqual({ status: "error", message: copy, fieldErrors: { confirmOversize: copy } });
    expect(db.writes()).toEqual([]);
  });

  it("records a confirmed entry at server time when no entry time is given", async () => {
    withPlan();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T14:30:00.000Z"));
    db.results.record_planned_entry = () => ({ data: { executionId: KEY, oversize: true, plannedQuantity: "0.25", actualQuantity: "0.5" }, error: null });
    const result = await recordEntry(idleState, form({ tradeId: TRADE, entry: "1.10000", quantity: "0.5", confirmOversize: "on" }));
    expect(result).toEqual({ status: "success", message: "Entry recorded with a size deviation. The trade is live.", data: { oversize: true, plannedQuantity: "0.25", actualQuantity: "0.5" } });
    expect(db.calls("record_planned_entry")[0]).toEqual({ p_trade_id: TRADE, p_entry: "1.10000", p_quantity: "0.5", p_entered_at: "2026-10-14T14:30:00.000Z" });
  });

  it("validates prices and the entry time, and maps entry-time rules", async () => {
    withPlan();
    expect(await recordEntry(idleState, form({ tradeId: TRADE, entry: "-1", quantity: "0.25", enteredAt: "yesterday" }))).toEqual({
      status: "error", message: "Some values need attention. Check the highlighted fields.",
      fieldErrors: { entry: "Entry price must be a positive number with up to 8 decimals.", enteredAt: "Enter the entry time with a date and time zone, or leave it as now." },
    });
    db.results.record_planned_entry = () => ({ data: null, error: { message: "INVALID_TIME: Entry must be after plan lock and not in the future" } });
    expect(await recordEntry(idleState, form({ tradeId: TRADE, entry: "1.1", quantity: "0.25", enteredAt: "2026-10-14T09:00:00-05:00" }))).toEqual({
      status: "error", message: "The entry time must be after the plan was locked and not in the future.",
    });
    expect(db.calls("record_planned_entry")[0].p_entered_at).toBe("2026-10-14T09:00:00-05:00");
  });

  it("reports non-numeric prices and sizes as field errors instead of failing the request", async () => {
    withPlan();
    expect(await recordEntry(idleState, form({ tradeId: TRADE, entry: "abc", quantity: "0,25" }))).toEqual({
      status: "error", message: "Some values need attention. Check the highlighted fields.",
      fieldErrors: { entry: "Entry price must be a positive number with up to 8 decimals.", quantity: expect.any(String) },
    });
    expect(db.calls("record_planned_entry")).toEqual([]);
  });

  it("closes with zero fees by default and reports the outcome", async () => {
    db.results.close_planned_trade = () => ({ data: { tradeId: TRADE, outcomeId: KEY, outcome: "WIN", netPnl: "150", realizedR: "3", calculationVersion: "FULL_CLOSE_V1" }, error: null });
    expect(await closePlannedTrade(idleState, form({ tradeId: TRADE, exit: "1.106", exitedAt: "2026-10-14T15:00:00Z" }))).toEqual({
      status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "WIN", netPnl: "150", realizedR: "3" },
    });
    expect(db.calls("close_planned_trade")[0]).toEqual({ p_trade_id: TRADE, p_exit: "1.106", p_exited_at: "2026-10-14T15:00:00Z", p_fees: "0" });
    expect(m.revalidate.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["/edge", "/accounts"]));
    expect((await closePlannedTrade(idleState, form({ tradeId: TRADE, exit: "1.106", fees: "1.234" }))).status).toBe("error");
  });

  it("skips with a reason only", async () => {
    db.results.set_planned_disposition = () => ({ data: {}, error: null });
    expect((await setDisposition(idleState, form({ tradeId: TRADE, status: "SKIPPED", reason: " " }))).status).toBe("error");
    expect(await setDisposition(idleState, form({ tradeId: TRADE, status: "SKIPPED", reason: "News spike" }))).toMatchObject({ status: "success" });
    expect(db.calls("set_planned_disposition")[0]).toEqual({ p_trade_id: TRADE, p_status: "SKIPPED", p_reason: "News spike" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("live-first trades (§3.5, §8.2)", () => {
  it("records only the details given, as the RPC's JSON input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T14:30:00.000Z"));
    db.results.record_live_trade = () => ({ data: TRADE, error: null });
    const result = await recordLiveTrade(idleState, form({ accountId: ACCOUNT, requestKey: KEY, symbol: "us30.cash", direction: "SHORT", entryPrice: "42000.5", enteredAt: "now", riskAmount: "100", quantity: "" }));
    expect(result).toEqual({ status: "success", message: "Live trade recorded. Add notes and screenshots while it runs.", data: { tradeId: TRADE } });
    expect(db.calls("record_live_trade")[0]).toEqual({
      p_account_id: ACCOUNT, p_input: { symbol: "US30.CASH", direction: "SHORT", entryPrice: "42000.5", enteredAt: "2026-10-14T14:30:00.000Z", riskAmount: "100" }, p_request_key: KEY,
    });
    expect(m.cookieSets[0][0]).toBe("tos_last_account");
    const INSTRUMENT_ID = "30000000-0000-4000-8000-000000000001";
    await recordLiveTrade(idleState, form({ accountId: ACCOUNT, requestKey: KEY, instrumentId: INSTRUMENT_ID, symbol: "GBPUSD", direction: "LONG" }));
    expect(db.calls("record_live_trade")[1]).toMatchObject({ p_input: { instrumentId: INSTRUMENT_ID, direction: "LONG" } });
    expect(db.calls("record_live_trade")[1].p_input).not.toHaveProperty("symbol");
  });

  it("requires a direction and an instrument or symbol", async () => {
    expect(await recordLiveTrade(idleState, form({ accountId: ACCOUNT, requestKey: KEY }))).toEqual({
      status: "error", message: "Some values need attention. Check the highlighted fields.",
      fieldErrors: { direction: "Choose a direction: long or short.", instrumentId: "Choose an instrument or enter the symbol." },
    });
    expect(db.writes()).toEqual([]);
  });

  it("completes missing entry details once and maps immutable details", async () => {
    expect(await completeLiveEntry(idleState, form({ tradeId: TRADE, requestKey: KEY }))).toEqual({ status: "error", message: "Add at least one missing entry detail." });
    db.results.complete_live_entry = () => ({ data: null, error: { message: "ENTRY_DETAILS_IMMUTABLE: Recorded entry details cannot be changed" } });
    expect(await completeLiveEntry(idleState, form({ tradeId: TRADE, requestKey: KEY, initialStop: "1.09" }))).toEqual({
      status: "error", message: "Recorded entry details can't be changed. Only missing details can be added.",
    });
    expect(db.calls("complete_live_entry")[0]).toEqual({ p_trade_id: TRADE, p_input: { initialStop: "1.09" }, p_request_key: KEY });
  });

  it("closes with a reported net P&L or the calculated one", async () => {
    useDb({ ...accountTables(), trade_ledger: [{ id: TRADE, outcome: "LOSS", net_pnl: "-25.5", realized_r: null }] });
    db.results.close_live_trade = () => ({ data: TRADE, error: null });
    expect(await closeLiveTrade(idleState, form({ tradeId: TRADE, netPnl: "-25.50", exitedAt: "2026-10-14T15:00:00Z" }))).toEqual({
      status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "LOSS", netPnl: "-25.5", realizedR: null },
    });
    expect(db.calls("close_live_trade")[0]).toEqual({ p_trade_id: TRADE, p_input: { exitedAt: "2026-10-14T15:00:00Z", netPnl: "-25.50" } });
    expect((await closeLiveTrade(idleState, form({ tradeId: TRADE, netPnl: "-25.501" }))).status).toBe("error");
    db.results.close_live_trade = () => ({ data: null, error: { message: "PNL_IS_CALCULATED: Net P&L is calculated from the recorded prices and size" } });
    expect(await closeLiveTrade(idleState, form({ tradeId: TRADE, exitPrice: "1.1", netPnl: "10" }))).toEqual({
      status: "error", message: "Net P&L is calculated from the recorded prices and size. Leave it empty.",
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// "now" and an empty entry/exit time are resolved on the server at every request. A resubmitted form (double click,
// retry after a lost response) therefore reaches the database with a new instant; when the database answers that the
// record already exists, the action retries once with the recorded instant and the database compares every reported
// value. tests/v2-actions-replay.test.ts runs the same flows against the real SQL.
describe("server-resolved times replay a resubmission (retries, double clicks)", () => {
  const RECORDED = "2026-10-14T14:30:00.123+00:00";
  const NOW = "2026-10-14T14:31:00.000Z";
  const LIVE_CONFLICT = { status: "error", message: "This form already recorded a live trade with other details. Open it from Today instead of recording it again." };
  const conflictError = { message: "IDEMPOTENCY_CONFLICT: This request key was already used for a different trade" };
  const liveFields = { accountId: ACCOUNT, requestKey: KEY, symbol: "EURUSD", direction: "LONG", enteredAt: "now" };
  const withFacts = (enteredAt: string | null) =>
    useDb({ ...accountTables(), trade_position_facts: [{ user_id: USER, request_key: KEY, trade_id: TRADE, entered_at: enteredAt }] });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  it("Record Live Trade: a conflict on a server-resolved entry time replays with the recorded entry time", async () => {
    withFacts(RECORDED);
    db.results.record_live_trade = args => ((args.p_input as Row).enteredAt === RECORDED ? { data: TRADE, error: null } : { data: null, error: conflictError });
    expect(await recordLiveTrade(idleState, form(liveFields))).toEqual({
      status: "success", message: "Live trade recorded. Add notes and screenshots while it runs.", data: { tradeId: TRADE },
    });
    expect(db.calls("record_live_trade")).toEqual([
      { p_account_id: ACCOUNT, p_input: { symbol: "EURUSD", direction: "LONG", enteredAt: NOW }, p_request_key: KEY },
      { p_account_id: ACCOUNT, p_input: { symbol: "EURUSD", direction: "LONG", enteredAt: RECORDED }, p_request_key: KEY },
    ]);
  });

  it("Record Live Trade: a reported time, an unknown recorded time or other details keep the conflict, with copy against recording twice", async () => {
    withFacts(RECORDED);
    db.results.record_live_trade = () => ({ data: null, error: conflictError });
    expect(await recordLiveTrade(idleState, form({ ...liveFields, enteredAt: "2026-10-14T09:00:00-05:00" }))).toEqual(LIVE_CONFLICT);
    expect(db.calls("record_live_trade")).toHaveLength(1);
    withFacts(null);
    db.results.record_live_trade = () => ({ data: null, error: conflictError });
    expect(await recordLiveTrade(idleState, form(liveFields))).toEqual(LIVE_CONFLICT);
    expect(db.calls("record_live_trade")).toHaveLength(1);
    withFacts(RECORDED);
    db.results.record_live_trade = () => ({ data: null, error: conflictError });
    expect(await recordLiveTrade(idleState, form(liveFields))).toEqual(LIVE_CONFLICT);
    expect(db.calls("record_live_trade").map(call => (call.p_input as Row).enteredAt)).toEqual([NOW, RECORDED]);
    expect(m.log).not.toHaveBeenCalled();
  });

  it("Record entry: an empty or 'now' time replays the recorded fill; a reported time is compared as given", async () => {
    const envelope = { executionId: KEY, oversize: false, plannedQuantity: "0.25", actualQuantity: "0.25" };
    useDb({ ...accountTables(), trade_ledger: [{ id: TRADE, planned_quantity: "0.25", instrument_version_id: INSTRUMENT, entered_at: RECORDED, exited_at: null }] });
    db.results.record_planned_entry = args => (args.p_entered_at === RECORDED
      ? { data: envelope, error: null }
      : { data: null, error: { message: "ENTRY_ALREADY_RECORDED: Entry already recorded; original fill is immutable" } });
    for (const enteredAt of ["", "now", " NOW "]) {
      expect(await recordEntry(idleState, form({ tradeId: TRADE, entry: "1.10000", quantity: "0.25", enteredAt })), enteredAt).toEqual({
        status: "success", message: "Entry recorded. The trade is live.", data: { oversize: false, plannedQuantity: "0.25", actualQuantity: "0.25" },
      });
      expect(db.calls("record_planned_entry").slice(-2).map(call => call.p_entered_at), enteredAt).toEqual([NOW, RECORDED]);
    }
    expect(await recordEntry(idleState, form({ tradeId: TRADE, entry: "1.10000", quantity: "0.25", enteredAt: "2026-10-14T09:30:00-05:00" }))).toEqual({
      status: "error", message: "The entry is already recorded. Recorded fills can't be changed.",
    });
    expect(db.calls("record_planned_entry").map(call => call.p_entered_at)).toEqual([NOW, RECORDED, NOW, RECORDED, NOW, RECORDED, "2026-10-14T09:30:00-05:00"]);
  });

  it("Close trade (planned and live-first): a default exit time replays the recorded close; other errors are never retried", async () => {
    useDb({ ...accountTables(), trade_ledger: [{ id: TRADE, entered_at: "2026-10-14T14:00:00+00:00", exited_at: RECORDED, outcome: "WIN", net_pnl: "150", realized_r: "3" }] });
    const alreadyClosed = { data: null, error: { message: "ALREADY_CLOSED: The trade is already closed with different values" } };
    db.results.close_planned_trade = args => (args.p_exited_at === RECORDED
      ? { data: { tradeId: TRADE, outcomeId: KEY, outcome: "WIN", netPnl: "150", realizedR: "3", calculationVersion: "FULL_CLOSE_V1" }, error: null }
      : alreadyClosed);
    expect(await closePlannedTrade(idleState, form({ tradeId: TRADE, exit: "1.106" }))).toEqual({
      status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "WIN", netPnl: "150", realizedR: "3" },
    });
    expect(db.calls("close_planned_trade").map(call => call.p_exited_at)).toEqual([NOW, RECORDED]);
    db.results.close_live_trade = args => ((args.p_input as Row).exitedAt === RECORDED ? { data: TRADE, error: null } : alreadyClosed);
    expect(await closeLiveTrade(idleState, form({ tradeId: TRADE, exitPrice: "1.106", exitedAt: "now" }))).toEqual({
      status: "success", message: "Trade closed. Write your review while it is fresh.", data: { outcome: "WIN", netPnl: "150", realizedR: "3" },
    });
    expect(db.calls("close_live_trade").map(call => call.p_input)).toEqual([{ exitPrice: "1.106", exitedAt: NOW }, { exitPrice: "1.106", exitedAt: RECORDED }]);
    // A reported exit time is compared as given; an error other than "already closed" is never retried.
    expect(await closePlannedTrade(idleState, form({ tradeId: TRADE, exit: "1.106", exitedAt: "2026-10-14T10:00:00-05:00" }))).toEqual({
      status: "error", message: "This trade is already closed with different values.",
    });
    db.results.close_live_trade = () => ({ data: null, error: { message: "INVALID_TIME: The exit time must not be before the entry time" } });
    expect(await closeLiveTrade(idleState, form({ tradeId: TRADE, exitPrice: "1.106" }))).toEqual({ status: "error", message: "The exit time can't be before the entry time." });
    expect(db.calls("close_planned_trade")).toHaveLength(3);
    expect(db.calls("close_live_trade")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("tags, review and evidence", () => {
  it("normalises tags before the database validates them", async () => {
    db.results.set_trade_tags = () => ({ data: 1, error: null });
    expect(await setTags(idleState, form({ tradeId: TRADE, grade: "A+", tags: ["FOMO,  late  entry", "fomo"] }))).toMatchObject({ status: "success" });
    expect(db.calls("set_trade_tags")[0]).toEqual({ p_trade_id: TRADE, p_grade: "A+", p_liquidity: null, p_mss: null, p_tags: ["fomo", "late entry"] });
    expect(await setTags(idleState, form({ tradeId: TRADE, tags: "#hash" }))).toMatchObject({
      status: "error", fieldErrors: { tags: "Use at most 12 different tags of 1 to 32 characters (a-z, 0-9, space, _ or -)." },
    });
  });

  it("completes and reopens reviews", async () => {
    db.results.complete_trade_review = () => ({ data: {}, error: null });
    db.results.reopen_trade_review = () => ({ data: null, error: { message: "NOT_REVIEWED: Only reviewed trades can be reopened" } });
    expect(await completeReview(idleState, form({ tradeId: TRADE, requestKey: KEY }))).toEqual({ status: "success", message: "Marked reviewed." });
    expect(db.calls("complete_trade_review")[0]).toEqual({ p_trade_id: TRADE, p_request_key: KEY });
    expect(await reopenReview(idleState, form({ tradeId: TRADE }))).toEqual({ status: "error", message: "Only reviewed trades can be reopened." });
  });

  it("removes V2 evidence and legacy screenshots through their own RPCs and revalidates the owning trade", async () => {
    const LEGACY = "e0000000-0000-4000-8000-000000000002";
    const PROPOSAL_ID = "70000000-0000-4000-8000-000000000009";
    useDb({
      trade_evidence: [{ id: EVIDENCE, user_id: USER, trade_id: TRADE }],
      setup_screenshots: [{ id: LEGACY, user_id: USER, proposal_id: PROPOSAL_ID }],
      trade_revisions: [{ proposal_id: PROPOSAL_ID, user_id: USER, trade_id: NEW_TRADE }],
    });
    db.results.remove_trade_evidence = () => ({ data: null, error: null });
    db.results.remove_setup_screenshot = () => ({ data: null, error: null });
    expect(await removeEvidence(idleState, form({ evidenceId: EVIDENCE, kind: "V2" }))).toEqual({ status: "success", message: "Screenshot removed. The timeline keeps a record of it." });
    expect(await removeEvidence(idleState, form({ evidenceId: LEGACY, kind: "LEGACY" }))).toMatchObject({ status: "success" });
    expect(db.calls("remove_trade_evidence")).toEqual([{ p_evidence_id: EVIDENCE }]);
    expect(db.calls("remove_setup_screenshot")).toEqual([{ p_screenshot_id: LEGACY }]);
    expect(m.revalidate.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([`/trades/${TRADE}`, `/trades/${NEW_TRADE}`]));
    expect(await removeEvidence(idleState, form({ evidenceId: "e0000000-0000-4000-8000-0000000000ff", kind: "V2" }))).toEqual({ status: "error", message: "That screenshot isn't available." });
  });

  it("relabels V2 evidence (label, timeframe, caption) and keeps legacy labels", async () => {
    useDb({ trade_evidence: [{ id: EVIDENCE, user_id: USER, trade_id: TRADE }] });
    db.results.relabel_trade_evidence = () => ({ data: null, error: null });
    expect(await relabelEvidence(idleState, form({ evidenceId: EVIDENCE, label: "ENTRY", timeframe: "M5", caption: " Entry candle " }))).toEqual({
      status: "success", message: "Label saved. The screenshot keeps its original timing.",
    });
    expect(db.calls("relabel_trade_evidence")[0]).toEqual({ p_evidence_id: EVIDENCE, p_label: "ENTRY", p_timeframe: "M5", p_caption: "Entry candle" });
    expect((await relabelEvidence(idleState, form({ evidenceId: EVIDENCE, label: "SELFIE" }))).status).toBe("error");
    db.results.relabel_trade_evidence = () => ({ data: null, error: { message: "EVIDENCE_REMOVED: Removed evidence cannot be relabelled" } });
    expect(await relabelEvidence(idleState, form({ evidenceId: EVIDENCE, label: "EXIT" }))).toEqual({ status: "error", message: "Removed screenshots can't be relabelled." });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("addJournalEntry (§3.6, §12.2 contract)", () => {
  const entry = (fields: Record<string, string>) => form({ tradeId: TRADE, requestKey: KEY, ...fields });

  it("adds an entry with the exact RPC arguments and returns its id", async () => {
    const ID = "c0000000-0000-4000-8000-000000000001";
    db.results.add_journal_entry = () => ({ data: ID, error: null });
    expect(await addJournalEntry(idleState, entry({ kind: "PARTIAL_CLOSE", body: "  Took half ", details: JSON.stringify({ price: "1.105", percent: "50", quantity: null }) }))).toEqual({
      status: "success", message: "Added to the journal.", data: { id: ID },
    });
    expect(db.calls("add_journal_entry")[0]).toEqual({ p_trade_id: TRADE, p_kind: "PARTIAL_CLOSE", p_body: "Took half", p_details: { price: "1.105", percent: "50" }, p_request_key: KEY });
    expect(m.revalidate.mock.calls.map(call => call[0])).toEqual([`/trades/${TRADE}`, "/today"]);
  });

  it.each([
    ["a note without text", { kind: "NOTE", body: "   " }, { body: "Write the note (up to 5,000 characters)." }],
    ["a note with details", { kind: "NOTE", body: "x", details: JSON.stringify({ price: "1" }) }, { details: "Check the price, size or percent of this entry." }],
    ["a stop change without a price", { kind: "STOP_CHANGE" }, { price: "Price must be a positive number with up to 8 decimals." }],
    ["a stop price as a JSON number", { kind: "STOP_CHANGE", details: JSON.stringify({ price: 1.1 }) }, { details: "Check the price, size or percent of this entry." }],
    ["both size and percent", { kind: "PARTIAL_CLOSE", details: JSON.stringify({ quantity: "0.1", percent: "50" }) }, { details: "Give either the size or the percent of a partial close, not both." }],
    ["a percent of 100", { kind: "PARTIAL_CLOSE", details: JSON.stringify({ percent: "100" }) }, { percent: "Percent must be more than 0 and less than 100." }],
    ["an unknown kind", { kind: "RANT", body: "x" }, { kind: "Choose what kind of entry this is." }],
  ])("rejects %s with field copy", async (_label, fields, fieldErrors) => {
    expect(await addJournalEntry(idleState, entry(fields))).toEqual({ status: "error", message: "Some values need attention. Check the highlighted fields.", fieldErrors });
    expect(db.writes()).toEqual([]);
  });

  it("maps a replay conflict and a foreign trade", async () => {
    db.results.add_journal_entry = () => ({ data: null, error: { message: "IDEMPOTENCY_CONFLICT: This request key was already used for a different entry" } });
    expect(await addJournalEntry(idleState, entry({ kind: "NOTE", body: "x" }))).toEqual({
      status: "error", message: "This form was already submitted and saved with different values. Reload the page to see what was saved before submitting again.",
    });
    db.results.add_journal_entry = () => ({ data: null, error: { message: "TRADE_NOT_FOUND: Trade not found" } });
    expect(await addJournalEntry(idleState, entry({ kind: "NOTE", body: "x" }))).toEqual({ status: "error", message: "That trade isn't available." });
  });
});
