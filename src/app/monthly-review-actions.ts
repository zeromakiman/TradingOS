"use server";
import {z} from "zod";
import {revalidatePath} from "next/cache";
import {unstable_rethrow} from "next/navigation";
import {reviewMonth} from "@/lib/monthly-review";
import {monthlyPeriod} from "@/ai/monthly-period";
import type {ActionState} from "./actions";
export async function requestMonthlyReview(_state:ActionState,form:FormData):Promise<ActionState>{
 try {
  const account=z.uuid().parse(form.get("accountId")),key=z.uuid().parse(form.get("requestKey")),month=monthlyPeriod(z.string().parse(form.get("month"))).month;
  const result=await reviewMonth(account,month,key);revalidatePath("/edge/monthly");revalidatePath("/settings");
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 }catch(error){unstable_rethrow(error);return {error:"Unable to request a monthly review. Choose a valid completed month and refresh to check history, account ownership and AI configuration."};}
}
