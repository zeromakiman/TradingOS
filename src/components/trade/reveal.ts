import { JOURNAL_COMPOSER_SELECTOR } from "@/components/shell/shortcuts";

/**
 * In-page targets of the trade workspace and the browser-side helpers that bring them into view (event handlers
 * only; never called while rendering). Scrolling respects `prefers-reduced-motion`; focus lands on the first control
 * so keyboard and screen-reader users arrive where the action continues.
 */

export const TRADE_TARGETS = Object.freeze({
  plan: "plan",
  recordEntry: "record-entry",
  entryDetails: "entry-details",
  closeTrade: "close-trade",
  review: "review",
  journal: "journal",
  evidence: "evidence",
  addScreenshots: "add-screenshots",
  technical: "technical-details",
});

const FOCUSABLE = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Scrolls to `#id` and focuses its first control (or the element matching `focusSelector`); false when absent. */
export function reveal(id: string, focusSelector: string = FOCUSABLE): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  const control = target.querySelector<HTMLElement>(focusSelector);
  (control ?? target).focus({ preventScroll: true });
  return true;
}

/**
 * Focuses the journal composer (the `J` shortcut's target). With `kind`, its entry-type chip is chosen first, so
 * "Add a lesson" opens the composer on Lesson. The composer keeps working with focus only if its chips ever change.
 */
export function focusComposer(kind?: string): boolean {
  const field = document.querySelector<HTMLTextAreaElement>(JOURNAL_COMPOSER_SELECTOR);
  if (!field) return false;
  if (kind) {
    const chip = field.closest("form")?.querySelector<HTMLInputElement>(`input[name="kind"][value="${kind}"]`);
    if (chip && !chip.checked) chip.click();
  }
  field.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  field.focus({ preventScroll: true });
  return true;
}

/** Id of the trade title (`h1`, programmatically focusable). */
export const TRADE_TITLE_ID = "trade-title";

const FOCUS_WATCH_MS = 2500;
const FOCUS_POLL_MS = 150;

function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected || active.classList.contains("skip-link");
}

/**
 * After an action changes the trade's state, the control that had focus usually leaves with the old state (the form
 * that recorded the entry, the dialog's trigger). While the refreshed page arrives, a lost focus moves to the trade
 * title, so keyboard and screen-reader users continue from the new state and its next action. Focus that is still
 * somewhere meaningful is left alone.
 */
export function keepFocusOnTrade(): void {
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (focusLost()) {
      document.getElementById(TRADE_TITLE_ID)?.focus({ preventScroll: true });
      window.clearInterval(timer);
    } else if (Date.now() - started > FOCUS_WATCH_MS) {
      window.clearInterval(timer);
    }
  }, FOCUS_POLL_MS);
}

const RETURN_POLL_MS = 50;
const OPEN_DIALOG = '[role="alertdialog"], [role="dialog"]';

/**
 * Gives focus back to `element` (the control that opened a dialog) once the dialog has closed. Radix returns focus
 * only to a dialog's own trigger, so a dialog opened from a menu item, which has none, would leave focus on the page
 * body. While the dialog is still on the page it keeps focus trapped, so this waits for it to leave; if focus has
 * meanwhile landed somewhere meaningful, it is left there.
 */
export function returnFocusTo(element: HTMLElement | null): void {
  if (!element) return;
  const started = Date.now();
  const timer = window.setInterval(() => {
    const expired = Date.now() - started > FOCUS_WATCH_MS;
    if (expired || !element.isConnected) {
      window.clearInterval(timer);
      return;
    }
    if (document.querySelector(OPEN_DIALOG)) return;
    if (focusLost()) element.focus({ preventScroll: true });
    window.clearInterval(timer);
  }, RETURN_POLL_MS);
}

/** Opens and shows the Technical details disclosure at the bottom of the page. */
export function revealTechnicalDetails(): boolean {
  const target = document.getElementById(TRADE_TARGETS.technical);
  const details = target?.querySelector("details");
  if (!target || !details) return false;
  details.open = true;
  target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  return true;
}
