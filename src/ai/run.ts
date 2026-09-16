import { randomUUID } from "node:crypto";
import { validateChartEvaluation, scoreSetup, type ChartEvaluation } from "./chart-contract";
import type { EvaluationContext } from "./validate";
import { ProviderError, type callResponses } from "./provider";
export interface PassRecord {id:string;stage:"A"|"B"|"RECONCILER";status:"VALID"|"INVALID"|"REFUSED"|"INCOMPLETE"|"FAILED";model:string;response_id:string|null;output:unknown;usage:unknown;error_code:string|null}
export async function runEvaluation(input:{mode:"NORMAL"|"DEEP";model:string;context:Omit<EvaluationContext,"analysisId"|"role"|"priorAnalysisIds"|"priorFindingIds"> & {proposalId:string;oteParametersAvailable:boolean};
 call:(role:PassRecord["stage"],id:string,prior:ChartEvaluation[])=>ReturnType<typeof callResponses>;
 savePass:(record:PassRecord)=>Promise<void>}){
 const prior:ChartEvaluation[]=[];let final:ChartEvaluation|undefined;
 const stages:PassRecord["stage"][]=input.mode==="DEEP"?["A","B","RECONCILER"]:["A"];
 for(const stage of stages){
  const id=randomUUID(), visiblePrior=stage==="RECONCILER"?prior:[];
  let response:Awaited<ReturnType<typeof callResponses>>|undefined;
  let validated:ChartEvaluation|undefined, failure:unknown;
  try{
   response=await input.call(stage,id,visiblePrior);
   const priorFindings=visiblePrior.flatMap(p=>[...p.assessment.missing_evidence,...p.assessment.uncertainties,...p.assessment.contradictions,...p.assessment.warnings,...p.assessment.rule_violations].map(x=>x.id));
   validated=validateChartEvaluation(response.output,{...input.context,analysisId:id,role:stage,priorAnalysisIds:visiblePrior.map(p=>p.assessment.analysis_id),priorFindingIds:priorFindings});
  }catch(e){failure=e;}
  const code=failure instanceof ProviderError?failure.code:failure?"INVALID_OUTPUT":null;
  await input.savePass({id,stage,status:validated?"VALID":code==="REFUSED"?"REFUSED":code==="INCOMPLETE"?"INCOMPLETE":code==="INVALID_OUTPUT"||code==="INVALID_JSON"||code==="INVALID_RESPONSE"?"INVALID":"FAILED",model:response?.model??(failure instanceof ProviderError?failure.model:null)??input.model,response_id:response?.responseId??(failure instanceof ProviderError?failure.responseId:null)??null,output:response?.output??null,usage:response?.usage??(failure instanceof ProviderError?failure.usage:null)??null,error_code:code});
  if(!validated)throw new ProviderError(code??"MODEL_ERROR");
  prior.push(validated);final=validated;
 }
 if(!final)throw new ProviderError("NO_RESULT");
 return {...final,...scoreSetup(final.assessment)};
}
