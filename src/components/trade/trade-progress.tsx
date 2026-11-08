import { Ban, Radio, Trash2 } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Stepper } from "@/components/ui/stepper";
import type { TimeDisplay } from "@/domain/time-display";
import type { TimelineItem } from "@/domain/timeline";
import { STEPPER_STEPS } from "@/domain/trade-state";
import type { TradeDetail } from "@/lib/trades-data";
import { whenLabel } from "./model";

/**
 * Where the trade stands (docs/V2_ARCHITECTURE.md §2.3): planned trades show the stepper Draft → Validated → Locked →
 * Live → Closed → Reviewed; live-first and imported trades show the exact banner "No pre-trade plan was recorded
 * before execution."; skipped, cancelled and discarded trades say how and when they ended, with the trader's reason
 * (for a skip recorded in an earlier version of Trading OS, the reason of its V1 decision).
 */

const STEPS = STEPPER_STEPS.map(step => ({ id: step, label: step }));

/** The latest V1 skip of the timeline (time order), which ended a plan skipped in an earlier version of Trading OS. */
function latestLegacySkip(timeline: readonly TimelineItem[]): TimelineItem | undefined {
  return timeline.filter(item => item.kind === "LEGACY_DECISION" && item.details?.decision === "SKIPPED").at(-1);
}

export function TradeProgress({ detail, now, display }: { detail: TradeDetail; now: string; display: TimeDisplay }) {
  const { state } = detail;
  const when = (instant: string) => whenLabel(instant, now, display);
  if (state.banner) {
    return (
      <Callout tone="info" icon={<Radio aria-hidden="true" />} title={state.banner} data-banner="no-plan">
        {detail.origin === "IMPORTED" ? "This trade was imported from a platform execution. " : "This trade was recorded while the position was open. "}
        Its notes and screenshots are labelled While live or After close, never Before entry.
      </Callout>
    );
  }
  if (state.lifecycle === "SKIPPED" || state.lifecycle === "CANCELLED") {
    const disposition = detail.disposition;
    const title = state.lifecycle === "SKIPPED" ? "Skipped before entry" : "Cancelled before entry";
    // A skip recorded in an earlier version of Trading OS has no disposition row: its decision, the trade's latest V1
    // skip, dates the end and carries the trader's reason when one was recorded.
    const legacySkip = disposition ? undefined : latestLegacySkip(detail.timeline);
    const endedAt = disposition?.recordedAt ?? detail.planEndedAt;
    const reason = disposition?.reason ?? legacySkip?.body ?? null;
    return (
      <Callout tone="neutral" icon={<Ban aria-hidden="true" />} title={endedAt ? `${title} · ${when(endedAt)}` : title}>
        {reason && <p className="whitespace-pre-wrap break-words">“{reason}”</p>}
        {!disposition && (
          <p className={reason ? "t-caption" : undefined}>
            {reason ? "Recorded in an earlier version of Trading OS." : "Recorded in an earlier version of Trading OS, without a reason."}
          </p>
        )}
      </Callout>
    );
  }
  if (state.lifecycle === "DISCARDED") {
    const discarded = detail.timeline.find(item => item.kind === "DRAFT_DISCARDED");
    return (
      <Callout tone="neutral" icon={<Trash2 aria-hidden="true" />} title={discarded ? `Draft discarded · ${when(discarded.at)}` : "Draft discarded"}>
        {discarded?.body ? <span className="whitespace-pre-wrap break-words">“{discarded.body}”</span> : "It was never locked. Its history stays below."}
      </Callout>
    );
  }
  if (!state.step) return null;
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface px-4 py-3">
      <Stepper steps={STEPS} current={state.step} complete={state.lifecycle === "REVIEWED"} label="Trade progress" />
    </div>
  );
}
