import type { z } from "zod";
import type { setupRow } from "@/lib/setup-data";
import type { storedRiskSchema } from "@/domain/risk-report";
import type { ReviewEvidence } from "./trade-review-context";
export interface BiasContextSource {
 proposal:z.infer<typeof setupRow>;
 strategy:{id:string;version:string;rules:Record<string,unknown>;written_rules:string};
 instrument:{id:string;symbol:string};
 risk:{id:string;result:z.infer<typeof storedRiskSchema>;recorded_at:string};
 riskVersion:string;
}
/** No account aggregates, unrelated history, old AI output, storage URLs or implicit images. */
export function biasChallengeContext(s:BiasContextSource,evidence:ReviewEvidence[]) {
 const p=s.proposal.proposal,r=s.risk.result;
 return {version:"CHALLENGE_BIAS_FACTS_V1",proposalId:s.proposal.id,capturedAt:new Date().toISOString(),
  proposal:{createdAt:s.proposal.created_at,instrument:s.instrument.symbol,direction:p.direction,entryModel:p.model,entry:p.entry,stop:p.stop,target:p.target,riskPercent:p.riskPercent,news:p.news,contractConfirmed:p.contractConfirmed},
  currentThesis:p.narrative,
  contextPolicy:"Pre-market and liquidity context are user-reported only where explicitly recorded in the thesis or selected evidence. Otherwise unverified. Session is the recorded risk-check session, not current market data.",
  strategy:{id:s.strategy.id,version:s.strategy.version,rules:s.strategy.rules,writtenRules:s.strategy.written_rules},
  deterministic:{evaluationId:s.risk.id,recordedAt:s.risk.recorded_at,engineVersion:r.engineVersion,evaluatedAt:r.evaluatedAt,tradingDay:r.tradingDay,session:r.session,strategyVersionId:r.strategyVersionId,riskPlanVersionId:r.riskPlanVersionId,riskPlanVersion:s.riskVersion,status:r.status,issues:r.issues,calculations:r.calculations,...("ruleResults" in r?{ruleResults:r.ruleResults}:{})},
  selectedEvidence:evidence.map(e=>({id:e.id,role:e.role,sha256:e.sha256,mimeType:e.mime_type,bytes:e.byte_size})),
  sourceRefs:["proposal","currentThesis","strategy","deterministic",...evidence.map(e=>`evidence:${e.id}`)]};
}
