import type { EvaluationContext } from "@/ai/validate";
import { previewContext } from "@/domain/fixtures";
const inputHash="a".repeat(64);
export const context:EvaluationContext={analysisId:"analysis-1",inputHash,direction:"LONG",setupModel:"OB_FIRST_TOUCH",strategyVersionId:previewContext.strategyVersionId,riskPlanVersionId:previewContext.plan.id,instrument:"EURUSD",role:"A",sources:{chart:"CHART_IMAGE",narrative:"USER_REPORT"},ruleIds:["MSS","OB_FIRST_TOUCH","OTE","TARGET"],blockingRuleIds:["MSS","OB_FIRST_TOUCH"],priorAnalysisIds:[],priorFindingIds:[]};
const assessment=()=>({status:"NOT_ASSESSED",confidence:"UNKNOWN",evidence_ids:[] as string[],rule_ids:[] as string[],rationale:"Evidence has not been provided."});
export function fixture() {
  return {
    schema_version:"1.0",analysis_id:context.analysisId,input_hash:inputHash,strategy_version:context.strategyVersionId,risk_plan_version:context.riskPlanVersionId,instrument:"EURUSD",evaluator_role:"A",direction:"LONG",setup_model:"OB_FIRST_TOUCH",
    htf_context:{daily:assessment(),h4:assessment(),h1:assessment(),alignment:"UNKNOWN"},liquidity_events:[],liquidity_target:null,
    mss:assessment(),mss_timeframe:"M5",mss_quality:"UNKNOWN",displacement:assessment(),displacement_quality:"UNKNOWN",
    order_block:{validity:assessment(),timeframe:"M5",originating_candle:"BEARISH",zone_construction:assessment(),first_touch:assessment(),proximal_edge_entry:assessment()},
    ote:{validity:assessment(),rationale:"NOT_APPLICABLE",anchor_definition:assessment(),versioned_parameters_available:"NO"},entry_valid:assessment(),target_valid:assessment(),
    observed_evidence:[] as {id:string;source_id:string;source_type:string;locator:string;statement:string;confidence:string}[],user_reported_evidence:[] as {id:string;source_id:string;locator:string;statement:string}[],inferred_evidence:[] as {id:string;premise_evidence_ids:string[];statement:string;confidence:string}[],
    missing_evidence:[{id:"gap-1",code:"MISSING_CHART",description:"No chart screenshots supplied.",material_to_decision:true,evidence_ids:[],rule_ids:[]}],uncertainties:[],contradictions:[],rule_violations:[],warnings:[] as {id:string;code:string;description:string;material_to_decision:boolean;evidence_ids:string[];rule_ids:string[]}[],
    grade_components:["HTF_ALIGNMENT","LIQUIDITY_CONTEXT","MSS_QUALITY","DISPLACEMENT_QUALITY","ENTRY_MODEL_VALIDITY","TARGET_QUALITY","EVIDENCE_CLARITY"].map(component=>({component,rating:"UNKNOWN",assessment:assessment()})),
    qualitative_decision:"CONDITIONAL",decision_reason:{code:"MATERIAL_EVIDENCE_MISSING",summary:"Chart evidence is required to evaluate the setup.",evidence_ids:[],rule_ids:[]},
    reconciliation:{reviewed_analysis_ids:[] as string[],accepted_finding_ids:[] as string[],rejected_finding_ids:[] as string[],unresolved_finding_ids:[] as string[],summary:"Not applicable to the independent A pass."}
  };
}
export function approved() {
  const v=fixture();
  v.observed_evidence=[{id:"e1",source_id:"chart",source_type:"CHART_IMAGE",locator:"M5 visible displacement leg",statement:"A bearish origin candle precedes the bullish leg.",confidence:"HIGH"}];
  const supported=()=>({status:"SUPPORTED",confidence:"HIGH",evidence_ids:["e1"],rule_ids:["MSS"],rationale:"Supported by the supplied source."});
  v.mss=supported();v.displacement=supported();v.entry_valid=supported();v.target_valid=supported();v.mss_quality="STRONG";v.displacement_quality="STRONG";
  v.order_block={validity:supported(),timeframe:"M5",originating_candle:"BEARISH",zone_construction:supported(),first_touch:supported(),proximal_edge_entry:supported()};
  v.grade_components=v.grade_components.map(c=>({...c,rating:"STRONG",assessment:supported()}));
  v.missing_evidence=[];v.qualitative_decision="APPROVED";v.decision_reason.code="SUPPORTED_BY_AVAILABLE_EVIDENCE";
  return {...v,liquidity_target:{liquidity_type:"PDH",internal_or_external:"EXTERNAL",reported_price:null,evidence_ids:["e1"],assessment:supported()}};
}
