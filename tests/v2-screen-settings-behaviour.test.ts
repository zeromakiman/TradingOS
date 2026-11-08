import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Settings behaviour that runs in the browser (docs/V2_ARCHITECTURE.md §14.11, §13.5): which section the list marks
// current, landing on `/settings#ai` (the AI fix route) after the page streams in, dialogs that start clean on every
// opening, and results that are announced and focused again when the same error repeats. The node test environment
// has no DOM, so the browser side is exercised through a fake environment and stubbed globals.

const m = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("@/app/actions/erasure", () => ({ deleteTradingOsAccount: m.action }));
vi.mock("@/app/ai-settings-actions", () => ({ saveAiActivation: m.action, saveAiBudget: m.action }));

import { activationNotice, enableRefusal } from "@/components/settings/ai-account-controls";
import { DeleteAccount, DeleteAccountForm } from "@/components/settings/delete-account";
import { Dialog } from "@/components/ui/dialog";
import { nextResultKey, type ResultKeyState } from "@/components/settings/form-submit";
import {
  CHOICE_HOLD_MS, currentSection, READING_LINE_PX, readingLine, type SectionEnvironment, type SectionLayout, sectionFromHash, trackSections,
} from "@/components/settings/section-tracker";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/settings-model";

const IDS: readonly SettingsSectionId[] = SETTINGS_SECTIONS.map(section => section.id);

/** Section tops for a page scrolled so that `first` starts at `top`, each section `height` px tall. */
function tops(first: number, heights: readonly number[]): SectionLayout["tops"] {
  let top = first;
  return IDS.map((id, index) => {
    const entry = { id, top };
    top += heights[index] ?? 600;
    return entry;
  });
}

function layout(overrides: Partial<SectionLayout> = {}): SectionLayout {
  return { tops: tops(240, HEIGHTS), viewportHeight: 1000, remaining: 4_000, ...overrides };
}

const HEIGHTS = [700, 1400, 900, 500, 640, 460, 420] as const;

/** 1440×1000 with `remaining` px still to scroll: at the end Security's top is at -400, Danger zone 240, Developer 700. */
function nearEnd(remaining: number): SectionLayout {
  return { tops: tops(-3_900 + remaining, HEIGHTS), viewportHeight: 1000, remaining };
}

function fakeBrowser(options: { hash?: string; layout?: SectionLayout } = {}) {
  let now = 1_000;
  let hash = options.hash ?? "";
  let current = options.layout ?? layout();
  let nextFrameId = 1;
  const frames = new Map<number, () => void>();
  const listeners = new Map<string, Set<() => void>>();
  const reveal = vi.fn<(id: SettingsSectionId) => void>();
  const reads = vi.fn();
  const env: SectionEnvironment = {
    hash: () => hash,
    layout: () => {
      reads();
      return current;
    },
    reveal,
    now: () => now,
    nextFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return () => frames.delete(id);
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    },
  };
  return {
    env,
    reveal,
    reads,
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    pendingFrames: () => frames.size,
    advance(ms: number) {
      now += ms;
    },
    scrollTo(next: SectionLayout) {
      current = next;
      for (const listener of listeners.get("scroll") ?? []) listener();
    },
    navigate(next: string) {
      hash = next;
      for (const listener of listeners.get("hashchange") ?? []) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings section list: which section is current", () => {
  it("is the first section at the top of the page, before any section reaches the reading line", () => {
    expect(currentSection(layout())).toBe("general");
  });

  it("is the last section whose top has passed the reading line", () => {
    expect(currentSection(layout({ tops: tops(-2_000, HEIGHTS) }))).toBe("connections");
    // A section a link parked at its scroll margin (128px on phones, 96px on desktop) is current.
    expect(currentSection(layout({ tops: tops(-572, HEIGHTS) }))).toBe("ai");
    expect(currentSection(layout({ tops: tops(-604, HEIGHTS) }))).toBe("ai");
    expect(READING_LINE_PX).toBeGreaterThan(128);
  });

  it("gives the short last sections their turn over the last screen of scrolling", () => {
    // The reading line stays put until the last screen, then follows the scroll down to the viewport bottom.
    expect(readingLine({ viewportHeight: 1000, remaining: 4_000 })).toBe(READING_LINE_PX);
    expect(readingLine({ viewportHeight: 1000, remaining: 300 })).toBe(700);
    expect(readingLine({ viewportHeight: 1000, remaining: 0 })).toBe(1000);
    expect(readingLine({ viewportHeight: 1000, remaining: Number.POSITIVE_INFINITY })).toBe(READING_LINE_PX);
    // Scrolling down through the end of the page at 1440×1000: Data, Security, then Danger zone, then Developer.
    expect([800, 600, 300, 200, 100, 0].map(remaining => currentSection(nearEnd(remaining)))).toEqual([
      "data", "security", "danger", "danger", "developer", "developer",
    ]);
    // A tall last section whose heading has scrolled out of view is still the current one.
    expect(currentSection({ tops: tops(-6_000, [700, 1400, 900, 500, 640, 460, 3000]), viewportHeight: 1000, remaining: 0 })).toBe("developer");
  });

  it("keeps the first section current on a page too short to scroll", () => {
    expect(currentSection({ tops: tops(240, [100, 100, 100, 100, 100, 100, 100]), viewportHeight: 1000, remaining: Number.POSITIVE_INFINITY })).toBe("general");
  });

  it("has no current section without sections", () => {
    expect(currentSection({ tops: [], viewportHeight: 1000, remaining: 0 })).toBeNull();
  });

  it("reads only section anchors from the URL", () => {
    expect(sectionFromHash(IDS, "#ai")).toBe("ai");
    expect(sectionFromHash(IDS, "#danger")).toBe("danger");
    for (const hash of ["", "#", "#AI", "#top", "ai"]) expect(sectionFromHash(IDS, hash)).toBeNull();
  });
});

