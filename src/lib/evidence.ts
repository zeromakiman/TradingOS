import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { z } from "zod";
import { type LedgerTrade, ledgerRow, LEDGER_COLUMNS } from "@/domain/ledger";
import { classifyTiming, type EvidenceLabel, inferStoredPhase, legacyEvidenceLabel, type StoredPhase } from "@/domain/timeline";
import { currentSession, type Db } from "./account-context";
import { operationalFailure } from "./operational-log";
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_BUCKET } from "./screenshots";
import { trustedServer } from "./supabase/admin";

/**
 * Trade evidence storage (docs/V2_ARCHITECTURE.md §3.7, §7, §10.2–10.3). Bytes are validated by the upload route,
 * then written by the trusted server to `trade-evidence/{uid}/{tradeId}/{evidenceId}` (never overwritten) and
 * registered through the service-only `register_trade_evidence` with the verified user id. A client-generated
 * evidence id makes retries idempotent: an existing object with the same sha256 is a replay. Reads always use the
 * user's session, so storage RLS applies a second time. Logs carry fixed event names only.
 */

export const TRADE_EVIDENCE_BUCKET = "trade-evidence";
export const MAX_EVIDENCE_BYTES = MAX_SCREENSHOT_BYTES;
/** Multipart overhead allowed on top of the 4 MiB image. */
export const MAX_EVIDENCE_BODY = MAX_EVIDENCE_BYTES + 64 * 1024;
export const EVIDENCE_LABELS = ["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"] as const satisfies readonly EvidenceLabel[];
export const EVIDENCE_TIMEFRAMES = ["DAILY", "H4", "H1", "M30", "M15", "M5", "M3", "OTHER"] as const;
/** Capture methods a browser may report; DUPLICATE and IMPORT are written by the server only. */
export const CLIENT_CAPTURE_METHODS = ["PASTE", "DROP", "FILE", "CAMERA"] as const;
export type CaptureMethod = (typeof CLIENT_CAPTURE_METHODS)[number] | "DUPLICATE";
export const THUMBNAIL_SIZE = 640;
export const EVIDENCE_LIMIT_MESSAGE = "A trade supports 24 active screenshots. Remove one before adding another.";

export function evidencePath(userId: string, tradeId: string, evidenceId: string): string {
  return `${userId}/${tradeId}/${evidenceId}`;
}

/** File name for the record only (never a storage path): control characters removed, at most 255 characters. */
export function safeFilename(name: string | null | undefined): string {
  const cleaned = [...(name ?? "")].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").trim().slice(0, 255);
  return cleaned || "screenshot";
}

/** WEBP preview that fits inside 640×640, never enlarged, oriented by its EXIF data. */
export async function evidenceThumbnail(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" })
    .rotate()
    .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------
// Upload and registration.
// ---------------------------------------------------------------------------------------------------------
export interface EvidenceFile {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
}

export interface EvidenceRecordInput {
  label: EvidenceLabel;
  timeframe: (typeof EVIDENCE_TIMEFRAMES)[number] | null;
  caption: string | null;
  originalFilename: string;
  captureMethod: CaptureMethod;
  /** Source item of a duplicate (§7.4). */
  copiedFrom?: string;
}

export interface StoreEvidenceInput {
  userId: string;
  tradeId: string;
  evidenceId: string;
  record: EvidenceRecordInput;
  file: EvidenceFile;
}

export type StoreEvidenceOutcome =
  | { ok: true; status: 201; id: string; phase: StoredPhase; replayed: boolean }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string; code: "INVALID" | "TRADE_NOT_FOUND" | "EVIDENCE_LIMIT" | "CONFLICT" | "STORAGE" };

interface StorageError {
  message: string;
  status?: number;
  statusCode?: string;
  code?: string;
}

/** The trusted-server and session operations an upload needs (supabase-js in production, doubles in tests). */
export interface EvidenceServices {
  /** Trusted server upload, `upsert: false`. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: StorageError | null }>;
  /** Trusted server download (replay detection only). */
  download(path: string): Promise<{ data: Blob | null; error: StorageError | null }>;
  remove(paths: string[]): Promise<{ error: StorageError | null }>;
  /** `register_trade_evidence` with the verified user id (service role). */
  register(userId: string, record: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  /**
   * The registered phase of this evidence id at this storage path, read with the user's session; null when nothing is
   * registered there, undefined when it could not be read.
   */
  registeredPhase(evidenceId: string, storagePath: string): Promise<StoredPhase | null | undefined>;
}

function alreadyExists(error: StorageError): boolean {
  return error.code === "ResourceAlreadyExists" || error.statusCode === "409" || error.status === 409 || /already exists/i.test(error.message);
}

const registration = z.object({
  id: z.uuid(), tradeId: z.uuid(), phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), stateAtCreation: z.string(), recordedAt: z.string(), replayed: z.boolean(),
});

