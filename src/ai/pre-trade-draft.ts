import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { accountAiAvailability, serverAiLedger } from "@/lib/ai-budget";
import {
  aiCostEstimate, aiRequestRow, historyRow, loadAccounting, loadResults, type PreTradeHistoryRow, type ResolvedAiCard, resolvedCard, revisionMarker,
} from "@/lib/ai-history";
import { loadSetup } from "@/lib/setup-data";
import { trustedServer } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/server";
import type { AiCostEstimate, EvidenceIndex } from "@/domain/ai-summary";
import { LEDGER_COLUMNS, type LedgerTrade, ledgerRow } from "@/domain/ledger";
import type { AiAvailability } from "./availability";
import type { BiasContextSource } from "./bias-challenge-context";
import { type CitationOperation, operationAllowedSources } from "./citation-sources";
import { operationContract } from "./operation-contract";
import { operationFor } from "./operations";
import { ProviderError } from "./provider";
import { providerKey } from "./provider-config";
import { estimateRequest } from "./request-estimate";
import { budgetedAiRequest } from "./request-gate";
import { rpcErrorCode, rpcErrorMessage } from "./rpc-error";
import { type AiEvidence, downloadEvidenceImages, EvidenceSelectionError, loadTradeEvidence, reviewEvidence, selectEvidence, type UserDb } from "./trade-evidence";
import type { ReviewEvidence } from "./trade-review-context";

/**
 * Pre-trade AI (Analyze Setup, Challenge My Bias) on V2 drafts (spec §8.3, §11.3). The request always targets the
 * latest draft revision, resolved on the server; selectable evidence is the trade's V2 evidence (pre-entry by
 * construction: a draft has no execution) plus legacy screenshots of that revision's proposal. Storage, SQL
 * authorization and accounting follow the V1 pipeline: start (append-only), verified evidence bytes, authorize before
 * reserve/dispatch/generation, validate, finish (append-only).
 */

export type PreTradeOperation = Extract<CitationOperation, "ANALYZE_SETUP" | "CHALLENGE_BIAS">;
export type DraftState = "OPEN" | "NOT_PLANNED" | "LOCKED" | "NOT_DRAFT";
export type PreTradeStatus =
  | "COMPLETED" | "FAILED" | "RECORDED" | Exclude<DraftState, "OPEN"> | "DRAFT_CHANGED" | "EVIDENCE_UNAVAILABLE" | "SCOPE_LIMIT" | "IN_PROGRESS"
  | Exclude<AiAvailability["status"], "ENABLED">;

export interface PreTradeOutcome {
  status: PreTradeStatus;
  message: string;
}

/** Bounded facts size of the pre-trade operations: 4 × the 16,000-token input limit, so the facts alone always fit. */
export const PRE_TRADE_FACTS_BYTES = 64_000;
/** Copy when the draft and its selected screenshots would not fit the operation's input limit as one request. */
export const PRE_TRADE_TOO_LARGE = "This draft and the selected screenshots are too large to analyse in one request. Select fewer screenshots or shorten the thesis. Nothing was sent.";
/** A screenshot whose pixel size is not read yet: the estimate prices it at the tile-formula maximum. */
const UNSIZED_IMAGE = "data:image/png;base64,AA==";

const STATE_COPY: Readonly<Record<Exclude<DraftState, "OPEN">, string>> = {
  NOT_PLANNED: "Pre-trade AI tools work on planned drafts. No pre-trade plan was recorded before execution.",
  LOCKED: "This plan is already locked. Earlier analyses remain available as advisory history.",
  NOT_DRAFT: "This draft is no longer open. Earlier analyses remain available as advisory history.",
};
const DRAFT_CHANGED = "The draft changed since this page was loaded. Refresh to review the current revision; nothing was sent.";
const EVIDENCE_UNAVAILABLE = "A selected screenshot is no longer available for this draft. Refresh and select again. Nothing was sent.";
const IN_PROGRESS = "Another AI request for this draft is still running. Its result will appear in the history.";
const RECORDED = "This request was already recorded. No additional provider request was made.";

/** Whether pre-trade AI can run on this trade, from the ledger row (spec §2.2). */
export function draftState(trade: Pick<LedgerTrade, "origin" | "lifecycle" | "plan_id">): DraftState {
  if (trade.origin !== "PLANNED") return "NOT_PLANNED";
  if (trade.lifecycle === "DRAFT") return "OPEN";
  return trade.plan_id !== null ? "LOCKED" : "NOT_DRAFT";
}

