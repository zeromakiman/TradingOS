"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import type { AiActionState } from "@/app/actions/ai";
import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { type ToastOptions, useOptionalToast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { type AiEstimateModel, type AiOperationId, dataToken, estimateLabel, estimateTooltip, PRICING_UNAVAILABLE } from "./model";

/**
 * Paid AI button (docs/V2_ARCHITECTURE.md §8.3, §11.2): "Analyze setup · ≈ €0.02". It sends nothing until it is
 * clicked (never on page load, never on Enter in another form), shows a pending state, and reports the result with a
 * toast and a router refresh. When the Risk Engine blocked the draft it renders as a secondary button labelled
 * "Analyze blocked setup anyway · ≈ €0.02". The request key is idempotent: replaying it never makes another provider
 * call, so it rotates only after a terminal outcome.
 */

export type { AiActionState } from "@/app/actions/ai";

/** A V2 AI server action (src/app/actions/ai.ts). */
export type AiRequestAction = (state: AiActionState, form: FormData) => Promise<AiActionState>;

export interface AiActionButtonProps {
  operation: AiOperationId;
  /** Button text without the estimate, for example "Analyze setup". */
  label: string;
  action: AiRequestAction;
  /** Form fields the action expects, for example `{ tradeId, revision }` or `{ accountId, week }`. */
  payload: Readonly<Record<string, string | readonly string[]>>;
  /** Client-generated UUID that becomes the request id. */
  requestKey: string;
  /** Pre-formatted estimate; null while pricing is unavailable, which keeps the button disabled. */
  estimate: AiEstimateModel | null;
  available: boolean;
  /**
   * Why the button cannot run, shown under it (and linked to it for screen readers). An empty string shows nothing
   * under the button; pass `describedBy` to link a reason shown elsewhere instead.
   */
  unavailableReason?: string;
  /** Id of an element outside the button that describes it, for example one reason shared by several buttons. */
  describedBy?: string;
  /** Secondary styling (the trade page's AI tools are never its primary action). */
  secondary?: boolean;
  /** Replaces `label` when the Risk Engine blocked the draft, for example "Analyze blocked setup anyway"; implies secondary. */
  blockedLabel?: string;
  /** Screenshots selected for this request (sent as repeated `evidence` fields). */
  selectedEvidenceIds?: readonly string[];
  className?: string;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "RECORDED"]);

const PENDING_LABELS: Readonly<Record<AiOperationId, string>> = {
  ANALYZE_SETUP: "Analyzing setup…",
  CHALLENGE_BIAS: "Challenging your thesis…",
  REVIEW_TRADE: "Reviewing trade…",
  REVIEW_TRADE_TIMELINE: "Reviewing trade…",
  WEEKLY_REVIEW: "Reviewing week…",
  RECENT_TRADES_ANALYSIS: "Analyzing recent trades…",
  MONTHLY_REVIEW: "Reviewing month…",
};

const RESULT_NAMES: Readonly<Record<AiOperationId, string>> = {
  ANALYZE_SETUP: "Setup analysis",
  CHALLENGE_BIAS: "Bias challenge",
  REVIEW_TRADE: "Trade review",
  REVIEW_TRADE_TIMELINE: "Trade review",
  WEEKLY_REVIEW: "Weekly review",
  RECENT_TRADES_ANALYSIS: "Recent-trades analysis",
  MONTHLY_REVIEW: "Monthly review",
};

const UNREACHABLE = "The request could not be confirmed. Refresh to check the history before trying again; a repeated request is never charged twice.";

/** Toast for an action result: terminal outcomes and refusals are worded differently. */
export function aiResultToast(operation: AiOperationId, result: AiActionState): ToastOptions {
  const name = RESULT_NAMES[operation];
  if (result.status === "COMPLETED") return { tone: "positive", title: `${name} ready`, description: result.success };
  if (result.status === "FAILED") return { tone: "warning", title: `${name} failed`, description: result.success ?? result.error };
  if (result.status === "RECORDED") return { tone: "info", title: "Already requested", description: result.success };
  return { tone: "negative", title: `${name} not requested`, description: result.error ?? result.success };
}

/** The form an AI action receives: payload fields, the request key and the selected screenshots. */
export function aiRequestForm(payload: AiActionButtonProps["payload"], requestKey: string, evidenceIds: readonly string[] = []): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === "string") form.append(name, value);
    else for (const item of value) form.append(name, item);
  }
  form.set("requestKey", requestKey);
  for (const id of new Set(evidenceIds)) form.append("evidence", id);
  return form;
}

