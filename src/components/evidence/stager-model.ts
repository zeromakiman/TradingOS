import { shortFileName } from "./labels";
import { ACCEPTED_IMAGE_TYPES, type CaptureMethod, type EvidenceLabel, MAX_CAPTION_LENGTH, MAX_EVIDENCE_BYTES, type StagedEvidence } from "./types";
import { UPLOAD_COPY, type UploadOptions, type UploadResult, type uploadStagedEvidence } from "./upload";

/**
 * Pure state of the evidence stager (docs/V2_ARCHITECTURE.md §7.1): client checks with human copy,
 * capacity, and the item state machine `staged → uploading → uploaded | failed`. No DOM, no object
 * URLs and no randomness here: the hook (`use-evidence-stager.ts`) supplies ids and preview URLs, so
 * every transition is testable. The server re-validates everything.
 */

/** The parts of a `File` the client checks look at. */
export interface FileFacts {
  name: string;
  type: string;
  size: number;
}

function quotedName(name: string): string {
  const cleaned = [...name].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").trim();
  return cleaned ? `“${shortFileName(cleaned)}”` : "This file";
}

/** Why a file can't be staged, in words; null when it can (PNG, JPEG or WEBP, 1 byte to 4 MiB). */
export function evidenceFileProblem(file: FileFacts): string | null {
  const name = quotedName(file.name);
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return `${name} can't be added: use a PNG, JPEG or WEBP image.`;
  if (file.size <= 0) return `${name} is empty.`;
  if (file.size > MAX_EVIDENCE_BYTES) return `${name} is larger than 4 MB. Save a smaller screenshot and try again.`;
  return null;
}

/** Message when more files arrive than `max` allows (`skipped` of them were not added). */
export function capacityMessage(max: number, skipped: number): string {
  if (max <= 0) return "No more screenshots can be added here. Remove one first.";
  const left = skipped === 1 ? "1 image wasn't added" : `${skipped} images weren't added`;
  return `Up to ${max} screenshot${max === 1 ? "" : "s"} can be added here; ${left}.`;
}

export interface StagingPlan<F extends FileFacts> {
  accepted: F[];
  /** Human messages, one per rejected file plus one for files over capacity. */
  errors: string[];
}

/** Splits incoming files into those that can be staged now and human reasons for the rest. */
export function planStaging<F extends FileFacts>(files: readonly F[], stagedCount: number, max: number): StagingPlan<F> {
  const errors: string[] = [];
  const valid: F[] = [];
  for (const file of files) {
    const problem = evidenceFileProblem(file);
    if (problem) errors.push(problem);
    else valid.push(file);
  }
  const room = Math.max(0, Math.floor(max) - stagedCount);
  const accepted = valid.slice(0, room);
  if (valid.length > accepted.length) errors.push(capacityMessage(Math.max(0, Math.floor(max)), valid.length - accepted.length));
  // Files with the same name and problem read as one message.
  return { accepted, errors: [...new Set(errors)] };
}

/** Ids and the preview URL of a new item, supplied by the caller (random UUIDs and an object URL in the browser). */
export interface StagedItemSeed {
  localId: string;
  evidenceId: string;
  previewUrl: string;
}

export function createStagedItem(file: File, method: CaptureMethod, label: EvidenceLabel, seed: StagedItemSeed): StagedEvidence {
  return { ...seed, file, label, timeframe: null, caption: "", captureMethod: method, status: "staged" };
}

/** Editable details of a staged item. */
export type StagedEvidencePatch = Partial<Pick<StagedEvidence, "label" | "timeframe" | "caption">>;

export type StagerAction =
  | { type: "add"; items: readonly StagedEvidence[] }
  | { type: "update"; localId: string; patch: StagedEvidencePatch }
  | { type: "replace"; localId: string; file: File; captureMethod: CaptureMethod; evidenceId: string; previewUrl: string }
  | { type: "remove"; localId: string }
  | { type: "clear" }
  | { type: "clearUploaded" }
  | { type: "uploading"; localId: string }
  | { type: "uploaded"; localId: string }
  | { type: "failed"; localId: string; error: string };

/** Items whose details can still change: not claimed by an upload and not saved. */
export function isEditable(item: Pick<StagedEvidence, "status">): boolean {
  return item.status === "staged" || item.status === "failed";
}

/** Items an upload should send: staged, or failed and waiting for a retry. */
export function needsUpload(item: Pick<StagedEvidence, "status">): boolean {
  return isEditable(item);
}

function cleanPatch(patch: StagedEvidencePatch): StagedEvidencePatch {
  const next: StagedEvidencePatch = {};
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.timeframe !== undefined) next.timeframe = patch.timeframe;
  if (patch.caption !== undefined) next.caption = [...patch.caption].slice(0, MAX_CAPTION_LENGTH).join("");
  return next;
}