function sqlCode(message: string): string | null {
  return /^([A-Z][A-Z_]+):/.exec(message)?.[1] ?? null;
}

/**
 * Stores and registers one validated image. The object is removed again when registration definitely failed; when the
 * outcome is unknown (the response was lost), the registration is looked up first so a registered image is never
 * orphaned from its bytes.
 */
export async function storeTradeEvidence(input: StoreEvidenceInput, services: EvidenceServices): Promise<StoreEvidenceOutcome> {
  const path = evidencePath(input.userId, input.tradeId, input.evidenceId);
  const upload = await services.upload(path, input.file.bytes, input.file.mimeType);
  if (upload.error) {
    if (!alreadyExists(upload.error)) {
      operationalFailure("storage_upload_failed", 503);
      return { ok: false, status: 503, code: "STORAGE", error: "Private storage upload failed. Please try again." };
    }
    // A retry of the same image finds its own object; any other content under this id is a conflict.
    const existing = await services.download(path);
    if (existing.error || !existing.data) {
      operationalFailure("storage_upload_failed", 503);
      return { ok: false, status: 503, code: "STORAGE", error: "Private storage upload failed. Please try again." };
    }
    if (sha256Hex(new Uint8Array(await existing.data.arrayBuffer())) !== input.file.sha256) {
      return { ok: false, status: 409, code: "CONFLICT", error: "This upload id was already used for a different image. Stage the image again." };
    }
  }
  const record = {
    id: input.evidenceId, tradeId: input.tradeId, storagePath: path, label: input.record.label, timeframe: input.record.timeframe, caption: input.record.caption,
    originalFilename: input.record.originalFilename, mimeType: input.file.mimeType, byteSize: input.file.byteSize, sha256: input.file.sha256,
    width: input.file.width, height: input.file.height, captureMethod: input.record.captureMethod, ...(input.record.copiedFrom ? { copiedFrom: input.record.copiedFrom } : {}),
  };
  const result = await services.register(input.userId, record);
  if (!result.error) {
    const parsed = registration.safeParse(result.data);
    if (parsed.success) return { ok: true, status: 201, id: parsed.data.id, phase: parsed.data.phase, replayed: parsed.data.replayed };
  }
  const code = result.error ? sqlCode(result.error.message) : null;
  const definite = code === "EVIDENCE_LIMIT" || code === "IDEMPOTENCY_CONFLICT" || code === "TRADE_NOT_FOUND" || code === "INVALID_INPUT";
  if (!definite) {
    // Unknown outcome: keep the object when the registration did happen.
    const phase = await services.registeredPhase(input.evidenceId, path);
    if (phase) return { ok: true, status: 201, id: input.evidenceId, phase, replayed: true };
    operationalFailure("storage_registration_failed", 503);
    if (phase === undefined) return { ok: false, status: 503, code: "STORAGE", error: "The screenshot could not be saved. Please try again." };
  }
  const cleanup = await services.remove([path]);
  if (cleanup.error) operationalFailure("storage_cleanup_failed", 503);
  switch (code) {
    case "EVIDENCE_LIMIT": return { ok: false, status: 409, code: "EVIDENCE_LIMIT", error: EVIDENCE_LIMIT_MESSAGE };
    case "IDEMPOTENCY_CONFLICT": return { ok: false, status: 409, code: "CONFLICT", error: "This upload id was already used for a different image. Stage the image again." };
    case "TRADE_NOT_FOUND": return { ok: false, status: 404, code: "TRADE_NOT_FOUND", error: "Trade not found" };
    case "INVALID_INPUT": return { ok: false, status: 400, code: "INVALID", error: "The screenshot details were not accepted. Check the label, timeframe and caption." };
    default: return { ok: false, status: 503, code: "STORAGE", error: "The screenshot could not be saved. Please try again." };
  }
}

