import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId } from "react";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { NavigateSelect } from "./navigate-select";
import type { PeriodStep } from "./periods";
import type { NavigateSelectModel, PeriodControl, SegmentLink } from "./review-data";
import { TransitionLink } from "./transition-link";

/**
 * Scope controls of a periodic review (docs/V2_ARCHITECTURE.md §14.10): the in-page trading-account picker (All
 * Accounts only) and the period: a week or month picker with previous / next steps, or the 10 · 20 · 30 trades sample.
 * Every choice is a URL, so it can be shared, bookmarked and used without JavaScript (the links); the selects
 * navigate on change.
 */

/** Steps appear from small tablets up; on phones the native picker is the control and gets the full width. */
const STEP = buttonClasses({ variant: "secondary", iconOnly: true, className: "hidden flex-none sm:inline-flex" });

function Step({ step, direction }: { step: PeriodStep | null; direction: "previous" | "next" }) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  if (!step) {
    // Nothing earlier (the account's first period) or later (the last completed one): an inert placeholder keeps the
    // picker's width; it is hidden from assistive technology because it does nothing.
    return (
      <span className={cx(STEP, "pointer-events-none opacity-40")} aria-hidden="true">
        <Icon />
      </span>
    );
  }
  return (
    <TransitionLink href={step.href} className={STEP} aria-label={step.label} rel={direction === "previous" ? "prev" : "next"}>
      <Icon aria-hidden="true" />
    </TransitionLink>
  );
}

/** The in-page account picker (All Accounts only); it follows the URL and keeps focus across account changes. */
export function AccountSelect({ model, className }: { model: NavigateSelectModel; className?: string }) {
  return <NavigateSelect name={model.name} label={model.label} value={model.value} groups={model.groups} className={className} />;
}

/**
 * A labelled segmented switch whose options are URLs (the recent-trades sample, the kind of analysis in History). On
 * phones it spans the width with equal segments and, where given, shorter wording.
 */
export function SegmentNav({ label, items, size = "md", className }: { label: string; items: readonly SegmentLink[]; size?: "sm" | "md"; className?: string }) {
  const labelId = useId();
  return (
    <div className={cx("field w-full sm:w-auto", className)}>
      <span id={labelId} className="field-label">
        {label}
      </span>
      <nav aria-labelledby={labelId} className={cx("segmented w-full sm:w-max", size === "sm" && "segmented-sm")}>
        {items.map(item => (
          <TransitionLink
            key={item.href}
            href={item.href}
            className="segmented-label flex-1 justify-center sm:flex-none"
            aria-current={item.current ? "true" : undefined}
          >
            {item.shortLabel ? (
              <>
                <span className="sm:hidden">{item.shortLabel}</span>
                <span className="hidden sm:inline">{item.label}</span>
              </>
            ) : (
              item.label
            )}
          </TransitionLink>
        ))}
      </nav>
    </div>
  );
}

export function PeriodControlView({ control, className }: { control: PeriodControl; className?: string }) {
  if (control.kind === "sample") return <SegmentNav label={control.label} items={control.items} className={className} />;
  const { picker } = control;
  return (
    <NavigateSelect
      name={picker.label.toLowerCase()}
      label={picker.label}
      value={picker.value}
      groups={[{ label: null, options: picker.options }]}
      before={<Step step={picker.previous} direction="previous" />}
      after={<Step step={picker.next} direction="next" />}
      className={className}
    />
  );
}
