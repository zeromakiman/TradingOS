"use server";
import { operationalFailure } from "@/lib/operational-log";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import type { ActionState } from "./actions";
import { grades,liquidityTypes } from "@/domain/analytics";
const decimal=z.string().regex(/^\d{1,12}(\.\d{1,8})?$/);
const timestamp=z.string().refine(v=>/(Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v)),"Use an ISO timestamp with Z or an explicit timezone offset.");
export async function journalAction(_state:ActionState,form:FormData):Promise<ActionState>{
 try{
  const {db}=await requireUser();
  const v=Object.fromEntries(form),id=z.uuid().parse(v.planId),action=z.enum(["open","close","disposition","tags"]).parse(v.action);
  let result:{error:{message:string}|null};
  if(action==="open")result=await db.rpc("open_journal_trade",{p_plan_id:id,p_entry:decimal.parse(v.entry),p_quantity:decimal.parse(v.quantity),p_entered_at:timestamp.parse(v.enteredAt)});
  else if(action==="close")result=await db.rpc("close_journal_trade",{p_plan_id:id,p_exit:decimal.parse(v.exit),p_exited_at:timestamp.parse(v.exitedAt),p_fees:z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).parse(v.fees)});
  else if(action==="disposition")result=await db.rpc("set_journal_disposition",{p_plan_id:id,p_status:z.enum(["SKIPPED","CANCELLED"]).parse(v.status),p_reason:z.string().trim().min(1).max(5000).parse(v.reason)});
  else result=await db.rpc("tag_journal_trade",{p_plan_id:id,p_grade:v.grade?z.enum(grades).parse(v.grade):null,p_liquidity:v.liquidity?z.enum(liquidityTypes).parse(v.liquidity):null,p_mss:v.mss?z.enum(["M15","M5","M3"]).parse(v.mss):null});
  if(result.error)return {error:journalError(result.error.message)};
  revalidatePath("/journal");revalidatePath(`/journal/${id}`);revalidatePath("/edge");revalidatePath("/today");
  return {success:action==="close"?"Trade closed. Its result is available in EDGE.":action==="open"?"Actual entry recorded. The trade is now active.":action==="tags"?"Tag revision saved.":"Disposition recorded. The original plan remains preserved."};
 }catch(e){unstable_rethrow(e);if(!(e instanceof z.ZodError))operationalFailure("database_write_failed");return {error:e instanceof z.ZodError?"Check prices and quantity are positive decimals, fees use at most two decimal places, and timestamps include Z or a timezone offset.":"Unable to save the journal record."};}
}

function journalError(message:string){
 if(/before.*(lock|entry)|timestamp|future|time/i.test(message))return "Check the timestamps: entry must be on or after lock, and exit on or after entry. Future times are not allowed.";
 if(/already|closed|execution|disposition/i.test(message))return "This trade’s status has changed. Refresh to see its current record before saving again.";
 if(/quantity|price|fees|tick|positive/i.test(message))return "Check price, quantity and fees against the instrument’s contract values.";
 return "Unable to save this record. Refresh to check the latest history, then try again.";
}
