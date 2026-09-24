import {WEEKLY_REVIEW_PROMPT,weeklyReviewJsonSchema} from "./weekly-review-contract";
import {ANALYZE_SETUP_PROMPT,analyzeSetupJsonSchema} from "./analyze-setup-contract";
import { SYSTEM_PROMPT } from "./analysis-prompt";
import { chartEvaluationSchema } from "./chart-contract";
import { REVIEW_TRADE_PROMPT,tradeReviewJsonSchema } from "./trade-review-contract";
import type { AiOperation } from "./operations";
import { CHALLENGE_BIAS_PROMPT,biasChallengeJsonSchema } from "./bias-challenge-contract";
export function operationContract(operation?:AiOperation) {
 if(!operation||operation.contract==="SETUP_V2")return {name:"ict_setup_v2",instructions:SYSTEM_PROMPT,schema:chartEvaluationSchema};
 if(operation.contract==="REVIEW_TRADE_V1")return {name:"review_trade_v1",instructions:REVIEW_TRADE_PROMPT,schema:tradeReviewJsonSchema};
 if(operation.contract==="CHALLENGE_BIAS_V1")return {name:"challenge_bias_v1",instructions:CHALLENGE_BIAS_PROMPT,schema:biasChallengeJsonSchema};
 if(operation.contract==="ANALYZE_SETUP_V1")return {name:"analyze_setup_v1",instructions:ANALYZE_SETUP_PROMPT,schema:analyzeSetupJsonSchema};
 if(operation.contract==="WEEKLY_REVIEW_V1")return {name:"weekly_review_v1",instructions:WEEKLY_REVIEW_PROMPT,schema:weeklyReviewJsonSchema};
 throw new Error("Unknown AI operation contract");
}
