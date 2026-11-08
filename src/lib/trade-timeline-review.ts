import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { accountAiAvailability, serverAiLedger } from "./ai-budget";
import { trustedServer } from "./supabase/admin";
import { loadTimelineReviewSource, ownedTimelineTrade, TimelineSourceLimitError } from "./trade-timeline-review-data";
import type { AiAvailability } from "@/ai/availability";
import { operationContract } from "@/ai/operation-contract";
import { operationFor } from "@/ai/operations";
import { ProviderError } from "@/ai/provider";
import { providerKey } from "@/ai/provider-config";
import { budgetedAiRequest } from "@/ai/request-gate";
import { rpcErrorCode } from "@/ai/rpc-error";
import { downloadEvidenceImages, EvidenceSelectionError, selectEvidence } from "@/ai/trade-evidence";
import { isClosedTrade, TimelineReviewScopeError, tradeTimelineReviewContext } from "@/ai/trade-timeline-review-context";
import { type TradeTimelineReviewResult, TimelineReviewRejection, validateTradeTimelineReview } from "@/ai/trade-timeline-review-contract";

/**
 * Timeline-aware review of one closed trade (spec §11.4), mirroring the V1 trade review: owner-scoped loading, no
 * writes while AI is unavailable, an append-only request row before any reservation, evidence bytes verified before
 * the budget gate, authorization re-checked before reserve, dispatch and generation, and an append-only result.
 */

export type TimelineReviewStatus =
  | "COMPLETED" | "FAILED" | "RECORDED" | "NOT_CLOSED" | "IN_PROGRESS" | "EVIDENCE_UNAVAILABLE" | "SCOPE_LIMIT"
  | Exclude<AiAvailability["status"], "ENABLED">;

export interface TimelineReviewOutcome {
  status: TimelineReviewStatus;
  message: string;
}

const OPERATION = "REVIEW_TRADE_TIMELINE";

const COPY = {
  NOT_CLOSED: "Close the trade before requesting an AI review.",
  IN_PROGRESS: "An AI review of this trade is already running. Its result will appear in the history.",
  EVIDENCE_UNAVAILABLE: "A selected screenshot is no longer available for this trade. Refresh and select again. Nothing was sent.",
  RECORDED: "This request was already recorded. No additional provider request was made.",
  COMPLETED: "Trade review saved. Your trade records are unchanged.",
  FAILED: "The review failed and the attempt was kept in the history. Check its details before requesting another review.",
  START_FAILED: "Unable to start the review. Refresh to check the trade and existing attempts.",
  FINISH_FAILED: "The review could not finish saving. Refresh the history before requesting another review; no automatic retry was made.",
} as const;

/** Start errors that leave nothing written and map to a state the page can explain. */
function startOutcome(code: string | null): TimelineReviewOutcome | null {
  if (code === "NOT_CLOSED") return { status: "NOT_CLOSED", message: COPY.NOT_CLOSED };
  if (code === "REVIEW_IN_PROGRESS") return { status: "IN_PROGRESS", message: COPY.IN_PROGRESS };
  if (code === "EVIDENCE_CHANGED" || code === "EVIDENCE_LIMIT") return { status: "EVIDENCE_UNAVAILABLE", message: COPY.EVIDENCE_UNAVAILABLE };
  return null;
}

function failureCode(error: unknown, raw: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof TimelineReviewRejection) return error.code;
  return raw !== null ? "INVALID_REVIEW_OUTPUT" : "REVIEW_FAILED";
}

export async function reviewTradeTimeline(tradeId: string, requestId: string, selectedIds: readonly string[]): Promise<TimelineReviewOutcome> {
  const operation = operationFor(OPERATION);
  z.uuid().parse(requestId);
  z.array(z.uuid()).max(operation.maxImages).parse(selectedIds);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Duplicate evidence selection");
  const owned = await ownedTimelineTrade(tradeId);
  const { db, user, trade } = owned;
  if (!isClosedTrade(trade)) return { status: "NOT_CLOSED", message: COPY.NOT_CLOSED };
  const availability = await accountAiAvailability(trade.account_id, OPERATION);
  if (availability.status !== "ENABLED") return { status: availability.status, message: availability.message };

  let facts: ReturnType<typeof tradeTimelineReviewContext>;
  let selected: ReturnType<typeof selectEvidence>;
  try {
    const source = await loadTimelineReviewSource(owned);
    selected = selectEvidence(source.evidence, selectedIds);
    facts = tradeTimelineReviewContext({
      ...source.input,
      evidence: selected.map(item => ({
        id: item.id, label: item.label, timeframe: item.timeframe, storedPhase: item.storedPhase, recordedAt: item.recordedAt,
        sha256: item.sha256, mimeType: item.mimeType, byteSize: item.byteSize,
      })),
    });
  } catch (error) {
    if (error instanceof EvidenceSelectionError) return { status: "EVIDENCE_UNAVAILABLE", message: COPY.EVIDENCE_UNAVAILABLE };
    if (error instanceof TimelineReviewScopeError || error instanceof TimelineSourceLimitError) return { status: "SCOPE_LIMIT", message: error.message };
    throw error;
  }

  const contract = operationContract(operation, facts);
  const admin = trustedServer();
  const start = await admin.rpc("start_trade_timeline_review", {
    p_id: requestId, p_user_id: user.id, p_trade_id: trade.id, p_facts: facts,
    p_hash: createHash("sha256").update(JSON.stringify(facts)).digest("hex"), p_operation: operation, p_contract: contract,
  });
  if (start.error) {
    const known = startOutcome(rpcErrorCode(start.error));
    if (known) return known;
    throw new Error(COPY.START_FAILED);
  }
  if (start.data !== true) return { status: "RECORDED", message: COPY.RECORDED };

  let reservationId: string | null = null;
  let raw: unknown = null;
  let interpretation: TradeTimelineReviewResult | null = null;
  let errorCode: string | null = null;
  const authorize = async () => {
    const { error } = await admin.rpc("authorize_trade_timeline_review", { p_id: requestId, p_user_id: user.id });
    if (error) throw new ProviderError("TRADE_OR_EVIDENCE_CHANGED");
  };
  try {
    // Bytes are verified against the registered rows before any reservation exists.
    const images = await downloadEvidenceImages(db, selected);
    const ledger = serverAiLedger();
    const result = await budgetedAiRequest(
      {
        apiKey: providerKey(operation.provider),
        config: { model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens, imageDetail: operation.imageDetail, deepEnabled: false },
        context: facts, images, prior: [],
      },
      { userId: user.id, accountId: trade.account_id, operationId: requestId, stage: "A", operation: operation.id },
      {
        ...ledger,
        reserve: async record => { await authorize(); await ledger.reserve(record); reservationId = record.id; },
        dispatch: async (...args) => { await authorize(); await ledger.dispatch(...args); },
        recheck: async (...args) => { await authorize(); await ledger.recheck(...args); },
      },
    );
    raw = result.output;
    interpretation = validateTradeTimelineReview(raw, facts);
  } catch (error) {
    errorCode = failureCode(error, raw);
  }
  const finish = await admin.rpc("finish_trade_timeline_review", {
    p_id: requestId, p_user_id: user.id, p_status: interpretation ? "COMPLETED" : "FAILED", p_interpretation: interpretation,
    p_error: errorCode, p_raw: raw, p_reservation_id: reservationId,
  });
  if (finish.error) throw new Error(COPY.FINISH_FAILED);
  return interpretation ? { status: "COMPLETED", message: COPY.COMPLETED } : { status: "FAILED", message: COPY.FAILED };
}
