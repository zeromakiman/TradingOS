import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { requireUser } from "@/lib/supabase/server";
import { SCREENSHOT_BUCKET, SCREENSHOT_ROLES } from "@/lib/screenshots";
import { type EvidenceLabel, legacyEvidenceLabel, type StoredPhase } from "@/domain/timeline";
import { ProviderError } from "./provider";
import type { ReviewEvidence } from "./trade-review-context";

/**
 * Evidence binding for AI requests (spec §11.3, §11.4): V2 trade evidence and legacy proposal screenshots are
 * loaded with the user's session, and their bytes are downloaded with that session from the bucket they live in
 * and verified (length and sha256) before any reservation exists.
 */

export const TRADE_EVIDENCE_BUCKET = "trade-evidence";
export const EVIDENCE_LABELS = ["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"] as const;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type UserDb = Awaited<ReturnType<typeof requireUser>>["db"];

export interface AiEvidence {
  id: string;
  source: "TRADE_EVIDENCE" | "LEGACY_SCREENSHOT";
  /** Effective label (latest relabel wins); legacy screenshots derive it from their timeframe role. */
  label: EvidenceLabel;
  timeframe: string | null;
  caption: string | null;
  /** Value sent to the provider and stored in facts: the timeframe when set, else the label. */
  role: string;
  originalFilename: string;
  /** Phase stored at registration (V2); legacy screenshots have none and are classified from server times. */
  storedPhase: StoredPhase | null;
  recordedAt: string;
  proposalId: string | null;
  bucket: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export interface ProviderImage {
  sourceId: string;
  role: string;
  dataUrl: string;
}

/** A selection that is not part of the eligible evidence (duplicate, foreign, removed or unknown). */
export class EvidenceSelectionError extends Error {}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceRow = z.object({
  id: z.uuid(), storage_path: z.string().min(1), label: z.enum(EVIDENCE_LABELS), timeframe: z.enum(SCREENSHOT_ROLES).nullable(),
  caption: z.string().nullable(), original_filename: z.string(), mime_type: z.enum(IMAGE_TYPES), byte_size: z.number().int().positive(),
  sha256, phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), recorded_at: z.string(),
});
const labelRow = z.object({ id: z.number(), evidence_id: z.uuid(), label: z.enum(EVIDENCE_LABELS), timeframe: z.enum(SCREENSHOT_ROLES).nullable(), caption: z.string().nullable() });
const screenshotRow = z.object({
  id: z.uuid(), proposal_id: z.uuid(), role: z.enum(SCREENSHOT_ROLES), storage_path: z.string().min(1), original_filename: z.string(),
  mime_type: z.enum(IMAGE_TYPES), byte_size: z.number().int().positive(), sha256, uploaded_at: z.string(),
});

/** Columns of a legacy `setup_screenshots` row used for AI evidence (also satisfied by `Screenshot` rows of setup-data). */
export interface LegacyScreenshotRow {
  id: string; proposal_id: string; role: string; storage_path: string; original_filename: string;
  mime_type: string; byte_size: number; sha256: string; uploaded_at: string;
}

export function evidenceRole(label: EvidenceLabel, timeframe: string | null): string {
  return timeframe ?? label;
}

/** A legacy `setup_screenshots` row as AI evidence; its role stays the user-assigned timeframe (V1 facts). */
export function legacyEvidence(row: LegacyScreenshotRow): AiEvidence {
  return {
    id: row.id, source: "LEGACY_SCREENSHOT", label: legacyEvidenceLabel(row.role), timeframe: row.role, caption: null, role: row.role,
    originalFilename: row.original_filename, storedPhase: null, recordedAt: row.uploaded_at, proposalId: row.proposal_id,
    bucket: SCREENSHOT_BUCKET, storagePath: row.storage_path, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
  };
}

/** The `{id, role, sha256, mime_type, byte_size}` snapshot the pre-trade facts builders store as `selectedEvidence`. */
export function reviewEvidence(evidence: AiEvidence): ReviewEvidence {
  return { id: evidence.id, role: evidence.role, sha256: evidence.sha256, mime_type: evidence.mimeType, byte_size: evidence.byteSize };
}

