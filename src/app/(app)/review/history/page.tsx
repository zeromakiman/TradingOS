import type { Metadata } from "next";
import { loadReview } from "@/components/review/review-data";
import { ReviewScreen } from "@/components/review/review-screen";

/** Every AI analysis across the trader's accounts (docs/V2_ARCHITECTURE.md §11.1, §14.10). */
export const metadata: Metadata = { title: "AI history · Trading OS" };

export default async function ReviewHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ReviewScreen view={await loadReview("history", await searchParams)} />;
}
