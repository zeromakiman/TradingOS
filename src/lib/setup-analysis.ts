import "server-only";
import { createHash } from "node:crypto";
import { loadSetup } from "./setup-data";
import { trustedServer } from "./supabase/admin";
import { SCREENSHOT_BUCKET } from "./screenshots";
import { EVALUATOR_VERSION, GRADING_CONFIG, modelConfig, SCHEMA_VERSION } from "@/ai/config";
import { SYSTEM_PROMPT } from "@/ai/analysis-prompt";
import { chartEvaluationSchema } from "@/ai/chart-contract";
import { callResponses, ProviderError } from "@/ai/provider";
import { runEvaluation } from "@/ai/run";
import { aiAvailability } from "@/ai/availability";
function canonical(value:unknown):string{if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;return JSON.stringify(value);}
const hash=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");
export async function analyzeSetup(proposalId:string,evaluationId:string,mode:"NORMAL"|"DEEP"){
 const availability=aiAvailability();
 if(availability.status==="DISABLED")return {status:"DISABLED" as const,message:availability.message};
 if(availability.status==="CONFIGURATION_ERROR")throw new Error(availability.message);
 const s=await loadSetup(proposalId),config=modelConfig(),key=process.env.OPENAI_API_KEY;
 if(!key)throw new Error("OpenAI is not configured. Add OPENAI_API_KEY to .env.local and restart; never paste the key into chat.");
 if(mode==="DEEP"&&!config.deepEnabled)throw new Error("Deep review is disabled by server configuration.");
 const prior=s.evaluations.find(e=>e.id===evaluationId);if(prior)return {id:prior.id,replayed:true};
 const admin=trustedServer(), screenshots=s.screenshots.filter(x=>!s.removals.some(r=>r.screenshot_id===x.id));
 if(!screenshots.length||screenshots.length>8)throw new Error("Select between 1 and 8 screenshots before analysis.");
 const definition={version:EVALUATOR_VERSION,schema_version:SCHEMA_VERSION,system_prompt:SYSTEM_PROMPT,json_schema:chartEvaluationSchema,config:GRADING_CONFIG};
 const versionHash=hash(definition);
 const {error:versionError}=await admin.from("evaluator_versions").upsert({...definition,sha256:versionHash},{onConflict:"version",ignoreDuplicates:true});
 if(versionError)throw new Error("Unable to preserve evaluator version.");
 const {data:version,error:readVersion}=await admin.from("evaluator_versions").select("sha256").eq("version",EVALUATOR_VERSION).single();
 if(readVersion||version?.sha256!==versionHash)throw new Error("Evaluator version changed. Create a new prompt version before running.");
 const risk=s.risk.result;
 const manifest={proposal_id:s.proposal.id,strategy:s.strategy,instrument:s.instrument,proposal:s.proposal.proposal,risk_plan_version_id:risk.riskPlanVersionId,risk_evaluation_id:s.risk.id,planned_rr:risk.calculations?.plannedRR??null,session:risk.session,evaluated_at:risk.evaluatedAt,config,evaluator_version:EVALUATOR_VERSION,evaluator_hash:versionHash,screenshots:screenshots.map(x=>({id:x.id,role:x.role,sha256:x.sha256,mime_type:x.mime_type,byte_size:x.byte_size,width:x.width,height:x.height}))};
 const inputHash=hash(manifest), deadline=new Date(Date.now()+12*60*1000).toISOString();
 const {error:startError}=await admin.rpc("start_setup_evaluation",{p_record:{id:evaluationId,user_id:s.user.id,proposal_id:s.proposal.id,evaluator_version:EVALUATOR_VERSION,mode,model:config.model,manifest,input_hash:inputHash,deadline_at:deadline},p_screenshots:screenshots.map(x=>x.id)});
 if(startError)throw new Error(startError.message.includes("already running")?"An analysis is already running. Its status survives refresh.":"Could not reserve the analysis. Refresh and try again.");
 try{
  const images:{sourceId:string;role:string;dataUrl:string}[]=[];
  for(const image of screenshots){
   // User-scoped download independently rechecks Storage RLS and prevents arbitrary URL/ID access.
   const {data,error}=await s.db.storage.from(SCREENSHOT_BUCKET).download(image.storage_path);
   if(error||!data)throw new ProviderError("SCREENSHOT_UNAVAILABLE");
   const bytes=Buffer.from(await data.arrayBuffer());
   if(bytes.length!==image.byte_size||createHash("sha256").update(bytes).digest("hex")!==image.sha256)throw new ProviderError("SCREENSHOT_CHANGED");
   images.push({sourceId:image.id,role:image.role,dataUrl:`data:${image.mime_type};base64,${bytes.toString("base64")}`});
  }
  const ruleIds=Object.keys((s.strategy.rules.rules??{}) as object);
  const ctx={inputHash,direction:s.proposal.proposal.direction,setupModel:s.proposal.proposal.model,strategyVersionId:s.strategy.id,riskPlanVersionId:risk.riskPlanVersionId,instrument:s.instrument.symbol,sources:Object.fromEntries([["user-report","USER_REPORT" as const],...screenshots.map(x=>[x.id,"CHART_IMAGE" as const])]),ruleIds,blockingRuleIds:ruleIds,proposalId:s.proposal.id,oteParametersAvailable:s.strategy.rules.ote_parameters!=null};
  const result=await runEvaluation({mode,model:config.model,context:ctx,call:(role,id,prior)=>callResponses({apiKey:key,config,context:{...ctx,analysisId:id,role,manifest},images,prior}),savePass:async record=>{
   const {error}=await admin.from("setup_evaluation_passes").insert({...record,user_id:s.user.id,account_id:s.proposal.account_id,evaluation_id:evaluationId});
   if(error)throw new Error("PASS_PERSISTENCE_FAILED");
  }});
  const {error}=await admin.rpc("finish_setup_evaluation",{p_id:evaluationId,p_status:"COMPLETED",p_payload:{result}});if(error)throw new Error("COMPLETION_PERSISTENCE_FAILED");
 }catch(e){
  const code=e instanceof ProviderError?e.code:"PERSISTENCE_OR_PROCESSING_ERROR";
  const {error}=await admin.rpc("finish_setup_evaluation",{p_id:evaluationId,p_status:"FAILED",p_payload:{error:code}});
  if(error)throw new Error("The review could not finish saving. Its pending record will expire; check the history before retrying.");
 }
 return {id:evaluationId,replayed:false};
}