/** Production services: the trusted client writes, the user's session reads registrations (RLS). */
export function supabaseEvidenceServices(trusted: SupabaseClient, session: Db, userId: string): EvidenceServices {
  const bucket = trusted.storage.from(TRADE_EVIDENCE_BUCKET);
  return {
    upload: (path, bytes, contentType) => bucket.upload(path, bytes, { contentType, upsert: false }),
    download: path => bucket.download(path),
    remove: paths => bucket.remove(paths),
    register: async (id, record) => {
      const { data, error } = await trusted.rpc("register_trade_evidence", { p_user_id: id, p_record: record });
      return { data, error };
    },
    registeredPhase: async (evidenceId, storagePath) => {
      const { data, error } = await session.from("trade_evidence").select("phase").eq("id", evidenceId).eq("storage_path", storagePath).eq("user_id", userId).maybeSingle();
      if (error) return undefined;
      const row = z.object({ phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]) }).safeParse(data);
      return row.success ? row.data.phase : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Reuse on duplicate (§7.4).
// ---------------------------------------------------------------------------------------------------------
export interface CopyEvidenceResult {
  copied: number;
  /** Items not copied because the new draft reached its screenshot limit. */
  skipped: number;
  failed: number;
}

/**
 * Deterministic id of the copy of `sourceId` in `targetTradeId` (UUID v4 layout from a hash), so a retried duplicate
 * finds its earlier copies instead of copying twice.
 */
export function copiedEvidenceId(targetTradeId: string, sourceId: string): string {
  const hex = createHash("sha256").update(`trade-evidence-copy:${targetTradeId}:${sourceId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}

const MIME = z.enum(["image/png", "image/jpeg", "image/webp"]);
const TIMEFRAME = z.enum(EVIDENCE_TIMEFRAMES);
const v2Row = z.object({
  id: z.uuid(), storage_path: z.string(), label: z.enum(EVIDENCE_LABELS), timeframe: TIMEFRAME.nullable(), caption: z.string().nullable(),
  original_filename: z.string(), mime_type: MIME, byte_size: z.number().int().positive(), sha256: z.string(), width: z.number().int().positive(),
  height: z.number().int().positive(), phase: z.enum(["PRE_ENTRY", "LIVE", "POST_TRADE"]), recorded_at: z.string(),
});
const labelRow = z.object({ id: z.number().int(), evidence_id: z.uuid(), label: z.enum(EVIDENCE_LABELS), timeframe: TIMEFRAME.nullable(), caption: z.string().nullable() });
const legacyRow = z.object({
  id: z.uuid(), role: TIMEFRAME, storage_path: z.string(), original_filename: z.string(), mime_type: MIME, byte_size: z.number().int().positive(),
  sha256: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), uploaded_at: z.string(),
});

interface CopyCandidate {
  sourceId: string;
  bucket: string;
  storagePath: string;
  record: Omit<EvidenceRecordInput, "captureMethod" | "copiedFrom">;
  mimeType: EvidenceFile["mimeType"];
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  recordedAt: string;
}

/** Active evidence of the source whose timing there was Before entry (all active evidence of a draft). */
export async function copyableEvidence(db: Db, userId: string, source: LedgerTrade): Promise<CopyCandidate[]> {
  const revisions = await db.from("trade_revisions").select("proposal_id").eq("trade_id", source.id).eq("user_id", userId);
  if (revisions.error) throw new Error("Evidence unavailable");
  const proposalIds = z.array(z.object({ proposal_id: z.uuid() })).parse(revisions.data ?? []).map(row => row.proposal_id);
  const none = Promise.resolve({ data: [], error: null });
  const [items, labels, removals, screenshots, screenshotRemovals] = await Promise.all([
    db.from("trade_evidence").select("id,storage_path,label,timeframe,caption,original_filename,mime_type,byte_size,sha256,width,height,phase,recorded_at")
      .eq("trade_id", source.id).eq("user_id", userId).order("recorded_at", { ascending: true }).order("id", { ascending: true }),
    db.from("trade_evidence_labels").select("id,evidence_id,label,timeframe,caption").eq("trade_id", source.id).eq("user_id", userId).order("id", { ascending: true }),
    db.from("trade_evidence_removals").select("evidence_id").eq("trade_id", source.id).eq("user_id", userId),
    proposalIds.length
      ? db.from("setup_screenshots").select("id,role,storage_path,original_filename,mime_type,byte_size,sha256,width,height,uploaded_at").eq("user_id", userId)
        .in("proposal_id", proposalIds).order("uploaded_at", { ascending: true }).order("id", { ascending: true })
      : none,
    proposalIds.length ? db.from("setup_screenshot_removals").select("screenshot_id").eq("user_id", userId).in("proposal_id", proposalIds) : none,
  ]);
  if (items.error || labels.error || removals.error || screenshots.error || screenshotRemovals.error) throw new Error("Evidence unavailable");
  const removed = new Set([
    ...z.array(z.object({ evidence_id: z.uuid() })).parse(removals.data ?? []).map(row => row.evidence_id),
    ...z.array(z.object({ screenshot_id: z.uuid() })).parse(screenshotRemovals.data ?? []).map(row => row.screenshot_id),
  ]);
  const latestLabel = new Map(z.array(labelRow).parse(labels.data ?? []).map(row => [row.evidence_id, row] as const));
  const entryRecordedAt = source.entry_recorded_at ?? (source.origin === "PLANNED" ? null : source.created_at);
  const beforeEntry = (recordedAt: string, storedPhase: StoredPhase | null) => classifyTiming({
    recordedAt, storedPhase: storedPhase ?? inferStoredPhase(recordedAt, entryRecordedAt, source.close_recorded_at), origin: source.origin,
    entryAt: source.entered_at, entryRecordedAt, exitAt: source.exited_at, tradeCreatedAt: source.created_at,
  }).timing === "BEFORE_ENTRY";
  const v2 = z.array(v2Row).parse(items.data ?? []).filter(row => !removed.has(row.id) && beforeEntry(row.recorded_at, row.phase)).map(row => {
    const label = latestLabel.get(row.id) ?? row;
    return {
      sourceId: row.id, bucket: TRADE_EVIDENCE_BUCKET, storagePath: row.storage_path,
      record: { label: label.label, timeframe: label.timeframe, caption: label.caption, originalFilename: row.original_filename },
      mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, width: row.width, height: row.height, recordedAt: row.recorded_at,
    };
  });
  const legacy = z.array(legacyRow).parse(screenshots.data ?? []).filter(row => !removed.has(row.id) && beforeEntry(row.uploaded_at, null)).map(row => ({
    sourceId: row.id, bucket: SCREENSHOT_BUCKET, storagePath: row.storage_path,
    record: { label: legacyEvidenceLabel(row.role), timeframe: row.role, caption: null, originalFilename: row.original_filename },
    mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, width: row.width, height: row.height, recordedAt: row.uploaded_at,
  }));
  return [...v2, ...legacy].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.sourceId < b.sourceId ? -1 : 1));
}

export interface CopyDeps {
  db: Db;
  userId: string;
  services: EvidenceServices;
}

/**
 * Copies the source trade's Before-entry evidence into the duplicated draft (legacy screenshots move to the V2
 * bucket). Bytes are read with the user's session and verified against the registered sha256 before the copy is
 * stored with `capture_method 'DUPLICATE'` and `copied_from` = the source id; the database re-checks eligibility.
 */
export async function copyEvidence(deps: CopyDeps, sourceTradeId: string, newTradeId: string): Promise<CopyEvidenceResult> {
  const { db, userId } = deps;
  const [sourceResult, target] = await Promise.all([
    db.from("trade_ledger").select(LEDGER_COLUMNS.join(",") as "*").eq("id", sourceTradeId).maybeSingle(),
    db.from("trades").select("id,duplicated_from").eq("id", newTradeId).eq("user_id", userId).maybeSingle(),
  ]);
  if (sourceResult.error || target.error) throw new Error("Trades unavailable");
  const targetRow = target.data ? z.object({ id: z.uuid(), duplicated_from: z.uuid().nullable() }).parse(target.data) : null;
  if (!sourceResult.data || !targetRow || targetRow.duplicated_from !== sourceTradeId) return { copied: 0, skipped: 0, failed: 0 };
  const candidates = await copyableEvidence(db, userId, ledgerRow.parse(sourceResult.data));
  const result: CopyEvidenceResult = { copied: 0, skipped: 0, failed: 0 };
  for (const [index, candidate] of candidates.entries()) {
    const download = await db.storage.from(candidate.bucket).download(candidate.storagePath);
    const bytes = download.data ? new Uint8Array(await download.data.arrayBuffer()) : null;
    if (download.error || !bytes || bytes.length !== candidate.byteSize || sha256Hex(bytes) !== candidate.sha256) {
      result.failed += 1;
      continue;
    }
    const outcome = await storeTradeEvidence({
      userId, tradeId: newTradeId, evidenceId: copiedEvidenceId(newTradeId, candidate.sourceId),
      record: { ...candidate.record, captureMethod: "DUPLICATE", copiedFrom: candidate.sourceId },
      file: { bytes, mimeType: candidate.mimeType, byteSize: candidate.byteSize, sha256: candidate.sha256, width: candidate.width, height: candidate.height },
    }, deps.services);
    if (outcome.ok) result.copied += 1;
    else if (outcome.code === "EVIDENCE_LIMIT") {
      result.skipped += candidates.length - index;
      break;
    } else result.failed += 1;
  }
  return result;
}

/** Duplicate-draft evidence copy for the signed-in user (trusted server for writes, the session for reads). */
export async function copyEvidenceForDuplicate(sourceTradeId: string, newTradeId: string): Promise<CopyEvidenceResult> {
  const { db, user } = await currentSession();
  const trusted = trustedServer();
  return copyEvidence({ db, userId: user.id, services: supabaseEvidenceServices(trusted, db, user.id) }, sourceTradeId, newTradeId);
}
