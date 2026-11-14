import type { OverviewFigures, OverviewRange } from "@/domain/all-accounts-overview";
import type { TimeDisplay } from "@/domain/time-display";

/**
 * View model of the Today screen (docs/V2_ARCHITECTURE.md §14.1). Every value arrives formatted (exact decimals through
 * src/domain/format, times through the person's time display), so the components only lay out words. Ids appear only
 * as `id`/`accountId` handles for links and forms; the default UI never prints them.
 */

/** Semantic tone of a value or a state; colour always comes with words or a sign. */
export type ValueTone = "pos" | "neg" | "neutral" | "muted";
export type HeadlineTone = "positive" | "warning" | "negative";
export type PillTone = "neutral" | "positive" | "positive-muted" | "negative" | "warning" | "info" | "live" | "muted";

export interface ValueText {
  text: string;
  tone: ValueTone;
}

/** A link the screen renders; `prefetch: false` for links that switch the account context. */
export interface LinkAction {
  label: string;
  href: string;
  prefetch?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Trading status (§14.1, §6.2, §8.4, §9.3).
// ---------------------------------------------------------------------------------------------------------------------
export type ReasonAction =
  /** One click records the values shown as today's ("Confirm unchanged"), or opens the form to enter new ones. */
  | { kind: "confirm-values" }
  /** No values were ever recorded: the form asks for them. */
  | { kind: "record-values" }
  /** Usage of another strategy day: compute Today again on the server. */
  | { kind: "refresh"; label: string }
  | ({ kind: "link" } & LinkAction);

export interface ReasonView {
  severity: "BLOCK" | "WARN";
  message: string;
  action: ReasonAction | null;
}

export interface StatView {
  label: string;
  /** Main value lines (R first, then money per currency). */
  values: ValueText[];
  hint: string | null;
}

export interface LossesView {
  /** Realized losses of trades closed today in this account's currency. */
  realized: string;
  /** Realized plus external losses ("$75.50"). */
  combined: string;
  /** "+ $25.00 external" or null. */
  external: string | null;
  /** Today's external losses as an exact decimal: a change means an entry was recorded. */
  externalAmount: string;
  /** "1 losing trade" / "No losing trades closed". */
  detail: string;
  /** "Counted toward the limit: $80.00, from an earlier manual entry." when the V1 total is larger, else null. */
  counted: string | null;
  /** "Daily loss limit $2,000.00" / "No daily loss limit". */
  limit: string;
  /** "External realized losses today: $25.00" (dialog summary). */
  externalSummary: string;
}

export interface AccountValuesView {
  confirmedToday: boolean;
  /** "Balance confirmed today" / "Confirm today's balance" / "No account values yet". */
  label: string;
  /** "Balance $111,132.01 · Equity $111,132.01" or null. */
  values: string | null;
  /** The same as separate lines: ["Balance $111,132.01", "Equity $111,132.01"] (empty without values). */
  lines: string[];
  /** "Recorded Oct 21" when not today, else null. */
  recorded: string | null;
  /** The values shown, so "Confirm unchanged" is refused when newer ones exist. */
  observationId: string | null;
  balance: string | null;
  equity: string | null;
}

export interface AccountStatusView {
  /** Handle for forms and links; never printed. */
  accountId: string;
  name: string;
  /** "Evaluation · FTMO · USD". */
  meta: string;
  currency: string;
  /** `/today?account=<id>` (switches the context; not prefetched). */
  focusHref: string;
  manageHref: string;
  headline: string;
  tone: HeadlineTone;
  allowed: boolean;
  /** Usage of another strategy day: nothing is judged, only a refresh is offered. */
  stale: boolean;
  reasons: ReasonView[];
  /** Null while the account has no risk plan or the usage is stale. */
  stats: {
    trades: StatView & { exhausted: boolean };
    risk: StatView;
    result: StatView;
    losses: LossesView;
    values: AccountValuesView;
  } | null;
  /** The latest account values, for the dialogs (also when `stats` is null). */
  values: AccountValuesView;
  /** External losses can be recorded (active accounts only). */
  canAddExternalLoss: boolean;
  /** Today's external losses (exact decimal), the dialogs' change signal. */
  externalAmount: string;
  externalSummary: string;
}

/**
 * All Accounts: today's result over every trade closed today in the context, archived accounts' included (R across
 * accounts, money per currency), and the realized losses of the same accounts.
 */
export interface DaySummaryView {
  /** "+3.06R" or null without R trades. */
  r: ValueText | null;
  money: ValueText[];
  /** "2 trades closed today · 1 without R", with "· 1 on an archived account" when an archived account closed one. */
  detail: string;
  /**
   * Per currency, the realized + external losses of the same accounts as the result, from their daily usage: every
   * account row, plus an archived account that closed a trade today (no row shows it): "€26.83 · $295.00".
   */
  losses: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Live trades (§14.1, §3.6, §7.1).
// ---------------------------------------------------------------------------------------------------------------------
export interface LastJournalView {
  title: string;
  body: string | null;
  /** "14:20". */
  time: string;
  /** "25 min ago" (server time). */
  relative: string;
}

/** One fact of a live position: "Stop" 1.33494 with the lines "At entry", "Moved 13:43", "Initial 1.33697". */
export interface LiveFactView {
  label: string;
  /** The value, or "Not recorded". */
  value: string;
  /** `muted`: not recorded; `warning`: the missing risk that leaves realized R unknown. */
  tone: "default" | "muted" | "warning";
  /** Short lines under the value ("30% closed", "Initial 1.33697"). */
  hints: string[];
}

export interface LiveTradeView {
  /** Handle for links, the composer and uploads; never printed. */
  id: string;
  href: string;
  closeHref: string;
  /** "EURUSD". */
  symbol: string;
  /** "Long" / "Short" / null. */
  direction: string | null;
  /** "EURUSD · Long" (accessible names of the card's controls). */
  title: string;
  origin: { label: string; tooltip: string | null };
  accountName: string;
  /**
   * Entry, Size (with partial closes), Stop (the latest stop move from the journal, else the initial stop) and Initial
   * risk (the R denominator, which a moved stop never changes).
   */
  facts: LiveFactView[];
  /** A risk basis was recorded, so realized R can be computed at the close. */
  riskRecorded: boolean;
  oversize: boolean;
  /** ISO instant the live duration counts from (entry time, else when it was recorded). */
  since: string;
  /** "Entered 13:30" / "Recorded 13:30 · entry time not recorded". */
  sinceLabel: string;
  lastJournal: LastJournalView | null;
  /** Link to complete missing entry details (live-first and imported positions), else null. */
  addDetailsHref: string | null;
  /** Screenshots the trade can still take (24 minus its active ones). */
  screenshotCapacity: number;
  /** "3 screenshots" (active ones), or null without any. */
  screenshots: string | null;
  /** Contract of the composer's Stop/Target checks. */
  instrument: { tickSize: string; quantityStep: string | null } | null;
  /** Idempotency key of the composer's first entry. */
  requestKey: string;
  menu: TradeMenuView;
}

/** The trade's menu (Open, Duplicate as draft, Delete trade; 0020). */
export interface TradeMenuView {
  /** Locked or live: Delete trade is unavailable until the trade is closed, skipped or cancelled. */
  open: boolean;
  /** A planned trade with a draft or a plan: Duplicate as draft is offered. */
  duplicate: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans waiting and closed trades.
// ---------------------------------------------------------------------------------------------------------------------
export type PlanActionView =
  /** `primary` for the row's one next step; `ghost` for the quieter choice beside a secondary main action. */
  | ({ kind: "link"; variant: "primary" | "secondary" | "ghost" } & LinkAction)
  /** The free deterministic check runs right here (`checkRisk`). */
  | { kind: "check"; label: string; tradeId: string }
  /** Skip or cancel a plan locked on an earlier day, with a reason (`setDisposition`). */
  | { kind: "skip"; label: string; tradeId: string; lockedOn: string };

export interface PlanReasonView {
  /** The engine's sentence (spec §6.5). */
  text: string;
  /** "Oct 23" when the check ran on an earlier strategy day: the sentence describes that day, not today. */
  checkedOn: string | null;
}

export interface PlanRowView {
  id: string;
  href: string;
  /** "XAUUSD · Short". */
  title: string;
  accountName: string;
  state: { label: string; tone: PillTone };
  /** "Locked 10:52 · Entry 2,415.50 · Stop 2,420.00 · Target 2,400.00 · Risk 0.50% ($500.00)". */
  meta: string;
  /** First blocking reason of a blocked draft. */
  reason: PlanReasonView | null;
  /**
   * Left to right, the main one last: the row's next step, or for an earlier day a quieter choice beside it (Skip… with
   * Record entry for a plan locked earlier; Edit draft with Recheck risk for a block found earlier).
   */
  actions: PlanActionView[];
  menu: TradeMenuView;
}

export interface PlansView {
  /** Plans locked today, then drafts worked on today (Ready to lock, Recheck needed, Blocked, Draft). */
  current: PlanRowView[];
  /** Plans locked on an earlier strategy day and still waiting: their slot and risk count on that day, not today. */
  earlierLocked: PlanRowView[];
  /** Many of them (V1 plans taken without a recorded fill stay locked) are folded away, like older drafts. */
  foldEarlierLocked: boolean;
  /** Drafts last touched before today (at most OLDER_DRAFTS_SHOWN). */
  older: PlanRowView[];
  /** Older drafts not listed here (the Journal lists them). */
  olderHidden: number;
  /** Many older drafts are folded away; a few are listed under their own label. */
  foldOlder: boolean;
  /** "1 locked · 1 locked earlier · 3 drafts today". */
  summary: string;
  total: number;
  /** The lists reached their bound; the Journal lists every trade. */
  truncated: boolean;
  journalHref: string;
}

export interface ClosedTradeView {
  id: string;
  href: string;
  title: string;
  origin: { label: string; tooltip: string | null };
  accountName: string;
  /** "Exit 11:20". */
  exit: string;
  /** "+1.20R"; null when no risk basis was recorded. */
  r: ValueText | null;
  pnl: ValueText | null;
  state: { label: string; tone: PillTone };
  action: LinkAction | null;
  menu: TradeMenuView;
}

// ---------------------------------------------------------------------------------------------------------------------
// Today's plan · notes (V1 daily context).
// ---------------------------------------------------------------------------------------------------------------------
export type NotesView =
  | { mode: "account"; accountId: string; accountName: string; narrative: string; savedLabel: string | null; archived: boolean }
  | { mode: "all"; accounts: LinkAction[] };

export interface TodayView {
  /** Server time of this render (ISO 8601 UTC); clocks tick from it. */
  now: string;
  /** Strategy day (fixed UTC−5). */
  day: string;
  /** "Fri, Oct 23 (UTC−5)". */
  dayLabel: string;
  display: TimeDisplay;
  /** "Times in UTC−5" (the person's time display). */
  zoneNote: string;
  context: { mode: "all" | "account"; label: string; detail: string };
  /** Rows name their account (All Accounts). */
  showAccount: boolean;
  status: AccountStatusView[];
  summary: DaySummaryView | null;
  live: LiveTradeView[];
  liveTruncated: boolean;
  liveJournalHref: string;
  plans: PlansView;
  closed: ClosedTradeView[];
  closedJournalHref: string;
  closedTruncated: boolean;
  notes: NotesView;
  /** Nothing live, waiting or closed today: the two large actions lead. */
  empty: boolean;
  newTradeHrefs: { plan: string; live: string };
  /** All Accounts only (V2.1): the combined overview between the header and the session ribbon. */
  overview?: OverviewState | null;
}

/** The All Accounts overview of one request; `figures` is null when it could not be read. */
export interface OverviewState {
  range: OverviewRange;
  figures: OverviewFigures | null;
  /** `?currency=` of the chart; the first currency when it names none of the period's. */
  currency: string | null;
}

/** What the Today route renders. */
export type TodayPage =
  | { kind: "today"; view: TodayView }
  /** First run: the user has no trading account. */
  | { kind: "onboarding"; dayLabel: string }
  /** Every trading account is archived. */
  | { kind: "no-active"; dayLabel: string; archivedCount: number };
