import "server-only";
import { z } from "zod";
import { notFound } from "next/navigation";
import { requireUser } from "./supabase/server";
import { proposalSchema } from "@/domain/risk";
import { storedRiskSchema } from "@/domain/risk-report";
export const setupRow=z.object({id:z.uuid(),user_id:z.uuid(),account_id:z.uuid(),strategy_version_id:z.uuid(),instrument_version_id:z.uuid(),risk_evaluation_id:z.uuid(),proposal:proposalSchema,created_at:z.string()});
export const screenshotRow=z.object({id:z.uuid(),user_id:z.uuid(),account_id:z.uuid(),proposal_id:z.uuid(),role:z.string(),storage_path:z.string(),original_filename:z.string(),mime_type:z.string(),byte_size:z.number(),sha256:z.string(),width:z.number(),height:z.number(),uploaded_at:z.string()});
export type Screenshot=z.infer<typeof screenshotRow>;
export async function loadSetup(id:string){
 if(!z.uuid().safeParse(id).success)notFound();
 const {db,user}=await requireUser();
 const {data,error}=await db.from("setup_proposals").select("*").eq("id",id).eq("user_id",user.id).maybeSingle();
 if(error)throw new Error("Unable to load the saved proposal. Please try again.");if(!data)notFound();
 const proposal=setupRow.parse(data);
 const results=await Promise.all([
  db.from("strategy_versions").select("id,version,rules,written_rules").eq("id",proposal.strategy_version_id).eq("account_id",proposal.account_id).single(),
  db.from("instrument_versions").select("id,symbol").eq("id",proposal.instrument_version_id).eq("account_id",proposal.account_id).single(),
  db.from("setup_screenshots").select("*").eq("proposal_id",id).order("uploaded_at"),
  db.from("setup_screenshot_removals").select("screenshot_id,recorded_at").eq("proposal_id",id),
  // 0007 retains the legacy FK, so select the complete proposal/evaluation relationship explicitly.
  db.from("setup_evaluations").select("*,events:setup_evaluation_events(*),passes:setup_evaluation_passes(*),screenshots:setup_evaluation_screenshots!evidence_same_proposal(screenshot_id)").eq("proposal_id",id).order("created_at",{ascending:false}).order("id",{ascending:false}),
  db.from("setup_human_decisions").select("*").eq("proposal_id",id).order("recorded_at",{ascending:false}),
  db.from("setup_locks").select("plan_id,created_at").eq("proposal_id",id),
  db.from("setup_risk_checks").select("id,risk:risk_evaluations(id,result,recorded_at)").eq("proposal_id",id).order("id",{ascending:false})
 ]);
 if(results.some(r=>r.error))throw new Error("Unable to load setup history.");
 const strategy=z.object({id:z.uuid(),version:z.string(),rules:z.record(z.string(),z.unknown()),written_rules:z.string()}).parse(results[0].data);
 const instrument=z.object({id:z.uuid(),symbol:z.string()}).parse(results[1].data);
 const screenshots=z.array(screenshotRow).parse(results[2].data);
 const removals=z.array(z.object({screenshot_id:z.uuid(),recorded_at:z.string()})).parse(results[3].data);
 const evaluations=z.array(evaluationRow).parse(results[4].data);
 const decisions=z.array(z.object({id:z.uuid(),decision:z.string(),event_type:z.string(),reason:z.string().nullable(),recorded_at:z.string(),ai_decision:z.string(),ai_context_status:z.string(),risk_decision:z.string()})).parse(results[5].data);
 const locks=z.array(z.object({plan_id:z.uuid(),created_at:z.string()})).parse(results[6].data);
 const risks=z.array(z.object({id:z.number(),risk:z.object({id:z.uuid(),result:storedRiskSchema,recorded_at:z.string()})})).parse(results[7].data);
 if(!risks.length)throw new Error("Saved risk report is missing");
 const riskVersionResult=await db.from("risk_plan_versions").select("version").eq("id",risks[0].risk.result.riskPlanVersionId).single();
 if(riskVersionResult.error)throw new Error("Unable to load the checked risk-plan version.");
 const riskVersion=z.object({version:z.string()}).parse(riskVersionResult.data).version;
 return {riskVersion,db,user,proposal,strategy,instrument,screenshots,removals,evaluations,decisions,lock:locks[0]??null,risks,risk:risks[0].risk};
}
export const evaluationRow=z.object({id:z.uuid(),proposal_id:z.uuid(),strategy_version_id:z.uuid(),mode:z.string(),model:z.string(),evaluator_version:z.string(),input_hash:z.string(),manifest:z.unknown(),created_at:z.string(),deadline_at:z.string(),events:z.array(z.object({id:z.number(),status:z.enum(["QUEUED","RUNNING","COMPLETED","FAILED"]),payload:z.record(z.string(),z.unknown()),created_at:z.string()})),passes:z.array(z.object({id:z.uuid(),stage:z.string(),status:z.string(),model:z.string(),response_id:z.string().nullable(),usage:z.unknown(),output:z.unknown(),error_code:z.string().nullable()})),screenshots:z.array(z.object({screenshot_id:z.uuid()}))});
export type EvaluationRow=z.infer<typeof evaluationRow>;
export function evaluationState(e:EvaluationRow){
 const event=[...e.events].sort((a,b)=>b.id-a.id)[0];
 return event?.status==="COMPLETED"||event?.status==="FAILED"?event.status:Date.parse(e.deadline_at)<Date.now()?"FAILED":event?.status??"QUEUED";
}
