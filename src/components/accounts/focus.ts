/**
 * Focus management of the Accounts screens (spec §13.5: dialogs restore focus). When the control that had focus goes
 * away after doing its job (a dialog opened from a menu item closes, a confirmation succeeds and its button is replaced
 * by the page update that follows), focus moves to a stable element of the same section instead of staying on the page
 * body. Focus that the person moved somewhere else in the meantime is left alone. Browser-only; call from event
 * handlers of client components.
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
const MAX_FRAMES = 120;

/** Runs `then` on the first animation frame where `ready()` holds, or after MAX_FRAMES frames. */
function onceReady(ready: () => boolean, then: () => void): void {
  const attempt = (framesLeft: number) => {
    if (framesLeft > 0 && !ready()) {
      window.requestAnimationFrame(() => attempt(framesLeft - 1));
      return;
    }
    then();
  };
  window.requestAnimationFrame(() => attempt(MAX_FRAMES));
}

/**
 * Once no dialog is open any more, focuses `target()` (evaluated then, so it sees the updated page) if focus is lost.
 * A dialog that is still open traps focus and would pull it back, and one that closes after its action's update
 * unmounts the element that had focus, so the target waits for the dialog to be gone.
 */
export function restoreFocusAfterDialog(target: () => HTMLElement | null | undefined): void {
  onceReady(
    () => !document.querySelector(OPEN_DIALOG),
    () => {
      if (focusLost()) focusElement(target());
    },
  );
}

/**
 * After a successful action whose control is replaced by the page update that follows (Confirm unchanged), focuses
 * `target()` once `origin` (the element around that control; null when it is already gone) has left the page, if focus
 * went with it. The update can be committed before or several frames after the action's result arrives, so this waits
 * for it instead of checking once. A control that is still there, and focus the person moved elsewhere, are left alone.
 */
export function restoreFocusWhenGone(origin: Element | null | undefined, target: () => HTMLElement | null | undefined): void {
  const gone = () => !origin?.isConnected;
  onceReady(gone, () => {
    if (gone() && focusLost()) focusElement(target());
  });
}
