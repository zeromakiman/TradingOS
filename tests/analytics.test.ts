import { describe,it,expect } from "vitest";
import { metrics,enrichTrades,filterTrades,groups,realizedR,sampleLabel,tradeCsv,validateFilters,type JournalTrade } from "@/domain/analytics";
function trade(r:number,index=0,changes:Partial<JournalTrade>={}):JournalTrade{
 return {id:`10000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,account_id:"20000000-0000-4000-8000-000000000001",locked_at:"2026-09-01T07:00:00Z",strategy_version_id:"30000000-0000-4000-8000-000000000001",risk_plan_version_id:"40000000-0000-4000-8000-000000000001",strategy_version:"ICT V1.0",risk_plan_version:"Risk V1",instrument:"EURUSD",entry_model:index%2?"OTE":"OB_FIRST_TOUCH",direction:"LONG",planned_entry:"1.1",initial_stop:"1.098",planned_quantity:"0.25",initial_risk:"50",risk_percent:"0.5",strategy_offset:-300,status:"CLOSED",execution_id:`50000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,entry_price:"1.1",quantity:"0.25",entered_at:`2026-09-${String(index+1).padStart(2,"0")}T08:00:00Z`,exit_price:"1.102",exited_at:`2026-09-${String(index+1).padStart(2,"0")}T09:00:00Z`,realized_r:String(r),outcome:r>0?"WIN":r<0?"LOSS":"BREAKEVEN",fees:"0",net_pnl:String(r*50),setup_grade:null,liquidity_context:null,mss_timeframe:null,tag_source:null,...changes};
}
const fixture=[2,-1,0,3,-2,-1,1].map((r,i)=>trade(r,i));
describe("deterministic EDGE metrics",()=>{
 it("counts all records but includes only closed trades in performance",()=>{expect(metrics([...fixture,trade(100,9,{status:"TAKEN"})])).toMatchObject({total:8,completed:7,wins:3,losses:3,breakevens:1});});
 it("uses all completed trades in the win rate denominator",()=>{expect(metrics(fixture).winRate).toBeCloseTo(3/7);});
 it("calculates average winner",()=>{expect(metrics(fixture).avgWinner).toBe(2);});
 it("calculates signed average loser",()=>{expect(metrics(fixture).avgLoser).toBeCloseTo(-4/3);});
 it("sums net and average realized R",()=>{expect(metrics(fixture).netR).toBe(2);expect(metrics(fixture).averageR).toBeCloseTo(2/7);});
 it("reconciles weighted expectancy with average R including break-evens",()=>{const m=metrics(fixture);expect(m.expectancy).toBeCloseTo((3/7)*2-(3/7)*(4/3));expect(m.expectancy).toBe(m.averageR);});
 it("calculates gross-R profit factor",()=>{expect(metrics(fixture).profitFactor).toBe(1.5);});
 it("starts equity at zero and orders by exit instant regardless of input order",()=>{expect(metrics([...fixture].reverse()).curve.map(p=>p.cumulativeR)).toEqual([0,2,1,1,4,2,1,2]);});
 it("calculates running peak, current and maximum drawdown",()=>{const m=metrics(fixture);expect(m.curve.map(p=>p.peakR)).toEqual([0,2,2,2,4,4,4,4]);expect(m.maxDrawdown).toBe(3);expect(m.currentDrawdown).toBe(2);});
 it("preserves microsecond ordering across timezone representations",()=>{const ts=[trade(-1,0,{exited_at:"2026-09-01T11:00:00.000002+02:00",entered_at:"2026-09-01T08:00:00.000002Z"}),trade(2,1,{exited_at:"2026-09-01T09:00:00.000001Z",entered_at:"2026-09-01T08:00:00.000001Z"})];expect(metrics(ts).curve.map(p=>p.cumulativeR)).toEqual([0,2,1]);const enriched=enrichTrades(ts);expect(enriched[0].dailySequence).toBe(2);expect(enriched[0].previousOutcome).toBe("WIN");});
 it("measures first loss against starting zero",()=>{expect(metrics([trade(-2)]).maxDrawdown).toBe(2);});
 it("reports best and worst trade",()=>{expect(metrics(fixture)).toMatchObject({best:3,worst:-2});});
 it("tracks streaks and resets at break-even",()=>{expect(metrics([1,1,0,-1,-1,-1,1].map((r,i)=>trade(r,i)))).toMatchObject({maxWins:2,maxLosses:3,currentStreak:1});expect(metrics([trade(1),trade(0,1)]).currentStreak).toBe(0);});
 it("handles empty data without fake rates or Infinity",()=>{const m=metrics([]);expect(m).toMatchObject({completed:0,netR:null,expectancy:null,profitFactor:null,winRate:null,best:null,maxDrawdown:null,sample:"NO DATA"});expect(JSON.stringify(m)).not.toMatch(/NaN|Infinity/);});
 it("handles one winner and all winners",()=>{expect(metrics([trade(3)])).toMatchObject({winRate:1,avgWinner:3,avgLoser:null,expectancy:3,maxDrawdown:0,profitFactor:null,profitFactorState:"NO_LOSSES"});expect(metrics([trade(2),trade(4,1)]).expectancy).toBe(3);});
 it("handles all losers",()=>{expect(metrics([trade(-1),trade(-2,1)])).toMatchObject({profitFactor:0,winRate:0,expectancy:-1.5,avgWinner:null,maxDrawdown:3,currentStreak:-2});});
 it("handles break-even only",()=>{expect(metrics([trade(0)])).toMatchObject({winRate:0,expectancy:0,netR:0,profitFactor:null,profitFactorState:"NO_GAINS_OR_LOSSES",breakevens:1});});
 it("averages locked risk percentages without using the current policy",()=>{expect(metrics([trade(1,0,{risk_percent:"0.25"}),trade(1,1,{risk_percent:"0.75"})]).avgRiskPercent).toBe(0.5);});
 it.each([[0,"NO DATA"],[1,"VERY SMALL SAMPLE"],[9,"VERY SMALL SAMPLE"],[10,"SMALL SAMPLE"],[29,"SMALL SAMPLE"],[30,"DEVELOPING SAMPLE"],[99,"DEVELOPING SAMPLE"],[100,"LARGER SAMPLE"]])("labels N=%s descriptively",(n,label)=>expect(sampleLabel(Number(n))).toBe(label));
});
describe("grouping, sequence and filters",()=>{
 it("compares OB and OTE with known sums and N",()=>{const g=groups(enrichTrades(fixture),t=>t.entry_model);expect(g.find(t=>t.name==="OB_FIRST_TOUCH")).toMatchObject({completed:4,netR:1});expect(g.find(t=>t.name==="OTE")).toMatchObject({completed:3,netR:1});});
 it("groups immutable strategy and risk version IDs",()=>{const ts=enrichTrades([trade(2),trade(-1,1,{strategy_version_id:"new",risk_plan_version_id:"new"})]);expect(groups(ts,t=>t.strategy_version_id).map(x=>x.netR)).toEqual([2,-1]);expect(groups(ts,t=>t.risk_plan_version_id).map(x=>x.netR)).toEqual([2,-1]);});
 it.each([["05:30","ASIAN_RANGE"],["06:30","JUDAS"],["07:00","ACTIVE_KILL_ZONE"],["17:00","DEAD_POOL"],["23:00","ASIAN_RANGE"]])("classifies entry %s UTC with tested strategy clock",(time,session)=>{expect(enrichTrades([trade(1,0,{entered_at:`2026-09-01T${time}:00Z`})])[0].session).toBe(session);});
 it("uses strategy weekday across UTC midnight, including weekends",()=>{expect(enrichTrades([trade(1,0,{entered_at:"2026-09-07T03:00:00Z"})])[0].weekday).toBe("Sunday");});
 it("does not invent unsupported session metadata",()=>{expect(enrichTrades([trade(1,0,{strategy_offset:60})])[0].session).toBe("OTHER");});
 it("applies inclusive exit-date bounds in fixed UTC-5",()=>{const ts=enrichTrades([trade(2,0,{exited_at:"2026-09-02T04:59:00Z"}),trade(-1,1,{exited_at:"2026-09-02T05:00:00Z"})]);expect(filterTrades(ts,{from:"2026-09-01",to:"2026-09-01"}).map(t=>t.realized_r)).toEqual(["2"]);});
 it("validates invalid and reversed dates",()=>{expect(validateFilters({from:"2026-02-30"})).toBeTruthy();expect(validateFilters({from:"2026-09-02",to:"2026-09-01"})).toBeTruthy();});
 it("applies every categorical filter consistently",()=>{const ts=enrichTrades(fixture);const f={instrument:"EURUSD",model:"OTE",strategy:fixture[0].strategy_version_id,risk:fixture[0].risk_plan_version_id,session:"ACTIVE_KILL_ZONE",weekday:"Wednesday",outcome:"LOSS"};expect(filterTrades(ts,f).map(t=>t.id)).toEqual([fixture[1].id]);});
 it("supports this month and latest 30 completed trades",()=>{const ts=enrichTrades(Array.from({length:35},(_,i)=>trade(1,i,{entered_at:new Date(Date.UTC(2026,7,i+1,8)).toISOString(),exited_at:new Date(Date.UTC(2026,7,i+1,9)).toISOString()})));expect(filterTrades(ts,{period:"last30"})).toHaveLength(30);expect(filterTrades(ts,{period:"month"},new Date("2026-09-06T12:00:00Z"))).toHaveLength(4);});
 it("daily sequence counts unclosed recorded entries before filters",()=>{const ts=enrichTrades([trade(0,0,{status:"TAKEN",exited_at:null,realized_r:null}),trade(2,1,{entered_at:"2026-09-01T10:00:00Z"})]);expect(ts[1].dailySequence).toBe(2);expect(filterTrades(ts,{outcome:"WIN"})[0].dailySequence).toBe(2);});
 it("marks equal entry timestamps unknown",()=>{const ts=enrichTrades([trade(1),trade(2,1,{entered_at:fixture[0].entered_at})]);expect(ts.map(t=>t.dailySequence)).toEqual([null,null]);});
 it("uses full chronological predecessor history, including overnight gaps",()=>{const ts=enrichTrades([trade(-1),trade(2,1)]);expect(filterTrades(ts,{outcome:"WIN"})[0].previousOutcome).toBe("LOSS");});
 it("keeps predecessor and daily order account isolated",()=>{const ts=enrichTrades([trade(-1),trade(2,1,{account_id:"other"})]);expect(ts[1].previousOutcome).toBeNull();expect(ts[1].dailySequence).toBe(1);});
 it("does not invent order for simultaneous closes or their successor",()=>{const ts=enrichTrades([trade(1),trade(-1,1,{exited_at:fixture[0].exited_at}),trade(2,2)]);expect(ts.map(t=>t.previousOutcome)).toEqual([null,null,null]);});
 it("preserves missing grades and liquidity as NO DATA",()=>{expect(groups(enrichTrades(fixture),t=>t.setup_grade??"NO DATA")[0].completed).toBe(7);});
 it("exports raw trade fields without authentication identifiers or formula injection",()=>{const csv=tradeCsv(enrichTrades([trade(1,0,{instrument:"=HYPERLINK(\"x\")"})]));expect(csv).toContain("'=");expect(csv).not.toContain("account_id");expect(csv).not.toContain(fixture[0].account_id);});
});
describe("full-close realized R",()=>{
 const input={direction:"LONG" as const,entry:"1.1",exit:"1.104",quantity:"0.25",tickSize:"0.00001",tickValue:"1",initialRisk:"50",fees:"0"};
 it("calculates a long win",()=>expect(realizedR(input)).toEqual({realizedR:"2",outcome:"WIN"}));
 it("calculates a short win",()=>expect(realizedR({...input,direction:"SHORT",exit:"1.096"})).toEqual({realizedR:"2",outcome:"WIN"}));
 it("deducts round-trip fees and uses original locked risk",()=>expect(realizedR({...input,fees:"5"})).toEqual({realizedR:"1.9",outcome:"WIN"}));
 it("derives loss and break-even deterministically",()=>{expect(realizedR({...input,exit:"1.098"}).outcome).toBe("LOSS");expect(realizedR({...input,exit:"1.1"})).toEqual({realizedR:"0",outcome:"BREAKEVEN"});});
 it("rejects zero denominator and negative fees",()=>{expect(()=>realizedR({...input,initialRisk:"0"})).toThrow();expect(()=>realizedR({...input,fees:"-1"})).toThrow();});
});
