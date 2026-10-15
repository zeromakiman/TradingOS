import {withOperationSources} from "./citation-sources";
import {biasChallengeContext,type BiasContextSource} from "./bias-challenge-context";
import type {ReviewEvidence} from "./trade-review-context";
/** Both pre-trade actions share the same explicit current-proposal allowlist, not prior AI output. */
export function analyzeSetupContext(source:BiasContextSource,evidence:ReviewEvidence[]){
 return withOperationSources("ANALYZE_SETUP",{...biasChallengeContext(source,evidence),version:"ANALYZE_SETUP_FACTS_V1"});
}
