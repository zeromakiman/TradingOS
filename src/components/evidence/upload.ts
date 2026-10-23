import { SESSION_COPY, SQL_ERROR_COPY } from "@/app/actions/state";
import type { StagedEvidence } from "./types";

/**
 * Saves staged images to a trade (docs/V2_ARCHITECTURE.md §7.1–7.2): one same-origin multipart POST per
 * image to `/api/trades/{tradeId}/evidence`, strictly one after another. Every image carries its
 * client-generated `evidenceId`, so a retry after a dropped connection or a temporary server error is a
 * replay the server recognises instead of a second copy. Server text is never shown: each status maps to
 * fixed human copy.
 */

export interface UploadResult {
  localId: string;
  ok: boolean;
  /** Evidence id of the saved image (the client-generated `evidenceId`). */
  id?: string;
  /** Human message when `ok` is false. */
  error?: string;
}

export interface UploadOptions {
  /** `done` of `total` images settled (saved or failed); called with 0 before the first request. */
  onProgress?(done: number, total: number): void;
  /** An image is about to be sent. */
  onItemStart?(localId: string): void;
  /** An image was saved or failed. */
  onItemSettled?(result: UploadResult): void;
  /** Stops before the next request; the images not yet sent fail with `UPLOAD_COPY.cancelled`. */
  signal?: AbortSignal;
  /** Pauses before each retry of a network failure or temporary server error (default 600 ms, then 1.8 s). */
  retryDelaysMs?: readonly number[];
}

export const UPLOAD_COPY = Object.freeze({
  invalidImage: "This image couldn't be saved. Use a PNG, JPEG or WEBP screenshot up to 4 MB that isn't animated.",
  invalidDetails: "The screenshot details weren't accepted. Check the label, timeframe and caption.",
  session: SESSION_COPY,
  blocked: "The upload was blocked. Reload the page and try again.",
  tradeMissing: "This trade isn't available anymore. Reload the page.",
  limit: SQL_ERROR_COPY.EVIDENCE_LIMIT,
  conflict: "This screenshot clashes with an earlier upload. Remove it and add it again.",
  tooLarge: "This image is larger than 4 MB. Save a smaller screenshot and try again.",
  unavailable: "Screenshot storage is temporarily unavailable. Your screenshot is still here; try again in a moment.",
  network: "The screenshot couldn't be uploaded. Check your connection and try again.",
  failed: "The screenshot couldn't be saved. Try again.",
  cancelled: "The upload stopped before this screenshot was sent.",
});

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([600, 1800]);
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function evidenceUploadUrl(tradeId: string): string {
  return `/api/trades/${encodeURIComponent(tradeId)}/evidence`;
}

/** Multipart body of one upload: metadata fields, then the image. Empty optional fields are left out. */
export function evidenceUploadForm(item: Pick<StagedEvidence, "file" | "evidenceId" | "label" | "timeframe" | "caption" | "captureMethod">): FormData {
  const form = new FormData();
  form.set("evidenceId", item.evidenceId);
  form.set("label", item.label);
  if (item.timeframe) form.set("timeframe", item.timeframe);
  const caption = item.caption.trim();
  if (caption) form.set("caption", caption);
  form.set("captureMethod", item.captureMethod);
  form.set("file", item.file, item.file.name || "screenshot");
  return form;
}

export interface UploadFailure {
  message: string;
  /** A later attempt with the same evidence id may succeed. */
  retry: boolean;
  /** The remaining images would fail the same way, so they are not sent. */
  stop: boolean;
}

/**
 * Human outcome of an error response. The server message is only used to tell apart the two causes
 * that share a status (bad image vs bad details; screenshot limit vs id conflict), never displayed.
 */
