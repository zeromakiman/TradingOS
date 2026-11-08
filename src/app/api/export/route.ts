import { exportResponse } from "@/lib/export";
import { routeError, routeUser } from "@/lib/route-security";

// Export my data (docs/V2_ARCHITECTURE.md §10.5): read-only, so no same-origin check; the user's own session is the
// only client used. Large parts read many keyset pages.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  try {
    const { db, user } = await routeUser(request);
    return await exportResponse(db, user, new URL(request.url).searchParams);
  } catch (error) {
    return routeError(error);
  }
}
