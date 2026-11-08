import { describe, expect, it } from "vitest";
import { previewContext, previewProposal, usageFixture } from "@/domain/fixtures";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { type DailyUsage, evaluateRisk, type RiskContext } from "@/domain/risk";
import {
  ARCHIVED_DRAFT_LABEL, type BlockingFinding, blockedOnEarlierDay, blockingFindingsOf, blockRemedy, deriveDraftCheck, deriveLifecycle, deriveTradeState,
  LOCKED_PLAN_NOTE, NO_PLAN_BANNER, planEndedAt, reasonWithCount, type TradeStateOptions, withBlockingFindings,
} from "@/domain/trade-state";

function ledger(changes: Partial<LedgerTrade> = {}): LedgerTrade {
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: "00000000-0000-4000-8000-000000000001", account_id: "00000000-0000-4000-8000-000000000002", origin: "PLANNED",
    created_at: "2026-09-04T13:00:00Z", currency: "USD", revision_count: 1, entry_time_known: false, lifecycle: "DRAFT", tags: [],
    evidence_count: 0, journal_count: 0, ai_review_count: 0, ...changes,
  };
}

const now = "2026-09-04T14:00:00Z";
const options: TradeStateOptions = { now, checkCurrent: true };
const ai: TradeStateOptions = { ...options, aiAvailable: true };
const checked = (decision: "APPROVED" | "BLOCKED") => ledger({ latest_check_decision: decision, latest_check_at: "2026-09-04T13:30:00Z" });
const locked = ledger({ plan_id: "00000000-0000-4000-8000-000000000003", locked_at: "2026-09-04T13:40:00Z", latest_check_decision: "APPROVED", latest_check_at: "2026-09-04T13:40:00Z" });
const live = { ...locked, entry_price: "1.1", entered_at: "2026-09-04T13:45:00Z", entry_recorded_at: "2026-09-04T13:46:00Z", quantity: "0.25", initial_stop: "1.098" };
const closed = { ...live, exit_price: "1.106", exited_at: "2026-09-04T15:00:00Z", close_recorded_at: "2026-09-04T15:01:00Z", net_pnl: "150", realized_r: "3", outcome: "WIN" as const };
const liveFirst = ledger({ origin: "LIVE_FIRST", revision_count: 0, symbol: "EURUSD", direction: "LONG", entry_recorded_at: "2026-09-04T13:00:00Z" });
/** Every entry detail known: instrument, model, price, time, size, stop and a risk basis. */
const completeEntry = {
  instrument_version_id: "00000000-0000-4000-8000-000000000004", entry_model: "OTHER" as const, entry_price: "1.1", entered_at: "2026-09-04T12:55:00Z",
  quantity: "0.5", initial_stop: "1.098", initial_risk: "100",
};

