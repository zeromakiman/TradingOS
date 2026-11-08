import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CLIENT_CAPTURE_METHODS, EVIDENCE_LABELS, EVIDENCE_TIMEFRAMES, MAX_EVIDENCE_BODY, safeFilename, storeTradeEvidence, supabaseEvidenceServices,
} from "@/lib/evidence";
import { boundedBody, RequestError, routeError, routeUser } from "@/lib/route-security";
import { checkSchema, SCHEMA_OUTDATED_MESSAGE, SchemaUnavailableError } from "@/lib/schema-gate";
import { validateScreenshot } from "@/lib/screenshots";
import { trustedServer } from "@/lib/supabase/admin";

/**
 * POST /api/trades/[id]/evidence (docs/V2_ARCHITECTURE.md §7.2): one image per request.
 * Same-origin + session → trade ownership with the user's RLS client → bounded body (4 MiB + 64 KiB) → magic bytes and
 * a full decode (40 MP, single frame) → trusted upload to trade-evidence/{uid}/{tradeId}/{evidenceId} (never
 * overwritten; an identical existing object is a replay) → register_trade_evidence with the verified user id →
 * cleanup when registration fails. 201 {id, phase, replayed}; 409 limit/conflict, 413 size, 400 type/decode,
 * 404 trade, 503 storage.
 *
 * Multipart fields: `file`, `evidenceId` (client UUID, reused on retry), `label`, `timeframe?`, `caption?`,
 * `captureMethod?` (PASTE | DROP | FILE | CAMERA; FILE by default).
 */
export const runtime = "nodejs";

/** validateScreenshot has already matched the bytes against one of these types. */
const IMAGE_TYPES = z.enum(["image/png", "image/jpeg", "image/webp"]);

const fields = z.object({
  evidenceId: z.uuid(),
  label: z.enum(EVIDENCE_LABELS),
  timeframe: z.enum(EVIDENCE_TIMEFRAMES).nullable(),
  caption: z.string().trim().max(200).transform(value => value || null),
  captureMethod: z.enum(CLIENT_CAPTURE_METHODS),
});

function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { db, user } = await routeUser(request, true);
    const tradeId = (await params).id.toLowerCase();
    if (!z.uuid().safeParse(tradeId).success) throw new RequestError("Trade not found", 404);
    let schemaReady: boolean;
    try {
      schemaReady = (await checkSchema(db)).ready;
    } catch (error) {
      if (error instanceof SchemaUnavailableError) throw new RequestError("Unable to save this screenshot. Please try again.", 503);
      throw error;
    }
    if (!schemaReady) throw new RequestError(SCHEMA_OUTDATED_MESSAGE, 503);
    const owned = await db.from("trades").select("id").eq("id", tradeId).eq("user_id", user.id).maybeSingle();
    if (owned.error) throw new RequestError("Unable to load this trade. Please try again.", 503);
    if (!owned.data) throw new RequestError("Trade not found", 404);

    const body = await boundedBody(request, MAX_EVIDENCE_BODY);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
    } catch {
      throw new RequestError("Choose an image and a label.");
    }
    const file = form.get("file");
    const input = fields.safeParse({
      evidenceId: text(form, "evidenceId")?.toLowerCase(),
      label: text(form, "label"),
      timeframe: text(form, "timeframe") || null,
      caption: text(form, "caption") ?? "",
      captureMethod: text(form, "captureMethod") || "FILE",
    });
    if (!(file instanceof File) || !input.success) throw new RequestError("Choose an image and a label.");
    const bytes = Buffer.from(await file.arrayBuffer());
    let metadata: Awaited<ReturnType<typeof validateScreenshot>>;
    try {
      metadata = await validateScreenshot(bytes, file.type);
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : "Unsupported image");
    }

    let trusted: ReturnType<typeof trustedServer>;
    try {
      trusted = trustedServer();
    } catch {
      throw new RequestError("Private storage is not available. Please try again later.", 503);
    }
    const outcome = await storeTradeEvidence({
      userId: user.id,
      tradeId,
      evidenceId: input.data.evidenceId,
      record: {
        label: input.data.label, timeframe: input.data.timeframe, caption: input.data.caption, originalFilename: safeFilename(file.name),
        captureMethod: input.data.captureMethod,
      },
      file: { bytes, mimeType: IMAGE_TYPES.parse(metadata.mime_type), byteSize: metadata.byte_size, sha256: metadata.sha256, width: metadata.width, height: metadata.height },
    }, supabaseEvidenceServices(trusted, db, user.id));
    if (!outcome.ok) throw new RequestError(outcome.error, outcome.status);
    revalidatePath(`/trades/${tradeId}`);
    revalidatePath("/journal");
    return Response.json({ id: outcome.id, phase: outcome.phase, replayed: outcome.replayed }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
