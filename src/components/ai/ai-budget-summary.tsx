import Decimal from "decimal.js";
import type { AiAvailability } from "@/ai/availability";
import type { BudgetSnapshot, budgetPresentation } from "@/ai/budget";
import { AI_OPERATIONS } from "@/ai/operations";
import { type AiCostOperation, estimateAiCost } from "@/domain/ai-summary";
import { formatMoney } from "@/domain/format";
import { formatDateTime, formatDay, formatMonth, STRATEGY_TIME, STRATEGY_ZONE_LABEL, type TimeDisplay } from "@/domain/time-display";
import { StatusPill, type StatusTone } from "../ui/badge";
import { cx } from "../ui/cx";
import { Disclosure } from "../ui/disclosure";
import { PRICING_UNAVAILABLE, withKeys } from "./model";

/**
 * Monthly AI budget of one trading account (docs/V2_ARCHITECTURE.md §11.2):
 * "AI usage this month · €0.74 of €5.00 · €4.26 left · resets Nov 1" plus one status chip
 * (On / Off / Limit reached / Paused — needs review / Unavailable). Held amounts, accounting state, audit log and
 * provider/model live behind "Details". Budgets are per trading account; All Accounts shows one compact row each.
 */

export interface AiBudgetAuditEvent {
  id: number;
  previous_enabled: boolean;
  enabled: boolean;
  previous_budget_cents: number;
  budget_cents: number;
  created_at: string;
}

/** The shape `loadAiBudget(accountId)` (src/lib/ai-budget.ts) returns. */
export interface AiBudgetModel {
  snapshot: BudgetSnapshot | null;
  presentation: ReturnType<typeof budgetPresentation> | null;
  system: Pick<AiAvailability, "status" | "message">;
  events?: readonly AiBudgetAuditEvent[];
  error?: string | null;
}

export type AiBudgetStatus = "On" | "Off" | "Limit reached" | "Paused — needs review" | "Unavailable";

export interface AiBudgetSummaryProps {
  /** Trading account display name (budgets are per account). */
  accountName: string;
  budget: AiBudgetModel;
  /** One row: name, usage and status chip (All Accounts lists). */
  compact?: boolean;
  /** Display for audit times; the reset day is always the fixed UTC−5 budget month. */
  timeDisplay?: TimeDisplay;
  /** Clock that decides whether AI pricing is still valid; defaults to the current time. */
  now?: Date;
  /**
   * Rendered inside Settings → AI, next to the account's AI controls: the copy points to those controls instead of
   * sending the trader to Settings. Every other placement keeps the default.
   */
  inSettings?: boolean;
  className?: string;
}

const MICROS_PER_CENT = 10_000;

function capEuros(cents: number): string {
  return formatMoney(new Decimal(cents).div(100).toFixed(), "EUR");
}

/** The operations V2 screens can request; the chip speaks for these. */
const V2_OPERATIONS = [
  "ANALYZE_SETUP", "CHALLENGE_BIAS", "REVIEW_TRADE_TIMELINE", "WEEKLY_REVIEW", "RECENT_TRADES_ANALYSIS", "MONTHLY_REVIEW",
] as const satisfies readonly AiCostOperation[];

/**
 * The smallest amount any V2 request reserves at `now`, or null when no operation has valid pricing. A request runs
 * only when the remaining budget covers its full reservation, so below this amount nothing can run.
 */
export function smallestRequestMicros(now: Date = new Date()): number | null {
  let smallest: number | null = null;
  for (const operation of V2_OPERATIONS) {
    try {
      const { maxMicros } = estimateAiCost(operation, now);
      if (Number.isSafeInteger(maxMicros) && maxMicros >= 0 && (smallest === null || maxMicros < smallest)) smallest = maxMicros;
    } catch {
      // Expired or unknown pricing: this operation cannot run, so it does not count.
    }
  }
  return smallest;
}

export interface AiBudgetStatusModel {
  label: AiBudgetStatus;
  tone: StatusTone;
  /** Why AI requests cannot run, in words; null while the budget is On. */
  reason: string | null;
}

const LIMIT_REACHED = "This month's budget can't cover another AI request. New requests are blocked until it resets or you raise the limit.";
const UNAVAILABLE = "AI is unavailable right now. Other Trading OS workflows are unaffected.";
/** A held (uncertain) reservation in plain words: what happened, what was charged and what resolves it. */
export const HELD_RESERVATION_REASON =
  "An earlier AI request ended without a confirmed cost, so the amount held for it stays in place. Nothing beyond that amount was charged. AI requests for this account are paused until an accounting review confirms the cost or releases the hold.";
