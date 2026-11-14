import type { Metadata } from "next";
import { loadTodayPage } from "@/components/today/load-today";
import { TodayScreen } from "@/components/today/today-screen";

export const metadata: Metadata = { title: "Today · Trading OS" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Today (docs/V2_ARCHITECTURE.md §14.1): the home workstation of the account context. `?account=` links switch the
 * context in the proxy before this page renders; first run shows the account onboarding. In All Accounts, `?range=`
 * (d, w, m, y, all) and `?currency=` choose the period and the chart currency of the combined overview.
 */
export default async function TodayPage({ searchParams }: { searchParams?: SearchParams } = {}) {
  const query = (await searchParams) ?? {};
  const page = await loadTodayPage({ range: query.range, currency: query.currency });
  return <TodayScreen page={page} />;
}
