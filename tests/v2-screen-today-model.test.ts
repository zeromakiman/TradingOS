import { describe, expect, it } from "vitest";
import { checkedOnLead, EARLIER_LOCKED_LABEL, EARLIER_LOCKED_NOTE, skipPlanDescription, UNSAVED_BADGE } from "@/components/today/copy";
import { anyPanelShown, cardPanels, hidePanel, type LivePanel, type LivePanelsState, openPanel } from "@/components/today/live-panels-model";
import { MANAGEMENT_COLUMNS, type ManagementRow, managementRow, summarizeManagement } from "@/components/today/management";
import { holdsDraft } from "@/components/today/use-kept-draft";

// Today's live trade cards (docs/V2_ARCHITECTURE.md §14.1, §3.6, §7.1): the pure rules behind the inline panels (nothing
// typed or staged is lost; a paste always lands on the trade whose capture panel is in view) and the management summary
// (stop moves and partial closes) the cards show.

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const focus = (panel: LivePanel, key: number) => ({ panel, key, preventScroll: false });

describe("Today · live card panels", () => {
  it("keeps Add note and Paste screenshot independent: opening one never hides the other", () => {
    let state: LivePanelsState = {};
    state = openPanel(state, A, "note", focus("note", 1));
    state = openPanel(state, A, "screenshot", focus("screenshot", 2));
    expect(cardPanels(state, A).shown).toEqual({ note: true, screenshot: true });
    expect(cardPanels(state, A).focus).toEqual(focus("screenshot", 2));
  });

  it("keeps a closed panel mounted, so a typed note or staged screenshots survive closing and reopening it", () => {
    let state = openPanel({}, A, "note", focus("note", 1));
    state = hidePanel(state, A, "note");
    expect(cardPanels(state, A)).toMatchObject({ shown: { note: false }, kept: { note: true } });
    state = openPanel(state, A, "note", focus("note", 2));
    expect(cardPanels(state, A)).toMatchObject({ shown: { note: true }, kept: { note: true }, focus: { panel: "note", key: 2 } });
  });

  it("shows one capture panel on the page: opening one hides, and keeps, the other card's", () => {
    let state = openPanel({}, A, "screenshot", focus("screenshot", 1));
    state = openPanel(state, A, "note", focus("note", 2));
    state = openPanel(state, B, "screenshot", focus("screenshot", 3));
    expect(cardPanels(state, A)).toMatchObject({ shown: { note: true, screenshot: false }, kept: { note: true, screenshot: true } });
    expect(cardPanels(state, B).shown.screenshot).toBe(true);
    // Notes capture only inside their own composer, so B's note never hides A's.
    state = openPanel(state, B, "note", focus("note", 4));
    expect(cardPanels(state, A).shown.note).toBe(true);
    // Back to A: B's capture panel steps aside, still holding what it staged.
    state = openPanel(state, A, "screenshot", focus("screenshot", 5));
    expect(cardPanels(state, B)).toMatchObject({ shown: { note: true, screenshot: false }, kept: { screenshot: true } });
  });

  it("tells the phone dock whether any panel is in view", () => {
    expect(anyPanelShown({})).toBe(false);
    const state = openPanel({}, A, "note", focus("note", 1));
    expect(anyPanelShown(state)).toBe(true);
    expect(anyPanelShown(hidePanel(state, A, "note"))).toBe(false);
  });

  it("leaves the state as it is when the panel to hide isn't in view", () => {
    const state = openPanel({}, A, "note", focus("note", 1));
    expect(hidePanel(state, A, "screenshot")).toBe(state);
    expect(hidePanel(state, B, "note")).toBe(state);
  });
});

describe("Today · unsaved work in a hidden panel", () => {
  const panel = (values: string[], staged = false) =>
    ({
      querySelector: (selector: string) => (staged && selector.includes("Screenshots to save") ? {} : null),
      querySelectorAll: () => values.map(value => ({ value })),
    }) as unknown as ParentNode;

  it("counts typed text and staged screenshots, never empty fields", () => {
    expect(holdsDraft(panel([]))).toBe(false);
    expect(holdsDraft(panel(["", "   "]))).toBe(false);
    expect(holdsDraft(panel(["", "Price rejected 1.1650 twice"]))).toBe(true);
    expect(holdsDraft(panel([], true))).toBe(true);
  });
});

describe("Today · copy for earlier days and kept work", () => {
  it("says which day an earlier check or lock belongs to, in exact words", () => {
    expect(checkedOnLead("Oct 23")).toBe("When checked on Oct 23:");
    expect(EARLIER_LOCKED_LABEL).toBe("Locked on an earlier day");
    expect(EARLIER_LOCKED_NOTE).toBe(
      "Each plan's trade slot and risk were reserved on the day it was locked, not today. Record the entry if you took the trade; otherwise skip it.",
    );
    expect(skipPlanDescription("Oct 23")).toBe(
      "The locked plan stays in your history with your reason. Its trade slot and risk stay counted on Oct 23, the day it was locked.",
    );
    expect(UNSAVED_BADGE).toBe("Unsaved");
  });
});

