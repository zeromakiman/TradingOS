import { INVALID_INPUT_FIELD_COPY } from "@/domain/risk-explain";
import { STRATEGY_ZONE_LABEL } from "@/domain/time-display";
import type { EntryTiming } from "./live-model";
import type { FormGap, LiveModel, NewsStatus, PlanModel } from "./types";

/**
 * Copy of the trade forms (docs/V2_ARCHITECTURE.md §14.2, §14.3, §15). Field messages repeat the server actions'
 * sentences (src/app/actions/trades.ts, src/domain/risk-explain.ts) so a value refused here and one refused by the
 * server read the same. Pure data: safe in server and client components; tests pin the exact strings.
 */

export const PLAN_TITLE = "Plan Trade";
export const PLAN_DESCRIPTION = "Draft the setup and see the free risk check before you enter. Nothing is reserved until you lock the plan.";
export const EDIT_TITLE = "Edit draft";
export const LIVE_TITLE = "Record Live Trade";
export const LIVE_DESCRIPTION = "Already in a position? Record it now and keep the journal while it runs.";
export const LIVE_NO_PLAN_NOTE = "Live-first trades have no pre-trade plan. Use Plan Trade before entry when you can.";

export const THESIS_LABEL = "Thesis";
export const THESIS_PLACEHOLDER = "Why this trade? What would invalidate it?";
export const THESIS_HINT = "Recorded before entry. It stays with the plan when you lock it.";
export const CONTRACT_LABEL = "Contract values match my broker";
export const CONTRADICTION_LABEL = "My setup contradicts a strategy rule";
export const ADD_INSTRUMENT = "Add instrument";
export const SAVE_DRAFT = "Save draft";
export const START_LIVE_JOURNAL = "Start live journal";
export const PRICE_LATER = "Already open — add price later";
export const OTHER_SYMBOL_LABEL = "Other symbol";
export const PREVIEW_TITLE = "Risk check preview";
export const PREVIEW_FOOTNOTE = "Same rules and today's usage as the server check. Saving runs that check for free; nothing is reserved until you lock the plan.";
export const LEAVE_TITLE = "Discard your unsaved changes?";
export const LEAVE_DESCRIPTION = "Leaving this page discards what you entered and any screenshots you added here.";
export const RESTORED_TITLE = "Restored your unsaved entries";
export const RESTORED_PLAN_BODY = "You left this page before saving. Screenshots aren't kept, so add them again before you save.";
export const RESTORED_LIVE_BODY = "You left this page before recording the position. Check the entry time: Now records the moment you save.";
export const DISCARD_RESTORED = "Discard entries";

/** Entry time of Record Live Trade (spec §14.3: Now by default; Earlier in strategy time; unknown is allowed, §5.3). */
export const TIMING_LABELS: Readonly<Record<EntryTiming, string>> = Object.freeze({ now: "Now", earlier: "Earlier", unknown: "Not sure" });
export const TIMING_NOW_HINT = "Recorded as the moment you save.";
export const TIMING_UNKNOWN_HINT = "No entry time is recorded. Add it later on the trade page with Add entry details.";

/** `Strategy time (UTC−5), now 08:56.`: the zone of the Earlier field, with the current strategy time beside it. */
export function strategyTimeHint(nowTime: string): string {
  return `Strategy time (${STRATEGY_ZONE_LABEL}), now ${nowTime}.`;
}
export const DRAFT_CHANGED_TITLE = "This draft has a newer revision";
export const DRAFT_CHANGED_BODY = "Reloading replaces the values on this page with the latest revision; screenshots you added here stay.";
export const CONTEXT_CHANGED_TITLE = "Account values or risk plan changed";
export const NEW_DAY_TITLE = "A new trading day started";
export const NEW_DAY_BODY = "Today's usage on this page belongs to the previous day. Reload to check against today's trades, risk and losses.";
export const UNREACHABLE_COPY = "Trading OS couldn't be reached. Check your connection and try again: the same submission is never saved twice.";

/** `/analyze/[id]` for a V1 setup that doesn't exist or belongs to someone else (spec §1.2): never says which. */
export const LEGACY_LINK_TITLE = "This plan link isn't available";
export const LEGACY_LINK_DESCRIPTION = "This link is from an earlier version of Trading OS. The plan may not exist, or it belongs to someone else. Nothing was changed.";

/** `Saving creates revision n+1; existing AI analysis will be marked as belonging to revision n` (spec §14.2). */
export function aiRevisionWarning(revision: number): string {
  return `Saving creates revision ${revision + 1}; existing AI analysis will be marked as belonging to revision ${revision}`;
}

/** `Revision 2 → 3`. */
export function revisionStep(revision: number): string {
  return `Revision ${revision} → ${revision + 1}`;
}

