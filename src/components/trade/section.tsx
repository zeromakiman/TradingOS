import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

/**
 * One section of the trade workspace (docs/V2_ARCHITECTURE.md §14.4): a card with an `h2`, one line of state under it,
 * optional actions on the right, and the content. The section's id is its in-page target (`#journal`, `#review`, …);
 * `scroll-mt` keeps a jumped-to section clear of the sticky top bar. Server component.
 */

export interface WorkspaceSectionProps {
  id: string;
  title: ReactNode;
  /** One line under the title: the state, versions or counts. */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function WorkspaceSection({ id, title, meta, actions, children, className, bodyClassName }: WorkspaceSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} tabIndex={-1} className={cx("card min-w-0 scroll-mt-20 outline-none", className)}>
      <div className="card-header flex-col flex-nowrap items-stretch gap-1">
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="card-title min-w-0">
            {title}
          </h2>
          {actions && <div className="-mt-1 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
        </div>
        {meta && <div className="t-meta">{meta}</div>}
      </div>
      <div className={cx("@container card-body flex flex-col gap-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A titled group inside a section ("Risk check", "Thesis", "Plan vs reality"). */
export function SubSection({ title, id, actions, children, className }: { title: ReactNode; id: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-semibold text-text">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
