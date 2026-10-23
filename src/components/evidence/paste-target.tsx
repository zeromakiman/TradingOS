"use client";

import { ImagePlus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  capturesPaste, captureAnnouncement, clipboardHasText, clipboardImageFiles, OPEN_MODAL_SELECTOR, type PageCaptureRole, pageCaptureRole, pageDragDecision, transferHasFiles,
} from "./paste-model";
import type { CaptureMethod } from "./types";

/**
 * Page-level screenshot capture (docs/V2_ARCHITECTURE.md §7.1, §13.4): Ctrl/⌘+V anywhere stages
 * clipboard images, and dragging files over the window shows a full-page drop overlay. Pastes into plain
 * text fields are left alone unless `allowInTextFields` accepts the field (the journal composer does).
 * Capture pauses while a dialog is open or `disabled` is set; file drops are then still kept from
 * replacing the page. When several targets are mounted, the most recently enabled one receives captures.
 * A disabled target with no enabled one on the page only protects it: pages whose composers take their own
 * drops (Today) mount one so a file dropped next to a composer can't open in place of unsaved drafts.
 */

export interface EvidencePasteTargetProps {
  onFiles(files: File[], method: CaptureMethod): void;
  disabled?: boolean;
  allowInTextFields?: (el: Element) => boolean;
  children?: ReactNode;
}

/** Enabled targets, most recent last; only the last one captures. */
const activeTargets: string[] = [];

function modalOpen(): boolean {
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

function isFileInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === "file";
}

export function EvidencePasteTarget({ onFiles, disabled = false, allowInTextFields, children }: EvidencePasteTargetProps) {
  const token = useId();
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  const latest = useRef({ onFiles, allowInTextFields });

  useEffect(() => {
    latest.current = { onFiles, allowInTextFields };
  });

  useEffect(() => {
    if (!disabled) activeTargets.push(token);
    let depth = 0;
    const role = (): PageCaptureRole =>
      pageCaptureRole({ disabled, enabledTargets: activeTargets.length, isLatest: activeTargets[activeTargets.length - 1] === token, modalOpen: !disabled && modalOpen() });
    const dragDecision = (event: DragEvent) =>
      pageDragDecision({ role: role(), hasFiles: transferHasFiles(event.dataTransfer), overFileInput: isFileInput(event.target), defaultPrevented: event.defaultPrevented });
    const announce = (text: string) => setAnnouncement(previous => ({ text, count: previous.count + 1 }));
    const endDrag = () => {
      depth = 0;
      setDragging(false);
    };

    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || role() !== "capture") return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      if (!capturesPaste({ target: event.target, hasText: clipboardHasText(event.clipboardData), allowInTextFields: latest.current.allowInTextFields })) return;
      event.preventDefault();
      latest.current.onFiles(files, "PASTE");
      announce(captureAnnouncement(files.length, "PASTE"));
    };

    const onDragEnter = (event: DragEvent) => {
      if (!transferHasFiles(event.dataTransfer) || role() !== "capture") return;
      depth += 1;
      if (depth === 1) {
        setDragging(true);
        announce("Drop the files to add them as screenshots.");
      }
    };

    const onDragOver = (event: DragEvent) => {
      const decision = dragDecision(event);
      if (decision === "leave") return;
      // Without this the browser would open a dropped file in place of the page.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = decision === "copy" ? "copy" : "none";
    };

    const onDragLeave = (event: DragEvent) => {
      if (!transferHasFiles(event.dataTransfer) || depth === 0) return;
      depth -= 1;
      if (depth === 0) setDragging(false);
    };

    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      endDrag();
      // `leave` includes drops a zone inside the page (the composer or a stager) already took.
      const decision = dragDecision(event);
      if (decision === "leave") return;
      event.preventDefault();
      if (decision !== "copy" || !files.length) return;
      latest.current.onFiles(files, "DROP");
      announce(captureAnnouncement(files.length, "DROP"));
    };

    document.addEventListener("paste", onPaste);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", endDrag);
    return () => {
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", endDrag);
      const index = activeTargets.lastIndexOf(token);
      if (index !== -1) activeTargets.splice(index, 1);
      setDragging(false);
    };
  }, [disabled, token]);

  return (
    <>
      {children}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.text ? <span key={announcement.count}>{announcement.text}</span> : null}
      </p>
      {dragging && <DropOverlay />}
    </>
  );
}

/** Full-page drop overlay; decorative (the live region carries the words for assistive technology). */
function DropOverlay() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-[var(--overlay)] p-6">
      <div className="flex max-w-md flex-col items-center gap-2 rounded-card border-2 border-dashed border-accent bg-surface-raised px-8 py-10 text-center shadow-raised">
        <ImagePlus className="size-8 text-accent" />
        <p className="text-base font-semibold text-text">Drop screenshots to add them</p>
        <p className="t-meta">PNG, JPEG or WEBP · up to 4 MB each. They are saved when you add them to the trade.</p>
      </div>
    </div>
  );
}
