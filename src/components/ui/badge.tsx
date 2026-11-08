import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * State tones (§13.2). `danger` is accepted as an alias of `negative`, and
 * `positive-muted` is the "Reviewed" tone of §2.3.
 */
export type StatusTone = "neutral" | "positive" | "positive-muted" | "negative" | "danger" | "warning" | "info" | "live" | "muted";

const toneClass: Record<StatusTone, string> = {
  neutral: "pill-neutral",
  positive: "pill-positive",
  "positive-muted": "pill-positive-muted",
  negative: "pill-negative",
  danger: "pill-negative",
  warning: "pill-warning",
  info: "pill-info",
  live: "pill-live",
  muted: "pill-muted",
};

export type StatusPillProps = Omit<ComponentProps<"span">, "children"> & {
  tone?: StatusTone;
  /** The state in words; colour is never the only signal. */
  children: ReactNode;
  /** Leading dot. Always shown for `live`, where it pulses unless reduced motion is requested. */
  dot?: boolean;
  icon?: ReactNode;
};

export function StatusPill({ tone = "neutral", dot, icon, className, children, ...props }: StatusPillProps) {
  const showDot = dot ?? tone === "live";
  return (
    <span className={cx("pill", toneClass[tone], className)} data-tone={tone} {...props}>
      {showDot && <span className="pill-dot" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}

export type BadgeProps = ComponentProps<"span"> & { tone?: "neutral" | "accent" };

/** Quiet label for categories such as the trade origin ("Planned", "Live-first", "Imported"). */
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span className={cx("badge", tone === "accent" && "badge-accent", className)} {...props} />;
}
