import type { LinkProps } from "next/link";

/**
 * Whether a link switches the trading-account context: its URL carries `?account=` (docs/V2_ARCHITECTURE.md §9.2).
 * Such links are never prefetched. The proxy never stores a prefetched context, but a prefetch would still render a
 * whole page for another account that the person may never open.
 */
export function switchesAccountContext(href: LinkProps["href"]): boolean {
  if (typeof href === "string") {
    try {
      return new URL(href, "http://link.invalid").searchParams.has("account");
    } catch {
      return false;
    }
  }
  const { query, search } = href;
  if (query && typeof query === "object" && "account" in query && query.account !== undefined) return true;
  if (typeof query === "string" && new URLSearchParams(query).has("account")) return true;
  return typeof search === "string" && new URLSearchParams(search).has("account");
}

/** `prefetch` for a link: never for context-switching links, else the link's own choice (Next.js default). */
export function prefetchFor(href: LinkProps["href"], prefetch: LinkProps["prefetch"]): LinkProps["prefetch"] {
  return switchesAccountContext(href) ? false : prefetch;
}
