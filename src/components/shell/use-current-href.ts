"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * Path and query of the current page ("/journal?model=OTE"), for links that change one
 * parameter, such as the trading-account context, and keep the page's filters.
 */
export function useCurrentHref(fallback = "/today") {
  const pathname = usePathname() ?? fallback;
  const query = useSearchParams()?.toString();
  return query ? `${pathname}?${query}` : pathname;
}
