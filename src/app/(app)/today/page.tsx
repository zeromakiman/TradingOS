import type { Metadata } from "next";
import { Suspense } from "react";
import { OverviewLoading, OverviewSection } from "@/components/today/overview-section";
import { loadTodayPage } from "@/components/today/load-today";
import { TodayScreen } from "@/components/today/today-screen";
import { parseOverviewRange } from "@/domain/all-accounts-overview";

export const metadata: Metadata = { title: "Today · Trading OS" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Today (docs/V2_ARCHITECTURE.md §14.1): the home workstation of the account context. `?account=` links switch the
 * context in the proxy before this page renders; first run shows the account onboarding. In All Accounts, `?range=`
 * (d, w, m, y, all) and `?currency=` choose the period and the chart currency of the combined overview.
 */
export default async function TodayPage({ searchParams }: { searchParams?: SearchParams } = {}) {
  const query = (await searchParams) ?? {};
  const options = { range: query.range, currency: query.currency };
  const page = await loadTodayPage({ ...options, deferOverview: true });
  if (page.kind !== "today" || page.view.context.mode !== "all") return <TodayScreen page={page} />;
  const section = <OverviewSection options={options} display={page.view.display} />;
  // The daily overview reuses this request's Today snapshot (no further read), so it renders with the page: a Suspense
  // fallback would only hold it back (React reveals streamed content no sooner than 300 ms after a fallback painted).
  // Other periods read their own ledger range and stream in without holding back the rest of Today.
  const overview = parseOverviewRange(options.range) === "d" ? section : (
    <Suspense key={`${page.view.day}:${options.range ?? "d"}:${options.currency ?? ""}`} fallback={<OverviewLoading />}>{section}</Suspense>
  );
  return <TodayScreen page={page} overview={overview} />;
}
