import { readFileSync } from "node:fs";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/journal", () => ({ addJournalEntry: vi.fn() }));
/** Props of every page-level capture target the composer mounts (effects don't run on the server). */
const pasteTargets = vi.hoisted(() => [] as Array<{ disabled?: boolean; allowInTextFields?: unknown }>);
vi.mock("@/components/evidence/paste-target", () => ({
  EvidencePasteTarget: (targetProps: { disabled?: boolean; allowInTextFields?: unknown }) => {
    pasteTargets.push(targetProps);
    return null;
  },
}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
}));

import { ENTRY_UNREACHABLE_COPY, JOURNAL_COMPOSER_ID, JournalComposer, type JournalComposerProps } from "@/components/trade/journal/composer";
import {
  defaultLabelForLifecycle, EMPTY_JOURNAL_DRAFT, isPartialPercent, isPositiveDecimal, isTickAligned, JOURNAL_COPY, JOURNAL_KIND_LABELS, JOURNAL_KINDS, JOURNAL_PLACEHOLDERS,
  type JournalDraft, journalEntryForm, journalEntryTitle, journalKindsFor, journalServerErrors, LIVE_ONLY_KINDS, liveKindsNote, MAX_JOURNAL_BODY, tickCopy,
  timingHintForLifecycle, trimJournalBody, validateJournalDraft,
} from "@/components/trade/journal/composer-model";
import { JOURNAL_COMPOSER_SELECTOR } from "@/components/shell/shortcuts";
import { LIFECYCLES } from "@/domain/ledger";

const TRADE = "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const KEY = "2b1c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
const draft = (changes: Partial<JournalDraft>): JournalDraft => ({ ...EMPTY_JOURNAL_DRAFT, ...changes });
const TICK = "0.00001";

describe("timing hint", () => {
  it("maps every lifecycle to the band a new note will most likely land in", () => {
    // A plan that ended without an entry stores what is written afterwards post-trade (§5.2): After close, never Before entry.
    expect(LIFECYCLES.map(lifecycle => [lifecycle, timingHintForLifecycle(lifecycle)])).toEqual([
      ["DRAFT", "BEFORE_ENTRY"], ["LOCKED", "BEFORE_ENTRY"], ["LIVE", "WHILE_LIVE"], ["CLOSED", "AFTER_CLOSE"], ["REVIEWED", "AFTER_CLOSE"],
      ["SKIPPED", "AFTER_CLOSE"], ["CANCELLED", "AFTER_CLOSE"], ["DISCARDED", "AFTER_CLOSE"],
    ]);
  });

  it("labels attached screenshots by that band, and Other on a plan that ended without an entry", () => {
    expect(LIFECYCLES.map(lifecycle => [lifecycle, defaultLabelForLifecycle(lifecycle)])).toEqual([
      ["DRAFT", "PRE_ENTRY"], ["LOCKED", "PRE_ENTRY"], ["LIVE", "MANAGEMENT"], ["CLOSED", "EXIT"], ["REVIEWED", "EXIT"],
      ["SKIPPED", "OTHER"], ["CANCELLED", "OTHER"], ["DISCARDED", "OTHER"],
    ]);
  });
});

