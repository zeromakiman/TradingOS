"use client";

import { X } from "lucide-react";
import { useRef } from "react";
import { cx } from "@/components/ui/cx";
import { ClearFiltersLink, FilterLink, neighbourChip } from "./journal-nav";
import type { ChipView } from "./types";

/**
 * Active filters as removable chips (the look of the shared `FilterChips`), built on `FilterLink` so a removal runs in
 * the Journal transition and focus moves on before the chip goes away: to the chip that takes its place, else the one
 * before it, else `onEmpty` (a control that stays). "Clear all" hands focus to the search field.
 */
export function ActiveFilterChips({ chips, label, clearHref, onEmpty, className }: {
  chips: ChipView[];
  label: string;
  /** Shown as "Clear all" when more than one chip is active. */
  clearHref?: string | null;
  onEmpty: () => void;
  className?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  if (chips.length === 0) return null;
  const handOff = (index: number) => {
    const next = neighbourChip(index, chips.length);
    const target = next === null ? null : listRef.current?.querySelectorAll<HTMLElement>(".chip-remove")[next];
    if (target) target.focus();
    else onEmpty();
  };
  return (
    <div className={cx("filter-chips", className)}>
      <ul ref={listRef} className="filter-chip-list" aria-label={label}>
        {chips.map((chip, index) => (
          <li key={chip.key} className="chip">
            <span>{chip.label}</span>
            <FilterLink href={chip.removeHref} className="chip-remove" aria-label={`Remove filter: ${chip.label}`} onSelect={() => handOff(index)}>
              <X aria-hidden="true" />
            </FilterLink>
          </li>
        ))}
      </ul>
      {clearHref && chips.length > 1 && (
        <ClearFiltersLink href={clearHref} className="btn btn-link -my-1 min-h-10 pointer-coarse:-my-1.5 pointer-coarse:min-h-11">
          Clear all
        </ClearFiltersLink>
      )}
    </div>
  );
}
