import { redirect } from "next/navigation";
import { legacyReviewHref } from "@/components/review/params";

/**
 * Legacy V1 URL (docs/V2_ARCHITECTURE.md §1.2): the recent-trades analysis moved to `/review/recent`. Bookmarks keep
 * working; the query string is preserved (`sample` keeps its meaning, `account` selects the account context).
 */
export default async function LegacyRecentTradesReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyReviewHref("recent", await searchParams));
}
