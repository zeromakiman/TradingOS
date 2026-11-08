import "server-only";
import { z } from "zod";
import { requireUser } from "./supabase/server";

/**
 * The recent-trades analysis an account is still running, whatever its sample (docs/V2_ARCHITECTURE.md §11.5). The
 * database runs one per account at a time: `start_recent_ai_analysis` refuses with 'Analysis already running' while any
 * request of the account has no result and its deadline is ahead. The Recent trades panel lists one sample's history,
 * so without this a running 20-trade analysis would leave the 30-trade button enabled, only for the request to be
 * refused. A request starts only while no other runs, so only the newest requests can be running: the few newest are
 * read with the user's session (RLS) and an explicit owner filter, then their results.
 */

const NEWEST = 5;
const requestRow = z.object({ id: z.uuid(), requested_sample: z.number().int(), deadline_at: z.string() });
const resultRow = z.object({ review_id: z.uuid() });

/** The requested sample (10, 20 or 30) of the account's running analysis, or null when none is running. */
export async function runningRecentSample(accountId: string, now: Date = new Date()): Promise<number | null> {
  const { db, user } = await requireUser();
  const requests = await db.from("recent_ai_analyses").select("id,requested_sample,deadline_at")
    .eq("account_id", z.uuid().parse(accountId)).eq("user_id", user.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(NEWEST);
  if (requests.error) throw new Error("Recent-trades analyses unavailable");
  const open = z.array(requestRow).parse(requests.data ?? []).filter(row => Date.parse(row.deadline_at) > now.getTime());
  if (open.length === 0) return null;
  const results = await db.from("recent_ai_analysis_results").select("review_id").in("review_id", open.map(row => row.id));
  if (results.error) throw new Error("Recent-trades analyses unavailable");
  const done = new Set(z.array(resultRow).parse(results.data ?? []).map(row => row.review_id));
  return open.find(row => !done.has(row.id))?.requested_sample ?? null;
}
