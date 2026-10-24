"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ComponentProps, createContext, type MouseEvent, type ReactNode, type RefObject, useCallback, useContext, useMemo, useRef, useTransition,
} from "react";
import { Refetching } from "@/components/ui/skeleton";

/**
 * Filter navigation of the Journal (URL state, docs/V2_ARCHITECTURE.md §14.5). Filter changes navigate inside a
 * transition so the current list stays on screen, dimmed, until the new page arrives (§13.7 "refetch keeps the previous
 * render dimmed"). Every filter control is still a real link or GET form, so it also works before hydration.
 *
 * Focus (§13.5): a control that disappears once its filter is gone (a remove button, "Clear all") first hands focus to
 * an element that stays: its filter pill, a neighbouring chip, or the search field this context keeps a ref to.
 */

interface JournalNavValue {
  pending: boolean;
  navigate: (href: string) => void;
  /** The search field: mounted whenever filters show, so it can take focus from a control that goes away. */
  searchRef: RefObject<HTMLInputElement | null>;
  focusSearch: () => void;
}

const noSearch: RefObject<HTMLInputElement | null> = { current: null };
const JournalNavContext = createContext<JournalNavValue>({ pending: false, navigate: () => undefined, searchRef: noSearch, focusSearch: () => undefined });

export function JournalNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useCallback((href: string) => startTransition(() => router.push(href, { scroll: false })), [router]);
  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const value = useMemo(() => ({ pending, navigate, searchRef, focusSearch }), [pending, navigate, focusSearch]);
  return <JournalNavContext.Provider value={value}>{children}</JournalNavContext.Provider>;
}

export function useJournalNav(): JournalNavValue {
  return useContext(JournalNavContext);
}

/** A plain click (no modifier keys, main button) that the page may handle itself. */
export function isPlainClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export type FilterLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
  /** Runs before navigating (for example to close the menu the link sits in, or to move focus to a control that stays). */
  onSelect?: () => void;
};

/** A link to another filter state of the Journal; plain clicks navigate in the Journal transition. */
export function FilterLink({ href, onSelect, onClick, ...props }: FilterLinkProps) {
  const { navigate } = useJournalNav();
  return (
    <Link
      href={href}
      scroll={false}
      {...props}
      onClick={event => {
        onClick?.(event);
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onSelect?.();
        navigate(href);
      }}
    />
  );
}

/** A link that removes filters ("Clear all", "Clear search"): it goes away with them, so focus moves to the search field. */
export function ClearFiltersLink(props: Omit<FilterLinkProps, "onSelect">) {
  const { focusSearch } = useJournalNav();
  return <FilterLink {...props} onSelect={focusSearch} />;
}

/** The list region: dimmed and marked busy while a filter change loads. */
export function RefetchRegion({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useJournalNav();
  return (
    <Refetching pending={pending} className={className}>
      {children}
    </Refetching>
  );
}

/**
 * `/journal?…` from a filter form's fields: empty values are dropped so the URL stays readable (the server ignores
 * them either way). Pure, so the form behaviour is testable without a DOM.
 */
export function formHref(entries: Iterable<[string, FormDataEntryValue]>, path = "/journal"): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text !== "") params.append(name, text);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The text a search field should show once a new search is applied (after Enter, "Clear all", Back): the applied one,
 * unless the person is typing something else in the focused field. Pure, so the rule is testable without a DOM.
 */
export function searchFieldValue({ shown, previous, applied, focused }: { shown: string; previous: string; applied: string; focused: boolean }): string {
  return shown === previous || !focused ? applied : shown;
}

/**
 * Where focus goes when the remove button of chip `index` of `count` disappears: the chip that takes its place, else
 * the one before it; null when it was the only chip (the caller then picks a control that stays).
 */
export function neighbourChip(index: number, count: number): number | null {
  if (index + 1 < count) return index + 1;
  return index > 0 ? index - 1 : null;
}