export function uploadFailure(status: number, serverMessage: string | null): UploadFailure {
  const text = serverMessage ?? "";
  switch (status) {
    case 400: return { message: /label|timeframe|caption/i.test(text) ? UPLOAD_COPY.invalidDetails : UPLOAD_COPY.invalidImage, retry: false, stop: false };
    case 401: return { message: UPLOAD_COPY.session, retry: false, stop: true };
    case 403: return { message: UPLOAD_COPY.blocked, retry: false, stop: true };
    case 404: return { message: UPLOAD_COPY.tradeMissing, retry: false, stop: true };
    case 409: return /\b24\b|limit/i.test(text) ? { message: UPLOAD_COPY.limit, retry: false, stop: true } : { message: UPLOAD_COPY.conflict, retry: false, stop: false };
    case 413: return { message: UPLOAD_COPY.tooLarge, retry: false, stop: false };
    default:
      if (RETRY_STATUSES.has(status)) return { message: UPLOAD_COPY.unavailable, retry: true, stop: false };
      return { message: UPLOAD_COPY.failed, retry: false, stop: false };
  }
}

async function serverMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
  } catch {
    return null;
  }
}

async function savedId(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === "string" && id !== "" ? id : fallback;
  } catch {
    return fallback;
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

function pause(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

type ItemOutcome = { result: UploadResult; stop: boolean };

async function uploadOne(tradeId: string, item: StagedEvidence, delays: readonly number[], signal: AbortSignal | undefined): Promise<ItemOutcome> {
  const failed = (message: string, stop: boolean): ItemOutcome => ({ result: { localId: item.localId, ok: false, error: message }, stop });
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return failed(UPLOAD_COPY.cancelled, true);
    let response: Response;
    try {
      response = await fetch(evidenceUploadUrl(tradeId), {
        method: "POST",
        body: evidenceUploadForm(item),
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (error) {
      if (isAbort(error, signal)) return failed(UPLOAD_COPY.cancelled, true);
      if (attempt < delays.length) {
        await pause(delays[attempt], signal);
        continue;
      }
      return failed(UPLOAD_COPY.network, true);
    }
    if (response.ok) return { result: { localId: item.localId, ok: true, id: await savedId(response, item.evidenceId) }, stop: false };
    const failure = uploadFailure(response.status, await serverMessage(response));
    if (failure.retry && attempt < delays.length) {
      await pause(delays[attempt], signal);
      continue;
    }
    return failed(failure.message, failure.stop);
  }
}

/**
 * Uploads `items` one at a time and resolves with one result per item, in input order. Items already
 * `uploaded` are reported as saved without a request. After a failure that would repeat for every image
 * (signed out, trade gone, screenshot limit reached, connection lost, cancelled) the remaining images
 * are not sent and fail with the same message.
 */
export async function uploadStagedEvidence(tradeId: string, items: StagedEvidence[], opts: UploadOptions = {}): Promise<UploadResult[]> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const total = items.filter(item => item.status !== "uploaded").length;
  const results: UploadResult[] = [];
  let done = 0;
  let stopped: string | null = null;
  opts.onProgress?.(0, total);
  for (const item of items) {
    if (item.status === "uploaded") {
      results.push({ localId: item.localId, ok: true, id: item.evidenceId });
      continue;
    }
    let outcome: ItemOutcome;
    if (stopped !== null) outcome = { result: { localId: item.localId, ok: false, error: stopped }, stop: true };
    else {
      opts.onItemStart?.(item.localId);
      outcome = await uploadOne(tradeId, item, delays, opts.signal);
      if (outcome.stop) stopped = outcome.result.error ?? UPLOAD_COPY.failed;
    }
    results.push(outcome.result);
    done += 1;
    opts.onItemSettled?.(outcome.result);
    opts.onProgress?.(done, total);
  }
  return results;
}

/** One-line summary of an upload run for alerts and announcements. */
export function uploadSummary(results: readonly UploadResult[]): { saved: number; failed: number; message: string } {
  const saved = results.filter(result => result.ok).length;
  const failed = results.length - saved;
  const savedText = saved === 1 ? "1 screenshot saved." : `${saved} screenshots saved.`;
  if (failed === 0) return { saved, failed, message: savedText };
  const firstError = results.find(result => !result.ok)?.error ?? UPLOAD_COPY.failed;
  const failedText = failed === 1 ? "1 screenshot wasn't saved" : `${failed} screenshots weren't saved`;
  return { saved, failed, message: `${saved > 0 ? `${savedText} ` : ""}${failedText}: ${firstError}` };
}
