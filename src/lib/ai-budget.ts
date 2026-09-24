import "server-only";
import { requireUser } from "./supabase/server";
import { trustedServer } from "./supabase/admin";
import { aiAvailability, type AiAvailability } from "@/ai/availability";
import { budgetPresentation, budgetSnapshotSchema } from "@/ai/budget";
import { operationFor } from "@/ai/operations";
import { operationPricing, reservationMicros } from "@/ai/pricing";
import type { AiLedger } from "@/ai/request-gate";
import { ProviderError } from "@/ai/provider";
import { z } from "zod";

export function aiSystemAvailability(): AiAvailability {
 const global=aiAvailability();
 if(global.status!=="ENABLED")return global;
 try {
  operationPricing(operationFor("SETUP_ANALYSIS"));
  if(!process.env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_"))throw new Error("Missing ledger credentials");
  return global;
 } catch {return {status:"CONFIGURATION_ERROR",message:"AI provider or budget-accounting configuration requires review. Other workflows remain available.",deepEnabled:false};}
}
const auditSchema=z.object({id:z.number(),previous_enabled:z.boolean(),enabled:z.boolean(),previous_budget_cents:z.number(),budget_cents:z.number(),created_at:z.string()});
export async function loadAiBudget(accountId:string) {
 const {db}=await requireUser();
 const system=aiSystemAvailability();
 try {
  const {data,error}=await db.rpc("get_account_ai_budget",{p_account_id:z.uuid().parse(accountId)});
  if(error)throw new Error("Budget unavailable");
  const snapshot=budgetSnapshotSchema.parse(data), presentation=budgetPresentation(snapshot,system.status==="ENABLED");
  const {data:events,error:auditError}=await db.from("ai_preference_events").select("id,previous_enabled,enabled,previous_budget_cents,budget_cents,created_at").eq("account_id",accountId).order("id",{ascending:false}).limit(12);
  if(auditError)throw new Error("Audit unavailable");
  return {snapshot,presentation,system,events:z.array(auditSchema).parse(events),reservationMicros:reservationMicros(),error:null};
 } catch {return {snapshot:null,presentation:null,system,events:[],reservationMicros:reservationMicros(),error:"AI budget controls are unavailable. No AI request can run; other Trading OS workflows remain available."};}
}
export async function accountAiAvailability(accountId:string,operationId="SETUP_ANALYSIS"):Promise<AiAvailability> {
 const system=aiSystemAvailability();
 if(system.status!=="ENABLED")return system;
 const data=await loadAiBudget(accountId);
 if(!data.snapshot||!data.presentation)return {status:"CONFIGURATION_ERROR",message:data.error??"AI accounting is unavailable",deepEnabled:false};
 if(data.presentation.state==="UNAVAILABLE")return {status:"CONFIGURATION_ERROR",message:"AI accounting requires review. No further AI requests can run.",deepEnabled:false};
 if(!data.snapshot.enabled)return {status:"ACCOUNT_OFF",message:"AI is OFF for this account. Enable it explicitly in Settings.",deepEnabled:false};
 if(data.presentation.state==="BUDGET REACHED"||data.presentation.remainingMicros<reservationMicros(operationPricing(operationFor(operationId)),operationFor(operationId)))return {status:"BUDGET_REACHED",message:"The AI budget cannot cover the required request reservation. Review your limit and usage in Settings.",deepEnabled:false};
 return system;
}
export function serverAiLedger():AiLedger {
 const admin=trustedServer();
 async function rpc(name:string,args:Record<string,unknown>) {
  const {error}=await admin.rpc(name,args);
  if(error)throw new ProviderError(name==="settle_account_ai_request"?"AI_ACCOUNTING_PERSISTENCE_FAILED":"AI_BUDGET_OR_PERMISSION_CHANGED");
 }
 return {
  reserve:r=>rpc("reserve_account_ai_request",{p_id:r.id,p_user_id:r.userId,p_account_id:r.accountId,p_operation_id:r.operationId,p_stage:r.stage,p_request_hash:r.hash,p_model:r.model,p_pricing:r.pricing,p_reserved_micros:r.amount,p_operation:r.operation,p_provider:r.provider}),
  dispatch:(id,user,hash)=>rpc("dispatch_account_ai_request",{p_id:id,p_user_id:user,p_request_hash:hash}),
  recheck:(id,user,hash)=>rpc("dispatch_account_ai_request",{p_id:id,p_user_id:user,p_request_hash:hash,p_recheck:true}),
  settle:(id,user,record)=>rpc("settle_account_ai_request",{p_id:id,p_user_id:user,p_record:record}),
 };
}
