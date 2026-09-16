import {describe,expect,it} from "vitest";
import {statusTier} from "@/components/status-banner";
import {sessionSegments} from "@/components/session-ribbon";
import {strategyClock} from "@/domain/session";

describe("trading permission is presented by tier, never re-decided",()=>{
 it("treats any reason from the risk context as a restriction",()=>expect(statusTier("READY",["The daily risk cap has been reached."])).toBe("restricted"));
 it("keeps an unrestricted active plan visually distinct from an idle ready state",()=>{
  expect(statusTier("PLAN ACTIVE",[])).toBe("working");
  expect(statusTier("TRADE ACTIVE",[])).toBe("working");
  expect(statusTier("READY",[])).toBe("clear");
 });
 it("shows a restricted active trade as restricted, not as permitted work",()=>expect(statusTier("TRADE ACTIVE",["Dead Pool is active."])).toBe("restricted"));
 it.each(["DEAD POOL","DAILY LIMIT REACHED","ACTION REQUIRED"])("marks %s as restricted",label=>expect(statusTier(label,["reason"])).toBe("restricted"));
});

describe("session ribbon mirrors the strategy clock",()=>{
 const day="2026-09-07",segments=sessionSegments(day);
 it("covers the whole strategy day exactly once",()=>expect(segments.reduce((total,s)=>total+s.span,0)).toBe(96));
 it("never invents a session the clock does not report",()=>{
  for(const segment of segments){
   const at=new Date(Date.parse(`${day}T05:00:00Z`)+segment.from*900_000).toISOString();
   expect(strategyClock(at).session).toBe(segment.session);
  }
 });
 it("orders the day as the clock defines it",()=>expect(segments.map(s=>s.session)).toEqual(["ASIA","JUDAS","ACTIVE_KILL_ZONE","DEAD_POOL","ASIA"]));
});
