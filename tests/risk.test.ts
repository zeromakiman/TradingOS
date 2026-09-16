import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { evaluateRisk, moneyString, type Proposal, type RiskContext } from "@/domain/risk";
import { previewContext, previewProposal } from "@/domain/fixtures";
import { strategyClock } from "@/domain/session";
const proposal = { ...previewProposal, narrative:"Liquidity sweep then meaningful M5 displacement; user-reported.", contractConfirmed:true };
const run = (p: Partial<Proposal> = {}, c: Partial<RiskContext> = {}) => evaluateRisk({...proposal,...p},{...previewContext,...c});
const has = (code:string,p:Partial<Proposal>={},c:Partial<RiskContext>={}) => expect(run(p,c).issues.map(i=>i.code)).toContain(code);

describe("exact monetary risk and sizing",()=>{
  it("calculates 0.5% risk, 20 pip stop, 0.25 lots and 3R",()=>{
    const r=run(); expect(r.status).toBe("RISK_APPROVED");
    expect(r.calculations).toMatchObject({budget:"50.00",permittedRisk:"50.00",quantity:"0.25",nominalRisk:"50",plannedRR:"3.00000000",stopPips:"20.0000",plannedReward:"150"});
  });
  it("supports mirrored shorts and OTE without extra OB requirements",()=>{
    const r=run({direction:"SHORT",model:"OTE",stop:"1.102",target:"1.094"});
    expect(r.status).toBe("RISK_APPROVED");expect(r.calculations?.quantity).toBe("0.25");
  });
  it("floors quantities without exceeding budget",()=>{
    const r=run({stop:"1.097",target:"1.109"});
    expect(r.calculations?.quantity).toBe("0.16");expect(r.calculations?.nominalRisk).toBe("48");
  });
  it("handles the extreme rounding regression conservatively",()=>{
    const r=run({entry:"2",stop:"1",target:"5"},{equity:"999999999998",instrument:{...previewContext.instrument,tickSize:"1",pipSize:null,tickValue:"0.33333333",quantityStep:"0.00000001",minimumQuantity:"0.00000001"}});
    expect(r.calculations?.quantity).toBe("15000000149.97000149");
    if(!r.calculations) throw new Error("Sizing calculation is required");
    expect(new Decimal(r.calculations.nominalRisk).lte(r.calculations.budget)).toBe(true);
  });
  it("does not compare display-rounded RR",()=>{has("MIN_RR",{target:"1.10599"});});
  it("blocks an undersized futures-like quantity instead of rounding upward",()=>{has("MINIMUM_QUANTITY",{entry:"100",stop:"98",target:"106"},{instrument:{...previewContext.instrument,tickSize:"0.25",tickValue:"12.5",pipSize:null,quantityStep:"1",minimumQuantity:"1"}});});
  it.each(["50.005","10000.99999","NaN","-1","1e5"])("rejects invalid monetary input %s",v=>{expect(moneyString.safeParse(v).success).toBe(false);});
  it("retains exact version links",()=>{const r=run();expect(r.strategyVersionId).toBe(previewContext.strategyVersionId);expect(r.riskPlanVersionId).toBe(previewContext.plan.id);});
});
describe("hard rules and missing data",()=>{
  it("blocks excessive requested risk",()=>has("RISK_LIMIT",{riskPercent:"0.51"}));
  it("blocks max daily slots",()=>has("MAX_TRADES",{},{slotsUsed:2}));
  it("blocks missing stop",()=>has("MISSING_STOP",{stop:null}));
  it.each([{stop:"1.1"},{stop:"1.11"},{target:"1.09"}])("blocks incorrect geometry %o",p=>has("PRICE_GEOMETRY",p));
  it("blocks off-tick prices",()=>has("OFF_TICK",{entry:"1.100001"}));
  it("requires contract confirmation",()=>has("CONTRACT_UNCONFIRMED",{contractConfirmed:false}));
  it("blocks unsupported account currency",()=>has("INSTRUMENT_MISMATCH",{},{currency:"EUR"}));
  it("blocks explicit strategy contradiction",()=>has("STRATEGY_CONTRADICTION",{contradiction:true}));
  it("blocks duplicates",()=>has("DUPLICATE",{},{duplicate:true}));
  it("blocks stale equity",()=>has("STALE_EQUITY",{},{observationDay:"2026-09-03"}));
  it("enforces configured daily risk cap",()=>has("DAILY_RISK_LIMIT",{},{riskConsumed:"50",plan:{...previewContext.plan,dailyRiskCap:"99.99"}}));
  it("permits exact cap boundary",()=>expect(run({},{riskConsumed:"50",plan:{...previewContext.plan,dailyRiskCap:"100"}}).status).toBe("RISK_APPROVED"));
  it("does not invent losses for a configured cap",()=>has("DAILY_LOSS_UNKNOWN",{},{plan:{...previewContext.plan,dailyLossCap:"100"}}));
  it("checks gross losses plus reserved risk",()=>has("DAILY_LOSS_LIMIT",{},{grossLoss:"51",plan:{...previewContext.plan,dailyLossCap:"100"}}));
  it("keeps unknown news as warning",()=>has("NEWS_UNKNOWN"));
  it("applies versioned news and RR policies",()=>{
    expect(run({news:"RESTRICTED"},{plan:{...previewContext.plan,newsPolicy:"BLOCK"}}).status).toBe("TRADE_BLOCKED");
    expect(run({target:"1.104"},{plan:{...previewContext.plan,rrPolicy:"WARN"}}).status).toBe("RISK_APPROVED");
  });
  it.each([null,"SCALP",123])("rejects unrecognized model %s",model=>expect(evaluateRisk({...proposal,model},previewContext).status).toBe("TRADE_BLOCKED"));
  it.each(["NaN","Infinity","-1","0","1e2",""])("rejects invalid price %s",entry=>has("INVALID_INPUT",{entry}));
  it("blocks malformed optional context without throwing",()=>{
    has("INVALID_CONTEXT",{},{plan:{...previewContext.plan,dailyRiskCap:"oops"}});
    has("INVALID_CONTEXT",{},{grossLoss:"-5"});
    has("INVALID_CONTEXT",{},{instrument:{...previewContext.instrument,pipSize:"0"}});
  });
});
describe("fixed UTC−5, independent of browser and DST",()=>{
  it.each([
    ["2026-09-04T05:59:59.999Z","ASIA"],["2026-09-04T06:00:00Z","JUDAS"],
    ["2026-09-04T07:00:00Z","ACTIVE_KILL_ZONE"],["2026-09-04T16:59:59.999Z","ACTIVE_KILL_ZONE"],
    ["2026-09-04T17:00:00Z","DEAD_POOL"],["2026-09-04T22:59:59.999Z","DEAD_POOL"],["2026-09-04T23:00:00Z","ASIA"]
  ])("%s is %s",(time,session)=>expect(strategyClock(time).session).toBe(session));
  it("resets the day at 05:00 UTC",()=>{
    expect(strategyClock("2026-09-04T04:59:59.999Z").day).toBe("2026-09-03");
    expect(strategyClock("2026-09-04T05:00:00Z").day).toBe("2026-09-04");
  });
  it.each(["2026-03-08T17:00:00Z","2026-11-01T17:00:00Z"])("keeps Dead Pool at 17:00 UTC on DST date %s",time=>expect(strategyClock(time).session).toBe("DEAD_POOL"));
  it("interprets an explicit alternate offset as the same instant",()=>expect(strategyClock("2026-09-04T19:00:00+02:00")).toEqual(strategyClock("2026-09-04T17:00:00Z")));
  it("rejects offset-free timestamps",()=>expect(()=>strategyClock("2026-09-04T12:00:00")).toThrow());
  it("blocks Dead Pool and warns for Asia",()=>{has("DEAD_POOL",{},{now:"2026-09-04T17:00:00Z"});has("OUTSIDE_ACTIVE",{},{now:"2026-09-04T23:00:00Z"});});
});
