import {RECENT_TRADES_PROMPT,recentTradesJsonSchema} from "./recent-trades-contract";
import {MONTHLY_REVIEW_PROMPT,monthlyReviewJsonSchema} from "./monthly-review-contract";
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
 if(operation.contract==="RECENT_TRADES_V1")return {name:"recent_trades_v1",instructions:RECENT_TRADES_PROMPT,schema:recentTradesJsonSchema};
 if(operation.contract==="MONTHLY_REVIEW_V1")return {name:"monthly_review_v1",instructions:MONTHLY_REVIEW_PROMPT,schema:monthlyReviewJsonSchema};
 throw new Error("Unknown AI operation contract");
}
