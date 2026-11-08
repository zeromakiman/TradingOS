import type { Metadata } from "next";
import { loadReview } from "@/components/review/review-data";
import { ReviewScreen } from "@/components/review/review-screen";

/**
 * Review workspace (docs/V2_ARCHITECTURE.md §14.10); `/review` opens on the Weekly tab. The page lives in a route group
 * so its loading state wraps this page only: a `loading.tsx` beside the tab folders would also be the loading state of
 * every tab (Recent trades, Monthly, History) while they load.
 */
export const metadata: Metadata = { title: "Review · Trading OS" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ReviewScreen view={await loadReview("weekly", await searchParams)} />;
}
