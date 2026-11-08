import {z} from "zod";

export interface CitationSource {id:string;kind:string;path:string;description?:string}
const record=z.record(z.string(),z.unknown());
const identity=z.object({id:z.uuid()});
const event=z.object({id:z.uuid(),event_type:z.string()});
/** A V2 periodic journal entry: a row whose first column is its id (`PERIODIC_JOURNAL_COLUMNS`), or an object with its id. */
const journal=z.union([z.tuple([z.uuid()],z.unknown()),z.object({id:z.uuid()})]);
const journalId=(entry:z.infer<typeof journal>)=>Array.isArray(entry)?entry[0]:entry.id;
const trade=z.object({tradeId:z.uuid(),events:z.array(event).optional()});
/** A V2 periodic trade lists events and journal entries only when it has them. */
const tradeV2=z.object({tradeId:z.uuid(),tradeRecordId:z.uuid(),events:z.array(event).default([]),journal:z.array(journal).default([])});
/**
 * Facts versions each operation accepts. Stored V1 periodic facts keep their V1 manifest (with per-source descriptions
 * and a sourceRefs list); new periodic requests send the compact V2 facts, which carry no manifest: their allowed ids
 * are derived from the facts by `operationSourceManifest` and enumerated once, in the response schema, and the
 * instructions say what each kind of id names (`periodicCitationInstructions`). Pre-trade V2 facts differ from V1 only
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
    t.journal.forEach((e,j)=>{push(`journal:${journalId(e)}`,"JOURNAL",`trades[${i}].journal[${j}]`,"");});
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
/** V1 facts carry the manifest and the sourceRefs list; V2 periodic facts carry neither (`verifiedPeriodicFactsV2`). */
export function withOperationSources<T extends object>(operation:CitationOperation,facts:T){
 const sourceManifest=operationSourceManifest(operation,facts);return {...facts,sourceManifest,sourceRefs:sourceManifest.sources.map(s=>s.id)};
}
/**
 * V2 periodic facts as they are stored and sent: no manifest and no sourceRefs list, because the allowed ids follow
 * from the facts themselves and the response schema enumerates them. Their manifest is derived here once, so facts
 * whose ids are malformed or not unique are refused before anything is written.
 */
export function verifiedPeriodicFactsV2<T extends object>(operation:Extract<CitationOperation,"WEEKLY_REVIEW"|"RECENT_TRADES_ANALYSIS"|"MONTHLY_REVIEW">,facts:T):T{
 if(!isV2PeriodicFacts(facts)||Object.hasOwn(facts,"sourceManifest")||Object.hasOwn(facts,"sourceRefs"))throw new Error("Compact citation sources are for V2 periodic facts without a stored manifest");
 operationSourceManifest(operation,facts);
 return facts;
}
/**
 * The allowed citation ids of stored or new facts. V1 facts must carry exactly the manifest and sourceRefs derived from
 * them. V2 periodic facts carry no sourceRefs; a manifest stored with earlier V2 facts must still match exactly.
 */
