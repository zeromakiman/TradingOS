"use client";

import { type RefObject, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { entriesToKeep, pruneAutosaves, readAutosave, removeAutosave, restorableEntries, writeAutosave } from "./autosave";

/**
 * Keeps a trade form's unsaved entries in this tab (see `autosave.ts`) and brings them back when the form opens again
 * after Back, a swipe-back or a reload. Restoring happens after mount, never in the first render, so the server markup
 * and hydration match. Pristine entries are not kept; after a save, or after "Discard and leave", nothing is kept again.
 */

export interface FormAutosaveOptions<T extends object> {
  /** Storage key of this form (`autosaveKey`); null keeps nothing. */
  storageKey: string | null;
  draft: T;
  /** The form's entries when it opened: entries equal to these are not kept. */
  initial: T;
  /** The submission's request key, kept with the entries and restored with them. */
  requestKey: RefObject<string | null>;
  /** Checks stored entries against today's data (`restorePlanDraft`, `restoreLiveDraft`); null drops them. */
  restore: (stored: unknown) => T | null;
  /** Puts restored entries into the form. */
  onRestore: (draft: T) => void;
  /** Entries are written while the form is editable (not while it saves). */
  active: boolean;
}

export interface FormAutosave {
  /** The form opened with restored entries (it shows a notice with "Discard entries"). */
  restored: boolean;
  /** Keeps `draft` with the request key at once: a submission is starting. */
  save: (draft: object) => void;
  /** Forgets the entries and keeps nothing more: the form was saved, or the trader discarded the changes and left. */
  clear: () => void;
  /** Forgets the restored entries and hides the notice; new changes are kept again. */
  discard: () => void;
  /**
   * Keeps the entries without the request key from now on: the submission it named was already saved with other
   * values, so after a reload the next save is a new submission (the page itself keeps the key until then).
   */
  forgetRequestKey: () => void;
}

export function useFormAutosave<T extends object>({ storageKey, draft, initial, requestKey, restore, onRestore, active }: FormAutosaveOptions<T>): FormAutosave {
  const [restored, setRestored] = useState(false);
  const checked = useRef(false);
  const stopped = useRef(false);
  const keepRequestKey = useRef(true);
  const previousKey = useRef(storageKey);

  const write = useCallback((key: string, current: object, opened: object) => {
    const entries = entriesToKeep(current, opened, keepRequestKey.current ? requestKey.current : null);
    if (entries) writeAutosave(key, entries);
    else removeAutosave(key);
  }, [requestKey]);

  // Runs once, after mount: other users' entries and older revisions go, this form's entries come back.
  const restoreStored = useEffectEvent((key: string): boolean => {
    pruneAutosaves(key);
    const entries = restorableEntries(readAutosave(key), restore, initial);
    if (entries === null) {
      removeAutosave(key);
      return false;
    }
    if (entries.requestKey !== null) requestKey.current = entries.requestKey;
    onRestore(entries.draft);
    setRestored(true);
    return true;
  });

  useEffect(() => {
    if (!storageKey) return;
    if (previousKey.current !== storageKey) {
      // A newer revision loaded into Edit Draft: the entries now belong to its key.
      if (previousKey.current) removeAutosave(previousKey.current);
      previousKey.current = storageKey;
    }
    if (!checked.current) {
      checked.current = true;
      // Restored entries render next, and that render writes them back.
      if (restoreStored(storageKey)) return;
    }
    if (!stopped.current && active) write(storageKey, draft, initial);
  }, [storageKey, draft, initial, active, write]);

  const save = useCallback((current: object) => {
    if (storageKey && !stopped.current) write(storageKey, current, initial);
  }, [storageKey, initial, write]);

  const forgetRequestKey = useCallback(() => {
    keepRequestKey.current = false;
  }, []);

  const clear = useCallback(() => {
    stopped.current = true;
    if (storageKey) removeAutosave(storageKey);
    setRestored(false);
  }, [storageKey]);

  const discard = useCallback(() => {
    keepRequestKey.current = true;
    if (storageKey) removeAutosave(storageKey);
    setRestored(false);
  }, [storageKey]);

  return { restored, save, clear, discard, forgetRequestKey };
}
