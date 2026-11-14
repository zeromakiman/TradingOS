import Decimal from "decimal.js";
import { operationFor } from "@/ai/operations";
import type { RiskLineDecision } from "@/components/ai/model";
import type { EvidenceLabel } from "@/components/evidence/types";
import { defaultLabelForLifecycle, timingHintForLifecycle } from "@/components/trade/journal/composer-model";
import {
  formatAgainst,
  formatMoney,
  formatMoneyExact,
  formatMoneyUp,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatR,
  formatSignedMoney,
  plural,
} from "@/domain/format";
import type { Lifecycle, TradeOrigin } from "@/domain/ledger";
import { type RiskReportV12, riskReportSchemaV12 } from "@/domain/risk-report";
import { strategyClock } from "@/domain/session";
import {
  compareInstants, differsByMoreThan, displayDay, formatDateTime, formatDay, formatDuration, formatTime, type Instant, STRATEGY_TIME, strategyDay, type TimeDisplay,
} from "@/domain/time-display";
import { TIMING_LABELS, type TimelineItem, type Timing } from "@/domain/timeline";
import {
  type BlockingFinding, type BlockingNow, blockingFindingsOf, blockRemedy, reasonWithCount, type TradeAction, type TradeActionKind, type TradeState,
  withBlockingFindings,
} from "@/domain/trade-state";
import type { CheckView, ProposalView, TradeDetail } from "@/lib/trades-data";
import {
  DELETION_COPY, directionLabel, gradeLabel, liquidityLabel, MSS_TIMEFRAMES, modelLabel, NEWS_LABELS, OUTCOME_LABELS, PNL_SOURCE_LABELS, RISK_BASIS_LABELS,
  unitWord,
} from "./copy";

const MSS_VALUES: ReadonlySet<string> = new Set(MSS_TIMEFRAMES);

/** A record is shown with its recording time too when the two differ by more than this (§5.4). */
const RECORDED_GAP_MINUTES = 5;

/**
 * Pure view model of the trade workspace (docs/V2_ARCHITECTURE.md §2.3–2.5, §7.1, §8, §14.4): which sections a trade
 * shows and in which order, the one primary next action and where the others live, the header facts in words, the
 * evidence capture route, the close-form variant and the live-first details still missing. No React and no I/O, so the
 * page and its tests share one source of truth. Only types come from server modules.
 */

const D = Decimal.clone({ precision: 60 });

/**
 * Money at risk at the stop (a plan's nominal risk, a position's initial risk), rounded up to the cent so it is never
 * understated (§6.6, as the plan preview shows it). One rounding wherever the trade page and the lock confirmation
 * state the same amount.
 */
function riskMoney(value: string, currency: string): string {
  return formatMoneyUp(value, currency);
}

/** Room left under a daily cap, rounded down to the cent so it is never overstated (as Today shows it); never negative. */
function roomMoney(value: Decimal, currency: string): string {
  return formatMoneyExact(D.max(value.toDecimalPlaces(2, D.ROUND_FLOOR), 0).toFixed(), currency);
}

// ---------------------------------------------------------------------------------------------------------------------
// Times in the person's display.
// ---------------------------------------------------------------------------------------------------------------------

