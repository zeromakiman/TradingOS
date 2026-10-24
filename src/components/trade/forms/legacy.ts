import "server-only";
import { z } from "zod";
import { currentSession } from "@/lib/account-context";
import { getSchemaStatus } from "@/lib/schema-gate";

/**
 * Legacy V1 setup links (docs/V2_ARCHITECTURE.md §1.2): `/analyze/[id]` named a V1 setup proposal. Every proposal is a
 * revision of exactly one V2 trade (`trade_revisions`, backfilled by 0015), so the link resolves to that trade's page.
 * Read with the user's session (RLS) plus an explicit owner filter: a proposal of another user resolves to nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revisionRow = z.object({ trade_id: z.uuid() });

export type LegacyProposalTarget =
  | { kind: "trade"; tradeId: string }
  /** The database lacks the 2.0 schema: the app's own pages explain it. */
  | { kind: "schema-outdated" }
  | { kind: "not-found" };

/** Where a V1 setup proposal link leads now. */
export async function legacyProposalTarget(proposalId: string): Promise<LegacyProposalTarget> {
  const id = proposalId.trim().toLowerCase();
  if (!UUID.test(id)) return { kind: "not-found" };
  if (!(await getSchemaStatus()).ready) return { kind: "schema-outdated" };
  const { db, user } = await currentSession();
  const { data, error } = await db.from("trade_revisions").select("trade_id").eq("proposal_id", id).eq("user_id", user.id).maybeSingle();
  if (error) throw new Error("Draft revisions are unavailable.");
  return data ? { kind: "trade", tradeId: revisionRow.parse(data).trade_id } : { kind: "not-found" };
}

/** `?a=1&b=2` of a page's search params (repeated keys kept in order), or an empty string. */
export function queryString(params: Readonly<Record<string, string | readonly string[] | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) search.append(key, item);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
