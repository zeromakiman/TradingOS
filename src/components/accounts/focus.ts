/**
 * Focus management of the Accounts and Today screens (spec §13.5: dialogs restore focus). When the control that had
 * focus goes away after doing its job (a dialog opened from a menu item closes, a confirmation succeeds and its button is
 * replaced by the page update that follows), focus moves to a stable element of the same section instead of staying on
 * the page body. Focus that the person moved somewhere else in the meantime is left alone. Browser-only; call from event
 * handlers of client components. The primitives (focusLost, focusElement, the frame wait) are the design system's
 * (src/components/ui/focus.ts); this module adds the two waits these screens need.
 */
import { focusElement, focusLost, noDialogOpen, onceReady } from "@/components/ui/focus";

export { focusElement, focusLost };

/**
 * Once no dialog is open any more, focuses `target()` (evaluated then, so it sees the updated page) if focus is lost.
 * A dialog that is still open traps focus and would pull it back, and one that closes after its action's update
 * unmounts the element that had focus, so the target waits for the dialog to be gone.
 */
export function restoreFocusAfterDialog(target: () => HTMLElement | null | undefined): void {
  onceReady(noDialogOpen, () => {
    if (focusLost()) focusElement(target());
  });
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
