import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type StepperStep = { id: string; label: ReactNode };

export type StepperProps = {
  steps: StepperStep[];
  /** Id of the current step; earlier steps are complete. */
  current: string;
  /** Marks every step complete, current included (for example a reviewed trade). */
  complete?: boolean;
  label?: string;
  className?: string;
};

type StepStatus = "complete" | "current" | "upcoming";

/** Progress through ordered steps, such as Draft → Validated → Locked → Live → Closed → Reviewed. */
export function Stepper({ steps, current, complete = false, label = "Progress", className }: StepperProps) {
  const currentIndex = steps.findIndex((step) => step.id === current);
  const statusOf = (index: number): StepStatus => {
    if (complete || index < currentIndex) return "complete";
    return index === currentIndex ? "current" : "upcoming";
  };

  return (
    <ol className={cx("stepper", className)} aria-label={label}>
      {steps.map((step, index) => {
        const status = statusOf(index);
        return (
          <li key={step.id} className="step" data-status={status} aria-current={status === "current" ? "step" : undefined}>
            <span className="step-marker" aria-hidden="true">
              {status === "complete" ? <Check /> : index + 1}
            </span>
            <span className="step-label">
              {step.label}
              {status === "complete" && <span className="sr-only"> (completed)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
