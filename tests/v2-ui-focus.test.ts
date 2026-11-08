import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FilterChips navigates with the app router.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
}));

import { ConfirmDialog } from "@/components/ui/dialog";
import { chipFocusAfterRemoval, FilterChips } from "@/components/ui/filter-chips";
// The Accounts and Today screens restore focus with the waits of accounts/focus, built on the design system's primitives.
import * as accountsFocus from "@/components/accounts/focus";
import { restoreFocusAfterDialog, restoreFocusWhenGone } from "@/components/accounts/focus";
import { FOCUS_WAIT_FRAMES, focusElement, focusLost, restoreFocusWhenLost } from "@/components/ui/focus";

// Focus never drops to the page body (V2 §13.5): when a dialog's trigger or a filter chip goes away after doing its job,
// focus moves to a stable element of the same section. The helpers run in the browser; here a minimal document and
// animation-frame queue stand in for it.

class FakeElement {
  isConnected = true;
  tabIndex: number;
  readonly attributes = new Map<string, string>();
  constructor(readonly name: string, focusable = false) {
    this.tabIndex = focusable ? 0 : -1;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "tabindex") this.tabIndex = Number(value);
  }
  focus() {
    if (this.isConnected && (this.tabIndex >= 0 || this.hasAttribute("tabindex"))) page.activeElement = this;
  }
}

const page = { activeElement: null as FakeElement | null, body: new FakeElement("body"), dialogOpen: false };
let frames: (() => void)[] = [];
const step = (count = 1) => {
  for (let index = 0; index < count; index++) {
    const due = frames;
    frames = [];
    for (const frame of due) frame();
  }
};

beforeEach(() => {
  page.activeElement = page.body;
  page.dialogOpen = false;
  frames = [];
  vi.stubGlobal("document", {
    get activeElement() {
      return page.activeElement;
    },
    body: page.body,
    querySelector: () => (page.dialogOpen ? {} : null),
  });
  vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => frames.push(callback) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const element = (name: string, focusable = true) => new FakeElement(name, focusable) as unknown as HTMLElement;

describe("focus helpers", () => {
  it("has one copy of each primitive: accounts/focus re-exports the design system's focusLost and focusElement", () => {
    expect(accountsFocus.focusLost).toBe(focusLost);
    expect(accountsFocus.focusElement).toBe(focusElement);
  });

  it("gives up waiting for a dialog after the shared frame budget, then restores focus once", () => {
    const target = element("section", false);
    page.dialogOpen = true;
    restoreFocusAfterDialog(() => target);
    step(FOCUS_WAIT_FRAMES);
    expect(page.activeElement).toBe(page.body);
    step(1);
    expect(page.activeElement).toBe(target);
    expect(frames).toHaveLength(0);
  });

  it("knows when focus is lost: on the body, nowhere, or on an element that left the page", () => {
    expect(focusLost()).toBe(true);
    const button = element("button");
    button.focus();
    expect(focusLost()).toBe(false);
    (button as unknown as FakeElement).isConnected = false;
    expect(focusLost()).toBe(true);
  });

  it("makes a heading programmatically focusable before focusing it, and skips detached elements", () => {
    const heading = element("h2", false);
    expect(focusElement(heading)).toBe(true);
    expect((heading as unknown as FakeElement).attributes.get("tabindex")).toBe("-1");
    const gone = element("button");
    (gone as unknown as FakeElement).isConnected = false;
    expect(focusElement(gone)).toBe(false);
    expect(focusElement(null)).toBe(false);
  });

  it("returns focus to the target when a confirmed action's update removes the dialog's trigger", () => {
    const trigger = element("button");
    const heading = element("h2", false);
    page.dialogOpen = true;
    restoreFocusWhenLost(() => heading);
    step(3);
    expect(page.activeElement).toBe(page.body);
    // The dialog closes and returns focus to its trigger: nothing to do while the trigger stays.
    page.dialogOpen = false;
    trigger.focus();
    step(3);
    expect(page.activeElement).toBe(trigger);
    // The page update removes the trigger; focus drops to the body and is moved to the target.
    (trigger as unknown as FakeElement).isConnected = false;
    page.activeElement = page.body;
    step(1);
    expect(page.activeElement).toBe(heading);
  });

  it("gives up after about two seconds, leaving focus the person moved alone", () => {
    const trigger = element("button");
    const elsewhere = element("input");
    restoreFocusWhenLost(() => element("h2", false));
    trigger.focus();
    step(FOCUS_WAIT_FRAMES + 2);
    elsewhere.focus();
    step(5);
    expect(page.activeElement).toBe(elsewhere);
    expect(frames).toHaveLength(0);
  });

  it("waits for an open dialog before restoring focus, and for a removed control to be gone", () => {
    const target = element("section", false);
    page.dialogOpen = true;
    restoreFocusAfterDialog(() => target);
    step(2);
    expect(page.activeElement).toBe(page.body);
    page.dialogOpen = false;
    step(1);
    expect(page.activeElement).toBe(target);

    const origin = element("li") as unknown as FakeElement;
    const next = element("h3", false);
    page.activeElement = origin;
    restoreFocusWhenGone(origin as unknown as Element, () => next);
    step(2);
    expect(page.activeElement).toBe(origin);
    origin.isConnected = false;
    step(1);
    expect(page.activeElement).toBe(next);
  });
});

describe("FilterChips", () => {
  const chips = [
    { key: "model", label: "Model: OTE", removeHref: "/journal?result=win" },
    { key: "result", label: "Result: Win", removeHref: "/journal?model=OTE" },
    { key: "session", label: "Session: Kill zone", removeHref: "/journal?model=OTE&result=win" },
  ];

  it("hands focus to the chip that takes the removed one's place, else the previous one, else the results", () => {
    expect(chipFocusAfterRemoval(0, 3)).toBe(0);
    expect(chipFocusAfterRemoval(1, 3)).toBe(1);
    expect(chipFocusAfterRemoval(2, 3)).toBe(1);
    expect(chipFocusAfterRemoval(0, 1)).toBeNull();
  });

  it("renders plain links that work without JavaScript, named for what they remove, and is not busy at rest", () => {
    const markup = renderToStaticMarkup(createElement(FilterChips, { chips, clearHref: "/journal", resultsId: "journal-results" }));
    expect(markup).toContain('<ul class="filter-chip-list" aria-label="Active filters">');
    expect(markup).toContain('<a class="chip-remove" aria-label="Remove filter: Model: OTE" href="/journal?result=win">');
    expect(markup).toContain('<a class="chip-remove" aria-label="Remove filter: Session: Kill zone" href="/journal?model=OTE&amp;result=win">');
    expect(markup).toMatch(/<a class="btn btn-link[^"]*" href="\/journal">Clear all<\/a>/);
    expect(markup).not.toContain("aria-busy");
    expect(renderToStaticMarkup(createElement(FilterChips, { chips: [] }))).toBe("");
    // A single chip has no "Clear all" (removing it clears everything).
    expect(renderToStaticMarkup(createElement(FilterChips, { chips: chips.slice(0, 1), clearHref: "/journal" }))).not.toContain("Clear all");
  });
});

describe("ConfirmDialog", () => {
  it("takes a return-focus target without changing its trigger", () => {
    const trigger = createElement("button", { type: "button" }, "Remove");
    const props = { trigger, title: "Remove this loss?", confirmLabel: "Remove", onConfirm: () => undefined };
    const plain = renderToStaticMarkup(createElement(ConfirmDialog, props));
    expect(renderToStaticMarkup(createElement(ConfirmDialog, { ...props, returnFocus: () => null }))).toBe(plain);
  });
});
