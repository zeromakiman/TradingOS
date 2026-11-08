import type { DuplicateCandidate, Instrument, RiskContext } from "@/domain/risk";

/**
 * Serializable view data of the trade forms (docs/V2_ARCHITECTURE.md §9.2, §14.2, §14.3): Plan Trade, Edit Draft and
 * Record Live Trade. The server loaders (`form-data.ts`) build it from the account workspaces with the user's session;
 * the client forms read it and never fetch. Pure types: safe in server and client components.
 */

export type Direction = "LONG" | "SHORT";
export type PlanModel = "OB_FIRST_TOUCH" | "OTE";
export type LiveModel = PlanModel | "OTHER";
export type NewsStatus = "UNKNOWN" | "CLEAR" | "RESTRICTED";

/** What an account still needs before a plan can be checked; `UNAVAILABLE` when its data could not be read. */
export type FormGap = "ACCOUNT_VALUES" | "RISK_PLAN" | "STRATEGY" | "INSTRUMENTS" | "UNAVAILABLE";

/** Risk-plan values the form shows (presets, policies) without the engine context. */
export interface FormRiskPlan {
  version: string;
  maxRiskPercent: string;
  /** Null on legacy versions: the default then equals the maximum. */
  defaultRiskPercent: string | null;
  minRR: string;
  rrPolicy: "BLOCK" | "WARN";
  newsPolicy: "BLOCK" | "WARN";
  maxDailyTrades: number;
  dailyRiskCap: string | null;
  dailyLossCap: string | null;
}

/** The engine context of an account without the per-proposal parts the client adds (instrument, duplicate). */
export type AccountRiskBase = Omit<RiskContext, "instrument" | "duplicate">;

/** Today's slot usage of an account, for the forms' one-line context. */
export interface FormUsage {
  /** Strategy day the usage was computed for (`get_daily_risk_usage`). */
  day: string;
  used: number;
  planned: number;
  unplanned: number;
  max: number;
}

/** A trading account as both forms see it: name, currency, contracts and, for planning, the risk context. */
export interface FormAccount {
  /** Handle for the action fields; never printed. */
  id: string;
  name: string;
  currency: string;
  /** `Evaluation · FTMO`. */
  description: string;
  /** Latest version of each symbol, ordered by symbol. */
  instruments: Instrument[];
  riskPlan: FormRiskPlan | null;
  /** Engine context of the preview; null while the account lacks account values, a risk plan or the strategy. */
  risk: AccountRiskBase | null;
  /**
   * The account's plans of the usage day, projected to the fields the DUPLICATE rule compares (instrument version,
   * direction, model, entry, stop, target), so locked theses never reach the browser.
   */
  todaysPlans: DuplicateCandidate[];
  /** Expected versions the save action sends (`p_expected_risk_id`, `p_expected_observation_id`). */
  riskPlanId: string | null;
  observationId: string | null;
  /** Latest recorded account values and their strategy day (the "Confirm unchanged" quick fix shows them). */
  balance: string | null;
  equity: string | null;
  observationDay: string | null;
  strategyVersion: string | null;
  usage: FormUsage | null;
  gaps: FormGap[];
}

/** Plan Trade (`/trades/new`) and Record Live Trade (`/trades/live/new`). */
export interface TradeFormData {
  /** Server time of this request (ISO 8601 UTC); the preview clock ticks from it, never from the browser clock. */
  now: string;
  /** Active accounts, oldest first (archived accounts take no new trades). */
  accounts: FormAccount[];
  /** Preselected account (§9.2): the selected context, else the most recently used active account, else the only one. */
  defaultAccountId: string | null;
  /** The user has archived accounts only (or none at all): the forms show how to create or restore one. */
  hasArchived: boolean;
  /** Per-user part of the keys under which the form keeps unsaved entries in the tab (a hash, never the user id). */
  autosaveScope: string;
}

/** Proposal values of a draft revision; null where the stored revision lacks a value. */
export interface DraftPrefill {
  instrumentId: string | null;
  direction: Direction | null;
  model: PlanModel | null;
  entry: string | null;
  stop: string | null;
  target: string | null;
  riskPercent: string | null;
  narrative: string | null;
  contractConfirmed: boolean | null;
  news: NewsStatus | null;
  contradiction: boolean | null;
}

/** A saved screenshot of the draft, shown read-only on Edit Draft. */
export interface ExistingEvidence {
  /** Handle for the gallery link; never printed. */
  id: string;
  /** `M5 chart`, `Entry screenshot`. */
  name: string;
  /** `Pre-entry · M5`. */
  tag: string;
  thumbSrc: string;
  recordedAt: string;
}

/** Edit Draft (`/trades/[id]/edit`): the latest revision of a draft and what saving a new one affects. */
export interface EditDraftData {
  now: string;
  tradeId: string;
  /** `EURUSD · Long`. */
  title: string;
  /** Latest revision n; saving creates n + 1. */
  revision: number;
  /** `expectedRevision` of revise_trade_draft (DRAFT_CHANGED when another revision was saved meanwhile). */
  expectedRevision: number;
  /** State of the draft in words (`Blocked`, `Ready to lock`, …) and its tone. */
  stateLabel: string;
  stateTone: "neutral" | "danger" | "positive" | "warning" | "info" | "live" | "positive-muted" | "muted";
  /** The trade's account: a revision keeps the trade's account. */
  account: FormAccount;
  archived: boolean;
  prefill: DraftPrefill;
  /** The revision's contract was superseded by a newer version of the same symbol (the form preselects the newer one). */
  contractUpdated: { symbol: string } | null;
  evidence: ExistingEvidence[];
  /** Screenshots the trade can still take (24 minus its active screenshots). */
  evidenceCapacity: number;
  /** Completed or running AI analyses of revision n (Analyze Setup, Challenge My Bias). */
  aiAnalysesOfRevision: number;
  /** Per-user part of the key under which the form keeps unsaved entries in the tab (a hash, never the user id). */
  autosaveScope: string;
}

/** Why `/trades/[id]/edit` can't edit a trade, with the words the page shows. */
export interface NotEditable {
  tradeId: string;
  title: string;
  stateLabel: string;
  stateTone: EditDraftData["stateTone"];
  reason: string;
}
