import {describe,expect,it} from "vitest";
import {statusTier} from "@/components/status-banner";
import {nextTransition,sessionSegments} from "@/components/session-ribbon";
import {rTone} from "@/components/numeric";
import {lowSample} from "@/components/edge-dashboard";
import {sampleLabel} from "@/domain/analytics";
import {strategyClock} from "@/domain/session";
import {dailyStatus,formatR} from "@/domain/ux";
import {evaluateRisk} from "@/domain/risk";
import {previewContext,previewProposal} from "@/domain/fixtures";

const DAY="2026-09-07",NEXT_DAY="2026-09-08",MIDNIGHT=Date.parse(`${DAY}T05:00:00Z`);
const at=(hhmm:string)=>{const [h,m]=hhmm.split(":").map(Number);return new Date(MIDNIGHT+(h*60+m)*60_000).toISOString();};

describe("session ribbon never contradicts the strategy clock",()=>{
 it("covers every minute of the strategy day exactly once",()=>expect(sessionSegments(DAY).reduce((total,s)=>total+s.span,0)).toBe(1440));
 it("reports only sessions the clock reports at that minute",()=>{
  for(const segment of sessionSegments(DAY)){
   for(const offset of [0,segment.span-1]) expect(strategyClock(new Date(MIDNIGHT+(segment.from+offset)*60_000)).session).toBe(segment.session);
  }
 });
 it("orders the day as the clock defines it",()=>expect(sessionSegments(DAY).map(s=>s.session)).toEqual(["ASIA","JUDAS","ACTIVE_KILL_ZONE","DEAD_POOL","ASIA"]));

 it.each([
  ["00:30","JUDAS","01:00",DAY],
  ["01:30","ACTIVE_KILL_ZONE","02:00",DAY],
  ["06:00","DEAD_POOL","12:00",DAY],
  ["13:00","ASIA","18:00",DAY],
  ["18:00","JUDAS","01:00",NEXT_DAY],
  ["18:30","JUDAS","01:00",NEXT_DAY],
  ["19:00","JUDAS","01:00",NEXT_DAY],
  ["23:30","JUDAS","01:00",NEXT_DAY],
  ["23:59","JUDAS","01:00",NEXT_DAY]
 ])("at %s the next transition is %s at %s on %s",(now,session,time,day)=>{
  expect(nextTransition(at(now))).toMatchObject({session,time,day});
 });

 it("never announces the session that is already running",()=>{
  for(let minute=0;minute<1440;minute++){
   const instant=new Date(MIDNIGHT+minute*60_000),current=strategyClock(instant),next=nextTransition(instant);
   expect(next).not.toBeNull();
   expect(next?.session).not.toBe(current.session);
  }
 });

 it("announces the first transition, not a later one",()=>{
  for(let minute=0;minute<1440;minute++){
   const instant=new Date(MIDNIGHT+minute*60_000),current=strategyClock(instant),next=nextTransition(instant);
   if(!next)throw new Error("missing transition");
   const [h,m]=next.time.split(":").map(Number);
   const boundary=Date.parse(`${next.day}T05:00:00Z`)+(h*60+m)*60_000;
   expect(strategyClock(new Date(boundary)).session).toBe(next.session);
   expect(strategyClock(new Date(boundary-60_000)).session).toBe(current.session);
  }
 });
});

describe("permission tier interprets the authoritative status, never replaces it",()=>{
 const lockable={...previewProposal,narrative:"Presentation contract test.",contractConfirmed:true};
 const clear={...previewContext,now:"2026-09-07T14:00:00Z",observationDay:DAY};
 const restricted={
  "Dead Pool":{...clear,now:"2026-09-07T18:00:00Z"},
  "stale observation":{...clear,observationDay:"2026-09-06"},
  "reserved slots":{...clear,slotsUsed:2},
  "daily risk cap":{...clear,riskConsumed:"100",plan:{...clear.plan,dailyRiskCap:"100"}},
  "unreported gross loss":{...clear,plan:{...clear.plan,dailyLossCap:"100"}},
  "daily loss cap":{...clear,riskConsumed:"1",grossLoss:"99",plan:{...clear.plan,dailyLossCap:"100"}}
 };

 it("keeps an unrestricted day clear in both the engine and the banner",()=>{
  expect(dailyStatus(clear,null).reasons).toEqual([]);
  expect(evaluateRisk(lockable,clear).status).toBe("RISK_APPROVED");
  expect(statusTier("READY",[])).toBe("clear");
 });

 // The banner treats any reason as a restriction. That is only honest if every
 // reason dailyStatus can produce also blocks the Risk Engine, so assert it.
 it.each(Object.entries(restricted))("%s blocks the engine, so the banner may show it as restricted",(_name,context)=>{
  const reasons=dailyStatus(context,null).reasons;
  expect(reasons.length).toBeGreaterThan(0);
  expect(evaluateRisk(lockable,context).status).toBe("TRADE_BLOCKED");
  expect(statusTier("READY",reasons)).toBe("restricted");
 });

 it("preserves every authoritative label",()=>{
  expect(dailyStatus(clear,null).label).toBe("READY");
  expect(dailyStatus(clear,"LOCKED").label).toBe("PLAN ACTIVE");
  expect(dailyStatus(clear,"TAKEN").label).toBe("TRADE ACTIVE");
  expect(dailyStatus(restricted["Dead Pool"],null).label).toBe("DEAD POOL");
  expect(dailyStatus(restricted["reserved slots"],null).label).toBe("DAILY LIMIT REACHED");
  expect(dailyStatus(restricted["stale observation"],null).label).toBe("ACTION REQUIRED");
 });

 it("separates active work from an idle ready day without hiding a restriction",()=>{
  expect(statusTier("PLAN ACTIVE",[])).toBe("working");
  expect(statusTier("TRADE ACTIVE",[])).toBe("working");
  expect(statusTier("TRADE ACTIVE",["Dead Pool is active."])).toBe("restricted");
 });
});

describe("numeric presentation follows the authoritative output",()=>{
 it.each([["2.71","success"],["-1","red"],["0","muted"],[null,"muted"]] as const)("tones %s from its formatted sign",(value,expected)=>expect(rTone(formatR(value))).toBe(expected));

 it("de-emphasises only the existing sample bands, adding no threshold",()=>{
  const bands=[...new Set([0,1,9,10,29,30,99,100,500].map(sampleLabel))];
  expect(bands).toEqual(["NO DATA","VERY SMALL SAMPLE","SMALL SAMPLE","DEVELOPING SAMPLE","LARGER SAMPLE"]);
  expect(bands.filter(lowSample)).toEqual(["NO DATA","VERY SMALL SAMPLE","SMALL SAMPLE"]);
 });

 it("leaves an unrecognised band at full emphasis rather than guessing",()=>expect(lowSample("SOMETHING NEW")).toBe(false));
});
