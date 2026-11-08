import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Confirmations of the trade page (docs/V2_ARCHITECTURE.md §2.4, §7.4, §8.1, §13.5): the words each dialog shows, and
// where focus goes when a dialog opened from the overflow menu closes. ConfirmDialog is replaced by a stub that renders
// its props and keeps them, so the copy is visible without a browser and the dialogs' callbacks can be driven directly.

const m = vi.hoisted(() => ({
  dialogs: {} as Record<string, Record<string, unknown>>,
  returnFocusTo: vi.fn(),
  keepFocusOnTrade: vi.fn(),
  closePlannedTrade: vi.fn(),
}));

vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/trades", () => ({
  checkRisk: vi.fn(), lockPlan: vi.fn(), duplicateDraft: vi.fn(), setDisposition: vi.fn(), reopenReview: vi.fn(),
  discardDraft: vi.fn(async () => ({ status: "success", message: "Draft discarded." })),
  closePlannedTrade: m.closePlannedTrade, closeLiveTrade: vi.fn(), recordEntry: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({
  ConfirmDialog: (props: Record<string, unknown> & { title: string; description?: string; confirmLabel: string; cancelLabel?: string; children?: ReactNode }) => {
    m.dialogs[props.title] = props;
    return createElement(
      "section",
      { "data-dialog": props.title },
      createElement("h2", null, props.title),
      createElement("p", null, props.description ?? ""),
      createElement("span", { "data-role": "cancel" }, props.cancelLabel ?? "Cancel"),
      createElement("span", { "data-role": "confirm" }, props.confirmLabel),
      props.children,
    );
  },
}));
vi.mock("@/components/trade/reveal", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/trade/reveal")>()),
  returnFocusTo: m.returnFocusTo,
  keepFocusOnTrade: m.keepFocusOnTrade,
}));

import { CloseTradeForm, type CloseTradeFormProps } from "@/components/trade/close-trade-form";
import {
  AVERAGE_REASON_COPY, CLOSE_COPY, type CloseFormContext, closeFormContext, closeSubmission, ENTRY_COPY, entrySubmission, type EntrySubmissionInput,
} from "@/components/trade/close-model";
import { type CloseDraft, type EntryDraft, FORM_COPY } from "@/components/trade/form-model";
import type { HeaderActionsModel } from "@/components/trade/model";
import { RecordConfirmDialog } from "@/components/trade/record-confirm-dialog";
import { RecordEntryForm } from "@/components/trade/record-entry-form";
import { type TradeActionContext, TradeMenu } from "@/components/trade/trade-actions";
import { DuplicateDialog, SkipTradeDialog } from "@/components/trade/trade-dialogs";
import { closeLegs, type PartialCloseRecord, type SplitClose } from "@/domain/partial-closes";
import { STRATEGY_TIME } from "@/domain/time-display";
import type { TimelineItem } from "@/domain/timeline";
import type { TradeDetail } from "@/lib/trades-data";

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeEach(() => {
  m.dialogs = {};
  m.returnFocusTo.mockClear();
  m.keepFocusOnTrade.mockClear();
  m.closePlannedTrade.mockClear();
});

describe("skip and cancel confirmation (§2.4, §6.2)", () => {
  it("names the trading day the plan keeps counting toward and labels the way out Keep plan", () => {
    const html = decode(renderToStaticMarkup(createElement(SkipTradeDialog, { tradeId: "trade", slotNote: "It still counts as one of Oct 22's planned trades." })));
    expect(html).toContain("<h2>Skip this trade?</h2>");
    expect(html).toContain("The locked plan stays in your history with your reason. It still counts as one of Oct 22's planned trades.");
    expect(html).toContain('<span data-role="cancel">Keep plan</span>');
    expect(html).toContain('<span data-role="confirm">Skip trade</span>');
    // Both choices are offered; choosing Cancelled retitles the dialog (skipDialogCopy, tested with the model).
    expect(html).toContain("Skipped");
    expect(html).toContain("Cancelled");
  });
});

