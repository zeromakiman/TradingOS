"use server";
import { operationalFailure } from "@/lib/operational-log";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { cookies } from "next/headers";
import { isChunkLike } from "@supabase/ssr";
import { requireUser, supabaseServer } from "@/lib/supabase/server";
import { publicConfig } from "@/lib/supabase/config";
import { decimalString, moneyString, proposalSchema } from "@/domain/risk";
import { evaluationEnvelopeSchema, type RiskReport } from "@/domain/risk-report";

export type ActionState = { error?: string; success?: string };
function field(form: FormData, key: string) { return String(form.get(key) ?? ""); }
function fail(error: unknown): ActionState { unstable_rethrow(error); if(!(error instanceof z.ZodError))operationalFailure("database_write_failed"); return { error: error instanceof z.ZodError ? error.issues.map(i => i.message).join(" ") : "The request failed. Please try again." }; }
export async function login(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const email = z.email().parse(field(form, "email"));
    const password = z.string().min(1).max(256).parse(field(form, "password"));
    const db = await supabaseServer(true);
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) { operationalFailure("database_write_failed"); return { error: "Sign-in failed. Check your email and password." }; }
  } catch (e) { return fail(e); }
  redirect("/today");
}
export async function logout() {
  const config = publicConfig();
  if (config) {
    try { const db = await supabaseServer(true); await db.auth.signOut({ scope: "local" }); }
    finally {
      const jar = await cookies();
      for (const cookie of jar.getAll()) if (isChunkLike(cookie.name, config.cookiePrefix) || isChunkLike(cookie.name, `${config.cookiePrefix}-user`)) jar.delete(cookie.name);
    }
  }
  revalidatePath("/", "layout");
  redirect("/login?reason=signed_out");
}
export async function createAccount(_state: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const { db } = await requireUser();
    const { data, error } = await db.rpc("bootstrap_demo_account", { p_idempotency_key: z.uuid().parse(field(form, "key")), p_name: z.string().trim().min(1).max(100).parse(field(form, "name")), p_equity: moneyString.parse(field(form, "equity")), p_balance: moneyString.parse(field(form, "balance")) });
    if (error) { operationalFailure("database_write_failed"); return { error: "Account creation failed. Check the entered values and database setup." }; }
    id = z.string().uuid().parse(data);
  } catch (e) { return fail(e); }
  revalidatePath("/today");
  redirect(`/today?account=${id}`);
}
type EvaluationResponse = { error?: string; planId?: string; evaluationId?: string; result?: RiskReport };
async function assessPlan(input: unknown, locking: boolean): Promise<EvaluationResponse> {
  try {
    const { db } = await requireUser();
    const v = z.object({ accountId: z.uuid(), observationId: z.uuid(), riskPlanId: z.uuid(), key: z.uuid().optional(), proposal: proposalSchema }).strict().parse(input);
    if (locking && !v.key) return { error: "A lock request key is required." };
    const { data, error } = await db.rpc(locking ? "lock_trade_plan" : "evaluate_trade_plan", { p_account_id: v.accountId, p_proposal: v.proposal, ...(locking ? {p_idempotency_key:v.key} : {}), p_expected_risk_id: v.riskPlanId, p_expected_observation_id: v.observationId });
    if (error) { operationalFailure("database_write_failed"); return { error: error.message.includes("changed") ? "Account or risk plan changed. Refresh before checking again." : "The server could not save this risk decision. Refresh and try again." }; }
    const envelope = evaluationEnvelopeSchema.parse(data);
    if (!("reportVersion" in envelope.result)) return { error: "The server returned an unsupported report. Refresh and try again." };
    revalidatePath("/today"); revalidatePath("/journal");
    return { planId: envelope.planId ?? undefined, evaluationId: envelope.evaluationId, result: envelope.result };
  } catch (e) { return fail(e); }
}
export async function evaluatePlan(input: unknown): Promise<EvaluationResponse> { return assessPlan(input, false); }
export async function lockPlan(input: unknown): Promise<EvaluationResponse> { return assessPlan(input, true); }
export async function saveContext(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { db } = await requireUser();
    const { error } = await db.rpc("save_daily_context", { p_account_id: z.string().uuid().parse(field(form, "accountId")), p_narrative: z.string().max(20000).parse(field(form, "narrative")) });
    if (error) { operationalFailure("database_write_failed"); return { error: "Unable to save the daily context." }; }
    revalidatePath("/today"); return { success: "Context saved as a new revision." };
  } catch (e) { return fail(e); }
}
export async function addNote(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { db } = await requireUser();
    const planId = z.string().uuid().parse(field(form, "planId"));
    const { error } = await db.rpc("append_plan_note", { p_plan_id: planId, p_note: z.string().trim().min(1).max(5000).parse(field(form, "note")), p_request_key:z.uuid().parse(field(form,"requestKey")) });
    if (error) { operationalFailure("database_write_failed"); return { error: "Unable to append the note." }; }
    revalidatePath(`/journal/${planId}`); return { success: "Note appended. The original plan is unchanged." };
  } catch (e) { return fail(e); }
}
export async function saveObservation(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { db } = await requireUser();
    const loss = field(form, "grossLoss");
    if (loss && !/^\d{1,12}(\.\d{1,2})?$/.test(loss)) return { error: "Gross loss must be a nonnegative amount with up to two decimal places." };
    const { error } = await db.rpc("record_observation", { p_account_id: z.string().uuid().parse(field(form, "accountId")), p_equity: moneyString.parse(field(form, "equity")), p_balance: moneyString.parse(field(form, "balance")), p_gross_loss: loss || null });
    if (error) { operationalFailure("database_write_failed"); return { error: "Unable to save account observation." }; }
    revalidatePath("/today"); revalidatePath("/settings"); return { success: "A new account observation was recorded." };
  } catch (e) { return fail(e); }
}
export async function saveRiskPlan(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { db } = await requireUser();
    const config = z.object({ maxRiskPercent: decimalString, maxDailyTrades: z.coerce.number().int().min(1).max(100), minRR: decimalString, rrPolicy: z.enum(["BLOCK","WARN"]), newsPolicy: z.enum(["BLOCK","WARN"]), dailyRiskCap: moneyString.nullable(), dailyLossCap: moneyString.nullable() }).parse({ maxRiskPercent: field(form,"maxRiskPercent"), maxDailyTrades: field(form,"maxDailyTrades"), minRR: field(form,"minRR"), rrPolicy: field(form,"rrPolicy"), newsPolicy: field(form,"newsPolicy"), dailyRiskCap: field(form,"dailyRiskCap") || null, dailyLossCap: field(form,"dailyLossCap") || null });
    const { error } = await db.rpc("create_risk_version", { p_account_id: z.string().uuid().parse(field(form,"accountId")), p_config: config, p_immediate: form.get("immediate") === "on", p_reason: field(form,"reason") || null });
    if (error) { operationalFailure("database_write_failed"); return { error: "Unable to create this version. Check limits and provide a reason for any immediate change." }; }
    revalidatePath("/settings"); revalidatePath("/today"); return { success: form.get("immediate") === "on" ? "New version activated. Override recorded." : "New version scheduled for the next UTC−5 trading day." };
  } catch (e) { return fail(e); }
}
