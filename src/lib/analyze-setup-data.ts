import "server-only";
import {loadDraftPanel,type PreTradePanel} from "@/ai/pre-trade-draft";
/** V2 trade page (spec §11.3): Analyze Setup on the latest revision of a draft, with history across revisions. */
export function loadTradeAnalyzeSetupPanel(tradeId:string,page=0):Promise<PreTradePanel>{return loadDraftPanel("ANALYZE_SETUP",tradeId,page);}