const OFF_REASON = "AI is off for this account. Nothing is sent until you turn it on in Settings → AI.";
const OFF_REASON_IN_SETTINGS = "AI is off for this account. Nothing is sent until you turn it on below.";

/**
 * The one status chip and its reason. Uncertainty wins over everything because it pauses requests until it is
 * resolved. "Limit reached" also covers a remainder too small for the cheapest request, and "Unavailable" expired
 * pricing, so the chip never says On while every AI button is disabled.
 */
export function aiBudgetStatus(budget: AiBudgetModel, now: Date = new Date(), options: { inSettings?: boolean } = {}): AiBudgetStatusModel {
  const { snapshot, presentation } = budget;
  if (!snapshot || !presentation) return { label: "Unavailable", tone: "muted", reason: budget.error ?? UNAVAILABLE };
  if (snapshot.uncertain) return { label: "Paused — needs review", tone: "warning", reason: HELD_RESERVATION_REASON };
  if (!snapshot.enabled) return { label: "Off", tone: "neutral", reason: options.inSettings ? OFF_REASON_IN_SETTINGS : OFF_REASON };
  if (budget.system.status !== "ENABLED") return { label: "Unavailable", tone: "muted", reason: budget.error ?? UNAVAILABLE };
  const smallest = smallestRequestMicros(now);
  if (smallest === null) return { label: "Unavailable", tone: "muted", reason: `${PRICING_UNAVAILABLE} Other Trading OS workflows are unaffected.` };
  const exhausted = snapshot.usedMicros + snapshot.heldMicros >= snapshot.budgetCents * MICROS_PER_CENT;
  if (exhausted || presentation.remainingMicros < smallest) return { label: "Limit reached", tone: "warning", reason: LIMIT_REACHED };
  return { label: "On", tone: "positive", reason: null };
}

function resetDay(snapshot: BudgetSnapshot): string | null {
  try {
    return formatDay(snapshot.resetAt, STRATEGY_TIME);
  } catch {
    return null;
  }
}

/** Whole cents of a micro-euro amount, rounded up (a cost is never understated). */
function centsUp(micros: number): Decimal {
  return new Decimal(Math.max(0, micros)).div(MICROS_PER_CENT).toDecimalPlaces(0, Decimal.ROUND_UP);
}

/**
 * The figures of `€0.14 of €10.00 · €9.86 left` and the held amount of Details, in whole cents, so they always
 * reconcile: used and held round up (never understated), and what is left is the limit minus both (never below
 * zero), so used + held + left equals the limit and what is left is never more than is really available.
 * `remainingMicros` is `budgetPresentation().remainingMicros` (limit − used − held, floored at zero).
 */
export function aiBudgetFigures(snapshot: BudgetSnapshot, remainingMicros: number): { usedCents: Decimal; heldCents: Decimal; leftCents: Decimal } {
  const usedCents = centsUp(snapshot.usedMicros);
  const heldCents = centsUp(snapshot.heldMicros);
  const reconciled = Decimal.max(0, new Decimal(snapshot.budgetCents).minus(usedCents).minus(heldCents));
  // Never more than the exact remainder, whatever the caller passed.
  const leftCents = Decimal.min(reconciled, new Decimal(Math.max(0, remainingMicros)).div(MICROS_PER_CENT).toDecimalPlaces(0, Decimal.ROUND_DOWN));
  return { usedCents, heldCents, leftCents };
}

function centsText(cents: Decimal): string {
  return formatMoney(cents.div(100).toFixed(2), "EUR");
}

/**
 * `€0.14 of €10.00 · €9.86 left`. Amounts held for requests in progress are shown only in Details (§11.2); the
 * remainder already excludes them. Used rounds up and left is the limit minus the rounded used and held amounts, so
 * the figures add up and never overstate what is still available (`aiBudgetFigures`).
 */
export function aiBudgetAmounts(snapshot: BudgetSnapshot, remainingMicros: number): string {
  const { usedCents, leftCents } = aiBudgetFigures(snapshot, remainingMicros);
  return `${centsText(usedCents)} of ${capEuros(snapshot.budgetCents)} · ${centsText(leftCents)} left`;
}

/** "AI usage this month · €0.74 of €5.00 · €4.26 left · resets Nov 1". */
export function aiBudgetUsageText(budget: AiBudgetModel): string {
  if (!budget.snapshot || !budget.presentation) return "AI usage this month is unavailable.";
  const reset = resetDay(budget.snapshot);
  return `AI usage this month · ${aiBudgetAmounts(budget.snapshot, budget.presentation.remainingMicros)}${reset ? ` · resets ${reset}` : ""}`;
}

