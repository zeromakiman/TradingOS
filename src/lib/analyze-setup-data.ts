import "server-only";
import {z} from "zod";
import type {loadSetup} from "./setup-data";
import {accountAiAvailability} from "./ai-budget";
import {operationFor} from "@/ai/operations";
import {reservationMicros} from "@/ai/pricing";
import {analyzeSetupOutput} from "@/ai/analyze-setup-contract";
const requestSchema=z.object({id:z.uuid(),facts:z.object({currentThesis:z.string(),deterministic:z.object({status:z.enum(["RISK_APPROVED","TRADE_BLOCKED"])}).passthrough()}).passthrough(),operation:z.object({provider:z.string(),model:z.string(),version:z.string()}),created_at:z.string(),deadline_at:z.string()});
const resultSchema=z.object({challenge_id:z.uuid(),status:z.enum(["COMPLETED","FAILED"]),interpretation:analyzeSetupOutput.nullable(),error_code:z.string().nullable(),reservation_id:z.uuid().nullable(),created_at:z.string()});
/** Internal server loader: s is the authenticated, owner-scoped result of loadSetup; its db retains RLS. */
export async function loadAnalyzeSetupPanel(s:Awaited<ReturnType<typeof loadSetup>>,page=0){
 const amount=reservationMicros(undefined,operationFor("ANALYZE_SETUP")),base={amount,locked:Boolean(s.lock),riskStatus:s.risk.result.status,page};
 try{
  const availability=await accountAiAvailability(s.proposal.account_id,"ANALYZE_SETUP");
  const evidence=s.screenshots.filter(x=>x.user_id===s.user.id&&x.proposal_id===s.proposal.id&&!s.removals.some(r=>r.screenshot_id===x.id)).map(x=>({id:x.id,role:x.role,label:x.original_filename}));
  const q=await s.db.from("bias_challenges").select("id,facts,operation,created_at,deadline_at",{count:"exact"}).eq("operation->>id","ANALYZE_SETUP").eq("proposal_id",s.proposal.id).eq("user_id",s.user.id).order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*10,page*10+9);
  if(q.error)throw new Error("Analysis history unavailable");
  const rows=z.array(requestSchema).parse(q.data),ids=rows.map(r=>r.id);
  const [r,h]=ids.length?await Promise.all([s.db.from("bias_challenge_results").select("challenge_id,status,interpretation,error_code,reservation_id,created_at").in("challenge_id",ids),s.db.from("ai_request_reservations").select("id,operation_id,reserved_micros").eq("operation","ANALYZE_SETUP").in("operation_id",ids)]):[{data:[],error:null},{data:[],error:null}];
  if(r.error||h.error)throw new Error("Analysis results unavailable");
  const results=z.array(resultSchema).parse(r.data),holds=z.array(z.object({id:z.uuid(),operation_id:z.uuid(),reserved_micros:z.number()})).parse(h.data);
  const usage=holds.length?await s.db.from("ai_usage_records").select("reservation_id,charged_micros,disposition").in("reservation_id",holds.map(x=>x.id)):{data:[],error:null};
  if(usage.error)throw new Error("Accounting unavailable");
  const costs=z.array(z.object({reservation_id:z.uuid(),charged_micros:z.number(),disposition:z.string()})).parse(usage.data);
  const history=rows.map(row=>{const hold=holds.find(x=>x.operation_id===row.id);return {...row,result:results.find(x=>x.challenge_id===row.id)??null,accounting:hold?{reservedMicros:hold.reserved_micros,usage:costs.find(x=>x.reservation_id===hold.id)??null}:null};});
  return {...base,availability,evidence,history,hasOlder:(q.count??0)>(page+1)*10,error:null};
 }catch{return {...base,availability:{status:"CONFIGURATION_ERROR" as const,message:"Setup analyses are unavailable. Deterministic workflows remain available.",deepEnabled:false},evidence:[],history:[],hasOlder:false,error:"Unable to load analysis history/configuration. No analysis request can run."};}
}
export type AnalyzeSetupPanelData=Awaited<ReturnType<typeof loadAnalyzeSetupPanel>>;
