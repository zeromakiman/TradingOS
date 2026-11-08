import "server-only";
import { analyzeSetupContext } from "@/ai/analyze-setup-context";
import { validateAnalyzeSetup } from "@/ai/analyze-setup-contract";
import { type PreTradeOperationConfig,type PreTradeOutcome,runDraftRequest } from "@/ai/pre-trade-draft";

/** V2 (spec §11.3): Analyze Setup on the latest revision of a planned draft, resolved on the server. */
const TRADE_SETUP_ANALYSIS:PreTradeOperationConfig<ReturnType<typeof validateAnalyzeSetup>>={
 operation:"ANALYZE_SETUP",context:analyzeSetupContext,validate:validateAnalyzeSetup,invalidOutputCode:"INVALID_ANALYSIS_OUTPUT",failureCode:"ANALYSIS_FAILED",
 copy:{completed:"Analysis saved. Your draft and the Risk Engine result are unchanged.",failed:"The analysis failed. The attempt and its accounting are kept in the history.",startFailed:"Unable to start the analysis. Refresh to check the draft and existing attempts.",finishFailed:"The analysis could not finish saving. Check the history before retrying; no automatic retry was made."},
};
export function analyzeTradeSetup(tradeId:string,requestId:string,evidenceIds:readonly string[],expectedRevision?:number):Promise<PreTradeOutcome>{
 return runDraftRequest(TRADE_SETUP_ANALYSIS,tradeId,requestId,evidenceIds,expectedRevision);
}
