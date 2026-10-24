import "server-only";
import { z } from "zod";
import { currentSession } from "@/lib/account-context";
import { type ExternalExecution, type LinkCandidate, listLinkCandidates, listUnmatchedExecutions, loadExecution } from "@/lib/sync-service";

/**
 * Platform executions of one account for Manage → Connection (spec §8.6): the executions waiting for the trader to
 * link them to a planned trade (with the trades they may belong to, suggested ones first) and the executions already
 * linked (which the trader may unlink). Read with the trader's RLS session through src/lib/sync-service.ts.
 */

export const LINKED_LIMIT = 50;
const UNMATCHED_SHOWN = 25;
const CANDIDATES_SHOWN = 20;

export interface UnmatchedExecutionView {
  execution: ExternalExecution;
  candidates: LinkCandidate[];
}

export interface ConnectionDetails {
  unmatched: UnmatchedExecutionView[];
  /** More unmatched executions exist than are listed. */
  moreUnmatched: boolean;
  linked: ExternalExecution[];
}

export async function loadConnectionDetails(accountId: string): Promise<ConnectionDetails> {
  const { db } = await currentSession();
  const [unmatched, linkedIds] = await Promise.all([
    listUnmatchedExecutions(db, { accountId, limit: UNMATCHED_SHOWN + 1 }),
    db.from("external_execution_status").select("id").eq("account_id", accountId).not("linked_trade_id", "is", null)
      .order("entered_at", { ascending: false }).order("id", { ascending: true }).limit(LINKED_LIMIT),
  ]);
  if (linkedIds.error) throw new Error("Platform executions are unavailable.");
  const ids = z.array(z.object({ id: z.uuid() })).parse(linkedIds.data ?? []).map(row => row.id);
  const shown = unmatched.slice(0, UNMATCHED_SHOWN);
  const [views, linked] = await Promise.all([
    Promise.all(shown.map(async execution => ({ execution, candidates: (await listLinkCandidates(db, execution)).slice(0, CANDIDATES_SHOWN) }))),
    Promise.all(ids.map(id => loadExecution(db, id))),
  ]);
  return {
    unmatched: views,
    moreUnmatched: unmatched.length > UNMATCHED_SHOWN,
    linked: linked.filter((execution): execution is ExternalExecution => execution !== null && execution.linkedTradeId !== null),
  };
}
