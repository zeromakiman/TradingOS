/**
 * Fixed copy of the Today screen (docs/V2_ARCHITECTURE.md §14.1, §15). Pure data, safe for server and client components;
 * tests pin the exact strings.
 */

export const TODAY_TITLE = "Today";

export const STATUS_TITLE = "Trading status";
export const LIVE_TITLE = "Live trades";
export const LIVE_DESCRIPTION = "Open positions. Note what you see and decide while it happens.";
export const PLANS_TITLE = "Plans waiting";
export const PLANS_DESCRIPTION = "Locked plans waiting for entry, and drafts with their next step.";
export const PLANS_EMPTY_TITLE = "No plans waiting.";
export const PLANS_EMPTY_DESCRIPTION = "Plan a trade before entry; drafts and locked plans appear here until you take or skip them.";
export const OLDER_DRAFTS_LABEL = "Older drafts";
/** Locked plans of an earlier strategy day (spec §6.2: a plan's slot and risk count on the day it was locked). */
export const EARLIER_LOCKED_LABEL = "Locked on an earlier day";
export const EARLIER_LOCKED_NOTE =
  "Each plan's trade slot and risk were reserved on the day it was locked, not today. Record the entry if you took the trade; otherwise skip it.";
export const SKIP_REASON_REQUIRED = "Add a reason: it stays with the plan.";
export function skipPlanDescription(lockedOn: string): string {
  return `The locked plan stays in your history with your reason. Its trade slot and risk stay counted on ${lockedOn}, the day it was locked.`;
}
/** Lead of a blocking reason found on an earlier strategy day ("When checked on Oct 23: …"). */
export function checkedOnLead(day: string): string {
  return `When checked on ${day}:`;
}
export const CLOSED_TITLE = "Closed today";
export const CLOSED_EMPTY_TITLE = "No trades closed today yet.";
export const CLOSED_EMPTY_DESCRIPTION = "Results appear here, in R and money, after you close a trade.";
export const NO_R_COPY = "Realized R not available: no risk was recorded";

/** Today's plan · notes: the V1 daily context (spec §14.1). */
export const NOTES_TITLE = "Today's plan · notes";
export const NOTES_MAX_LENGTH = 20_000;
export const NOTES_PLACEHOLDER = "Bias and key levels · scenarios and their invalidation · setups you allow today · what to avoid";
export const NOTES_HINT = "Your pre-market plan for this trading account. Each save keeps the earlier version.";
export const NOTES_SAVED_COPY = "Today's plan saved. Earlier versions are kept.";
export const NOTES_ALL_ACCOUNTS_COPY = "Notes are kept per trading account. Choose an account to write today's plan.";
export const NOTES_ARCHIVED_COPY = "This trading account is archived. Restore it in Manage account to write today's plan.";

export const EMPTY_DAY_TITLE = "Nothing planned or traded yet today";
export const EMPTY_DAY_DESCRIPTION = "Start with a plan before entry, or record a position you are already in.";
export const PLAN_TRADE_COPY = "Draft a plan before entry. The free risk check runs when you save it.";
export const LIVE_TRADE_COPY = "Already in a position? Start its live journal now and add details later.";

export const LIVE_EMPTY_JOURNAL = "No journal entries yet. Note what you see while the trade is live.";
export const SCREENSHOT_SAVED_AS = "Saved as While live and labelled Management unless you change the label.";
export const NOT_RECORDED = "Not recorded";
export const RISK_NOT_RECORDED = NOT_RECORDED;
export const RISK_NOT_RECORDED_HINT = "Without a recorded risk, realized R can't be computed.";
/** A closed note or screenshot panel that still holds unsaved work (the work is kept until it is saved or discarded). */
export const UNSAVED_BADGE = "Unsaved";
export const NOTE_KEPT_COPY = "unsaved note kept";
export const SCREENSHOTS_KEPT_COPY = "screenshots not saved yet";

export const ONBOARDING_TITLE = "Create your first trading account";
export const ONBOARDING_DESCRIPTION =
  "A trading account is the broker, prop-firm or demo account you trade on. Trading OS keeps its own risk plan, journal and results for each one.";
export const NO_ACTIVE_TITLE = "All your trading accounts are archived";
export const NO_ACTIVE_DESCRIPTION = "Archived accounts take no new trades; their history stays. Restore one or create a new account to trade today.";
