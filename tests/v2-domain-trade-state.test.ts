import { describe, expect, it } from "vitest";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { deriveDraftCheck, deriveLifecycle, deriveTradeState, LOCKED_PLAN_NOTE, NO_PLAN_BANNER, type TradeStateOptions } from "@/domain/trade-state";

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
