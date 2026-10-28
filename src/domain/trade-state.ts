import type { DraftCheck, LedgerTrade, Lifecycle, TradeOrigin } from "./ledger";
import { compareInstants, type Instant, strategyDay } from "./time-display";

/**
 * Trade lifecycle, vocabulary, next action and editability (spec §2). The lifecycle mirrors the
 * SQL derivation of `trade_ledger.lifecycle` from raw facts (parity-tested against the view);
 * it is never read back from a stored status.
 */

export type TradeTone = "neutral" | "danger" | "positive" | "warning" | "info" | "live" | "positive-muted" | "muted";
export type TradeStep = "Draft" | "Validated" | "Locked" | "Live" | "Closed" | "Reviewed";
export type AiActionOperation = "ANALYZE_SETUP" | "CHALLENGE_BIAS" | "REVIEW_TRADE_TIMELINE";
export type TradeActionKind =
  | "CHECK_RISK" | "EDIT_DRAFT" | "DISCARD" | "ANALYZE_BLOCKED" | "LOCK_PLAN" | "ANALYZE_SETUP" | "CHALLENGE_BIAS"
  | "RECHECK_RISK" | "RECORD_ENTRY" | "SKIP" | "ADD_JOURNAL" | "CLOSE_TRADE" | "ADD_ENTRY_DETAILS"
  | "WRITE_REVIEW" | "AI_REVIEW" | "REOPEN_REVIEW";

export interface TradeAction {
  kind: TradeActionKind;
  label: string;
  /** Paid AI actions; the UI appends the cost estimate (`ai-summary.ts`). */
  aiOperation?: AiActionOperation;
  /** Inline context, e.g. the first blocking reason next to "Edit draft". */
  detail?: string;
}

export interface TradeEditability {
  /** Plan fields: editable only as a new draft revision. */
  plan: boolean;
  /**
   * `manage`: add, plus soft and audited remove/relabel (timing never changes; removed items leave
   * the gallery and AI selection). Allowed in every state (spec §2.5).
   */
  evidence: "none" | "add" | "manage";
  /** Journal notes, including reflection on skipped, cancelled or discarded trades. */
  journal: boolean;
  /** `complete`: a live-first or imported position can fill missing entry details once each. */
  entry: "none" | "record" | "complete" | "immutable";
  close: "none" | "record" | "immutable";
  tags: boolean;
  review: "none" | "complete" | "reopen";
}

export interface TradeState {
  lifecycle: Lifecycle;
  /** Only for drafts; null otherwise. */
  draftCheck: DraftCheck | null;
  /** True when an approved draft check is still current (drafts only). */
  checkCurrent: boolean;
  label: string;
  tone: TradeTone;
  /** Stepper position for planned trades; null for live-first/imported and terminal states. */
  step: TradeStep | null;
  origin: TradeOrigin;
  originLabel: string;
  originTooltip: string | null;
  /** Live-first / imported banner (exact copy). */
  banner: string | null;
  nextAction: TradeAction | null;
  secondaryActions: TradeAction[];
  editable: TradeEditability;
  /** Plain-words statement of what can no longer change. */
  immutableNote: string | null;
  canDuplicate: boolean;
}

export const NO_PLAN_BANNER = "No pre-trade plan was recorded before execution.";
export const LOCKED_PLAN_NOTE = "Locked plans can't be edited. Later changes are recorded in the journal.";
export const STEPPER_STEPS: readonly TradeStep[] = Object.freeze(["Draft", "Validated", "Locked", "Live", "Closed", "Reviewed"]);

/** Columns the lifecycle derivation reads (spec §2.2). */
export type LifecycleRow = Pick<LedgerTrade,
  | "origin" | "plan_id" | "discarded_at" | "legacy_decision" | "disposition" | "outcome" | "exited_at" | "close_recorded_at"
  | "entered_at" | "entry_recorded_at" | "entry_price" | "review_completed_at">;

/** Columns the full state reads, so callers can pass a projection of the ledger. */
export type TradeStateRow = LifecycleRow & Pick<LedgerTrade,
  | "instrument_version_id" | "entry_model" | "quantity" | "initial_stop" | "initial_risk"
  | "latest_check_decision" | "latest_check_at" | "revision_count">;

