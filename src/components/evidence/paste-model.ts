import { isTypingTarget } from "@/components/shell/shortcuts";
import type { CaptureMethod } from "./types";

/**
 * Rules of page-level capture (docs/V2_ARCHITECTURE.md §7.1, §13.4), pure so they are testable without a
 * browser: which clipboard entries are images, when Ctrl/⌘+V belongs to a text field instead of the
 * stager, and whether a drag carries files.
 */

/** The parts of `DataTransferItem` the clipboard reader uses. */
export interface TransferItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** The parts of `DataTransfer` (a paste's `clipboardData` or a drop's `dataTransfer`) the readers use. */
export interface TransferLike {
  items?: ArrayLike<TransferItemLike> | null;
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | null;
}

/** Image files on the clipboard (`items` first; `files` for browsers that only fill that list). */
export function clipboardImageFiles(data: TransferLike | null | undefined): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length) return fromItems;
  return Array.from(data.files ?? []).filter(file => file.type.startsWith("image/"));
}

/** True when the clipboard also carries plain text (copying a table can carry a rendered image too). */
export function clipboardHasText(data: TransferLike | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes("text/plain");
}

/** True when a drag carries files from the operating system (not text or links dragged within the page). */
export function transferHasFiles(data: TransferLike | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}

export interface PasteContext {
  /** The focused element receiving the paste. */
  target: unknown;
  /** The clipboard also carries plain text. */
  hasText: boolean;
  /** Text fields that still accept pasted images, for example the journal composer. */
  allowInTextFields?: (element: Element) => boolean;
}

/**
 * Whether a paste with images is captured as screenshots. Outside text fields it always is. In a text
 * field it is only when `allowInTextFields` accepts the field and the clipboard has no plain text, so
 * pasting copied words into a note still inserts the words.
 */
export function capturesPaste({ target, hasText, allowInTextFields }: PasteContext): boolean {
  if (!isTypingTarget(target)) return true;
  if (!allowInTextFields || hasText) return false;
  return allowInTextFields(target as Element);
}

/** "Pasted 1 screenshot." / "Dropped 3 files." */
export function captureAnnouncement(count: number, method: CaptureMethod): string {
  if (method === "PASTE") return count === 1 ? "Pasted 1 screenshot." : `Pasted ${count} screenshots.`;
  return count === 1 ? "Dropped 1 file." : `Dropped ${count} files.`;
}

/** Selector of open modal layers; page capture pauses while one is open. */
export const OPEN_MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * What one mounted `<EvidencePasteTarget>` does with page pastes and file drags. `capture`: it takes them.
 * `protect`: nothing is captured (it is disabled and no target is enabled, or a dialog is open), but a file
 * dropped on the page must not replace it. `ignore`: another target is responsible.
 */
export type PageCaptureRole = "capture" | "protect" | "ignore";

export interface PageCaptureState {
  disabled: boolean;
  /** Enabled targets mounted on the page. */
  enabledTargets: number;
  /** This target is the most recently enabled one. */
  isLatest: boolean;
  modalOpen: boolean;
}

export function pageCaptureRole({ disabled, enabledTargets, isLatest, modalOpen }: PageCaptureState): PageCaptureRole {
  if (disabled) return enabledTargets === 0 ? "protect" : "ignore";
  if (!isLatest) return "ignore";
  return modalOpen ? "protect" : "capture";
}

export interface PageDragEvent {
  role: PageCaptureRole;
  /** The drag carries files from the operating system. */
  hasFiles: boolean;
  /** The drag is over a file input, which takes the drop itself. */
  overFileInput: boolean;
  /** A drop zone inside the page (the composer or a stager) already took the drag. */
  defaultPrevented: boolean;
}

/**
 * The window's answer to a file `dragover` or `drop`: `copy` takes the files, `block` refuses them (prevent
 * the default with drop effect "none", so the browser doesn't open the image in place of the page and
 * unsaved drafts survive), `leave` does nothing.
 */
export function pageDragDecision({ role, hasFiles, overFileInput, defaultPrevented }: PageDragEvent): "copy" | "block" | "leave" {
  if (!hasFiles || overFileInput || defaultPrevented || role === "ignore") return "leave";
  return role === "capture" ? "copy" : "block";
}
