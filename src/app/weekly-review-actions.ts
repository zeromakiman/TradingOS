"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {unstable_rethrow} from "next/navigation";
import {reviewWeek} from "@/lib/weekly-review";
import {weeklyPeriod} from "@/ai/weekly-period";
import type {ActionState} from "./actions";
export async function requestWeeklyReview(_state:ActionState,form:FormData):Promise<ActionState>{
 try {
  const account=z.uuid().parse(form.get("accountId")),key=z.uuid().parse(form.get("requestKey")),week=weeklyPeriod(z.string().parse(form.get("week"))).startDate;
  const result=await reviewWeek(account,week,key);revalidatePath("/edge/weekly");revalidatePath("/settings");
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 }catch(error){unstable_rethrow(error);return {error:"Unable to request a weekly review. Choose a valid completed week and refresh to check history, account ownership and AI configuration."};}
}
