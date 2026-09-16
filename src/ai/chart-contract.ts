import { z } from "zod";
import legacySchema from "./evaluation.schema.json";
import { validateEvaluation, type AiAssessment, type EvaluationContext } from "./validate";

const quality = z.enum(["STRONG","MODERATE","WEAK","UNKNOWN"]);
const evidenceClass = z.enum(["OBSERVED","USER_REPORTED","INFERRED","UNKNOWN"]);
const refs = z.array(z.string().min(1));
const fact = z.object({ value:z.enum(["YES","NO","UNKNOWN"]), evidence_class:evidenceClass, evidence_ids:refs, explanation:z.string().min(1) }).strict();
const price = z.object({ value:z.string().regex(/^\d{1,12}(\.\d{1,8})?$/).nullable(), evidence_class:evidenceClass, evidence_ids:refs }).strict();
const detail = { evidence_ids:refs, uncertainties:z.array(z.string().min(1)) };
export const chartDetailsSchema = z.object({
 mss:z.object({status:z.enum(["CONFIRMED","PROBABLE","NOT_CONFIRMED","NOT_PRESENT","UNKNOWN"]),quality,timeframe:z.string().min(1),broken_swing_importance:z.string().min(1),preceding_liquidity:z.string().min(1),expansion:z.string().min(1),...detail}).strict(),
 displacement:z.object({status:z.enum(["CONFIRMED","PROBABLE","NOT_PRESENT","UNKNOWN"]),quality,description:z.string().min(1),...detail}).strict(),
 liquidity_events:z.array(z.object({type:z.enum(["ARL_HIGH","ARL_LOW","PDH","PDL","PWH","PWL","KZ_HIGH","KZ_LOW","EQUAL_HIGHS","EQUAL_LOWS","SWING_HIGH","SWING_LOW","OTHER"]),status:z.enum(["SWEPT","TARGETED","PRESENT","UNKNOWN"]),evidence_class:evidenceClass,description:z.string().min(1),confidence:z.enum(["HIGH","MEDIUM","LOW","UNKNOWN"]),evidence_ids:refs}).strict()),
 order_block:z.object({candidate_present:fact,direction:z.enum(["LONG","SHORT","UNKNOWN"]),timeframe:z.string().min(1),validity:z.enum(["VALID","PROBABLE","INVALID","UNKNOWN"]),proximal_price_if_readable:price,distal_price_if_readable:price,reversal_candle_identified:fact,caused_displacement:fact,first_touch_status:z.enum(["CONFIRMED","USER_REPORTED","NOT_FIRST_TOUCH","UNKNOWN"]),first_touch_evidence_ids:refs,coverage_description:z.string().min(1),mitigation_status:z.enum(["UNMITIGATED","FIRST_MITIGATION","PREVIOUSLY_MITIGATED","UNKNOWN"]),...detail}).strict(),
 ote:z.object({leg_identified:fact,swing_high:price,swing_low:price,retracement_zone_low:price,retracement_zone_high:price,parameters_available:z.boolean(),screenshot_support:fact,strategy_consistency:z.enum(["VALID","PROBABLE","INVALID","UNKNOWN"]),...detail}).strict(),
 target:z.object({type:z.enum(["ARL","PDH","PDL","PWH","PWL","KZ_EXTREME","EXTERNAL_LIQUIDITY","PREVIOUS_DAY_50","STRUCTURAL_LIQUIDITY","OTHER","UNKNOWN"]),validity:z.enum(["VALID","PROBABLE","INVALID","UNKNOWN"]),evidence_class:evidenceClass,contradictions:z.array(z.string().min(1)),...detail}).strict(),
 evidence_quality:z.object({level:z.enum(["HIGH","MEDIUM","LOW","UNKNOWN"]),rationale:z.string().min(1),evidence_ids:refs}).strict(),
}).strict();
export type ChartDetails=z.infer<typeof chartDetailsSchema>;
export type SetupDecision="APPROVED"|"CONDITIONAL"|"BLOCKED"|"INSUFFICIENT_EVIDENCE";
export interface ChartEvaluation {schema_version:"2.0";trade_plan_id:string;decision:SetupDecision;assessment:AiAssessment;chart_details:ChartDetails}
// Reuse the original strict contract and semantic validator; preserve schema 1.0 as a historical artifact.
const detailsJson=z.toJSONSchema(chartDetailsSchema,{target:"draft-7"});
delete detailsJson.$schema;
const { $defs, ...core }=legacySchema;
export const chartEvaluationSchema={type:"object",additionalProperties:false,properties:{
 schema_version:{type:"string",enum:["2.0"]},trade_plan_id:{type:"string"},decision:{type:"string",enum:["APPROVED","CONDITIONAL","BLOCKED","INSUFFICIENT_EVIDENCE"]},assessment:core,chart_details:detailsJson,
},required:["schema_version","trade_plan_id","decision","assessment","chart_details"],$defs};
export function validateChartEvaluation(raw:unknown,ctx:EvaluationContext & {proposalId:string;oteParametersAvailable:boolean}):ChartEvaluation {
 const root=z.object({schema_version:z.literal("2.0"),trade_plan_id:z.literal(ctx.proposalId),decision:z.enum(["APPROVED","CONDITIONAL","BLOCKED","INSUFFICIENT_EVIDENCE"]),assessment:z.unknown(),chart_details:chartDetailsSchema}).strict().parse(raw);
 const a=validateEvaluation(root.assessment,ctx), d=root.chart_details;
 const findings=[...a.missing_evidence,...a.uncertainties,...a.contradictions,...a.warnings,...a.rule_violations];
 if([...a.observed_evidence,...a.user_reported_evidence,...a.inferred_evidence,...findings].some(x=>!x.id.startsWith(`${ctx.analysisId}:`)))throw new Error("Evidence and finding IDs must be scoped to this pass");
 if ((root.decision==="INSUFFICIENT_EVIDENCE" ? "CONDITIONAL":root.decision)!==a.qualitative_decision) throw new Error("Contradictory AI decisions");
 if (root.decision==="INSUFFICIENT_EVIDENCE" && !a.missing_evidence.some(x=>x.material_to_decision)) throw new Error("Insufficient evidence requires a material gap");
 const observed=new Set(a.observed_evidence.map(x=>x.id)), reported=new Set(a.user_reported_evidence.map(x=>x.id)), inferred=new Set(a.inferred_evidence.map(x=>x.id));
 const all=new Set([...observed,...reported,...inferred]);
 function walk(value:unknown):void {
  if(Array.isArray(value)){value.forEach(walk);return;} if(!value||typeof value!=="object")return;
  const v=value as Record<string,unknown>, ids=(v.evidence_ids??[]) as string[];
  if(ids.some(id=>!all.has(id)))throw new Error("Unknown chart evidence reference");
  const set=v.evidence_class==="OBSERVED"?observed:v.evidence_class==="USER_REPORTED"?reported:v.evidence_class==="INFERRED"?inferred:null;
  if(set&&(!ids.length||ids.some(id=>!set.has(id))))throw new Error("Evidence class conflicts with provenance");
  if(typeof v.value==="string" && /^\d/.test(v.value) && (v.evidence_class!=="OBSERVED"||!ids.length))throw new Error("Readable prices require direct chart evidence");
  if(v.value!==undefined&&v.value!==null&&v.value!=="UNKNOWN"&&!ids.length)throw new Error("Chart fact requires evidence");
  Object.values(v).forEach(walk);
 }
 walk(d);
 for(const [finding,coreFinding] of [[d.mss,a.mss],[d.displacement,a.displacement]] as const){
  if(finding.status==="CONFIRMED"&&(coreFinding.status!=="SUPPORTED"||!finding.evidence_ids.some(id=>observed.has(id))))throw new Error("Confirmed structure requires observed evidence");
  if(finding.status==="UNKNOWN"&&finding.quality!=="UNKNOWN")throw new Error("Unknown structure cannot have a quality rating");
 }
 const qualities:Record<string,string>={STRONG:"STRONG",ADEQUATE:"MODERATE",WEAK:"WEAK",AMBIGUOUS:"UNKNOWN",UNKNOWN:"UNKNOWN"};
 if(d.mss.quality!==qualities[a.mss_quality]||d.displacement.quality!==qualities[a.displacement_quality])throw new Error("Detailed and core quality ratings disagree");
 if(d.order_block.first_touch_evidence_ids.some(id=>!all.has(id)))throw new Error("Unknown first-touch evidence reference");
 if(d.order_block.first_touch_status==="CONFIRMED"&&(!d.order_block.first_touch_evidence_ids.length||d.order_block.first_touch_evidence_ids.some(id=>!observed.has(id))||a.order_block.first_touch.status!=="SUPPORTED"))throw new Error("First touch is not independently supported");
 if(d.order_block.first_touch_status==="USER_REPORTED"&&(!d.order_block.first_touch_evidence_ids.length||d.order_block.first_touch_evidence_ids.some(id=>!reported.has(id))))throw new Error("First-touch assertion lacks user provenance");
 if(!ctx.oteParametersAvailable&&(d.ote.parameters_available||a.ote.versioned_parameters_available==="YES"||d.ote.strategy_consistency==="VALID"||d.ote.retracement_zone_low.value!==null||d.ote.retracement_zone_high.value!==null))throw new Error("Missing OTE parameters cannot be invented");
 if(root.decision==="APPROVED"&&(d.mss.status!=="CONFIRMED"||d.displacement.status!=="CONFIRMED"||d.target.validity!=="VALID"||(ctx.setupModel==="OB_FIRST_TOUCH"&&(d.order_block.validity!=="VALID"||d.order_block.first_touch_status!=="CONFIRMED"||d.order_block.timeframe!=="M5"))))throw new Error("Approval conflicts with chart details");
 return {...root,assessment:a};
}
export function scoreSetup(a:AiAssessment){
 const components=a.grade_components.filter(x=>x.component!=="EVIDENCE_CLARITY");
 const points:Record<string,number>={STRONG:100,ADEQUATE:75,WEAK:40,INVALID:0};
 const rated=components.filter(x=>x.rating!=="NOT_APPLICABLE");
 const rawScore=rated.length&&rated.every(x=>points[x.rating]!==undefined)?Math.round(rated.reduce((sum,x)=>sum+points[x.rating],0)/rated.length):null;
 const score=rawScore!==null&&a.rule_violations.length?Math.min(rawScore,39):rawScore;
 return {setup_score:score,setup_grade:score===null?"UNRATED":score>=90?"A":score>=75?"B":score>=60?"C":"D",grading_version:"PROCESS_1",grading_note:"Equal-weight qualitative process rubric; not a win probability. Unknown criteria leave the total unrated."};
}
export function tradingStatus(ai:SetupDecision|"NOT_EVALUATED",risk:"APPROVED"|"BLOCKED"){
 return risk==="BLOCKED"?"BLOCKED BY RISK":ai==="BLOCKED"?"BLOCKED BY AI":ai==="APPROVED"?"ELIGIBLE FOR HUMAN DECISION":"REQUIRES HUMAN DECISION";
}