describe("journal kinds", () => {
  it("are the database kinds, shown as Note · Decision · Stop · Target · Partial · Lesson", () => {
    expect(JOURNAL_KINDS).toEqual(["NOTE", "DECISION", "STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "LESSON"]);
    expect(JOURNAL_KINDS.map(kind => JOURNAL_KIND_LABELS[kind]).join(" · ")).toBe("Note · Decision · Stop · Target · Partial · Lesson");
    expect(JOURNAL_PLACEHOLDERS.NOTE).toBe("Add to trade journal…");
  });

  it("offers stop moves, target changes and partial closes only while the trade is live", () => {
    // add_journal_entry refuses them in any other phase (ENTRY_NOT_LIVE): no position existed before the entry or after the close.
    expect(LIVE_ONLY_KINDS).toEqual(["STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE"]);
    expect(journalKindsFor("WHILE_LIVE")).toEqual(JOURNAL_KINDS);
    expect(journalKindsFor("BEFORE_ENTRY")).toEqual(["NOTE", "DECISION", "LESSON"]);
    expect(journalKindsFor("AFTER_CLOSE")).toEqual(["NOTE", "DECISION", "LESSON"]);
    expect(LIFECYCLES.filter(lifecycle => journalKindsFor(timingHintForLifecycle(lifecycle)).includes("STOP_CHANGE"))).toEqual(["LIVE"]);
  });

  it("says why on a draft (its stop and target change with Edit draft), on a locked plan and on a closed trade, and nowhere else", () => {
    expect(liveKindsNote("DRAFT", true)).toEqual({ text: "The stop and target are part of the plan: change them with Edit draft.", editDraft: true });
    expect(JOURNAL_COPY.draftKinds.split("Edit draft")).toHaveLength(2);
    // A draft of an archived account can't be edited: no pointer to an edit it can't take.
    expect(liveKindsNote("DRAFT", false)).toBeNull();
    expect(liveKindsNote("LOCKED", false)).toEqual({ text: "Stop moves, target changes and partial closes can be journaled once the entry is recorded.", editDraft: false });
    // Closed (also a live-first trade recorded after the fact, or an import closed between syncs): add_journal_entry
    // refuses stop, target and partial entries after the close (ENTRY_NOT_LIVE), so the composer says how to keep what
    // happened instead, whatever the account's state.
    const closed = {
      text: "This trade is closed. To keep a stop move, target change or partial close you made, write it as a Decision or a Note: it is saved as recorded after close and doesn't change the result.",
      editDraft: false,
    };
    for (const lifecycle of ["CLOSED", "REVIEWED"] as const) for (const editable of [true, false]) expect(liveKindsNote(lifecycle, editable), lifecycle).toEqual(closed);
    // Every kind the note names is one the composer offers after a close.
    expect(journalKindsFor(timingHintForLifecycle("CLOSED")).map(kind => JOURNAL_KIND_LABELS[kind])).toEqual(expect.arrayContaining(["Decision", "Note"]));
    // Live: nothing to explain. A plan that ended without an entry never had a position to manage.
    for (const lifecycle of ["LIVE", "SKIPPED", "CANCELLED", "DISCARDED"] as const) expect(liveKindsNote(lifecycle, true), lifecycle).toBeNull();
    expect(JOURNAL_COPY.notLive).toBe("Stop, target and partial-close entries can only be recorded while the trade is live. To keep what happened, write it as a Decision or a Note.");
  });
});

describe("structured field validation (mirrors add_journal_entry)", () => {
  it("requires text for notes, decisions and lessons", () => {
    expect(validateJournalDraft(draft({ kind: "NOTE", body: "  \n" }))).toEqual({ ok: false, fieldErrors: { body: JOURNAL_COPY.empty } });
    expect(validateJournalDraft(draft({ kind: "DECISION" }))).toEqual({ ok: false, fieldErrors: { body: JOURNAL_COPY.decision } });
    expect(validateJournalDraft(draft({ kind: "LESSON" }), { screenshotCount: 2 })).toEqual({ ok: false, fieldErrors: { body: JOURNAL_COPY.lesson } });
    expect(validateJournalDraft(draft({ kind: "DECISION", body: "  Hold to target \t" }))).toEqual({ ok: true, entry: { kind: "DECISION", body: "Hold to target", details: {} } });
  });

  it("saves only the screenshots when a note is empty but images are attached", () => {
    expect(validateJournalDraft(draft({ kind: "NOTE" }), { screenshotCount: 1 })).toEqual({ ok: true, entry: null });
  });

  it("ignores structured fields of other kinds (notes never carry details)", () => {
    expect(validateJournalDraft(draft({ kind: "NOTE", body: "Price ran", price: "1.2", amount: "50" }))).toEqual({ ok: true, entry: { kind: "NOTE", body: "Price ran", details: {} } });
  });

  it("limits text to 5,000 characters, counted like the database", () => {
    expect(validateJournalDraft(draft({ body: "x".repeat(MAX_JOURNAL_BODY) })).ok).toBe(true);
    expect(validateJournalDraft(draft({ body: "x".repeat(MAX_JOURNAL_BODY + 1) }))).toEqual({ ok: false, fieldErrors: { body: JOURNAL_COPY.bodyTooLong } });
    // Astral characters count once, as in PostgreSQL length().
    expect(validateJournalDraft(draft({ body: "📈".repeat(MAX_JOURNAL_BODY) })).ok).toBe(true);
    expect(trimJournalBody("  note \r\n")).toBe("  note");
  });

  it("requires a positive stop or target price with up to 8 decimals, on the instrument's tick", () => {
    expect(validateJournalDraft(draft({ kind: "STOP_CHANGE" }))).toEqual({ ok: false, fieldErrors: { price: JOURNAL_COPY.stopRequired } });
    expect(validateJournalDraft(draft({ kind: "TARGET_CHANGE" }))).toEqual({ ok: false, fieldErrors: { price: JOURNAL_COPY.targetRequired } });
    for (const price of ["0", "0.0", "-1", "1e3", "1.123456789", ".5", "1,08500", "1234567890123"]) {
      expect(validateJournalDraft(draft({ kind: "STOP_CHANGE", price }))).toEqual({ ok: false, fieldErrors: { price: JOURNAL_COPY.price } });
    }
    expect(validateJournalDraft(draft({ kind: "STOP_CHANGE", price: "1.085005" }), { tickSize: TICK })).toEqual({ ok: false, fieldErrors: { price: tickCopy(TICK) } });
    expect(tickCopy("0.00001000")).toBe("Price must be a multiple of the 0.00001 tick size.");
    expect(validateJournalDraft(draft({ kind: "STOP_CHANGE", price: "1.08500" }), { tickSize: TICK })).toEqual({ ok: true, entry: { kind: "STOP_CHANGE", body: null, details: { price: "1.08500" } } });
    expect(validateJournalDraft(draft({ kind: "TARGET_CHANGE", price: " 1.1 ", body: "Next liquidity pool" }), { tickSize: TICK })).toEqual({
      ok: true, entry: { kind: "TARGET_CHANGE", body: "Next liquidity pool", details: { price: "1.1" } },
    });
    // Without a known contract the server decides the tick.
    expect(validateJournalDraft(draft({ kind: "STOP_CHANGE", price: "1.085005" })).ok).toBe(true);
  });

  it("accepts a partial close with text or any of price, size or percent (0 < percent < 100)", () => {
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE" }))).toEqual({ ok: false, fieldErrors: { body: JOURNAL_COPY.partialEmpty } });
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", body: "Paid myself at the 1R level" }))).toEqual({ ok: true, entry: { kind: "PARTIAL_CLOSE", body: "Paid myself at the 1R level", details: {} } });
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", price: "1.10200", amount: "50" }), { tickSize: TICK })).toEqual({
      ok: true, entry: { kind: "PARTIAL_CLOSE", body: null, details: { price: "1.10200", percent: "50" } },
    });
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", amountKind: "quantity", amount: "0.25" }))).toEqual({ ok: true, entry: { kind: "PARTIAL_CLOSE", body: null, details: { quantity: "0.25" } } });
    for (const amount of ["0", "00.000", "100", "150", "-5", "12.123456789"]) {
      expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", amount }))).toEqual({ ok: false, fieldErrors: { amount: JOURNAL_COPY.percent } });
    }
    for (const amount of ["0.5", "99.99999999", "00.5"]) expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", amount })).ok).toBe(true);
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", amountKind: "quantity", amount: "0" }))).toEqual({ ok: false, fieldErrors: { amount: JOURNAL_COPY.quantity } });
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", price: "abc", amount: "50" }))).toEqual({ ok: false, fieldErrors: { price: JOURNAL_COPY.price } });
    // The database does not check a partial's price against the tick.
    expect(validateJournalDraft(draft({ kind: "PARTIAL_CLOSE", price: "1.102005" }), { tickSize: TICK }).ok).toBe(true);
  });

  it("checks decimals exactly, without floating point", () => {
    expect(isPositiveDecimal("0.00000001")).toBe(true);
    expect(isPositiveDecimal("999999999999.99999999")).toBe(true);
    expect(isPositiveDecimal("0.000000001")).toBe(false);
    expect(isPartialPercent("99.99999999")).toBe(true);
    // Floating point would call both of these aligned.
    expect(isTickAligned("1.10000000000000000000", "0.00001")).toBe(true);
    expect(isTickAligned("1.10000000000000000003", "0.00001")).toBe(false);
    expect(isTickAligned("1.08501", "0.00002")).toBe(false);
    expect(isTickAligned("4510.25", "0.25")).toBe(true);
    expect(isTickAligned("4510.3", "0.25")).toBe(false);
    expect(isTickAligned("1.2", "not a tick")).toBe(true);
  });
});

