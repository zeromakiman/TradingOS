import type { ReactNode } from "react";

/**
 * A Review tab's label: the shorter wording on phones where one exists (TAB_SHORT_LABELS), the full label from 640px.
 * The full label stays the accessible name at every width; it starts with the short wording, so the name still
 * contains what is shown (WCAG 2.5.3).
 */
export function ReviewTabLabel({ label, shortLabel }: { label: string; shortLabel: string | null }): ReactNode {
  if (!shortLabel) return label;
  return (
    <>
      <span aria-hidden="true" className="sm:hidden">
        {shortLabel}
      </span>
      <span className="max-sm:sr-only">{label}</span>
    </>
  );
}