export interface TradeStateOptions {
  /**
   * Server time; an approval from an earlier strategy day is never treated as current, and a block from an earlier
   * strategy day makes "Recheck risk" the next action.
   */
  now: Instant;
  /** Result of `isRiskReportCurrent` for the latest approved check (server time). */
  checkCurrent: boolean;
  /** Offer paid AI actions (account opted in, budget and pricing available). Default false. */
  aiAvailable?: boolean;
  /** First blocking reason of the latest check (`explainReport(...).blocking[0].detail`), shown with "Edit draft". */
  blockingReason?: string;
  /**
   * The trade's account is archived (§3.2, §9, §14.9): it takes no new activity, so a draft can only be discarded (the
   * database refuses a new revision, a check or a lock with ACCOUNT_ARCHIVED) and reads "Account archived", none of its
   * approvals is current, and no trade of it can be duplicated. Trades it already holds are finished as usual: the other
   * states keep their actions. Default false.
   */
  accountArchived?: boolean;
}

function hasClose(row: Pick<LifecycleRow, "outcome" | "exited_at" | "close_recorded_at">): boolean {
  return row.outcome !== null || row.exited_at !== null || row.close_recorded_at !== null;
}

function hasEntry(row: Pick<LifecycleRow, "entry_recorded_at" | "entered_at" | "entry_price">): boolean {
  return row.entry_recorded_at !== null || row.entered_at !== null || row.entry_price !== null;
}

/** Lifecycle per spec §2.2, in the precedence of `trade_ledger.lifecycle`. */
export function deriveLifecycle(row: LifecycleRow): Lifecycle {
  const closedOrReviewed: Lifecycle = row.review_completed_at !== null ? "REVIEWED" : "CLOSED";
  if (row.origin !== "PLANNED") return hasClose(row) ? closedOrReviewed : "LIVE";
  if (row.discarded_at !== null) return "DISCARDED";
  if (row.plan_id === null) return row.legacy_decision === "SKIPPED" ? "SKIPPED" : "DRAFT";
  if (hasClose(row)) return closedOrReviewed;
  if (hasEntry(row)) return "LIVE";
  if (row.disposition !== null) return row.disposition;
  // A V1 skip of a locked plan keeps its meaning; a V1 "taken" without a fill stays LOCKED.
  return row.legacy_decision === "SKIPPED" ? "SKIPPED" : "LOCKED";
}

/** Draft check per spec §2.2 (null outside the draft state). */
export function deriveDraftCheck(row: LifecycleRow & Pick<LedgerTrade, "latest_check_decision">): DraftCheck | null {
  return deriveLifecycle(row) === "DRAFT" ? row.latest_check_decision ?? "UNCHECKED" : null;
}

/** Columns `planEndedAt` reads: the origin, the discard, and whether the plan has a fill or an outcome. */
export type PlanEndRow = Pick<LedgerTrade,
  "origin" | "discarded_at" | "entered_at" | "entry_recorded_at" | "entry_price" | "outcome" | "exited_at" | "close_recorded_at">;

/** End facts the ledger names but does not date (timestamps as the database returns them). */
export interface PlanEndTimes {
  /** `trade_dispositions.recorded_at` of the linked plan (its skip or cancellation). */
  dispositionAt?: string | null;
  /** `setup_human_decisions.recorded_at` of the trade's latest V1 decision, when that decision is SKIPPED. */
  legacySkipAt?: string | null;
}

/**
 * When a planned trade ended without an entry (spec §5.2, `private.plan_ended_at`, parity-tested): the earliest of its
 * discard, the skip or cancellation of its plan and a latest V1 SKIPPED decision. Null while none exists, once the plan
 * has a fill or an outcome, and for trades without a Trading OS plan. The earliest fact counts, so a later one never
 * moves the end. Records made from then on are hindsight: stored post-trade and never pre-entry evidence (§5.3, §7.4).
 */
export function planEndedAt(row: PlanEndRow, times: PlanEndTimes = {}): string | null {
  if (row.origin !== "PLANNED" || hasEntry(row) || hasClose(row)) return null;
  const facts = [row.discarded_at, times.dispositionAt ?? null, times.legacySkipAt ?? null].filter((at): at is string => at !== null);
  return facts.reduce<string | null>((earliest, at) => (earliest === null || compareInstants(at, earliest) < 0 ? at : earliest), null);
}

/**
 * A draft blocked by a check that ran on an earlier strategy day (fixed UTC−5) than `now`. Daily limits, the session,
 * today's account values and the risk plan in effect can all differ since, so the stored reasons say nothing certain
 * about today: the free recheck comes first, as it does for an approval that is no longer current.
 */
