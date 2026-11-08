import type { Metadata } from "next";
import { AccountsOverviewView } from "@/components/accounts/accounts-overview";
import { getPreferences } from "@/lib/account-context";
import { getAccountsOverview } from "@/lib/accounts-data";

export const metadata: Metadata = { title: "Accounts · Trading OS" };

/** Accounts workspace (docs/V2_ARCHITECTURE.md §14.7). */
export default async function AccountsPage() {
  const [overview, preferences] = await Promise.all([getAccountsOverview(), getPreferences()]);
  return <AccountsOverviewView overview={overview} display={preferences.timeDisplay} />;
}
