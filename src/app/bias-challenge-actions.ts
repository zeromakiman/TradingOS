"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {unstable_rethrow} from "next/navigation";
import {challengeBias} from "@/lib/bias-challenge";
import type {ActionState} from "./actions";
export async function requestBiasChallenge(_state:ActionState,form:FormData):Promise<ActionState>{
 try {
  const id=z.uuid().parse(form.get("proposalId")),key=z.uuid().parse(form.get("requestKey")),evidence=z.array(z.uuid()).max(3).parse(form.getAll("evidence"));
  const result=await challengeBias(id,key,evidence);revalidatePath(`/analyze/${id}`);revalidatePath("/settings");
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 }catch(error){unstable_rethrow(error);return {error:error instanceof z.ZodError?"Select up to three screenshots from this proposal.":"Unable to request a challenge. Refresh to check history, ownership, locked state and AI configuration."};}
}