describe("addJournalEntry contract (spec §12.2)", () => {
  it("sends tradeId, kind, body?, details? as a JSON object of strings, and the request key", () => {
    const form = journalEntryForm(TRADE, KEY, { kind: "PARTIAL_CLOSE", body: "Half off", details: { price: "1.10200", percent: "50" } });
    expect(Object.fromEntries(form.entries())).toEqual({ tradeId: TRADE, kind: "PARTIAL_CLOSE", requestKey: KEY, body: "Half off", details: '{"price":"1.10200","percent":"50"}' });
    const bare = journalEntryForm(TRADE, KEY, { kind: "STOP_CHANGE", body: null, details: { price: "1.085" } });
    expect(bare.has("body")).toBe(false);
    const note = journalEntryForm(TRADE, KEY, { kind: "NOTE", body: "Patience", details: {} });
    expect(note.has("details")).toBe(false);
  });

  it("maps the action's field errors onto the composer and keeps other messages general", () => {
    expect(journalServerErrors({ price: "Price must be a positive number with up to 8 decimals.", percent: "Percent must be more than 0 and less than 100." })).toEqual({
      fieldErrors: { price: "Price must be a positive number with up to 8 decimals.", amount: "Percent must be more than 0 and less than 100." }, general: null,
    });
    expect(journalServerErrors({ requestKey: "Reload the page and submit the entry again.", body: "Write the note (up to 5,000 characters)." })).toEqual({
      fieldErrors: { body: "Write the note (up to 5,000 characters)." }, general: "Reload the page and submit the entry again.",
    });
    expect(journalServerErrors(undefined)).toEqual({ fieldErrors: {}, general: null });
  });

  it("titles a pending entry exactly as the timeline will", () => {
    expect(journalEntryTitle({ kind: "STOP_CHANGE", body: null, details: { price: "1.085" } }, { tickSize: TICK })).toBe("Stop moved to 1.08500");
    expect(journalEntryTitle({ kind: "TARGET_CHANGE", body: null, details: { price: "1.1" } }, { tickSize: TICK })).toBe("Target moved to 1.10000");
    expect(journalEntryTitle({ kind: "PARTIAL_CLOSE", body: null, details: { percent: "50", price: "1.102" } }, { tickSize: TICK })).toBe("Partial close · 50% at 1.10200");
    expect(journalEntryTitle({ kind: "LESSON", body: "Wait for the close", details: {} })).toBe("Lesson");
  });

  it("promises a safe retry when the server could not be reached", () => {
    expect(ENTRY_UNREACHABLE_COPY).toBe("The entry couldn't be saved. Check your connection and try again; it won't be added twice.");
  });
});

