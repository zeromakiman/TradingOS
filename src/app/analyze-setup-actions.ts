"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {unstable_rethrow} from "next/navigation";
import {analyzeSetup} from "@/lib/analyze-setup";
import type {ActionState} from "./actions";
export async function requestAnalyzeSetup(_state:ActionState,form:FormData):Promise<ActionState>{
 try {
  const id=z.uuid().parse(form.get("proposalId")),key=z.uuid().parse(form.get("requestKey")),evidence=z.array(z.uuid()).max(3).parse(form.getAll("evidence"));
  const result=await analyzeSetup(id,key,evidence);revalidatePath(`/analyze/${id}`);revalidatePath("/settings");
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 }catch(error){unstable_rethrow(error);return {error:error instanceof z.ZodError?"Select up to three screenshots from this proposal.":"Unable to request an analysis. Refresh to check history, ownership, locked state and AI configuration."};}
}
