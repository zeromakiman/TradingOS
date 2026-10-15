import type {AnalyzeSetupOutput} from '@/ai/analyze-setup-contract';
export {source,ids} from './bias-challenge';
export const analysisOutput:AnalyzeSetupOutput={
 setupStructure:{text:'The recorded long proposal defines entry, stop and target. The supplied thesis reports a sweep; it is not independently verified.',sourceRefs:['proposal','currentThesis']},
 entryModelAssessment:{text:'Assess first-touch eligibility only using the supplied strategy definition. No selected chart verifies prior touches.',sourceRefs:['strategy','proposal']},
 confluences:[{text:'No visual confluence is established by the narrative alone.',sourceRefs:['currentThesis']}],
 weaknesses:[{text:'Visual evidence is missing. The claimed liquidity event and pre-market assumptions are unverified.',sourceRefs:['currentThesis']}],
 invalidation:[{text:'A previous touch would contradict the supplied first-touch rule if documented.',sourceRefs:['strategy']}],
 observations:[{text:'The recorded risk block remains in effect; this analysis does not change it.',sourceRefs:['deterministic']}],evidenceStatus:'NONE_SELECTED'};
