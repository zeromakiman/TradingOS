import type { Metadata } from "next";
import { loadReview } from "@/components/review/review-data";
import { ReviewScreen } from "@/components/review/review-screen";

/** Monthly AI review of one trading account (docs/V2_ARCHITECTURE.md §11.5, §14.10). */
export const metadata: Metadata = { title: "Monthly review · Trading OS" };

export default async function MonthlyReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ReviewScreen view={await loadReview("monthly", await searchParams)} />;
}
