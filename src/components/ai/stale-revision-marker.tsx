import { History } from "lucide-react";
import { STALE_ANALYSIS_NOTE } from "@/domain/ai-summary";
import { cx } from "../ui/cx";

/**
 * Marker on a pre-trade analysis of an earlier draft revision (docs/V2_ARCHITECTURE.md §11.1, §15):
 * "Based on draft revision 2 · current revision is 3" (`staleRevisionLabel`). Such an analysis is never presented as
 * current; an analysis of the current revision has no marker.
 */

/** The stale-analysis notice with any marker text (AiCard renders `staleNote` with it). */
export function StaleNotice({ text, className }: { text: string; className?: string }) {
  return (
    <p
      className={cx(
        "inline-flex max-w-full items-start gap-1.5 rounded-control border border-warn-border bg-warn-soft px-2 py-1 text-xs font-medium text-warn [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:flex-none",
        className,
      )}
      data-stale="true"
    >
      <History aria-hidden="true" />
      <span>
        <span className="sr-only">{STALE_ANALYSIS_NOTE}. </span>
        {text}
      </span>
    </p>
  );
}
