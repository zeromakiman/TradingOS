import { cookies } from "next/headers";
import { ACCOUNT_COOKIE } from "@/lib/account-context";
import { routeError, routeUser } from "@/lib/route-security";
import { closedTradesExport } from "./load";

// EDGE's closed-trades CSV (docs/V2_ARCHITECTURE.md §1.2, §14.6; contract in ./contract.ts): read-only, so no
// same-origin check; the user's own session is the only client used, and signed-out requests get a JSON 401.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  try {
    const { db, user } = await routeUser(request);
    // Without an explicit `account`, the file follows the request's account context (the `tos_account` cookie).
    const context = (await cookies()).get(ACCOUNT_COOKIE)?.value;
    const file = await closedTradesExport(db, user.id, new URL(request.url).searchParams, context, new Date().toISOString());
    return new Response(file.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
