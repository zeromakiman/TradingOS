import { z } from "zod";
import { evidenceThumbnail, TRADE_EVIDENCE_BUCKET } from "@/lib/evidence";
import { RequestError, routeError, routeUser } from "@/lib/route-security";

/**
 * GET /api/evidence/[id] (docs/V2_ARCHITECTURE.md §7.3, §10.2): the bytes of one V2 evidence item for its owner.
 * The row is read with the user's session (RLS plus an explicit owner filter) and the object is downloaded with that
 * session, so the storage policy checks ownership a second time. `?variant=thumb` returns a WEBP that fits inside
 * 640×640 (never enlarged). Responses are private and never cached.
 */
export const runtime = "nodejs";

const IMAGE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { db, user } = await routeUser(request);
    const id = (await params).id.toLowerCase();
    if (!z.uuid().safeParse(id).success) throw new RequestError("Image not found", 404);
    const variant = new URL(request.url).searchParams.get("variant");
    if (variant !== null && variant !== "thumb") throw new RequestError("Unknown image variant");
    const { data: row, error } = await db.from("trade_evidence").select("storage_path,mime_type").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (error) throw new RequestError("Unable to load this image. Please try again.", 503);
    const evidence = row ? z.object({ storage_path: z.string(), mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]) }).parse(row) : null;
    if (!evidence) throw new RequestError("Image not found", 404);
    const { data, error: downloadError } = await db.storage.from(TRADE_EVIDENCE_BUCKET).download(evidence.storage_path);
    if (downloadError || !data) throw new RequestError("Saved image is unavailable", 404);
    if (variant === "thumb") {
      let thumbnail: Buffer;
      try {
        thumbnail = await evidenceThumbnail(new Uint8Array(await data.arrayBuffer()));
      } catch {
        throw new RequestError("Unable to prepare this preview. Please try again.", 503);
      }
      return new Response(new Uint8Array(thumbnail), { headers: { "Content-Type": "image/webp", ...IMAGE_HEADERS } });
    }
    return new Response(data, { headers: { "Content-Type": evidence.mime_type, ...IMAGE_HEADERS } });
  } catch (error) {
    return routeError(error);
  }
}
