import { Inbox, OctagonAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "./button";
import { cx } from "./cx";

export type EmptyStateProps = {
  /** What will appear here, in one short sentence: "No closed trades yet." */
  title: ReactNode;
  /** The next action and when content appears: "Record or plan a trade; results appear here after you close it." */
  description?: ReactNode;
  icon?: ReactNode;
  /** Buttons or links for the next step. */
  actions?: ReactNode;
  compact?: boolean;
  /** Heading level for the title; defaults to a paragraph so it never disturbs the outline. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
};

export function EmptyState({ title, description, icon, actions, compact = false, headingLevel, className }: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div className={cx("empty-state", compact && "empty-state-compact", className)}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon ?? <Inbox />}
      </div>
      <Title className="empty-state-title">{title}</Title>
      {description && <p className="empty-state-description">{description}</p>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}

export type ErrorStateProps = {
  title?: ReactNode;
  description?: ReactNode;
  /** Retry control, typically `<Button onClick={reset}>Try again</Button>` from an error boundary. */
  retry?: ReactNode;
  /** Escape hatch link; route errors link back to Today. */
  homeHref?: string;
  homeLabel?: string;
  headingLevel?: 1 | 2 | 3;
  className?: string;
};

/** Error state for route `error.tsx` boundaries and failed sections. Never shows raw error text. */
export function ErrorState({
  title = "This page couldn't load.",
  description = "Nothing was changed. Try again, or go back to Today.",
  retry,
  homeHref = "/today",
  homeLabel = "Go to Today",
  headingLevel = 2,
  className,
}: ErrorStateProps) {
  const Title = `h${headingLevel}` as const;
  return (
    <div className={cx("empty-state error-state", className)} role="alert">
      <div className="empty-state-icon" aria-hidden="true">
        <OctagonAlert />
      </div>
      <Title className="empty-state-title">{title}</Title>
      <p className="empty-state-description">{description}</p>
      <div className="empty-state-actions">
        {retry}
        <Link href={homeHref} className={buttonClasses({ variant: "secondary" })}>
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