describe("duplicate confirmation (§3.4, §7.4)", () => {
  it("lists what duplicating copies, including that screenshots added after the plan ended stay with the trade", () => {
    const notes = ["Economic news is reset.", "Screenshots recorded before entry are copied.", "1 screenshot added after the skip stays with this trade."];
    const html = renderToStaticMarkup(createElement(DuplicateDialog, { tradeId: "trade", requestKey: "key", notes }));
    expect(html.match(/<li>/g)).toHaveLength(3);
    for (const note of notes) expect(html).toContain(`<li>${note}</li>`);
  });
});

describe("dialogs opened from the overflow menu (§13.5)", () => {
  const model: HeaderActionsModel = {
    primary: null,
    secondary: [],
    menu: [{ kind: "DUPLICATE", label: "Duplicate draft" }, { kind: "DISCARD", label: "Discard draft", destructive: true }, { kind: "TECHNICAL", label: "Technical details" }],
  };
  const context: TradeActionContext = {
    tradeId: "trade", editHref: "/trades/trade/edit", expectedRevision: 1, lock: null, keys: { duplicate: "k1", discard: "k2", reopen: "k3" },
    duplicateNotes: ["Economic news is reset."], skipNote: "It still counts as one of today's planned trades.",
  };
  type Driven = { onOpenChange: (open: boolean) => void; onConfirm: () => Promise<unknown> };

  it("gives focus back to the menu button when a dialog is dismissed, and leaves it to the trade after a confirmed action", async () => {
    renderToStaticMarkup(createElement(TradeMenu, { model, context }));
    expect(m.dialogs["Duplicate as a new draft?"]).toMatchObject({ open: false });
    const discard = m.dialogs["Discard this draft?"] as unknown as Driven;
    // Escape or Keep: the dialog has no trigger of its own, so focus goes back to the menu button.
    discard.onOpenChange(false);
    expect(m.returnFocusTo).toHaveBeenCalledTimes(1);
    m.returnFocusTo.mockClear();
    // A confirmed discard: the trade's new state takes focus, the menu button doesn't.
    await expect(discard.onConfirm()).resolves.toMatchObject({ status: "success" });
    expect(m.keepFocusOnTrade).toHaveBeenCalledTimes(1);
    discard.onOpenChange(false);
    expect(m.returnFocusTo).not.toHaveBeenCalled();
    // The next dismissal returns focus again.
    discard.onOpenChange(false);
    expect(m.returnFocusTo).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Close trade and Record entry: records that can't be changed are confirmed first (spec §57), and partial closes the
// journal knows are never worked out by hand (§3.6, spec §60.17).
// ---------------------------------------------------------------------------------------------------------------------

const visible = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const OPEN: CloseDraft = { exit: "", netPnl: "", pnlKind: null, fees: "", time: { mode: "now" } };
/** The reviewed trade: 1.25 lots of EURUSD long from 1.10000 with $250.00 locked risk. */
const PLANNED: CloseFormContext = {
  position: { direction: "LONG", entryPrice: "1.1", quantity: "1.25", tickSize: "0.00001", tickValue: "1" }, riskBasis: "250", planned: true, quantityStep: "0.01",
  unit: "lots", legs: { kind: "NONE" },
};
const partial = (id: string, details: Partial<PartialCloseRecord>): PartialCloseRecord => ({ id, recordedAt: `2026-10-23T09:0${id.length}:00Z`, price: null, quantity: null, percent: null, ...details });
/** The seeded live trade: 5.23 lots of GBPUSD short from 1.33494 ($1,061.69 locked risk), 30% closed at 1.33291. */
const SCALED_OUT = closeLegs([partial("a", { percent: "30", price: "1.33291" })], { quantity: "5.23" }) as SplitClose;
const GBPUSD_SHORT: CloseFormContext = {
  position: { direction: "SHORT", entryPrice: "1.33494", quantity: "5.23", tickSize: "0.00001", tickValue: "1" }, riskBasis: "1061.69", planned: true,
  quantityStep: "0.01", unit: "lots", legs: SCALED_OUT,
};
const closeInput = (context: CloseFormContext | null, split: SplitClose | null = null) =>
  ({ mode: "planned", tickSize: "0.00001", currency: "USD", display: STRATEGY_TIME, entered: null, split, context }) as const;

describe("closing a trade is confirmed with its result first (§57)", () => {
  it("opens the confirmation from a valid form and never sends the close from the submit itself", () => {
    // The submit (button, Enter, Ctrl/⌘+Enter) has two outcomes only: field errors, or the confirmation.
    const next = closeSubmission({ ...OPEN, exit: "1.10400" }, closeInput(PLANNED));
    expect(next).toEqual({
      kind: "confirm",
      fields: { exitedAt: "now", exit: "1.10400", fees: "0" },
      review: {
        recorded: [
          { label: "Exit price", value: "1.10400" }, { label: "Exit time", value: "Now", hint: "The server's time when you confirm." }, { label: "Fees", value: "None" },
        ],
        result: [
          { label: "Outcome", value: "Win", tone: "positive" }, { label: "Net P&L", value: "+$500.00", tone: "positive" },
          { label: "Realized R", value: "+2.00R", tone: "positive", hint: "Net P&L ÷ $250.00, the locked risk." },
        ],
        previewed: true,
      },
    });
    expect(closeSubmission(OPEN, closeInput(PLANNED))).toEqual({ kind: "invalid", fieldErrors: { exit: FORM_COPY.exitRequired } });
    expect(m.closePlannedTrade).not.toHaveBeenCalled();
  });

  it("shows a loss with its fees, an earlier exit time in the person's display, and no R without a risk basis", () => {
    const loss = closeSubmission({ ...OPEN, exit: "1.09900", fees: "7.5", time: { mode: "earlier", wall: "2026-10-23T08:05" } }, closeInput(PLANNED));
    expect(loss.kind === "confirm" && loss.review).toEqual({
      recorded: [{ label: "Exit price", value: "1.09900" }, { label: "Exit time", value: "Oct 23, 08:05 UTC−5" }, { label: "Fees", value: "$7.50" }],
      result: [
        { label: "Outcome", value: "Loss", tone: "negative" }, { label: "Net P&L", value: "-$132.50", tone: "negative", hint: "Gross -$125.00 − fees $7.50." },
        { label: "Realized R", value: "-0.53R", tone: "negative", hint: "Net P&L ÷ $250.00, the locked risk." },
      ],
      previewed: true,
    });
    const noRisk = closeSubmission({ ...OPEN, exit: "1.10400" }, { ...closeInput({ ...PLANNED, planned: false, riskBasis: null }), mode: "calculated" });
    expect(noRisk.kind === "confirm" && noRisk.fields).toEqual({ exitedAt: "now", exitPrice: "1.10400" });
    expect(noRisk.kind === "confirm" && noRisk.review.result[2]).toEqual({ label: "Realized R", value: "Not available", hint: "No risk is recorded for this trade.", tone: "muted" });
  });

  it("states the R basis rounded up to the cent, as the plan, the lock confirmation and Today state the locked risk (§6.6)", () => {
    // 530.452 reads $530.46 everywhere the locked risk is shown; half-up rounding would make this one dialog say $530.45.
    const next = closeSubmission({ ...OPEN, exit: "1.10400" }, closeInput({ ...PLANNED, riskBasis: "530.452" }));
    expect(next.kind === "confirm" && next.review.result[2]?.hint).toBe("Net P&L ÷ $530.46, the locked risk.");
  });

  it("states a reported result with its sign, and says when the result is only known once confirmed", () => {
    const reported = closeSubmission(
      { ...OPEN, pnlKind: "loss", netPnl: "295.5", fees: "4" },
      { ...closeInput({ ...PLANNED, position: null, planned: false, riskBasis: "100" }), mode: "reported", tickSize: null },
    );
    expect(reported.kind === "confirm" && reported.review).toEqual({
      recorded: [
        { label: "Exit price", value: "Not recorded", tone: "muted" }, { label: "Exit time", value: "Now", hint: "The server's time when you confirm." },
        { label: "Fees", value: "$4.00", hint: CLOSE_COPY.feesIncluded },
      ],
      result: [
        { label: "Outcome", value: "Loss", tone: "negative" }, { label: "Net P&L", value: "-$295.50", tone: "negative", hint: "Reported by you." },
        { label: "Realized R", value: "-2.96R", tone: "negative", hint: "Net P&L ÷ $100.00, the risk recorded after entry." },
      ],
      previewed: true,
    });
    // Without the trade's facts nothing is guessed: the database still computes the result, and the review says so.
    const unknown = closeSubmission({ ...OPEN, exit: "1.10400" }, closeInput(null));
    expect(unknown.kind === "confirm" && unknown.review).toMatchObject({
      result: [{ label: "Net P&L", value: CLOSE_COPY.calculatedOnConfirm, tone: "muted" }, { label: "Realized R", value: CLOSE_COPY.calculatedOnConfirm, tone: "muted" }],
      previewed: false,
    });
    // A reported close still shows the trader's own net P&L; only its R waits for the database, with its basis in words.
    const basis = "R based on risk recorded after entry: realized R = net P&L ÷ $100.00.";
    const reportedUnknown = closeSubmission({ ...OPEN, pnlKind: "profit", netPnl: "42.5" }, { ...closeInput(null), mode: "reported", tickSize: null, basis });
    expect(reportedUnknown.kind === "confirm" && reportedUnknown.review).toMatchObject({
      result: [
        { label: "Outcome", value: "Win" }, { label: "Net P&L", value: "+$42.50", hint: "Reported by you." },
        { label: "Realized R", value: CLOSE_COPY.calculatedOnConfirm, tone: "muted", hint: basis },
      ],
      previewed: true,
    });
  });

  it("works out the one exit of a position closed in parts from the exit of the rest, with the arithmetic", () => {
    const next = closeSubmission({ ...OPEN, rest: "1.33300" }, closeInput(GBPUSD_SHORT, SCALED_OUT));
    // 30% at 1.33291 and 70% at 1.33300 close at 1.332973 on average: 1.33297 on the tick, sent as the one exit price.
    expect(next.kind === "confirm" && next.fields).toEqual({ exitedAt: "now", exit: "1.33297", fees: "0" });
    expect(next.kind === "confirm" && next.review.recorded[0]).toEqual({
      label: "Exit price", value: "1.33297", hint: "Average of every partial close and the rest: 30% × 1.33291 + 70% × 1.33300 = 1.332973, rounded to the 0.00001 tick.",
    });
    // 197 ticks × 5.23 lots, R on the locked $1,061.69.
    expect(next.kind === "confirm" && next.review.result.map(fact => fact.value)).toEqual(["Win", "+$1,030.31", "+0.97R"]);
    // The rest's price is what the trader enters; an average they may have typed elsewhere is never sent.
    expect(closeSubmission({ ...OPEN, exit: "1.33300" }, closeInput(GBPUSD_SHORT, SCALED_OUT))).toEqual({ kind: "invalid", fieldErrors: { exit: FORM_COPY.restRequired } });
    expect(closeSubmission({ ...OPEN, rest: "1.333005" }, closeInput(GBPUSD_SHORT, SCALED_OUT)))
      .toEqual({ kind: "invalid", fieldErrors: { exit: "Prices must be a multiple of the 0.00001 tick size." } });
    // A trader who types the average instead (the toggle) closes at exactly that price.
    const own = closeSubmission({ ...OPEN, exit: "1.33300", rest: "1.33250" }, closeInput(GBPUSD_SHORT));
    expect(own.kind === "confirm" && own.fields).toEqual({ exitedAt: "now", exit: "1.33300", fees: "0" });
  });

  it("reads the position, its R basis and the live partial closes from the trade", () => {
    const item = (id: string, details: Record<string, unknown>, changes: Partial<TimelineItem> = {}): TimelineItem => ({
      id, kind: "JOURNAL", journalKind: "PARTIAL_CLOSE", at: "2026-10-23T09:00:00Z", recordedAt: "2026-10-23T09:00:00Z", timing: "WHILE_LIVE", flags: [], title: "Partial close",
      source: id, timeLabel: "09:00", details, ...changes,
    });
    const detail = (changes: Record<string, unknown> = {}) => ({
      origin: "PLANNED", timelineTruncated: false, timeline: [item("a", { percent: "30", price: "1.33291" }), item("b", { percent: "50", price: "1.3" }, { timing: "BEFORE_ENTRY" })],
      instrument: { symbol: "GBPUSD", currency: "USD", quantityUnit: "lots (100,000 GBP)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01" },
      technical: { ledger: { direction: "SHORT", entry_price: "1.33494", quantity: "5.23", initial_risk: "1061.69" } }, ...changes,
    }) as unknown as TradeDetail;
    expect(closeFormContext(detail())).toEqual({ ...GBPUSD_SHORT, legs: { ...SCALED_OUT, legs: [{ ...SCALED_OUT.legs[0], recordedAt: "2026-10-23T09:00:00Z" }] } });
    expect(closeFormContext(detail({ timelineTruncated: true })).legs).toMatchObject({ kind: "AVERAGE", reason: "UNREAD" });
    // A live-first position without a contract reports its net P&L: partial closes don't change it.
    expect(closeFormContext(detail({ origin: "LIVE_FIRST", instrument: null }))).toEqual({
      position: null, riskBasis: "1061.69", planned: false, quantityStep: null, unit: "", legs: { kind: "NONE" },
    });
  });
});

describe("the close form (§3.4–3.6)", () => {
  const props: CloseTradeFormProps = {
    tradeId: "trade", mode: "planned", currency: "USD", tickSize: "0.00001", basis: "R based on locked risk: realized R = net P&L ÷ $1,061.69.", entered: null,
    display: STRATEGY_TIME, nowIso: "2026-10-23T13:00:00Z",
  };

  it("asks for the exit of the rest when the journal knows the partial closes, and offers to type the average instead", () => {
    const text = visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: GBPUSD_SHORT })));
    expect(text).toContain("Partial closes in your journal 30% (≈ 1.57 lots) at 1.33291");
    expect(text).toContain("Exit price of the remaining 70% (≈ 3.66 lots)");
    expect(text).toContain(CLOSE_COPY.averagePending);
    expect(text).toContain("Enter the average exit price yourself");
    expect(text).not.toContain("Average exit price (all partials)");
    expect(text).toContain(CLOSE_COPY.recordedOnce);
  });

  it("asks for the average across partial closes it can't work out, saying why, and fills in partials that close everything", () => {
    const later = closeLegs([partial("a", { quantity: "1", price: "1.3325" }), partial("bb", { percent: "50", price: "1.333" })], { quantity: "5.23" });
    const text = visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: { ...GBPUSD_SHORT, legs: later } })));
    expect(text).toContain("Partial closes in your journal 1.00 lots at 1.33250 50% at 1.33300");
    expect(text).toContain(AVERAGE_REASON_COPY.LATER_PERCENT);
    expect(text).toContain("Average exit price (all partials)");
    expect(text).toContain(CLOSE_COPY.averageHint);
    const whole = closeLegs([partial("a", { quantity: "2", price: "1.101" }), partial("bb", { quantity: "3.23", price: "1.102" })], { quantity: "5.23" });
    const html = renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: { ...GBPUSD_SHORT, legs: whole } }));
    expect(html).toContain('value="1.10162"');
    expect(visible(html)).toContain(AVERAGE_REASON_COPY.WHOLE_POSITION);
    // Without partial closes nothing changes; a reported close never lists them.
    const plain = visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: PLANNED })));
    expect(plain).toContain("Average exit price (all partials)");
    expect(plain).toContain("One price for the whole position. Partial closes stay in the journal.");
    expect(plain).not.toContain("Partial closes in your journal");
    expect(visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, mode: "reported", tickSize: null, context: GBPUSD_SHORT })))).not.toContain("Partial closes in your journal");
  });

  it("keeps its confirmation closed until the form is submitted, and the confirmation alone sends nothing without one", async () => {
    renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: PLANNED }));
    const dialog = m.dialogs[CLOSE_COPY.dialogTitle] as { open: boolean; confirmLabel: string; cancelLabel: string; description: string; onConfirm: () => Promise<unknown> };
    expect(dialog).toMatchObject({ open: false, confirmLabel: "Close trade", cancelLabel: "Keep editing", description: CLOSE_COPY.dialogDescription });
    await expect(dialog.onConfirm()).resolves.toMatchObject({ status: "error" });
    expect(m.closePlannedTrade).not.toHaveBeenCalled();
  });

  it("never claims the result is checked first when it can't be worked out, and names what R will be based on", () => {
    // Without the position's facts (a caller that doesn't pass closeFormContext) only the database computes the result.
    const without = visible(renderToStaticMarkup(createElement(CloseTradeForm, props)));
    expect(without).not.toMatch(/check the result/i);
    expect(without).toContain(CLOSE_COPY.recordedOnceWithoutResult);
    expect(m.dialogs[CLOSE_COPY.dialogTitle]).toMatchObject({ open: false, description: CLOSE_COPY.dialogDescriptionWithoutResult });
    const next = closeSubmission({ ...OPEN, exit: "1.10400" }, { ...closeInput(null), basis: props.basis });
    expect(next.kind === "confirm" && next.review).toEqual({
      recorded: [{ label: "Exit price", value: "1.10400" }, { label: "Exit time", value: "Now", hint: CLOSE_COPY.nowHint }, { label: "Fees", value: "None" }],
      result: [
        { label: "Net P&L", value: CLOSE_COPY.calculatedOnConfirm, tone: "muted" },
        { label: "Realized R", value: CLOSE_COPY.calculatedOnConfirm, tone: "muted", hint: "R based on locked risk: realized R = net P&L ÷ $1,061.69." },
      ],
      previewed: false,
    });
    // With them the same form promises the result, and its confirmation shows it (and so does a reported close's).
    const withFacts = visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, context: PLANNED })));
    expect(withFacts).toContain(CLOSE_COPY.recordedOnce);
    expect(m.dialogs[CLOSE_COPY.dialogTitle]).toMatchObject({ description: CLOSE_COPY.dialogDescription });
    expect(visible(renderToStaticMarkup(createElement(CloseTradeForm, { ...props, mode: "reported", tickSize: null })))).toContain(CLOSE_COPY.recordedOnce);
  });
});