export interface TradeDraft {
  db: UserDb;
  userId: string;
  trade: LedgerTrade;
}

/** The caller's trade, read with the user's session and an explicit owner filter; throws for any other trade. */
export async function loadTradeDraft(tradeId: string): Promise<TradeDraft> {
  const { db, user } = await requireUser();
  const id = z.uuid().parse(tradeId);
  const owned = await db.from("trades").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (owned.error || !owned.data) throw new Error("Trade unavailable");
  const ledger = await db.from("trade_ledger").select(LEDGER_COLUMNS.join(",")).eq("id", id).maybeSingle();
  if (ledger.error || !ledger.data) throw new Error("Trade unavailable");
  return { db, userId: user.id, trade: ledgerRow.parse(ledger.data) };
}

/** Evidence a pre-trade request may select: active pre-entry V2 evidence and the latest revision's legacy screenshots. */
export async function draftEvidence(draft: TradeDraft, proposalId: string): Promise<AiEvidence[]> {
  const evidence = await loadTradeEvidence(draft.db, { userId: draft.userId, tradeId: draft.trade.id, proposalIds: [proposalId] });
  return evidence.filter(item => item.source === "LEGACY_SCREENSHOT" ? item.proposalId === proposalId : item.storedPhase === "PRE_ENTRY");
}

/** Operation-specific parts of a pre-trade request; the pipeline itself is shared. */
export interface PreTradeOperationConfig<T> {
  operation: PreTradeOperation;
  context: (source: BiasContextSource, evidence: ReviewEvidence[]) => object;
  validate: (raw: unknown, sourceRefs: string[], hasEvidence: boolean) => T;
  /** Stored error codes, as in the V1 operations. */
  invalidOutputCode: string;
  failureCode: string;
  copy: { completed: string; failed: string; startFailed: string; finishFailed: string };
}

/** Start errors that leave nothing written and map to a state the page can explain. */
function startOutcome(error: { message?: unknown }): PreTradeOutcome | null {
  const code = rpcErrorCode(error);
  const message = rpcErrorMessage(error);
  if (code === "NOT_LATEST_REVISION") return { status: "DRAFT_CHANGED", message: DRAFT_CHANGED };
  if (code === "PLAN_LOCKED" || message === "Plan already locked") return { status: "LOCKED", message: STATE_COPY.LOCKED };
  if (code === "DRAFT_DISCARDED" || code === "NOT_A_DRAFT") return { status: "NOT_DRAFT", message: STATE_COPY.NOT_DRAFT };
  if (message === "Challenge already running") return { status: "IN_PROGRESS", message: IN_PROGRESS };
  return null;
}

/**
 * Runs one pre-trade request for the latest revision of a draft. `expectedRevision` (the revision the page showed)
 * refuses the request when the draft changed in the meantime. Nothing is written while the trade is not an open
 * planned draft, AI is unavailable or the selection is invalid.
 */