describe("Settings section list: landing, choosing and scrolling", () => {
  it("lands on the URL's section once the streamed page is there and keeps it current while the scroll settles", () => {
    const browser = fakeBrowser({ hash: "#ai" });
    const onCurrent = vi.fn();
    trackSections(IDS, onCurrent, browser.env);
    expect(onCurrent).toHaveBeenLastCalledWith("ai");
    expect(browser.reveal).not.toHaveBeenCalled();

    browser.frame();
    expect(browser.reveal).toHaveBeenCalledExactlyOnceWith("ai");

    // The scroll the reveal causes does not move the mark, even where positions alone would say otherwise.
    browser.scrollTo(layout());
    browser.frame();
    expect(onCurrent).toHaveBeenLastCalledWith("ai");

    // The reader's own scroll afterwards decides again.
    browser.advance(CHOICE_HOLD_MS + 1);
    browser.scrollTo(layout({ tops: tops(-2_000, HEIGHTS) }));
    browser.frame();
    expect(onCurrent).toHaveBeenLastCalledWith("connections");
  });

  it("marks the section in view on arrival without a fragment, without scrolling", () => {
    const browser = fakeBrowser({ layout: layout({ tops: tops(-2_000, HEIGHTS) }) });
    const onCurrent = vi.fn();
    trackSections(IDS, onCurrent, browser.env);
    expect(onCurrent).not.toHaveBeenCalled();
    browser.frame();
    expect(onCurrent).toHaveBeenCalledExactlyOnceWith("connections");
    expect(browser.reveal).not.toHaveBeenCalled();
  });

  it("keeps a section chosen in the list current at the end of the page until the reader scrolls", () => {
    const end = nearEnd(0);
    const browser = fakeBrowser({ layout: end });
    const onCurrent = vi.fn();
    const tracker = trackSections(IDS, onCurrent, browser.env);
    browser.frame();
    expect(onCurrent).toHaveBeenLastCalledWith("developer");

    tracker.choose("danger");
    expect(onCurrent).toHaveBeenLastCalledWith("danger");
    browser.scrollTo(end);
    browser.frame();
    expect(onCurrent).toHaveBeenLastCalledWith("danger");

    browser.advance(CHOICE_HOLD_MS + 1);
    browser.scrollTo(end);
    browser.frame();
    expect(onCurrent).toHaveBeenLastCalledWith("developer");
  });

  it("follows in-page links to a section (Download my data → Data)", () => {
    const browser = fakeBrowser();
    const onCurrent = vi.fn();
    trackSections(IDS, onCurrent, browser.env);
    browser.frame();
    browser.navigate("#data");
    expect(onCurrent).toHaveBeenLastCalledWith("data");
    browser.frame();
    expect(browser.reveal).toHaveBeenLastCalledWith("data");

    browser.reveal.mockClear();
    browser.navigate("#technical-details");
    browser.frame();
    expect(browser.reveal).not.toHaveBeenCalled();
  });

  it("reads positions once per frame however many scroll events arrive", () => {
    const browser = fakeBrowser();
    trackSections(IDS, vi.fn(), browser.env);
    browser.frame();
    browser.reads.mockClear();
    for (let index = 0; index < 5; index += 1) browser.scrollTo(layout());
    expect(browser.pendingFrames()).toBe(1);
    browser.frame();
    expect(browser.reads).toHaveBeenCalledOnce();
  });

  it("stops listening and drops pending frames when the page goes", () => {
    const browser = fakeBrowser({ hash: "#ai" });
    const onCurrent = vi.fn();
    const tracker = trackSections(IDS, onCurrent, browser.env);
    expect(browser.listenerCount()).toBe(3);
    tracker.stop();
    expect(browser.listenerCount()).toBe(0);
    expect(browser.pendingFrames()).toBe(0);
    browser.frame();
    expect(browser.reveal).not.toHaveBeenCalled();
  });

  it("scrolls the AI section into view in the browser when the URL ends in #ai", () => {
    const scrollIntoView = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const listening: string[] = [];
    vi.stubGlobal("window", {
      location: { hash: "#ai" },
      innerHeight: 852,
      scrollY: 0,
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
      cancelAnimationFrame: vi.fn(),
      addEventListener: (type: string) => listening.push(type),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      documentElement: { scrollHeight: 6_000 },
      getElementById: (id: string) =>
        IDS.includes(id as SettingsSectionId) ? { getBoundingClientRect: () => ({ top: 240 }), scrollIntoView: id === "ai" ? scrollIntoView : vi.fn() } : null,
    });
    const onCurrent = vi.fn();
    const tracker = trackSections(IDS, onCurrent);
    expect(onCurrent).toHaveBeenLastCalledWith("ai");
    for (const frame of frames.splice(0)) frame(0);
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(listening).toEqual(["scroll", "resize", "hashchange"]);
    tracker.stop();
  });
});

