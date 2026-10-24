import "server-only";
import { z } from "zod";
import { monthlyPeriod, previousCompletedMonth } from "@/ai/monthly-period";
import { previousCompletedWeek, weeklyPeriod } from "@/ai/weekly-period";
import { aiBudgetAmounts, type AiBudgetModel, type AiBudgetStatusModel, aiBudgetStatus } from "@/components/ai/ai-budget-summary";
import { aiEstimate } from "@/components/ai/estimate";
import type { AiEstimateModel } from "@/components/ai/model";
import { optional } from "@/components/ai/panel-data";
import { ACCOUNT_TYPE_LABELS } from "@/domain/account-metrics";
import { plural } from "@/domain/format";
import { TRADE_ORIGINS, type TradeOrigin } from "@/domain/ledger";
import { isInstant, strategyDay, strategyMonth, type TimeDisplay } from "@/domain/time-display";
import { type AccountContext, type ContextAccount, currentSession, type Db, getAccountContext, getPreferences } from "@/lib/account-context";
import { loadAiBudget } from "@/lib/ai-budget";
import { journalHref, type TradeFilters } from "@/lib/trades-data";
import { PERIODIC_SOURCES } from "./copy";
import { loadHistoryPage } from "./history-data";
import { groupByDay, type HistoryDayGroup } from "./history-model";
import {
  HISTORY_KIND_LABELS, HISTORY_KIND_SHORT_LABELS, HISTORY_KINDS, type HistoryKind, type PeriodicTab, parseReviewQuery, RECENT_SAMPLES, type ReviewLinkState,
  type ReviewQuery, type ReviewTab, type ReviewTabLink, reviewHref, reviewTabs, type SearchParams,
} from "./params";
import {
  countByMonth, countByWeek, countOrigins, countsFor, MAX_MONTH_OPTIONS, MAX_WEEK_OPTIONS, monthPicker, monthsBack, monthTitle, mondayOf, type PeriodCounts,
  type PeriodPickerModel, plannedSampleText, plannedSoFarText, weekPicker, weekRange, weeksBack, weekTitle,
} from "./periods";

/**
 * Data of the Review workspace (docs/V2_ARCHITECTURE.md §9.1–9.2, §11.1–11.2, §11.5, §14.10). Everything is read with
 * the user's session; nothing here sends an AI request (the periodic panel loads its own AI data, and only its button
 * sends a request, after a click).
 *
 * Account scope is always explicit. A selected account context reviews that account. All Accounts reviews the account
 * chosen inside the page (`reviewAccount`), else the most recently used active account (the same default as Plan
 * Trade), else asks the trader to choose: AI budgets, consent and review scope stay per account (§11.5), so a periodic
 * review never spans accounts. History is the one place that lists the analyses of every account.
 */

export interface ReviewAccountItem {
  id: string;
  name: string;
  currency: string;
  /** "Evaluation · USD". */
  detail: string;
  archived: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
  href: string;
}

export interface SelectGroup {
  /** Option group label ("Archived"); null for the ungrouped first group. */
  label: string | null;
  options: SelectOption[];
}

/** A select whose options navigate (URL state). */
export interface NavigateSelectModel {
  name: string;
  label: string;
  value: string;
  groups: SelectGroup[];
}

export interface SegmentLink {
  href: string;
  label: string;
  /** Shorter wording for phones; `label` otherwise. */
  shortLabel?: string;
  current: boolean;
}

export interface FactRow {
  /** Whole count, as text. */
  value: string;
  label: string;
  note: string;
  /** `pending`: the period has not ended, so the count can still change and nothing can be reviewed yet. */
  tone: "included" | "excluded" | "neutral" | "pending";
}

/** The Journal, filtered to the trades a fact block counts. */
export interface FactsJournalLink {
  href: string;
  /** Visible text: "Open in Journal". */
  label: string;
  /** Accessible name, starting with the visible text: "Open in Journal: trades closed Oct 12–18". */
  description: string;
  /**
   * All Accounts: the link selects the account as the context (§9.2). It is never prefetched, and ReviewContextScope
   * loads it in full so the header follows.
   */
  switchesContext: boolean;
}

/** A week or month as its facts block names it. */
export interface FactsPeriod {
  /** "Closed Oct 12–18", "Closed in September 2026"; "Closed so far, Oct 19–25" while the period runs. */
  heading: string;
  /** "week not finished" or "month not finished" while the period runs (its counts can still change); null once it has ended. */
  unfinished: string | null;
}

