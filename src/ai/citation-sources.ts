import {z} from "zod";

export interface CitationSource {id:string;kind:string;path:string;description?:string}
const record=z.record(z.string(),z.unknown());
const identity=z.object({id:z.uuid()});
const event=z.object({id:z.uuid(),event_type:z.string()});
const journal=z.object({id:z.uuid()});
const trade=z.object({tradeId:z.uuid(),events:z.array(event).optional()});
const tradeV2=z.object({tradeId:z.uuid(),tradeRecordId:z.uuid(),events:z.array(event),journal:z.array(journal)});
/**
 * Facts versions each operation accepts. Stored V1 periodic facts keep their V1 manifest (with per-source descriptions
 * and a sourceRefs list); new periodic requests send the compact V2 facts, whose manifest describes each kind once and
 * whose allowed ids are the manifest ids (the response schema enumerates them). Pre-trade V2 facts differ from V1 only
 * by the strategy's written prompt, which is not a citation source: both share one manifest.
 */
const versions={
 CHALLENGE_BIAS:["CHALLENGE_BIAS_FACTS_V1","CHALLENGE_BIAS_FACTS_V2"],ANALYZE_SETUP:["ANALYZE_SETUP_FACTS_V1","ANALYZE_SETUP_FACTS_V2"],
 WEEKLY_REVIEW:["WEEKLY_REVIEW_FACTS_V1","WEEKLY_REVIEW_FACTS_V2"],RECENT_TRADES_ANALYSIS:["RECENT_TRADES_FACTS_V1","RECENT_TRADES_FACTS_V2"],MONTHLY_REVIEW:["MONTHLY_REVIEW_FACTS_V1","MONTHLY_REVIEW_FACTS_V2"],
} as const satisfies Record<string,readonly string[]>;
export type CitationOperation=keyof typeof versions;
const V2_FACTS:ReadonlySet<string>=new Set(["WEEKLY_REVIEW_FACTS_V2","RECENT_TRADES_FACTS_V2","MONTHLY_REVIEW_FACTS_V2"]);
/** What each V2 source kind refers to; the timing of every journal entry and event is in its record. */
export const PERIODIC_SOURCE_KINDS=Object.freeze({
 PERIOD:"Exact selected period and fixed UTC-5 boundaries",
 SAMPLE:"Exact sample size and deterministic limitations",
 CALCULATIONS:"Existing deterministic EDGE metrics or breakdowns for this sample only",
 TRADE:"Included closed planned trade: its locked plan, compact Risk Engine result and execution",
 STRATEGY:"Original strategy version supplied for the included trades",
 RISK_VERSION:"Original risk version supplied for the included trades",
 JOURNAL:"Included journal entry; its timing says whether it was written before entry, while live or after close (hindsight)",
 NOTE:"Included recorded note event; its timing says when it was written",
 EVENT:"Included recorded trade event",
});
const stable=(value:unknown):string=>JSON.stringify(value,(_,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
/** Whether the facts are a compact V2 periodic snapshot. */
export function isV2PeriodicFacts(context:unknown):boolean{const parsed=record.safeParse(context);return parsed.success&&typeof parsed.data.version==="string"&&V2_FACTS.has(parsed.data.version);}
/** Derive IDs only from the already ownership/period-filtered snapshot, never from caller-provided sourceRefs. */
export function operationSourceManifest(operation:CitationOperation,context:unknown){
 const f=record.parse(context);
 if(!(versions[operation] as readonly string[]).includes(String(f.version)))throw new Error("Citation operation/context mismatch");
 const v2=V2_FACTS.has(String(f.version));
 const sources:CitationSource[]=[],scope:Record<string,unknown>={};
 const push=(id:string,kind:keyof typeof PERIODIC_SOURCE_KINDS|string,path:string,description:string)=>{sources.push(v2?{id,kind,path}:{id,kind,path,description});};
 function fixed(id:string,kind:string,path:string,description:string){if(!Object.hasOwn(f,path))throw new Error("Missing canonical source: "+path);push(id,kind,path,description);}
 if(operation==="CHALLENGE_BIAS"||operation==="ANALYZE_SETUP"){
  scope.proposalId=z.uuid().parse(f.proposalId);
  for(const key of ["proposal","strategy","deterministic"])record.parse(f[key]);z.string().parse(f.currentThesis);
  fixed("proposal","PROPOSAL","proposal","Current saved proposal; not permission to trade");
  fixed("currentThesis","THESIS","currentThesis","User-recorded thesis; unverified assertions");
  fixed("strategy","STRATEGY","strategy","Supplied strategy version and rules");
  fixed("deterministic","CALCULATIONS","deterministic","Recorded Risk Engine result, risk version, session and calculations");
  z.array(identity).max(3).parse(f.selectedEvidence).forEach((e,i)=>{sources.push({id:`evidence:${e.id}`,kind:"EVIDENCE",path:`selectedEvidence[${i}]`,description:"Explicitly selected evidence for this proposal"});});
 }else{
  const max=operation==="WEEKLY_REVIEW"?40:operation==="RECENT_TRADES_ANALYSIS"?30:120;
  const summary=operation==="MONTHLY_REVIEW"&&f.mode==="DETERMINISTIC SUMMARY";
  const rows=z.array(trade).max(max).parse(f.trades);
  const ids=rows.map(t=>t.tradeId);if(new Set(ids).size!==ids.length)throw new Error("Duplicate cited trade");scope.tradeIds=ids;
  if(operation!=="RECENT_TRADES_ANALYSIS"){scope.period=z.object({start:z.string(),endExclusive:z.string()}).parse(f.period);fixed("period","PERIOD","period","Exact selected period and fixed UTC-5 boundaries");}
  record.parse(f.sample);record.parse(f.edge);
  fixed("sample","SAMPLE","sample","Exact sample size and deterministic limitations");fixed("edge","CALCULATIONS","edge","Existing deterministic EDGE metrics for this sample only");
  if(operation==="MONTHLY_REVIEW"){
   if(!summary&&f.mode!=="DETAILED")throw new Error("Unknown monthly citation mode");
   const breakdowns=record.parse(f.breakdowns);for(const [id,path] of [["models","entryModels"],["sessions","sessions"]]){if(!Object.hasOwn(breakdowns,path))throw new Error("Missing aggregate source");push(id,"CALCULATIONS",`breakdowns.${path}`,"Existing deterministic breakdown for the selected month");}
  }
  if(operation!=="WEEKLY_REVIEW"){
   const sample=z.object({tradeIds:z.array(z.uuid())}).parse(f.sample);if(stable(sample.tradeIds)!==stable(ids))throw new Error("Citation sample IDs mismatch");
  }
  // Summary mode intentionally omits trade/event details. Retained IDs alone are not evidence for those details.
  if(!summary&&v2){
   const detailed=z.array(tradeV2).max(max).parse(f.trades);
   const tradeRefs=detailed.map(t=>t.tradeRecordId);if(new Set(tradeRefs).size!==tradeRefs.length)throw new Error("Duplicate cited trade");
   detailed.forEach((t,i)=>{push(`trade:${t.tradeRecordId}`,"TRADE",`trades[${i}]`,"");});
   for(const [key,prefix,kind] of [["strategyVersions","strategy","STRATEGY"],["riskVersions","risk","RISK_VERSION"]])z.array(identity).parse(f[key]).forEach((v,i)=>{push(`${prefix}:${v.id}`,kind,`${key}[${i}]`,"");});
   detailed.forEach((t,i)=>{
    t.events.forEach((e,j)=>{push(`event:${e.id}`,e.event_type==="NOTE_ADDED"?"NOTE":"EVENT",`trades[${i}].events[${j}]`,"");});
    t.journal.forEach((e,j)=>{push(`journal:${e.id}`,"JOURNAL",`trades[${i}].journal[${j}]`,"");});
   });
  }else if(!summary){
   rows.forEach((t,i)=>{sources.push({id:`trade:${t.tradeId}`,kind:"TRADE",path:`trades[${i}]`,description:"Included closed trade's supplied plan, execution and deterministic facts"});});
   if(operation!=="WEEKLY_REVIEW")for(const [key,prefix,kind] of [["strategyVersions","strategy","STRATEGY"],["riskVersions","risk","RISK_VERSION"]])z.array(identity).parse(f[key]).forEach((v,i)=>{sources.push({id:`${prefix}:${v.id}`,kind,path:`${key}[${i}]`,description:"Original version supplied for the included trades"});});
   rows.forEach((t,i)=>{if(!t.events)throw new Error("Missing included event list");t.events.forEach((e,j)=>{sources.push({id:`event:${e.id}`,kind:e.event_type==="NOTE_ADDED"?"NOTE":"EVENT",path:`trades[${i}].events[${j}]`,description:e.event_type==="NOTE_ADDED"?"Included recorded note event":"Included recorded trade event"});});});
  }
 }
 if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error("Duplicate canonical citation source");
 if(v2)return {version:"AI_CITATIONS_V2",operation,scope,kinds:Object.fromEntries([...new Set(sources.map(s=>s.kind))].map(kind=>[kind,PERIODIC_SOURCE_KINDS[kind as keyof typeof PERIODIC_SOURCE_KINDS]])),sources};
 return {version:"AI_CITATIONS_V1",operation,scope,sources};
}
/** V1 facts carry the manifest and the sourceRefs list; V2 periodic facts carry the manifest only (its ids are the allowed ids). */
export function withOperationSources<T extends object>(operation:CitationOperation,facts:T){
 const sourceManifest=operationSourceManifest(operation,facts);return {...facts,sourceManifest,sourceRefs:sourceManifest.sources.map(s=>s.id)};
}
export function withPeriodicSourcesV2<T extends object>(operation:Extract<CitationOperation,"WEEKLY_REVIEW"|"RECENT_TRADES_ANALYSIS"|"MONTHLY_REVIEW">,facts:T){
 if(!isV2PeriodicFacts(facts))throw new Error("Compact citation manifests are for V2 periodic facts");
 return {...facts,sourceManifest:operationSourceManifest(operation,facts)};
}
export function operationAllowedSources(operation:CitationOperation,context:unknown){
 const facts=record.parse(context),expected=operationSourceManifest(operation,facts),ids=expected.sources.map(s=>s.id);
 const v2=isV2PeriodicFacts(facts);
 if(stable(facts.sourceManifest)!==stable(expected)||(v2?Object.hasOwn(facts,"sourceRefs"):stable(facts.sourceRefs)!==stable(ids)))throw new Error("Citation manifest does not match supplied facts");
 return ids;
}
export function citationInstructions(ids:readonly string[]){return "\nCANONICAL CITATIONS: Only the exact allowed IDs below may appear in sourceRefs. The sourceManifest maps each ID to supplied facts. Collection names (including selectedEvidence, events, trades), JSON property names, data paths, headings and invented IDs are forbidden unless explicitly listed as canonical IDs. Cite event:<id> only for an included event/note and evidence:<id> only for explicitly selected evidence. Never cite absent screenshots/events or trades outside this snapshot. Explain missing evidence using an available proposal, thesis, strategy, sample or trade source. A citation does not make an unverified assertion a fact.\nAllowed source IDs for this request (exact strings only): "+JSON.stringify(ids);}
/** One shared enum avoids repeating hundreds of aggregate IDs across every observation field. */
export function citationSchema(schema:object,ids:readonly string[]){
 if(!ids.length||new Set(ids).size!==ids.length)throw new Error("Invalid canonical citation enum");
 const result=structuredClone(schema) as Record<string,unknown>;
 const defs=(result.$defs??{}) as Record<string,unknown>;if(Object.hasOwn(defs,"canonicalCitation"))throw new Error("Reserved citation definition");
 let fields=0;
 function visit(value:unknown){if(!value||typeof value!=="object")return;const node=value as Record<string,unknown>;
  if(node.properties&&typeof node.properties==="object"){
   const ref=(node.properties as Record<string,unknown>).sourceRefs;if(ref&&typeof ref==="object"){const field=ref as Record<string,unknown>;if(field.type!=="array")throw new Error("Invalid citation field");field.items={$ref:"#/$defs/canonicalCitation"};fields++;}
  }
  for(const child of Object.values(node))visit(child);
 }
 visit(result);if(!fields)throw new Error("Missing citation fields");delete result.$schema;
 // Bounded enum branches retain the exact allowlist for large event manifests.
 // Structured Outputs limits each >250-value string enum to 15,000 characters.
 const branches=Array.from({length:Math.ceil(ids.length/250)},(_,i)=>({type:"string",enum:ids.slice(i*250,(i+1)*250)}));
 result.$defs={...defs,canonicalCitation:branches.length===1?branches[0]:{anyOf:branches}};return result;
}
/**
 * Citation rules of V2 periodic facts. The allowed ids are the manifest ids and the response schema enumerates them
 * exactly (as in the timeline-aware trade review), so the prompt does not repeat the list.
 */
export const PERIODIC_CITATION_INSTRUCTIONS="\nCANONICAL CITATIONS: sourceRefs may contain only canonical ids of sourceManifest.sources; the response schema enumerates them exactly. Cite trade:<tradeRecordId> for an included trade, journal:<id> for an included journal entry, event:<id> for an included event, strategy:<id> and risk:<id> for the supplied versions, and the fixed ids for the period, the sample and the deterministic metrics. Collection names, JSON property names, data paths, headings and invented ids are forbidden. Never cite records outside this snapshot. Journal entries and events with timing AFTER_CLOSE are hindsight: never cite them as evidence of what was planned or known before entry. A citation does not make an unverified assertion a fact.";
export function canonicalOperationContract(operation:CitationOperation,context:unknown,contract:{name:string;instructions:string;schema:object}){
 const ids=operationAllowedSources(operation,context);
 if(isV2PeriodicFacts(context))return {...contract,version:`${operation}_CITATIONS_V3`,instructions:contract.instructions+PERIODIC_CITATION_INSTRUCTIONS,schema:citationSchema(contract.schema,ids)};
 return {...contract,version:operation+"_CITATIONS_V2",instructions:contract.instructions+citationInstructions(ids),schema:citationSchema(contract.schema,ids)};
}
