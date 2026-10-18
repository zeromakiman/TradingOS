import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type StatDelta = {
  /** Signed, pre-formatted value such as "+$120.00" or "−0.50R". */
  value: ReactNode;
  /** Whether the change is good, bad or neither; the sign in `value` already carries direction. */
  tone?: "positive" | "negative" | "neutral";
  /** The comparison period, for example "vs last week". */
  label?: ReactNode;
};

export type StatProps = Omit<ComponentProps<"div">, "children"> & {
  label: ReactNode;
  /** Pre-formatted value; proportional figures are used for standalone numbers. */
  value: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
  /** De-emphasises a statistic that rests on an early sample (§13.8) and adds an "Early" tag. */
  early?: boolean;
  size?: "md" | "lg";
};

export function Stat({ label, value, delta, hint, early = false, size = "md", className, ...props }: StatProps) {
  return (
    <div className={cx("stat", size === "lg" && "stat-lg", early && "stat-early", className)} {...props}>
      <div className="stat-label">
        <span>{label}</span>
        {early && <span className="stat-early-tag">Early</span>}
      </div>
      <div className="stat-value">{value}</div>
      {delta && (
        <div className={cx("stat-delta", delta.tone === "positive" && "stat-delta-positive", delta.tone === "negative" && "stat-delta-negative")}>
          {delta.value}
          {delta.label && <span className="stat-hint"> {delta.label}</span>}
        </div>
      )}
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function StatGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("stat-group", className)} {...props} />;
}
