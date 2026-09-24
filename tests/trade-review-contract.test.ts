import { beforeEach,afterEach,describe,it,expect,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { budgetedAiRequest,type AiLedger } from "@/ai/request-gate";
import { operationFor } from "@/ai/operations";
import { operationPricing,reservationMicros } from "@/ai/pricing";
import { tradeReviewContext } from "@/ai/trade-review-context";
import { validateTradeReview } from "@/ai/trade-review-contract";
import { plan,trade,strategy,risk,events,output,ids } from "./fixtures/trade-review";
const op=operationFor("REVIEW_TRADE");
const context=()=>tradeReviewContext(plan,trade,strategy,risk,events,[]);
const owner={userId:ids.user,accountId:ids.account,operationId:ids.review,operation:op.id,stage:"A"};
function harness(){
 const ledger={reserve:vi.fn<AiLedger['reserve']>().mockResolvedValue(),dispatch:vi.fn<AiLedger['dispatch']>().mockResolvedValue(),recheck:vi.fn<AiLedger['recheck']>().mockResolvedValue(),settle:vi.fn<AiLedger['settle']>().mockResolvedValue()};
 const transport=vi.fn<typeof fetch>(async url=>String(url).endsWith('/input_tokens')?Response.json({input_tokens:1000}):Response.json({id:"mock-review",model:op.model,status:"completed",usage:{input_tokens:1000,output_tokens:100},output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(output)}]}]}));
 const request={apiKey:"mock-only",config:{model:op.model,reasoningEffort:op.reasoningEffort,timeoutMs:op.timeoutMs,maxOutputTokens:op.maxOutputTokens,imageDetail:op.imageDetail,deepEnabled:false},context:context(),images:[],prior:[]};
 return {ledger,transport,request};
}
beforeEach(()=>{vi.stubEnv('AI_ENABLED','true');vi.stubEnv('OPENAI_API_KEY','mock-only');vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-23T12:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('post-trade operation contract and accounting',()=>{
 it('has a dedicated bounded contract with an exact EUR0.792 hold',()=>{expect(op).toMatchObject({contract:'REVIEW_TRADE_V1',maxInputTokens:24000,maxOutputTokens:6000,maxImages:4,reasoningEffort:'medium',tools:[]});expect(reservationMicros(operationPricing(op),op)).toBe(792000);});
 it('preserves deterministic facts without sending unrelated account state or private paths',()=>{const facts=context();expect(facts.execution.realized_r).toBe(trade.realized_r);expect(facts.deterministic.calculations).toEqual(plan.risk_result.calculations);const text=JSON.stringify(facts);for(const forbidden of ['account_id','user_id','storage_path','account_observations','balance','equity','snapshot'])expect(text).not.toContain(`"${forbidden}"`);expect(facts.sourceRefs).toContain(`event:${ids.event}`);});
 it('drops unknown event and risk fields',()=>{const facts=tradeReviewContext(plan,trade,strategy,{...risk,unrelatedHistory:['secret']},[{...events[0],payload:{...events[0].payload,privateAccountData:'secret'}}],[]);expect(JSON.stringify(facts)).not.toContain('secret');});
 it('rejects mixed trade or account context',()=>{expect(()=>tradeReviewContext(plan,{...trade,id:ids.review},strategy,risk,[],[])).toThrow();expect(()=>tradeReviewContext(plan,{...trade,account_id:ids.review},strategy,risk,[],[])).toThrow();});
 it('strict output forbids generated facts and unknown sources',()=>{expect(validateTradeReview(output,context().sourceRefs)).toEqual(output);expect(()=>validateTradeReview({...output,realizedR:42},context().sourceRefs)).toThrow();expect(()=>validateTradeReview({...output,modelFit:{...output.modelFit,sourceRefs:['other-trade']}},context().sourceRefs)).toThrow();});
 it('uses the review prompt/schema in both count and generation, reconciles and releases unused hold',async()=>{const h=harness();const result=await budgetedAiRequest(h.request,owner,h.ledger,h.transport);expect(validateTradeReview(result.output,context().sourceRefs)).toEqual(output);expect(h.ledger.reserve.mock.calls[0][0]).toMatchObject({...owner,amount:792000});const count=JSON.parse(String(h.transport.mock.calls[0][1]?.body)),generation=JSON.parse(String(h.transport.mock.calls[1][1]?.body));expect(generation.text.format.name).toBe('review_trade_v1');expect(generation.instructions).toContain('post-trade');expect(generation.max_output_tokens).toBe(6000);expect(generation.reasoning.effort).toBe('medium');expect(count.text).toEqual(generation.text);expect(count.input).toEqual(generation.input);expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({disposition:'SETTLED',chargedMicros:21000,inputTokens:1000,outputTokens:100});});
 it.each(['Account AI is OFF','Insufficient reservation','Account not found'])('%s prevents count and generation',async error=>{const h=harness();h.ledger.reserve.mockRejectedValue(new Error(error));await expect(budgetedAiRequest(h.request,owner,h.ledger,h.transport)).rejects.toThrow(error);expect(h.transport).not.toHaveBeenCalled();});
 it('global OFF overrides account permission',async()=>{vi.stubEnv('AI_ENABLED','false');const h=harness();await expect(budgetedAiRequest(h.request,owner,h.ledger,h.transport)).rejects.toThrow(/disabled/);expect(h.transport).not.toHaveBeenCalled();});
 it('enforces the 24k input envelope before generation',async()=>{const h=harness();h.transport.mockResolvedValueOnce(Response.json({input_tokens:24001}));await expect(budgetedAiRequest(h.request,owner,h.ledger,h.transport)).rejects.toThrow();expect(h.transport).toHaveBeenCalledTimes(1);expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({disposition:'UNCERTAIN',chargedMicros:792000,errorCode:'INPUT_LIMIT_EXCEEDED'});});
 it('failure retains the full hold and never retries',async()=>{const h=harness();h.transport.mockRejectedValue(new Error('offline'));await expect(budgetedAiRequest(h.request,owner,h.ledger,h.transport)).rejects.toThrow();expect(h.transport).toHaveBeenCalledTimes(1);expect(h.ledger.settle.mock.calls[0][2]).toMatchObject({disposition:'UNCERTAIN',chargedMicros:792000});});
});
