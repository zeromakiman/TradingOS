import "server-only";
import { currentSession } from "@/lib/account-context";
import { type ExternalExecution, type LinkCandidate, listLinkCandidates, listLinkedExecutions, listUnmatchedExecutions } from "@/lib/sync-service";

/**
 * Platform executions of one account for Manage → Connection (spec §8.6): the executions waiting for the trader to
 * link them to a planned trade (with the trades they may belong to, suggested ones first) and the executions already
 * linked (which the trader may unlink, except positions imported as trades). Read with the trader's RLS session
 * through src/lib/sync-service.ts.
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
  /** The most recent linked executions (at most LINKED_LIMIT), newest entry first. */
  linked: ExternalExecution[];
  /** Set when more linked executions exist than are listed. */
  moreLinked?: boolean;
}

export async function loadConnectionDetails(accountId: string): Promise<ConnectionDetails> {
  const { db } = await currentSession();
  const [unmatched, linked] = await Promise.all([
    listUnmatchedExecutions(db, { accountId, limit: UNMATCHED_SHOWN + 1 }),
    listLinkedExecutions(db, { accountId, limit: LINKED_LIMIT + 1 }),
  ]);
  const shown = unmatched.slice(0, UNMATCHED_SHOWN);
  const views = await Promise.all(shown.map(async execution => ({ execution, candidates: (await listLinkCandidates(db, execution)).slice(0, CANDIDATES_SHOWN) })));
  return {
    unmatched: views,
    moreUnmatched: unmatched.length > UNMATCHED_SHOWN,
    linked: linked.slice(0, LINKED_LIMIT),
    moreLinked: linked.length > LINKED_LIMIT,
  };
}
