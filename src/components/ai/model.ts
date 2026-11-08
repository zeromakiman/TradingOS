import Decimal from "decimal.js";
import type { AiAssessmentChip, SourceChip, SourceChipKind } from "@/domain/ai-summary";
import { formatMoney } from "@/domain/format";
import { formatDay, formatMonth } from "@/domain/time-display";

/**
 * Presentation models shared by the AI components (docs/V2_ARCHITECTURE.md §11.1, §11.2, §13.9). Pure: no React, no
 * I/O and no server-only imports, so server and client components can both use them. Raw identifiers only ever travel
 * in `technicalId`, which is rendered inside Technical details and nowhere else.
 */

/** Operations a V2 screen can show or request. `REVIEW_TRADE` (V1) is history only. */
export type AiOperationId =
  | "ANALYZE_SETUP" | "CHALLENGE_BIAS" | "REVIEW_TRADE" | "REVIEW_TRADE_TIMELINE" | "WEEKLY_REVIEW" | "RECENT_TRADES_ANALYSIS" | "MONTHLY_REVIEW";

export type AiCardStatus = "COMPLETED" | "FAILED" | "IN_PROGRESS";

export type RiskDecision = "APPROVED" | "BLOCKED" | "UNCHECKED";

/** A Risk Engine line can also say that an approval is no longer current ("Recheck needed", §2.3). */
export type RiskLineDecision = RiskDecision | "RECHECK";

/** A friendly citation chip: a label in trader words, never a raw id. */
export interface SourceChipModel {
  label: string;
  kind: SourceChipKind;
  /**
   * Link target: `/trades/<id>` for a trade, `#evidence-<id>` for a screenshot (the evidence gallery opens its viewer
   * for that hash, see `evidenceHref` in src/components/evidence/gallery-model.ts), `#<TimelineItem.id>` for a
   * timeline record (scrolls to it). Absent for sources without a destination.
   */
  href?: string;
  /** Canonical citation id; shown only inside Technical details. */
  technicalId?: string;
}

export interface AiCardItemModel {
  text: string;
  sources: readonly SourceChipModel[];
}

export interface AiCardSectionModel {
  heading: string;
  /** A deterministic caveat from Trading OS shown under the heading (never AI text), for example a monthly review's change sections. */
  note?: string;
  items: readonly AiCardItemModel[];
}

/** The deterministic Risk Engine status line that leads every pre-trade card (§11.1). */
export interface AiRiskLine {
  decision: RiskLineDecision;
  /** Exact reason, for example "Requested risk 1.00% exceeds your configured maximum of 0.75%." */
  text: string;
}

export type AssessmentTone = "positive-muted" | "warning" | "neutral";

/** An assessment chip of a trade review: `Plan adherence · Aligned`. */
export interface AiAssessmentModel {
  label: string;
  value: string;
  tone: AssessmentTone;
}

/** A deterministic fact computed by Trading OS (never by the AI), for the "From Trading OS" strip. */
export interface AiFactModel {
  label: string;
  value: string;
}

/** Pre-formatted cost estimate of one request: `typical` "€0.02", `max` "€0.06" (the amount reserved). */
export interface AiEstimateModel {
  typical: string;
  max: string;
}

/**
 * Pairs list values with unique React keys derived from their content; repeated natural keys get a counter
 * (`a`, `a#2`), so lists never key by position.
 */
export function withKeys<T>(values: readonly T[], keyOf: (value: T) => string): { key: string; value: T }[] {
  const counts = new Map<string, number>();
  return values.map(value => {
    const natural = keyOf(value);
    const count = (counts.get(natural) ?? 0) + 1;
    counts.set(natural, count);
    return { key: count === 1 ? natural : `${natural}#${count}`, value };
  });
}

/**
 * Value for a `data-*` styling/test hook: `ANALYZE_SETUP` → `analyze-setup`. Keeps backend enum spellings out of the
 * default HTML (spec §0.9, §16.1), attributes included.
 */
