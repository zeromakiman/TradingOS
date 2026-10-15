import {z} from "zod";

export interface CitationSource {id:string;kind:string;path:string;description:string}
const record=z.record(z.string(),z.unknown());
const identity=z.object({id:z.uuid()});
const event=z.object({id:z.uuid(),event_type:z.string()});
const trade=z.object({tradeId:z.uuid(),events:z.array(event).optional()});
const versions={CHALLENGE_BIAS:"CHALLENGE_BIAS_FACTS_V1",ANALYZE_SETUP:"ANALYZE_SETUP_FACTS_V1",WEEKLY_REVIEW:"WEEKLY_REVIEW_FACTS_V1",RECENT_TRADES_ANALYSIS:"RECENT_TRADES_FACTS_V1",MONTHLY_REVIEW:"MONTHLY_REVIEW_FACTS_V1"} as const;
export type CitationOperation=keyof typeof versions;
const stable=(value:unknown):string=>JSON.stringify(value,(_,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
/** Derive IDs only from the already ownership/period-filtered snapshot, never from caller-provided sourceRefs. */
export function operationSourceManifest(operation:CitationOperation,context:unknown){
 const f=record.parse(context);
 if(f.version!==versions[operation])throw new Error("Citation operation/context mismatch");
 const sources:CitationSource[]=[],scope:Record<string,unknown>={};
 function fixed(id:string,kind:string,path:string,description:string){if(!Object.hasOwn(f,path))throw new Error("Missing canonical source: "+path);sources.push({id,kind,path,description});}
 if(operation==="CHALLENGE_BIAS"||operation==="ANALYZE_SETUP"){
  scope.proposalId=z.uuid().parse(f.proposalId);
  for(const key of ["proposal","strategy","deterministic"])record.parse(f[key]);z.string().parse(f.currentThesis);
  fixed("proposal","PROPOSAL","proposal","Current saved proposal; not permission to trade");
  fixed("currentThesis","THESIS","currentThesis","User-recorded thesis; unverified assertions");
  fixed("strategy","STRATEGY","strategy","Supplied strategy version and rules");
  fixed("deterministic","CALCULATIONS","deterministic","Recorded Risk Engine result, risk version, session and calculations");
  z.array(identity).max(3).parse(f.selectedEvidence).forEach((e,i)=>{sources.push({id:`evidence:${e.id}`,kind:"EVIDENCE",path:`selectedEvidence[${i}]`,description:"Explicitly selected evidence for this proposal"});});
 }else{
  const rows=z.array(trade).max(operation==="WEEKLY_REVIEW"?40:operation==="RECENT_TRADES_ANALYSIS"?30:120).parse(f.trades);
  const ids=rows.map(t=>t.tradeId);if(new Set(ids).size!==ids.length)throw new Error("Duplicate cited trade");scope.tradeIds=ids;
  if(operation!=="RECENT_TRADES_ANALYSIS"){scope.period=z.object({start:z.string(),endExclusive:z.string()}).parse(f.period);fixed("period","PERIOD","period","Exact selected period and fixed UTC-5 boundaries");}
  record.parse(f.sample);record.parse(f.edge);
  fixed("sample","SAMPLE","sample","Exact sample size and deterministic limitations");fixed("edge","CALCULATIONS","edge","Existing deterministic EDGE metrics for this sample only");
  const summary=operation==="MONTHLY_REVIEW"&&f.mode==="DETERMINISTIC SUMMARY";
  if(operation==="MONTHLY_REVIEW"){
   if(!summary&&f.mode!=="DETAILED")throw new Error("Unknown monthly citation mode");
   const breakdowns=record.parse(f.breakdowns);for(const [id,path] of [["models","entryModels"],["sessions","sessions"]]){if(!Object.hasOwn(breakdowns,path))throw new Error("Missing aggregate source");sources.push({id,kind:"CALCULATIONS",path:`breakdowns.${path}`,description:"Existing deterministic breakdown for the selected month"});}
  }
  if(operation!=="WEEKLY_REVIEW"){
   const sample=z.object({tradeIds:z.array(z.uuid())}).parse(f.sample);if(stable(sample.tradeIds)!==stable(ids))throw new Error("Citation sample IDs mismatch");
  }
  // Summary mode intentionally omits trade/event details. Retained IDs alone are not evidence for those details.
  if(!summary){
   rows.forEach((t,i)=>{sources.push({id:`trade:${t.tradeId}`,kind:"TRADE",path:`trades[${i}]`,description:"Included closed trade's supplied plan, execution and deterministic facts"});});
   if(operation!=="WEEKLY_REVIEW")for(const [key,prefix,kind] of [["strategyVersions","strategy","STRATEGY"],["riskVersions","risk","RISK_VERSION"]])z.array(identity).parse(f[key]).forEach((v,i)=>{sources.push({id:`${prefix}:${v.id}`,kind,path:`${key}[${i}]`,description:"Original version supplied for the included trades"});});
   rows.forEach((t,i)=>{if(!t.events)throw new Error("Missing included event list");t.events.forEach((e,j)=>{sources.push({id:`event:${e.id}`,kind:e.event_type==="NOTE_ADDED"?"NOTE":"EVENT",path:`trades[${i}].events[${j}]`,description:e.event_type==="NOTE_ADDED"?"Included recorded note event":"Included recorded trade event"});});});
  }
 }
 if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new Error("Duplicate canonical citation source");
 return {version:"AI_CITATIONS_V1",operation,scope,sources};
}
export function withOperationSources<T extends object>(operation:CitationOperation,facts:T){
 const sourceManifest=operationSourceManifest(operation,facts);return {...facts,sourceManifest,sourceRefs:sourceManifest.sources.map(s=>s.id)};
}
export function operationAllowedSources(operation:CitationOperation,context:unknown){
 const facts=record.parse(context),expected=operationSourceManifest(operation,facts),ids=expected.sources.map(s=>s.id);
 if(stable(facts.sourceManifest)!==stable(expected)||stable(facts.sourceRefs)!==stable(ids))throw new Error("Citation manifest does not match supplied facts");
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
export function canonicalOperationContract(operation:CitationOperation,context:unknown,contract:{name:string;instructions:string;schema:object}){
 const ids=operationAllowedSources(operation,context);return {...contract,version:operation+"_CITATIONS_V2",instructions:contract.instructions+citationInstructions(ids),schema:citationSchema(contract.schema,ids)};
}
