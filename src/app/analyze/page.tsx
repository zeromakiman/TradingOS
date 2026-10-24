import { redirect } from "next/navigation";
import { queryString } from "@/components/trade/forms/legacy";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Legacy V1 "Analyze" (docs/V2_ARCHITECTURE.md §1.2): planning a trade now starts at Plan Trade; the query string is kept. */
export default async function LegacyAnalyzePage({ searchParams }: { searchParams: SearchParams }) {
  redirect(`/trades/new${queryString(await searchParams)}`);
}
