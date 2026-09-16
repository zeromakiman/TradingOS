import { describe, expect, it } from "vitest";
import { composeFinalEvaluation, validateEvaluation, type EvaluationContext } from "@/ai/validate";
import { evaluateRisk } from "@/domain/risk";
import { previewContext, previewProposal } from "@/domain/fixtures";
const inputHash="a".repeat(64);
const context:EvaluationContext={analysisId:"analysis-1",inputHash,direction:"LONG",setupModel:"OB_FIRST_TOUCH",strategyVersionId:previewContext.strategyVersionId,riskPlanVersionId:previewContext.plan.id,instrument:"EURUSD",role:"A",sources:{chart:"CHART_IMAGE",narrative:"USER_REPORT"},ruleIds:["MSS","OB_FIRST_TOUCH","OTE","TARGET"],blockingRuleIds:["MSS","OB_FIRST_TOUCH"],priorAnalysisIds:[],priorFindingIds:[]};
const assessment=()=>({status:"NOT_ASSESSED",confidence:"UNKNOWN",evidence_ids:[] as string[],rule_ids:[] as string[],rationale:"Evidence has not been provided."});
function fixture() {
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
function approved() {
  const v=fixture();
  v.observed_evidence=[{id:"e1",source_id:"chart",source_type:"CHART_IMAGE",locator:"M5 visible displacement leg",statement:"A bearish origin candle precedes the bullish leg.",confidence:"HIGH"}];
  const supported=()=>({status:"SUPPORTED",confidence:"HIGH",evidence_ids:["e1"],rule_ids:["MSS"],rationale:"Supported by the supplied source."});
  v.mss=supported();v.displacement=supported();v.entry_valid=supported();v.target_valid=supported();v.mss_quality="STRONG";v.displacement_quality="STRONG";
  v.order_block={validity:supported(),timeframe:"M5",originating_candle:"BEARISH",zone_construction:supported(),first_touch:supported(),proximal_edge_entry:supported()};
  v.grade_components=v.grade_components.map(c=>({...c,rating:"STRONG",assessment:supported()}));
  v.missing_evidence=[];v.qualitative_decision="APPROVED";v.decision_reason.code="SUPPORTED_BY_AVAILABLE_EVIDENCE";
  return {...v,liquidity_target:{liquidity_type:"PDH",internal_or_external:"EXTERNAL",reported_price:null,evidence_ids:["e1"],assessment:supported()}};
}
describe("strict AI output and provenance",()=>{
  it("accepts an explicit, complete unknown-evidence assessment",()=>expect(validateEvaluation(fixture(),context).qualitative_decision).toBe("CONDITIONAL"));
  it("rejects malformed JSON objects and unknown keys",()=>{expect(()=>validateEvaluation({decision:"APPROVED"},context)).toThrow(/schema/);expect(()=>validateEvaluation({...fixture(),planned_rr:3},context)).toThrow(/schema/);expect(()=>validateEvaluation("not json",context)).toThrow(/schema/);});
  it("rejects invented model IDs/context",()=>expect(()=>validateEvaluation({...fixture(),strategy_version:"ICT V2"},context)).toThrow(/identifiers/));
  it("rejects user assertions labeled as observed",()=>{const v=fixture();v.observed_evidence=[{id:"e1",source_id:"narrative",source_type:"CHART_IMAGE",locator:"Narrative",statement:"Claimed sweep",confidence:"HIGH"}];expect(()=>validateEvaluation(v,context)).toThrow(/source/);});
  it("rejects missing sources and duplicate evidence IDs",()=>{const v=approved();v.observed_evidence.push({...v.observed_evidence[0]});expect(()=>validateEvaluation(v,context)).toThrow(/unique/);});
  it("rejects inference cycles",()=>{const v=fixture();v.inferred_evidence=[{id:"e1",premise_evidence_ids:["e2"],statement:"First inference",confidence:"LOW"},{id:"e2",premise_evidence_ids:["e1"],statement:"Second inference",confidence:"LOW"}];expect(()=>validateEvaluation(v,context)).toThrow(/Cyclic/);});
  it("rejects unresolved evidence and unknown rule IDs",()=>{const v=fixture();v.mss.evidence_ids=["missing"];expect(()=>validateEvaluation(v,context)).toThrow(/reference/);v.mss.evidence_ids=[];v.mss.rule_ids=["invented extra confirmation"];expect(()=>validateEvaluation(v,context)).toThrow(/Unknown strategy/);});
  it("rejects empty evidence text and unsupported positive assessments",()=>{const v=approved();v.observed_evidence[0].statement="  ";expect(()=>validateEvaluation(v,context)).toThrow(/blank/);const w=fixture();w.mss.status="SUPPORTED";expect(()=>validateEvaluation(w,context)).toThrow(/require evidence/);});
  it("refuses approval with missing evidence",()=>expect(()=>validateEvaluation({...fixture(),qualitative_decision:"APPROVED"},context)).toThrow(/Approval/));
  it("accepts a supported selected OB classification",()=>expect(validateEvaluation(approved(),context).qualitative_decision).toBe("APPROVED"));
  it("rejects invalid first-touch OB and wrong candle",()=>{const v=approved();v.order_block.first_touch.status="REFUTED";expect(()=>validateEvaluation(v,context)).toThrow(/OB model/);const w=approved();w.order_block.originating_candle="BULLISH";expect(()=>validateEvaluation(w,context)).toThrow(/OB model/);});
  it("does not invent OTE parameters",()=>{const v=approved();v.setup_model="OTE";expect(()=>validateEvaluation(v,{...context,setupModel:"OTE"})).toThrow(/OTE parameters/);});
  it("rejects material warnings under approval",()=>{const v=approved();v.warnings=[{id:"w1",code:"SOURCE_CONFLICT",description:"Source conflict remains.",material_to_decision:true,evidence_ids:["e1"],rule_ids:[]}];expect(()=>validateEvaluation(v,context)).toThrow(/Approval/);});
  it("rejects unsubstantiated BLOCKED",()=>expect(()=>validateEvaluation({...fixture(),qualitative_decision:"BLOCKED"},context)).toThrow(/Blocking/));
  it("requires reconciler to account for every earlier finding exactly once",()=>{
    const v=fixture();v.evaluator_role="RECONCILER";v.reconciliation.reviewed_analysis_ids=["A","B"];
    const ctx={...context,role:"RECONCILER" as const,priorAnalysisIds:["A","B"],priorFindingIds:["A:gap","B:violation"]};
    expect(()=>validateEvaluation(v,ctx)).toThrow(/every prior finding/);
    v.reconciliation.unresolved_finding_ids=["A:gap","B:violation"];expect(validateEvaluation(v,ctx)).toBeTruthy();
    v.reconciliation.accepted_finding_ids=["A:gap"];expect(()=>validateEvaluation(v,ctx)).toThrow(/exactly once/);
  });
  it("a deterministic hard block dominates a supported AI result",()=>{
    const ai=validateEvaluation(approved(),context);
    const risk=evaluateRisk({...previewProposal,narrative:"Test",contractConfirmed:true},{...previewContext,slotsUsed:2});
    expect(composeFinalEvaluation(ai,{inputHash,result:risk}).decision).toBe("BLOCKED");
  });
  it("requires the same evidence package for final composition",()=>{
    const ai=validateEvaluation(fixture(),context);const risk=evaluateRisk({...previewProposal,narrative:"Test"},previewContext);
    expect(()=>composeFinalEvaluation(ai,{inputHash:"b".repeat(64),result:risk})).toThrow(/input packages differ/);
  });
  it("keeps grade and score missing while no grading policy exists",()=>{
    const ai=validateEvaluation(approved(),context);const risk=evaluateRisk({...previewProposal,narrative:"Test",contractConfirmed:true},previewContext);
    expect(composeFinalEvaluation(ai,{inputHash,result:risk})).toMatchObject({setup_score:null,setup_grade:null,decision:"CONDITIONAL",grading_status:"UNCONFIGURED"});
  });
});