function providerModels(): string {
  const pairs = new Set(V2_OPERATIONS.filter(id => Object.hasOwn(AI_OPERATIONS, id)).map(id => `${AI_OPERATIONS[id].provider} · ${AI_OPERATIONS[id].model}`));
  return [...pairs].join(", ");
}

function auditLine(event: AiBudgetAuditEvent, display: TimeDisplay): string {
  let at: string;
  try {
    at = formatDateTime(event.created_at, display);
  } catch {
    at = "Earlier";
  }
  const state = event.previous_enabled === event.enabled ? (event.enabled ? "On" : "Off") : `${event.previous_enabled ? "On" : "Off"} → ${event.enabled ? "On" : "Off"}`;
  const limit = event.previous_budget_cents === event.budget_cents ? capEuros(event.budget_cents) : `${capEuros(event.previous_budget_cents)} → ${capEuros(event.budget_cents)}`;
  return `${at} · ${state} · ${limit}`;
}

function monthText(snapshot: BudgetSnapshot): string | null {
  try {
    return formatMonth(snapshot.period.slice(0, 7));
  } catch {
    return null;
  }
}

function BudgetDetails({ budget, display }: { budget: AiBudgetModel; display: TimeDisplay }) {
  const { snapshot, presentation } = budget;
  const events = budget.events ?? [];
  const reset = snapshot ? resetDay(snapshot) : null;
  const month = snapshot ? monthText(snapshot) : null;
  return (
    <Disclosure summary="Details" className="border-0 bg-transparent [&>summary]:px-0 [&>div]:px-0">
      <div className="flex flex-col gap-3 text-[0.8125rem] leading-5">
        {snapshot && presentation && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-2">Reserved for requests in progress</dt>
            <dd className="num">{centsText(aiBudgetFigures(snapshot, presentation.remainingMicros).heldCents)}</dd>
            <dt className="text-2">Committed this month</dt>
            <dd className="num">{presentation.percentage}% of the limit</dd>
            <dt className="text-2">Accounting</dt>
            <dd>{snapshot.uncertain ? "Needs review — the cost of an earlier request could not be confirmed, so the full amount reserved for this request stays held until it is resolved." : "Settled"}</dd>
            {month && (
              <>
                <dt className="text-2">Month</dt>
                <dd>
                  {month}
                  {reset ? ` · resets ${reset}, 00:00 ${STRATEGY_ZONE_LABEL}` : ""}
                </dd>
              </>
            )}
            <dt className="text-2">Provider and model</dt>
            <dd className="break-words">{providerModels()}</dd>
          </dl>
        )}
        <p className="t-caption">
          Amounts are Trading OS estimates of provider usage, not the provider's invoice. Each request reserves its maximum cost first; unused funds are released.
        </p>
        <div className="flex flex-col gap-1">
          <p className="font-semibold">Recent changes</p>
          {events.length ? (
            <ul className="flex flex-col gap-0.5 text-2">
              {withKeys(events.slice(0, 12), event => String(event.id)).map(({ key, value }) => (
                <li key={key}>{auditLine(value, display)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-2">No changes recorded. AI starts off with a €5.00 monthly limit.</p>
          )}
        </div>
      </div>
    </Disclosure>
  );
}

export function AiBudgetSummary({ accountName, budget, compact = false, timeDisplay = STRATEGY_TIME, now, inSettings = false, className }: AiBudgetSummaryProps) {
  const status = aiBudgetStatus(budget, now, { inSettings });
  const chip = (
    <StatusPill tone={status.tone} data-budget-status={status.label}>
      {status.label}
    </StatusPill>
  );
  if (compact) {
    const amounts = budget.snapshot && budget.presentation ? aiBudgetAmounts(budget.snapshot, budget.presentation.remainingMicros) : "Usage unavailable";
    return (
      <p className={cx("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
        <span className="font-medium text-text">{accountName}</span>
        <span className="t-meta num">{amounts}</span>
        {chip}
      </p>
    );
  }
  const percent = budget.presentation ? Math.min(100, Math.max(0, budget.presentation.percentage)) : 0;
  return (
    <section aria-label={`AI budget · ${accountName}`} className={cx("card", className)}>
      <div className="card-body flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-text">{accountName}</p>
          {chip}
        </div>
        <p className="t-meta num">{aiBudgetUsageText(budget)}</p>
        {budget.presentation && (
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
            <div className={cx("h-full rounded-pill", status.tone === "warning" ? "bg-warn" : "bg-accent")} style={{ width: `${percent}%` }} />
          </div>
        )}
        {status.reason && <p className="t-meta">{status.reason}</p>}
        <BudgetDetails budget={budget} display={timeDisplay} />
      </div>
    </section>
  );
}
