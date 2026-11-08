import { monthlyPeriod, previousCompletedMonth } from "@/ai/monthly-period";
import { previousCompletedWeek, weeklyPeriod } from "@/ai/weekly-period";
import { isInstant } from "@/domain/time-display";

/**
 * URL state of the Review workspace (docs/V2_ARCHITECTURE.md §1.2, §9.2, §14.10). Pure, so server pages, client
 * pickers and tests share it.
 *
 * - Each tab is a URL: `/review/weekly` (also served at `/review`), `/review/recent`, `/review/monthly`,
 *   `/review/history`.
 * - Periods keep the V1 parameter names, so legacy `/edge/weekly|recent|monthly?…` links keep their meaning after the
 *   redirect: `week` (any day of the week, normalised to its Monday), `sample` (10, 20 or 30), `month` (`YYYY-MM`).
 * - `?account=` belongs to the proxy: it switches and stores the account context (§9.2). In All Accounts the page's own
 *   account picker therefore uses `reviewAccount`, which never changes the context.
 */

export type ReviewTab = "weekly" | "recent" | "monthly" | "history";
export type PeriodicTab = Exclude<ReviewTab, "history">;
export type RecentSample = 10 | 20 | 30;
export type HistoryKind = "all" | "periodic" | "trade";
export type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

export const REVIEW_ACCOUNT_PARAM = "reviewAccount";
export const RECENT_SAMPLES: readonly RecentSample[] = [10, 20, 30];
export const DEFAULT_SAMPLE: RecentSample = 20;
export const PERIODIC_TABS: readonly PeriodicTab[] = ["weekly", "recent", "monthly"];
export const REVIEW_TABS: readonly ReviewTab[] = [...PERIODIC_TABS, "history"];

export const TAB_PATHS: Readonly<Record<ReviewTab, string>> = {
  weekly: "/review/weekly",
  recent: "/review/recent",
  monthly: "/review/monthly",
  history: "/review/history",
};

export const TAB_LABELS: Readonly<Record<ReviewTab, string>> = {
  weekly: "Weekly",
  recent: "Recent trades",
  monthly: "Monthly",
  history: "History",
};

/**
 * Shorter wording on phones, so the four tabs fit a 360px screen without scrolling (the current tab is never cut off).
 * Each one starts the full label, which stays the tab's accessible name.
 */
export const TAB_SHORT_LABELS: Readonly<Partial<Record<ReviewTab, string>>> = {
  recent: "Recent",
};

export const HISTORY_KINDS: readonly HistoryKind[] = ["all", "periodic", "trade"];

export const HISTORY_KIND_LABELS: Readonly<Record<HistoryKind, string>> = {
  all: "All analyses",
  periodic: "Periodic reviews",
  trade: "Trade analyses",
};

