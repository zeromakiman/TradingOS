"use client";

import { useId } from "react";
import { useOptionalEvidenceSelection } from "@/components/evidence/selection";
import { AiActionButton, type AiActionButtonProps } from "./ai-action-button";
import { PRICING_UNAVAILABLE } from "./model";

/**
 * Paid AI buttons that send the screenshots selected in the trade's evidence gallery (docs/V2_ARCHITECTURE.md §7.5,
 * §11.3). Only screenshots eligible for the operation are sent (pre-entry evidence of the latest draft revision for
 * pre-trade tools; the trade's own evidence for a review), never more than the operation's maximum.
 */

export type AiEvidenceActionButton = Omit<AiActionButtonProps, "selectedEvidenceIds">;

export interface AiEvidenceActionsProps {
  buttons: readonly AiEvidenceActionButton[];
  /** Screenshots these operations may use; other selected screenshots are not sent. */
  eligibleEvidenceIds: readonly string[];
  /** Per-operation maximum (3 for Analyze setup / Challenge my bias, 4 for a trade review). */
  maxEvidence: number;
}

/** "Includes 2 selected screenshots." and the other selection states in words. */
export function evidenceSelectionSummary(selected: number, ignored: number, eligible: number, max: number): string {
  const unusable = ignored > 0 ? ` ${ignored === 1 ? "1 selected screenshot isn't" : `${ignored} selected screenshots aren't`} available to this tool and won't be sent.` : "";
  if (selected > max) return `${selected} screenshots selected; this request accepts up to ${max}. Deselect some in Evidence.${unusable}`;
  if (selected > 0) return `Includes ${selected === 1 ? "1 selected screenshot" : `${selected} selected screenshots`}.${unusable}`;
  if (eligible === 0) return `No screenshots available, so only your recorded text and numbers are sent.${unusable}`;
  return `No screenshots selected. Select up to ${max} in Evidence to include them.${unusable}`;
}

/** Why a button cannot run, or null when it can. */
function blockedReason(button: AiEvidenceActionButton): string | null {
  if (!button.available) return button.unavailableReason ?? "AI is unavailable right now.";
  return button.estimate === null ? PRICING_UNAVAILABLE : null;
}

export function AiEvidenceActions({ buttons, eligibleEvidenceIds, maxEvidence }: AiEvidenceActionsProps) {
  const sharedId = useId();
  // Outside an <EvidenceSelectionProvider> (no gallery on the page) requests are text-only.
  const selected = useOptionalEvidenceSelection()?.selected ?? [];
  const eligible = new Set(eligibleEvidenceIds);
  const unique = [...new Set(selected)];
  const chosen = unique.filter(id => eligible.has(id));
  const tooMany = chosen.length > maxEvidence;
  const reasons = buttons.map(blockedReason);
  // One shared reason ("Run the free risk check first.") is shown once instead of under every button, and every
  // button points to it with aria-describedby so a screen reader still hears why it cannot run.
  const shared = buttons.length > 1 && reasons.every(reason => reason !== null && reason === reasons[0]) ? reasons[0] : null;
  return (
    <div className="flex flex-col gap-2">
      <p className="t-meta">{evidenceSelectionSummary(chosen.length, unique.length - chosen.length, eligible.size, maxEvidence)}</p>
      {shared && (
        <p id={sharedId} className="t-caption">
          {shared}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-3">
        {buttons.map(button => (
          <AiActionButton
            key={button.operation}
            {...button}
            available={button.available && !tooMany}
            unavailableReason={shared ? "" : tooMany ? `Select at most ${maxEvidence} screenshots for this request.` : button.unavailableReason}
            describedBy={shared ? sharedId : button.describedBy}
            selectedEvidenceIds={tooMany ? [] : chosen}
          />
        ))}
      </div>
    </div>
  );
}
