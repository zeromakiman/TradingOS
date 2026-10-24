/**
 * Copy of the Review workspace (docs/V2_ARCHITECTURE.md §11.5, §14.10, §15). Pure, so the server screen, the loading
 * skeleton and the tests share one source.
 */

export const REVIEW_TITLE = "Review";
export const REVIEW_DESCRIPTION = "Step back from single trades: AI reviews of a week, a month or your latest trades. Advisory, and only when you ask.";
export const REVIEW_TABS_LABEL = "Review sections";

export const NO_ACCOUNTS_TITLE = "Create your first trading account";
export const NO_ACCOUNTS_DESCRIPTION = "Reviews look back at the closed trades of one trading account. Add an account, then plan or record trades.";

/**
 * What a periodic review reads from each trade. The weekly, monthly and recent-trades facts are built from the plans,
 * risk versions, executions and outcomes; entries of the trade journal and screenshots are not part of them yet.
 */
export const PERIODIC_SOURCES = "Uses their original plans, risk versions, entries and exits. Journal notes and screenshots are not included yet.";

export const CHOOSE_TITLE = "Choose a trading account";
export const FACTS_UNAVAILABLE = "Trade counts for this period are unavailable right now. The review itself is not affected.";
export const BUDGET_TITLE = "AI budget";
export const BUDGETS_TITLE = "AI budgets this month";

export const HISTORY_TITLE = "AI history";
export const HISTORY_EMPTY_TITLE = "No AI analyses yet.";
export const HISTORY_EMPTY_DESCRIPTION =
  "Reviews you request here and the analyses you run on a trade appear in this list, including attempts that did not complete.";
export const HISTORY_FILTERED_EMPTY_TITLE = "No analyses match this view.";
export const HISTORY_FILTERED_EMPTY_DESCRIPTION = "Show every analysis, or choose another account or kind of analysis.";
export const HISTORY_SOURCES_TITLE = "Where analyses come from";
export const HISTORY_SOURCES: readonly string[] = [
  "Weekly, recent-trades and monthly reviews are requested in the tabs above, for one trading account at a time.",
  "Setup analyses, bias challenges and trade reviews are requested on each trade's page.",
  "Every request is listed, including attempts that did not complete, with what it cost.",
];
export const IN_PROGRESS_TEXT = "Still running. Refresh to see the result.";
