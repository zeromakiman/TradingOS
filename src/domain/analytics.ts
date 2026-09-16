import Decimal from "decimal.js";
import { z } from "zod";
import { strategyClock } from "./session";

const D = Decimal.clone({ precision: 40 });
export const grades = ["A+", "A", "B", "C", "INVALID"] as const;
export const liquidityTypes = ["ARL_HIGH", "ARL_LOW", "PDH", "PDL", "PWH", "PWL", "KZ_HIGH", "KZ_LOW", "EQUAL_HIGHS", "EQUAL_LOWS", "OTHER"] as const;
export const sessions = ["JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL", "ASIAN_RANGE", "OTHER"] as const;
export const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const numeric = z.string().refine(v => /^-?\d+(\.\d+)?$/.test(v) && new D(v).isFinite(), "Invalid stored decimal");
export const journalRow = z.object({
 id:z.uuid(),account_id:z.uuid(),locked_at:z.string(),strategy_version_id:z.uuid(),risk_plan_version_id:z.uuid(),
 strategy_version:z.string(),risk_plan_version:z.string(),instrument:z.string(),entry_model:z.string(),direction:z.enum(["LONG","SHORT"]),
 planned_entry:numeric,initial_stop:numeric,planned_quantity:numeric,initial_risk:numeric,risk_percent:numeric,strategy_offset:z.number().nullable(),
 status:z.enum(["LOCKED","TAKEN","CLOSED","SKIPPED","CANCELLED"]),execution_id:z.uuid().nullable(),
 entry_price:numeric.nullable(),quantity:numeric.nullable(),entered_at:z.string().nullable(),
 exit_price:numeric.nullable(),exited_at:z.string().nullable(),realized_r:numeric.nullable(),outcome:z.enum(["WIN","LOSS","BREAKEVEN"]).nullable(),
 fees:numeric.nullable(),net_pnl:numeric.nullable(),setup_grade:z.enum(grades).nullable(),liquidity_context:z.enum(liquidityTypes).nullable(),mss_timeframe:z.string().nullable(),tag_source:z.string().nullable()
});
export type JournalTrade = z.infer<typeof journalRow>;
export type EnrichedTrade = JournalTrade & { session:string;weekday:string;entryDay:string|null;closeDay:string|null;dailySequence:number|null;previousOutcome:string|null };
export type Filters = { from?:string;to?:string;instrument?:string;model?:string;strategy?:string;risk?:string;session?:string;weekday?:string;outcome?:string;period?:string };
// PostgreSQL timestamps retain microseconds; Date.parse alone loses their order.
function instantKey(value:string){const fraction=/\.(\d+)/.exec(value)?.[1]??"";return BigInt(Math.floor(Date.parse(value)/1000))*1_000_000n+BigInt(fraction.padEnd(6,"0").slice(0,6));}
function compareInstant(a:string,b:string){const x=instantKey(a),y=instantKey(b);return x<y?-1:x>y?1:0;}
const byClose = (a:JournalTrade,b:JournalTrade) => compareInstant(a.exited_at ?? a.locked_at,b.exited_at ?? b.locked_at)||a.id.localeCompare(b.id);
export function enrichTrades(rows:JournalTrade[]):EnrichedTrade[] {
 const enriched:EnrichedTrade[]=rows.map(t=>{
  const clock=t.entered_at&&t.strategy_offset===-300?strategyClock(t.entered_at):null;
  const close=t.exited_at?strategyClock(t.exited_at):null;
  return {...t,session:clock?(clock.session==="ASIA"?"ASIAN_RANGE":clock.session):"OTHER",weekday:clock?weekdays[(new Date(`${clock.day}T00:00:00Z`).getUTCDay()+6)%7]:"NO DATA",entryDay:clock?.day??null,closeDay:close?.day??null,dailySequence:null,previousOutcome:null};
 });
 const days=new Map<string,EnrichedTrade[]>();
 for(const t of enriched)if(t.execution_id&&t.entryDay){const key=`${t.account_id}/${t.entryDay}`,day=days.get(key)??[];day.push(t);days.set(key,day);}
 for(const day of days.values()){
  day.sort((a,b)=>compareInstant(a.entered_at??"",b.entered_at??"")||a.id.localeCompare(b.id));
  // Simultaneous recorded fills have no authoritative ordering: mark the whole day unknown.
  if(new Set(day.map(t=>instantKey(t.entered_at??""))).size===day.length)day.forEach((t,i)=>{t.dailySequence=i+1;});
 }
 const previous=new Map<string,string>();
 const complete=enriched.filter(t=>t.status==="CLOSED").sort(byClose);
 const closeCounts=new Map<string,number>();
 for(const t of complete){const key=`${t.account_id}/${instantKey(t.exited_at??"")}`;closeCounts.set(key,(closeCounts.get(key)??0)+1);}
 for(let n=0;n<complete.length;n++){
  const t=complete[n];
  const tied=(closeCounts.get(`${t.account_id}/${instantKey(t.exited_at??"")}`)??0)>1;
  t.previousOutcome=tied?null:previous.get(t.account_id)??null;
  if(tied)previous.delete(t.account_id);else if(t.outcome)previous.set(t.account_id,t.outcome);
 }
 return enriched;
}
export function validateFilters(f:Filters):string|null {
 for(const value of [f.from,f.to])if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value))return "Use valid calendar dates.";
 if(f.from&&f.to&&f.from>f.to)return "Start date must be on or before end date.";
 return null;
}
export function filterTrades(rows:EnrichedTrade[],f:Filters,now=new Date()):EnrichedTrade[] {
 if(validateFilters(f))return [];
 const month=strategyClock(now).day.slice(0,7);
 const result=rows.filter(t=>{
  const day=t.closeDay??strategyClock(t.locked_at).day;
  return (!f.from||day>=f.from)&&(!f.to||day<=f.to)&&(!f.instrument||t.instrument===f.instrument)&&(!f.model||t.entry_model===f.model)&&(!f.strategy||t.strategy_version_id===f.strategy)&&(!f.risk||t.risk_plan_version_id===f.risk)&&(!f.session||t.session===f.session)&&(!f.weekday||t.weekday===f.weekday)&&(!f.outcome||t.outcome===f.outcome)&&(f.period!=="month"||day.startsWith(month));
 }).sort(byClose);
 return f.period==="last30"?result.filter(t=>t.status==="CLOSED").slice(-30):result;
}
export function sampleLabel(n:number){return n===0?"NO DATA":n<10?"VERY SMALL SAMPLE":n<30?"SMALL SAMPLE":n<100?"DEVELOPING SAMPLE":"LARGER SAMPLE";}
export function metrics(rows:JournalTrade[]) {
 const trades=rows.filter(t=>t.status==="CLOSED"&&t.realized_r!==null&&t.exited_at!==null).sort(byClose);
 const values=trades.map(t=>new D(t.realized_r as string));
 const positives=values.filter(v=>v.gt(0)),negatives=values.filter(v=>v.lt(0));
 const sum=(xs:Decimal[])=>xs.reduce((s,x)=>s.plus(x),new D(0));
 const n=values.length,wins=positives.length,losses=negatives.length,breakevens=n-wins-losses;
 const positive=sum(positives),negative=sum(negatives),net=positive.plus(negative);
 const avgWin=wins?positive.div(wins):null,avgLoss=losses?negative.div(losses):null;
 const expectancy=n?positive.div(n).plus(negative.div(n)):null;
 let equity=new D(0),peak=new D(0),maxDD=new D(0),currentStreak=0,maxWins=0,maxLosses=0;
 const curve=[{sequence:0,date:null as string|null,cumulativeR:0,peakR:0,drawdownR:0}];
 values.forEach((v,i)=>{
  equity=equity.plus(v);peak=D.max(peak,equity);const dd=peak.minus(equity);maxDD=D.max(maxDD,dd);
  currentStreak=v.gt(0)?Math.max(0,currentStreak)+1:v.lt(0)?Math.min(0,currentStreak)-1:0;
  maxWins=Math.max(maxWins,currentStreak);maxLosses=Math.max(maxLosses,-currentStreak);
  curve.push({sequence:i+1,date:trades[i].exited_at,cumulativeR:equity.toNumber(),peakR:peak.toNumber(),drawdownR:dd.toNumber()});
 });
 return {total:rows.length,completed:n,wins,losses,breakevens,winRate:n?wins/n:null,lossRate:n?losses/n:null,
  avgWinner:avgWin?.toNumber()??null,avgLoser:avgLoss?.toNumber()??null,averageR:n?net.div(n).toNumber():null,netR:n?net.toNumber():null,expectancy:expectancy?.toNumber()??null,
  profitFactor:losses?positive.div(negative.abs()).toNumber():null,profitFactorState:n===0?"NO_DATA":losses===0?(wins?"NO_LOSSES":"NO_GAINS_OR_LOSSES"):"DEFINED",
  maxDrawdown:n?maxDD.toNumber():null,currentDrawdown:n?peak.minus(equity).toNumber():null,
  best:n?D.max(...values).toNumber():null,worst:n?D.min(...values).toNumber():null,currentStreak,maxWins,maxLosses,curve,
  avgRiskPercent:n?sum(trades.map(t=>new D(t.risk_percent))).div(n).toNumber():null,sample:sampleLabel(n)};
}
export type Metrics=ReturnType<typeof metrics>;
export function groups(rows:EnrichedTrade[],key:(t:EnrichedTrade)=>string,expected:string[]=[]){
 const grouped=new Map<string,EnrichedTrade[]>(expected.map(k=>[k,[]]));
 for(const t of rows.filter(x=>x.status==="CLOSED")){const k=key(t),group=grouped.get(k)??[];group.push(t);grouped.set(k,group);}
 return [...grouped].map(([name,trades])=>({name,...metrics(trades)}));
}
export function realizedR(input:{direction:"LONG"|"SHORT";entry:string;exit:string;quantity:string;tickSize:string;tickValue:string;initialRisk:string;fees:string}){
 for(const k of ["entry","exit","quantity","tickSize","tickValue","initialRisk"] as const)if(!new D(input[k]).isFinite()||new D(input[k]).lte(0))throw new Error("Positive finite values required");
 if(!new D(input.fees).isFinite()||new D(input.fees).lt(0))throw new Error("Nonnegative finite fees required");
 const pnl=new D(input.exit).minus(input.entry).mul(input.direction==="LONG"?1:-1).div(input.tickSize).mul(input.tickValue).mul(input.quantity).minus(input.fees);
 return {realizedR:pnl.div(input.initialRisk).toFixed(),outcome:pnl.gt(0)?"WIN":pnl.lt(0)?"LOSS":"BREAKEVEN"};
}
export function tradeCsv(rows:EnrichedTrade[]){
 const fields=["instrument","entry_model","direction","status","strategy_version","risk_plan_version","planned_entry","initial_stop","entry_price","quantity","entered_at","exit_price","exited_at","fees","initial_risk","risk_percent","net_pnl","realized_r","outcome","session","weekday","dailySequence","setup_grade","liquidity_context","mss_timeframe","tag_source"] as const;
 const cell=(value:unknown)=>{let s=String(value??"");if(/^[=+@\t\r]/.test(s)||(/^-/.test(s)&&!/^-[\d.]+$/.test(s)))s=`'${s}`;return `"${s.replaceAll('"','""')}"`;};
 return [fields.join(","),...rows.map(t=>fields.map(f=>cell(t[f])).join(","))].join("\r\n");
}