export function dataToken(value: string): string {
  return value.toLowerCase().replaceAll("_", "-");
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

export const AI_INTERPRETATION_LABEL = "AI interpretation · advisory";
export const FROM_TRADING_OS_LABEL = "From Trading OS";
export const VIEW_FULL_ANALYSIS = "View full analysis";
export const PERIODIC_LIMITATION = "Live-first and imported trades are not yet included in periodic AI reviews.";
export const NO_PLAN_RECORDED = "No pre-trade plan recorded";
export const PRICING_UNAVAILABLE = "AI pricing requires review before requests can run.";

const RISK_WORDS: Readonly<Record<RiskLineDecision, string>> = Object.freeze({
  APPROVED: "Approved", BLOCKED: "Blocked", UNCHECKED: "Not checked", RECHECK: "Recheck needed",
});

/** `Risk Engine · Blocked — Requested risk exceeds maximum` (the reason is omitted when empty). */
export function riskLineText(line: AiRiskLine): string {
  const reason = line.text.trim();
  return reason ? `Risk Engine · ${RISK_WORDS[line.decision]} — ${reason}` : `Risk Engine · ${RISK_WORDS[line.decision]}`;
}

/**
 * The terminal accounting review of an unconfirmed cost (`ai_uncertainty_resolutions`, docs/AI_ACCOUNTING_RESOLUTION.md):
 * no provider usage (nothing charged, the whole held amount released) or a confirmed cost (the difference released, or
 * recorded on top when the cost was higher). A review that keeps the cost unconfirmed is not one.
 */
export interface AccountingReviewModel {
  decision: "NO_PROVIDER_USAGE_CONFIRMED" | "USAGE_CONFIRMED";
  /** The cost after the review, in micro-euros. */
  reconciledMicros: number;
  /** The part of the held amount the review released. */
  releasedMicros: number;
  /** A confirmed cost above the held amount. */
  additionalMicros: number;
}

/** Accounting fields of a failed request (`AiHistoryTechnical`): whether money was held for it, and how it settled. */
export interface FailureAccounting {
  /** The amount held for the request; null when nothing was held. */
  reservedMicros: number | null;
  /** Stored usage outcome (`SETTLED`, `UNCERTAIN`, `CANCELLED`); null while no usage record exists. */
  disposition: string | null;
  /** Budget month the held amount counts toward (`YYYY-MM-01`, fixed UTC−5); null when unknown. */
  holdPeriod?: string | null;
  /** A held amount without a usage record whose budget month has ended: the monthly reset released it. */
  holdExpired?: boolean;
  /** The review that settled an unconfirmed cost; the stored `UNCERTAIN` record itself never changes. */
  accountingReview?: AccountingReviewModel | null;
}

const MICROS_PER_CENT = 10_000;

/** `€0.06`: a micro-euro amount in whole cents, rounded up like the budget's own figures (a cost is never understated). */
export function centsText(micros: number): string {
  const cents = new Decimal(Math.max(0, Number.isSafeInteger(micros) ? micros : 0)).div(MICROS_PER_CENT).toDecimalPlaces(0, Decimal.ROUND_UP);
  return formatMoney(cents.div(100).toFixed(2), "EUR");
}

/**
 * A budget month (`YYYY-MM-01`) in words and the day it resets (00:00 fixed UTC−5): `{ month: "October 2026", reset:
 * "Nov 1" }`; null when the month is unreadable.
 */
export function budgetMonthWords(period: string | null | undefined): { month: string; reset: string } | null {
  const match = period ? /^(\d{4})-(\d{2})-01$/.exec(period.slice(0, 10)) : null;
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) return null;
  // Date.UTC months are zero-based, so the 1-based month number is already the next month.
  return { month: formatMonth(`${match[1]}-${match[2]}`), reset: formatDay(new Date(Date.UTC(Number(match[1]), month, 1)).toISOString().slice(0, 10)) };
}

function reviewedText(review: AccountingReviewModel): string {
  if (review.decision === "NO_PROVIDER_USAGE_CONFIRMED") {
    return "Reviewed: the AI provider recorded no usage for this attempt, so nothing was charged and the held amount was released.";
  }
  const cost = centsText(review.reconciledMicros);
  // No separately rounded difference: whole cents of a sub-cent difference would state an amount that is neither the
  // real difference nor the difference of the amounts shown. The exact figures stay in Technical details.
  if (review.additionalMicros > 0) return `Reviewed: the confirmed cost of ${cost} is recorded. It was more than the amount held for this attempt, and all of it counts toward the AI budget.`;
  if (review.releasedMicros > 0) return `Reviewed: the confirmed cost of ${cost} is recorded, and the rest of the held amount was released.`;
  return `Reviewed: the confirmed cost of ${cost} is recorded.`;
}

/**
 * What a failed request cost, in plain words (§11.1, §15): the stored accounting values stay in Technical details. It
 * follows what the budget applies (private.ai_budget_snapshot, 0014): an accounting review settles an unconfirmed cost,
 * and a held amount without a usage record counts toward its own month's budget only. Nothing reviews such a hold (the
 * operator procedure resolves unconfirmed usage records only), so the monthly reset is what releases it.
 */