describe("Settings forms: results", () => {
  it("gives every new result a new key, so the same error twice mounts a fresh alert", () => {
    const first = { status: "error", message: "Check the highlighted fields." };
    const again = { status: "error", message: "Check the highlighted fields." };
    const start: ResultKeyState<object> = { result: {}, key: 0 };
    const one = nextResultKey(start, first);
    expect(one.key).toBe(1);
    expect(nextResultKey(one, first)).toBe(one);
    expect(nextResultKey(one, again).key).toBe(2);
  });

  it("shows the enable dialog only the refusal of its current opening", () => {
    const refused = { error: "AI is unavailable in this deployment. Your account has not been enabled." };
    expect(enableRefusal(refused, refused)).toBeNull();
    expect(enableRefusal(refused, {})).toBe(refused);
    expect(enableRefusal({ ...refused }, refused)).toEqual(refused);
    expect(enableRefusal({ success: "AI enabled for this account. Requests still require available budget." }, {})).toBeNull();
  });

  it("shows beside the AI control the result of the control used last, never a refused enable", () => {
    const enabled = { success: "AI enabled for this account. Requests still require available budget." };
    const refused = { error: "Confirm the AI data-sharing disclosure before enabling." };
    const turnedOff = { success: "AI disabled for future requests. Existing evaluations and history are preserved." };
    const failed = { error: "AI settings were not saved. Check account access and try again." };
    expect(activationNotice(null, enabled, turnedOff)).toBeNull();
    expect(activationNotice("enable", enabled, turnedOff)).toBe(enabled);
    expect(activationNotice("enable", refused, turnedOff)).toBeNull();
    expect(activationNotice("turnOff", enabled, turnedOff)).toBe(turnedOff);
    expect(activationNotice("turnOff", enabled, failed)).toBe(failed);
  });

  it("mounts the deletion form only inside the open dialog, so no earlier attempt survives a reopening", () => {
    const closed = renderToStaticMarkup(createElement(DeleteAccount, { email: "qa.settings@example.test" }));
    expect(closed).toContain("Delete Trading OS account…");
    expect(closed).not.toContain('name="confirmation"');
    expect(closed).not.toContain('role="alert"');

    const form = renderToStaticMarkup(createElement(Dialog, { open: true }, createElement(DeleteAccountForm, { email: "qa.settings@example.test", onBusyChange: vi.fn() })));
    expect(form).toContain("Type DELETE to confirm");
    expect(form).toMatch(/<input[^>]*name="confirmation"[^>]*value=""|<input[^>]*value=""[^>]*name="confirmation"/);
    expect(form).toMatch(/<input[^>]*name="password"[^>]*value=""|<input[^>]*value=""[^>]*name="password"/);
    expect(form).not.toContain('role="alert"');
    expect(/<button[^>]*type="submit"[^>]*>/.exec(form)?.[0]).toMatch(/\bdisabled=""/);
  });
});