export function blockedOnEarlierDay(row: LifecycleRow & Pick<LedgerTrade, "latest_check_decision" | "latest_check_at">, now: Instant): boolean {
  return deriveDraftCheck(row) === "BLOCKED" && row.latest_check_at !== null && strategyDay(row.latest_check_at) !== strategyDay(now);
}

const ORIGIN_LABELS: Record<TradeOrigin, string> = { PLANNED: "Planned", LIVE_FIRST: "Live-first", IMPORTED: "Imported" };

function action(kind: TradeActionKind, label: string, aiOperation?: AiActionOperation): TradeAction {
  return aiOperation ? { kind, label, aiOperation } : { kind, label };
}

const EDIT_DRAFT = action("EDIT_DRAFT", "Edit draft");
const DISCARD = action("DISCARD", "Discard");
const RECHECK_RISK = action("RECHECK_RISK", "Recheck risk");

/**
 * State pill of a draft whose trading account is archived (§3.2, §9): whatever its last check said, the draft waits for
 * the account to be restored, so the pill names that reason and no risk step ("Recheck needed", "Ready to lock").
 */
export const ARCHIVED_DRAFT_LABEL = "Account archived";

/**
 * Entry details a live-first or imported position can still fill once each (`complete_live_entry`):
 * instrument, model, price, time, size, stop, or a risk basis (reported or derivable). Without a
 * risk basis its realized R can never be computed.
 */
function missingEntryDetails(row: TradeStateRow): boolean {
  if (row.origin === "PLANNED") return false;
  return [row.instrument_version_id, row.entry_model, row.entry_price, row.entered_at, row.quantity, row.initial_stop, row.initial_risk]
    .some(value => value === null);
}

/** Evidence, journal notes and tags stay open in every state; the other parts follow the lifecycle. */
function editability(lifecycle: Lifecycle, row: TradeStateRow): TradeEditability {
  const base: TradeEditability = { plan: false, evidence: "manage", journal: true, entry: "none", close: "none", tags: true, review: "none" };
  switch (lifecycle) {
    case "DRAFT": return { ...base, plan: true };
    case "LOCKED": return { ...base, entry: "record" };
    // Entry details can be completed until the close (the database then refuses with ALREADY_CLOSED).
    case "LIVE": return { ...base, entry: missingEntryDetails(row) ? "complete" : "immutable", close: "record" };
    case "CLOSED": return { ...base, entry: "immutable", close: "immutable", review: "complete" };
    case "REVIEWED": return { ...base, entry: "immutable", close: "immutable", review: "reopen" };
    case "SKIPPED":
    case "CANCELLED":
    case "DISCARDED": return base;
  }
}

interface Presentation {
  label: string;
  tone: TradeTone;
  step: TradeStep | null;
  nextAction: TradeAction | null;
  secondaryActions: TradeAction[];
}

