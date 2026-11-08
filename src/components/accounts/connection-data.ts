import "server-only";
import type { Lifecycle } from "@/domain/ledger";
import { currentSession } from "@/lib/account-context";
import {
  type ExternalExecution, type LinkCandidate, linkCandidatesFor, listLinkedExecutions, listUnmatchedExecutions, loadLinkablePlans, loadTradeLifecycles,
} from "@/lib/sync-service";

/**
 * Platform executions of one account for Manage → Connection (spec §8.6): the executions waiting for the trader to
 * link them to a planned trade (with the trades they may belong to, suggested ones first) and the executions already
 * linked (which the trader may unlink, except positions imported as trades). Read with the trader's RLS session
 * through src/lib/sync-service.ts: one read per list, the account's linkable plans once for every waiting execution (never
 * one read per execution), and, when planned trades are among the listed links, their lifecycles in one read.
 */

export const LINKED_LIMIT = 50;
const UNMATCHED_SHOWN = 25;
const CANDIDATES_SHOWN = 20;

export interface UnmatchedExecutionView {
  execution: ExternalExecution;
  candidates: LinkCandidate[];
}

/**
 * Why a linked planned trade does not carry its platform position's result (V2_1_GAPS.md §1.2): the platform closed the
 * position but the trade is still open in Trading OS, or the plan was marked skipped or cancelled.
 */
export type LinkedTradeNote = "CLOSE_NOT_RECORDED" | "SKIPPED" | "CANCELLED";

export interface ConnectionDetails {
  unmatched: UnmatchedExecutionView[];
  /** More unmatched executions exist than are listed. */
  moreUnmatched: boolean;
  /** The most recent linked executions (at most LINKED_LIMIT), newest entry first. */
  linked: ExternalExecution[];
  /** Set when more linked executions exist than are listed. */
  moreLinked?: boolean;
  /** Execution id → note, for listed executions linked to a planned trade that does not carry their result. */
  linkedNotes?: Readonly<Record<string, LinkedTradeNote>>;
}

const OPEN: ReadonlySet<Lifecycle> = new Set(["LOCKED", "LIVE"]);

function linkedNote(execution: ExternalExecution, lifecycle: Lifecycle | undefined): LinkedTradeNote | null {
  if (lifecycle === "SKIPPED" || lifecycle === "CANCELLED") return lifecycle;
  return lifecycle !== undefined && OPEN.has(lifecycle) && execution.exitedAt !== null ? "CLOSE_NOT_RECORDED" : null;
}

export async function loadConnectionDetails(accountId: string): Promise<ConnectionDetails> {
  const { db } = await currentSession();
  const [unmatched, linked] = await Promise.all([
    listUnmatchedExecutions(db, { accountId, limit: UNMATCHED_SHOWN + 1 }),
    listLinkedExecutions(db, { accountId, limit: LINKED_LIMIT + 1 }),
  ]);
  const shown = unmatched.slice(0, UNMATCHED_SHOWN);
  const listed = linked.slice(0, LINKED_LIMIT);
  // Planned links (automatic or the trader's); an imported trade is closed from its own platform close.
  const planned = listed.flatMap(execution =>
    execution.linkMethod !== "IMPORT_CREATED" && execution.linkedTradeId !== null ? [{ execution, tradeId: execution.linkedTradeId }] : []);
  const [plans, lifecycles] = await Promise.all([
    shown.length ? loadLinkablePlans(db, accountId) : [],
    planned.length ? loadTradeLifecycles(db, planned.map(link => link.tradeId)) : new Map<string, Lifecycle>(),
  ]);
  const linkedNotes: Record<string, LinkedTradeNote> = {};
  for (const { execution, tradeId } of planned) {
    const note = linkedNote(execution, lifecycles.get(tradeId));
    if (note !== null) linkedNotes[execution.id] = note;
  }
  return {
    unmatched: shown.map(execution => ({ execution, candidates: linkCandidatesFor(execution, plans).slice(0, CANDIDATES_SHOWN) })),
    moreUnmatched: unmatched.length > UNMATCHED_SHOWN,
    linked: listed,
    moreLinked: linked.length > LINKED_LIMIT,
    linkedNotes,
  };
}
