import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Unsaved work in a hidden panel of a live trade card (docs/V2_ARCHITECTURE.md §14.1). Today keeps a closed note or
 * screenshot panel mounted, so nothing typed or staged is lost; its button then says the work is still there.
 */

/** Staged screenshots (the evidence stager lists them under this name). */
const STAGED_SELECTOR = '[aria-label="Screenshots to save"] > li';
/** Fields a trader types into: the journal text, prices and amounts, screenshot captions. */
const TEXT_FIELD_SELECTOR = 'textarea, input[type="text"], input:not([type])';

/** Whether a panel holds unsaved work: text typed into one of its fields, or staged screenshots. */
export function holdsDraft(panel: ParentNode): boolean {
  if (panel.querySelector(STAGED_SELECTOR)) return true;
  return Array.from(panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELD_SELECTOR)).some(field => field.value.trim() !== "");
}

/**
 * While `watching` (the panel is kept but hidden), whether it still holds unsaved work. It is checked again whenever the
 * hidden panel changes, for example when a save that was running finishes (the draft is gone) or fails (the draft is
 * back with its message), so the button never claims a draft that was saved or hides one that returned.
 */
export function useKeptDraft(panel: RefObject<HTMLElement | null>, watching: boolean): boolean {
  const [draft, setDraft] = useState(false);
  // Before paint, so a panel that is hidden again never flashes the previous answer.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!watching || !element) return;
    const check = () => setDraft(holdsDraft(element));
    check();
    const observer = new MutationObserver(check);
    observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [panel, watching]);
  return watching && draft;
}
