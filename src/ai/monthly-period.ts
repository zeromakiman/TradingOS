import {strategyClock} from "@/domain/session";
/** Fixed UTC-5 calendar month, never DST or browser-local time. */
export function monthlyPeriod(month:string){
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new Error("Choose a valid calendar month from 2000-01 through 2099-12.");
 const [year,m]=month.split("-").map(Number),start=Date.UTC(year,m-1,1,5),end=Date.UTC(year,m,1,5);
 return {month,startDate:month+"-01",endDate:new Date(end-86400000).toISOString().slice(0,10),start:new Date(start).toISOString(),endExclusive:new Date(end).toISOString(),timezone:"Fixed UTC−5",policy:"Completed trades by persisted exit time; first day 00:00 inclusive to next month's first day 00:00 exclusive."};
}
export function previousCompletedMonth(now=new Date()){
 const [year,m]=strategyClock(now).day.slice(0,7).split("-").map(Number);
 return monthlyPeriod(new Date(Date.UTC(year,m-2,1)).toISOString().slice(0,7));
}
