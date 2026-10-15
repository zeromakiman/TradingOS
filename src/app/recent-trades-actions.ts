"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {unstable_rethrow} from "next/navigation";
import {analyzeRecentTrades} from "@/lib/recent-trades";
import {recentSample} from "@/ai/recent-trades-context";
import type {ActionState} from "./actions";
export async function requestRecentTrades(_state:ActionState,form:FormData):Promise<ActionState>{
 try {
  const account=z.uuid().parse(form.get("accountId")),key=z.uuid().parse(form.get("requestKey")),sample=recentSample(form.get("sample"));
  const result=await analyzeRecentTrades(account,sample,key);revalidatePath("/edge/recent");revalidatePath("/settings");
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 }catch(error){unstable_rethrow(error);return {error:"Unable to request an analysis. Choose 10, 20 or 30 completed trades and refresh to check history, account ownership and AI configuration."};}
}
