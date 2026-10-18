import {describe,it,expect} from "vitest";
import {dailyStatus,formatR,journalFilters,journalQuery,journalReturnPath,setupRiskFeedback,utcTime} from "@/domain/ux";
import {shouldGuardLink} from "@/components/unsaved-changes";
import {previewContext,usageFixture} from "@/domain/fixtures";
const c={...previewContext,now:"2026-09-07T14:00:00Z",observationDay:"2026-09-07",usage:usageFixture({day:"2026-09-07"})};
const usage=(changes:Parameters<typeof usageFixture>[0])=>usageFixture(changes,c.usage);
describe("daily operational status",()=>{
 it("ready means slots remain, not approval for an individual plan",()=>expect(dailyStatus(c,null)).toEqual({label:"READY",reasons:[],slots:2}));
 it("keeps active-trade continuation while new locks are blocked",()=>{const s=dailyStatus({...c,now:"2026-09-07T18:00:00Z",usage:usage({plannedSlots:2})},"TAKEN");expect(s.label).toBe("TRADE ACTIVE");expect(s.reasons).toHaveLength(2);expect(s.slots).toBe(0);});
 it("counts live-first trades toward the daily slots",()=>{const s=dailyStatus({...c,usage:usage({plannedSlots:1,unplannedTrades:1})},null);expect(s.label).toBe("DAILY LIMIT REACHED");expect(s.slots).toBe(0);});
 it("identifies a plan awaiting execution",()=>expect(dailyStatus(c,"LOCKED").label).toBe("PLAN ACTIVE"));
 it("flags stale observations at the strategy-day boundary",()=>expect(dailyStatus({...c,now:"2026-09-08T05:00:00Z"},null).reasons.join()).toContain("account values"));
 it("recognizes monetary caps using exact decimal arithmetic",()=>{
  expect(dailyStatus({...c,usage:usage({openExposure:"99.99",realizedLoss:"0.01"}),plan:{...c.plan,dailyLossCap:"100"}},null).reasons.join()).toContain("limit");
  expect(dailyStatus({...c,usage:usage({openExposure:"99.98",realizedLoss:"0.01"}),plan:{...c.plan,dailyLossCap:"100"}},null).reasons).toEqual([]);
  expect(dailyStatus({...c,usage:usage({plannedRisk:"99.99",unplannedRisk:"0.01"}),plan:{...c.plan,dailyRiskCap:"100"}},null).reasons.join()).toContain("risk cap");
 });
 it("needs no manually reported loss for a configured cap: today's losses are computed (engine 1.2)",()=>{
  expect(dailyStatus({...c,plan:{...c.plan,dailyLossCap:"100"}},null).reasons).toEqual([]);
  expect(dailyStatus({...c,usage:usage({legacyReportedLoss:"100"}),plan:{...c.plan,dailyLossCap:"100"}},null).reasons.join()).toContain("limit");
 });
 it("never displays negative slots",()=>expect(dailyStatus({...c,usage:usage({plannedSlots:5})},null).slots).toBe(0));
});
describe("Journal filters and safe navigation",()=>{
 it("rejects unsupported filters and invalid dates",()=>expect(journalFilters({status:"DELETED",outcome:"profit",page:"-1",from:"2026-02-30"})).toMatchObject({status:undefined,outcome:undefined,from:undefined,page:0}));
 it("retains valid dates and searchable instruments",()=>expect(journalFilters({q:" EURUSD ",from:"2026-09-07",status:"TAKEN",page:"2"})).toMatchObject({q:"EURUSD",from:"2026-09-07",status:"TAKEN",page:2}));
 it("removes filter syntax from search",()=>expect(journalFilters({q:"EURUSD),id.eq.*"}).q).toBe("EURUSDid.eq."));
 it("preserves active filters across pagination",()=>{const q=new URLSearchParams(journalQuery("a",journalFilters({q:"GBPUSD",status:"CLOSED",outcome:"WIN"}),3));expect(q.get("page")).toBe("3");expect(q.get("status")).toBe("CLOSED");expect(q.get("q")).toBe("GBPUSD");});
 it.each(["https://example.com","//example.com","/journal/../settings","/journal?x=\nfoo"])("rejects unsafe return destination %s",value=>expect(journalReturnPath(value)).toBe("/journal"));
 it("retains a local filtered Journal return link",()=>expect(journalReturnPath("/journal?status=CLOSED")).toBe("/journal?status=CLOSED"));
 it("allows same-page anchors without a discard warning",()=>expect(shouldGuardLink("#main-content","http://localhost/journal?a=1")).toBe(false));
 it.each(["/today","/journal?a=2","https://example.com"])("warns on a meaningful navigation to %s",href=>expect(shouldGuardLink(href,"http://localhost/journal?a=1")).toBe(true));
});
describe("clear preserved-risk feedback and number formatting",()=>{
 it("does not report a blocked lock as saved successfully",()=>expect(setupRiskFeedback({result:{status:"TRADE_BLOCKED",issues:[{message:"Maximum daily trades reached."}]}},true)).toBe("Trade blocked. Maximum daily trades reached."));
 it("does not invent a lock on an unexpected reply",()=>expect(setupRiskFeedback({},true)).toContain("No plan was locked"));
 it("acknowledges a real persisted lock",()=>expect(setupRiskFeedback({planId:"saved"},true)).toContain("Plan locked"));
 it.each([["2.71","+2.71R"],["-1","-1.00R"],["0","0.00R"],[null,"—"]])("formats %s consistently",(value,expected)=>expect(formatR(value)).toBe(expected));
 it("labels timestamps and converts explicit offsets",()=>expect(utcTime("2026-09-07T10:30:00-05:00")).toBe("2026-09-07 15:30 UTC"));
});
import {proposalFeedback,eventSummary} from "@/domain/ux";
import {previewProposal} from "@/domain/fixtures";
describe("helpful form and event presentation",()=>{
 it("identifies the missing stop without preventing saving a proposal",()=>expect(proposalFeedback({...previewProposal,stop:null}).stop).toContain("before locking"));
 it("explains long and short price geometry",()=>{expect(proposalFeedback({...previewProposal,target:"1.0"}).target).toContain("above entry");expect(proposalFeedback({...previewProposal,direction:"SHORT",stop:"1.0"}).stop).toContain("above entry");});
 it("names invalid numeric fields",()=>expect(proposalFeedback({...previewProposal,riskPercent:"0"}).riskPercent).toContain("Risk must be greater"));
 it("requires reasoning",()=>expect(proposalFeedback({...previewProposal,narrative:" "}).narrative).toContain("reasoning"));
 it("summarizes outcomes without exposing IDs in the main event text",()=>expect(eventSummary("TRADE_CLOSED",{exit_price:"1.104",realized_r:"2.00000",outcome:"WIN",outcome_id:"secret-id"})).toBe("Exit 1.104 · WIN · +2.00R."));
});
