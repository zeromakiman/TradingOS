import type { Metadata } from "next";
import { loadReview } from "@/components/review/review-data";
import { ReviewScreen } from "@/components/review/review-screen";

/** Recent-trades AI analysis of one trading account (docs/V2_ARCHITECTURE.md §11.5, §14.10). */
export const metadata: Metadata = { title: "Recent trades analysis · Trading OS" };

export default async function RecentTradesReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ReviewScreen view={await loadReview("recent", await searchParams)} />;
}
