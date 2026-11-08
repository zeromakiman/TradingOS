import "server-only";
import { biasChallengeContext } from "@/ai/bias-challenge-context";
import { validateBiasChallenge } from "@/ai/bias-challenge-contract";
import { type PreTradeOperationConfig,type PreTradeOutcome,runDraftRequest } from "@/ai/pre-trade-draft";

/** V2 (spec §11.3): Challenge My Bias on the latest revision of a planned draft, resolved on the server. */
const TRADE_BIAS_CHALLENGE:PreTradeOperationConfig<ReturnType<typeof validateBiasChallenge>>={
 operation:"CHALLENGE_BIAS",context:biasChallengeContext,validate:validateBiasChallenge,invalidOutputCode:"INVALID_CHALLENGE_OUTPUT",failureCode:"CHALLENGE_FAILED",
 copy:{completed:"Challenge saved. Your draft and the Risk Engine result are unchanged.",failed:"The challenge failed. The attempt and its accounting are kept in the history.",startFailed:"Unable to start the challenge. Refresh to check the draft and existing attempts.",finishFailed:"The challenge could not finish saving. Check the history before retrying; no automatic retry was made."},
};
export function challengeTradeBias(tradeId:string,requestId:string,evidenceIds:readonly string[],expectedRevision?:number):Promise<PreTradeOutcome>{
 return runDraftRequest(TRADE_BIAS_CHALLENGE,tradeId,requestId,evidenceIds,expectedRevision);
}