describe("Today · live position management", () => {
  const row = (n: number, tradeId: string, kind: ManagementRow["kind"], details: Record<string, unknown>, recordedAt: string): ManagementRow => ({
    id: `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, trade_id: tradeId, kind, details, recorded_at: recordedAt,
  });

  it("keeps the newest stop move per trade (microsecond-exact) and every partial close, newest first", () => {
    const summary = summarizeManagement([
      row(1, A, "STOP_CHANGE", { price: "1.1" }, "2026-10-23T12:00:00.000001Z"),
      row(2, A, "STOP_CHANGE", { price: "1.099" }, "2026-10-23T12:00:00Z"),
      row(3, A, "PARTIAL_CLOSE", { percent: "30", price: "1.104" }, "2026-10-23T11:00:00Z"),
      row(4, A, "PARTIAL_CLOSE", { quantity: "0.1" }, "2026-10-23T12:30:00Z"),
      row(5, B, "PARTIAL_CLOSE", {}, "2026-10-23T12:30:00Z"),
    ]);
    expect(summary.get(A)).toEqual({
      stop: { price: "1.1", recordedAt: "2026-10-23T12:00:00.000001Z" },
      partials: [
        { percent: null, quantity: "0.1", price: null, recordedAt: "2026-10-23T12:30:00Z" },
        { percent: "30", quantity: null, price: "1.104", recordedAt: "2026-10-23T11:00:00Z" },
      ],
    });
    expect(summary.get(B)).toEqual({ stop: null, partials: [{ percent: null, quantity: null, price: null, recordedAt: "2026-10-23T12:30:00Z" }] });
  });

  it("ignores details that are not exact decimals instead of guessing", () => {
    const summary = summarizeManagement([
      row(1, A, "STOP_CHANGE", { price: 1.1 }, "2026-10-23T12:10:00Z"),
      row(2, A, "STOP_CHANGE", { price: "1.0985" }, "2026-10-23T12:00:00Z"),
      row(3, A, "PARTIAL_CLOSE", { percent: "1e1" }, "2026-10-23T12:00:00Z"),
    ]);
    expect(summary.get(A)?.stop).toEqual({ price: "1.0985", recordedAt: "2026-10-23T12:00:00Z" });
    expect(summary.get(A)?.partials[0].percent).toBeNull();
  });

  it("reads only what was recorded while the position was live, never a stop or partial journaled before the entry", () => {
    // A locked plan with a 50% "partial" and a stop journaled before its entry, then entered: none of it describes
    // the open position. Rows stored after a close don't either.
    const phased = (n: number, kind: ManagementRow["kind"], details: Record<string, unknown>, recordedAt: string, phase: ManagementRow["phase"]) => ({
      ...row(n, A, kind, details, recordedAt), phase,
    });
    const summary = summarizeManagement([
      phased(1, "PARTIAL_CLOSE", { percent: "50", price: "1.1031" }, "2026-10-23T12:00:00Z", "PRE_ENTRY"),
      phased(2, "STOP_CHANGE", { price: "1.1" }, "2026-10-23T12:01:00Z", "PRE_ENTRY"),
      phased(3, "STOP_CHANGE", { price: "1.0995" }, "2026-10-23T12:30:00Z", "LIVE"),
      phased(4, "STOP_CHANGE", { price: "1.105" }, "2026-10-23T13:00:00Z", "POST_TRADE"),
      phased(5, "PARTIAL_CLOSE", { percent: "30" }, "2026-10-23T13:00:00Z", "POST_TRADE"),
    ]);
    expect(summary.get(A)).toEqual({ stop: { price: "1.0995", recordedAt: "2026-10-23T12:30:00Z" }, partials: [] });
    expect(summarizeManagement([phased(1, "PARTIAL_CLOSE", { percent: "50" }, "2026-10-23T12:00:00Z", "PRE_ENTRY")]).has(A)).toBe(false);
  });

  it("reads the stored phase with the rows, and refuses a phase the database doesn't have", () => {
    expect(MANAGEMENT_COLUMNS.split(",")).toEqual(["id", "trade_id", "kind", "details", "recorded_at", "phase"]);
    const stored = { ...row(1, A, "STOP_CHANGE", { price: "1.1" }, "2026-10-23T12:00:00Z"), phase: "LIVE" };
    expect(managementRow.parse(stored)).toEqual(stored);
    expect(managementRow.safeParse({ ...stored, phase: "WHILE_LIVE" }).success).toBe(false);
  });
});
