import type { Metadata } from "next";
import { JournalScreen } from "@/components/journal/journal-screen";
import { loadJournal, type SearchParams } from "@/components/journal/load-journal";

export const metadata: Metadata = { title: "Journal · Trading OS" };

/**
 * Journal (docs/V2_ARCHITECTURE.md §14.5): every trade of the account context, grouped by trade date, with URL-state
 * filters and keyset pagination. Drill-down links from EDGE, the calendar and Accounts arrive as query parameters.
 */
export default async function JournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const view = await loadJournal(await searchParams);
  return <JournalScreen view={view} />;
}
