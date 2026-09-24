import {plan,trade,strategy,risk,events,ids} from "./trade-review";
import {recentTradesContext} from "@/ai/recent-trades-context";
import type {RecentTradesOutput} from "@/ai/recent-trades-contract";
export {ids};
export const capturedAt="2026-09-23T12:00:00.000Z";
export const sources=[{plan,trade,strategy,risk,events}];
export function makeSources(count:number){
 return Array.from({length:count},(_,i)=>{const s=structuredClone(sources[0]),id="30000000-0000-4000-8000-"+String(i+1).padStart(12,"0");
 const entered=new Date(Date.UTC(2026,7,i+1,8)).toISOString(),exit=new Date(Date.UTC(2026,7,i+1,9)).toISOString();
 s.plan.id=id;s.trade.id=id;s.trade.entered_at=entered;s.trade.exited_at=exit;s.events=s.events.map(e=>({...e,id:"60000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),occurred_at:exit,recorded_at:exit}));return s;});
}
export const facts=recentTradesContext(ids.account,20,sources,capturedAt);
const observation={text:"This small sample cannot establish a recurring behavioral cause. More consistent execution notes would help distinguish process from outcome.",sourceRefs:["sample","trade:"+ids.plan]};
export const recentOutput:RecentTradesOutput={strengths:[observation],executionMistakes:[observation],entryModelPatterns:[observation],sessionPatterns:[observation],processDiscipline:[observation],behavioralPatterns:[observation],outliers:[{text:"A single recorded result is not sufficient to define an outlier pattern.",sourceRefs:["sample"]}],monitorNext:[{text:"Monitor recorded adherence to the supplied rules, not market predictions.",sourceRefs:["sample"]}]};
