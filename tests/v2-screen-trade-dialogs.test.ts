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
}));

vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/trades", () => ({
  checkRisk: vi.fn(), lockPlan: vi.fn(), duplicateDraft: vi.fn(), setDisposition: vi.fn(), reopenReview: vi.fn(),
  discardDraft: vi.fn(async () => ({ status: "success", message: "Draft discarded." })),
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

import type { HeaderActionsModel } from "@/components/trade/model";
import { type TradeActionContext, TradeMenu } from "@/components/trade/trade-actions";
import { DuplicateDialog, SkipTradeDialog } from "@/components/trade/trade-dialogs";

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

beforeEach(() => {
  m.dialogs = {};
  m.returnFocusTo.mockClear();
  m.keepFocusOnTrade.mockClear();
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
  it("lists what duplicating copies, including screenshots added after the plan ended", () => {
    const notes = ["Economic news is reset.", "Screenshots recorded before entry are copied.", "1 screenshot added after the plan was skipped is copied too."];
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