export interface AiRequestOutcome {
  result: AiActionState;
  /** COMPLETED, FAILED or RECORDED: the request key was used up and must rotate before the next request. */
  terminal: boolean;
}

/**
 * Sends one request. A thrown error (a dropped connection) becomes an error state that keeps the key, so a retry
 * replays the same request instead of paying twice; Next.js control flow such as a redirect is rethrown.
 */
export async function submitAiRequest(action: AiRequestAction, form: FormData): Promise<AiRequestOutcome> {
  let result: AiActionState;
  try {
    result = await action({}, form);
  } catch (error) {
    unstable_rethrow(error);
    result = { error: UNREACHABLE };
  }
  return { result, terminal: result.status !== undefined && TERMINAL.has(result.status) };
}

/** The visible label: "Analyze setup · ≈ €0.02" or, when blocked, "Analyze blocked setup anyway · ≈ €0.02". */
export function aiButtonLabel(label: string, estimate: AiEstimateModel | null, blockedLabel?: string): string {
  const text = blockedLabel ?? label;
  return estimate ? `${text} · ${estimateLabel(estimate)}` : text;
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export function AiActionButton({
  operation, label, action, payload, requestKey, estimate, available, unavailableReason, describedBy: externalDescription, secondary = false, blockedLabel,
  selectedEvidenceIds = [], className,
}: AiActionButtonProps) {
  const router = useRouter();
  const toast = useOptionalToast();
  const [key, setKey] = useState(requestKey);
  const [pending, startTransition] = useTransition();
  const [inlineResult, setInlineResult] = useState<{ tone: "error" | "status"; text: string } | null>(null);
  const reasonId = useId();
  const statusId = useId();

  const runnable = available && estimate !== null;
  const reason = runnable ? null : (unavailableReason ?? (estimate === null ? PRICING_UNAVAILABLE : "AI is unavailable right now."));
  const text = aiButtonLabel(label, estimate, blockedLabel);
  const variant = secondary || blockedLabel ? "secondary" : "primary";

  const run = () => {
    if (!runnable || pending) return;
    const form = aiRequestForm(payload, key, selectedEvidenceIds);
    setInlineResult(null);
    startTransition(async () => {
      const { result, terminal } = await submitAiRequest(action, form);
      if (terminal) setKey(newKey());
      if (result.error && !terminal) setInlineResult({ tone: "error", text: result.error });
      else if (toast) toast.toast(aiResultToast(operation, result));
      else setInlineResult({ tone: "status", text: result.success ?? result.error ?? "" });
      router.refresh();
    });
  };

  const describedBy = [externalDescription || null, reason ? reasonId : null, inlineResult || pending ? statusId : null].filter(Boolean).join(" ") || undefined;
  // aria-disabled instead of disabled keeps the button focusable while it is pending or unavailable, so keyboard
  // focus is not lost and the reason stays discoverable.
  const button = (
    <Button
      type="button"
      variant={variant}
      icon={pending ? <LoaderCircle aria-hidden="true" className="spin" /> : <Sparkles aria-hidden="true" />}
      aria-disabled={!runnable || pending || undefined}
      aria-busy={pending || undefined}
      aria-describedby={describedBy}
      onClick={run}
      data-operation={dataToken(operation)}
      data-blocked={blockedLabel ? "true" : undefined}
      className="h-auto max-w-full whitespace-normal py-2 text-left"
    >
      {pending ? PENDING_LABELS[operation] : text}
    </Button>
  );

  return (
    <div className={cx("flex min-w-0 flex-col items-start gap-1", className)}>
      {/* Always wrapped, so the button keeps its identity (and focus) when availability changes. */}
      <Tooltip content={estimate ? estimateTooltip(estimate) : PRICING_UNAVAILABLE}>{button}</Tooltip>
      {reason && (
        <p id={reasonId} className="t-caption">
          {reason}
        </p>
      )}
      <p id={statusId} role="status" aria-live="polite" className={cx("t-caption", !pending && inlineResult?.tone !== "status" && "sr-only")}>
        {pending ? "Request sent. This usually takes under a minute; the result appears on this page." : inlineResult?.tone === "status" ? inlineResult.text : ""}
      </p>
      {inlineResult?.tone === "error" && (
        <p role="alert" className="text-[0.8125rem] font-medium text-neg">
          {inlineResult.text}
        </p>
      )}
    </div>
  );
}
