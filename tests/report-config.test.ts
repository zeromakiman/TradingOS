import {it,expect,describe} from 'vitest';
import {riskReportSchema,riskReportSchemaV12,storedRiskSchema,RISK_RULES,isRiskReportCurrent} from '@/domain/risk-report';
import {evaluateRisk} from '@/domain/risk';
import {previewProposal,previewContext,usageFixture} from '@/domain/fixtures';
import {readPublicConfig} from '@/lib/supabase/config';
const current=evaluateRisk({...previewProposal,narrative:'Test proposal',contractConfirmed:true},previewContext);
// A stored V1 (engine 1.0) report and a stored 1.1 report, exactly as the V1 engines wrote them.
const legacy={engineVersion:'1.0',evaluatedAt:'2026-09-04T14:00:00Z',tradingDay:'2026-09-04',session:'ACTIVE_KILL_ZONE',strategyVersionId:previewContext.strategyVersionId,riskPlanVersionId:previewContext.plan.id,status:'RISK_APPROVED',issues:[{code:'COSTS_UNKNOWN',severity:'WARN',message:'Sizing reflects nominal stop risk; fees, gaps and slippage are not included.'}],calculations:{budget:'50.00',permittedRisk:'50.00',stopDistance:'0.002',stopTicks:'200',stopPips:'20.0000',plannedRR:'3.00000000',quantity:'0.25',nominalRisk:'50',plannedReward:'150'}};
const report={...legacy,reportVersion:'1.1',decision:'APPROVED',requestedRiskPercent:'0.5',targetDistance:'0.006',sessionEligible:true,snapshot:{accountObservationId:crypto.randomUUID(),observationDay:legacy.tradingDay,equity:'10000',currency:'USD',instrumentVersionId:previewContext.instrument.id,slotsUsed:0,executedTrades:null,maximumDailyTrades:2,riskConsumed:'0',grossLoss:null},ruleResults:RISK_RULES.map(rule=>({rule,outcome:'PASS',message:'Check passed'}))};
const NOW=previewContext.now;
describe('stored report validation',()=>{
  it('reads historical and new reports',()=>{expect(storedRiskSchema.safeParse(legacy).success).toBe(true);expect(riskReportSchema.safeParse(report).success).toBe(true);expect(riskReportSchemaV12.safeParse(current).success).toBe(true);expect(storedRiskSchema.safeParse(current).success).toBe(true);});
  it.each([{decision:'BOGUS'},{snapshot:undefined},{status:'TRADE_BLOCKED'},{calculations:null},{session:'DEAD_POOL'},{ruleResults:[]},{issues:[{code:'X',severity:'BLOCK',message:'Blocked'}]}])('rejects malformed modern records without downgrade %o',change=>{
    expect(storedRiskSchema.safeParse({...report,...change}).success).toBe(false);
    expect(storedRiskSchema.safeParse({...current,...change}).success).toBe(false);
  });
  it('never treats a saved 1.1 approval as current, whatever changed: engine 1.2 must recheck it',()=>{
    const parsed=riskReportSchema.parse(report);const observationId=report.snapshot.accountObservationId;
    expect(isRiskReportCurrent(parsed,previewContext,observationId,NOW)).toBe(false);
    for(const now of ['2026-09-04T17:00:00Z','2026-09-05T14:00:00Z']) expect(isRiskReportCurrent(parsed,previewContext,observationId,now)).toBe(false);
    for(const change of [{usage:usageFixture({plannedSlots:1})},{usage:usageFixture({unplannedTrades:1})},{usage:usageFixture({plannedRisk:'50'})},{plan:{...previewContext.plan,id:crypto.randomUUID()}}]) expect(isRiskReportCurrent(parsed,{...previewContext,...change},observationId,NOW)).toBe(false);
    expect(isRiskReportCurrent(parsed,previewContext,crypto.randomUUID(),NOW)).toBe(false);
    expect(isRiskReportCurrent(parsed,previewContext,undefined,NOW)).toBe(false);
    expect(isRiskReportCurrent(parsed,{...previewContext,usage:usageFixture({plannedRisk:'0.00000000'})},observationId,NOW)).toBe(false);
    // The 1.2 approval of the same proposal in the same context is current.
    expect(isRiskReportCurrent(riskReportSchemaV12.parse(current),{...previewContext,usage:usageFixture({plannedRisk:'0.00000000'})},previewContext.observationId,NOW)).toBe(true);
  });
  it('invalidates a saved 1.2 approval when any part of the daily usage changes, using the server time passed in',()=>{
    const parsed=riskReportSchemaV12.parse(current);const observationId=previewContext.observationId;
    expect(isRiskReportCurrent(parsed,previewContext,observationId,NOW)).toBe(true);
    expect(isRiskReportCurrent(parsed,previewContext,observationId.toUpperCase(),NOW)).toBe(true);
    expect(isRiskReportCurrent(parsed,previewContext,observationId,'2026-09-04T17:00:00Z')).toBe(false);
    expect(isRiskReportCurrent(parsed,previewContext,observationId,'2026-09-05T14:00:00Z')).toBe(false);
    for(const usage of [{plannedSlots:1},{plannedRisk:'50'},{unplannedTrades:1},{unplannedRisk:'0.01'},{unplannedRiskUnknown:1},{realizedLoss:'0.01'},{externalLoss:'5'},{legacyReportedLoss:'0'},{openExposure:'50'},{openRiskUnknown:1}]) {
      expect(isRiskReportCurrent(parsed,{...previewContext,usage:usageFixture(usage)},observationId,NOW)).toBe(false);
    }
    expect(isRiskReportCurrent(parsed,{...previewContext,usage:usageFixture({plannedRisk:'0.000',realizedLoss:'0.00'})},observationId,NOW)).toBe(true);
    expect(isRiskReportCurrent(parsed,{...previewContext,instrument:{...previewContext.instrument,id:crypto.randomUUID()}},observationId,NOW)).toBe(false);
    expect(isRiskReportCurrent(parsed,{...previewContext,strategyVersionId:crypto.randomUUID()},observationId,NOW)).toBe(false);
    expect(isRiskReportCurrent(storedRiskSchema.parse(legacy),previewContext,observationId,NOW)).toBe(false);
  });
});
describe('public configuration',()=>{
  it('allows absent configuration and a public project key',()=>{expect(readPublicConfig({})).toBeNull();expect(readPublicConfig({url:'https://example.supabase.co',key:'sb_publishable_example'})).toMatchObject({cookiePrefix:'sb-example-auth-token'});});
  it.each([{url:'https://example.supabase.co'},{key:'sb_publishable_example'},{url:'http://remote.example',key:'sb_publishable_example'},{url:'https://example.supabase.co',key:'sb_secret_private'},{url:'https://example.supabase.co/path',key:'sb_publishable_example'}])('rejects unsafe or partial configuration %o',raw=>expect(()=>readPublicConfig(raw)).toThrow());
});