/** Deterministic counts from Trading OS for the selected period (never from the AI). */
export interface PeriodFactsModel {
  heading: string;
  rows: FactRow[];
  journal: FactsJournalLink | null;
}

export type PeriodControl = { kind: "picker"; picker: PeriodPickerModel } | { kind: "sample"; label: string; items: SegmentLink[] };

export interface PanelRequest {
  kind: PeriodicTab;
  accountId: string;
  /** Monday of the week, the sample size or the month, as PeriodicReviewPanel takes it. */
  period: string | number;
}

export interface PeriodicContent {
  kind: "periodic";
  tab: PeriodicTab;
  account: ReviewAccountItem;
  /** The in-page account picker (All Accounts only). */
  accountSelect: NavigateSelectModel | null;
  period: PeriodControl;
  /** Null when the trade counts could not be read. */
  facts: PeriodFactsModel | null;
  budget: AiBudgetModel;
  explainer: { title: string; points: string[] };
  panel: PanelRequest;
}

export interface ChooserRow {
  account: ReviewAccountItem;
  href: string;
  /** "Week of Oct 12–18 · 5 trades · reviewed"; null when it could not be read. */
  summary: string | null;
  status: AiBudgetStatusModel;
  /** "€0.13 of €10.00 · €9.86 left" or "Usage unavailable". */
  usage: string;
}

export interface ChooseContent {
  kind: "choose";
  tab: PeriodicTab;
  /** "Week of Oct 12–18", "Last 20 trades", "September 2026": the period each row describes. */
  periodLabel: string;
  description: string;
  active: ChooserRow[];
  archived: ChooserRow[];
}

export interface HistoryBudget {
  account: ReviewAccountItem;
  budget: AiBudgetModel;
}

export interface HistoryContent {
  kind: "history";
  accountSelect: NavigateSelectModel | null;
  kinds: SegmentLink[];
  historyKind: HistoryKind;
  /** Single-account context: the list covers that account; the link switches to All Accounts. */
  scopeNote: { text: string; href: string; label: string } | null;
  /** Several accounts can appear, so each row names its account. */
  showAccount: boolean;
  accountNames: Readonly<Record<string, string>>;
  groups: HistoryDayGroup[];
  /** Entries on this page. */
  count: number;
  newestHref: string | null;
  olderHref: string | null;
  error: string | null;
  /** What the list covers, in words: "Every trade analysis of Personal 12K, newest first." */
  description: string;
  /** An in-page filter (account or kind) narrows the list. */
  filtered: boolean;
  clearHref: string;
  budgets: HistoryBudget[];
}

export type ReviewContent = { kind: "no-accounts" } | ChooseContent | PeriodicContent | HistoryContent;

