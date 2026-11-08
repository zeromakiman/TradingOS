import { redirect } from "next/navigation";
import { legacyReviewHref } from "@/components/review/params";

/**
 * Legacy V1 URL (docs/V2_ARCHITECTURE.md §1.2): the monthly review moved to `/review/monthly`. Bookmarks keep working;
 * the query string is preserved (`month` keeps its meaning, `account` selects the account context).
 */
export default async function LegacyMonthlyReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyReviewHref("monthly", await searchParams));
}
