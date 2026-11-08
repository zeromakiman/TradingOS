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

export type TradeTarget = (typeof TRADE_TARGETS)[keyof typeof TRADE_TARGETS];

const TARGET_IDS: ReadonlySet<string> = new Set(Object.values(TRADE_TARGETS));

/**
 * A trade-timeline item a link names: a journal entry `journal:<uuid>` or a (V1) event `event:<uuid>`, the DOM ids
 * the timeline gives its items (`TimelineItem.id`, src/domain/timeline.ts). The source chips of a weekly, recent-trades
 * or monthly AI review open them from the Review pages as `/trades/<id>#journal:<uuid>` (docs/V2_ARCHITECTURE.md §11.1).
 */
export type TimelineItemTarget = `journal:${string}` | `event:${string}`;

const TIMELINE_ITEM = /^(?:journal|event):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTimelineItem(target: string): target is TimelineItemTarget {
  return TIMELINE_ITEM.test(target);
}

/**
 * The trade-page target a location hash names (`#close-trade` → `close-trade`, `#journal:<uuid>` → that timeline
 * item), or null for any other hash.
 */
export function tradeTargetOf(hash: string): TradeTarget | TimelineItemTarget | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (TARGET_IDS.has(id)) return id as TradeTarget;
  return isTimelineItem(id) ? id : null;
}

const FOCUSABLE = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";
const CLOSED_PANEL = "details:not([open])";

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * The first control of `target` that no collapsed `<details>` hides. When every control is collapsed (the "Edit tags"
 * disclosure of an open trade), the panels holding the first one are opened, so focus reaches a control people can see.
 */
function firstControl(target: HTMLElement, focusSelector: string): HTMLElement | null {
  const controls = Array.from(target.querySelectorAll<HTMLElement>(focusSelector));
  const shown = controls.find(control => control.closest(CLOSED_PANEL) === null);
  if (shown) return shown;
  const [first] = controls;
  if (!first) return null;
  for (let panel = first.closest<HTMLDetailsElement>(CLOSED_PANEL); panel && target.contains(panel); panel = first.closest<HTMLDetailsElement>(CLOSED_PANEL)) {
    panel.open = true;
  }
  return first;
}

/** A target this close to the top of its section scrolls with the section, so the section's heading stays in view. */
const SECTION_HEAD_ROOM = 160;

/** What to scroll into view: the enclosing section when the target opens it (the close form under "Close trade"). */
function scrollAnchor(target: HTMLElement): HTMLElement {
  const section = target.parentElement?.closest<HTMLElement>("section[id]");
  if (!section) return target;
  return target.getBoundingClientRect().top - section.getBoundingClientRect().top <= SECTION_HEAD_ROOM ? section : target;
}

/**
 * Scrolls to `#id` (with its section's heading when it opens the section) and focuses its first control (or the first
 * element matching `focusSelector`), opening a collapsed panel to reach it; false when the target is not on the page.
 */
export function reveal(id: string, focusSelector: string = FOCUSABLE): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  const control = firstControl(target, focusSelector);
  scrollAnchor(target).scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  (control ?? target).focus({ preventScroll: true });
  return true;
}

/**
 * Brings a trade-page target into view the way the page's own actions do: `#journal` focuses the composer, `#technical-
 * details` opens the disclosure, a timeline item scrolls into view and takes focus itself, every other target scrolls
 * into view with its first control focused. A trade with a position attaches screenshots in the journal composer, so
 * `#add-screenshots` falls back to it when the Evidence stager is not on the page. False when nothing could be shown
 * (the target belongs to another state of the trade, or the timeline does not show that record).
 */
export function revealTradeTarget(target: TradeTarget | TimelineItemTarget): boolean {
  switch (target) {
    case TRADE_TARGETS.journal:
      return focusComposer();
    case TRADE_TARGETS.technical:
      return revealTechnicalDetails();
    case TRADE_TARGETS.addScreenshots:
      return reveal(target) || focusComposer();
    default:
      return isTimelineItem(target) ? revealTimelineItem(target) : reveal(target);
  }
}

/**
 * Scrolls a timeline item into view (its `scroll-mt` keeps it clear of the top bar) and focuses the item itself, not a
 * control inside it, so a screen reader reads the record the link named. On a client navigation Next.js looks for the
 * fragment while the loading skeleton shows, so the browser never scrolls to it on its own (`TradeHashFocus` calls this
 * once the trade is on the page).
 */
function revealTimelineItem(id: TimelineItemTarget): boolean {
  const item = document.getElementById(id);
  if (!item) return false;
  item.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  if (!item.hasAttribute("tabindex")) item.setAttribute("tabindex", "-1");
  item.focus({ preventScroll: true });
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
