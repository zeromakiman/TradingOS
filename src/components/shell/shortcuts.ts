/** Global keyboard shortcuts (§13.4). Pure so the rules can be tested without a DOM. */

export type ShortcutAction = "palette" | "plan" | "live" | "journal" | "help";

export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: unknown;
  defaultPrevented?: boolean;
  isComposing?: boolean;
};

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/** True when keystrokes go into a text field, a select or editable content. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown };
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
  return !NON_TEXT_INPUT_TYPES.has(type);
}

const SINGLE_KEYS: Record<string, ShortcutAction> = {
  "/": "palette",
  "?": "help",
  p: "plan",
  l: "live",
  j: "journal",
};

export type ShortcutContext = {
  /** A dialog or menu is open. */
  dialogOpen: boolean;
  /**
   * Single-key shortcuts are on (the default). The person can turn them off (WCAG 2.2 SC 2.1.4),
   * for example when speech input or stray key presses would trigger them; Ctrl/⌘+K stays.
   */
  singleKeys?: boolean;
};

/**
 * Maps a key press to a shortcut. Ctrl/⌘+K always opens the palette; single-key shortcuts
 * (/, ?, P, L, J) apply only while they are turned on, and never while typing or while a dialog
 * is open.
 */
export function shortcutFor(event: ShortcutKeyEvent, { dialogOpen, singleKeys = true }: ShortcutContext): ShortcutAction | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") return "palette";
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (!singleKeys || dialogOpen || isTypingTarget(event.target)) return null;
  return SINGLE_KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key] ?? null;
}

/** Element a trade page marks as its journal composer; `J` focuses it. */
export const JOURNAL_COMPOSER_SELECTOR = "[data-journal-composer]";

/** Ids of the header primary actions that `P` and `L` activate. */
export const PLAN_ACTION_ID = "shell-action-plan";
export const LIVE_ACTION_ID = "shell-action-live";
