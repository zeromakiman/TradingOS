import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountDashboardView, parseCalendarMode } from "@/components/accounts/account-dashboard";
import { strategyMonth } from "@/domain/time-display";
import { getAccountContext, getPreferences } from "@/lib/account-context";
import { getAccountDashboard } from "@/lib/accounts-data";
import { parseMonth } from "@/lib/performance-data";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const context = await getAccountContext();
  const account = context.accounts.find(item => item.id === id.toLowerCase());
  return { title: account ? `${account.name} · Accounts · Trading OS` : "Account · Trading OS" };
}

/** Account dashboard (docs/V2_ARCHITECTURE.md §14.8). `?month=YYYY-MM&mode=net-r|net-pnl|loss|trades` drive the calendar. */
export default async function AccountDashboardPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query, preferences, context] = await Promise.all([params, searchParams, getPreferences(), getAccountContext()]);
  const mode = parseCalendarMode(query.mode);
  const month = parseMonth(first(query.month), strategyMonth(new Date().toISOString()));
  const dashboard = await getAccountDashboard(id, month, mode);
  if (!dashboard) notFound();
  return (
    <AccountDashboardView
      dashboard={dashboard}
      display={preferences.timeDisplay}
      month={dashboard.calendar.month}
      mode={mode}
      currentContext={context.selected.mode === "all" ? "all" : context.selected.account.id}
    />
  );
}
