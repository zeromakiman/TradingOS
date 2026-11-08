import type { Metadata } from "next";
import { loadTodayPage } from "@/components/today/load-today";
import { TodayScreen } from "@/components/today/today-screen";

export const metadata: Metadata = { title: "Today · Trading OS" };

/**
 * Today (docs/V2_ARCHITECTURE.md §14.1): the home workstation of the account context. `?account=` links switch the
 * context in the proxy before this page renders; first run shows the account onboarding.
 */
export default async function TodayPage() {
  const page = await loadTodayPage();
  return <TodayScreen page={page} />;
}
