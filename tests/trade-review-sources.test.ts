import {describe,it,expect} from "vitest";
import Ajv from "ajv";
import {tradeReviewContext} from "@/ai/trade-review-context";
import {tradeReviewContract,validateTradeReview} from "@/ai/trade-review-contract";
import {tradeReviewAllowedSources} from "@/ai/trade-review-sources";
import {operationContract} from "@/ai/operation-contract";
import {operationFor} from "@/ai/operations";
import {plan,trade,strategy,risk,events,output,ids} from "./fixtures/trade-review";
const eventId="60000000-0000-4000-8000-000000000002";
const evidence={id:ids.image,role:"H1",sha256:"a".repeat(64),mime_type:"image/png",byte_size:1};
const facts=()=>tradeReviewContext(plan,trade,strategy,risk,[...events,{...events[0],id:eventId,event_type:"STOP_UPDATED"}],[evidence]);
const withRef=(ref:string)=>({...structuredClone(output),modelFit:{...output.modelFit,sourceRefs:[ref]}});
function schemaCheck(context= facts()){return new Ajv({strict:true}).compile(tradeReviewContract(context).schema);}
describe("canonical trade source manifest and strict citation schema",()=>{
 it("maps the existing IDs to exact supplied fields, including notes as event records",()=>{
  const c=facts();expect(c.sourceManifest).toMatchObject({version:"REVIEW_TRADE_SOURCES_V1",tradeId:ids.plan});
  expect(c.sourceManifest.sources.map(s=>[s.id,s.kind,s.path])).toEqual([
   ["originalPlan","PLAN","originalPlan"],["strategy","STRATEGY","strategy"],["riskVersion","RISK_VERSION","riskVersion"],["deterministic","CALCULATIONS","deterministic"],["execution","EXECUTION","execution"],["tags","TAGS","tags"],
   ["event:"+ids.event,"NOTE","events[0]"],["event:"+eventId,"EVENT","events[1]"],["evidence:"+ids.image,"EVIDENCE","selectedEvidence[0]"],
  ]);expect(tradeReviewAllowedSources(c)).toEqual(c.sourceRefs);
 });
 it.each(["originalPlan","execution","strategy","riskVersion","deterministic","tags","event:"+ids.event,"event:"+eventId,"evidence:"+ids.image])("accepts canonical source %s in provider schema and server validation",ref=>{
  const c=facts(),response=withRef(ref);expect(schemaCheck(c)(response)).toBe(true);expect(validateTradeReview(response,c.sourceRefs)).toEqual(response);
 });
 it.each(["events","selectedEvidence","invented","plan:other-trade","event:60000000-0000-4000-8000-000000000099","note:"+ids.event,"evidence:50000000-0000-4000-8000-000000000099","events[0]","TRADING OS FACTS"])("rejects unsupported citation %s without dropping or rewriting it",ref=>{
  const c=facts(),response=withRef(ref),before=structuredClone(response);expect(schemaCheck(c)(response)).toBe(false);expect(()=>validateTradeReview(response,c.sourceRefs)).toThrow("Review references evidence outside this trade snapshot");expect(response).toEqual(before);
 });
 it("does not allow actual evidence/event IDs from another supplied trade",()=>{
  const other=tradeReviewContext({...plan,id:ids.review},{...trade,id:ids.review},strategy,risk,[{...events[0],id:"60000000-0000-4000-8000-000000000099"}],[{...evidence,id:"50000000-0000-4000-8000-000000000099"}]);
  for(const ref of other.sourceRefs.filter(s=>s.startsWith("event:")||s.startsWith("evidence:"))){expect(schemaCheck()(withRef(ref))).toBe(false);expect(()=>validateTradeReview(withRef(ref),facts().sourceRefs)).toThrow();}
 });
 it("accepts a complete manifest-only response and preserves risk results, realized R and input records",()=>{
  const before=structuredClone({plan,trade,strategy,risk,events}),c=facts();const response={...structuredClone(output),planAdherence:{...output.planAdherence,sourceRefs:["originalPlan"]},executionQuality:{...output.executionQuality,sourceRefs:["execution"]},deviations:{...output.deviations,sourceRefs:["event:"+eventId]},behavioralMistakes:{...output.behavioralMistakes,sourceRefs:["event:"+ids.event]},lessons:[{...output.lessons[0],sourceRefs:["evidence:"+ids.image]}]};
  expect(schemaCheck(c)(response)).toBe(true);expect(validateTradeReview(response,c.sourceRefs)).toEqual(response);expect(c.deterministic.calculations).toEqual(plan.risk_result.calculations);expect(c.execution.realized_r).toBe(trade.realized_r);expect({plan,trade,strategy,risk,events}).toEqual(before);
 });
 it("no selected evidence or events means no such IDs are allowed; the prompt explains absence",()=>{
  const c=tradeReviewContext(plan,trade,strategy,risk,[],[]);expect(c.sourceRefs).toHaveLength(6);const contract=tradeReviewContract(c);expect(contract.instructions).toContain("absent collections");expect(contract.instructions).toContain(JSON.stringify(c.sourceRefs));expect(schemaCheck(c)(withRef("evidence:"+ids.image))).toBe(false);
 });
 it.each(["missing","extra ID","foreign manifest","missing event","duplicate","wrong mapping"])("fails closed for %s manifest",kind=>{
  const c=facts();if(kind==="missing")Reflect.deleteProperty(c,"sourceManifest");if(kind==="extra ID"){c.sourceRefs.push("events");c.sourceManifest.sources.push({id:"events",kind:"EVENT",path:"events",description:"Invented"});}if(kind==="foreign manifest")c.sourceManifest.tradeId=ids.review;if(kind==="missing event")c.events=[];if(kind==="duplicate")c.events.push(c.events[0]);if(kind==="wrong mapping")c.sourceManifest.sources[0].path="execution";
  expect(()=>operationContract(operationFor("REVIEW_TRADE"),c)).toThrow();
 });
 it("cannot dispatch the Review contract without a manifest",()=>expect(()=>operationContract(operationFor("REVIEW_TRADE"))).toThrow());
 it("the maximum envelope uses one shared source enum, within provider schema limits",()=>{
  const rows=Array.from({length:200},(_,i)=>({...events[0],id:"60000000-0000-4000-8000-"+String(i).padStart(12,"0")}));
  const images=Array.from({length:4},(_,i)=>({...evidence,id:"50000000-0000-4000-8000-"+String(i).padStart(12,"0")}));const c=tradeReviewContext(plan,trade,strategy,risk,rows,images),contract=tradeReviewContract(c);expect(c.sourceRefs).toHaveLength(210);
  const enums:string[][]=[];function visit(value:unknown){if(!value||typeof value!=="object")return;for(const [key,child] of Object.entries(value)){if(key==="enum")enums.push(child);else visit(child);}}visit(contract.schema);
  expect(enums.filter(values=>values.includes("originalPlan"))).toEqual([c.sourceRefs]);expect(enums.reduce((n,v)=>n+v.length,0)).toBeLessThanOrEqual(1000);expect(schemaCheck(c)(output)).toBe(true);expect(JSON.stringify(contract.schema)).toContain("$ref");
 });
});