/**
 * Active (not removed) evidence of a trade with effective labels, plus the active legacy screenshots of the given
 * proposals. Owner-scoped twice: RLS of the user's session and an explicit user filter.
 */
export async function loadTradeEvidence(db: UserDb, scope: { userId: string; tradeId: string; proposalIds: readonly string[] }): Promise<AiEvidence[]> {
  const { userId, tradeId } = scope;
  const proposalIds = [...new Set(scope.proposalIds)];
  const empty = { data: [], error: null };
  const [items, removals, labels, screenshots, screenshotRemovals] = await Promise.all([
    db.from("trade_evidence").select("id,storage_path,label,timeframe,caption,original_filename,mime_type,byte_size,sha256,phase,recorded_at")
      .eq("trade_id", tradeId).eq("user_id", userId).order("recorded_at").order("id"),
    db.from("trade_evidence_removals").select("evidence_id").eq("trade_id", tradeId).eq("user_id", userId),
    db.from("trade_evidence_labels").select("id,evidence_id,label,timeframe,caption").eq("trade_id", tradeId).eq("user_id", userId).order("id"),
    proposalIds.length
      ? db.from("setup_screenshots").select("id,proposal_id,role,storage_path,original_filename,mime_type,byte_size,sha256,uploaded_at")
        .in("proposal_id", proposalIds).eq("user_id", userId).order("uploaded_at").order("id")
      : empty,
    proposalIds.length ? db.from("setup_screenshot_removals").select("screenshot_id").in("proposal_id", proposalIds).eq("user_id", userId) : empty,
  ]);
  if (items.error || removals.error || labels.error || screenshots.error || screenshotRemovals.error) throw new Error("Evidence unavailable");
  const removed = new Set([
    ...z.array(z.object({ evidence_id: z.uuid() })).parse(removals.data).map(row => row.evidence_id),
    ...z.array(z.object({ screenshot_id: z.uuid() })).parse(screenshotRemovals.data).map(row => row.screenshot_id),
  ]);
  // Rows are ordered by id, so the last relabel of each item wins.
  const relabels = new Map(z.array(labelRow).parse(labels.data).map(row => [row.evidence_id, row] as const));
  const current: AiEvidence[] = z.array(evidenceRow).parse(items.data).filter(row => !removed.has(row.id)).map(row => {
    const effective = relabels.get(row.id) ?? row;
    return {
      id: row.id, source: "TRADE_EVIDENCE", label: effective.label, timeframe: effective.timeframe, caption: effective.caption,
      role: evidenceRole(effective.label, effective.timeframe), originalFilename: row.original_filename, storedPhase: row.phase,
      recordedAt: row.recorded_at, proposalId: null, bucket: TRADE_EVIDENCE_BUCKET, storagePath: row.storage_path,
      mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
    };
  });
  const legacy = z.array(screenshotRow).parse(screenshots.data).filter(row => !removed.has(row.id)).map(legacyEvidence);
  return [...current, ...legacy];
}

/**
 * Picks the requested ids from the eligible evidence, in request order. Duplicates and ids outside the eligible set
 * are rejected before anything is downloaded or written.
 */
export function selectEvidence(eligible: readonly AiEvidence[], ids: readonly string[]): AiEvidence[] {
  if (new Set(ids).size !== ids.length) throw new EvidenceSelectionError("Duplicate evidence selection");
  return ids.map(id => {
    const match = eligible.find(item => item.id === id);
    if (!match) throw new EvidenceSelectionError("Selected evidence is unavailable");
    return match;
  });
}

/** Downloads each image with the user's session and verifies length and sha256 against the registered row. */
export async function downloadEvidenceImages(db: UserDb, evidence: readonly AiEvidence[]): Promise<ProviderImage[]> {
  const images: ProviderImage[] = [];
  for (const item of evidence) {
    const { data, error } = await db.storage.from(item.bucket).download(item.storagePath);
    if (error || !data) throw new ProviderError("SCREENSHOT_UNAVAILABLE");
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length !== item.byteSize || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new ProviderError("SCREENSHOT_CHANGED");
    images.push({ sourceId: `evidence:${item.id}`, role: item.role, dataUrl: `data:${item.mimeType};base64,${bytes.toString("base64")}` });
  }
  return images;
}
