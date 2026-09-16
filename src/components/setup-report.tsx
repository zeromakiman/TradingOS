import { z } from "zod";
import type { ChartEvaluation } from "@/ai/chart-contract";
import { evaluationState, type EvaluationRow } from "@/lib/setup-data";
export function savedResult(e:EvaluationRow|undefined){
 if(!e||evaluationState(e)!=="COMPLETED")return null;
 const value=e.events.find(x=>x.status==="COMPLETED")?.payload.result;
 const shape=z.object({schema_version:z.literal("2.0"),decision:z.enum(["APPROVED","CONDITIONAL","BLOCKED","INSUFFICIENT_EVIDENCE"]),setup_score:z.number().nullable(),setup_grade:z.string(),assessment:z.object({decision_reason:z.object({summary:z.string()})}).passthrough(),chart_details:z.object({evidence_quality:z.object({level:z.string(),rationale:z.string()})}).passthrough()}).passthrough().safeParse(value);
 if(!shape.success)throw new Error("Saved analysis result is not readable");
 return value as ChartEvaluation & {setup_score:number|null;setup_grade:string};
}
export function SetupReport({evaluation:e}:{evaluation:EvaluationRow}){
 const status=evaluationState(e),v=savedResult(e);
 return <article className="panel padded"><div className="row"><h2>{e.mode==="DEEP"?"Deep review":"Normal review"}</h2><span className="pill">{status}</span></div><p className="small muted">{e.created_at} · {e.model} · {e.evaluator_version}</p>
  {v?<><div className="setup-verdict"><strong>{v.decision.replaceAll("_"," ")}</strong><span>Process grade {v.setup_grade} · {v.setup_score===null?"Score not available":`${v.setup_score}/100`}</span><span>Evidence {v.chart_details.evidence_quality.level}</span></div><p>{v.assessment.decision_reason.summary}</p><p className="small muted">{v.chart_details.evidence_quality.rationale} Process scores describe compliance quality, never a probability of winning. Unknown criteria leave the total unrated.</p>
   <div className="form-grid"><div><h3>MSS · {v.chart_details.mss.status}</h3><p>{v.chart_details.mss.quality} · {v.chart_details.mss.broken_swing_importance}</p></div><div><h3>Displacement · {v.chart_details.displacement.status}</h3><p>{v.chart_details.displacement.quality} · {v.chart_details.displacement.description}</p></div></div>
   <h3>Missing evidence and uncertainty</h3>{[...v.assessment.missing_evidence,...v.assessment.uncertainties,...v.assessment.contradictions,...v.assessment.warnings].map(f=><p key={f.id} className="notice amber"><span><strong>{String((f as Record<string,unknown>).code)}</strong> · {String((f as Record<string,unknown>).description)}{f.material_to_decision?" · material to decision":""}</span></p>)}
   {[['OBSERVED',v.assessment.observed_evidence],['USER-REPORTED',v.assessment.user_reported_evidence],['INFERRED',v.assessment.inferred_evidence]] .map(([name,items])=><details key={String(name)} open><summary>{String(name)} evidence</summary>{(items as Record<string,unknown>[]).map(item=><p key={String(item.id)}><strong>{String(item.statement)}</strong><br/><small>{String(item.source_id??"Premises")} · {String(item.locator??JSON.stringify(item.premise_evidence_ids))}</small></p>)}</details>)}
   <details><summary>Entry model, liquidity, target and full structured findings</summary><pre className="code-data">{JSON.stringify(v,null,2)}</pre></details>
  </>:<p className="notice">{status==="FAILED"?`Review failed: ${String(e.events.find(x=>x.status==="FAILED")?.payload.error??"WORKER_TIMEOUT")}. No successful setup decision was recorded. A new review keeps this attempt in history.`:"Review in progress. Refreshing preserves this record. Long-running interrupted jobs expire after 12 minutes."}</p>}
  <details><summary>Audit, model usage and independent passes</summary><p className="small">Evaluation {e.id}<br/>Strategy {e.strategy_version_id}<br/>Input hash {e.input_hash}</p><p>Screenshot IDs: {e.screenshots.map(x=>x.screenshot_id).join(", ")}</p>{e.passes.map(p=><details key={p.id}><summary>Pass {p.stage} · {p.status} · {p.model}</summary><p>Provider response: {p.response_id??"Unavailable"}</p><pre className="code-data">{JSON.stringify({usage:p.usage,error:p.error_code,output:p.output},null,2)}</pre></details>)}<pre className="code-data">{JSON.stringify({events:e.events,manifest:e.manifest},null,2)}</pre></details>
 </article>;
}
