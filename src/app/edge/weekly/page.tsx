import { redirect } from "next/navigation";
import { legacyReviewHref } from "@/components/review/params";

/**
 * Legacy V1 URL (docs/V2_ARCHITECTURE.md §1.2): the weekly review moved to `/review/weekly`. Bookmarks keep working;
 * the query string is preserved (`week` keeps its meaning, `account` selects the account context).
 */
export default async function LegacyWeeklyReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyReviewHref("weekly", await searchParams));
}
