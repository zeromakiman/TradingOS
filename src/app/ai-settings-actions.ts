"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "./actions";
import { requireUser } from "@/lib/supabase/server";
import { aiSystemAvailability } from "@/lib/ai-budget";
import { budgetCents } from "@/ai/budget";

async function save(form:FormData,kind:"BUDGET"|"ACTIVATION"):Promise<ActionState> {
 try {
  const {db}=await requireUser();
  const account=z.uuid().parse(form.get("accountId"));
  const enabled=kind==="ACTIVATION"?z.enum(["true","false"]).parse(form.get("enabled"))==="true":null;
  const confirm=form.get("confirm")==="on";
  if(enabled&&!confirm)return {error:"Confirm the AI data-sharing disclosure before enabling."};
  if(enabled&&aiSystemAvailability().status!=="ENABLED")return {error:"AI is unavailable in this deployment. Your account has not been enabled."};
  const cents=kind==="BUDGET"?budgetCents(String(form.get("budget")??"")):null;
  const {error}=await db.rpc("set_account_ai_preferences",{p_account_id:account,p_enabled:enabled,p_budget_cents:cents,p_confirm:confirm});
  if(error)return {error:"AI settings were not saved. Check account access and try again."};
  revalidatePath("/settings");revalidatePath("/analyze","layout");
  return {success:kind==="BUDGET"?"Monthly AI budget saved. Existing usage is unchanged.":enabled?"AI enabled for this account. Requests still require available budget.":"AI disabled for future requests. Existing evaluations and history are preserved."};
 } catch(error) {
  unstable_rethrow(error);
  return {error:error instanceof z.ZodError?"Invalid AI settings.":kind==="BUDGET"&&error instanceof Error&&error.message.startsWith("Monthly budget")?error.message:"Unable to save AI settings. Check the amount and try again."};
 }
}
export async function saveAiBudget(_state:ActionState,form:FormData){return save(form,"BUDGET");}
export async function saveAiActivation(_state:ActionState,form:FormData){return save(form,"ACTIVATION");}
