import {describe,it,expect} from "vitest";
import Ajv from "ajv";
import {operationContract} from "@/ai/operation-contract";
import {operationFor} from "@/ai/operations";
import {operationAllowedSources,withOperationSources,citationSchema,type CitationOperation} from "@/ai/citation-sources";
import {biasChallengeContext} from "@/ai/bias-challenge-context";
import {analyzeSetupContext} from "@/ai/analyze-setup-context";
import {validateBiasChallenge} from "@/ai/bias-challenge-contract";
import {validateAnalyzeSetup} from "@/ai/analyze-setup-contract";
import {validateWeeklyReview} from "@/ai/weekly-review-contract";
import {validateRecentTrades} from "@/ai/recent-trades-contract";
import {validateMonthlyReview} from "@/ai/monthly-review-contract";
import {monthlyReviewContext} from "@/ai/monthly-review-context";
import {weeklyReviewContext} from "@/ai/weekly-review-context";
import {source,ids,challengeOutput} from "./fixtures/bias-challenge";
import {analysisOutput} from "./fixtures/analyze-setup";
import {facts as weekly,weeklyOutput,sources as weekSources,week} from "./fixtures/weekly-review";
import {facts as recent,recentOutput} from "./fixtures/recent-trades";
import {facts as monthly,monthlyOutput,monthSources,month} from "./fixtures/monthly-review";
const evidence={id:ids.image,role:"H1",sha256:"a".repeat(64),mime_type:"image/png",byte_size:1};
const cases=[
 {id:"CHALLENGE_BIAS",facts:biasChallengeContext(source,[evidence]),output:challengeOutput,validate:validateBiasChallenge},
 {id:"ANALYZE_SETUP",facts:analyzeSetupContext(source,[evidence]),output:{...analysisOutput,evidenceStatus:"SELECTED_NOT_INDEPENDENTLY_VERIFIED"},validate:(v:unknown,refs:string[])=>validateAnalyzeSetup(v,refs,true)},
 {id:"WEEKLY_REVIEW",facts:weekly,output:weeklyOutput,validate:validateWeeklyReview},
 {id:"RECENT_TRADES_ANALYSIS",facts:recent,output:recentOutput,validate:validateRecentTrades},
 {id:"MONTHLY_REVIEW",facts:monthly,output:monthlyOutput,validate:validateMonthlyReview},
] satisfies {id:CitationOperation;facts:object&{sourceRefs:string[]};output:unknown;validate:(v:unknown,refs:string[])=>unknown}[];
function citing(value:unknown,ref:string):unknown{
 if(Array.isArray(value))return value.map(v=>citing(v,ref));if(!value||typeof value!=="object")return value;
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==="sourceRefs"?[ref]:citing(v,ref)]));
}
for(const c of cases)describe(c.id+" canonical citation contract",()=>{
 const contract=()=>operationContract(operationFor(c.id),c.facts);
 const schema=()=>new Ajv({strict:true}).compile(contract().schema);
 it("lists the exact manifest IDs in the prompt and versions the persisted contract",()=>{expect(operationAllowedSources(c.id,c.facts)).toEqual(c.facts.sourceRefs);expect(contract().instructions).toContain(JSON.stringify(c.facts.sourceRefs));expect(contract().instructions).toContain("Collection names");expect(contract()).toHaveProperty("version",c.id+"_CITATIONS_V2");});
 it.each(c.facts.sourceRefs)("accepts exact canonical source %s in both schema and server validator",ref=>{const raw=citing(c.output,ref);expect(schema()(raw)).toBe(true);expect(c.validate(raw,operationAllowedSources(c.id,c.facts))).toEqual(raw);});
 it.each(["selectedEvidence","events","trades","invented","TRADING OS FACTS","trades[0]","event:60000000-0000-4000-8000-000000000099","evidence:50000000-0000-4000-8000-000000000099","trade:30000000-0000-4000-8000-000000000099"])("rejects %s without dropping, rewriting or accepting the output",ref=>{const raw=citing(c.output,ref),before=structuredClone(raw);expect(schema()(raw)).toBe(false);expect(()=>c.validate(raw,operationAllowedSources(c.id,c.facts))).toThrow();expect(raw).toEqual(before);});
 it("accepts a complete manifest-only response without modifying authoritative inputs",()=>{const before=structuredClone(c.facts);expect(schema()(c.output)).toBe(true);expect(c.validate(c.output,c.facts.sourceRefs)).toEqual(c.output);expect(c.facts).toEqual(before);});
 it.each(["missing","extra","mapping","scope","operation"])("rejects a %s/tampered manifest before constructing a provider contract",kind=>{const f=structuredClone(c.facts) as unknown as Record<string,unknown>;const manifest=f.sourceManifest as {operation:string;scope:object;sources:{id:string;path:string}[]};if(kind==="missing")delete f.sourceManifest;if(kind==="extra"){(f.sourceRefs as string[]).push("events");manifest.sources.push({id:"events",path:"events"});}if(kind==="mapping")manifest.sources[0].path="unrelatedHistory";if(kind==="scope")manifest.scope={foreign:true};if(kind==="operation")manifest.operation="REVIEW_TRADE";expect(()=>operationContract(operationFor(c.id),f)).toThrow();});
 it("cannot build a contract without supplied facts",()=>expect(()=>operationContract(operationFor(c.id))).toThrow());
 it("stores one shared enum rather than multiplying allowed IDs across sections",()=>{const enums:unknown[][]=[];function visit(v:unknown){if(!v||typeof v!=="object")return;for(const [k,x] of Object.entries(v)){if(k==="enum")enums.push(x);else visit(x);}}visit(contract().schema);expect(enums.filter(x=>x.includes(c.facts.sourceRefs[0]))).toEqual([c.facts.sourceRefs]);});
});
describe("aggregate notes and exact sample boundaries",()=>{
 it.each(cases.filter(c=>c.id!=="CHALLENGE_BIAS"&&c.id!=="ANALYZE_SETUP"))("$id maps supplied note events to exact paths",c=>{const f=c.facts as typeof weekly;expect(f.sourceManifest.sources.find(s=>s.id==="event:"+ids.event)).toMatchObject({kind:"NOTE",path:"trades[0].events[0]"});});
 it("no evidence selected permits no evidence IDs in either proposal operation",()=>{for(const [op,f] of [["CHALLENGE_BIAS",biasChallengeContext(source,[])],["ANALYZE_SETUP",analyzeSetupContext(source,[])]] as const){expect(operationAllowedSources(op,f)).not.toContain("evidence:"+ids.image);expect(f.sourceRefs).not.toContain("selectedEvidence");}});
 it("an empty period excludes all trades and events instead of inventing sources",()=>{const f=weeklyReviewContext(ids.account,week,[]);expect(f.sourceRefs).toEqual(["period","sample","edge"]);});
 it("monthly deterministic summary cannot cite omitted individual trades, events or rule definitions",()=>{const f=monthlyReviewContext(ids.account,month,monthSources(31));expect(f.mode).toBe("DETERMINISTIC SUMMARY");expect(f.sourceRefs).toEqual(["period","sample","edge","models","sessions"]);const raw=citing(monthlyOutput,"trade:"+f.sample.tradeIds[0]);expect(new Ajv().compile(operationContract(operationFor("MONTHLY_REVIEW"),f).schema)(raw)).toBe(false);expect(()=>validateMonthlyReview(raw,f.sourceRefs)).toThrow();});
 it("changing selected trades without regenerating the manifest fails closed",()=>{for(const c of cases.slice(2)){const f=structuredClone(c.facts) as typeof weekly;f.trades[0].tradeId=ids.review;expect(()=>operationContract(operationFor(c.id),f)).toThrow();}});
 it("rejects duplicate included events rather than ambiguous source paths",()=>{const f=structuredClone(weekly);f.trades[0].events.push(f.trades[0].events[0]);expect(()=>withOperationSources("WEEKLY_REVIEW",f)).toThrow(/Duplicate/);});
 it("maximum weekly event envelope uses a single source enum under provider enum limits",()=>{const sources=structuredClone(weekSources);sources[0].events=Array.from({length:200},(_,i)=>({...sources[0].events[0],id:"60000000-0000-4000-8000-"+String(i).padStart(12,"0")}));const f=weeklyReviewContext(ids.account,week,sources);expect(f.sourceRefs).toHaveLength(204);const schema=operationContract(operationFor("WEEKLY_REVIEW"),f).schema;expect(new Ajv({strict:true}).compile(schema)(weeklyOutput)).toBe(true);expect(JSON.stringify(schema).match(/"enum"/g)).toHaveLength(1);});
});

describe("large aggregate citation enums",()=>{
 it("preserves all 625 bounded source IDs with provider-compatible enum branches",()=>{
  const ids=Array.from({length:625},(_,i)=>"event:60000000-0000-4000-8000-"+String(i).padStart(12,"0"));
  const schema=citationSchema({type:"object",additionalProperties:false,required:["sourceRefs"],properties:{sourceRefs:{type:"array",minItems:1,items:{type:"string"}}}},ids);
  const validate=new Ajv({strict:true}).compile(schema),defs=schema.$defs as {canonicalCitation:{anyOf:{enum:string[]}[]}};
  expect(defs.canonicalCitation.anyOf.flatMap(b=>b.enum)).toEqual(ids);
  for(const branch of defs.canonicalCitation.anyOf){expect(branch.enum.length).toBeLessThanOrEqual(250);expect(branch.enum.join("").length).toBeLessThan(15000);}
  for(const ref of [ids[0],ids[249],ids[250],ids[500],ids[624]])expect(validate({sourceRefs:[ref]})).toBe(true);
  for(const ref of ["events","selectedEvidence","event:outside-sample"])expect(validate({sourceRefs:[ref]})).toBe(false);
 });
});
