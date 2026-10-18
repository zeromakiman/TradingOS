import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

export type SkeletonProps = {
  className?: string;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  /** Use `pill` for chips/badges and `circle` for avatars or dots. */
  shape?: "block" | "pill" | "circle";
};

/** Placeholder shaped like the content it stands in for. Decorative: wrap groups in `LoadingState`. */
export function Skeleton({ className, width, height = "1rem", shape = "block" }: SkeletonProps) {
  const radius = shape === "pill" || shape === "circle" ? "var(--radius-pill)" : undefined;
  return <span aria-hidden="true" className={cx("skeleton", className)} style={{ width, height, borderRadius: radius }} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  const placeholders = Array.from({ length: lines }, (_, line) => ({ id: `line-${line}`, width: line === lines - 1 && lines > 1 ? "62%" : "100%" }));
  return (
    <span aria-hidden="true" className={cx("skeleton-text", className)}>
      {placeholders.map((placeholder) => (
        <span key={placeholder.id} className="skeleton skeleton-line" style={{ width: placeholder.width }} />
      ))}
    </span>
  );
}

/** Announces loading once ("Loading trades…") while skeletons fill the space. */
export function LoadingState({ label = "Loading", children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Keeps the previous render visible but dimmed while new data loads (no skeleton flash). */
export function Refetching({ pending, children, className }: { pending: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cx("refetch", className)} aria-busy={pending}>
      {children}
    </div>
  );
}
