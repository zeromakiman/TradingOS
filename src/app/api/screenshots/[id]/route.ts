import { z } from "zod";
import { evidenceThumbnail } from "@/lib/evidence";
import { SCREENSHOT_BUCKET } from "@/lib/screenshots";
import { RequestError, routeError, routeUser } from "@/lib/route-security";

/**
 * GET /api/screenshots/[id]: legacy (V1) setup screenshots, unchanged except for `?variant=thumb` (docs/V2_ARCHITECTURE.md
 * §7.3): a WEBP that fits inside 640×640, never enlarged. Owner-only through the user's session twice (row and storage).
 */
const IMAGE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await routeUser(request), { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new RequestError("Image not found", 404);
    const variant = new URL(request.url).searchParams.get("variant");
    if (variant !== null && variant !== "thumb") throw new RequestError("Unknown image variant");
    const { data: s, error } = await db.from("setup_screenshots").select("storage_path,mime_type").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (error) throw new RequestError("Unable to load this image. Please try again.", 503);
    if (!s) throw new RequestError("Image not found", 404);
    const { data, error: downloadError } = await db.storage.from(SCREENSHOT_BUCKET).download(s.storage_path);
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
    return new Response(data, { headers: { "Content-Type": s.mime_type, ...IMAGE_HEADERS } });
  } catch (e) {
    return routeError(e);
  }
}
