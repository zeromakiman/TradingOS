import type { Metadata } from "next";
import { autosaveKey } from "@/components/trade/forms/autosave";
import { loadTradeFormData } from "@/components/trade/forms/form-data";
import { newLiveDraft } from "@/components/trade/forms/live-model";
import { LiveTradeForm } from "@/components/trade/forms/live-trade-form";
import { NoTradingAccount } from "@/components/trade/forms/no-account";

export const metadata: Metadata = { title: "Record Live Trade · Trading OS" };

/**
 * Record Live Trade (docs/V2_ARCHITECTURE.md §8.2, §9.2, §14.3): a position that is already open, recorded in an
 * explicit trading account, then journaled on its trade page. Unsaved entries are kept in the tab and restored after
 * Back or a reload.
 */
export default async function RecordLiveTradePage() {
  const data = await loadTradeFormData();
  if (!data.accounts.length) return <NoTradingAccount kind="live" hasArchived={data.hasArchived} />;
  const account = data.accounts.find(item => item.id === data.defaultAccountId) ?? null;
  return <LiveTradeForm now={data.now} accounts={data.accounts} initial={newLiveDraft(account)} autosaveKey={autosaveKey(data.autosaveScope, { form: "live" })} />;
}
