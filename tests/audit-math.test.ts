import { describe,it,expect } from "vitest";
import { metrics,enrichTrades,realizedR,type JournalTrade } from "@/domain/analytics";
function trade(r:number,index=0,changes:Partial<JournalTrade>={}):JournalTrade{
 return {id:`10000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,account_id:"20000000-0000-4000-8000-000000000001",locked_at:"2026-09-01T07:00:00Z",strategy_version_id:"30000000-0000-4000-8000-000000000001",risk_plan_version_id:"40000000-0000-4000-8000-000000000001",strategy_version:"ICT V1.0",risk_plan_version:"Risk V1",instrument:"EURUSD",entry_model:index%2?"OTE":"OB_FIRST_TOUCH",direction:"LONG",planned_entry:"1.1",initial_stop:"1.098",planned_quantity:"0.25",initial_risk:"50",risk_percent:"0.5",strategy_offset:-300,status:"CLOSED",execution_id:`50000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,entry_price:"1.1",quantity:"0.25",entered_at:`2026-09-${String(index+1).padStart(2,"0")}T08:00:00Z`,exit_price:"1.102",exited_at:`2026-09-${String(index+1).padStart(2,"0")}T09:00:00Z`,realized_r:String(r),outcome:r>0?"WIN":r<0?"LOSS":"BREAKEVEN",fees:"0",net_pnl:String(r*50),setup_grade:null,liquidity_context:null,mss_timeframe:null,tag_source:null,...changes};
}
import {evaluateRisk} from '@/domain/risk';
import {previewContext,previewProposal} from '@/domain/fixtures';
import {strategyClock} from '@/domain/session';
describe('independent audit fixtures',()=>{
 it('matches integer arithmetic for 400 long/short size and RR boundaries',()=>{
  for(let distance=1;distance<=200;distance++)for(const direction of ['LONG','SHORT'] as const){
   const sign=direction==='LONG'?1:-1,entryTicks=110000;
   const price=(ticks:number)=>(ticks/100000).toFixed(5);
   const r=evaluateRisk({...previewProposal,direction,entry:price(entryTicks),stop:price(entryTicks-sign*distance),target:price(entryTicks+sign*3*distance),narrative:'Independent integer fixture',contractConfirmed:true,news:'CLEAR'},previewContext);
   expect(r.status).toBe('RISK_APPROVED');const c=r.calculations;if(!c)throw Error('Missing calculation');
   const hundredths=5000n/BigInt(distance);expect(Number(c.quantity)).toBe(Number(hundredths)/100);expect(Number(c.nominalRisk)).toBe(Number(hundredths*BigInt(distance))/100);expect(Number(c.plannedRR)).toBe(3);expect(Number(c.nominalRisk)).toBeLessThanOrEqual(50);
  }
 });
 it('agrees with an independently summed fee-adjusted full-close ledger',()=>{
  const trades=[['LONG','1.104','5',1.9],['SHORT','1.098','2',0.96],['LONG','1.098','1',-1.02],['SHORT','1.1','0',0]] as const;
  const values=trades.map(([direction,exit,fees,expected],i)=>{const r=realizedR({direction,entry:'1.1',exit,fees,quantity:'0.25',tickSize:'0.00001',tickValue:'1',initialRisk:'50'});expect(Number(r.realizedR)).toBe(expected);return trade(Number(r.realizedR),i);});
  expect(metrics(values)).toMatchObject({completed:4,wins:2,losses:1,breakevens:1,netR:1.84,averageR:0.46,expectancy:0.46,avgWinner:1.43,avgLoser:-1.02,maxDrawdown:1.02,winRate:0.5});expect(metrics(values).profitFactor).toBeCloseTo(2.86/1.02);
 });
 it.each([[1e60,1e60],[-1e60,-1e60]])('keeps huge supported %s R outcomes finite',a=>{const m=metrics([trade(a)]);function check(value:unknown){if(typeof value==='number')expect(Number.isFinite(value)).toBe(true);else if(value&&typeof value==='object')Object.values(value).forEach(check);}check(m);expect(m.netR).toBe(a);});
 it('orders exact timestamp ties deterministically and marks economic sequence unknown',()=>{const a=trade(2),b=trade(-1,1,{entered_at:a.entered_at,exited_at:a.exited_at});expect(metrics([b,a]).curve.map(x=>x.cumulativeR)).toEqual([0,2,1]);expect(enrichTrades([b,a]).map(x=>x.dailySequence)).toEqual([null,null]);});
 it.each(['2026-03-29','2026-10-25'])('ignores Madrid DST transition on %s',day=>{const instant=day+'T17:00:00Z';const local=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(new Date(instant));expect(local).toBe(day.includes('03-29')?'19:00':'18:00');expect(strategyClock(instant)).toMatchObject({day,time:'12:00',session:'DEAD_POOL'});});
});