describe("the confirmation of a record (§57)", () => {
  it("lists what will be recorded, and hands the form the last result once it closes", async () => {
    const onConfirm = vi.fn(async () => ({ status: "error" as const, message: "This trade is already closed with different values." }));
    const onClosed = vi.fn();
    const groups = [
      { title: "Recorded", facts: [{ label: "Exit price", value: "1.10400" }, { label: "Exit time", value: "Now", hint: "The server's time when you confirm." }] },
      { title: "Result", facts: [{ label: "Net P&L", value: "+$500.00", tone: "positive" as const }, { label: "Realized R", value: "Not available", tone: "muted" as const }] },
    ];
    const html = renderToStaticMarkup(createElement(RecordConfirmDialog, {
      open: true, title: CLOSE_COPY.dialogTitle, description: CLOSE_COPY.dialogDescription, confirmLabel: CLOSE_COPY.confirm, pendingLabel: CLOSE_COPY.pending,
      cancelLabel: CLOSE_COPY.keepEditing, groups, onConfirm, onClosed,
    }));
    expect(visible(html)).toContain("Recorded Exit price 1.10400 Exit time Now The server's time when you confirm. Result Net P&L +$500.00 Realized R Not available");
    expect(html).toMatch(/<dt[^>]*>Net P&amp;L<\/dt><dd[^>]*><span class="[^"]*value-pos[^"]*">\+\$500\.00<\/span>/);
    const dialog = m.dialogs[CLOSE_COPY.dialogTitle] as { onConfirm: () => Promise<unknown>; onOpenChange: (open: boolean) => void };
    await expect(dialog.onConfirm()).resolves.toEqual({ status: "error", message: "This trade is already closed with different values." });
    dialog.onOpenChange(false);
    expect(onClosed).toHaveBeenLastCalledWith({ status: "error", message: "This trade is already closed with different values." });
    // Dismissed again without sending: nothing to hand over.
    dialog.onOpenChange(false);
    expect(onClosed).toHaveBeenLastCalledWith(null);
  });
});

