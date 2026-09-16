import { Shell } from "@/components/shell";
import { TradeWorkspace } from "@/components/trade-workspace";
import { AccountSetup } from "@/components/account-setup";
import { loadWorkspace } from "@/lib/data";
export const dynamic = "force-dynamic";
export default async function AnalyzePage({searchParams}:{searchParams:Promise<{account?:string}>}) {
  const {account} = await searchParams;
  const {current:c} = await loadWorkspace(account);
  return <Shell active="Analyze" accountId={c?.account.id}>{c ? <TradeWorkspace key={`${c.account.id}:${c.observation.id}:${c.riskPlan.id}`} context={c.context} instruments={c.instruments} accountId={c.account.id} observationId={c.observation.id}/> : <AccountSetup/>}</Shell>;
}
