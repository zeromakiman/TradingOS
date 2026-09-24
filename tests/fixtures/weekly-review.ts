import {plan,trade,strategy,risk,events,ids} from "./trade-review";
import {weeklyReviewContext} from "@/ai/weekly-review-context";
import type {WeeklyReviewOutput} from "@/ai/weekly-review-contract";
export {ids};
export const week="2026-08-31";
export const sources=[{plan,trade,strategy,risk,events}];
export const facts=weeklyReviewContext(ids.account,week,sources,"2026-09-23T12:00:00Z");
const observation={text:"One recorded trade is too small a sample to establish a recurring pattern. Visual evidence is not supplied.",sourceRefs:["sample","trade:"+ids.plan]};
export const weeklyOutput:WeeklyReviewOutput={weekSummary:observation,processQuality:[observation],ruleAdherence:[observation],setupModelPatterns:[observation],executionMistakes:[observation],behavioralPatterns:[observation],whatImproved:[{text:"Improvement cannot be established from this sample; no prior-week comparison was supplied.",sourceRefs:["sample"]}],needsAttention:[observation],focusNextWeek:[{text:"Keep recording execution notes and adherence to the supplied rules.",sourceRefs:["sample"]}]};
