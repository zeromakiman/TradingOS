import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "./button";
import { cx } from "./cx";

export type PaginationLink = { href: string; label?: string };

export type PaginationProps = {
  /** Link to newer/previous results; omitted on the first page. */
  previous?: PaginationLink | null;
  /** Link to older/next results; omitted on the last page. */
  next?: PaginationLink | null;
  /** Position text such as "Page 2 · 50 per page" (works with keyset pagination). */
  summary?: ReactNode;
  label?: string;
  className?: string;
};

function PageLink({ link, fallbackLabel, direction }: { link?: PaginationLink | null; fallbackLabel: string; direction: "previous" | "next" }) {
  const text = link?.label ?? fallbackLabel;
  const content =
    direction === "previous" ? (
      <>
        <ChevronLeft aria-hidden="true" />
        {text}
      </>
    ) : (
      <>
        {text}
        <ChevronRight aria-hidden="true" />
      </>
    );
  if (!link) {
    return (
      <span className={buttonClasses({ variant: "secondary", size: "sm" })} aria-disabled="true">
        {content}
      </span>
    );
  }
  return (
    <Link href={link.href} className={buttonClasses({ variant: "secondary", size: "sm" })} rel={direction === "previous" ? "prev" : "next"}>
      {content}
    </Link>
  );
}

export function Pagination({ previous, next, summary, label = "Pagination", className }: PaginationProps) {
  return (
    <nav aria-label={label} className={cx("pagination", className)}>
      <p className="pagination-summary">{summary}</p>
      <div className="pagination-links">
        <PageLink link={previous} fallbackLabel="Newer" direction="previous" />
        <PageLink link={next} fallbackLabel="Older" direction="next" />
      </div>
    </nav>
  );
}
