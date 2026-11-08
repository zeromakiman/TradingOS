import type { Metadata } from "next";
import { TRADE_EVIDENCE_LIMIT } from "@/components/evidence/types";
import { autosaveKey } from "@/components/trade/forms/autosave";
import { loadTradeFormData } from "@/components/trade/forms/form-data";
import { NoTradingAccount } from "@/components/trade/forms/no-account";
import { newPlanDraft } from "@/components/trade/forms/plan-model";
import { PlanTradeForm } from "@/components/trade/forms/plan-trade-form";

export const metadata: Metadata = { title: "Plan Trade · Trading OS" };

/**
 * Plan Trade (docs/V2_ARCHITECTURE.md §8.1, §9.2, §14.2): a new draft in an explicit trading account. The account
 * defaults to the selected context, else the most recently used active account, else the only one. Unsaved entries are
 * kept in the tab and restored after Back or a reload.
 */
export default async function PlanTradePage() {
  const data = await loadTradeFormData();
  if (!data.accounts.length) return <NoTradingAccount kind="plan" hasArchived={data.hasArchived} />;
  const account = data.accounts.find(item => item.id === data.defaultAccountId) ?? null;
  return (
    <PlanTradeForm
      now={data.now}
      accounts={data.accounts}
      initial={newPlanDraft(account)}
      mode={{ kind: "create" }}
      evidenceCapacity={TRADE_EVIDENCE_LIMIT}
      autosaveKey={autosaveKey(data.autosaveScope, { form: "plan" })}
    />
  );
}
