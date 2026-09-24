import {strategyClock} from "@/domain/session";
const DAY=86400000;
/** Calendar Monday 00:00 through next Monday 00:00, fixed UTC-5 (never DST). */
export function weeklyPeriod(day:string){
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(day)||day<"2000-01-03")throw new Error("Choose a valid date from 2000-01-03 through 2099-12-31.");
 const d=new Date(day+"T00:00:00Z");
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)throw new Error("Choose a valid calendar date.");
 const monday=d.getTime()-((d.getUTCDay()+6)%7)*DAY;
 const startDate=new Date(monday).toISOString().slice(0,10),endDate=new Date(monday+6*DAY).toISOString().slice(0,10);
 return {startDate,endDate,start:new Date(monday+5*3600000).toISOString(),endExclusive:new Date(monday+7*DAY+5*3600000).toISOString(),timezone:"Fixed UTC−5",policy:"Completed trades by persisted exit time; Monday 00:00 inclusive to next Monday 00:00 exclusive."};
}
export function previousCompletedWeek(now=new Date()){
 const current=weeklyPeriod(strategyClock(now).day);
 return weeklyPeriod(strategyClock(new Date(Date.parse(current.start)-DAY)).day);
}
