import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadConnectionDetails } from "@/components/accounts/connection-data";
import { parseManageTab } from "@/components/accounts/copy";
import type { InstrumentDraft } from "@/components/accounts/manage-instrument-form";
import { ManageView } from "@/components/accounts/manage-view";
import { getAccountContext, getPreferences } from "@/lib/account-context";
import { type AccountManage, getAccountManage } from "@/lib/accounts-data";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const context = await getAccountContext();
  const account = context.accounts.find(item => item.id === id.toLowerCase());
  return { title: account ? `Manage ${account.name} · Trading OS` : "Manage account · Trading OS" };
}

/** The current version of `symbol` as the prefill of a new version (`?tab=instruments&symbol=EURUSD`). */
function instrumentDraft(manage: AccountManage, symbol: string | undefined): InstrumentDraft | null {
  if (!symbol) return null;
  const current = manage.instruments.find(row => row.current && row.symbol === symbol.trim().toUpperCase());
  return current
    ? {
        versionId: current.id, symbol: current.symbol, quantityUnit: current.quantityUnit, tickSize: current.tickSize, pipSize: current.pipSize,
        tickValue: current.tickValue, quantityStep: current.quantityStep, minimumQuantity: current.minimumQuantity,
      }
    : null;
}

/** Manage a trading account (docs/V2_ARCHITECTURE.md §14.9); `?tab=` selects the section. */
export default async function ManageAccountPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query, preferences] = await Promise.all([params, searchParams, getPreferences()]);
  const tab = parseManageTab(query.tab);
  const manage = await getAccountManage(id);
  if (!manage) notFound();
  const connection = tab === "connection" ? await loadConnectionDetails(manage.account.id) : null;
  return (
    <ManageView
      manage={manage}
      display={preferences.timeDisplay}
      tab={tab}
      connection={connection}
      instrumentDraft={tab === "instruments" ? instrumentDraft(manage, first(query.symbol)) : null}
    />
  );
}