export function operationAllowedSources(operation:CitationOperation,context:unknown){
 const facts=record.parse(context),expected=operationSourceManifest(operation,facts),ids=expected.sources.map(s=>s.id);
 const v2=isV2PeriodicFacts(facts);
 const manifestMatches=v2&&!Object.hasOwn(facts,"sourceManifest")?true:stable(facts.sourceManifest)===stable(expected);
 if(!manifestMatches||(v2?Object.hasOwn(facts,"sourceRefs"):stable(facts.sourceRefs)!==stable(ids)))throw new Error("Citation manifest does not match supplied facts");
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
 * A periodic response schema with its one observation object defined once (`$defs.observation`) and referenced by every
 * section, instead of repeated in each: the same constraints in fewer tokens, which count toward the input limit.
 * Every section must use the identical observation schema; anything else is refused.
 */
export function sharedObservationSchema(schema:object){
 const result=structuredClone(schema) as Record<string,unknown>;
 const properties=result.properties as Record<string,Record<string,unknown>>|undefined;
 if(!properties||typeof properties!=="object")throw new Error("Invalid periodic response schema");
 const defs=(result.$defs??{}) as Record<string,unknown>;if(Object.hasOwn(defs,"observation"))throw new Error("Reserved observation definition");
 let observation:unknown=null;
 const shared=(node:unknown)=>{
  if(!node||typeof node!=="object"||!Object.hasOwn(node,"properties"))throw new Error("Periodic sections must be observations");
  if(observation===null)observation=node;else if(stable(node)!==stable(observation))throw new Error("Periodic sections must share one observation schema");
  return {$ref:"#/$defs/observation"};
 };
 for(const [name,property] of Object.entries(properties))properties[name]=property.type==="array"?{...property,items:shared(property.items)}:shared(property);
 if(observation===null)throw new Error("Missing observation schema");
 result.$defs={...defs,observation};
 return result;
}
/** What each kind of canonical id of V2 periodic facts names, in the order the instructions list them. */
const PERIODIC_ID_FORMS:readonly (readonly [form:string,matches:(id:string)=>boolean,meaning:string])[]=[
 ["trade:<tradeRecordId>",id=>id.startsWith("trade:"),"an included closed planned trade: its locked plan, compact Risk Engine result and execution"],
 ["journal:<id>",id=>id.startsWith("journal:"),"a journal entry of an included trade (the id in the first column of its row)"],
 ["event:<id>",id=>id.startsWith("event:"),"a recorded event of an included trade; a NOTE_ADDED event is a note"],
 ["strategy:<id>",id=>id.startsWith("strategy:"),"a supplied strategy version"],
 ["risk:<id>",id=>id.startsWith("risk:"),"a supplied risk version"],
 ["period",id=>id==="period","the selected period and its fixed UTC-5 boundaries"],
 ["sample",id=>id==="sample","the exact sample size and its deterministic limitations"],
 ["edge",id=>id==="edge","the existing deterministic EDGE metrics of this sample"],
 ["models",id=>id==="models","the existing deterministic breakdown of the month by entry model"],
 ["sessions",id=>id==="sessions","the existing deterministic breakdown of the month by session"],
];
/**
 * Citation rules of V2 periodic facts. The allowed ids follow from the facts and the response schema enumerates them
 * exactly (as in the timeline-aware trade review), so neither the facts nor the prompt repeat the list: the prompt
 * says once what each kind of id present names.
 */
export function periodicCitationInstructions(ids:readonly string[]){
 const forms=PERIODIC_ID_FORMS.filter(([,matches])=>ids.some(matches)).map(([form,,meaning])=>`${form} is ${meaning}`);
 const records=ids.some(id=>id.startsWith("journal:")||id.startsWith("event:"));
 return `\nCANONICAL CITATIONS: sourceRefs may contain only canonical ids; the response schema enumerates every allowed id exactly. ${forms.join("; ")}. Collection names, JSON property names, data paths, headings and invented ids are forbidden. Never cite records outside this snapshot.${records?" Journal entries and events with timing AFTER_CLOSE are hindsight: never cite them as evidence of what was planned or known before entry.":""} A citation does not make an unverified assertion a fact.`;
}
export function canonicalOperationContract(operation:CitationOperation,context:unknown,contract:{name:string;instructions:string;schema:object}){
 const ids=operationAllowedSources(operation,context);
 if(isV2PeriodicFacts(context))return {...contract,version:`${operation}_CITATIONS_V3`,instructions:contract.instructions+periodicCitationInstructions(ids),schema:citationSchema(sharedObservationSchema(contract.schema),ids)};
 return {...contract,version:operation+"_CITATIONS_V2",instructions:contract.instructions+citationInstructions(ids),schema:citationSchema(contract.schema,ids)};
}
