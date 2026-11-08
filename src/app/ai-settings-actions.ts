"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "./actions";
import { errorCode } from "./actions/state";
import { aiSystemAvailability } from "@/lib/ai-budget";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { budgetCents } from "@/ai/budget";

/**
 * Settings → AI (docs/V2_ARCHITECTURE.md §11.2, §13.10): the V1 `set_account_ai_preferences` with the user's session,
 * behind the schema gate like every V2 action. On an archived account the database takes only turning AI off (which is
 * never blocked: it withdraws the consent and stops the spending); turning AI on or a new limit is refused with
 * ACCOUNT_ARCHIVED until the account is restored (§3.2).
 */

// Not exported: a "use server" module exports its actions only.
const AI_SETTINGS_ARCHIVED_COPY = "This trading account is archived. Restore it in Manage account to turn AI on or change its monthly limit.";

async function save(form:FormData,kind:"BUDGET"|"ACTIVATION"):Promise<ActionState> {
 try {
  const session=await writableSession();
  if(!session)return {error:SCHEMA_OUTDATED_MESSAGE};
  const account=z.uuid().parse(form.get("accountId"));
  const enabled=kind==="ACTIVATION"?z.enum(["true","false"]).parse(form.get("enabled"))==="true":null;
  const confirm=form.get("confirm")==="on";
  if(enabled&&!confirm)return {error:"Confirm the AI data-sharing disclosure before enabling."};
  if(enabled&&aiSystemAvailability().status!=="ENABLED")return {error:"AI is unavailable in this deployment. Your account has not been enabled."};
  const cents=kind==="BUDGET"?budgetCents(String(form.get("budget")??"")):null;
  const {error}=await session.db.rpc("set_account_ai_preferences",{p_account_id:account,p_enabled:enabled,p_budget_cents:cents,p_confirm:confirm});
  if(error)return {error:errorCode(error)==="ACCOUNT_ARCHIVED"?AI_SETTINGS_ARCHIVED_COPY:"AI settings were not saved. Check account access and try again."};
  revalidatePath("/settings");revalidatePath("/analyze","layout");
  return {success:kind==="BUDGET"?"Monthly AI budget saved. Existing usage is unchanged.":enabled?"AI enabled for this account. Requests still require available budget.":"AI disabled for future requests. Existing evaluations and history are preserved."};
 } catch(error) {
  unstable_rethrow(error);
  return {error:error instanceof z.ZodError?"Invalid AI settings.":kind==="BUDGET"&&error instanceof Error&&error.message.startsWith("Monthly budget")?error.message:"Unable to save AI settings. Check the amount and try again."};
 }
}
export async function saveAiBudget(_state:ActionState,form:FormData){return save(form,"BUDGET");}
export async function saveAiActivation(_state:ActionState,form:FormData){return save(form,"ACTIVATION");}
