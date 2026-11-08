/**
 * Evidence vocabulary shared by the stager, the uploader, the gallery and the viewer
 * (docs/V2_ARCHITECTURE.md §3.7, §7). The values mirror the `trade_evidence` checks and the upload
 * route (`POST /api/trades/[id]/evidence`); the default UI never prints them raw: `labels.ts` holds
 * the words. Pure module: safe in server and client components.
 */

/** What a screenshot shows (`trade_evidence.label`). Same union as `EvidenceLabel` in src/domain/timeline.ts. */
export type EvidenceLabel = "HTF" | "CONTEXT" | "PRE_ENTRY" | "ENTRY" | "MANAGEMENT" | "EXIT" | "OTHER";

/** Chart timeframe of a screenshot (`trade_evidence.timeframe`); optional on every item. */
export type Timeframe = "DAILY" | "H4" | "H1" | "M30" | "M15" | "M5" | "M3" | "OTHER";

/** How the browser captured an image (`capture_method`; DUPLICATE and IMPORT are written by the server only). */
export type CaptureMethod = "PASTE" | "DROP" | "FILE" | "CAMERA";

/** Lifecycle of a staged image: kept in the browser, being sent, saved, or failed with a human message. */
export type StagedEvidenceStatus = "staged" | "uploading" | "uploaded" | "failed";

/** An image staged in the browser before it is saved to a trade (spec §7.1). */
export interface StagedEvidence {
  /** Client-only key for lists and stager operations; never sent. */
  localId: string;
  /** Client-generated UUID sent with the upload. Retries reuse it, so the server treats them as replays. */
  evidenceId: string;
  file: File;
  /** Object URL of `file` for the preview; the stager revokes it when the item leaves. */
  previewUrl: string;
  label: EvidenceLabel;
  timeframe: Timeframe | null;
  /** Optional caption (at most 200 characters); empty string when none. */
  caption: string;
  captureMethod: CaptureMethod;
  status: StagedEvidenceStatus;
  /** Human message of the last failure (status `failed`). */
  error?: string;
}

export const EVIDENCE_LABELS: readonly EvidenceLabel[] = Object.freeze(["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"]);
export const TIMEFRAMES: readonly Timeframe[] = Object.freeze(["DAILY", "H4", "H1", "M30", "M15", "M5", "M3", "OTHER"]);
export const CAPTURE_METHODS: readonly CaptureMethod[] = Object.freeze(["PASTE", "DROP", "FILE", "CAMERA"]);

/** Image types the upload route accepts (it re-validates the bytes). */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
/** `accept` attribute of the file picker. */
export const ACCEPTED_IMAGE_INPUT = ACCEPTED_IMAGE_TYPES.join(",");
/** 4 MiB, the bucket and route limit. */
export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_CAPTION_LENGTH = 200;
/** Active (non-removed) screenshots one trade can hold (`EVIDENCE_LIMIT`, register_trade_evidence). */
export const TRADE_EVIDENCE_LIMIT = 24;

export function isEvidenceLabel(value: unknown): value is EvidenceLabel {
  return typeof value === "string" && (EVIDENCE_LABELS as readonly string[]).includes(value);
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}
