import {plan,trade,strategy,risk,events,ids} from "./trade-review";
import {monthlyReviewContext} from "@/ai/monthly-review-context";
import type {MonthlyReviewOutput} from "@/ai/monthly-review-contract";
export {ids};
export const month="2026-08";
export const sources=JSON.parse(JSON.stringify([{plan,trade,strategy,risk,events}]).replaceAll("2026-09-","2026-08-")) as {plan:typeof plan;trade:typeof trade;strategy:typeof strategy;risk:typeof risk;events:typeof events}[];
export const facts=monthlyReviewContext(ids.account,month,sources,"2026-09-23T12:00:00Z");
const observation={text:"This small sample cannot establish a recurring behavioral cause. More recorded execution evidence is needed.",sourceRefs:["sample"]};
export const monthlyOutput:MonthlyReviewOutput={monthSummary:observation,processQuality:[observation],ruleAdherence:[observation],entryModelPatterns:[observation],sessionPatterns:[observation],executionQuality:[observation],behavioralPatterns:[observation],recurringStrengths:[observation],recurringMistakes:[observation],whatImproved:[observation],whatDegraded:[observation],keyLessons:[observation],focusNextMonth:[observation]};
export function monthSources(count:number){return Array.from({length:count},(_,i)=>{const s=structuredClone(sources[0]),id="30000000-0000-4000-8000-"+String(i+1).padStart(12,"0");s.plan.id=id;s.trade.id=id;s.events=[];return s;});}