export interface ReviewView {
  tab: ReviewTab;
  nowIso: string;
  display: TimeDisplay;
  developerMode: boolean;
  /** The header's trading-account context of this request: `all` or the selected account's id (see ReviewContextScope). */
  contextValue: string;
  /** "All Accounts · 3 trading accounts" or "FTMO 100K · USD". */
  scopeLabel: string;
  tabs: ReviewTabLink[];
  notices: string[];
  content: ReviewContent;
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy.
// ---------------------------------------------------------------------------------------------------------------------

export const UNAVAILABLE_ACCOUNT = "That trading account isn't available. Choose one of your accounts.";
export const UNAVAILABLE_ACCOUNT_HISTORY = "That trading account isn't available. Showing every account.";
export const INVALID_PERIOD: Readonly<Record<PeriodicTab, string>> = {
  weekly: "That week couldn't be read. Showing the last completed week.",
  recent: "Choose 10, 20 or 30 trades. Showing the latest 20.",
  monthly: "That month couldn't be read. Showing the last completed month.",
};
const CHOOSE_DESCRIPTION: Readonly<Record<PeriodicTab, string>> = {
  weekly: "A weekly review looks at one trading account at a time: AI budgets, consent and the trades reviewed are set per account.",
  recent: "A recent-trades analysis looks at one trading account at a time: AI budgets, consent and the trades analyzed are set per account.",
  monthly: "A monthly review looks at one trading account at a time: AI budgets, consent and the trades reviewed are set per account.",
};
const EXPLAINER_TITLES: Readonly<Record<PeriodicTab, string>> = {
  weekly: "How weekly reviews work",
  recent: "How recent-trades analysis works",
  monthly: "How monthly reviews work",
};
/** What a periodic review covers, what it reads from each trade (PERIODIC_SOURCES) and when it can run. */
const SCOPE_POINTS: Readonly<Record<PeriodicTab, readonly string[]>> = {
  weekly: [
    "Covers the planned trades you closed from Monday 00:00 to Sunday 24:00 (fixed UTC−5).",
    PERIODIC_SOURCES,
    "A week can be reviewed once it has ended.",
  ],
  recent: [
    "Covers your most recent completed planned trades with a recorded R, newest first: 10, 20 or 30 of them.",
    PERIODIC_SOURCES,
    "The sample is taken when you ask, so a later analysis can include newer trades.",
  ],
  monthly: [
    "Covers the planned trades you closed in the calendar month (fixed UTC−5).",
    PERIODIC_SOURCES,
    "A month can be reviewed from the 1st of the next month.",
  ],
};
const NOTHING_SENT: Readonly<Record<PeriodicTab, string>> = {
  weekly: "Nothing is sent when this page opens. A review runs only when you click its button.",
  recent: "Nothing is sent when this page opens. An analysis runs only when you click its button.",
  monthly: "Nothing is sent when this page opens. A review runs only when you click its button.",
};
const ADVISORY = "Advisory only: it never changes your records, your plans or the Risk Engine's decisions.";

// ---------------------------------------------------------------------------------------------------------------------
// Accounts and scope.
// ---------------------------------------------------------------------------------------------------------------------

export function accountItem(account: ContextAccount): ReviewAccountItem {
  return {
    id: account.id, name: account.name, currency: account.currency, detail: `${ACCOUNT_TYPE_LABELS[account.type]} · ${account.currency}`,
    archived: account.status === "ARCHIVED",
  };
}

/** "All Accounts · 3 trading accounts" or "FTMO 100K · USD". */
export function reviewScopeLabel(context: AccountContext): string {
  if (context.selected.mode === "account") return `${context.selected.account.name} · ${context.selected.account.currency}`;
  return `All Accounts · ${plural(context.accounts.length, "trading account")}`;
}

/** Active accounts first; archived ones in their own group (they keep their history and can still be reviewed). */
function accountGroups(context: AccountContext, href: (accountId: string) => string, lead: SelectOption | null): SelectGroup[] {
  const option = (account: ContextAccount): SelectOption => ({ value: account.id, label: `${account.name} · ${account.currency}`, href: href(account.id) });
  const groups: SelectGroup[] = [{ label: null, options: [...(lead ? [lead] : []), ...context.active.map(option)] }];
  if (context.archived.length) groups.push({ label: "Archived", options: context.archived.map(option) });
  return groups;
}

/** The period of the current URL, kept when the account changes. */
function periodState(tab: PeriodicTab, query: ReviewQuery): ReviewLinkState {
  if (!query.explicitPeriod) return {};
  return tab === "weekly" ? { week: query.week } : tab === "monthly" ? { month: query.month } : { sample: query.sample };
}

/** `href` with one more query parameter. */
function withParam(href: string, key: string, value: string): string {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${path}?${params.toString()}`;
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------------------------------------------------

const PAGE = 1000;
const MAX_CLOSED_ROWS = 20_000;
const closedRow = z.object({ id: z.uuid(), account_id: z.uuid(), origin: z.enum(TRADE_ORIGINS), exited_at: z.string().refine(isInstant) });
type ClosedRow = z.infer<typeof closedRow>;

/**
 * Closed trades (any origin) of the given accounts exiting in [from, to), keyset-paged by id. A window holding more
 * than MAX_CLOSED_ROWS trades is refused rather than counted short: the pickers then show no counts instead of wrong ones.
 */
async function closedTrades(db: Db, accountIds: readonly string[], from: string, to: string | null): Promise<ClosedRow[]> {
  const rows: ClosedRow[] = [];
  let after: string | null = null;
  for (;;) {
    let query = db.from("trade_ledger").select("id,account_id,origin,exited_at").in("account_id", [...accountIds]).gte("exited_at", from);
    if (to !== null) query = query.lt("exited_at", to);
    if (after !== null) query = query.gt("id", after);
    const { data, error } = await query.order("id", { ascending: true }).limit(PAGE);
    if (error) throw new Error("Trades are unavailable.");
    const batch = z.array(closedRow).parse(data ?? []);
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
    if (rows.length >= MAX_CLOSED_ROWS) throw new Error("Too many trades to count.");
    after = batch[batch.length - 1].id;
  }
}

const REVIEW_TABLES = {
  weekly: { requests: "weekly_ai_reviews", results: "weekly_ai_review_results", column: "week_start" },
  monthly: { requests: "monthly_ai_reviews", results: "monthly_ai_review_results", column: "month_start" },
} as const;
const REVIEWED_LIMIT = 500;
const reviewRequestRow = z.object({ id: z.uuid(), account_id: z.uuid(), week_start: z.string().optional(), month_start: z.string().optional() });

/**
 * Periods that already have a completed AI review, per account: Mondays (weekly) or `YYYY-MM` (monthly). `only`
 * narrows the read to one period. Failed attempts do not count.
 */
async function reviewedPeriods(db: Db, userId: string, accountIds: readonly string[], tab: "weekly" | "monthly", only?: string): Promise<Map<string, Set<string>>> {
  const table = REVIEW_TABLES[tab];
  let requests = db.from(table.requests).select(`id,account_id,${table.column}`).eq("user_id", userId).in("account_id", [...accountIds]);
  if (only !== undefined) requests = requests.eq(table.column, tab === "weekly" ? only : `${only}-01`);
  const results = db.from(table.results).select("review_id").eq("user_id", userId).in("account_id", [...accountIds]).eq("status", "COMPLETED");
  const [requested, completed] = await Promise.all([
    requests.order("created_at", { ascending: false }).limit(REVIEWED_LIMIT),
    results.order("created_at", { ascending: false }).limit(REVIEWED_LIMIT * 2),
  ]);
  if (requested.error || completed.error) throw new Error("AI history unavailable");
  const done = new Set(z.array(z.object({ review_id: z.uuid() })).parse(completed.data ?? []).map(row => row.review_id));
  const periods = new Map<string, Set<string>>();
  for (const row of z.array(reviewRequestRow).parse(requested.data ?? [])) {
    const period = tab === "weekly" ? row.week_start : row.month_start?.slice(0, 7);
    if (!period || !done.has(row.id)) continue;
    const set = periods.get(row.account_id) ?? new Set<string>();
    set.add(period);
    periods.set(row.account_id, set);
  }
  return periods;
}

/**
 * Closed trades of one account and origin up to now (exact count; at most one row is transferred). Planned trades
 * count only with a recorded R, which mirrors the recent-trades sample; live-first and imported trades are counted to
 * say what the analysis leaves out.
 */
async function closedCount(db: Db, accountId: string, origin: TradeOrigin, nowIso: string): Promise<number> {
  const base = db.from("trade_ledger").select("id", { count: "exact" }).eq("account_id", accountId).eq("origin", origin).not("exited_at", "is", null).lte("exited_at", nowIso);
  const filtered = origin === "PLANNED" ? base.filter("realized_r", "not.is", null) : base;
  const { count, error } = await filtered.limit(1);
  if (error || count === null) throw new Error("Trades are unavailable.");
  return count;
}

// ---------------------------------------------------------------------------------------------------------------------
// Periodic tabs.
// ---------------------------------------------------------------------------------------------------------------------

function excludedRows(counts: PeriodCounts): FactRow[] {
  const rows: FactRow[] = [];
  if (counts.liveFirst > 0) rows.push({ value: String(counts.liveFirst), label: counts.liveFirst === 1 ? "live-first trade" : "live-first trades", note: "not included", tone: "excluded" });
  if (counts.imported > 0) rows.push({ value: String(counts.imported), label: counts.imported === 1 ? "imported trade" : "imported trades", note: "not included", tone: "excluded" });
  return rows;
}

/** A week as its facts block names it; one after the last completed week is still running. */
export function weekFactsPeriod(week: string, lastCompleted: string): FactsPeriod {
  const range = weekRange(week);
  return week > lastCompleted ? { heading: `Closed so far, ${range}`, unfinished: "week not finished" } : { heading: `Closed ${range}`, unfinished: null };
}

/** A month as its facts block names it; one after the last completed month is still running. */
export function monthFactsPeriod(month: string, lastCompleted: string): FactsPeriod {
  const title = monthTitle(month);
  return month > lastCompleted ? { heading: `Closed so far in ${title}`, unfinished: "month not finished" } : { heading: `Closed in ${title}`, unfinished: null };
}

/**
 * Weekly and monthly: what closed in the period, and what the review covers. While the period runs, its planned trades
 * are counted so far and never called included: the count can still change, and the review runs only once it ends.
 */
export function periodFacts({ heading, unfinished }: FactsPeriod, counts: PeriodCounts, journal: PeriodFactsModel["journal"]): PeriodFactsModel {
  if (counts.planned + counts.liveFirst + counts.imported === 0) {
    const row: FactRow = unfinished
      ? { value: "0", label: "closed trades", note: unfinished, tone: "pending" }
      : { value: "0", label: "closed trades", note: "nothing to review", tone: "neutral" };
    return { heading, rows: [row], journal: null };
  }
  const label = counts.planned === 1 ? "planned trade" : "planned trades";
  const planned: FactRow = unfinished
    ? { value: String(counts.planned), label, note: unfinished, tone: "pending" }
    : { value: String(counts.planned), label, note: counts.planned > 0 ? "included" : "nothing to review", tone: counts.planned > 0 ? "included" : "neutral" };
  return { heading, rows: [planned, ...excludedRows(counts)], journal };
}

/**
 * Recent trades: the completed planned trades available (each has a recorded R, which the sample requires), how many
 * the chosen sample takes, and what is left out.
 */
export function sampleFacts(counts: PeriodCounts, sample: number, journal: PeriodFactsModel["journal"]): PeriodFactsModel {
  const heading = "Completed so far";
  const { planned } = counts;
  if (planned + counts.liveFirst + counts.imported === 0) {
    return { heading, rows: [{ value: "0", label: "completed trades", note: "nothing to analyze yet", tone: "neutral" }], journal: null };
  }
  const taken = Math.min(planned, sample);
  const note = planned === 0 ? "nothing to analyze" : taken === planned ? (planned === 1 ? "included" : `all ${planned} included`) : `the latest ${taken} are included`;
  const row: FactRow = { value: String(planned), label: planned === 1 ? "planned trade" : "planned trades", note, tone: planned > 0 ? "included" : "neutral" };
  return { heading, rows: [row, ...excludedRows(counts)], journal };
}

const JOURNAL_LABEL = "Open in Journal";

function journalLink(allAccounts: boolean, accountId: string, filters: TradeFilters, what: string): FactsJournalLink {
  return {
    href: journalHref(filters, allAccounts ? { account: accountId } : {}), label: JOURNAL_LABEL, description: `${JOURNAL_LABEL}: ${what}`,
    switchesContext: allAccounts,
  };
}

interface PeriodicInput {
  db: Db;
  userId: string;
  tab: PeriodicTab;
  query: ReviewQuery;
  account: ContextAccount;
  allAccounts: boolean;
  now: Date;
}

interface Controls {
  period: PeriodControl;
  facts: PeriodFactsModel | null;
}

async function weeklyControls({ db, userId, query, account, allAccounts, now }: PeriodicInput): Promise<Controls> {
  const reviewAccount = allAccounts ? account.id : null;
  const lastCompleted = previousCompletedWeek(now).startDate;
  const earliest = mondayOf(strategyDay(account.createdAt));
  const listed = weeksBack(lastCompleted, earliest, MAX_WEEK_OPTIONS);
  const from = earlier(listed[listed.length - 1] ?? lastCompleted, query.week);
  const [trades, reviewed] = await Promise.all([
    optional(closedTrades(db, [account.id], weeklyPeriod(from).start, null)),
    optional(reviewedPeriods(db, userId, [account.id], "weekly")),
  ]);
  const counts = trades === null ? null : countByWeek(trades);
  const picker = weekPicker({
    selected: query.week, lastCompleted, earliest, counts, reviewed: reviewed?.get(account.id) ?? new Set(), currentYear: strategyDay(now).slice(0, 4),
    href: week => reviewHref("weekly", { week, reviewAccount }),
  });
  const period = weeklyPeriod(query.week);
  const journal = journalLink(allAccounts, account.id, { closedFrom: period.startDate, closedTo: period.endDate }, `trades closed ${weekRange(query.week)}`);
  const facts = counts === null ? null : periodFacts(weekFactsPeriod(query.week, lastCompleted), countsFor(counts, query.week), journal);
  return { period: { kind: "picker", picker }, facts };
}

async function monthlyControls({ db, userId, query, account, allAccounts, now }: PeriodicInput): Promise<Controls> {
  const reviewAccount = allAccounts ? account.id : null;
  const lastCompleted = previousCompletedMonth(now).month;
  const earliest = strategyMonth(account.createdAt);
  const listed = monthsBack(lastCompleted, earliest, MAX_MONTH_OPTIONS);
  const from = earlier(listed[listed.length - 1] ?? lastCompleted, query.month);
  const [trades, reviewed] = await Promise.all([
    optional(closedTrades(db, [account.id], monthlyPeriod(from).start, null)),
    optional(reviewedPeriods(db, userId, [account.id], "monthly")),
  ]);
  const counts = trades === null ? null : countByMonth(trades);
  const picker = monthPicker({
    selected: query.month, lastCompleted, earliest, counts, reviewed: reviewed?.get(account.id) ?? new Set(), currentYear: strategyDay(now).slice(0, 4),
    href: month => reviewHref("monthly", { month, reviewAccount }),
  });
  const period = monthlyPeriod(query.month);
  const journal = journalLink(allAccounts, account.id, { closedFrom: period.startDate, closedTo: period.endDate }, `trades closed in ${monthTitle(query.month)}`);
  const facts = counts === null ? null : periodFacts(monthFactsPeriod(query.month, lastCompleted), countsFor(counts, query.month), journal);
  return { period: { kind: "picker", picker }, facts };
}

async function recentControls({ db, query, account, allAccounts, now }: PeriodicInput): Promise<Controls> {
  const reviewAccount = allAccounts ? account.id : null;
  const items = RECENT_SAMPLES.map(sample => ({ href: reviewHref("recent", { sample, reviewAccount }), label: `${sample} trades`, current: sample === query.sample }));
  const nowIso = now.toISOString();
  const counts = await optional(Promise.all(TRADE_ORIGINS.map(origin => closedCount(db, account.id, origin, nowIso))));
  const period: PeriodControl = { kind: "sample", label: "Sample", items };
  if (counts === null) return { period, facts: null };
  const [planned, liveFirst, imported] = counts;
  const journal = journalLink(allAccounts, account.id, { states: ["CLOSED", "REVIEWED"] }, "closed trades");
  return { period, facts: sampleFacts({ planned, liveFirst, imported }, query.sample, journal) };
}

const OPERATIONS = { weekly: "WEEKLY_REVIEW", recent: "RECENT_TRADES_ANALYSIS", monthly: "MONTHLY_REVIEW" } as const;

/** How the review works, including what it costs (the same estimate its button shows). */
export function explainer(tab: PeriodicTab, estimate: AiEstimateModel | null): PeriodicContent["explainer"] {
  const cost = estimate
    ? `Typically ≈ ${estimate.typical} per request. At most ${estimate.max} is reserved while it runs; unused funds are released.`
    : "AI pricing requires review before requests can run.";
  return { title: EXPLAINER_TITLES[tab], points: [...SCOPE_POINTS[tab], NOTHING_SENT[tab], cost, ADVISORY] };
}

async function periodicContent(input: PeriodicInput, context: AccountContext): Promise<PeriodicContent> {
  const { tab, query, account, allAccounts, now } = input;
  const controls = tab === "weekly" ? weeklyControls(input) : tab === "monthly" ? monthlyControls(input) : recentControls(input);
  const [{ period, facts }, budget] = await Promise.all([controls, loadAiBudget(account.id)]);
  const keep = periodState(tab, query);
  // All Accounts picks the account inside the page; with a single trading account there is nothing to choose.
  const accountSelect: NavigateSelectModel | null = allAccounts && context.accounts.length > 1
    ? { name: "reviewAccount", label: "Trading account", value: account.id, groups: accountGroups(context, id => reviewHref(tab, { ...keep, reviewAccount: id }), null) }
    : null;
  return {
    kind: "periodic", tab, account: accountItem(account), accountSelect, period, facts, budget, explainer: explainer(tab, aiEstimate(OPERATIONS[tab], now)),
    panel: { kind: tab, accountId: account.id, period: tab === "weekly" ? query.week : tab === "monthly" ? query.month : query.sample },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Chooser (All Accounts without a chosen account).
// ---------------------------------------------------------------------------------------------------------------------

/** The period every chooser row describes. */
function chooserPeriodLabel(tab: PeriodicTab, query: ReviewQuery): string {
  if (tab === "weekly") return weekTitle(query.week);
  if (tab === "monthly") return monthTitle(query.month);
  return `Last ${query.sample} trades`;
}

/** What the sample takes from an account's completed planned trades: "All 15 planned trades", "Latest 20 of 31 planned trades". */
export function recentSampleSummary(planned: number, sample: number): string {
  if (planned === 0) return "No completed planned trades yet";
  if (planned === 1) return "1 planned trade";
  return planned <= sample ? `All ${planned} planned trades` : `Latest ${sample} of ${planned} planned trades`;
}

/** One line per account about the period the chooser opens: "5 planned trades · reviewed" or "Latest 20 of 31 planned trades". */
async function chooserSummaries(db: Db, userId: string, tab: PeriodicTab, query: ReviewQuery, accounts: readonly ContextAccount[], now: Date): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  if (!accounts.length) return summaries;
  if (tab === "recent") {
    const counts = await Promise.all(accounts.map(account => closedCount(db, account.id, "PLANNED", now.toISOString())));
    for (const [index, account] of accounts.entries()) summaries.set(account.id, recentSampleSummary(counts[index], query.sample));
    return summaries;
  }
  const weekly = tab === "weekly";
  const key = weekly ? query.week : query.month;
  const period = weekly ? weeklyPeriod(query.week) : monthlyPeriod(query.month);
  // A period that is still running (reachable by link) is counted so far, like its facts block and its picker option.
  const unfinished = weekly ? query.week > previousCompletedWeek(now).startDate : query.month > previousCompletedMonth(now).month;
  const ids = accounts.map(account => account.id);
  const [trades, reviewed] = await Promise.all([
    closedTrades(db, ids, period.start, period.endExclusive),
    reviewedPeriods(db, userId, ids, weekly ? "weekly" : "monthly", key),
  ]);
  for (const account of accounts) {
    const { planned } = countOrigins(trades.filter(trade => trade.account_id === account.id));
    const parts = unfinished ? [plannedSoFarText(planned), "not finished"] : [plannedSampleText(planned)];
    if (reviewed.get(account.id)?.has(key)) parts.push("reviewed");
    summaries.set(account.id, parts.join(" · "));
  }
  return summaries;
}

async function chooseContent(db: Db, userId: string, tab: PeriodicTab, query: ReviewQuery, context: AccountContext, now: Date): Promise<ChooseContent> {
  const keep = periodState(tab, query);
  const [summaries, budgets] = await Promise.all([
    optional(chooserSummaries(db, userId, tab, query, context.accounts, now)),
    Promise.all(context.accounts.map(account => loadAiBudget(account.id))),
  ]);
  const rows = context.accounts.map((account, index): ChooserRow => {
    const budget = budgets[index];
    return {
      account: accountItem(account),
      href: reviewHref(tab, { ...keep, reviewAccount: account.id }),
      summary: summaries?.get(account.id) ?? null,
      status: aiBudgetStatus(budget, now),
      usage: budget.snapshot && budget.presentation ? aiBudgetAmounts(budget.snapshot, budget.presentation.remainingMicros) : "Usage unavailable",
    };
  });
  return {
    kind: "choose", tab, periodLabel: chooserPeriodLabel(tab, query), description: CHOOSE_DESCRIPTION[tab],
    active: rows.filter(row => !row.account.archived), archived: rows.filter(row => row.account.archived),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// History.
// ---------------------------------------------------------------------------------------------------------------------

const HISTORY_SUBJECTS: Readonly<Record<HistoryKind, string>> = { all: "Every AI analysis", periodic: "Every periodic review", trade: "Every trade analysis" };

/** "Every AI analysis of your trading accounts, newest first: …", "Every trade analysis of Personal 12K, newest first." */
export function historyDescription(kind: HistoryKind, accountName: string | null): string {
  const scope = accountName ? `of ${accountName}` : "of your trading accounts";
  const detail = kind === "all" ? ": periodic reviews and the analyses run on single trades" : "";
  return `${HISTORY_SUBJECTS[kind]} ${scope}, newest first${detail}.`;
}

interface HistoryInput {
  db: Db;
  userId: string;
  query: ReviewQuery;
  context: AccountContext;
  /** The account the list is narrowed to: the selected context account, or the in-page filter in All Accounts. */
  picked: ContextAccount | null;
  display: TimeDisplay;
  now: Date;
}

async function historyContent({ db, userId, query, context, picked, display, now }: HistoryInput): Promise<HistoryContent> {
  const allAccounts = context.selected.mode === "all";
  const accountId = picked?.id ?? null;
  const reviewAccount = allAccounts ? accountId : null;
  // Budgets of the accounts the list covers; archived accounts keep their history but no longer plan new trades.
  const budgetAccounts = picked ? [picked] : context.active;
  const [page, budgets] = await Promise.all([
    loadHistoryPage({ db, userId, accountId, kind: query.kind, before: query.before, linkAccounts: allAccounts, display, now }),
    Promise.all(budgetAccounts.map(async account => ({ account: accountItem(account), budget: await loadAiBudget(account.id) }))),
  ]);
  const accountSelect: NavigateSelectModel | null = allAccounts && context.accounts.length > 1
    ? {
        name: "reviewAccount",
        label: "Trading account",
        value: accountId ?? "",
        groups: accountGroups(context, id => reviewHref("history", { kind: query.kind, reviewAccount: id }), { value: "", label: "All accounts", href: reviewHref("history", { kind: query.kind }) }),
      }
    : null;
  const kinds = HISTORY_KINDS.map(kind => ({
    href: reviewHref("history", { kind, reviewAccount }), label: HISTORY_KIND_LABELS[kind], shortLabel: HISTORY_KIND_SHORT_LABELS[kind], current: kind === query.kind,
  }));
  return {
    kind: "history",
    accountSelect,
    kinds,
    historyKind: query.kind,
    scopeNote: !allAccounts && picked && context.accounts.length > 1
      ? { text: "Analyses of your other accounts are listed in All Accounts.", href: withParam(reviewHref("history", { kind: query.kind }), "account", "all"), label: "Show every account" }
      : null,
    showAccount: allAccounts && !picked && context.accounts.length > 1,
    accountNames: Object.fromEntries(context.accounts.map(account => [account.id, account.name])),
    groups: groupByDay(page.entries, now.toISOString(), display),
    count: page.entries.length,
    newestHref: query.before ? reviewHref("history", { kind: query.kind, reviewAccount }) : null,
    olderHref: page.nextCursor ? reviewHref("history", { kind: query.kind, reviewAccount, before: page.nextCursor }) : null,
    error: page.error,
    description: historyDescription(query.kind, picked?.name ?? null),
    filtered: (allAccounts && picked !== null) || query.kind !== "all",
    clearHref: reviewHref("history"),
    budgets,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------------------------------------------------

/** All Accounts: the most recently used active account (or the only active one); null when the trader must choose. */
function defaultAccount(context: AccountContext): ContextAccount | null {
  return context.accounts.find(account => account.id === context.formDefaultAccountId) ?? null;
}

/** Everything the Review page renders for one tab and URL. */
export async function loadReview(tab: ReviewTab, params: SearchParams): Promise<ReviewView> {
  const now = new Date();
  const [{ db, user }, context, preferences] = await Promise.all([currentSession(), getAccountContext(), getPreferences()]);
  const query = parseReviewQuery(tab, params, now);
  const allAccounts = context.selected.mode === "all";
  const notices: string[] = [];
  if (tab !== "history" && query.periodInvalid) notices.push(INVALID_PERIOD[tab]);

  // A selected context account always wins; in All Accounts the page's own choice applies.
  let picked: ContextAccount | null = context.selected.mode === "account" ? context.selected.account : null;
  const asked = allAccounts && (query.reviewAccount !== null || query.reviewAccountInvalid);
  if (asked) {
    picked = context.accounts.find(account => account.id === query.reviewAccount) ?? null;
    if (!picked) notices.push(tab === "history" ? UNAVAILABLE_ACCOUNT_HISTORY : UNAVAILABLE_ACCOUNT);
  }

  const display = preferences.timeDisplay;
  const contextValue = context.selected.mode === "account" ? context.selected.account.id : "all";
  const base = { tab, nowIso: now.toISOString(), display, developerMode: preferences.developerMode, contextValue, scopeLabel: reviewScopeLabel(context), notices };
  const tabsFor = (accountId: string | null) => reviewTabs(tab, allAccounts ? accountId : null);

  if (context.accounts.length === 0) return { ...base, tabs: tabsFor(null), content: { kind: "no-accounts" } };
  if (tab === "history") {
    return { ...base, tabs: tabsFor(picked?.id ?? null), content: await historyContent({ db, userId: user.id, query, context, picked, display, now }) };
  }
  // An account asked for but unavailable shows the chooser, never another account.
  const account = picked ?? (asked ? null : defaultAccount(context));
  if (!account) return { ...base, tabs: tabsFor(null), content: await chooseContent(db, user.id, tab, query, context, now) };
  return { ...base, tabs: tabsFor(account.id), content: await periodicContent({ db, userId: user.id, tab, query, account, allAccounts, now }, context) };
}
