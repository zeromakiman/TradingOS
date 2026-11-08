"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createStagedItem, isEditable, needsUpload, planStaging, type StagedEvidencePatch, type StagerAction, stagerReducer, uploadStagedBatch,
} from "./stager-model";
import { type CaptureMethod, type EvidenceLabel, type StagedEvidence, TRADE_EVIDENCE_LIMIT } from "./types";
import { type UploadOptions, type UploadResult, uploadStagedEvidence } from "./upload";

/**
 * Client state of staged screenshots (docs/V2_ARCHITECTURE.md §7.1): checks (PNG, JPEG or WEBP, at most
 * 4 MiB) with human errors, a client-generated evidence id per image for idempotent retries, and the
 * object-URL lifecycle of the previews (revoked when an item leaves and on unmount). Pair it with
 * `<EvidenceStager>` for the controls and `<EvidencePasteTarget onFiles={stager.addFiles}>` for
 * Ctrl/⌘+V and page drops.
 */

export interface EvidenceStagerOptions {
  /** Label of new images; by timing with `defaultLabelForTiming` (draft → Pre-entry, live → Management, closed → Exit). */
  defaultLabel: EvidenceLabel;
  /** Images this stager may hold at once, for example the trade's remaining capacity (default 24). */
  max?: number;
  /** Replaces the network upload, for demos and tests (default `uploadStagedEvidence`). */
  uploader?: typeof uploadStagedEvidence;
}

export interface AddFilesResult {
  added: StagedEvidence[];
  /** Human reasons for the files that were not staged. */
  errors: string[];
}

export interface EvidenceStagerApi {
  items: StagedEvidence[];
  /** Reasons the last add or replace left files out; cleared by the next one or `dismissErrors`. */
  errors: string[];
  defaultLabel: EvidenceLabel;
  max: number;
  /** Images that can still be staged. */
  remaining: number;
  /** Staged or failed images waiting to be saved. */
  pendingCount: number;
  addFiles(files: File[], method: CaptureMethod): AddFilesResult;
  update(localId: string, patch: StagedEvidencePatch): void;
  /** Swaps the image of a staged item (new evidence id, same details); returns a human error or null. */
  replace(localId: string, file: File, method: CaptureMethod): string | null;
  remove(localId: string): void;
  /** Removes every item that is not being sent. */
  clear(): void;
  /** Removes saved items (after the page shows them). */
  clearUploaded(): void;
  dismissErrors(): void;
  markUploading(localId: string): void;
  markUploaded(localId: string): void;
  markFailed(localId: string, error: string): void;
  /**
   * Uploads every staged or failed item to the trade, one at a time. They are all marked "Uploading…" at
   * once and can't be edited, removed or replaced until they settle; images added meanwhile wait.
   */
  uploadAll(tradeId: string, options?: UploadOptions): Promise<UploadResult[]>;
}

const HEX = "0123456789abcdef";

/** RFC 4122 v4 UUID; `crypto.randomUUID` is missing outside secure contexts (for example a LAN address over http). */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => HEX[byte >> 4] + HEX[byte & 0x0f]).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useEvidenceStager({ defaultLabel, max = TRADE_EVIDENCE_LIMIT, uploader = uploadStagedEvidence }: EvidenceStagerOptions): EvidenceStagerApi {
  const [items, setItems] = useState<StagedEvidence[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  // The source of truth between renders, so rapid operations (two pastes in one tick) never act on stale items.
  const current = useRef<StagedEvidence[]>(items);
  const previewUrls = useRef(new Set<string>());

  const dispatch = useCallback((action: StagerAction) => {
    const next = stagerReducer(current.current, action);
    if (next === current.current) return;
    current.current = next;
    setItems(next);
  }, []);

  // Revoke the preview URL of every item that left the stager.
  useEffect(() => {
    const live = new Set(items.map(item => item.previewUrl));
    for (const url of previewUrls.current) if (!live.has(url)) URL.revokeObjectURL(url);
    previewUrls.current = live;
  }, [items]);

  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current = new Set();
  }, []);

  const limit = Math.max(0, Math.floor(max));

  const addFiles = useCallback((files: File[], method: CaptureMethod): AddFilesResult => {
    const plan = planStaging(files, current.current.length, limit);
    const added = plan.accepted.map(file => createStagedItem(file, method, defaultLabel, { localId: randomUuid(), evidenceId: randomUuid(), previewUrl: URL.createObjectURL(file) }));
    dispatch({ type: "add", items: added });
    setErrors(plan.errors);
    return { added, errors: plan.errors };
  }, [defaultLabel, dispatch, limit]);

  const replace = useCallback((localId: string, file: File, method: CaptureMethod): string | null => {
    const target = current.current.find(item => item.localId === localId);
    if (!target || !isEditable(target)) return "This screenshot can't be replaced while it is being saved.";
    const plan = planStaging([file], 0, 1);
    if (plan.errors.length) {
      setErrors(plan.errors);
      return plan.errors[0];
    }
    dispatch({ type: "replace", localId, file, captureMethod: method, evidenceId: randomUuid(), previewUrl: URL.createObjectURL(file) });
    setErrors([]);
    return null;
  }, [dispatch]);

  const uploadAll = useCallback(
    (tradeId: string, options: UploadOptions = {}): Promise<UploadResult[]> => uploadStagedBatch(tradeId, current.current.filter(needsUpload), uploader, dispatch, options),
    [dispatch, uploader],
  );

  return useMemo<EvidenceStagerApi>(() => ({
    items,
    errors,
    defaultLabel,
    max: limit,
    remaining: Math.max(0, limit - items.length),
    pendingCount: items.filter(needsUpload).length,
    addFiles,
    update: (localId, patch) => dispatch({ type: "update", localId, patch }),
    replace,
    remove: localId => dispatch({ type: "remove", localId }),
    clear: () => {
      dispatch({ type: "clear" });
      setErrors([]);
    },
    clearUploaded: () => dispatch({ type: "clearUploaded" }),
    dismissErrors: () => setErrors([]),
    markUploading: localId => dispatch({ type: "uploading", localId }),
    markUploaded: localId => dispatch({ type: "uploaded", localId }),
    markFailed: (localId, error) => dispatch({ type: "failed", localId, error }),
    uploadAll,
  }), [items, errors, defaultLabel, limit, addFiles, replace, uploadAll, dispatch]);
}
