import Ajv from "ajv";
import schema from "./evaluation.schema.json";
import type { RiskResult } from "@/domain/risk";
const validator = new Ajv({ allErrors: true, strict: true }).compile(schema);
type Obj = Record<string, unknown>;
interface Assessment { status: string; evidence_ids: string[]; rule_ids: string[] }
export interface AiAssessment extends Obj {
  analysis_id: string; input_hash:string; direction:string; strategy_version: string; risk_plan_version: string; instrument: string;
  evaluator_role: "A" | "B" | "RECONCILER"; setup_model: string;
  qualitative_decision: "APPROVED" | "CONDITIONAL" | "BLOCKED";
  observed_evidence: {id:string;source_id:string;source_type:string;locator:string}[];
  user_reported_evidence: {id:string;source_id:string;locator:string}[];
  inferred_evidence: {id:string;premise_evidence_ids:string[]}[];
  missing_evidence: {id:string;material_to_decision:boolean}[];
  uncertainties: {id:string;material_to_decision:boolean}[];
  contradictions: {id:string;material_to_decision:boolean}[];
  warnings: {id:string;material_to_decision:boolean}[];
  rule_violations: {id:string;rule_id:string;evidence_ids:string[]}[];
  grade_components: {component:string;rating:string;assessment:Assessment}[];
  entry_valid: Assessment; target_valid: Assessment; mss: Assessment; displacement: Assessment;
  mss_quality:string; displacement_quality:string; liquidity_target:unknown;
  order_block:{validity:Assessment;timeframe:string;originating_candle:string;zone_construction:Assessment;first_touch:Assessment;proximal_edge_entry:Assessment};
  ote:{validity:Assessment;anchor_definition:Assessment;versioned_parameters_available:string};
  decision_reason:{code:string;summary:string};
  reconciliation: {reviewed_analysis_ids:string[];accepted_finding_ids:string[];rejected_finding_ids:string[];unresolved_finding_ids:string[]};
}
export interface EvaluationContext {
  analysisId:string; inputHash:string; direction:"LONG"|"SHORT"; setupModel:"OB_FIRST_TOUCH"|"OTE"; strategyVersionId:string; riskPlanVersionId:string; instrument:string; role:"A"|"B"|"RECONCILER";
  sources: Record<string, "CHART_IMAGE"|"MARKET_DATA"|"USER_REPORT">;
  ruleIds:string[]; blockingRuleIds:string[]; priorAnalysisIds:string[]; priorFindingIds:string[];
}
export function validateEvaluation(raw: unknown, ctx: EvaluationContext): AiAssessment {
  if (!validator(raw)) throw new Error(`Invalid AI schema: ${validator.errors?.map(e=>`${e.instancePath} ${e.message}`).join("; ")}`);
  const v = raw as AiAssessment;
  if (v.analysis_id !== ctx.analysisId || v.input_hash !== ctx.inputHash || v.strategy_version !== ctx.strategyVersionId || v.risk_plan_version !== ctx.riskPlanVersionId || v.instrument !== ctx.instrument || v.evaluator_role !== ctx.role) throw new Error("AI context identifiers do not match the request.");
  const evidence = [...v.observed_evidence,...v.user_reported_evidence,...v.inferred_evidence];
  const ids = new Set(evidence.map(e=>e.id));
  if (ids.size !== evidence.length || evidence.some(e=>!e.id.trim())) throw new Error("Evidence IDs must be unique and nonempty.");
  for (const e of v.observed_evidence) if (ctx.sources[e.source_id] !== e.source_type || !e.locator.trim()) throw new Error("Observed evidence has an invalid source or locator.");
  for (const e of v.user_reported_evidence) if (ctx.sources[e.source_id] !== "USER_REPORT" || !e.locator.trim()) throw new Error("User-reported evidence has an invalid source or locator.");
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Obj;
    if (["SUPPORTED","REFUTED"].includes(String(record.status)) && Array.isArray(record.evidence_ids) && !record.evidence_ids.length) throw new Error("Supported/refuted assessments require evidence.");
    if (typeof record.reported_price === "string" && Array.isArray(record.evidence_ids) && !record.evidence_ids.length) throw new Error("Reported prices require evidence.");
    for (const [key,item] of Object.entries(value)) {
      if (typeof item === "string" && !item.trim()) throw new Error("AI text fields cannot be blank.");
      if (["evidence_ids","premise_evidence_ids"].includes(key) && Array.isArray(item) && item.some(id=>!ids.has(String(id)))) throw new Error("Unresolved evidence reference.");
      if (key === "rule_ids" && Array.isArray(item) && item.some(id=>!ctx.ruleIds.includes(String(id)))) throw new Error("Unknown strategy rule.");
      if (key === "rule_id" && !ctx.ruleIds.includes(String(item))) throw new Error("Unknown strategy rule.");
      walk(item);
    }
  }
  walk(v);
  const inferences = new Map(v.inferred_evidence.map(e=>[e.id,e.premise_evidence_ids]));
  function visit(id:string,path:Set<string>):void {
    if (path.has(id)) throw new Error("Cyclic inference provenance.");
    const next = new Set(path).add(id);
    for (const premise of inferences.get(id) ?? []) visit(premise,next);
  }
  inferences.forEach((_,id)=>{ visit(id,new Set()); });
  const components = ["HTF_ALIGNMENT","LIQUIDITY_CONTEXT","MSS_QUALITY","DISPLACEMENT_QUALITY","ENTRY_MODEL_VALIDITY","TARGET_QUALITY","EVIDENCE_CLARITY"];
  if (v.grade_components.length !== components.length || new Set(v.grade_components.map(c=>c.component)).size !== components.length) throw new Error("Rubric components must appear exactly once.");
  const findingIds = [...v.missing_evidence,...v.uncertainties,...v.contradictions,...v.warnings,...v.rule_violations].map(i=>i.id);
  if (new Set(findingIds).size !== findingIds.length) throw new Error("Finding IDs must be unique.");
  const rec = v.reconciliation;
  const findings = [...rec.accepted_finding_ids,...rec.rejected_finding_ids,...rec.unresolved_finding_ids];
  if (ctx.role !== "RECONCILER" && (rec.reviewed_analysis_ids.length || findings.length)) throw new Error("Independent passes cannot claim reconciliation.");
  if (ctx.role === "RECONCILER" && (rec.reviewed_analysis_ids.length !== 2 || new Set(rec.reviewed_analysis_ids).size !== 2 || rec.reviewed_analysis_ids.some(id=>!ctx.priorAnalysisIds.includes(id)) || findings.some(id=>!ctx.priorFindingIds.includes(id)) || new Set(findings).size !== findings.length || findings.length !== new Set(ctx.priorFindingIds).size)) throw new Error("Invalid reconciliation references; account for every prior finding exactly once.");
  if (v.qualitative_decision === "BLOCKED" && (!v.rule_violations.some(r=>ctx.blockingRuleIds.includes(r.rule_id)) || !["STRATEGY_VIOLATION","UNRECOGNIZED_MODEL"].includes(v.decision_reason.code))) throw new Error("Blocking decisions require an evidenced blocking rule and matching reason.");
  if (v.qualitative_decision === "CONDITIONAL" && !["MATERIAL_EVIDENCE_MISSING","MATERIAL_UNCERTAINTY","UNRESOLVED_CONTRADICTION"].includes(v.decision_reason.code)) throw new Error("Conditional decision requires a matching reason.");
  if (v.qualitative_decision === "APPROVED") {
    if ([...v.missing_evidence,...v.uncertainties,...v.contradictions,...v.warnings].some(i=>i.material_to_decision) || v.rule_violations.length || rec.unresolved_finding_ids.length || v.setup_model !== ctx.setupModel || v.direction !== ctx.direction || v.decision_reason.code !== "SUPPORTED_BY_AVAILABLE_EVIDENCE") throw new Error("Approval cannot conceal unresolved material findings or conflict with the proposal.");
    if ([v.entry_valid,v.target_valid,v.mss,v.displacement].some(a=>a.status !== "SUPPORTED" || !a.evidence_ids.length)) throw new Error("Approval requires supported core criteria with evidence.");
    if (!v.liquidity_target || [v.mss_quality,v.displacement_quality].some(q=>["UNKNOWN","AMBIGUOUS","WEAK"].includes(q))) throw new Error("Approval requires clear structure, displacement and target evidence.");
    if (v.setup_model === "OB_FIRST_TOUCH") {
      const ob=v.order_block;
      if ([ob.validity,ob.zone_construction,ob.first_touch,ob.proximal_edge_entry].some(a=>a.status !== "SUPPORTED") || ob.timeframe !== "M5" || ob.originating_candle !== (ctx.direction === "LONG" ? "BEARISH":"BULLISH")) throw new Error("Approval requires the selected first-touch OB model to be supported.");
    } else if (v.ote.validity.status !== "SUPPORTED" || v.ote.anchor_definition.status !== "SUPPORTED" || v.ote.versioned_parameters_available !== "YES") throw new Error("Approval requires specified and supported OTE parameters.");
    if (v.grade_components.some(c=>["INVALID","UNKNOWN"].includes(c.rating) || ["REFUTED","AMBIGUOUS","NOT_ASSESSED"].includes(c.assessment.status))) throw new Error("Approval conflicts with rubric findings.");
  }
  return v;
}
export function composeFinalEvaluation(analysis: AiAssessment, boundRisk: { inputHash:string; result:RiskResult }) {
  const risk = boundRisk.result;
  if (analysis.input_hash !== boundRisk.inputHash) throw new Error("Risk and AI input packages differ.");
  if (analysis.strategy_version !== risk.strategyVersionId || analysis.risk_plan_version !== risk.riskPlanVersionId) throw new Error("Risk and AI versions differ.");
  return { schema_version: "1.0", analysis_id: analysis.analysis_id, assessment: analysis, risk,
    planned_rr: risk.calculations?.plannedRR ?? null, setup_score: null, setup_grade: null,
    grading_status: "UNCONFIGURED" as const,
    decision: risk.status === "TRADE_BLOCKED" || analysis.qualitative_decision === "BLOCKED" ? "BLOCKED" : "CONDITIONAL",
    decision_reason: risk.status === "TRADE_BLOCKED" ? "Deterministic risk restriction." : analysis.qualitative_decision === "BLOCKED" ? "Strategy violation." : "Grading policy is not configured; preserve the qualitative assessment separately." };
}
