import { z } from "zod";
import { boundedBody, RequestError } from "@/lib/route-security";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * POST /api/perf: the shell's timing beacon (src/components/shell/perf-beacon.tsx) for signed-in pages. It only writes
 * one `tos-perf-client` log line of timings and counts; nothing is stored. The session is verified from its JWT
 * (`getClaims`), so a report never adds a call to Supabase Auth while the signing key is asymmetric.
 */
export const runtime = "nodejs";

const LIMIT = 2048;
const ms = z.number().int().min(0).max(600_000);
const count = z.number().int().min(0).max(1000);
const Report = z.strictObject({
  type: z.enum(["load", "nav"]),
  route: z.string().regex(/^\/[A-Za-z0-9/_:.-]{0,95}$/),
  navMs: ms.optional(),
  ttfbMs: ms.optional(),
  fcpMs: ms.optional(),
  lcpMs: ms.optional(),
  rsc: count,
  rscMs: z.array(ms).max(8),
  actions: count,
  clicks: count,
  refreshes: count,
  persists: count,
});

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    if (origin !== null && origin !== `${url.protocol}//${request.headers.get("host") ?? url.host}`) throw new RequestError("Same-origin request required", 403);
    const db = await supabaseServer();
    const { data, error } = await db.auth.getClaims();
    if (error || !data?.claims) throw new RequestError("Sign in required", 401);
    let body: unknown;
    try {
      body = JSON.parse((await boundedBody(request, LIMIT)).toString("utf8"));
    } catch (failure) {
      if (failure instanceof RequestError) throw failure;
      throw new RequestError("Invalid report");
    }
    const report = Report.safeParse(body);
    if (!report.success) throw new RequestError("Invalid report");
    console.info(JSON.stringify({ event: "tos-perf-client", region: process.env.VERCEL_REGION ?? "local", ...report.data }));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 400;
    return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  }
}