export function failureAccountingText({ reservedMicros, disposition, holdPeriod, holdExpired, accountingReview }: FailureAccounting): string {
  if (reservedMicros === null) return "Nothing was charged for this attempt.";
  switch (disposition) {
    case "SETTLED":
      return "The cost is recorded; unused funds were released.";
    case "UNCERTAIN":
      return accountingReview ? reviewedText(accountingReview) : "The amount held for this attempt stays until an accounting review confirms the cost or releases it; nothing beyond it was charged.";
    case "CANCELLED":
      return "Nothing was charged; the held amount was released.";
    case null: {
      const words = budgetMonthWords(holdPeriod);
      if (holdExpired) {
        return words
          ? `The amount held for this attempt counted toward the AI budget of ${words.month} only and was released when it reset on ${words.reset}; nothing beyond it was charged.`
          : "The amount held for this attempt was released when the monthly AI budget reset; nothing beyond it was charged.";
      }
      return words
        ? `The amount held for this attempt counts toward the AI budget of ${words.month} until it resets on ${words.reset}; nothing beyond it was charged.`
        : "The amount held for this attempt counts toward its month's AI budget until that budget resets; nothing beyond it was charged.";
    }
    default:
      return "The cost of this attempt is not settled yet; the held amount still counts toward this month's budget.";
  }
}

/** Settings → AI: it lists every trading account, archived ones included, without selecting any. */
export const AI_SETTINGS_PATH = "/settings#ai";

/**
 * Link to an account's AI settings; `?account=` selects that account explicitly (spec §9.2). An archived account can
 * never be the context, so its link opens Settings → AI without selecting an account: the page lists archived accounts
 * there, read-only until they are restored. (A fix route for an archived account opens Manage account instead, where
 * Restore lives: `AiSettingsLink`.)
 */
export function aiSettingsHref(accountId: string, archived = false): string {
  return archived ? AI_SETTINGS_PATH : `/settings?${new URLSearchParams({ account: accountId })}#ai`;
}

/** `≈ €0.02` */
export function estimateLabel(estimate: AiEstimateModel): string {
  return `≈ ${estimate.typical}`;
}

/** Tooltip of every paid button (§11.2). */
export function estimateTooltip(estimate: AiEstimateModel): string {
  return `Typical cost based on measured runs; at most ${estimate.max} is reserved and unused funds are released.`;
}

// ---------------------------------------------------------------------------------------------
// Source chips
// ---------------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Only in-app paths and in-page anchors are rendered as links; anything else becomes a plain chip. */
export function safeChipHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#") && href.length > 1) return href;
  if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) return href;
  return undefined;
}

/** A label that would expose a raw identifier falls back to the neutral "Source" wording. */
export function chipLabel(label: string): string {
  const text = label.trim();
  return text === "" || UUID.test(text) ? "Source" : text;
}

/**
 * Domain chip (`resolveSourceChip`) → presentation chip. The domain already links screenshots to `#evidence-<id>`
 * (the gallery's viewer hash), timeline records to `#<TimelineItem.id>` and trades to `/trades/<id>`.
 */
export function sourceChipModel(chip: SourceChip): SourceChipModel {
  return chip.href === undefined
    ? { label: chip.label, kind: chip.kind, technicalId: chip.technicalId }
    : { label: chip.label, kind: chip.kind, href: chip.href, technicalId: chip.technicalId };
}

interface ResolvedSection {
  title: string;
  note?: string;
  items: readonly { text: string; sources: readonly SourceChip[] }[];
}

/** Resolved summary sections (`ResolvedAiCard.sections` / `.full`) → card sections; empty sections are dropped. */
export function sectionModels(sections: readonly ResolvedSection[]): AiCardSectionModel[] {
  return sections
    .filter(section => section.items.length > 0)
    .map(section => ({
      heading: section.title,
      ...(section.note === undefined ? {} : { note: section.note }),
      items: section.items.map(item => ({ text: item.text, sources: item.sources.map(sourceChipModel) })),
    }));
}

/** Every distinct citation of the given sections and headline, for the Technical details listing. */
export function citationsOf(sections: readonly AiCardSectionModel[], headline?: AiCardItemModel | null): SourceChipModel[] {
  const seen = new Map<string, SourceChipModel>();
  const items = [...(headline ? [headline] : []), ...sections.flatMap(section => section.items)];
  for (const chip of items.flatMap(item => item.sources)) {
    const key = chip.technicalId ?? `${chip.kind}:${chip.label}`;
    if (!seen.has(key)) seen.set(key, chip);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------------------------

const POSITIVE = new Set(["ALIGNED", "CONSISTENT", "DISCIPLINED"]);
const WARNING = new Set(["DEVIATION", "CHANGED", "REACTIVE"]);

export function assessmentTone(assessment: string): AssessmentTone {
  if (POSITIVE.has(assessment)) return "positive-muted";
  if (WARNING.has(assessment)) return "warning";
  return "neutral";
}

export function assessmentModels(chips: readonly AiAssessmentChip[]): AiAssessmentModel[] {
  return chips.map(chip => ({ label: chip.label, value: chip.assessmentLabel, tone: assessmentTone(chip.assessment) }));
}