/** `09:42` today (in the display), `Oct 21, 09:42` on another day, with the year when it differs from now. */
export function whenLabel(instant: Instant, now: Instant, display: TimeDisplay): string {
  const day = displayDay(instant, display);
  const today = displayDay(now, display);
  if (day === today) return formatTime(instant, display);
  return formatDateTime(instant, display, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout (§14.4): main column Plan · Execution · Result · Review, side column Journal + Evidence; phones show one
// column whose order is the DOM order of three blocks (the main column is one block).
// ---------------------------------------------------------------------------------------------------------------------

export type MainSection = "plan" | "execution" | "result" | "review";
export type WorkspaceBlock = "main" | "journal" | "evidence";
/**
 * `review`: tags, lessons and the review status of a closed trade; `reflection`: tags and lessons of a plan that was
 * skipped or cancelled; `tags`: tags of a trade that is still open.
 */
export type ReviewMode = "review" | "reflection" | "tags";

export interface WorkspaceLayout {
  /** Sections of the main column, top to bottom. */
  main: MainSection[];
  /**
   * DOM order of the blocks, which is also the phone order: the journal leads while a position is live; before entry
   * the evidence comes before the journal, after entry the journal comes first. Desktop places the main block in the
   * left column and the other two, in this order, in the right column.
   */
  blocks: readonly [WorkspaceBlock, WorkspaceBlock, WorkspaceBlock];
  review: ReviewMode | null;
  /** The composer docks above the tab bar on phones while the position is open. */
  stickyComposer: boolean;
}

const EXECUTED: ReadonlySet<Lifecycle> = new Set(["LIVE", "CLOSED", "REVIEWED"]);
const ENDED: ReadonlySet<Lifecycle> = new Set(["CLOSED", "REVIEWED"]);

export function reviewMode(lifecycle: Lifecycle): ReviewMode | null {
  if (ENDED.has(lifecycle)) return "review";
  if (lifecycle === "SKIPPED" || lifecycle === "CANCELLED") return "reflection";
  if (lifecycle === "DISCARDED") return null;
  return "tags";
}

export function workspaceLayout(detail: { origin: TradeOrigin; state: Pick<TradeState, "lifecycle"> }): WorkspaceLayout {
  const { lifecycle } = detail.state;
  const review = reviewMode(lifecycle);
  const main: MainSection[] = [];
  // Live-first and imported trades have no plan: the banner says so instead of an empty Plan section.
  if (detail.origin === "PLANNED") main.push("plan");
  if (lifecycle === "LOCKED" || EXECUTED.has(lifecycle)) main.push("execution");
  if (EXECUTED.has(lifecycle)) main.push("result");
  if (review) main.push("review");
  const blocks: WorkspaceLayout["blocks"] = lifecycle === "LIVE"
    ? ["journal", "main", "evidence"]
    : ENDED.has(lifecycle) ? ["main", "journal", "evidence"] : ["main", "evidence", "journal"];
  return { main, blocks, review, stickyComposer: lifecycle === "LIVE" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Header actions (§2.4): one primary next action, a few visible secondary actions, the rest in the overflow menu.
// ---------------------------------------------------------------------------------------------------------------------

export type MenuKind = "EDIT_DRAFT" | "CLOSE_TRADE" | "ADD_ENTRY_DETAILS" | "REOPEN_REVIEW" | "DUPLICATE" | "DISCARD" | "SKIP" | "DELETE" | "TECHNICAL";

export interface MenuEntry {
  kind: MenuKind;
  label: string;
  destructive?: boolean;
  /** Shown as a button from the small breakpoint up, so the menu lists it on phones only. */
  compactOnly?: boolean;
  /** Listed but unavailable, with the reason in words (Delete trade on a locked or live trade). */
  disabledReason?: string;
}

export interface HeaderActionsModel {
  primary: TradeAction | null;
  /** Non-AI secondary actions shown as buttons (from the small breakpoint up; always when there is no primary). */
  secondary: TradeAction[];
  menu: MenuEntry[];
}

/** Secondary actions that get a visible button; Discard and Skip stay in the menu behind a confirmation. */
const VISIBLE_SECONDARY: ReadonlySet<TradeActionKind> = new Set(["EDIT_DRAFT", "CLOSE_TRADE", "ADD_ENTRY_DETAILS", "REOPEN_REVIEW"]);

/**
 * The state's next action (`deriveTradeState`, the same one Today, the Journal and the command palette read: "Recheck
 * risk" for a draft blocked on an earlier trading day) and its visible secondary actions. Paid AI actions never sit in
 * the header: they live with their estimate in the Plan (pre-trade tools) and Review (trade review) sections, which
 * load their own availability.
 */
export function headerActions(state: TradeState, options: { trashed?: boolean } = {}): HeaderActionsModel {
  // A trade in Deleted trades is read-only until it is restored: its page offers Restore and Delete permanently instead.
  if (options.trashed) return { primary: null, secondary: [], menu: [{ kind: "TECHNICAL", label: "Technical details" }] };
  const next = state.nextAction;
  const primary = next && !next.aiOperation ? next : null;
  const secondary = state.secondaryActions.filter(action => !action.aiOperation && VISIBLE_SECONDARY.has(action.kind));
  const menu: MenuEntry[] = primary === null ? [] : secondary.map(action => ({ kind: action.kind as MenuKind, label: action.label, compactOnly: true }));
  if (state.canDuplicate) menu.push({ kind: "DUPLICATE", label: "Duplicate draft" });
  if (state.lifecycle === "DRAFT") menu.push({ kind: "DISCARD", label: "Discard draft", destructive: true });
  if (state.lifecycle === "LOCKED") menu.push({ kind: "SKIP", label: "Skip this trade" });
  menu.push(state.lifecycle === "LOCKED" || state.lifecycle === "LIVE"
    ? { kind: "DELETE", label: "Delete trade", destructive: true, disabledReason: DELETION_COPY.trashOpenReason }
    : { kind: "DELETE", label: "Delete trade", destructive: true });
  menu.push({ kind: "TECHNICAL", label: "Technical details" });
  return { primary, secondary, menu };
}

// ---------------------------------------------------------------------------------------------------------------------
// Header facts.
// ---------------------------------------------------------------------------------------------------------------------

export interface NextStepHint {
  tone: "neutral" | "danger" | "warning" | "positive";
  text: string;
}

/** When the draft's latest check ran (null without one). */
function latestCheckAt(detail: Pick<TradeDetail, "draft" | "technical">): string | null {
  return detail.draft?.latestCheck?.recordedAt ?? detail.technical.ledger.latest_check_at;
}

/**
 * What the page knows now about a draft's blocking reasons beyond its stored check: whether the account's latest values
 * are from today's trading day (`LockSummary.valuesDay`, read with the account's workspace), which clears a stale-values
 * reason at the next check.
 */
export function blockingNow(lock: Pick<LockSummary, "valuesDay"> | null | undefined, now: Instant): BlockingNow {
  const day = lock?.valuesDay ?? null;
  return day !== null && day === strategyDay(now) ? { valuesConfirmedToday: true } : {};
}

/**
 * The trade's state as its header leads with it: a draft blocked today only by reasons no edit of the draft can clear
 * (Dead Pool, a used-up daily limit, today's account values) leads with the step that clears them, Edit draft one click
 * away (`withBlockingFindings`, the rule Today applies to its blocked plans too). Every other state is the trade's own.
 */
export function pageState(detail: Pick<TradeDetail, "state" | "draft" | "technical" | "account">, current: BlockingNow = {}): TradeState {
  const block = blockingCheckOf(detail, current);
  return block ? withBlockingFindings(detail.state, block.findings) : detail.state;
}

/**
 * A draft blocked by a check from an earlier trading day (strategy day, UTC−5), as the trade's state decided it
 * (`deriveTradeState` then leads with "Recheck risk"). Daily limits and sessions have reset since, so the stored
 * reasons may no longer apply: the free recheck is the next step, as it is for an approval that is no longer current.
 */
export function blockedOnEarlierDay(detail: Pick<TradeDetail, "state">): boolean {
  const { state } = detail;
  return state.lifecycle === "DRAFT" && state.draftCheck === "BLOCKED" && state.nextAction?.kind === "RECHECK_RISK";
}

/**
 * The exact first blocking reason of a blocked draft, with how many more the check found (§2.4, §10); without the check
 * on the page, the reason Edit draft carries.
 */
function firstBlockingReason(detail: Pick<TradeDetail, "state" | "draft">): string | undefined {
  const counted = reasonWithCount(detail.draft?.latestCheck?.explained.blocking ?? []);
  if (counted !== undefined) return counted;
  const { state } = detail;
  const edit = state.nextAction?.kind === "EDIT_DRAFT" ? state.nextAction : state.secondaryActions.find(action => action.kind === "EDIT_DRAFT");
  return edit?.detail;
}

/**
 * A draft of an archived account (§3.2, §9): the account takes no new activity, so the draft can't be edited, checked or
 * locked until the account is restored (the database refuses with ACCOUNT_ARCHIVED); it can still be discarded.
 */
export const ARCHIVED_DRAFT_HINT = "This trading account is archived, so this draft can't be edited, checked or locked. Restore the account in Manage account to continue it.";

/**
 * One sentence under the title that says why the primary action is the next step (`current`: what the page knows now
 * about a blocked draft's reasons, `blockingNow`).
 */
export function nextStepHint(detail: TradeDetail, now: Instant, display: TimeDisplay, current: BlockingNow = {}): NextStepHint | null {
  const { state } = detail;
  const when = (instant: Instant) => whenLabel(instant, now, display);
  switch (state.lifecycle) {
    case "DRAFT": {
      if (detail.account.status === "ARCHIVED") return { tone: "warning", text: ARCHIVED_DRAFT_HINT };
      const check = detail.draft?.latestCheck ?? null;
      if (state.draftCheck === "BLOCKED") {
        const reason = firstBlockingReason(detail);
        const checkedAt = latestCheckAt(detail);
        if (checkedAt !== null && blockedOnEarlierDay(detail)) {
          // The stored sentences speak of "today" as the day of the check; the time in front says which day that was.
          return {
            tone: "warning",
            text: `Blocked when checked ${when(checkedAt)}${reason ? `: ${reason}` : "."} Today's limits and session can differ, so recheck risk before you edit the draft.`,
          };
        }
        // Nothing an edit can clear: say what does, since the header then leads with that step instead of Edit draft.
        const outlook = blockOutlook(blockingCheckOf(detail, current), now);
        if (outlook?.wait && !outlook.editable) return { tone: "danger", text: `Blocked${reason ? `: ${reason}` : "."} ${outlook.wait}` };
        return { tone: "danger", text: reason ? `Blocked: ${reason}` : "Blocked. Edit the draft to resolve the reasons in the plan." };
      }
      if (state.draftCheck === "APPROVED" && state.checkCurrent) {
        return { tone: "positive", text: `The free risk check approved revision ${detail.draft?.revision ?? 1}${check ? ` at ${when(check.recordedAt)}` : ""}. Lock the plan before you enter.` };
      }
      if (state.draftCheck === "APPROVED") {
        return { tone: "warning", text: `The approval${check ? ` from ${when(check.recordedAt)}` : ""} is no longer current. Recheck risk before locking.` };
      }
      return { tone: "neutral", text: "Run the free risk check, then lock the plan before you enter." };
    }
    case "LOCKED":
      return { tone: "neutral", text: "Record the entry when you take the trade, or skip it with a reason." };
    case "LIVE":
      return {
        tone: "neutral",
        text: state.editable.entry === "complete"
          ? "Journal decisions as they happen. Some entry details are still missing: add them before you close."
          : "Journal stop and target changes, partials and decisions as they happen.",
      };
    case "CLOSED":
      return { tone: "neutral", text: "Tag the setup, write a lesson and mark the trade reviewed while it is fresh." };
    case "REVIEWED":
      // Tags and lessons stay editable on a reviewed trade (§2.5); reopening only marks the review pending again.
      return detail.review.completedAt
        ? { tone: "neutral", text: `Reviewed ${when(detail.review.completedAt)}. Tags and lessons stay editable; reopen the review to mark it pending again.` }
        : null;
    default:
      return null;
  }
}

export interface HeaderFact {
  text: string;
  /** Live position: the fact is followed by "· live 2h 15m" since this instant, kept current in the browser. */
  liveSince?: string;
}

/** Facts after the account chip: the model, then the times that matter in this state. */
export function headerFacts(detail: TradeDetail, now: Instant, display: TimeDisplay): HeaderFact[] {
  const ledger = detail.technical.ledger;
  const when = (instant: Instant) => whenLabel(instant, now, display);
  const facts: HeaderFact[] = [];
  const model = modelLabel(detail.model);
  if (model) facts.push({ text: model });
  switch (detail.state.lifecycle) {
    case "DRAFT":
      if (detail.draft) facts.push({ text: `Revision ${detail.draft.revision} · saved ${when(detail.draft.createdAt)}` });
      break;
    case "DISCARDED":
      facts.push({ text: `Drafted ${when(detail.createdAt)}` });
      break;
    case "LOCKED":
    case "SKIPPED":
    case "CANCELLED":
      facts.push({ text: ledger.locked_at ? `Locked ${when(ledger.locked_at)}` : `Drafted ${when(detail.createdAt)}` });
      break;
    case "LIVE":
      if (ledger.entered_at) facts.push({ text: `Entered ${when(ledger.entered_at)}`, liveSince: ledger.entered_at });
      else facts.push({ text: `Recorded ${when(detail.createdAt)} · entry time not recorded` });
      break;
    case "CLOSED":
    case "REVIEWED": {
      const enteredAt = ledger.entered_at;
      const exitedAt = ledger.exited_at;
      if (enteredAt) facts.push({ text: `Entered ${when(enteredAt)}` });
      if (exitedAt) facts.push({ text: enteredAt ? `Closed ${when(exitedAt)} · held ${formatDuration(enteredAt, exitedAt)}` : `Closed ${when(exitedAt)}` });
      break;
    }
  }
  return facts;
}

export interface ResultSummary {
  /** `+3.08R`, or null when no risk basis exists. */
  r: string | null;
  /** `+$1,667.38`. */
  money: string | null;
  /** Win · Loss · Breakeven. */
  outcome: string | null;
  tone: "positive" | "negative" | "neutral";
}

/** The realized result of a closed trade for the header; null while the trade is open. */
export function resultSummary(detail: TradeDetail): ResultSummary | null {
  const close = detail.close;
  if (!close) return null;
  const sign = close.netPnl !== null ? new D(close.netPnl) : close.realizedR !== null ? new D(close.realizedR) : null;
  return {
    r: close.realizedR !== null ? formatR(close.realizedR) : null,
    money: close.netPnl !== null ? formatSignedMoney(close.netPnl, detail.account.currency) : null,
    outcome: close.outcome ? OUTCOME_LABELS[close.outcome] : null,
    tone: sign === null || sign.isZero() ? "neutral" : sign.gt(0) ? "positive" : "negative",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Evidence: AI selection and where page-level paste and drops go.
// ---------------------------------------------------------------------------------------------------------------------

export interface EvidenceMode {
  /** Checkbox overlay "use for AI" on gallery tiles (an AI tool that sends screenshots is offered). */
  selectable: boolean;
  /** Per-operation maximum of the offered tool (3 for pre-trade tools, 4 for a trade review). */
  max: number;
  /**
   * Ctrl/⌘+V and file drops anywhere on the page: while the trade has no position (a draft, a locked plan, or a plan
   * that ended without one) they stage screenshots in Evidence (label, timeframe, caption); once a position exists they
   * go to the journal composer, next to the note they illustrate.
   */
  pasteTo: "evidence" | "journal";
  /** Band new records most likely land in (the composer's hint). The server decides the real timing. */
  timingHint: Timing;
  /**
   * Label of new screenshots (Evidence stager and journal composer): Pre-entry before entry, Management while live, Exit
   * after a close, and Other once a plan ended without an entry (what is pasted then shows what happened later, never
   * pre-entry evidence; §5.3).
   */
  defaultLabel: EvidenceLabel;
  /** Active screenshots the trade can still take (24 at most). */
  remaining: number;
}

export function evidenceMode(detail: TradeDetail): EvidenceMode {
  const { lifecycle } = detail.state;
  // Pre-trade AI serves a plan that can still be locked: never on a draft of an archived account (§3.2, §9).
  const preTrade = lifecycle === "DRAFT" && detail.origin === "PLANNED" && detail.account.status !== "ARCHIVED";
  const review = ENDED.has(lifecycle);
  const max = preTrade
    ? Math.min(operationFor("ANALYZE_SETUP").maxImages, operationFor("CHALLENGE_BIAS").maxImages)
    : review ? operationFor("REVIEW_TRADE_TIMELINE").maxImages : 0;
  return {
    selectable: detail.ai.available && (preTrade || review) && max > 0,
    max,
    pasteTo: EXECUTED.has(lifecycle) ? "journal" : "evidence",
    // A skipped, cancelled or discarded plan never had an entry, yet whatever is recorded on it now is hindsight: the
    // database stores it post-trade (§5.2), so it lands After close.
    timingHint: timingHintForLifecycle(lifecycle),
    defaultLabel: defaultLabelForLifecycle(lifecycle),
    remaining: Math.max(0, detail.evidence.limit - detail.evidence.activeCount),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans that ended without an entry (§5.3): what is recorded after the skip, the cancellation or the discard is
// hindsight. The database stores such records post-trade and the trade detail classifies older rows by the end time
// (`planEndedAt`, "Recorded after the plan ended"), so the workspace only words it.
// ---------------------------------------------------------------------------------------------------------------------

const END_WORDS: Readonly<Record<"SKIPPED" | "CANCELLED" | "DISCARDED", { event: string }>> = {
  SKIPPED: { event: "after the skip" },
  CANCELLED: { event: "after the cancellation" },
  DISCARDED: { event: "after the discard" },
};

function endWords(lifecycle: Lifecycle): { event: string } | null {
  return lifecycle === "SKIPPED" || lifecycle === "CANCELLED" || lifecycle === "DISCARDED" ? END_WORDS[lifecycle] : null;
}

/** Where new journal entries land, for the Journal section's meta line: a band, or after the plan ended. */
export function newEntriesLabel(detail: Pick<TradeDetail, "state">, mode: Pick<EvidenceMode, "timingHint">): string {
  return endWords(detail.state.lifecycle)?.event ?? TIMING_LABELS[mode.timingHint];
}

/** A lesson's timing in words: after the skip or cancellation on a plan that ended, the band otherwise. */
export function lessonTiming(lesson: Pick<TimelineItem, "timing">, lifecycle: Lifecycle): string {
  const words = endWords(lifecycle);
  if (words && lesson.timing === "AFTER_CLOSE") return words.event.charAt(0).toUpperCase() + words.event.slice(1);
  return TIMING_LABELS[lesson.timing];
}

/**
 * What duplicating copies (§3.4, §7.4), as the confirmation's bullet points. The copy takes exactly the screenshots the
 * trade shows Before entry; anything added after a plan ended is After close and stays here (`private.copyable_evidence`).
 */
export function duplicateNotes(detail: TradeDetail): string[] {
  const notes = [
    "Economic news is reset to “Not checked”: verify it again for the new trade.",
    "Screenshots recorded before entry are copied; live and after-close screenshots are not.",
  ];
  const words = endWords(detail.state.lifecycle);
  const later = detail.evidence.items.filter(item => item.removedAt === null && item.timing === "AFTER_CLOSE").length;
  if (words && later > 0) {
    notes.push(`${later === 1 ? "1 screenshot" : `${later} screenshots`} added ${words.event} ${later === 1 ? "stays" : "stay"} with this trade.`);
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pre-trade AI panel inputs.
// ---------------------------------------------------------------------------------------------------------------------

export function aiRiskDecision(detail: TradeDetail): RiskLineDecision {
  const { draftCheck, checkCurrent } = detail.state;
  if (draftCheck === "BLOCKED") return "BLOCKED";
  if (draftCheck === "APPROVED") return checkCurrent ? "APPROVED" : "RECHECK";
  return "UNCHECKED";
}

/** The exact first reason of a blocked check (spec §6.5); empty otherwise, so the line reads "Risk Engine · Approved". */
export function aiRiskLine(detail: TradeDetail): string {
  if (detail.state.draftCheck !== "BLOCKED") return "";
  return detail.draft?.latestCheck?.explained.blocking[0]?.detail ?? "";
}

// ---------------------------------------------------------------------------------------------------------------------
// Draft workflow.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The blocking check behind a blocked draft: when it ran, its reasons, and what its report 1.2 says about them (the room
 * left under each daily cap, the equity it sized with, what the smallest position risks at the checked stop), to say
 * what can resolve them (§6.3). An older report leaves the amounts unknown (null): an edit is then taken to help.
 */
export interface BlockingCheck {
  checkedAt: Instant;
  codes: readonly string[];
  /** One per blocking reason, in engine order. */
  findings: readonly BlockingFinding[];
  /** Equity the check sized with. */
  equity: string | null;
  /** The configured maximum risk per trade the check applied. */
  maxRiskPercent: string | null;
  /** What the minimum size risks at the checked stop: no lower risk fits a room below it. */
  minimumRisk: string | null;
  currency: string;
}

/** A stored report 1.2 (Technical details keep each check's), or null for an older or unreadable one. */
function report12(report: unknown): RiskReportV12 | null {
  const parsed = riskReportSchemaV12.safeParse(report);
  return parsed.success ? parsed.data : null;
}

/** The stored report of the draft's latest check (the one `draft.latestCheck` explains). */
function latestCheckReport(detail: Pick<TradeDetail, "technical">): RiskReportV12 | null {
  const id = detail.technical.latestCheckEvaluationId;
  const row = id === null ? undefined : detail.technical.checks.find(check => check.evaluationId === id);
  return row ? report12(row.report) : null;
}

/** The blocking check of a blocked draft, with what is known now about its reasons (`current`, `blockingNow`). */
export function blockingCheckOf(detail: Pick<TradeDetail, "draft" | "technical" | "account">, current: BlockingNow = {}): BlockingCheck | null {
  const check = detail.draft?.latestCheck;
  if (check?.decision !== "BLOCKED") return null;
  const report = latestCheckReport(detail);
  const codes = check.explained.blocking.map(issue => issue.code);
  const stopTicks = report?.calculations?.stopTicks ?? null;
  return {
    checkedAt: check.recordedAt,
    codes,
    findings: blockingFindingsOf(codes, report, current),
    equity: report?.snapshot.equity ?? null,
    maxRiskPercent: report?.limits.maxRiskPercent ?? null,
    // The engine's nominal risk is size × stop ticks × tick value (§6.7).
    minimumRisk: report && stopTicks !== null ? new D(report.instrument.minimumQuantity).times(stopTicks).times(report.instrument.tickValue).toFixed() : null,
    currency: detail.account.currency,
  };
}

/**
 * The largest risk per trade that fits `room` under a daily cap: its budget (equity × risk, truncated to the cent, as the
 * engine sizes it) never exceeds the room, so the position it sizes never does either, and it still sizes the minimum
 * position at this stop. Never above the configured maximum; rounded down, from 2 up to 8 decimals until it fits; null
 * when nothing does.
 */
function riskThatFits(room: Decimal, block: Pick<BlockingCheck, "equity" | "maxRiskPercent" | "minimumRisk">): string | null {
  if (block.equity === null) return null;
  const equity = new D(block.equity);
  if (room.lte(0) || equity.lte(0)) return null;
  let top = room.times(100).div(equity);
  if (block.maxRiskPercent !== null && top.gt(block.maxRiskPercent)) top = new D(block.maxRiskPercent);
  for (let decimals = 2; decimals <= 8; decimals++) {
    const percent = top.toDecimalPlaces(decimals, D.ROUND_DOWN);
    if (percent.lte(0)) continue;
    const budget = equity.times(percent).times("0.01").toDecimalPlaces(2, D.ROUND_DOWN);
    if (block.minimumRisk === null || budget.gte(block.minimumRisk)) return formatPercent(percent.toFixed());
  }
  return null;
}

/** What clears a block from today, in words. */
interface BlockOutlook {
  /** Some reason can be cleared by editing the draft. */
  editable: boolean;
  /** The step for the reasons no edit can clear (one sentence), or null when an edit can clear every reason. */
  wait: string | null;
  /**
   * Every reason no edit can clear has already lapsed since the check (Dead Pool has ended, today's account values were
   * confirmed): the recheck alone clears them now.
   */
  lapsed: boolean;
  /** How an edit clears the reasons that need more than their own sentence: the risk that fits a daily cap, the fields a duplicate must change. */
  hints: string[];
}

/** A daily limit that is used up for today, in words. */
const USED_UP: Readonly<Record<string, string>> = { MAX_TRADES: "the daily trade limit", DAILY_RISK_LIMIT: "the daily risk cap", DAILY_LOSS_LIMIT: "the daily loss limit" };

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Whether a reason no edit can clear has lapsed by `now`: Dead Pool is over, or today's values were confirmed since. */
function lapsedBy(finding: BlockingFinding, now: Instant): boolean {
  const remedy = blockRemedy(finding);
  return remedy === "RECHECK" || (remedy === "SESSION" && strategyClock(now).session !== "DEAD_POOL");
}

/**
 * The step for the reasons no edit can clear, as one sentence (null when every reason is edit-clearable): the next
 * trading day once a daily limit is used up; else confirming today's account values, and the recheck once Dead Pool ends
 * (strategy time, as the Dead Pool sentence states it; any check during Dead Pool blocks, whatever this one found) or an
 * open position closes; the recheck now once what blocked has lapsed (Dead Pool has ended, today's values were
 * confirmed after the check).
 */
function waitWords(findings: readonly BlockingFinding[], now: Instant): string | null {
  const waiting = findings.filter(finding => blockRemedy(finding) !== "EDIT");
  if (waiting.length === 0) return null;
  const remedies = new Set(waiting.map(blockRemedy));
  const usedUp = [...new Set(waiting.filter(finding => blockRemedy(finding) === "DAY").map(finding => USED_UP[finding.code] ?? "a daily limit"))];
  if (usedUp.length > 0) return `${capitalized(listInWords(usedUp))} ${usedUp.length > 1 ? "are" : "is"} used up for today: recheck risk on the next trading day.`;
  const deadPool = strategyClock(now).session === "DEAD_POOL";
  const conditions = [deadPool ? "Dead Pool ends at 18:00 UTC−5" : null, remedies.has("OPEN_RISK") ? "an open position closes" : null]
    .filter((part): part is string => part !== null);
  const recheck = conditions.length === 0
    ? "recheck risk"
    : `recheck risk once ${conditions.join(" and ")}${remedies.has("OPEN_RISK") ? ", or on the next trading day" : ""}`;
  if (remedies.has("ACCOUNT_VALUES")) return `Confirm today's account values, then ${recheck}.`;
  if (remedies.has("OPEN_RISK")) return `Today's losses and open risk fill your daily loss limit: ${recheck}.`;
  // What changed since the check, so the recheck can approve.
  const changed = [
    remedies.has("SESSION") && !deadPool ? "Dead Pool has ended" : null,
    remedies.has("RECHECK") ? "today's account values have been confirmed since the check" : null,
  ].filter((part): part is string => part !== null);
  if (deadPool) return changed.length > 0 ? `${capitalized(listInWords(changed))}: ${recheck}.` : `${capitalized(recheck)}.`;
  return `${capitalized(listInWords(changed))}: recheck risk now.`;
}

/** How an edit clears a daily cap that still has room (a lower risk) and a duplicate (different values). */
function editHints(block: BlockingCheck): string[] {
  const hints: string[] = [];
  // The tighter of the two caps decides how low the risk must go.
  const tightest = block.findings
    .filter(finding => (finding.code === "DAILY_RISK_LIMIT" || finding.code === "DAILY_LOSS_LIMIT") && finding.room != null && blockRemedy(finding) === "EDIT")
    .map(finding => ({ code: finding.code, room: new D(finding.room as string) }))
    .sort((a, b) => a.room.comparedTo(b.room))[0];
  if (tightest) {
    const room = roomMoney(tightest.room, block.currency);
    const riskCap = tightest.code === "DAILY_RISK_LIMIT";
    const fits = riskThatFits(tightest.room, block);
    if (fits) hints.push(`A risk of ${fits} or less fits the ${riskCap ? `${room} of daily risk left` : `${room} left under your daily loss limit`}.`);
    else if (block.minimumRisk !== null && tightest.room.lt(block.minimumRisk)) {
      const left = riskCap ? `${room} of daily risk is left` : `${room} is left under your daily loss limit`;
      hints.push(`Only ${left}: even the minimum size risks ${riskMoney(block.minimumRisk, block.currency)} at this stop.`);
    }
  }
  if (block.codes.includes("DUPLICATE")) hints.push("Change the instrument, direction, model, entry, stop or target so it differs from the plan already locked today.");
  return hints;
}

/** What resolves a blocked check from today; null without a blocking check. */
function blockOutlook(block: BlockingCheck | null, now: Instant): BlockOutlook | null {
  if (!block || block.findings.length === 0) return null;
  const waiting = block.findings.filter(finding => blockRemedy(finding) !== "EDIT");
  return {
    editable: waiting.length < block.findings.length,
    wait: waitWords(block.findings, now),
    lapsed: waiting.length > 0 && waiting.every(finding => lapsedBy(finding, now)),
    hints: editHints(block),
  };
}

/**
 * Why Lock plan can't run yet, in words; null when the latest check approves the latest revision and is current. A
 * block from an earlier trading day is resolved by a recheck first. Of a block from today it says what an edit clears
 * (with the largest risk that fits a daily cap's room, or what a duplicate must change) and what only the end of Dead
 * Pool, the next trading day, a closed position or today's confirmed account values clear (§6.3): "won't clear" only
 * when no reason depends on the draft and one still applies (reasons that have lapsed since the check need only the
 * recheck).
 */
export function lockBlockedReason(state: Pick<TradeState, "draftCheck" | "checkCurrent">, block: BlockingCheck | null = null, now: Instant | null = null): string | null {
  switch (state.draftCheck) {
    case "APPROVED":
      return state.checkCurrent ? null : "Recheck risk first: the last approval is no longer current.";
    case "BLOCKED": {
      const opens = "Locking opens once a check approves this revision.";
      if (block && now !== null && strategyDay(block.checkedAt) !== strategyDay(now)) {
        return `${opens} This check is from ${tradingDayWords(strategyDay(block.checkedAt), now)}; today's limits and session can differ, so recheck risk before you edit the draft.`;
      }
      const outlook = now === null ? null : blockOutlook(block, now);
      const several = (block?.findings.length ?? 0) > 1;
      if (outlook && !outlook.editable && outlook.wait) {
        return outlook.lapsed ? `${opens} ${outlook.wait}` : `${opens} Editing the draft won't clear ${several ? "these reasons" : "this reason"}. ${outlook.wait}`;
      }
      // Some reasons wait for the session, the day, a closed position or the account values: the wait says when to recheck.
      const edits = outlook?.wait
        ? `Edit the draft for the ${(block?.findings.filter(finding => blockRemedy(finding) === "EDIT").length ?? 0) > 1 ? "reasons" : "reason"} an edit clears.`
        : `Edit the draft to resolve ${block && !several ? "the reason" : "the reasons"} above, then check again.`;
      return [`${opens} ${edits}`, ...(outlook?.hints ?? []), outlook?.wait ?? ""].filter(Boolean).join(" ");
    }
    default:
      return "Run the free risk check first: locking needs an approval of this revision.";
  }
}

/**
 * The skip confirmation's note on the daily trade limit: a locked plan keeps the trade slot of the trading day it was
 * locked on (§6.2), which is today only for a plan locked today.
 */
export function skipSlotNote(detail: Pick<TradeDetail, "plan" | "technical">, now: Instant): string {
  const ledger = detail.technical.ledger;
  const day = detail.plan?.tradingDay ?? ledger.plan_trading_day ?? (ledger.locked_at ? strategyDay(ledger.locked_at) : null);
  if (day === null) return "It still counts as one of the planned trades of the day it was locked.";
  if (day === strategyDay(now)) return "It still counts as one of today's planned trades.";
  return `It still counts as one of ${tradingDayWords(day, now)}'s planned trades.`;
}

/** `Oct 23` for a strategy day (`YYYY-MM-DD`), with the year when it isn't the current one. */
function tradingDayWords(day: string, now: Instant): string {
  return formatDay(day, STRATEGY_TIME, { year: day.slice(0, 4) !== strategyDay(now).slice(0, 4) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Live-first entry details and the close-form variant (§3.5, §8.2).
// ---------------------------------------------------------------------------------------------------------------------

export type EntryField = "instrumentId" | "entryModel" | "entryPrice" | "enteredAt" | "quantity" | "initialStop" | "riskAmount";

/** Details a live-first or imported position can still record once each; empty for planned trades. */
export function missingEntryFields(detail: TradeDetail): EntryField[] {
  if (detail.origin === "PLANNED") return [];
  const ledger = detail.technical.ledger;
  const missing: EntryField[] = [];
  if (ledger.instrument_version_id === null) missing.push("instrumentId");
  if (ledger.entry_model === null) missing.push("entryModel");
  if (ledger.entry_price === null) missing.push("entryPrice");
  if (ledger.entered_at === null) missing.push("enteredAt");
  if (ledger.quantity === null) missing.push("quantity");
  if (ledger.initial_stop === null) missing.push("initialStop");
  if (ledger.initial_risk === null) missing.push("riskAmount");
  return missing;
}

export type CloseMode =
  /** Planned trade: FULL_CLOSE_V1, R = net P&L ÷ locked risk. */
  | { kind: "planned" }
  /** Live-first with contract, entry and size: P&L is calculated from the exit price. */
  | { kind: "calculated" }
  /** Live-first without enough facts: the trader reports net P&L; `missing` names what is not recorded. */
  | { kind: "reported"; missing: string[] };

export function closeMode(detail: TradeDetail): CloseMode {
  if (detail.origin === "PLANNED") return { kind: "planned" };
  const ledger = detail.technical.ledger;
  const missing = [
    ledger.instrument_version_id === null ? "the instrument contract" : null,
    ledger.entry_price === null ? "the entry price" : null,
    ledger.quantity === null ? "the size" : null,
  ].filter((part): part is string => part !== null);
  return missing.length ? { kind: "reported", missing } : { kind: "calculated" };
}

/** `the entry price and the size`, `the instrument contract, the entry price and the size`. */
export function listInWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What realized R will be based on once closed, in the §14.4 words (the risk as "Risk at stop" shows it). */
export function riskBasisPreview(detail: TradeDetail): string {
  const ledger = detail.technical.ledger;
  const currency = detail.account.currency;
  if (detail.origin === "PLANNED") {
    return ledger.initial_risk ? `R based on locked risk: realized R = net P&L ÷ ${riskMoney(ledger.initial_risk, currency)}.` : "R based on locked risk: realized R = net P&L ÷ the locked risk.";
  }
  if (ledger.initial_risk) return `R based on risk recorded after entry: realized R = net P&L ÷ ${riskMoney(ledger.initial_risk, currency)}.`;
  return "No risk is recorded for this trade, so realized R won't be available. Add the stop and size, or a risk amount, before you close.";
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan values in words (draft revision, locked plan, or the last revision of a discarded draft).
// ---------------------------------------------------------------------------------------------------------------------

export interface PlanFact {
  label: string;
  value: string;
  tone?: "warning";
}

/** The plan values a view shows and the check that sized them. */
export interface PlanSource {
  proposal: ProposalView;
  check: CheckView | null;
  /** Money at risk at the stop: the locked nominal risk, or the sizing of the latest check. */
  nominalRisk: string | null;
  /**
   * The minimum RR that check compared the plan with (`CheckView.minRR`: its report 1.2 limits, or its risk plan version
   * for an older report); null when unknown.
   */
  minRR?: string | null;
}

/** The minimum RR a stored report 1.2 compared the plan with (the fallback when the check view doesn't carry it). */
function minRrOf(report: unknown): string | null {
  return report12(report)?.limits.minRR ?? null;
}

export function draftSource(detail: TradeDetail): PlanSource | null {
  const draft = detail.draft;
  if (!draft) return null;
  const check = draft.latestCheck;
  return {
    proposal: draft.proposal, check, nominalRisk: check?.calculations?.nominalRisk ?? null,
    minRR: check ? check.minRR ?? latestCheckReport(detail)?.limits.minRR ?? null : null,
  };
}

export function lockedSource(detail: TradeDetail): PlanSource | null {
  const plan = detail.plan;
  return plan ? { proposal: plan.proposal, check: plan.check, nominalRisk: plan.nominalRisk, minRR: plan.check?.minRR ?? minRrOf(detail.technical.planReport) } : null;
}

/**
 * The plan values the ledger keeps for a planned trade (latest revision, or the locked plan): the fallback when the
 * revision itself can't be read. The thesis and the trader's checks live only in the revision, so they stay unknown.
 */
export function ledgerProposal(detail: TradeDetail): ProposalView {
  const ledger = detail.technical.ledger;
  const model = ledger.entry_model === "OB_FIRST_TOUCH" || ledger.entry_model === "OTE" ? ledger.entry_model : null;
  return {
    instrumentVersionId: ledger.instrument_version_id, direction: ledger.direction, model, entry: ledger.planned_entry, stop: ledger.planned_stop,
    target: ledger.planned_target, riskPercent: ledger.requested_risk_percent, narrative: null, contractConfirmed: null, news: null, contradiction: null,
  };
}

/** The latest revision of a draft that never became a plan (discarded, or skipped in V1), with its latest check. */
export function lastRevisionSource(detail: TradeDetail, proposal: ProposalView | null): PlanSource {
  const check = detail.checks.at(-1) ?? null;
  // Technical details keep every stored check's report; the check view carries its recording time.
  const report = check === null ? null : detail.technical.checks.findLast(row => row.recordedAt === check.recordedAt)?.report ?? null;
  return { proposal: proposal ?? ledgerProposal(detail), check, nominalRisk: check?.calculations?.nominalRisk ?? null, minRR: check?.minRR ?? minRrOf(report) };
}

/**
 * Planned RR as the check judged it (§6.6): against the minimum that check compared it with (`formatAgainst`, the Plan
 * Trade preview's words), so an approved plan never reads below its minimum and a plan below it never reads as meeting
 * it. Without a known minimum it is truncated to 2 decimals, which can never read as meeting a minimum it misses.
 */
function plannedRrText(plannedRR: string, minRR: string | null | undefined): string {
  if (minRR) return `${formatAgainst(plannedRR, minRR, "min", new D(plannedRR).gte(minRR))}R`;
  return `${new D(plannedRR).toDecimalPlaces(2, D.ROUND_DOWN).toFixed(2)}R`;
}

export function planFacts(detail: TradeDetail, source: PlanSource): PlanFact[] {
  const { proposal, check, nominalRisk } = source;
  const tick = detail.instrument?.tickSize ?? null;
  const step = detail.instrument?.quantityStep ?? null;
  const unit = unitWord(detail.instrument?.quantityUnit);
  const price = (value: string | null) => (value === null ? "Missing" : formatPrice(value, tick));
  const calc = check?.calculations ?? null;
  const facts: PlanFact[] = [
    { label: "Instrument", value: [detail.symbol ?? "Unknown", directionLabel(proposal.direction)].filter(Boolean).join(" · ") },
    { label: "Model", value: modelLabel(proposal.model) ?? "Not set" },
    { label: "Entry", value: price(proposal.entry) },
    { label: "Stop", value: price(proposal.stop), ...(proposal.stop === null ? { tone: "warning" as const } : {}) },
    { label: "Target", value: price(proposal.target) },
    { label: "Risk per trade", value: proposal.riskPercent ? formatPercent(proposal.riskPercent) : "Not set" },
  ];
  if (calc) {
    facts.push({ label: "Planned RR", value: plannedRrText(calc.plannedRR, source.minRR) });
    facts.push({ label: "Size", value: `${formatQuantity(calc.quantity, step)}${unit ? ` ${unit}` : ""}` });
  }
  if (nominalRisk) facts.push({ label: "Risk at stop", value: riskMoney(nominalRisk, detail.account.currency) });
  return facts;
}

/**
 * The trader's own checks of the plan, in words. A draft whose contract was superseded by a newer version of its symbol
 * (`contractUpdated`) keeps a confirmation of values that are no longer the account's.
 */
export function planChecks(proposal: ProposalView, options: { contractUpdated?: boolean } = {}): PlanFact[] {
  const confirmed = proposal.contractConfirmed === true && options.contractUpdated !== true;
  return [
    {
      label: "Economic news",
      value: NEWS_LABELS[proposal.news ?? "UNKNOWN"],
      ...(proposal.news === "CLEAR" ? {} : { tone: "warning" as const }),
    },
    {
      label: "Contract values",
      value: confirmed ? "Match my broker" : proposal.contractConfirmed === true ? "Confirmed before the contract update" : "Not confirmed",
      ...(confirmed ? {} : { tone: "warning" as const }),
    },
    {
      label: "Strategy rules",
      value: proposal.contradiction === true ? "Contradiction flagged" : "No contradiction flagged",
      ...(proposal.contradiction === true ? { tone: "warning" as const } : {}),
    },
  ];
}

/** `Locked 09:12 · Risk Plan V1.0 · ICT V1.0 · immutable` (§14.4). */
export function lockedLine(plan: NonNullable<TradeDetail["plan"]>, now: Instant, display: TimeDisplay): string {
  return [`Locked ${whenLabel(plan.lockedAt, now, display)}`, plan.riskPlanVersion, plan.strategyVersion, "immutable"].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------------
// Lock confirmation (§8.1): what becomes immutable and what is reserved.
// ---------------------------------------------------------------------------------------------------------------------

/** Today's usage of the account (from its workspace), to state what locking reserves. */
export interface LockUsage {
  slotsUsed: number;
  maxDailyTrades: number;
  /** Planned + recorded-live risk of today. */
  riskUsed: string;
  dailyRiskCap: string | null;
  dailyLossCap: string | null;
  /** Trading day (strategy day) of the account's latest values; null without any. Locking sizes with these values. */
  valuesDay?: string | null;
}

export interface LockSummary {
  immutable: string[];
  stillOpen: string;
  reserved: string[];
  /**
   * Trading day of the account's latest values (`LockUsage.valuesDay`), not shown in the confirmation: the header and
   * the Plan section read it (`blockingNow`) to tell a stale-values block whether today's values have been confirmed
   * since its check. Null when unknown.
   */
  valuesDay: string | null;
}

export function lockSummary(detail: TradeDetail, usage: LockUsage | null): LockSummary {
  const draft = detail.draft;
  const currency = detail.account.currency;
  const proposal = draft?.proposal;
  const calc = draft?.latestCheck?.calculations ?? null;
  const tick = detail.instrument?.tickSize ?? null;
  const step = detail.instrument?.quantityStep ?? null;
  const unit = unitWord(detail.instrument?.quantityUnit);
  const price = (value: string | null | undefined) => (value ? formatPrice(value, tick) : "—");
  const immutable = [
    [detail.symbol ?? "Instrument", directionLabel(proposal?.direction)?.toLowerCase(), modelLabel(proposal?.model)].filter(Boolean).join(" · "),
    `Entry ${price(proposal?.entry)} · stop ${price(proposal?.stop)} · target ${price(proposal?.target)}`,
    [
      proposal?.riskPercent ? `Risk ${formatPercent(proposal.riskPercent)}` : null,
      calc ? `${formatQuantity(calc.quantity, step)}${unit ? ` ${unit}` : ""}` : null,
      calc ? `${riskMoney(calc.nominalRisk, currency)} at the stop` : null,
    ].filter(Boolean).join(" · "),
    "Thesis and checks (news, contract values, strategy rules)",
  ].filter(line => line !== "");
  const reserved: string[] = [];
  if (usage) {
    const after = usage.slotsUsed + 1;
    reserved.push(`1 daily trade: ${after} of ${usage.maxDailyTrades} used today after locking (${plural(Math.max(0, usage.maxDailyTrades - after), "trade")} left).`);
    // The reserved risk is never understated and the room left never overstated (§6.6), as Today states them.
    if (usage.dailyRiskCap && calc) {
      const left = new D(usage.dailyRiskCap).minus(usage.riskUsed).minus(calc.nominalRisk);
      reserved.push(
        `${riskMoney(calc.nominalRisk, currency)} of your ${formatMoneyExact(usage.dailyRiskCap, currency)} daily risk cap (${roomMoney(left, currency)} left after locking).`,
      );
    } else if (calc) {
      reserved.push(`${riskMoney(calc.nominalRisk, currency)} of daily risk (no daily risk cap is configured).`);
    }
    if (usage.dailyLossCap) reserved.push(`While open, its risk counts toward your ${formatMoneyExact(usage.dailyLossCap, currency)} daily loss limit.`);
  } else {
    reserved.push("One of today's trade slots and this trade's risk count toward your daily limits.");
  }
  return { immutable, stillOpen: "Screenshots, journal notes and tags stay open after locking.", reserved, valuesDay: usage?.valuesDay ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution facts.
// ---------------------------------------------------------------------------------------------------------------------

export interface PositionFact {
  label: string;
  /** Null: not recorded. */
  value: string | null;
  hint?: string;
}

/** An entry detail of a live-first or imported position (a column of `trade_position_facts` the page shows). */
export type PositionDetail = "contract" | "model" | "entryPrice" | "enteredAt" | "quantity" | "initialStop" | "riskAmount";

/** One record of a position's entry details (§3.5): when the server wrote it and which details it set. */
export interface PositionRecord {
  recordedAt: string;
  details: readonly PositionDetail[];
}

/**
 * When each detail was added after the position was first recorded ("Add entry details"); details of the first record
 * are left out. A detail is set once and never changed, so its first record is the one that counts.
 */
export function addedLater(records: readonly PositionRecord[]): Partial<Record<PositionDetail, string>> {
  const added: Partial<Record<PositionDetail, string>> = {};
  const seen = new Set<PositionDetail>();
  records.forEach((record, index) => {
    for (const field of record.details) {
      if (seen.has(field)) continue;
      seen.add(field);
      if (index > 0) added[field] = record.recordedAt;
    }
  });
  return added;
}

/** `Recorded 10:04. Details marked “Added” were completed later.`, or null without records. */
export function positionRecordedLine(records: readonly PositionRecord[], now: Instant, display: TimeDisplay): string | null {
  const first = records[0];
  if (!first) return null;
  const later = Object.keys(addedLater(records)).length > 0;
  return `Recorded ${whenLabel(first.recordedAt, now, display)}, with the position already open.${later ? " Details marked “Added” were completed later." : ""}`;
}

/** A stop move journaled while the position was live: its exact price and when it was recorded. */
export interface StopMove {
  price: string;
  recordedAt: string;
}

const DECIMAL_PRICE = /^\d+(\.\d+)?$/;

/**
 * The newest stop move journaled while the position was live (§3.6), as Today's live card reads it: a stop journaled
 * before the entry or after the close never describes the open position. Newest by recording time, then id, as the
 * journal orders its entries; null without one.
 */
export function liveStopMove(timeline: readonly TimelineItem[]): StopMove | null {
  let newest: (StopMove & { id: string }) | null = null;
  for (const item of timeline) {
    const price = item.details?.price;
    if (item.kind !== "JOURNAL" || item.journalKind !== "STOP_CHANGE" || item.timing !== "WHILE_LIVE" || typeof price !== "string" || !DECIMAL_PRICE.test(price)) continue;
    const order = newest === null ? 1 : compareInstants(item.recordedAt, newest.recordedAt) || (item.id > newest.id ? 1 : -1);
    if (order > 0) newest = { price, recordedAt: item.recordedAt, id: item.id };
  }
  return newest && { price: newest.price, recordedAt: newest.recordedAt };
}

/**
 * What a live-first or imported position recorded, in words; missing details read "Not recorded", and details completed
 * after the first record say when they were added, since a later stop or risk amount sets the basis of realized R. The
 * recorded stop is the initial stop (the R basis); while the position is live and the journal moved the stop, the
 * current stop leads, with when it moved, as on Today's live card (§3.6).
 */
export function positionFacts(detail: TradeDetail, now: Instant, display: TimeDisplay, records: readonly PositionRecord[] = []): PositionFact[] {
  const ledger = detail.technical.ledger;
  const tick = detail.instrument?.tickSize ?? null;
  const step = detail.instrument?.quantityStep ?? null;
  const unit = unitWord(detail.instrument?.quantityUnit);
  const added = addedLater(records);
  const addedHint = (field: PositionDetail, before?: string): { hint: string } | Record<string, never> => {
    const at = added[field];
    if (!at) return before ? { hint: before } : {};
    const words = `added ${whenLabel(at, now, display)}`;
    return { hint: before ? `${before} · ${words}` : `${words.charAt(0).toUpperCase()}${words.slice(1)}` };
  };
  const riskBasis = detail.close?.riskBasisSource ?? (added.riskAmount ? "USER_REPORTED" : null);
  const riskHint = riskBasis === "USER_REPORTED" ? "Risk amount you recorded" : riskBasis === "DERIVED" ? "From the recorded entry, stop and size" : undefined;
  const contractHint = ledger.instrument_version_id === null ? { hint: "No contract values" } : added.contract ? { hint: `Contract added ${whenLabel(added.contract, now, display)}` } : {};
  const move = detail.state.lifecycle === "LIVE" ? liveStopMove(detail.timeline) : null;
  const atEntry = move !== null && ledger.entry_price !== null && new D(move.price).eq(ledger.entry_price);
  const moved: PositionFact[] = move
    ? [{ label: "Stop", value: formatPrice(move.price, tick), hint: `${atEntry ? "At entry · moved" : "Moved"} ${whenLabel(move.recordedAt, now, display)}` }]
    : [];
  return [
    { label: "Instrument", value: [detail.symbol, directionLabel(detail.direction)].filter(Boolean).join(" · ") || null, ...contractHint },
    { label: "Model", value: modelLabel(ledger.entry_model), ...addedHint("model") },
    { label: "Entry", value: ledger.entry_price === null ? null : formatPrice(ledger.entry_price, tick), ...addedHint("entryPrice") },
    { label: "Entry time", value: ledger.entered_at === null ? null : whenLabel(ledger.entered_at, now, display), ...addedHint("enteredAt") },
    { label: "Size", value: ledger.quantity === null ? null : `${formatQuantity(ledger.quantity, step)}${unit ? ` ${unit}` : ""}`, ...addedHint("quantity") },
    ...moved,
    { label: "Initial stop", value: ledger.initial_stop === null ? null : formatPrice(ledger.initial_stop, tick), ...addedHint("initialStop") },
    {
      label: "Risk at stop",
      value: ledger.initial_risk === null ? null : riskMoney(ledger.initial_risk, detail.account.currency),
      ...(ledger.initial_risk === null ? {} : addedHint("riskAmount", riskHint)),
    },
  ];
}

/** `Entered Oct 23, 03:05 · recorded 03:16 · 1.10020 · 0.50 lots` (recorded time when it is more than 5 minutes later). */
export function entryLine(detail: TradeDetail, now: Instant, display: TimeDisplay): string | null {
  const execution = detail.execution;
  if (!execution) return null;
  const tick = detail.instrument?.tickSize ?? null;
  const step = detail.instrument?.quantityStep ?? null;
  const unit = unitWord(detail.instrument?.quantityUnit);
  const parts: string[] = [];
  if (execution.enteredAt) {
    const late = execution.recordedAt !== null && differsByMoreThan(execution.enteredAt, execution.recordedAt, RECORDED_GAP_MINUTES);
    parts.push(`Entered ${whenLabel(execution.enteredAt, now, display)}${late && execution.recordedAt ? ` · recorded ${whenLabel(execution.recordedAt, now, display)}` : ""}`);
  } else {
    parts.push("Entry time not recorded");
  }
  if (execution.entryPrice) parts.push(formatPrice(execution.entryPrice, tick));
  if (execution.quantity) parts.push(`${formatQuantity(execution.quantity, step)}${unit ? ` ${unit}` : ""}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------------
// Outcome (§3.5, §14.4): realized R, P&L and how they were calculated.
// ---------------------------------------------------------------------------------------------------------------------

export interface OutcomeView {
  summary: ResultSummary;
  /** "R based on locked risk · realized R = net P&L ÷ $500.00", or why R is not available. */
  basis: string;
  facts: PositionFact[];
  /** User-reported exit time. */
  exitedAt: string;
}

export function outcomeView(detail: TradeDetail, now: Instant, display: TimeDisplay): OutcomeView | null {
  const close = detail.close;
  const summary = resultSummary(detail);
  if (!close || !summary) return null;
  const currency = detail.account.currency;
  const tick = detail.instrument?.tickSize ?? null;
  const risk = detail.technical.ledger.initial_risk;
  const riskWords = close.riskBasisSource ? RISK_BASIS_LABELS[close.riskBasisSource].toLowerCase() : null;
  const basis = close.realizedR !== null && risk
    ? `${close.basisLabel} · realized R = net P&L ÷ ${riskMoney(risk, currency)}${riskWords ? ` (${riskWords})` : ""}`
    : close.basisLabel;
  const enteredAt = detail.execution?.enteredAt ?? null;
  const late = close.recordedAt !== null && differsByMoreThan(close.exitedAt, close.recordedAt, RECORDED_GAP_MINUTES);
  const facts: PositionFact[] = [
    { label: "Average exit price", value: close.exitPrice === null ? null : formatPrice(close.exitPrice, tick) },
    {
      label: "Exit time",
      value: whenLabel(close.exitedAt, now, display),
      ...(late && close.recordedAt ? { hint: `Recorded ${whenLabel(close.recordedAt, now, display)}` } : {}),
    },
    { label: "Held", value: enteredAt ? formatDuration(enteredAt, close.exitedAt) : null },
    { label: "Gross P&L", value: close.grossPnl === null ? null : formatSignedMoney(close.grossPnl, currency) },
    { label: "Fees", value: close.fees === null ? null : formatMoney(close.fees, currency) },
  ];
  if (detail.origin !== "PLANNED" && close.pnlSource) facts.push({ label: "P&L source", value: PNL_SOURCE_LABELS[close.pnlSource] });
  return { summary, basis, facts, exitedAt: close.exitedAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Review.
// ---------------------------------------------------------------------------------------------------------------------

/** `Grade A · Asian range low · MSS M5 · london, sweep`, or null without any tag (never an enum spelling). */
export function tagsSummary(tags: Pick<TradeDetail["tags"], "grade" | "liquidity" | "mss" | "tags">): string | null {
  const grade = gradeLabel(tags.grade);
  const parts = [
    grade ? (tags.grade === "INVALID" ? "Invalid setup" : `Grade ${grade}`) : null,
    liquidityLabel(tags.liquidity),
    tags.mss && MSS_VALUES.has(tags.mss) ? `MSS ${tags.mss}` : null,
    tags.tags.length ? tags.tags.join(", ") : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : null;
}

/** Lessons are journal entries of the LESSON kind (written with the composer's Lesson chip), oldest first. */
export function lessonsOf(timeline: readonly TimelineItem[]): TimelineItem[] {
  return timeline.filter(item => item.kind === "JOURNAL" && item.journalKind === "LESSON");
}

/** Record-entry defaults: the plan's entry at the tick scale and its size at the step scale (strings, never numbers). */
export function entryDefaults(detail: TradeDetail): { entry: string; quantity: string } {
  const ledger = detail.technical.ledger;
  const tick = detail.instrument?.tickSize ?? null;
  const step = detail.instrument?.quantityStep ?? null;
  return {
    entry: ledger.planned_entry ? formatPrice(ledger.planned_entry, tick) : "",
    quantity: ledger.planned_quantity ? formatQuantity(ledger.planned_quantity, step) : "",
  };
}

/** Origin words for the badge; the live-first tooltip is the §15 sentence. */
export function originBadge(origin: TradeOrigin, state: TradeState): { label: string; tooltip: string | null } {
  return { label: state.originLabel, tooltip: origin === "PLANNED" ? null : state.originTooltip ?? state.banner };
}
