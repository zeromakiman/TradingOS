import { z } from "zod";

const fixedSources = [
 {id:"originalPlan",kind:"PLAN",path:"originalPlan",description:"Immutable original plan and recorded proposal"},
 {id:"strategy",kind:"STRATEGY",path:"strategy",description:"Sealed strategy version and supplied rules"},
 {id:"riskVersion",kind:"RISK_VERSION",path:"riskVersion",description:"Sealed risk-plan version"},
 {id:"deterministic",kind:"CALCULATIONS",path:"deterministic",description:"Authoritative Risk Engine result and calculations"},
 {id:"execution",kind:"EXECUTION",path:"execution",description:"Recorded execution, result and realized R"},
 {id:"tags",kind:"TAGS",path:"tags",description:"Recorded tags; null fields are not evidence"},
];
const eventSource = z.object({id:z.uuid(),event_type:z.string()});
const evidenceSource = z.object({id:z.uuid()});
/** Existing canonical IDs are scoped to this trade. Notes are NOTE_ADDED events, not separate records. */
export function tradeReviewSourceManifest(tradeId:string,events:{id:string;event_type:string}[],evidence:{id:string}[]) {
 z.uuid().parse(tradeId);
 const eventRows=z.array(eventSource).parse(events), evidenceRows=z.array(evidenceSource).parse(evidence);
 const sources=[...fixedSources.map(source=>({...source})),
  ...eventRows.map((event,index)=>({id:`event:${event.id}`,kind:event.event_type==="NOTE_ADDED"?"NOTE":"EVENT",path:`events[${index}]`,description:event.event_type==="NOTE_ADDED"?"Recorded note event":"Recorded trade event"})),
  ...evidenceRows.map((image,index)=>({id:`evidence:${image.id}`,kind:"EVIDENCE",path:`selectedEvidence[${index}]`,description:"Explicitly selected evidence for this trade"})),
 ];
 if(new Set(sources.map(source=>source.id)).size!==sources.length)throw new Error("Duplicate trade review source");
 return {version:"REVIEW_TRADE_SOURCES_V1",tradeId,sources};
}
/** Fail closed before dispatch if the manifest differs from the supplied facts. Ownership is enforced by the caller. */
export function tradeReviewAllowedSources(context:unknown):string[] {
 const facts=z.object({tradeId:z.uuid(),originalPlan:z.record(z.string(),z.unknown()),strategy:z.record(z.string(),z.unknown()),riskVersion:z.record(z.string(),z.unknown()),deterministic:z.record(z.string(),z.unknown()),execution:z.record(z.string(),z.unknown()),tags:z.record(z.string(),z.unknown()),events:z.array(eventSource).max(200),selectedEvidence:z.array(evidenceSource).max(4),sourceManifest:z.unknown(),sourceRefs:z.array(z.string())}).parse(context);
 const expected=tradeReviewSourceManifest(facts.tradeId,facts.events,facts.selectedEvidence),ids=expected.sources.map(source=>source.id);
 if(JSON.stringify(facts.sourceManifest)!==JSON.stringify(expected)||JSON.stringify(facts.sourceRefs)!==JSON.stringify(ids))throw new Error("Trade review source manifest does not match supplied facts");
 return ids;
}
