"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useEffect, useRef, useTransition } from "react";
import { cx } from "./cx";
import { focusElement } from "./focus";

export type FilterChip = {
  key: string;
  /** Human wording of the active filter, for example "Model: OTE". */
  label: string;
  /** URL with this filter removed. */
  removeHref: string;
};

export type FilterChipsProps = {
  chips: FilterChip[];
  /** URL with every filter removed. */
  clearHref?: string;
  clearLabel?: string;
  label?: string;
  className?: string;
  /**
   * Id of the region the filters change (the results). While the new results load it is marked busy (`aria-busy`)
   * and dimmed like `Refetching`; with no `emptyFocusId` it also receives focus once no chip is left.
   */
  resultsId?: string;
  /** Element that receives focus once no chip is left, for example the results heading. */
  emptyFocusId?: string;
};

/**
 * Where focus goes when the remove button of chip `index` of `count` goes away: the chip that takes its place in the
 * shorter list, else the one before it; null when it was the only chip.
 */
export function chipFocusAfterRemoval(index: number, count: number): number | null {
  if (index + 1 < count) return index;
  return index > 0 ? index - 1 : null;
}

const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

type FocusIntent = { chip: number } | { chip: null };

/**
 * Active filters as removable chips (URL state; without JavaScript every chip is a plain link). With JavaScript a
 * removal (or "Clear all") navigates in a transition: the results region is marked busy and dimmed until the new
 * results arrive, and focus moves to the chip that takes the removed one's place, else the previous chip, else the
 * results (`emptyFocusId`, `resultsId`) instead of dropping to the page body.
 */
export function FilterChips({ chips, clearHref, clearLabel = "Clear all", label = "Active filters", className, resultsId, emptyFocusId }: FilterChipsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLUListElement>(null);
  const intent = useRef<FocusIntent | null>(null);

  // The results region shows it is out of date while the next results load.
  useEffect(() => {
    const region = resultsId ? document.getElementById(resultsId) : null;
    if (!region || !pending) return;
    const added = !region.classList.contains("refetch");
    if (added) region.classList.add("refetch");
    region.setAttribute("aria-busy", "true");
    return () => {
      region.removeAttribute("aria-busy");
      if (added) region.classList.remove("refetch");
    };
  }, [pending, resultsId]);

  // Once the new chips are on the page, focus lands where the person expects it.
  useEffect(() => {
    if (pending || !intent.current) return;
    const { chip } = intent.current;
    intent.current = null;
    const remove = chip === null ? null : listRef.current?.querySelectorAll<HTMLElement>(".chip-remove")[chip];
    if (remove) {
      remove.focus();
      return;
    }
    const fallback = [emptyFocusId, resultsId, "main-content"].map(id => (id ? document.getElementById(id) : null)).find(Boolean);
    focusElement(fallback);
  });

  if (chips.length === 0) return null;

  const navigate = (event: MouseEvent<HTMLAnchorElement>, href: string, next: FocusIntent) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    intent.current = next;
    startTransition(() => router.push(href, { scroll: false }));
  };

  return (
    <div className={cx("filter-chips", className)} aria-busy={pending || undefined}>
      <ul ref={listRef} className="filter-chip-list" aria-label={label}>
        {chips.map((chip, index) => (
          <li key={chip.key} className="chip">
            <span>{chip.label}</span>
            <Link
              href={chip.removeHref}
              className="chip-remove"
              aria-label={`Remove filter: ${chip.label}`}
              scroll={false}
              onClick={event => navigate(event, chip.removeHref, { chip: chipFocusAfterRemoval(index, chips.length) })}
            >
              <X aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      {clearHref && chips.length > 1 && (
        <Link href={clearHref} className="btn btn-link -my-1 min-h-10 pointer-coarse:-my-1.5 pointer-coarse:min-h-11" scroll={false} onClick={event => navigate(event, clearHref, { chip: null })}>
          {clearLabel}
        </Link>
      )}
    </div>
  );
}