function withoutError(item: StagedEvidence): StagedEvidence {
  const { error: _error, ...rest } = item;
  return rest;
}

function mapItem(items: readonly StagedEvidence[], localId: string, change: (item: StagedEvidence) => StagedEvidence): StagedEvidence[] {
  let changed = false;
  const next = items.map(item => {
    if (item.localId !== localId) return item;
    const updated = change(item);
    if (updated !== item) changed = true;
    return updated;
  });
  return changed ? next : (items as StagedEvidence[]);
}

/**
 * The stager's state machine. Details change only while an item is staged or failed (editing a failed
 * item makes it staged again); an item being sent can't be removed or replaced; a replaced image gets a
 * new evidence id because the server refuses different bytes under an id it has seen.
 */
export function stagerReducer(items: readonly StagedEvidence[], action: StagerAction): StagedEvidence[] {
  switch (action.type) {
    case "add":
      return action.items.length ? [...items, ...action.items] : (items as StagedEvidence[]);
    case "update":
      return mapItem(items, action.localId, item => (isEditable(item) ? { ...withoutError(item), ...cleanPatch(action.patch), status: "staged" } : item));
    case "replace":
      return mapItem(items, action.localId, item => (isEditable(item)
        ? { ...withoutError(item), file: action.file, captureMethod: action.captureMethod, evidenceId: action.evidenceId, previewUrl: action.previewUrl, status: "staged" }
        : item));
    case "remove":
      return items.some(item => item.localId === action.localId && item.status !== "uploading") ? items.filter(item => item.localId !== action.localId) : (items as StagedEvidence[]);
    case "clear":
      return items.some(item => item.status !== "uploading") ? items.filter(item => item.status === "uploading") : (items as StagedEvidence[]);
    case "clearUploaded":
      return items.some(item => item.status === "uploaded") ? items.filter(item => item.status !== "uploaded") : (items as StagedEvidence[]);
    case "uploading":
      return mapItem(items, action.localId, item => (isEditable(item) ? { ...withoutError(item), status: "uploading" } : item));
    case "uploaded":
      return mapItem(items, action.localId, item => (item.status === "uploaded" ? item : { ...withoutError(item), status: "uploaded" }));
    case "failed":
      return mapItem(items, action.localId, item => (item.status === "uploaded" ? item : { ...item, status: "failed", error: action.error }));
  }
}

function settleAction(result: UploadResult): StagerAction {
  return result.ok ? { type: "uploaded", localId: result.localId } : { type: "failed", localId: result.localId, error: result.error ?? UPLOAD_COPY.failed };
}

/**
 * Uploads a batch with `uploader` and moves every item through the state machine. The whole batch is
 * claimed (`uploading`) before the first request, so an image waiting its turn can't be removed,
 * relabelled or replaced while earlier ones are sent: what is saved is exactly what its card shows, and
 * images added meanwhile wait for the next save. Each item settles as the uploader reports it; an item
 * the uploader never reported (it threw, or returned without reporting) settles from the returned
 * results or fails, so none stays "Uploading…".
 */
export async function uploadStagedBatch(
  tradeId: string,
  batch: StagedEvidence[],
  uploader: typeof uploadStagedEvidence,
  dispatch: (action: StagerAction) => void,
  options: UploadOptions = {},
): Promise<UploadResult[]> {
  if (!batch.length) return [];
  for (const item of batch) dispatch({ type: "uploading", localId: item.localId });
  const settled = new Map<string, UploadResult>();
  let returned: readonly UploadResult[] = [];
  try {
    returned = await uploader(tradeId, batch, {
      ...options,
      onItemSettled: result => {
        settled.set(result.localId, result);
        dispatch(settleAction(result));
        options.onItemSettled?.(result);
      },
    });
  } catch {
    returned = [];
  }
  const fromUploader = new Map(returned.map(result => [result.localId, result]));
  return batch.map(item => {
    const reported = settled.get(item.localId);
    if (reported) return reported;
    const result = fromUploader.get(item.localId) ?? { localId: item.localId, ok: false, error: UPLOAD_COPY.failed };
    dispatch(settleAction(result));
    return result;
  });
}

/** Short status line of a staged item for its card. */
export function stagedStatusText(item: Pick<StagedEvidence, "status" | "error">): string {
  switch (item.status) {
    case "staged": return "Ready to save";
    case "uploading": return "Uploading…";
    case "uploaded": return "Saved";
    case "failed": return item.error ?? "Not saved. Try again.";
  }
}

/** Polite announcement after images were staged from the stager's own controls. */
export function stagedAnnouncement(added: number, errors: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(added === 1 ? "1 screenshot ready to save." : `${added} screenshots ready to save.`);
  if (errors > 0) parts.push(errors === 1 ? "1 file wasn't added." : `${errors} files weren't added.`);
  return parts.join(" ");
}