describe("lifecycle derivation (spec §2.2)", () => {
  it.each([
    ["unchecked draft", ledger(), "DRAFT", "UNCHECKED"],
    ["blocked draft", checked("BLOCKED"), "DRAFT", "BLOCKED"],
    ["approved draft", checked("APPROVED"), "DRAFT", "APPROVED"],
    ["discarded draft", ledger({ discarded_at: "2026-09-04T13:50:00Z", latest_check_decision: "APPROVED" }), "DISCARDED", null],
    ["legacy skipped proposal", ledger({ legacy_decision: "SKIPPED" }), "SKIPPED", null],
    ["legacy taken proposal without a plan stays a draft", ledger({ legacy_decision: "TAKEN" }), "DRAFT", "UNCHECKED"],
    ["locked plan", locked, "LOCKED", null],
    ["locked plan skipped in V1", { ...locked, legacy_decision: "SKIPPED" as const }, "SKIPPED", null],
    ["locked plan taken in V1 without a fill", { ...locked, legacy_decision: "TAKEN" as const }, "LOCKED", null],
    ["skipped plan", { ...locked, disposition: "SKIPPED" as const }, "SKIPPED", null],
    ["cancelled plan", { ...locked, disposition: "CANCELLED" as const }, "CANCELLED", null],
    ["executed plan", live, "LIVE", null],
    ["executed plan skipped in V1", { ...live, legacy_decision: "SKIPPED" as const }, "LIVE", null],
    ["closed plan", closed, "CLOSED", null],
    ["closed plan skipped in V1", { ...closed, legacy_decision: "SKIPPED" as const }, "CLOSED", null],
    ["reviewed plan", { ...closed, review_completed_at: "2026-09-04T16:00:00Z" }, "REVIEWED", null],
    ["live-first", liveFirst, "LIVE", null],
    ["closed live-first", { ...liveFirst, exited_at: "2026-09-04T15:00:00Z", net_pnl: "-20", outcome: "LOSS" as const }, "CLOSED", null],
    ["reviewed imported", { ...liveFirst, origin: "IMPORTED" as const, exited_at: "2026-09-04T15:00:00Z", outcome: "WIN" as const, review_completed_at: "2026-09-04T16:00:00Z" }, "REVIEWED", null],
  ])("%s → %s", (_name, row, lifecycle, draftCheck) => {
    expect(deriveLifecycle(row)).toBe(lifecycle);
    expect(deriveDraftCheck(row)).toBe(draftCheck);
    expect(deriveTradeState(row, options).lifecycle).toBe(lifecycle);
  });

  it("discard wins over a legacy decision; an execution or outcome wins over a V1 skip", () => {
    expect(deriveLifecycle(ledger({ discarded_at: now, legacy_decision: "SKIPPED" }))).toBe("DISCARDED");
    expect(deriveLifecycle({ ...locked, legacy_decision: "SKIPPED" })).toBe("SKIPPED");
    expect(deriveLifecycle({ ...locked, legacy_decision: "SKIPPED", entry_recorded_at: "2026-09-04T13:46:00Z" })).toBe("LIVE");
    expect(deriveLifecycle({ ...live, legacy_decision: "SKIPPED", outcome: "LOSS", exited_at: "2026-09-04T15:00:00Z", review_completed_at: now })).toBe("REVIEWED");
  });

  it("a plan skipped in V1 is not offered entry or skip actions again", () => {
    const state = deriveTradeState({ ...locked, legacy_decision: "SKIPPED" }, ai);
    expect(state).toMatchObject({ label: "Skipped", tone: "muted", step: null, nextAction: null, secondaryActions: [] });
    expect(state.editable.entry).toBe("none");
  });
});