/** The same choices in the width of a phone. */
export const HISTORY_KIND_SHORT_LABELS: Readonly<Record<HistoryKind, string>> = {
  all: "All",
  periodic: "Periodic",
  trade: "Trades",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The last non-empty value of a parameter (repeated parameters keep the last one, like the Journal filters). */
export function readParam(params: SearchParams, key: string): string | undefined {
  const raw = params[key];
  const values = (raw === undefined ? [] : typeof raw === "string" ? [raw] : [...raw]).map(value => value.trim()).filter(Boolean);
  return values.length ? values[values.length - 1] : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// History cursor (keyset over created_at desc, id desc across every AI request table).
// ---------------------------------------------------------------------------------------------------------------------

export interface HistoryCursor {
  /** `created_at` exactly as the database returned it (microseconds kept). */
  t: string;
  id: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return toBase64Url(JSON.stringify({ t: cursor.t, id: cursor.id }));
}

/** Null for anything this module did not write (the list then starts at the newest analysis). */
export function decodeHistoryCursor(value: string | undefined): HistoryCursor | null {
  if (!value || value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { t, id, ...rest } = parsed as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof t !== "string" || typeof id !== "string") return null;
    return isInstant(t) && UUID.test(id) ? { t, id } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Query parsing.
// ---------------------------------------------------------------------------------------------------------------------

export interface ReviewQuery {
  tab: ReviewTab;
  /** Account chosen inside the page (All Accounts only); lowercase id, or null. */
  reviewAccount: string | null;
  /** `reviewAccount` was present but is not an account id. */
  reviewAccountInvalid: boolean;
  /** Monday (`YYYY-MM-DD`) of the selected week; the last completed week by default. */
  week: string;
  /** Selected month (`YYYY-MM`); the last completed month by default. */
  month: string;
  sample: RecentSample;
  /** Whether the period came from the URL (false: the default period). */
  explicitPeriod: boolean;
  /** The URL's period could not be read; the default period is shown instead. */
  periodInvalid: boolean;
  kind: HistoryKind;
  before: HistoryCursor | null;
}

function parseSample(raw: string | undefined): RecentSample | null {
  return raw === "10" ? 10 : raw === "20" ? 20 : raw === "30" ? 30 : null;
}

function parseKind(raw: string | undefined): HistoryKind {
  return raw === "periodic" || raw === "trade" ? raw : "all";
}

function weekStart(raw: string): string | null {
  try {
    return weeklyPeriod(raw).startDate;
  } catch {
    return null;
  }
}

function monthOf(raw: string): string | null {
  try {
    return monthlyPeriod(raw).month;
  } catch {
    return null;
  }
}

/** The page's URL state; invalid values fall back to the defaults and are flagged, never thrown. */
export function parseReviewQuery(tab: ReviewTab, params: SearchParams, now: Date): ReviewQuery {
  const rawAccount = readParam(params, REVIEW_ACCOUNT_PARAM)?.toLowerCase();
  const rawWeek = readParam(params, "week");
  const rawMonth = readParam(params, "month");
  const rawSample = readParam(params, "sample");
  const week = rawWeek === undefined ? null : weekStart(rawWeek);
  const month = rawMonth === undefined ? null : monthOf(rawMonth);
  const sample = parseSample(rawSample);
  const periodRaw = tab === "weekly" ? rawWeek : tab === "monthly" ? rawMonth : tab === "recent" ? rawSample : undefined;
  const periodValue = tab === "weekly" ? week : tab === "monthly" ? month : tab === "recent" ? sample : null;
  return {
    tab,
    reviewAccount: rawAccount !== undefined && UUID.test(rawAccount) ? rawAccount : null,
    reviewAccountInvalid: rawAccount !== undefined && !UUID.test(rawAccount),
    week: week ?? previousCompletedWeek(now).startDate,
    month: month ?? previousCompletedMonth(now).month,
    sample: sample ?? DEFAULT_SAMPLE,
    explicitPeriod: periodRaw !== undefined && periodValue !== null,
    periodInvalid: periodRaw !== undefined && periodValue === null,
    kind: parseKind(readParam(params, "kind")),
    before: decodeHistoryCursor(readParam(params, "before")),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Links.
// ---------------------------------------------------------------------------------------------------------------------

export interface ReviewLinkState {
  /** Only in All Accounts: the account chosen inside the page. */
  reviewAccount?: string | null;
  week?: string;
  month?: string;
  sample?: RecentSample;
  kind?: HistoryKind;
  before?: string | null;
}

/** `/review/<tab>?…` with the given state in a stable order; defaults (`kind=all`) are left out. */
export function reviewHref(tab: ReviewTab, state: ReviewLinkState = {}): string {
  const params = new URLSearchParams();
  if (tab === "weekly" && state.week) params.set("week", state.week);
  if (tab === "recent" && state.sample) params.set("sample", String(state.sample));
  if (tab === "monthly" && state.month) params.set("month", state.month);
  if (tab === "history" && state.kind && state.kind !== "all") params.set("kind", state.kind);
  if (tab === "history" && state.before) params.set("before", state.before);
  if (state.reviewAccount) params.set(REVIEW_ACCOUNT_PARAM, state.reviewAccount);
  const query = params.toString();
  return query ? `${TAB_PATHS[tab]}?${query}` : TAB_PATHS[tab];
}

export interface ReviewTabLink {
  tab: ReviewTab;
  href: string;
  label: string;
  /** Phone wording (TAB_SHORT_LABELS); null when the label fits as it is. */
  shortLabel: string | null;
  current: boolean;
}

/**
 * Route-level tabs. The periodic tabs keep the account chosen inside the page; History always opens on every account
 * of the context (it is the one place that lists analyses across accounts).
 */
export function reviewTabs(current: ReviewTab, reviewAccount: string | null): ReviewTabLink[] {
  return REVIEW_TABS.map(tab => ({
    tab,
    href: reviewHref(tab, { reviewAccount: tab === "history" ? null : reviewAccount }),
    label: TAB_LABELS[tab],
    shortLabel: TAB_SHORT_LABELS[tab] ?? null,
    current: tab === current,
  }));
}

const LEGACY_TARGETS = { weekly: "/review/weekly", recent: "/review/recent", monthly: "/review/monthly" } as const;

/**
 * Target of a legacy `/edge/weekly|recent|monthly` URL (spec §1.2): the same parameters, in the same order, on the
 * Review page. `account` keeps its V1 meaning: the proxy applies it as the account context.
 */
export function legacyReviewHref(kind: keyof typeof LEGACY_TARGETS, params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) query.append(key, item);
  }
  const text = query.toString();
  return text ? `${LEGACY_TARGETS[kind]}?${text}` : LEGACY_TARGETS[kind];
}
