import {describe,it,expect,vi} from "vitest";
import {createElement,type ComponentProps} from "react";
import {renderToStaticMarkup} from "react-dom/server";
vi.mock("server-only",()=>({}));
vi.mock("@/app/bias-challenge-actions",()=>({requestBiasChallenge:vi.fn()}));
vi.mock("@/app/analyze-setup-actions",()=>({requestAnalyzeSetup:vi.fn()}));
vi.mock("@/app/weekly-review-actions",()=>({requestWeeklyReview:vi.fn()}));
vi.mock("@/app/recent-trades-actions",()=>({requestRecentTrades:vi.fn()}));
vi.mock("@/app/monthly-review-actions",()=>({requestMonthlyReview:vi.fn()}));
vi.mock("@/app/trade-review-actions",()=>({requestTradeReview:vi.fn()}));
import {BiasChallengePanel} from "@/components/bias-challenge";
import {AnalyzeSetupPanel} from "@/components/analyze-setup";
import {WeeklyReviewPanel} from "@/components/weekly-review";
import {RecentTradesPanel} from "@/components/recent-trades";
import {MonthlyReviewPanel} from "@/components/monthly-review";
import {TradeAiReview} from "@/components/trade-ai-review";
import {biasChallengeContext} from "@/ai/bias-challenge-context";
import {analyzeSetupContext} from "@/ai/analyze-setup-context";
import {tradeReviewContext} from "@/ai/trade-review-context";
import {source,ids} from "./fixtures/bias-challenge";
import {facts as weekly} from "./fixtures/weekly-review";
import {facts as recent} from "./fixtures/recent-trades";
import {facts as monthly,monthlyOutput} from "./fixtures/monthly-review";
import {plan,trade,strategy,risk,events} from "./fixtures/trade-review";
const proposal=biasChallengeContext(source,[]),analysis=analyzeSetupContext(source,[]),review=tradeReviewContext(plan,trade,strategy,risk,events,[]);
// Historical facts without the new manifest must remain readable; no stored row is rewritten.
const legacy=(facts:object)=>Object.fromEntries(Object.entries(facts).filter(([k])=>k!=="sourceManifest"));
function data(facts:object,disposition:string|null|undefined){
 return {account:{id:ids.account,name:"Synthetic"},period:weekly.period,requested:20,eligible:1,amount:59400,facts,scopeError:null,closed:true,locked:false,riskStatus:"TRADE_BLOCKED",evidence:[],page:0,hasOlder:false,error:null,availability:{status:"ACCOUNT_OFF",message:"Account AI is OFF",deepEnabled:false},history:[{id:ids.review,facts:legacy(facts),operation:{provider:"openai",model:"gpt-5.4-mini",version:"HISTORICAL_VERSION"},created_at:"2026-09-23T12:00:00Z",deadline_at:"2026-09-23T12:10:00Z",result:{status:"FAILED",interpretation:null,error_code:"INVALID_OUTPUT",created_at:"2026-09-23T12:01:00Z"},accounting:disposition===undefined?null:{reservedMicros:59400,usage:disposition===null?null:{disposition,charged_micros:1000}}}]};
}
const panels=[
 {name:"Challenge Bias",render:(d:ReturnType<typeof data>)=>createElement(BiasChallengePanel,{proposalId:ids.plan,requestKey:ids.review,data:d as unknown as ComponentProps<typeof BiasChallengePanel>["data"]}),facts:proposal},
 {name:"Analyze Setup",render:(d:ReturnType<typeof data>)=>createElement(AnalyzeSetupPanel,{proposalId:ids.plan,requestKey:ids.review,data:d as unknown as ComponentProps<typeof AnalyzeSetupPanel>["data"]}),facts:analysis},
 {name:"Weekly Review",render:(d:ReturnType<typeof data>)=>createElement(WeeklyReviewPanel,{requestKey:ids.review,data:d as unknown as ComponentProps<typeof WeeklyReviewPanel>["data"]}),facts:weekly},
 {name:"Recent Trades",render:(d:ReturnType<typeof data>)=>createElement(RecentTradesPanel,{requestKey:ids.review,data:d as unknown as ComponentProps<typeof RecentTradesPanel>["data"]}),facts:recent},
 {name:"Monthly Review",render:(d:ReturnType<typeof data>)=>createElement(MonthlyReviewPanel,{requestKey:ids.review,data:{...d,period:monthly.period} as unknown as ComponentProps<typeof MonthlyReviewPanel>["data"]}),facts:monthly},
 {name:"Trade Review",render:(d:ReturnType<typeof data>)=>createElement(TradeAiReview,{planId:ids.plan,requestKey:ids.review,data:d as unknown as ComponentProps<typeof TradeAiReview>["data"]}),facts:review},
];
for(const panel of panels)describe(panel.name+" failed history accounting presentation",()=>{
 it.each(["SETTLED","UNCERTAIN","CANCELLED",null,undefined,"UNKNOWN"])("renders the actual %s state without altering old history",disposition=>{
  const d=data(panel.facts,disposition),before=structuredClone(d),html=renderToStaticMarkup(panel.render(d));
  expect(html).toContain("FAILED");expect(html).toContain("INVALID_OUTPUT");expect(html).toContain("HISTORICAL_VERSION");expect(d).toEqual(before);
  if(disposition==="UNCERTAIN")expect(html).toContain("Accounting is uncertain; the protected reservation remains held");
  else expect(html).not.toMatch(/Accounting is uncertain|uncertainty retains|Uncertain accounting|uncertainty keeps/);
  if(disposition==="SETTLED"){expect(html).toContain("Usage accounting is settled");expect(html).toContain("unused reservation capacity has been released");}
  if(disposition==="CANCELLED")expect(html).toContain("reservation was released");
  if(disposition===null||disposition==="UNKNOWN")expect(html).toContain("Accounting has not been reconciled");
  if(disposition===undefined)expect(html).toContain("No reservation is recorded");
 });
});

it("monthly comparison notice preserves historical interpretation without claiming completeness proves improvement",()=>{
 const d=data(monthly,"SETTLED");Object.assign(d.history[0].result,{status:"COMPLETED",interpretation:monthlyOutput,error_code:null});const before=structuredClone(d);const panel=panels.find(p=>p.name==="Monthly Review");if(!panel)throw new Error("Missing panel");const html=renderToStaticMarkup(panel.render(d));expect(html).toContain("Change requires comparable earlier and later evidence");expect(html).toContain("Record completeness alone does not establish improvement or degradation");expect(d).toEqual(before);
});