export async function runDraftRequest<T>(
  config: PreTradeOperationConfig<T>, tradeId: string, requestId: string, evidenceIds: readonly string[], expectedRevision?: number,
): Promise<PreTradeOutcome> {
  const operation = operationFor(config.operation);
  z.uuid().parse(requestId);
  z.array(z.uuid()).max(operation.maxImages).parse(evidenceIds);
  if (expectedRevision !== undefined) z.number().int().positive().parse(expectedRevision);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Duplicate evidence selection");
  const draft = await loadTradeDraft(tradeId);
  const { trade } = draft;
  const state = draftState(trade);
  if (state !== "OPEN") return { status: state, message: STATE_COPY[state] };
  if (trade.latest_proposal_id === null || trade.latest_revision === null) return { status: "NOT_DRAFT", message: STATE_COPY.NOT_DRAFT };
  if (expectedRevision !== undefined && expectedRevision !== trade.latest_revision) return { status: "DRAFT_CHANGED", message: DRAFT_CHANGED };
  const availability = await accountAiAvailability(trade.account_id, operation.id);
  if (availability.status !== "ENABLED") return { status: availability.status, message: availability.message };

  const setup = await loadSetup(trade.latest_proposal_id);
  if (setup.lock) return { status: "LOCKED", message: STATE_COPY.LOCKED };
  let selected: AiEvidence[];
  try {
    selected = selectEvidence(await draftEvidence(draft, setup.proposal.id), evidenceIds);
  } catch (error) {
    if (error instanceof EvidenceSelectionError) return { status: "EVIDENCE_UNAVAILABLE", message: EVIDENCE_UNAVAILABLE };
    throw error;
  }
  const facts = config.context(setup, selected.map(reviewEvidence));
  if (Buffer.byteLength(JSON.stringify(facts)) > PRE_TRADE_FACTS_BYTES) {
    return { status: "SCOPE_LIMIT", message: "This draft exceeds the bounded analysis size. Nothing was sent." };
  }
  // The whole request (prompt, facts, response schema and every selected screenshot at its maximum tile cost) is
  // checked before anything is written; the gate checks it again with the downloaded screenshots before reserving.
  const placeholders = selected.map(item => ({ sourceId: `evidence:${item.id}`, role: item.role, dataUrl: UNSIZED_IMAGE }));
  if (estimateRequest(operation, { context: facts, images: placeholders, prior: [] }).tokens > operation.maxInputTokens) {
    return { status: "SCOPE_LIMIT", message: PRE_TRADE_TOO_LARGE };
  }
  const admin = trustedServer();
  const start = await admin.rpc("start_bias_challenge", {
    p_id: requestId, p_user_id: draft.userId, p_proposal_id: setup.proposal.id, p_facts: facts,
    p_hash: createHash("sha256").update(JSON.stringify(facts)).digest("hex"), p_operation: operation, p_contract: operationContract(operation, facts),
  });
  if (start.error) {
    const known = startOutcome(start.error);
    if (known) return known;
    throw new Error(config.copy.startFailed);
  }
  if (start.data !== true) return { status: "RECORDED", message: RECORDED };

  let reservationId: string | null = null;
  let raw: unknown = null;
  let interpretation: T | null = null;
  let errorCode: string | null = null;
  const authorize = async () => {
    const { error } = await admin.rpc("authorize_bias_challenge", { p_id: requestId, p_user_id: draft.userId });
    if (error) throw new ProviderError("PROPOSAL_OR_EVIDENCE_CHANGED");
  };
  try {
    // Bytes are verified against the registered rows before any reservation exists.
    const images = await downloadEvidenceImages(draft.db, selected);
    const ledger = serverAiLedger();
    const result = await budgetedAiRequest(
      {
        apiKey: providerKey(operation.provider),
        config: { model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens, imageDetail: operation.imageDetail, deepEnabled: false },
        context: facts, images, prior: [],
      },
      { userId: draft.userId, accountId: trade.account_id, operationId: requestId, stage: "A", operation: operation.id },
      {
        ...ledger,
        reserve: async record => { await authorize(); await ledger.reserve(record); reservationId = record.id; },
        dispatch: async (...args) => { await authorize(); await ledger.dispatch(...args); },
        recheck: async (...args) => { await authorize(); await ledger.recheck(...args); },
      },
    );
    raw = result.output;
    interpretation = config.validate(raw, operationAllowedSources(config.operation, facts), selected.length > 0);
  } catch (error) {
    errorCode = error instanceof ProviderError ? error.code : raw !== null ? config.invalidOutputCode : config.failureCode;
  }
  const finish = await admin.rpc("finish_bias_challenge", {
    p_id: requestId, p_user_id: draft.userId, p_status: interpretation ? "COMPLETED" : "FAILED", p_interpretation: interpretation,
    p_error: errorCode, p_raw: raw, p_reservation_id: reservationId,
  });
  if (finish.error) throw new Error(config.copy.finishFailed);
  return interpretation ? { status: "COMPLETED", message: config.copy.completed } : { status: "FAILED", message: config.copy.failed };
}

// ---------------------------------------------------------------------------------------------
// Panel data
// ---------------------------------------------------------------------------------------------

export interface PreTradeEvidenceOption {
  id: string;
  source: AiEvidence["source"];
  label: AiEvidence["label"];
  timeframe: string | null;
  caption: string | null;
  recordedAt: string;
}

export interface PreTradeHistoryEntry extends PreTradeHistoryRow {
  /** Concise card with friendly source chips (completed rows only). */
  card: ResolvedAiCard | null;
}