describe("recording an entry (§8.5, §57)", () => {
  const draft = (changes: Partial<EntryDraft> = {}): EntryDraft => ({ entry: "1.10000", quantity: "0.25", time: { mode: "now" }, confirmOversize: false, ...changes });
  const input: EntrySubmissionInput = {
    planned: { entry: "1.10000", quantity: "0.25" }, contract: { tickSize: "0.00001", quantityStep: "0.01", unit: "lots" }, display: STRATEGY_TIME, locked: null,
  };

  it("records the plan's fill now at once, and confirms anything the trader typed first", () => {
    expect(entrySubmission(draft(), input)).toEqual({ kind: "send", fields: { entry: "1.10000", quantity: "0.25", enteredAt: "now" } });
    expect(entrySubmission(draft({ entry: "1.10012" }), input)).toEqual({
      kind: "confirm", fields: { entry: "1.10012", quantity: "0.25", enteredAt: "now" },
      facts: [
        { label: "Entry price", value: "1.10012", hint: "12 ticks above the plan's 1.10000" }, { label: "Size", value: "0.25 lots", hint: ENTRY_COPY.asPlanned },
        { label: "Entry time", value: "Now", hint: "The server's time when you confirm." },
      ],
    });
    expect(entrySubmission(draft({ entry: "1.09999" }), input)).toMatchObject({ kind: "confirm", facts: [{ hint: "1 tick below the plan's 1.10000" }, {}, {}] });
    expect(entrySubmission(draft({ quantity: "0.2" }), input)).toMatchObject({ kind: "confirm", facts: [{ hint: ENTRY_COPY.atPlan }, { value: "0.20 lots", hint: "0.80× the plan's 0.25 lots" }, {}] });
    // An oversized fill keeps its own confirmation (§8.5) and is named as a deviation once more.
    expect(entrySubmission(draft({ quantity: "0.5" }), input)).toEqual({ kind: "invalid", fieldErrors: { confirmOversize: FORM_COPY.oversize } });
    expect(entrySubmission(draft({ quantity: "0.5", confirmOversize: true }), input))
      .toMatchObject({ kind: "confirm", fields: { confirmOversize: "on" }, facts: [{}, { hint: "2.00× the plan's 0.25 lots. Recorded as a size deviation." }, {}] });
    // A typed time is shown in the person's display before it is recorded.
    expect(entrySubmission(draft({ time: { mode: "earlier", wall: "2026-10-23T08:05" } }), input))
      .toMatchObject({ kind: "confirm", facts: [{}, {}, { label: "Entry time", value: "Oct 23, 08:05 UTC−5" }] });
    expect(entrySubmission(draft({ entry: "" }), input)).toEqual({ kind: "invalid", fieldErrors: { entry: FORM_COPY.entryRequired } });
  });

  it("keeps the entry confirmation closed until the form is submitted", () => {
    renderToStaticMarkup(createElement(RecordEntryForm, {
      tradeId: "trade", defaults: { entry: "1.10000", quantity: "0.25" }, planned: { entry: "1.10000", quantity: "0.25", quantityExact: "0.25" },
      contract: input.contract, locked: null, display: STRATEGY_TIME, nowIso: "2026-10-23T13:00:00Z",
    }));
    expect(m.dialogs[ENTRY_COPY.dialogTitle]).toMatchObject({ open: false, confirmLabel: "Record entry", cancelLabel: "Keep editing" });
  });
});