describe("vocabulary, stepper and next action (spec §2.3–2.4)", () => {
  it.each([
    ["Draft", ledger(), options, "neutral", "Draft", "CHECK_RISK", ["EDIT_DRAFT", "DISCARD"]],
    ["Blocked", checked("BLOCKED"), ai, "danger", "Draft", "EDIT_DRAFT", ["ANALYZE_BLOCKED", "DISCARD"]],
    ["Ready to lock", checked("APPROVED"), ai, "positive", "Validated", "LOCK_PLAN", ["ANALYZE_SETUP", "CHALLENGE_BIAS", "EDIT_DRAFT"]],
    ["Recheck needed", checked("APPROVED"), { ...ai, checkCurrent: false }, "warning", "Draft", "RECHECK_RISK", ["EDIT_DRAFT"]],
    ["Locked · waiting for entry", locked, ai, "info", "Locked", "RECORD_ENTRY", ["SKIP"]],
    ["Live", live, ai, "live", "Live", "ADD_JOURNAL", ["CLOSE_TRADE"]],
    ["Closed · review pending", closed, ai, "neutral", "Closed", "WRITE_REVIEW", ["AI_REVIEW"]],
    ["Reviewed", { ...closed, review_completed_at: "2026-09-04T16:00:00Z" }, ai, "positive-muted", "Reviewed", null, ["REOPEN_REVIEW"]],
    ["Skipped", { ...locked, disposition: "SKIPPED" as const }, ai, "muted", null, null, []],
    ["Cancelled", { ...locked, disposition: "CANCELLED" as const }, ai, "muted", null, null, []],
    ["Discarded", ledger({ discarded_at: now }), ai, "muted", null, null, []],
  ] as const)("%s", (label, row, opts, tone, step, next, secondary) => {
    const state = deriveTradeState(row, opts);
    expect(state.label).toBe(label);
    expect(state.tone).toBe(tone);
    expect(state.step).toBe(step);
    expect(state.nextAction?.kind ?? null).toBe(next);
    expect(state.secondaryActions.map(action => action.kind)).toEqual(secondary);
  });

  it("labels actions in plain words and marks paid AI actions", () => {
    expect(deriveTradeState(ledger(), options).nextAction).toEqual({ kind: "CHECK_RISK", label: "Check risk (free)" });
    const blocked = deriveTradeState(checked("BLOCKED"), ai);
    expect(blocked.secondaryActions[0]).toEqual({ kind: "ANALYZE_BLOCKED", label: "Analyze blocked setup anyway", aiOperation: "ANALYZE_SETUP" });
    expect(deriveTradeState(closed, ai).secondaryActions[0]).toEqual({ kind: "AI_REVIEW", label: "Review this trade with AI", aiOperation: "REVIEW_TRADE_TIMELINE" });
    expect(deriveTradeState(locked, ai).secondaryActions[0].label).toBe("Skip this trade");
  });

  it("shows the first blocking reason with Edit draft", () => {
    const reason = "Requested risk 1.00% exceeds your configured maximum of 0.50%.";
    expect(deriveTradeState(checked("BLOCKED"), { ...options, blockingReason: reason }).nextAction).toEqual({ kind: "EDIT_DRAFT", label: "Edit draft", detail: reason });
    expect(deriveTradeState(checked("APPROVED"), { ...options, blockingReason: reason }).nextAction).toEqual({ kind: "LOCK_PLAN", label: "Lock plan" });
  });

  it("offers no paid AI action unless AI is available", () => {
    expect(deriveTradeState(checked("BLOCKED"), options).secondaryActions.map(a => a.kind)).toEqual(["DISCARD"]);
    expect(deriveTradeState(checked("APPROVED"), options).secondaryActions.map(a => a.kind)).toEqual(["EDIT_DRAFT"]);
    expect(deriveTradeState(closed, options).secondaryActions).toEqual([]);
  });

  it("never treats an approval from an earlier strategy day as current", () => {
    const yesterday = ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-09-04T04:59:59.999999Z" });
    const state = deriveTradeState(yesterday, { now: "2026-09-04T05:00:00Z", checkCurrent: true });
    expect(state.label).toBe("Recheck needed");
    expect(state.checkCurrent).toBe(false);
    expect(deriveTradeState(checked("APPROVED"), options).checkCurrent).toBe(true);
  });

  it("leads a block found on an earlier strategy day with the free recheck; Edit draft keeps the reason one click away", () => {
    const reason = "Daily trade limit reached: 2 of 2 trades already used today (2 planned, 0 recorded live).";
    // 04:59:59.999999 UTC is 23:59:59.999999 UTC−5 of Sep 3; 05:00 UTC starts Sep 4.
    const blockedYesterday = ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-04T04:59:59.999999Z" });
    const state = deriveTradeState(blockedYesterday, { now: "2026-09-04T05:00:00Z", checkCurrent: false, aiAvailable: true, blockingReason: reason });
    // The word and tone stay "Blocked" (Today groups and labels it so); only the next step changes.
    expect(state).toMatchObject({ lifecycle: "DRAFT", draftCheck: "BLOCKED", label: "Blocked", tone: "danger", step: "Draft" });
    expect(state.nextAction).toEqual({ kind: "RECHECK_RISK", label: "Recheck risk" });
    expect(state.secondaryActions).toEqual([
      { kind: "EDIT_DRAFT", label: "Edit draft", detail: reason },
      { kind: "ANALYZE_BLOCKED", label: "Analyze blocked setup anyway", aiOperation: "ANALYZE_SETUP" },
      { kind: "DISCARD", label: "Discard" },
    ]);
    expect(blockedOnEarlierDay(blockedYesterday, "2026-09-04T05:00:00Z")).toBe(true);
    // The same block seen on its own strategy day keeps Edit draft first.
    expect(deriveTradeState(blockedYesterday, { now: "2026-09-04T04:59:59.999999Z", checkCurrent: false, blockingReason: reason }).nextAction)
      .toEqual({ kind: "EDIT_DRAFT", label: "Edit draft", detail: reason });
    expect(blockedOnEarlierDay(blockedYesterday, "2026-09-04T04:59:59.999999Z")).toBe(false);
    // Only blocked drafts: an approval, a locked plan or a plan that ended are never led by a recheck for their day.
    expect(blockedOnEarlierDay(ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-09-03T12:00:00Z" }), now)).toBe(false);
    expect(blockedOnEarlierDay({ ...locked, latest_check_decision: "BLOCKED", latest_check_at: "2026-09-03T12:00:00Z" }, now)).toBe(false);
    expect(blockedOnEarlierDay(ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-03T12:00:00Z", discarded_at: now }), now)).toBe(false);
    expect(blockedOnEarlierDay(ledger({ latest_check_decision: null, latest_check_at: null }), now)).toBe(false);
  });
});

describe("when a planned trade ended without an entry (spec §5.2, private.plan_ended_at)", () => {
  const SKIP = "2026-09-04T14:10:00.000001Z";
  const LEGACY = "2026-09-04T14:05:00Z";
  it.each([
    ["an open draft", ledger(), {}, null],
    ["a discarded draft", ledger({ discarded_at: "2026-09-04T13:50:00Z" }), {}, "2026-09-04T13:50:00Z"],
    ["a skipped plan", { ...locked, disposition: "SKIPPED" as const }, { dispositionAt: SKIP }, SKIP],
    ["a cancelled plan", { ...locked, disposition: "CANCELLED" as const }, { dispositionAt: SKIP }, SKIP],
    ["a draft skipped in V1", ledger({ legacy_decision: "SKIPPED" }), { legacySkipAt: LEGACY }, LEGACY],
    ["a plan skipped in V1, then cancelled: the earlier fact", { ...locked, legacy_decision: "SKIPPED" as const, disposition: "CANCELLED" as const }, { dispositionAt: SKIP, legacySkipAt: LEGACY }, LEGACY],
    ["a plan skipped in V1, then filled", { ...live, legacy_decision: "SKIPPED" as const }, { legacySkipAt: LEGACY }, null],
    ["a closed plan", closed, {}, null],
    ["a locked plan", locked, {}, null],
    ["a live-first trade", liveFirst, { dispositionAt: SKIP }, null],
  ])("%s", (_name, row, times, ended) => {
    expect(planEndedAt(row, times)).toBe(ended);
  });

  it("compares instants exactly, whatever their notation", () => {
    expect(planEndedAt(ledger({ discarded_at: "2026-09-04T09:00:00.000002-05:00" }), { legacySkipAt: "2026-09-04T14:00:00.000001Z" })).toBe("2026-09-04T14:00:00.000001Z");
    expect(planEndedAt(ledger({ discarded_at: "2026-09-04T09:00:00.000001-05:00" }), { legacySkipAt: "2026-09-04T14:00:00.000002Z" })).toBe("2026-09-04T09:00:00.000001-05:00");
  });
});

describe("live-first and imported trades", () => {
  it("show the banner instead of a stepper and never offer pre-trade AI tools", () => {
    const state = deriveTradeState(liveFirst, ai);
    expect(state).toMatchObject({ label: "Live", step: null, originLabel: "Live-first", originTooltip: NO_PLAN_BANNER, banner: NO_PLAN_BANNER, canDuplicate: false });
    expect(NO_PLAN_BANNER).toBe("No pre-trade plan was recorded before execution.");
    expect(state.secondaryActions.map(a => a.kind)).toEqual(["ADD_ENTRY_DETAILS", "CLOSE_TRADE"]);
    expect(state.editable.entry).toBe("complete");
    const imported = deriveTradeState({ ...liveFirst, origin: "IMPORTED" }, ai);
    expect(imported).toMatchObject({ originLabel: "Imported", originTooltip: null, banner: NO_PLAN_BANNER });
  });

  it("stops offering entry details once every detail and a risk basis are known", () => {
    for (const origin of ["LIVE_FIRST", "IMPORTED"] as const) {
      const state = deriveTradeState({ ...liveFirst, ...completeEntry, origin }, ai);
      expect(state.secondaryActions.map(a => a.kind)).toEqual(["CLOSE_TRADE"]);
      expect(state.editable.entry).toBe("immutable");
    }
  });

  it.each([
    ["no instrument and no risk basis (other symbol)", { symbol: "XAUUSD", instrument_version_id: null, initial_risk: null }],
    ["no risk basis", { initial_risk: null }],
    ["no instrument", { instrument_version_id: null }],
    ["no entry model", { entry_model: null }],
    ["no entry price", { entry_price: null }],
    ["no entry time", { entered_at: null }],
    ["no size", { quantity: null }],
    ["no stop", { initial_stop: null }],
  ] as const)("offers to complete entry details with %s", (_name, missing) => {
    for (const origin of ["LIVE_FIRST", "IMPORTED"] as const) {
      const state = deriveTradeState({ ...liveFirst, ...completeEntry, ...missing, origin }, ai);
      expect(state.secondaryActions).toEqual([{ kind: "ADD_ENTRY_DETAILS", label: "Add entry details" }, { kind: "CLOSE_TRADE", label: "Close trade" }]);
      expect(state.editable.entry).toBe("complete");
    }
  });

  it("never offers entry details for planned trades or after the close", () => {
    expect(deriveTradeState({ ...live, instrument_version_id: null, entry_model: null }, ai).secondaryActions.map(a => a.kind)).toEqual(["CLOSE_TRADE"]);
    const closedImported = deriveTradeState({ ...liveFirst, origin: "IMPORTED", initial_risk: null, exited_at: "2026-09-04T15:00:00Z", outcome: "WIN" }, ai);
    expect(closedImported.secondaryActions.map(a => a.kind)).toEqual(["AI_REVIEW"]);
    expect(closedImported.editable.entry).toBe("immutable");
  });

  it("closed live-first trades get the AI review but no stepper", () => {
    const state = deriveTradeState({ ...liveFirst, exited_at: "2026-09-04T15:00:00Z", outcome: "LOSS" }, ai);
    expect(state).toMatchObject({ label: "Closed · review pending", step: null });
    expect(state.secondaryActions.map(a => a.kind)).toEqual(["AI_REVIEW"]);
  });
});

describe("editability (spec §2.5)", () => {
  // Evidence (soft, audited remove/relabel), journal notes and tags stay open in every state.
  const open = { evidence: "manage", journal: true, tags: true };
  it.each([
    ["draft", ledger(), { ...open, plan: true, entry: "none", close: "none", review: "none" }],
    ["locked", locked, { ...open, plan: false, entry: "record", close: "none", review: "none" }],
    ["live", live, { ...open, plan: false, entry: "immutable", close: "record", review: "none" }],
    ["live-first with missing details", liveFirst, { ...open, plan: false, entry: "complete", close: "record", review: "none" }],
    ["imported with missing details", { ...liveFirst, origin: "IMPORTED" as const }, { ...open, plan: false, entry: "complete", close: "record", review: "none" }],
    ["closed", closed, { ...open, plan: false, entry: "immutable", close: "immutable", review: "complete" }],
    ["reviewed", { ...closed, review_completed_at: now }, { ...open, plan: false, entry: "immutable", close: "immutable", review: "reopen" }],
    ["skipped", { ...locked, disposition: "SKIPPED" as const }, { ...open, plan: false, entry: "none", close: "none", review: "none" }],
    ["cancelled", { ...locked, disposition: "CANCELLED" as const }, { ...open, plan: false, entry: "none", close: "none", review: "none" }],
    ["discarded", ledger({ discarded_at: now }), { ...open, plan: false, entry: "none", close: "none", review: "none" }],
  ])("%s", (_name, row, editable) => expect(deriveTradeState(row, options).editable).toEqual(editable));

  it("states plan immutability in plain words for every trade with a locked plan", () => {
    expect(deriveTradeState(locked, options).immutableNote).toBe(LOCKED_PLAN_NOTE);
    expect(deriveTradeState({ ...locked, disposition: "SKIPPED" }, options).immutableNote).toBe(LOCKED_PLAN_NOTE);
    expect(deriveTradeState(closed, options).immutableNote).toBe(LOCKED_PLAN_NOTE);
    expect(LOCKED_PLAN_NOTE).toBe("Locked plans can't be edited. Later changes are recorded in the journal.");
    expect(deriveTradeState(ledger(), options).immutableNote).toBeNull();
    expect(deriveTradeState(ledger({ legacy_decision: "SKIPPED" }), options).immutableNote).toBeNull();
    expect(deriveTradeState(liveFirst, options).immutableNote).toBeNull();
  });

  it("allows duplicating planned trades with a revision or a plan", () => {
    expect(deriveTradeState(ledger(), options).canDuplicate).toBe(true);
    expect(deriveTradeState(locked, options).canDuplicate).toBe(true);
    expect(deriveTradeState(ledger({ revision_count: 0 }), options).canDuplicate).toBe(false);
  });
});

describe("trades of an archived account (spec §3.2, §9, §14.9)", () => {
  // The database refuses new activity on an archived account (ACCOUNT_ARCHIVED); its trades are finished as usual.
  const archived: TradeStateOptions = { ...ai, accountArchived: true };

  it("a draft can only be discarded: no new revision, check, lock, analysis or duplicate", () => {
    for (const row of [ledger(), checked("BLOCKED"), checked("APPROVED"), ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-03T13:30:00Z" })]) {
      const state = deriveTradeState(row, archived);
      expect(state.nextAction).toBeNull();
      expect(state.secondaryActions.map(action => action.kind)).toEqual(["DISCARD"]);
      expect(state.editable.plan).toBe(false);
      expect(state.canDuplicate).toBe(false);
      // Evidence, journal notes and tags stay open, as on every trade.
      expect(state.editable).toMatchObject({ evidence: "manage", journal: true, tags: true });
    }
    // An approval can't be current while the plan can't be locked: never "Ready to lock".
    expect(deriveTradeState(checked("APPROVED"), archived)).toMatchObject({ draftCheck: "APPROVED", checkCurrent: false });
  });

  it("names the archived account as the reason, never a risk step it can't take, and keeps the fact of the last check", () => {
    expect(ARCHIVED_DRAFT_LABEL).toBe("Account archived");
    const rows: [LedgerTrade, "UNCHECKED" | "BLOCKED" | "APPROVED"][] = [
      [ledger(), "UNCHECKED"],
      [checked("BLOCKED"), "BLOCKED"],
      // A block from an earlier strategy day: no "Recheck risk" either (the database refuses the check).
      [ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-03T13:30:00Z" }), "BLOCKED"],
      // A current approval (it would read "Ready to lock") and one from an earlier day (it would read "Recheck needed").
      [checked("APPROVED"), "APPROVED"],
      [ledger({ latest_check_decision: "APPROVED", latest_check_at: "2026-09-03T13:30:00Z" }), "APPROVED"],
    ];
    for (const [row, draftCheck] of rows) {
      const state = deriveTradeState(row, archived);
      expect(state).toMatchObject({ lifecycle: "DRAFT", draftCheck, checkCurrent: false, label: "Account archived", tone: "muted", step: "Draft", nextAction: null });
      expect(state.label).not.toMatch(/Recheck|Ready to lock|Blocked/);
    }
    // Once the account is restored, the same draft reads as its check says again.
    expect(deriveTradeState(checked("APPROVED"), ai)).toMatchObject({ label: "Ready to lock", tone: "positive", nextAction: { kind: "LOCK_PLAN" } });
    expect(deriveTradeState(checked("APPROVED"), { ...ai, checkCurrent: false })).toMatchObject({ label: "Recheck needed", nextAction: { kind: "RECHECK_RISK" } });
  });

  it("trades it already holds keep their actions, and nothing can be duplicated", () => {
    const same = (row: LedgerTrade) => {
      const { canDuplicate: _archived, ...state } = deriveTradeState(row, archived);
      const { canDuplicate: _active, ...active } = deriveTradeState(row, ai);
      expect(state).toEqual(active);
      expect(deriveTradeState(row, archived).canDuplicate).toBe(false);
    };
    same(locked);
    same(live);
    same(closed);
    same({ ...closed, review_completed_at: now });
    same({ ...locked, disposition: "SKIPPED" });
    same(liveFirst);
    expect(deriveTradeState(locked, archived).nextAction?.kind).toBe("RECORD_ENTRY");
    expect(deriveTradeState(live, archived).secondaryActions.map(action => action.kind)).toContain("CLOSE_TRADE");
  });

  it("is off by default", () => {
    expect(deriveTradeState(checked("APPROVED"), options)).toMatchObject({ label: "Ready to lock", canDuplicate: true });
    expect(deriveTradeState(checked("APPROVED"), { ...options, accountArchived: false }).nextAction?.kind).toBe("LOCK_PLAN");
  });
});

describe("what clears a block found today (spec §2.4, §6.3, §10)", () => {
  // The real engine (report 1.2) on the preview account: equity 10,000, 0.5% → a $50 budget, EURUSD 0.25 lots × 200 ticks.
  const engine = (plan: Partial<RiskContext["plan"]>, usage: Partial<DailyUsage> = {}, proposal: Record<string, unknown> = {}, changes: Partial<RiskContext> = {}) => {
    const ctx: RiskContext = { ...previewContext, ...changes, plan: { ...previewContext.plan, ...plan }, usage: usageFixture(usage) };
    return evaluateRisk({ ...previewProposal, narrative: "Fixture.", contractConfirmed: true, news: "CLEAR", ...proposal }, ctx);
  };
  const blockingCodes = (report: ReturnType<typeof engine>) => report.issues.filter(issue => issue.severity === "BLOCK").map(issue => issue.code);
  const findings = (report: ReturnType<typeof engine>) => blockingFindingsOf(blockingCodes(report), report);
  const blockedToday = ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-04T13:30:00Z" });
  const reason = "Daily trade limit reached: 2 of 2 trades already used today (2 planned, 0 recorded live).";

  it("names how many more reasons the check found after the first", () => {
    expect(reasonWithCount([{ detail: "First." }])).toBe("First.");
    expect(reasonWithCount([{ detail: "First." }, { detail: "Second." }, { detail: "Third." }])).toBe("First. (+2 more)");
    expect(reasonWithCount([])).toBeUndefined();
  });

  it("reads the room each daily cap had left from the stored report, exactly as the engine compared it", () => {
    const risk = engine({ dailyRiskCap: "70.5" }, { plannedRisk: "50.125", plannedSlots: 1 });
    expect(blockingCodes(risk)).toEqual(["DAILY_RISK_LIMIT"]);
    expect(findings(risk)).toEqual([{ code: "DAILY_RISK_LIMIT", room: "20.375" }]);
    const loss = engine({ dailyLossCap: "100" }, { realizedLoss: "30", openExposure: "30.5" });
    expect(findings(loss)).toEqual([{ code: "DAILY_LOSS_LIMIT", room: "39.5", openRisk: "30.5" }]);
    // An older report carries no amounts: an edit is then taken to help.
    expect(blockingFindingsOf(["DAILY_RISK_LIMIT", "MAX_TRADES"], null)).toEqual([{ code: "DAILY_RISK_LIMIT" }, { code: "MAX_TRADES" }]);
  });

  it("clears a daily cap with room left by an edit, and waits for the next day once nothing is left", () => {
    const remedies = (list: BlockingFinding[]) => list.map(blockRemedy);
    expect(remedies(findings(engine({ dailyRiskCap: "70" }, { plannedRisk: "50", plannedSlots: 1 })))).toEqual(["EDIT"]);
    expect(remedies(findings(engine({ dailyRiskCap: "50" }, { plannedRisk: "50", plannedSlots: 1 })))).toEqual(["DAY"]);
    expect(remedies(findings(engine({ dailyLossCap: "100" }, { realizedLoss: "60" })))).toEqual(["EDIT"]);
    expect(remedies(findings(engine({ dailyLossCap: "100" }, { realizedLoss: "100" })))).toEqual(["DAY"]);
    // Open risk fills the limit: closing a position frees room.
    expect(remedies(findings(engine({ dailyLossCap: "100" }, { realizedLoss: "40", openExposure: "60" })))).toEqual(["OPEN_RISK"]);
    // Losses alone reach the limit: closing the open position frees nothing, even at break-even, so only tomorrow helps.
    expect(remedies(findings(engine({ dailyLossCap: "100" }, { realizedLoss: "100", openExposure: "60" })))).toEqual(["DAY"]);
    expect(remedies(findings(engine({ dailyLossCap: "100" }, { realizedLoss: "120", openExposure: "60" })))).toEqual(["DAY"]);
    expect(blockRemedy({ code: "DAILY_LOSS_LIMIT", room: "-59.99", openRisk: "60" })).toBe("OPEN_RISK");
    expect(blockRemedy({ code: "DAILY_LOSS_LIMIT", room: "-60", openRisk: "60" })).toBe("DAY");
    expect(blockRemedy({ code: "DAILY_LOSS_LIMIT", room: "-60", openRisk: null })).toBe("DAY");
    // A duplicate differs once its values change; the trade limit, Dead Pool and stale values never depend on the draft.
    expect(remedies(findings(engine({}, {}, {}, { duplicate: true })))).toEqual(["EDIT"]);
    expect(remedies(findings(engine({}, { plannedSlots: 2 })))).toEqual(["DAY"]);
    expect(remedies(findings(engine({}, {}, {}, { now: "2026-09-04T18:00:00Z" })))).toEqual(["SESSION"]);
    expect(remedies(findings(engine({}, {}, {}, { observationDay: "2026-09-03" })))).toEqual(["ACCOUNT_VALUES"]);
    expect(remedies(findings(engine({}, {}, { riskPercent: "1" })))).toEqual(["EDIT"]);
  });

  it("needs only the recheck for stale values once today's values have been confirmed since the check", () => {
    const stale = engine({}, {}, {}, { observationDay: "2026-09-03" });
    expect(blockingFindingsOf(blockingCodes(stale), stale, { valuesConfirmedToday: true })).toEqual([{ code: "STALE_EQUITY", valuesConfirmed: true }]);
    expect(blockingFindingsOf(["STALE_EQUITY"], null, { valuesConfirmedToday: true }).map(blockRemedy)).toEqual(["RECHECK"]);
    // Values not from today yet, or unknown: confirming them is still the step.
    expect(blockingFindingsOf(blockingCodes(stale), stale, { valuesConfirmedToday: false }).map(blockRemedy)).toEqual(["ACCOUNT_VALUES"]);
    expect(blockingFindingsOf(blockingCodes(stale), stale).map(blockRemedy)).toEqual(["ACCOUNT_VALUES"]);
    // Only the stale-values reason is affected.
    const tradeLimit = engine({}, { plannedSlots: 2 });
    expect(blockingFindingsOf(blockingCodes(tradeLimit), tradeLimit, { valuesConfirmedToday: true })).toEqual([{ code: "MAX_TRADES" }]);
  });

  it("leads with the step that clears the block when no edit can, Edit draft beside it", () => {
    const state = deriveTradeState(blockedToday, { ...ai, checkCurrent: false, blockingReason: reason });
    expect(state.nextAction).toEqual({ kind: "EDIT_DRAFT", label: "Edit draft", detail: reason });
    const edit = { kind: "EDIT_DRAFT", label: "Edit draft", detail: reason };
    const others = state.secondaryActions;
    expect(withBlockingFindings(state, [{ code: "MAX_TRADES" }])).toMatchObject({ label: "Blocked", nextAction: { kind: "RECHECK_RISK", label: "Recheck risk" }, secondaryActions: [edit, ...others] });
    expect(withBlockingFindings(state, [{ code: "DEAD_POOL" }]).nextAction?.kind).toBe("RECHECK_RISK");
    expect(withBlockingFindings(state, [{ code: "DAILY_LOSS_LIMIT", room: "0", openRisk: "60" }]).nextAction?.kind).toBe("RECHECK_RISK");
    expect(withBlockingFindings(state, [{ code: "STALE_EQUITY" }]).nextAction).toEqual({ kind: "CONFIRM_VALUES", label: "Confirm account values" });
    expect(withBlockingFindings(state, [{ code: "STALE_EQUITY" }, { code: "DEAD_POOL" }]).nextAction?.kind).toBe("CONFIRM_VALUES");
    // Confirmed values don't open a day whose limits are used up.
    expect(withBlockingFindings(state, [{ code: "STALE_EQUITY" }, { code: "MAX_TRADES" }]).nextAction?.kind).toBe("RECHECK_RISK");
    // Values confirmed since the check: the recheck is the step, never a second confirmation.
    expect(withBlockingFindings(state, [{ code: "STALE_EQUITY", valuesConfirmed: true }])).toMatchObject({ nextAction: { kind: "RECHECK_RISK" }, secondaryActions: [edit, ...others] });
    expect(withBlockingFindings(state, [{ code: "STALE_EQUITY", valuesConfirmed: true }, { code: "DEAD_POOL" }]).nextAction?.kind).toBe("RECHECK_RISK");
    // Losses alone fill the loss limit: the open position can't free room, and the recheck waits for tomorrow.
    expect(withBlockingFindings(state, [{ code: "DAILY_LOSS_LIMIT", room: "-60", openRisk: "60" }]).nextAction?.kind).toBe("RECHECK_RISK");
    // One reason an edit clears keeps Edit draft first, whatever else blocks.
    for (const list of [[{ code: "DUPLICATE" }], [{ code: "DAILY_RISK_LIMIT", room: "20" }], [{ code: "DAILY_RISK_LIMIT" }], [{ code: "RISK_LIMIT" }, { code: "MAX_TRADES" }]]) {
      expect(withBlockingFindings(state, list)).toBe(state);
    }
    expect(withBlockingFindings(state, [])).toBe(state);
  });

  it("leaves every other state alone: a block from an earlier day, an archived account's draft, an approval", () => {
    const earlier = deriveTradeState(ledger({ latest_check_decision: "BLOCKED", latest_check_at: "2026-09-03T13:30:00Z" }), { ...options, checkCurrent: false });
    expect(withBlockingFindings(earlier, [{ code: "MAX_TRADES" }])).toBe(earlier);
    const frozen = deriveTradeState(blockedToday, { ...options, checkCurrent: false, accountArchived: true });
    expect(withBlockingFindings(frozen, [{ code: "STALE_EQUITY" }])).toBe(frozen);
    const ready = deriveTradeState(checked("APPROVED"), options);
    expect(withBlockingFindings(ready, [{ code: "MAX_TRADES" }])).toBe(ready);
  });
});
