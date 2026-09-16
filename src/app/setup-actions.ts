"use server";
import { setupRiskFeedback } from "@/domain/ux";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { operationalFailure } from "@/lib/operational-log";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { proposalSchema } from "@/domain/risk";
import type { ActionState } from "./actions";
export async function saveSetup(input:unknown):Promise<{id?:string;error?:string}>{
 try{
 const parsed=z.object({accountId:z.uuid(),observationId:z.uuid(),riskPlanId:z.uuid(),key:z.uuid(),proposal:proposalSchema}).strict().safeParse(input);
 if(!parsed.success)return {error:"Complete the proposed prices and narrative first."};
 const {db}=await requireUser(),v=parsed.data;
 const {data,error}=await db.rpc("save_setup_proposal",{p_account_id:v.accountId,p_proposal:v.proposal,p_key:v.key,p_expected_risk_id:v.riskPlanId,p_expected_observation_id:v.observationId});
 if(error)return {error:error.message.includes("changed")?"Account context changed. Refresh and try again.":"Unable to save the proposal. Please try again."};
 revalidatePath("/journal");return {id:z.uuid().parse(data)};
 }catch(e){return safeFailure(e);}
}
export async function importLockedSetup(_state:ActionState,form:FormData):Promise<ActionState>{
 try{
 const {db}=await requireUser();const id=z.uuid().parse(form.get("planId"));
 const {data,error}=await db.rpc("import_locked_setup",{p_plan_id:id});if(error)return {error:"Unable to open this plan’s analysis workspace."};
 redirect(`/analyze/${z.uuid().parse(data)}`);
 }catch(e){return safeFailure(e);}
}
export async function setupCommand(input:unknown):Promise<ActionState>{
 try{
 const v=z.object({id:z.uuid(),command:z.enum(["CHECK","LOCK","REMOVE","TAKEN","SKIPPED"]),reason:z.string().max(5000).optional()}).strict().parse(input);
 const {db}=await requireUser();
 const {data,error}=v.command==="REMOVE"?await db.rpc("remove_setup_screenshot",{p_screenshot_id:v.id}):v.command==="CHECK"||v.command==="LOCK"?await db.rpc("check_setup_risk",{p_proposal_id:v.id,p_lock:v.command==="LOCK"}):await db.rpc("record_setup_decision",{p_proposal_id:v.id,p_decision:v.command,p_reason:v.reason||null});
 if(error)return {error:"The command could not be saved. Refresh to check the latest history."};
 revalidatePath("/analyze","layout");revalidatePath("/journal","layout");revalidatePath("/today");
 return {success:v.command==="LOCK"||v.command==="CHECK"?setupRiskFeedback(data,v.command==="LOCK"):"Saved to the permanent history."};
 }catch(e){return safeFailure(e);}
}

function safeFailure(e:unknown):ActionState{unstable_rethrow(e);if(!(e instanceof z.ZodError))operationalFailure("database_write_failed");return {error:e instanceof z.ZodError?"Check the submitted values and try again.":"Unable to save this change. Please try again."};}