function presentation(lifecycle: Lifecycle, draftCheck: DraftCheck | null, current: boolean, row: TradeStateRow, options: TradeStateOptions): Presentation {
  const aiActions = (...actions: TradeAction[]) => (options.aiAvailable === true ? actions : []);
  const planned = row.origin === "PLANNED";
  switch (lifecycle) {
    case "DRAFT":
      if (draftCheck === "BLOCKED") {
        const edit = options.blockingReason ? { ...EDIT_DRAFT, detail: options.blockingReason } : EDIT_DRAFT;
        const others = [...aiActions(action("ANALYZE_BLOCKED", "Analyze blocked setup anyway", "ANALYZE_SETUP")), DISCARD];
        // A block found on an earlier strategy day: the free recheck gives today's answer before any edit (§2.4, §6.3).
        if (blockedOnEarlierDay(row, options.now)) return { label: "Blocked", tone: "danger", step: "Draft", nextAction: RECHECK_RISK, secondaryActions: [edit, ...others] };
        return { label: "Blocked", tone: "danger", step: "Draft", nextAction: edit, secondaryActions: others };
      }
      if (draftCheck === "APPROVED" && current) {
        return {
          label: "Ready to lock", tone: "positive", step: "Validated", nextAction: action("LOCK_PLAN", "Lock plan"),
          secondaryActions: [
            ...aiActions(action("ANALYZE_SETUP", "Analyze setup", "ANALYZE_SETUP"), action("CHALLENGE_BIAS", "Challenge my bias", "CHALLENGE_BIAS")),
            EDIT_DRAFT,
          ],
        };
      }
      if (draftCheck === "APPROVED") {
        return { label: "Recheck needed", tone: "warning", step: "Draft", nextAction: RECHECK_RISK, secondaryActions: [EDIT_DRAFT] };
      }
      return { label: "Draft", tone: "neutral", step: "Draft", nextAction: action("CHECK_RISK", "Check risk (free)"), secondaryActions: [EDIT_DRAFT, DISCARD] };
    case "LOCKED":
      return { label: "Locked · waiting for entry", tone: "info", step: "Locked", nextAction: action("RECORD_ENTRY", "Record entry"), secondaryActions: [action("SKIP", "Skip this trade")] };
    case "LIVE":
      return {
        label: "Live", tone: "live", step: planned ? "Live" : null, nextAction: action("ADD_JOURNAL", "Add to journal"),
        secondaryActions: [
          ...(missingEntryDetails(row) ? [action("ADD_ENTRY_DETAILS", "Add entry details")] : []),
          action("CLOSE_TRADE", "Close trade"),
        ],
      };
    case "CLOSED":
      return {
        label: "Closed · review pending", tone: "neutral", step: planned ? "Closed" : null,
        nextAction: action("WRITE_REVIEW", "Write review"),
        secondaryActions: aiActions(action("AI_REVIEW", "Review this trade with AI", "REVIEW_TRADE_TIMELINE")),
      };
    case "REVIEWED":
      return {
        label: "Reviewed", tone: "positive-muted", step: planned ? "Reviewed" : null,
        nextAction: null, secondaryActions: [action("REOPEN_REVIEW", "Reopen review")],
      };
    case "SKIPPED":
      return { label: "Skipped", tone: "muted", step: null, nextAction: null, secondaryActions: [] };
    case "CANCELLED":
      return { label: "Cancelled", tone: "muted", step: null, nextAction: null, secondaryActions: [] };
    case "DISCARDED":
      return { label: "Discarded", tone: "muted", step: null, nextAction: null, secondaryActions: [] };
  }
}

/**
 * Full presentation state of a trade. `checkCurrent` comes from `isRiskReportCurrent` evaluated
 * with server time; an approval recorded on an earlier strategy day is stale regardless.
 */
export function deriveTradeState(row: TradeStateRow, options: TradeStateOptions): TradeState {
  const lifecycle = deriveLifecycle(row);
  const draftCheck = lifecycle === "DRAFT" ? row.latest_check_decision ?? "UNCHECKED" : null;
  const sameDay = row.latest_check_at !== null && strategyDay(row.latest_check_at) === strategyDay(options.now);
  const archived = options.accountArchived === true;
  // An archived account's draft can't be locked, so none of its approvals is current (never "Ready to lock").
  const current = draftCheck === "APPROVED" && options.checkCurrent && sameDay && !archived;
  const planned = row.origin === "PLANNED";
  const shown = presentation(lifecycle, draftCheck, current, row, options);
  const editable = editability(lifecycle, row);
  // A draft of an archived account waits for the account: no new revision, check, lock or analysis (the database refuses
  // them with ACCOUNT_ARCHIVED), only Discard. Its pill says why instead of a risk step it can't take; `draftCheck` keeps
  // the fact of its last check.
  const frozen = archived && lifecycle === "DRAFT";
  return {
    lifecycle,
    draftCheck,
    checkCurrent: current,
    ...shown,
    ...(frozen ? { label: ARCHIVED_DRAFT_LABEL, tone: "muted" as const, step: "Draft" as const, nextAction: null, secondaryActions: [DISCARD] } : {}),
    origin: row.origin,
    originLabel: ORIGIN_LABELS[row.origin],
    originTooltip: row.origin === "LIVE_FIRST" ? NO_PLAN_BANNER : null,
    banner: planned ? null : NO_PLAN_BANNER,
    editable: frozen ? { ...editable, plan: false } : editable,
    // Any linked plan is locked and immutable, including a skipped or cancelled one.
    immutableNote: planned && row.plan_id !== null ? LOCKED_PLAN_NOTE : null,
    // A duplicate is a new trade of the same account, which an archived account refuses.
    canDuplicate: !archived && planned && (row.revision_count > 0 || row.plan_id !== null),
  };
}