const visibleText = (markup: string) => [markup.replace(/<[^>]+>/g, " "), ...[...markup.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1])].join(" ");
const element = <P extends object>(component: ComponentType<P>, props: P) => createElement(component, props);
const props = (changes: Partial<JournalComposerProps> = {}): JournalComposerProps => ({ tradeId: TRADE, timingHint: "WHILE_LIVE", requestKey: KEY, ...changes });

describe("<JournalComposer>", () => {
  it("starts as one line with the exact prompt, the kind chips and attach controls", () => {
    const markup = renderToStaticMarkup(element(JournalComposer, props()));
    expect(markup).toContain('aria-label="Add to trade journal"');
    expect(markup).toMatch(/<textarea[^>]*rows="1"/);
    expect(markup).toContain('placeholder="Add to trade journal…"');
    const chips = [...markup.matchAll(/<label class="chip-toggle"><input[^>]*value="([A-Z_]+)"[^>]*\/>([^<]+)<\/label>/g)].map(match => [match[1], match[2]]);
    expect(chips).toEqual([["NOTE", "Note"], ["DECISION", "Decision"], ["STOP_CHANGE", "Stop"], ["TARGET_CHANGE", "Target"], ["PARTIAL_CLOSE", "Partial"], ["LESSON", "Lesson"]]);
    const checked = [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(match => match[0]).filter(input => input.includes('checked=""'));
    expect(checked).toEqual([expect.stringContaining('value="NOTE"')]);
    expect(markup).toContain("Attach screenshots");
    expect(markup).toMatch(/accept="image\/\*"[^>]*capture="environment"/);
    expect(markup).toContain(">Add to journal<");
    expect(markup).toContain("Ctrl");
    expect(markup).toMatch(/role="status"[^>]*aria-live="polite"/);
  });

  it("is the target of the J shortcut, with a stable id", () => {
    const markup = renderToStaticMarkup(element(JournalComposer, props()));
    expect(JOURNAL_COMPOSER_SELECTOR).toBe("[data-journal-composer]");
    expect(markup).toMatch(new RegExp(`<textarea[^>]*data-journal-composer=""[^>]*id="${JOURNAL_COMPOSER_ID}"|<textarea[^>]*id="${JOURNAL_COMPOSER_ID}"[^>]*data-journal-composer=""`));
    expect(renderToStaticMarkup(element(JournalComposer, props({ id: "live-composer-2" })))).toContain('id="live-composer-2"');
  });

  it("docks above the mobile tab bar in the sticky variant", () => {
    const sticky = renderToStaticMarkup(element(JournalComposer, props({ sticky: true })));
    expect(sticky).toContain("max-md:sticky");
    expect(sticky).toContain("max-md:bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))]");
    expect(renderToStaticMarkup(element(JournalComposer, props()))).not.toContain("max-md:sticky");
  });

  it("scrolls under the sticky top bar while docked, never over the account selector and search", () => {
    // Both are sticky in the same stacking context, and the composer comes later in the page: on equal z-index it
    // would paint over the top bar while it scrolls past it.
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    const topbar = Number(/\n {2}\.app-topbar \{[^}]*?z-index: (\d+);/.exec(css)?.[1]);
    const tabbar = Number(/\n {2}\.mobile-tabbar \{[^}]*?z-index: (\d+);/.exec(css)?.[1]);
    const overlay = Number(/\n {2}\.overlay \{[^}]*?z-index: (\d+);/.exec(css)?.[1]);
    const docked = Number(/max-md:z-(\d+)/.exec(renderToStaticMarkup(element(JournalComposer, props({ sticky: true }))))?.[1]);
    expect(docked).toBeGreaterThan(0);
    expect(topbar).toBeGreaterThan(docked);
    // Shell chrome stays under dialogs and sheets.
    expect(topbar).toBeLessThan(overlay);
    expect(tabbar).toBeLessThan(overlay);
  });

  it("offers Note · Decision · Lesson before the entry and after the close, with the page's reason under the chips", () => {
    const chipsOf = (markup: string) => [...markup.matchAll(/<label class="chip-toggle"><input[^>]*value="([A-Z_]+)"[^>]*\/>([^<]+)<\/label>/g)].map(match => match[2]);
    for (const timingHint of ["BEFORE_ENTRY", "AFTER_CLOSE"] as const) {
      const markup = renderToStaticMarkup(element(JournalComposer, props({ timingHint })));
      expect(chipsOf(markup), timingHint).toEqual(["Note", "Decision", "Lesson"]);
      expect(markup).not.toContain("New stop price");
      expect(markup).not.toContain("aria-describedby=\"journal-composer-kinds-note\"");
    }
    expect(chipsOf(renderToStaticMarkup(element(JournalComposer, props())))).toEqual(["Note", "Decision", "Stop", "Target", "Partial", "Lesson"]);
    const noted = renderToStaticMarkup(element(JournalComposer, props({ timingHint: "BEFORE_ENTRY", kindsNote: JOURNAL_COPY.lockedKinds })));
    expect(noted).toMatch(/<fieldset[^>]*aria-describedby="journal-composer-kinds-note"/);
    expect(noted).toContain(`<p id="journal-composer-kinds-note" class="t-caption -mt-1">${JOURNAL_COPY.lockedKinds}</p>`);
  });

  it("captures pastes and drops on the whole trade page by default", () => {
    pasteTargets.length = 0;
    renderToStaticMarkup(element(JournalComposer, props()));
    expect(pasteTargets).toHaveLength(1);
    expect(pasteTargets[0].disabled).toBeFalsy();
    expect(pasteTargets[0].allowInTextFields).toBeTypeOf("function");
  });

  it("with capture limited to the composer, still keeps files dropped beside it from replacing the page", () => {
    pasteTargets.length = 0;
    renderToStaticMarkup(element(JournalComposer, props({ capture: "composer", id: "live-composer-2" })));
    // A disabled target captures nothing; with no enabled one on the page it refuses stray drops (see pageCaptureRole).
    expect(pasteTargets).toEqual([expect.objectContaining({ disabled: true })]);
    expect(pasteTargets[0].allowInTextFields).toBeUndefined();
  });

  it("keeps the attach controls enabled while nothing is being saved", () => {
    const live = renderToStaticMarkup(element(JournalComposer, props()));
    expect(live).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Attach screenshots/);
  });

  it("never shows raw kinds or codes", () => {
    const text = visibleText(renderToStaticMarkup(element(JournalComposer, props({ timingHint: "AFTER_CLOSE" }))));
    expect(text).not.toMatch(/\b(NOTE|DECISION|STOP_CHANGE|TARGET_CHANGE|PARTIAL_CLOSE|LESSON|AFTER_CLOSE|EXIT)\b/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