export const DIRECTION_OPTIONS = [
  { value: "LONG", label: "Long" },
  { value: "SHORT", label: "Short" },
] as const;

export const MODEL_LABELS: Readonly<Record<LiveModel, string>> = Object.freeze({ OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other" });
export const PLAN_MODELS: readonly PlanModel[] = Object.freeze(["OB_FIRST_TOUCH", "OTE"]);

/** Record Live Trade's Model field (0020): the Risk Engine's models, Other, the account's custom models. */
export const MODEL_GROUP_VALIDATED = "Risk Engine-validated";
export const MODEL_GROUP_CUSTOM = "Custom · not validated by the Risk Engine";
export const ADD_MODEL = "Add model";
export const MANAGE_MODELS = "Manage models…";

export const NEWS_LABELS: Readonly<Record<NewsStatus, string>> = Object.freeze({ UNKNOWN: "Not checked", CLEAR: "Checked · clear", RESTRICTED: "Restricted window" });
export const NEWS_ORDER: readonly NewsStatus[] = Object.freeze(["UNKNOWN", "CLEAR", "RESTRICTED"]);

/** What the chosen news status means for the plan, in the risk plan's own terms. */
export function newsConsequence(news: NewsStatus, policy: "BLOCK" | "WARN" | null): string {
  if (news === "CLEAR") return "No high-impact release falls in your trading window.";
  if (news === "UNKNOWN") return "The plan carries a warning until you check the economic calendar.";
  if (policy === null) return "Your risk plan decides whether a restricted window blocks or warns.";
  return policy === "BLOCK" ? "Your risk plan blocks trading in a restricted news window." : "Your risk plan warns about trading in a restricted news window.";
}

export function contradictionDescription(strategy: string | null): string {
  return `Leave this unticked unless the setup breaks one of your ${strategy ?? "strategy"} rules. Ticking it blocks the plan from being locked.`;
}

/** Field messages of the plan form: the proposal fields use the engine's INVALID_INPUT sentences. */
export const PLAN_FIELD_COPY = Object.freeze({
  accountId: "Choose a trading account.",
  instrumentId: INVALID_INPUT_FIELD_COPY.instrumentId,
  direction: INVALID_INPUT_FIELD_COPY.direction,
  model: INVALID_INPUT_FIELD_COPY.model,
  entry: INVALID_INPUT_FIELD_COPY.entry,
  stop: INVALID_INPUT_FIELD_COPY.stop,
  target: INVALID_INPUT_FIELD_COPY.target,
  riskPercent: INVALID_INPUT_FIELD_COPY.riskPercent,
  narrative: INVALID_INPUT_FIELD_COPY.narrative,
  news: INVALID_INPUT_FIELD_COPY.news,
  contractConfirmed: INVALID_INPUT_FIELD_COPY.contractConfirmed,
  contradiction: INVALID_INPUT_FIELD_COPY.contradiction,
});

/** Field messages of the live form (same sentences as recordLiveTrade). */
export const LIVE_FIELD_COPY = Object.freeze({
  accountId: "Choose a trading account.",
  instrumentId: "Choose an instrument or enter the symbol.",
  symbol: "Use 1 to 20 capital letters, digits or . _ / - for the symbol.",
  direction: "Choose a direction: long or short.",
  entryModel: "Choose an entry model.",
  customModel: "Choose a model of this trading account.",
  entryPrice: "Entry price must be a positive number with up to 8 decimals.",
  enteredAt: "Enter the entry date and time.",
  enteredAtFuture: "The entry time can't be in the future.",
  quantity: "Size must be a positive number with up to 8 decimals.",
  initialStop: "Stop must be a positive number with up to 8 decimals.",
  riskAmount: "Risk must be a positive amount with up to 2 decimals.",
});

/** What each account gap means and where it is fixed (Manage tabs of src/components/accounts/copy.ts). */
export const GAP_COPY: Readonly<Record<FormGap, { text: string; action: string | null; tab: "account-values" | "risk-policy" | "instruments" | null }>> = Object.freeze({
  ACCOUNT_VALUES: { text: "Record this account's balance and equity before planning a trade.", action: "Update account values", tab: "account-values" },
  RISK_PLAN: { text: "This account has no risk plan in effect today.", action: "Set up the risk plan", tab: "risk-policy" },
  STRATEGY: { text: "This account has no strategy version, so plans can't be checked.", action: null, tab: null },
  INSTRUMENTS: { text: "This account has no instruments yet. Add the contract you trade with its tick size and tick value.", action: ADD_INSTRUMENT, tab: "instruments" },
  UNAVAILABLE: { text: "This account's risk data couldn't be loaded. Reload the page to try again.", action: null, tab: null },
});
