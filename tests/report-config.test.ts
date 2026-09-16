import {it,expect,describe} from 'vitest';
import {riskReportSchema,storedRiskSchema,RISK_RULES,isRiskReportCurrent} from '@/domain/risk-report';
import {evaluateRisk} from '@/domain/risk';
import {previewProposal,previewContext} from '@/domain/fixtures';
import {readPublicConfig} from '@/lib/supabase/config';
const legacy=evaluateRisk({...previewProposal,narrative:'Test proposal',contractConfirmed:true},previewContext);
const report={...legacy,reportVersion:'1.1',decision:'APPROVED',requestedRiskPercent:'0.5',targetDistance:'0.006',sessionEligible:true,snapshot:{accountObservationId:crypto.randomUUID(),observationDay:legacy.tradingDay,equity:'10000',currency:'USD',instrumentVersionId:previewContext.instrument.id,slotsUsed:0,executedTrades:null,maximumDailyTrades:2,riskConsumed:'0',grossLoss:null},ruleResults:RISK_RULES.map(rule=>({rule,outcome:'PASS',message:'Check passed'}))};
describe('stored report validation',()=>{
  it('reads historical and new reports',()=>{expect(storedRiskSchema.safeParse(legacy).success).toBe(true);expect(riskReportSchema.safeParse(report).success).toBe(true);});
  it.each([{decision:'BOGUS'},{snapshot:undefined},{status:'TRADE_BLOCKED'},{calculations:null},{session:'DEAD_POOL'},{ruleResults:[]},{issues:[{code:'X',severity:'BLOCK',message:'Blocked'}]}])('rejects malformed modern records without downgrade %o',change=>expect(storedRiskSchema.safeParse({...report,...change}).success).toBe(false));
  it('invalidates a saved approval on time, observation, versions or reservation changes',()=>{
    const parsed=riskReportSchema.parse(report);const observationId=report.snapshot.accountObservationId;
    expect(isRiskReportCurrent(parsed,previewContext,observationId)).toBe(true);
    for(const change of [{now:'2026-09-04T17:00:00Z'},{now:'2026-09-05T14:00:00Z'},{slotsUsed:1},{riskConsumed:'50'},{plan:{...previewContext.plan,id:crypto.randomUUID()}}]) expect(isRiskReportCurrent(parsed,{...previewContext,...change},observationId)).toBe(false);
    expect(isRiskReportCurrent(parsed,previewContext,crypto.randomUUID())).toBe(false);
    expect(isRiskReportCurrent(parsed,{...previewContext,riskConsumed:'0.00000000'},observationId)).toBe(true);
  });
});
describe('public configuration',()=>{
  it('allows absent configuration and a public project key',()=>{expect(readPublicConfig({})).toBeNull();expect(readPublicConfig({url:'https://example.supabase.co',key:'sb_publishable_example'})).toMatchObject({cookiePrefix:'sb-example-auth-token'});});
  it.each([{url:'https://example.supabase.co'},{key:'sb_publishable_example'},{url:'http://remote.example',key:'sb_publishable_example'},{url:'https://example.supabase.co',key:'sb_secret_private'},{url:'https://example.supabase.co/path',key:'sb_publishable_example'}])('rejects unsafe or partial configuration %o',raw=>expect(()=>readPublicConfig(raw)).toThrow());
});
