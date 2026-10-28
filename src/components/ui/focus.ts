/**
 * Focus management shared by the design system (docs/V2_ARCHITECTURE.md §13.5: dialogs restore focus; focus never
 * drops to the page body). When the control that had focus goes away after doing its job (a confirmation succeeds and
 * the page update that follows replaces its trigger, a filter chip removes itself), focus moves to a stable element
 * instead. Focus that the person moved somewhere else in the meantime is left alone. Browser-only: call these from
 * event handlers and effects of client components. (Generalised from src/components/accounts/focus.ts.)
 */

/** Whether focus is lost: on the page body (where browsers leave it when the focused element is removed) or nowhere. */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** Focuses the element; a heading or section is made programmatically focusable first (`tabindex="-1"`). */
export function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element?.isConnected) return false;
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus();
  return document.activeElement === element;
}

const OPEN_DIALOG = '[role="alertdialog"], [role="dialog"]';
/**
 * About two seconds at 60 frames per second. A dialog closes, and a confirmed action's page update is committed, well
 * within it; waiting longer would move focus long after the person moved on.
 */
export const FOCUS_WAIT_FRAMES = 120;

/** Runs `then` on the first animation frame where `ready()` holds, or after `frames` frames. */
export function onceReady(ready: () => boolean, then: () => void, frames = FOCUS_WAIT_FRAMES): void {
  const attempt = (framesLeft: number) => {
    if (framesLeft > 0 && !ready()) {
      window.requestAnimationFrame(() => attempt(framesLeft - 1));
      return;
    }
    then();
  };
  window.requestAnimationFrame(() => attempt(frames));
}

const noDialogOpen = () => !document.querySelector(OPEN_DIALOG);

/**
 * Once no dialog is open any more, focuses `target()` (evaluated then, so it sees the updated page) if focus is lost.
 * A dialog that is still open traps focus and would pull it back, so the target waits for the dialog to be gone.
 */
export function restoreFocusAfterDialog(target: () => HTMLElement | null | undefined): void {
  onceReady(noDialogOpen, () => {
    if (focusLost()) focusElement(target());
  });
}

/**
 * After a successful action whose control is replaced by the page update that follows, focuses `target()` once
 * `origin` (the element around that control; null when it is already gone) has left the page, if focus went with it.
 * The update can be committed before or several frames after the action's result arrives, so this waits for it.
 */
export function restoreFocusWhenGone(origin: Element | null | undefined, target: () => HTMLElement | null | undefined): void {
  const gone = () => !origin?.isConnected;
  onceReady(gone, () => {
    if (gone() && focusLost()) focusElement(target());
  });
}

/**
 * After a dialog's action succeeded: watches for a short while (no dialog open any more) and, if focus drops to the page
 * body because the page update removed the dialog's trigger, moves it to `target()`. While the trigger stays, the dialog
 * returns focus to it and nothing happens here.
 */
export function restoreFocusWhenLost(target: () => HTMLElement | null | undefined): void {
  onceReady(
    () => noDialogOpen() && focusLost(),
    () => {
      if (noDialogOpen() && focusLost()) focusElement(target());
    },
  );
}
