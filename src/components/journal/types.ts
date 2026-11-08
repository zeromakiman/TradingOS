import type { StatusTone } from "@/components/ui/badge";

/**
 * View model of the Journal screen (docs/V2_ARCHITECTURE.md §14.5). Built on the server by `buildJournalView`; every
 * string is already worded for the default UI (no ids, enums or raw decimals), and every link is a finished URL, so the
 * client components only render and navigate.
 */

/** A form field carried along unchanged when a filter form is submitted (the other active filters). */
export interface HiddenField {
  name: string;
  value: string;
}

export interface FilterOptionView {
  key: string;
  label: string;
  /** URL with this option applied (or removed, for a selected option of a multi-choice filter). */
  href: string;
  selected: boolean;
}

export interface DateFormView {
  kind: "date";
  from: string;
  to: string;
  /** Today's strategy day: no date input accepts a later day. */
  max: string;
  hidden: HiddenField[];
}

export interface TextFormView {
  kind: "text";
  name: "tag" | "instrument";
  label: string;
  placeholder: string;
  submitLabel: string;
  /** HTML `pattern` mirroring what the server accepts (./patterns.ts). */
  pattern: string;
  /** The accepted format in words, added to the browser's validation message. */
  format: string;
  maxLength: number;
  hidden: HiddenField[];
  /** Quick picks from the trades on this page. */
  suggestionsLabel: string;
  suggestions: FilterOptionView[];
}

export type FilterMenuKey = "date" | "result" | "state" | "origin" | "model" | "session" | "review" | "ai" | "tags" | "instrument";

export interface FilterMenuView {
  key: FilterMenuKey;
  /** Pill text: "Result". */
  label: string;
  /** Active value in words ("Win", "Closed, Reviewed"); null when the filter is off. */
  activeLabel: string | null;
  /** URL without this filter; null when the filter is off. */
  removeHref: string | null;
  multiple: boolean;
  options: FilterOptionView[];
  /** One line under the options explaining what the filter reads. */
  hint: string | null;
  form: DateFormView | TextFormView | null;
}

export interface ChipView {
  key: string;
  label: string;
  removeHref: string;
}

export interface SearchView {
  value: string;
  hidden: HiddenField[];
  /** URL without the search; null without one. */
  clearHref: string | null;
}

export interface SheetChoiceGroup {
  name: string;
  legend: string;
  type: "radio" | "checkbox";
  hint: string | null;
  options: { value: string; label: string; checked: boolean }[];
}

export interface DatePreset {
  key: string;
  label: string;
  from: string;
  to: string;
}

export interface SheetView {
  /** Changes whenever the applied filters change, so the form resets to them. */
  signature: string;
  activeCount: number;
  date: { presets: DatePreset[]; from: string; to: string; max: string };
  groups: SheetChoiceGroup[];
  tags: string;
  instrument: string;
  /** Filters the sheet does not edit (search, drill-down filters), kept when it is applied. */
  hidden: HiddenField[];
}

export interface FiltersView {
  search: SearchView;
  /** Filters always shown as pills: Date, Result, State, Model, Tags, Instrument. */
  menus: FilterMenuView[];
  /** Origin, Session, Review, AI review: under "More filters"; an active one is also shown as its own pill. */
  moreMenus: FilterMenuView[];
  /** Drill-down filters without a menu (closed day, weekday, R range, …). */
  extraChips: ChipView[];
  /** Every active filter as a chip (mobile, where the menus live in the sheet). */
  allChips: ChipView[];
  clearHref: string | null;
  sheet: SheetView;
  activeCount: number;
}

export interface ValueView {
  text: string;
  tone: "pos" | "neg" | "neutral" | "muted";
  /** Screen-reader wording when `text` alone is ambiguous ("—"). */
  srText?: string;
  /** No result yet: the compact card leaves the cell empty instead of showing a dash. */
  pending?: boolean;
}

export interface TradeRowView {
  /** React key (the trade handle); never rendered as text. */
  key: string;
  href: string;
  symbol: string;
  direction: string | null;
  /**
   * "Entered 09:42", "Locked 08:10", "Drafted 07:55", "Recorded 10:02"; "Entered Oct 24, 03:44" when the time display
   * puts the instant on another calendar day than the row's group.
   */
  timeLabel: string;
  /** Shown only in All Accounts. */
  accountName: string | null;
  model: string | null;
  plannedRisk: ValueView;
  realizedR: ValueView;
  pnl: ValueView;
  state: { label: string; tone: StatusTone };
  origin: { label: string; title: string | null };
  /** The first tags, shown as chips; `hiddenTagCount` more are summarized as "+n". */
  tags: string[];
  hiddenTagCount: number;
  /** Every tag, for screen readers ("london, sweep, a-setup"); empty without tags. */
  tagsText: string;
  aiReviewed: boolean;
  thumbnail: { src: string; extra: number } | null;
  evidenceCount: number;
}

export interface TradeGroupView {
  day: string;
  /** "Today", "Yesterday" or null. */
  relative: string | null;
  /** "Fri, Oct 23" (the strategy day). */
  label: string;
  /** "UTC−5" when times show in another zone, so the header says which clock the day belongs to; else null. */
  zone: string | null;
  countLabel: string;
  rows: TradeRowView[];
}

export interface EmptyView {
  kind: "no-accounts" | "no-trades" | "no-matches" | "end-of-list";
  title: string;
  description: string;
  actions: {
    label: string;
    href: string;
    variant: "primary" | "secondary";
    prefetch?: boolean;
    /** Removes filters on this page: navigates in the Journal transition and leaves focus in the search field. */
    clearsFilters?: boolean;
  }[];
}

export interface PaginationView {
  newerHref: string | null;
  olderHref: string | null;
  /** Shown when the way back is longer than the remembered trail. */
  newestHref: string | null;
  summary: string;
}

export interface JournalView {
  contextLabel: string;
  zoneLabel: string;
  dateDefinition: string;
  /** Added to the definition when times show in another zone than the UTC−5 days they are grouped by; else null. */
  dateNote: string | null;
  filters: FiltersView;
  notices: { tone: "warning" | "negative"; text: string }[];
  groups: TradeGroupView[];
  resultSummary: string | null;
  pagination: PaginationView | null;
  empty: EmptyView | null;
}
