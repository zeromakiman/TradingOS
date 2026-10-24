"use client";

import { useRef } from "react";
import { ActiveFilterChips } from "./active-filter-chips";
import { FilterMenu, MoreFiltersMenu } from "./filter-menu";
import { FilterSheet } from "./filter-sheet";
import { ClearFiltersLink } from "./journal-nav";
import { SearchBox } from "./search-box";
import type { FiltersView } from "./types";

/**
 * The Journal's filter row (docs/V2_ARCHITECTURE.md §14.5): search, one pill per frequent filter (URL state), active
 * less frequent filters, "More filters", drill-down chips and "Clear all". Below 768px the pills move into a bottom
 * sheet and every active filter shows as a removable chip under the search. A client component only so its controls
 * can pass focus to one another when one of them goes away (§13.5).
 */
export function FilterBar({ filters }: { filters: FiltersView }) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLButtonElement>(null);
  const focusMore = () => moreRef.current?.focus();
  const focusSheet = () => sheetRef.current?.focus();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 md:gap-1.5">
        <SearchBox search={filters.search} className="min-w-0 flex-1 md:mr-1 md:w-56 md:flex-none" />
        <FilterSheet sheet={filters.sheet} clearHref={filters.clearHref} triggerRef={sheetRef} className="md:hidden" />
        {filters.menus.map(menu => (
          <FilterMenu key={menu.key} menu={menu} className="max-md:hidden" />
        ))}
        {filters.moreMenus
          .filter(menu => menu.activeLabel !== null)
          .map(menu => (
            <FilterMenu key={menu.key} menu={menu} onGone={focusMore} className="max-md:hidden" />
          ))}
        <MoreFiltersMenu menus={filters.moreMenus} triggerRef={moreRef} className="max-md:hidden" />
        <ActiveFilterChips chips={filters.extraChips} label="Other active filters" onEmpty={focusMore} className="max-md:hidden" />
        {filters.clearHref && filters.activeCount > 0 && (
          <ClearFiltersLink href={filters.clearHref} className="btn btn-link inline-flex min-h-10 items-center px-1 max-md:hidden pointer-coarse:min-h-11">
            Clear all
          </ClearFiltersLink>
        )}
      </div>
      <ActiveFilterChips chips={filters.allChips} label="Active filters" clearHref={filters.clearHref} onEmpty={focusSheet} className="md:hidden" />
    </div>
  );
}
