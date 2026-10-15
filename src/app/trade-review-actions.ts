"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { reviewTrade } from "@/lib/trade-review";
import type { ActionState } from "./actions";
export async function requestTradeReview(_state:ActionState,form:FormData):Promise<ActionState> {
 try {
  const plan=z.uuid().parse(form.get("planId")),id=z.uuid().parse(form.get("requestKey"));
  const evidence=z.array(z.uuid()).max(4).parse(form.getAll("evidence"));
  const result=await reviewTrade(plan,id,evidence);
  revalidatePath(`/journal/${plan}`);revalidatePath("/settings");
  // Terminal recorded attempts rotate the form idempotency key. Failures remain visible in history.
  return ["COMPLETED","FAILED","RECORDED"].includes(result.status)?{success:result.message}:{error:result.message};
 } catch(error){unstable_rethrow(error);return {error:error instanceof z.ZodError?"Select up to four screenshots from this trade.":"Unable to request a review. Refresh to check history, evidence, ownership and AI configuration before trying again."};}
}
