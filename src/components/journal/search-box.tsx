"use client";

import { Search, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { cx } from "@/components/ui/cx";
import { FilterLink, formHref, searchFieldValue, useJournalNav } from "./journal-nav";
import type { SearchView } from "./types";

/**
 * Journal search (instrument, tag, note text). A GET form carrying the other active filters as hidden fields, so the
 * search narrows the current filters instead of replacing them; Enter applies it. The field stays mounted across
 * searches (it keeps focus after Enter and takes it from "Clear search" and "Clear all", see journal-nav.tsx).
 */
export function SearchBox({ search, className }: { search: SearchView; className?: string }) {
  const id = useId();
  const { navigate, searchRef } = useJournalNav();
  const applied = useRef(search.value);

  // Show a newly applied search (after "Clear all", Back or Forward) unless the person is typing a different one.
  useEffect(() => {
    const input = searchRef.current;
    if (input) {
      input.value = searchFieldValue({ shown: input.value, previous: applied.current, applied: search.value, focused: document.activeElement === input });
    }
    applied.current = search.value;
  }, [search.value, searchRef]);

  return (
    <search className={className}>
      <form
        action="/journal"
        method="get"
        className="relative"
        onSubmit={event => {
          event.preventDefault();
          navigate(formHref(new FormData(event.currentTarget).entries()));
        }}
      >
        <label htmlFor={`journal-search${id}`} className="sr-only">
          Search trades by instrument, tag or note
        </label>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-3" />
        <input
          ref={searchRef}
          id={`journal-search${id}`}
          type="search"
          name="q"
          defaultValue={search.value}
          maxLength={100}
          autoComplete="off"
          enterKeyHint="search"
          placeholder="Instrument, tag or note"
          className={cx("input pl-9 [&::-webkit-search-cancel-button]:appearance-none", search.clearHref && "pr-10")}
        />
        {search.hidden.map(field => (
          <input key={`${field.name}=${field.value}`} type="hidden" name={field.name} value={field.value} />
        ))}
        {search.clearHref && (
          <FilterLink
            href={search.clearHref}
            aria-label="Clear search"
            onSelect={() => {
              const input = searchRef.current;
              if (!input) return;
              input.value = "";
              input.focus();
            }}
            className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-control text-3 after:absolute after:-inset-1 after:content-[''] hover:bg-surface-sunken hover:text-1 pointer-coarse:after:-inset-1.5"
          >
            <X aria-hidden="true" className="size-4" />
          </FilterLink>
        )}
      </form>
    </search>
  );
}
