import Decimal from "decimal.js";
import { strategyClock } from "./session";
import { decimalString, type Proposal, type RiskContext } from "./risk";

export function formatR(value: string | number | null) {
  if (value === null) return "—";
  const n = new Decimal(value);
  return `${n.gt(0) ? "+" : ""}${n.toFixed(2)}R`;
}
export function utcTime(value: string) {
  return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
export function dailyStatus(c: RiskContext, active: "LOCKED" | "TAKEN" | null) {
  const clock = strategyClock(c.now);
  const reasons: string[] = [];
  if (clock.session === "DEAD_POOL") reasons.push("Dead Pool is active. New locks resume at 18:00 UTC−5.");
  if (c.observationDay !== clock.day) reasons.push("Update today’s account values in Settings before locking a plan.");
  if (c.slotsUsed >= c.plan.maxDailyTrades) reasons.push(`${c.slotsUsed} / ${c.plan.maxDailyTrades} daily slots are reserved. Closed and skipped plans do not release a slot.`);
  if (c.plan.dailyRiskCap !== null && new Decimal(c.riskConsumed).gte(c.plan.dailyRiskCap)) reasons.push("The daily risk cap has been reached.");
  if (c.plan.dailyLossCap !== null) {
    if (c.grossLoss === null) reasons.push("Record today’s gross losses in Settings to check the daily loss cap.");
    else if (new Decimal(c.grossLoss).plus(c.riskConsumed).gte(c.plan.dailyLossCap)) reasons.push("The daily loss and reserved-risk limit has been reached.");
  }
  return { label: active === "TAKEN" ? "TRADE ACTIVE" : active === "LOCKED" ? "PLAN ACTIVE" : reasons.length ? clock.session === "DEAD_POOL" ? "DEAD POOL" : c.slotsUsed >= c.plan.maxDailyTrades ? "DAILY LIMIT REACHED" : "ACTION REQUIRED" : "READY", reasons, slots: Math.max(0, c.plan.maxDailyTrades - c.slotsUsed) };
}

export type JournalFilters = ReturnType<typeof journalFilters>;
export function journalFilters(raw: Record<string, string | undefined>) {
  const pick = (key: string, values: readonly string[]) => values.includes(raw[key] ?? "") ? raw[key] : undefined;
  const date = (v?: string) => v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v ? v : undefined;
  return { status: pick("status", ["LOCKED", "TAKEN", "CLOSED", "SKIPPED", "CANCELLED"]), outcome: pick("outcome", ["WIN", "LOSS", "BREAKEVEN"]), model: pick("model", ["OB_FIRST_TOUCH", "OTE"]), from: date(raw.from), to: date(raw.to), q: (raw.q ?? "").trim().slice(0, 80).replace(/[^a-zA-Z0-9 ._-]/g, ""), strategy: (raw.strategy ?? "").trim().slice(0,80), page: /^\d{1,5}$/.test(raw.page ?? "") ? Number(raw.page) : 0 };
}
export function journalQuery(account: string, f: JournalFilters, page = f.page) {
  return new URLSearchParams(Object.entries({ account, ...f, page: String(page) }).filter((e): e is [string,string] => typeof e[1] === "string" && Boolean(e[1]))).toString();
}
export function journalReturnPath(value?: string) {
  return value?.startsWith("/journal?") && !/[\\\r\n]/.test(value) ? value : "/journal";
}
export function setupRiskFeedback(value: unknown, lock: boolean) {
  const v = value as { planId?: string; result?: {status?:string; issues?: {message:string;severity?:string}[]} } | null;
  if (v?.planId) return "Plan locked. Open the trade record to record an actual entry.";
  if (v?.result?.status === "TRADE_BLOCKED") return `Trade blocked. ${v.result.issues?.filter(i=>i.severity!=="WARN").map(i=>i.message).join(" ") || "Review the risk conditions below."}`;
  return lock ? "No plan was locked. Review the latest risk decision before continuing." : "Risk check saved. Review the decision below.";
}
export function eventSummary(type:string,p:Record<string,unknown>){
 if(typeof p.note==="string")return p.note;
 if(type==="PLAN_LOCKED")return "Original plan and risk reservation preserved.";
 if(type==="TRADE_OPENED")return `Actual entry ${p.entry_price??"—"} · quantity ${typeof p.quantity==="string"?new Decimal(p.quantity).toFixed():"—"}.`;
 if(type==="TRADE_CLOSED")return `Exit ${p.exit_price??"—"} · ${p.outcome??"Closed"} · ${typeof p.realized_r==="string"?formatR(p.realized_r):"—"}.`;
 if(typeof p.reason==="string")return p.reason;
 return "Recorded in the permanent history. Expand to inspect the original details.";
}
export function proposalFeedback(p:Proposal){
 const errors:Partial<Record<keyof Proposal,string>>={};
 for(const [key,label] of [["entry","Entry price"],["target","Target price"],["riskPercent","Risk"]] as const){if(!decimalString.safeParse(p[key]).success)errors[key]=`${label} must be greater than 0, with up to 8 decimal places.`;}
 if(p.stop===null)errors.stop="A stop loss is required before locking.";
 else if(!decimalString.safeParse(p.stop).success)errors.stop="Stop loss must be a positive price with up to 8 decimal places.";
 if(!errors.entry&&!errors.stop&&p.stop!==null){if(p.direction==="LONG"?new Decimal(p.stop).gte(p.entry):new Decimal(p.stop).lte(p.entry))errors.stop=`For a ${p.direction} trade, stop loss must be ${p.direction==="LONG"?"below":"above"} entry.`;}
 if(!errors.entry&&!errors.target){if(p.direction==="LONG"?new Decimal(p.target).lte(p.entry):new Decimal(p.target).gte(p.entry))errors.target=`For a ${p.direction} trade, target must be ${p.direction==="LONG"?"above":"below"} entry.`;}
 if(!p.narrative.trim())errors.narrative="Add your pre-trade reasoning.";
 return errors;
}