export interface PreTradePanel {
  operation: PreTradeOperation;
  state: DraftState;
  /** Why the tool cannot run on this trade; null for an open draft. */
  stateMessage: string | null;
  /** Latest draft revision (the one a new request analyses); null for trades without revisions. */
  revision: number | null;
  /** Latest deterministic check of that revision: the Risk Engine line that leads every pre-trade card. */
  riskDecision: "APPROVED" | "BLOCKED" | null;
  availability: AiAvailability;
  estimate: AiCostEstimate | null;
  maxEvidence: number;
  evidence: PreTradeEvidenceOption[];
  /** This operation's requests across every revision, newest first, with the stale-revision marker. */
  history: PreTradeHistoryEntry[];
  page: number;
  hasOlder: boolean;
  error: string | null;
}

const PAGE_SIZE = 10;
const requestRow = aiRequestRow.extend({ facts: z.record(z.string(), z.unknown()), proposal_id: z.uuid() });

/** Availability, selectable evidence and paginated history of one pre-trade operation. Never reaches the provider. */
export async function loadDraftPanel(operationId: PreTradeOperation, tradeId: string, page = 0): Promise<PreTradePanel> {
  const draft = await loadTradeDraft(tradeId);
  const { db, userId, trade } = draft;
  const operation = operationFor(operationId);
  const state = draftState(trade);
  const safePage = Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 10_000) : 0;
  const base = {
    operation: operationId, state, stateMessage: state === "OPEN" ? null : STATE_COPY[state], revision: trade.latest_revision,
    riskDecision: trade.latest_check_decision, maxEvidence: operation.maxImages, page: safePage,
  };
  try {
    const availability = await accountAiAvailability(trade.account_id, operationId);
    const revisions = await db.from("trade_revisions").select("proposal_id,revision").eq("trade_id", trade.id).eq("user_id", userId).order("revision");
    if (revisions.error) throw new Error("Draft revisions unavailable");
    const revisionRows = z.array(z.object({ proposal_id: z.uuid(), revision: z.number().int().positive() })).parse(revisions.data);
    const revisionOf = new Map(revisionRows.map(row => [row.proposal_id, row.revision] as const));
    const latestRevision = revisionRows.at(-1)?.revision ?? null;
    const evidence = state === "OPEN" && trade.latest_proposal_id ? await draftEvidence(draft, trade.latest_proposal_id) : [];
    const q = revisionRows.length
      ? await db.from("bias_challenges").select("id,facts,operation,created_at,deadline_at,proposal_id", { count: "exact" })
        .eq("operation->>id", operationId).in("proposal_id", revisionRows.map(row => row.proposal_id)).eq("user_id", userId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).range(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE - 1)
      : { data: [], error: null, count: 0 };
    if (q.error) throw new Error("Analysis history unavailable");
    const requests = z.array(requestRow).parse(q.data);
    const [results, accounting] = await Promise.all([
      loadResults(db, "bias_challenge_results", "challenge_id", requests),
      loadAccounting(db, userId, requests.map(row => row.id)),
    ]);
    const evidenceIndex: EvidenceIndex = Object.fromEntries(evidence.map(item => [item.id, { label: item.label, timeframe: item.timeframe }]));
    const history: PreTradeHistoryEntry[] = requests.flatMap(request => {
      const revision = revisionOf.get(request.proposal_id);
      if (revision === undefined || latestRevision === null) return [];
      const result = results.get(request.id) ?? null;
      const row = historyRow(operationId, request, result, accounting);
      return [{ ...row, revision: revisionMarker(revision, latestRevision), card: resolvedCard(row, result?.interpretation, request.facts, evidenceIndex) }];
    });
    return {
      ...base, availability, estimate: aiCostEstimate(operationId), history, hasOlder: (q.count ?? 0) > (safePage + 1) * PAGE_SIZE, error: null,
      evidence: evidence.map(item => ({ id: item.id, source: item.source, label: item.label, timeframe: item.timeframe, caption: item.caption, recordedAt: item.recordedAt })),
    };
  } catch {
    return {
      ...base, estimate: null, evidence: [], history: [], hasOlder: false,
      availability: { status: "CONFIGURATION_ERROR", message: "Pre-trade AI is unavailable. Deterministic workflows remain available.", deepEnabled: false },
      error: "Unable to load AI history or configuration. Draft records are unaffected.",
    };
  }
}
