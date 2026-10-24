"use server";
import Decimal from "decimal.js";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { type Proposal, proposalSchema } from "@/domain/risk";
import { explainReport, INVALID_INPUT_FIELD_COPY } from "@/domain/risk-explain";
import { storedRiskSchema } from "@/domain/risk-report";
import { isInstant, strategyDay } from "@/domain/time-display";
import { sizeDeviationWarning } from "@/domain/plan-vs-reality";
import { type Db, LAST_ACCOUNT_COOKIE, loadAccount, type Session, setContextCookie } from "@/lib/account-context";
import { copyEvidenceForDuplicate, EVIDENCE_LABELS, EVIDENCE_TIMEFRAMES } from "@/lib/evidence";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { loadActiveRiskPlan, loadLatestObservation } from "@/lib/workspace";
import {
  type ActionState, actionError, actionSuccess, errorCode, FAILED_COPY, formFlag, formList, formOptional, formText, INVALID_COPY, invalidField, rpcErrorCopy,
  type RpcErrorLike, SQL_ERROR_COPY,
} from "./state";

/**
 * Trade server actions (docs/V2_ARCHITECTURE.md §2.4–2.5, §3.4–3.8, §8, §12.2). Each one: schema gate first (§13.10),
 * then zod validation with field-level copy, then one RPC with the user's session (the database re-checks ownership,
 * state and idempotency), then revalidation of the affected routes. Errors are mapped from the stable SQL code prefix
 * to human copy; `unstable_rethrow` runs first in every catch so redirects and other framework signals pass through.
 *
 * Form contracts (FormData field names):
 * - createPlannedTrade: accountId, requestKey, riskPlanId, observationId, proposal (JSON, the 11 proposal keys)
 * - reviseDraft: tradeId, requestKey, expectedRevision, riskPlanId, observationId, proposal (JSON)
 * - duplicateDraft: tradeId, requestKey, riskPlanId?, observationId? (current account state when omitted)
 * - discardDraft: tradeId, reason?, requestKey?
 * - checkRisk: tradeId · lockPlan: tradeId, expectedRevision
 * - recordEntry: tradeId, entry, quantity, enteredAt? (ISO with zone, or "now"; now when empty), confirmOversize
 * - closePlannedTrade: tradeId, exit, exitedAt? (ISO or "now"; now when empty), fees? (default 0)
 * - setDisposition: tradeId, status (SKIPPED|CANCELLED), reason
 * - recordLiveTrade: accountId, requestKey, instrumentId? | symbol?, direction, entryModel?, entryPrice?,
 *   enteredAt? ("now", ISO with zone, or empty = unknown), quantity?, initialStop?, riskAmount?
 * - completeLiveEntry: tradeId, requestKey, instrumentId?, entryModel?, entryPrice?, enteredAt?, quantity?, initialStop?, riskAmount?
 * - closeLiveTrade: tradeId, exitPrice?, exitedAt? (ISO or "now"; now when empty), fees?, netPnl?
 * - setTags: tradeId, grade?, liquidity?, mss?, tags (repeated or comma-separated)
 * - completeReview: tradeId, requestKey? · reopenReview: tradeId, reason?, requestKey?
 * - removeEvidence: evidenceId, kind (V2|LEGACY) · relabelEvidence: evidenceId, label, timeframe?, caption?
 *
 * "now" (and an empty entry or exit time where it defaults to now) is resolved on the server, never from the browser
 * clock. Submitting the same form again (a double click, or a retry after a lost response) replays the first
 * submission exactly, so forms keep their requestKey until they see a result (see `replayResolvedTime`).
 */

const D = Decimal.clone({ precision: 60 });
const uuid = z.uuid();
const POSITIVE = /^\d{1,12}(\.\d{1,8})?$/;
const FEES = /^\d{1,12}(\.\d{1,2})?$/;
const SIGNED_MONEY = /^-?\d{1,12}(\.\d{1,2})?$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;
const TAG = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

// `abort` stops at a failed format check so the refinement only parses well-formed numbers.
const positiveDecimal = z.string().trim().regex(POSITIVE, { abort: true }).refine(value => new D(value).gt(0));
const optionalPositive = positiveDecimal.optional();
const reason = z.string().trim().min(1).max(5000);

const FIELD_COPY = {
  accountId: "Choose a trading account.",
  tradeId: "This trade isn't available. Reload the page.",
  requestKey: "Reload the page and submit the form again.",
  riskPlanId: "Reload the page: the account's risk plan could not be confirmed.",
  observationId: "Reload the page: the account values could not be confirmed.",
  expectedRevision: "Reload the page to edit the latest revision.",
  proposal: "Complete the plan: instrument, direction, model, prices, risk, thesis and checks.",
  entry: "Entry price must be a positive number with up to 8 decimals.",
  exit: "Exit price must be a positive number with up to 8 decimals.",
  quantity: "Size must be a positive number with up to 8 decimals.",
  enteredAt: "Enter the entry time with a date and time zone, or leave it as now.",
  exitedAt: "Enter the exit time with a date and time zone, or leave it as now.",
  fees: "Fees must be zero or a positive amount with up to 2 decimals.",
  status: "Choose Skip or Cancel.",
  reason: "Add a reason (up to 5,000 characters).",
  instrumentId: "Choose an instrument from this trading account.",
  symbol: "Use 1 to 20 capital letters, digits or . _ / - for the symbol.",
  direction: "Choose a direction: long or short.",
  entryModel: "Choose an entry model.",
  entryPrice: "Entry price must be a positive number with up to 8 decimals.",
  initialStop: "Stop must be a positive number with up to 8 decimals.",
  riskAmount: "Risk must be a positive amount with up to 2 decimals.",
  exitPrice: "Exit price must be a positive number with up to 8 decimals.",
  netPnl: "Net P&L must be an amount with up to 2 decimals (negative for a loss).",
  grade: "Choose a setup grade.",
  liquidity: "Choose a liquidity context.",
  mss: "Choose an MSS timeframe.",
  tags: "Use at most 12 different tags of 1 to 32 characters (a-z, 0-9, space, _ or -).",
  evidenceId: "That screenshot isn't available. Reload the page.",
  kind: "That screenshot isn't available. Reload the page.",
  label: "Choose a label.",
  timeframe: "Choose a timeframe.",
  caption: "Keep the caption to 200 characters.",
  confirmOversize: "Confirm the size deviation to record this entry.",
} as const satisfies Record<string, string>;

type FieldName = keyof typeof FIELD_COPY;

function fieldErrors(error: z.ZodError, fallback: FieldName): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? fallback);
    errors[key] = Object.hasOwn(FIELD_COPY, key) ? FIELD_COPY[key as FieldName] : FIELD_COPY[fallback];
  }
  return errors;
}

/** Copy for a failed RPC; unknown failures are logged with a fixed event only. */
function rpcFailure<T>(error: RpcErrorLike, overrides: Readonly<Record<string, string>> = {}, fields: readonly string[] = []): ActionState<T> {
  const message = rpcErrorCopy(error, overrides);
  if (message === FAILED_COPY) operationalFailure("database_write_failed");
  const field = invalidField(error, fields);
  return actionError(message, field && Object.hasOwn(FIELD_COPY, field) ? { [field]: FIELD_COPY[field as FieldName] } : undefined);
}

function unexpected<T>(error: unknown): ActionState<T> {
  unstable_rethrow(error);
  operationalFailure("database_write_failed");
  return actionError(FAILED_COPY);
}

function revalidateTrade(tradeId: string, extra: readonly string[] = []): void {
  revalidatePath(`/trades/${tradeId}`);
  revalidatePath("/today");
  revalidatePath("/journal");
  for (const path of extra) revalidatePath(path);
}

/**
 * An instant field: empty → `fallback`, "now" → the server's current time, else an ISO 8601 timestamp with a zone.
 * `resolved` marks a time the server chose (a default), as opposed to a time the trader reported.
 */
type InstantField = { ok: true; value: string | null; resolved: boolean } | { ok: false };

function instantField(value: string | undefined, fallback: "now" | "unknown"): InstantField {
  const text = value?.trim() ?? "";
  if (text === "") return fallback === "now" ? { ok: true, value: new Date().toISOString(), resolved: true } : { ok: true, value: null, resolved: false };
  if (text.toLowerCase() === "now") return { ok: true, value: new Date().toISOString(), resolved: true };
  return isInstant(text) ? { ok: true, value: text, resolved: false } : { ok: false };
}

interface RpcResponse {
  data: unknown;
  error: RpcErrorLike | null;
}

/**
 * Replays a submission whose time the server resolved. "Now" resolves to a new instant on every request. When the same
 * form is submitted twice (a double click, or a retry after a lost response), the database would see two different
 * times and refuse the second request although the first one was recorded. A server-resolved time is a default, not a
 * time the trader reported. So when the database answers `recordedCode` (the record already exists), the call runs once
 * more with the recorded instant. The database still compares every reported value (prices, size, fees, P&L, account)
 * exactly: a resubmission with other values keeps its error, and an exact one returns the original record.
 */
async function replayResolvedTime(
  first: RpcResponse,
  time: { resolved: boolean },
  recordedCode: "IDEMPOTENCY_CONFLICT" | "ENTRY_ALREADY_RECORDED" | "ALREADY_CLOSED",
  recordedInstant: () => Promise<string | null>,
  call: (instant: string) => PromiseLike<RpcResponse>,
): Promise<RpcResponse> {
  if (!first.error || !time.resolved || errorCode(first.error) !== recordedCode) return first;
  const recorded = await recordedInstant();
  return recorded === null ? first : call(recorded);
}

const recordedInstantText = z.string().refine(isInstant).nullable();
const recordedTimesRow = z.object({ entered_at: recordedInstantText, exited_at: recordedInstantText });

/** The recorded entry and exit times of a trade (`trade_ledger`); null when the trade can't be read. */
async function recordedTimes(db: Db, tradeId: string): Promise<{ enteredAt: string | null; exitedAt: string | null } | null> {
  const { data, error } = await db.from("trade_ledger").select("entered_at,exited_at").eq("id", tradeId).maybeSingle();
  if (error || !data) return null;
  const row = recordedTimesRow.safeParse(data);
  return row.success ? { enteredAt: row.data.entered_at, exitedAt: row.data.exited_at } : null;
}

/** The entry time recorded by the live trade created under `requestKey` (its first facts row carries the key), or null. */
async function recordedLiveEntryTime(db: Db, userId: string, requestKey: string): Promise<string | null> {
  const { data, error } = await db.from("trade_position_facts").select("entered_at").eq("user_id", userId).eq("request_key", requestKey).maybeSingle();
  if (error || !data) return null;
  const row = z.object({ entered_at: recordedInstantText }).safeParse(data);
  return row.success ? row.data.entered_at : null;
}

function parseProposal(raw: string | undefined): { ok: true; proposal: Proposal } | { ok: false; fieldErrors: Record<string, string> } {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    return { ok: false, fieldErrors: { proposal: FIELD_COPY.proposal } };
  }
  const parsed = proposalSchema.safeParse(value);
  if (parsed.success) return { ok: true, proposal: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "proposal");
    errors[key] = INVALID_INPUT_FIELD_COPY[key] ?? FIELD_COPY.proposal;
  }
  return { ok: false, fieldErrors: errors };
}

const draftEnvelope = z.object({ tradeId: z.uuid(), proposalId: z.uuid(), revision: z.number().int().positive(), evaluationId: z.uuid(), result: z.unknown() });

function draftOutcome(data: unknown): { tradeId: string; revision: number; decision: "APPROVED" | "BLOCKED"; firstReason: string | null } {
  const envelope = draftEnvelope.parse(data);
  const report = storedRiskSchema.parse(envelope.result);
  const explained = explainReport(report);
  return { tradeId: envelope.tradeId, revision: envelope.revision, decision: explained.decision, firstReason: explained.blocking[0]?.detail ?? null };
}

function draftMessage(saved: string, decision: "APPROVED" | "BLOCKED", firstReason: string | null): string {
  return decision === "APPROVED" ? `${saved} The free risk check approved it.` : `${saved} Risk check: Blocked — ${firstReason ?? "see the reasons on the trade page."}`;
}

/** The account a new trade is written to must be the user's and active (archived accounts take no new trades). */
async function writableAccount(session: Session, accountId: string): Promise<ActionState<never> | null> {
  const account = await loadAccount(session.db, session.user.id, accountId);
  if (!account) return actionError("That trading account isn't available.", { accountId: FIELD_COPY.accountId });
  if (account.status === "ARCHIVED") {
    return actionError("This trading account is archived. Restore it in Manage account before planning or recording trades.", { accountId: FIELD_COPY.accountId });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Drafts (§3.4, §8.1).
// ---------------------------------------------------------------------------------------------------------
export interface DraftResult {
  tradeId: string;
  revision: number;
  decision: "APPROVED" | "BLOCKED";
}

const createInput = z.object({ accountId: uuid, requestKey: uuid, riskPlanId: uuid, observationId: uuid });

export async function createPlannedTrade(_prev: ActionState<DraftResult>, form: FormData): Promise<ActionState<DraftResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = createInput.safeParse({
      accountId: formText(form, "accountId"), requestKey: formText(form, "requestKey"), riskPlanId: formText(form, "riskPlanId"), observationId: formText(form, "observationId"),
    });
    const proposal = parseProposal(formText(form, "proposal"));
    if (!input.success || !proposal.ok) {
      return actionError(INVALID_COPY, { ...(input.success ? {} : fieldErrors(input.error, "proposal")), ...(proposal.ok ? {} : proposal.fieldErrors) });
    }
    const blocked = await writableAccount(session, input.data.accountId);
    if (blocked) return blocked;
    const { data, error } = await session.db.rpc("create_planned_trade", {
      p_account_id: input.data.accountId, p_proposal: proposal.proposal, p_request_key: input.data.requestKey,
      p_expected_risk_id: input.data.riskPlanId, p_expected_observation_id: input.data.observationId,
    });
    if (error) return rpcFailure(error, {}, ["instrumentId"]);
    const outcome = draftOutcome(data);
    await setContextCookie(LAST_ACCOUNT_COOKIE, input.data.accountId);
    revalidateTrade(outcome.tradeId);
    return actionSuccess(draftMessage("Draft saved.", outcome.decision, outcome.firstReason), { tradeId: outcome.tradeId, revision: outcome.revision, decision: outcome.decision });
  } catch (error) {
    return unexpected(error);
  }
}

const reviseInput = z.object({ tradeId: uuid, requestKey: uuid, expectedRevision: z.coerce.number().int().positive(), riskPlanId: uuid, observationId: uuid });

export async function reviseDraft(_prev: ActionState<DraftResult>, form: FormData): Promise<ActionState<DraftResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = reviseInput.safeParse({
      tradeId: formText(form, "tradeId"), requestKey: formText(form, "requestKey"), expectedRevision: formText(form, "expectedRevision"),
      riskPlanId: formText(form, "riskPlanId"), observationId: formText(form, "observationId"),
    });
    const proposal = parseProposal(formText(form, "proposal"));
    if (!input.success || !proposal.ok) {
      return actionError(INVALID_COPY, { ...(input.success ? {} : fieldErrors(input.error, "proposal")), ...(proposal.ok ? {} : proposal.fieldErrors) });
    }
    const { data, error } = await session.db.rpc("revise_trade_draft", {
      p_trade_id: input.data.tradeId, p_proposal: proposal.proposal, p_request_key: input.data.requestKey, p_expected_revision: input.data.expectedRevision,
      p_expected_risk_id: input.data.riskPlanId, p_expected_observation_id: input.data.observationId,
    });
    if (error) return rpcFailure(error, { DRAFT_NOT_EDITABLE: "Only drafts can be edited. Locked plans can't change; later changes go in the journal." }, ["instrumentId"]);
    const outcome = draftOutcome(data);
    revalidateTrade(outcome.tradeId, [`/trades/${outcome.tradeId}/edit`]);
    return actionSuccess(draftMessage(`Saved as revision ${outcome.revision}.`, outcome.decision, outcome.firstReason), {
      tradeId: outcome.tradeId, revision: outcome.revision, decision: outcome.decision,
    });
  } catch (error) {
    return unexpected(error);
  }
}

export interface DuplicateResult {
  tradeId: string;
  /** Before-entry screenshots copied to the new draft. */
  copiedEvidence: number;
  /** Screenshots that could not be copied (limit reached or unavailable bytes). */
  evidenceNotCopied: number;
}

const duplicateInput = z.object({ tradeId: uuid, requestKey: uuid, riskPlanId: uuid.optional(), observationId: uuid.optional() });

export async function duplicateDraft(_prev: ActionState<DuplicateResult>, form: FormData): Promise<ActionState<DuplicateResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = duplicateInput.safeParse({
      tradeId: formText(form, "tradeId"), requestKey: formText(form, "requestKey"), riskPlanId: formOptional(form, "riskPlanId"),
      observationId: formOptional(form, "observationId"),
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tradeId"));
    const { db, user } = session;
    const source = await db.from("trades").select("account_id").eq("id", input.data.tradeId).eq("user_id", user.id).maybeSingle();
    if (source.error) return actionError(FAILED_COPY);
    const accountId = source.data ? z.object({ account_id: z.uuid() }).parse(source.data).account_id : null;
    if (!accountId) return actionError("That trade isn't available.");
    const blocked = await writableAccount(session, accountId);
    if (blocked) return blocked;
    // No preview precedes a duplicate: its free check runs against the account's current risk plan and values.
    const [riskPlan, observation] = input.data.riskPlanId && input.data.observationId
      ? [{ id: input.data.riskPlanId }, { id: input.data.observationId }]
      : await Promise.all([loadActiveRiskPlan(db, user.id, accountId, strategyDay(new Date())), loadLatestObservation(db, user.id, accountId)]);
    if (!riskPlan || !observation) return actionError(SQL_ERROR_COPY.ACCOUNT_INCOMPLETE);
    const { data, error } = await db.rpc("duplicate_trade_draft", {
      p_trade_id: input.data.tradeId, p_request_key: input.data.requestKey, p_expected_risk_id: riskPlan.id, p_expected_observation_id: observation.id,
    });
    if (error) return rpcFailure(error);
    const created = z.object({ tradeId: z.uuid(), proposalId: z.uuid() }).parse(data);
    let copied = 0;
    let notCopied = 0;
    try {
      const copy = await copyEvidenceForDuplicate(input.data.tradeId, created.tradeId);
      copied = copy.copied;
      notCopied = copy.skipped + copy.failed;
    } catch (copyError) {
      unstable_rethrow(copyError);
      operationalFailure("storage_upload_failed", 503);
      notCopied = -1;
    }
    revalidateTrade(created.tradeId, [`/trades/${input.data.tradeId}`]);
    const message = notCopied === -1
      ? "Draft duplicated. Its screenshots could not be copied; add them again on the new draft."
      : notCopied > 0
        ? `Draft duplicated with ${copied} pre-entry screenshot${copied === 1 ? "" : "s"}. ${notCopied} could not be copied.`
        : `Draft duplicated${copied ? ` with ${copied} pre-entry screenshot${copied === 1 ? "" : "s"}` : ""}. News is reset to "Not checked".`;
    return actionSuccess(message, { tradeId: created.tradeId, copiedEvidence: copied, evidenceNotCopied: Math.max(0, notCopied) });
  } catch (error) {
    return unexpected(error);
  }
}

const discardInput = z.object({ tradeId: uuid, reason: z.string().trim().max(2000).optional(), requestKey: uuid.optional() });

export async function discardDraft(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = discardInput.safeParse({ tradeId: formText(form, "tradeId"), reason: formOptional(form, "reason"), requestKey: formOptional(form, "requestKey") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tradeId"));
    const { error } = await session.db.rpc("discard_trade_draft", {
      p_trade_id: input.data.tradeId, p_reason: input.data.reason ?? null, p_request_key: input.data.requestKey ?? null,
    });
    if (error) return rpcFailure(error, { DRAFT_NOT_EDITABLE: "Only drafts can be discarded." });
    revalidateTrade(input.data.tradeId);
    return actionSuccess("Draft discarded. Its history stays in the journal.");
  } catch (error) {
    return unexpected(error);
  }
}

const checkEnvelope = z.object({ planId: z.uuid().nullable(), evaluationId: z.uuid(), result: z.unknown(), replayed: z.boolean(), tradeId: z.uuid() });

export interface CheckResult {
  decision: "APPROVED" | "BLOCKED";
}

export async function checkRisk(_prev: ActionState<CheckResult>, form: FormData): Promise<ActionState<CheckResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const tradeId = uuid.safeParse(formText(form, "tradeId"));
    if (!tradeId.success) return actionError(INVALID_COPY, { tradeId: FIELD_COPY.tradeId });
    const { data, error } = await session.db.rpc("check_trade_risk", { p_trade_id: tradeId.data });
    if (error) return rpcFailure(error, { DRAFT_NOT_EDITABLE: "Only drafts can be checked. Locked plans were checked when they were locked." });
    const envelope = checkEnvelope.parse(data);
    const explained = explainReport(storedRiskSchema.parse(envelope.result));
    revalidateTrade(tradeId.data);
    return actionSuccess(
      explained.decision === "APPROVED" ? "Risk check: Approved. The plan is ready to lock." : `Risk check: Blocked — ${explained.blocking[0]?.detail ?? "see the reasons on the trade page."}`,
      { decision: explained.decision },
    );
  } catch (error) {
    return unexpected(error);
  }
}

const lockInput = z.object({ tradeId: uuid, expectedRevision: z.coerce.number().int().positive() });

export interface LockResult {
  locked: true;
}

export async function lockPlan(_prev: ActionState<LockResult>, form: FormData): Promise<ActionState<LockResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = lockInput.safeParse({ tradeId: formText(form, "tradeId"), expectedRevision: formText(form, "expectedRevision") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tradeId"));
    const { data, error } = await session.db.rpc("lock_trade", { p_trade_id: input.data.tradeId, p_expected_revision: input.data.expectedRevision });
    if (error) return rpcFailure(error, { DRAFT_NOT_EDITABLE: "Only drafts can be locked." });
    const envelope = checkEnvelope.parse(data);
    revalidateTrade(input.data.tradeId, ["/edge"]);
    if (envelope.planId === null) {
      const explained = explainReport(storedRiskSchema.parse(envelope.result));
      return actionError(`Not locked. Risk check: Blocked — ${explained.blocking[0]?.detail ?? "see the reasons on the trade page."}`);
    }
    return actionSuccess("Plan locked. Its values can no longer change; record the entry when you take the trade.", { locked: true });
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Planned execution (§3.4, §8.5).
// ---------------------------------------------------------------------------------------------------------
export interface EntryResult {
  oversize: boolean;
  plannedQuantity: string;
  actualQuantity: string;
}

const entryInput = z.object({ tradeId: uuid, entry: positiveDecimal, quantity: positiveDecimal });
const plannedRow = z.object({ planned_quantity: z.string().nullable(), instrument_version_id: z.uuid().nullable() });

export async function recordEntry(_prev: ActionState<EntryResult>, form: FormData): Promise<ActionState<EntryResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = entryInput.safeParse({ tradeId: formText(form, "tradeId"), entry: formText(form, "entry"), quantity: formText(form, "quantity") });
    const enteredAt = instantField(formText(form, "enteredAt"), "now");
    if (!input.success || !enteredAt.ok) {
      return actionError(INVALID_COPY, { ...(input.success ? {} : fieldErrors(input.error, "entry")), ...(enteredAt.ok ? {} : { enteredAt: FIELD_COPY.enteredAt }) });
    }
    const { db, user } = session;
    // §8.5: a size above the plan is recorded only after the trader confirmed the deviation.
    const plan = await db.from("trade_ledger").select("planned_quantity,instrument_version_id").eq("id", input.data.tradeId).maybeSingle();
    if (plan.error) return actionError(FAILED_COPY);
    const planned = plan.data ? plannedRow.parse(plan.data) : null;
    if (planned?.planned_quantity && new D(input.data.quantity).gt(planned.planned_quantity) && !formFlag(form, "confirmOversize")) {
      let step: string | null = null;
      if (planned.instrument_version_id) {
        const instrument = await db.from("instrument_versions").select("quantity_step::text").eq("id", planned.instrument_version_id).eq("user_id", user.id).maybeSingle();
        step = instrument.data ? z.object({ quantity_step: z.string() }).parse(instrument.data).quantity_step : null;
      }
      const warning = sizeDeviationWarning(input.data.quantity, planned.planned_quantity, step) ?? FIELD_COPY.confirmOversize;
      return actionError(warning, { confirmOversize: warning });
    }
    const record = (at: string | null) => db.rpc("record_planned_entry", {
      p_trade_id: input.data.tradeId, p_entry: input.data.entry, p_quantity: input.data.quantity, p_entered_at: at,
    });
    const { data, error } = await replayResolvedTime(
      await record(enteredAt.value), enteredAt, "ENTRY_ALREADY_RECORDED", async () => (await recordedTimes(db, input.data.tradeId))?.enteredAt ?? null, record,
    );
    if (error) return rpcFailure(error);
    const result = z.object({ executionId: z.uuid(), oversize: z.boolean(), plannedQuantity: z.string(), actualQuantity: z.string() }).parse(data);
    revalidateTrade(input.data.tradeId, ["/accounts"]);
    return actionSuccess(result.oversize ? "Entry recorded with a size deviation. The trade is live." : "Entry recorded. The trade is live.", {
      oversize: result.oversize, plannedQuantity: result.plannedQuantity, actualQuantity: result.actualQuantity,
    });
  } catch (error) {
    return unexpected(error);
  }
}

export interface CloseResult {
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  netPnl: string;
  /** Null when no risk basis exists (live-first trades without recorded risk). */
  realizedR: string | null;
}

const closePlannedInput = z.object({ tradeId: uuid, exit: positiveDecimal, fees: z.string().trim().regex(FEES) });

export async function closePlannedTrade(_prev: ActionState<CloseResult>, form: FormData): Promise<ActionState<CloseResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = closePlannedInput.safeParse({ tradeId: formText(form, "tradeId"), exit: formText(form, "exit"), fees: formOptional(form, "fees") ?? "0" });
    const exitedAt = instantField(formText(form, "exitedAt"), "now");
    if (!input.success || !exitedAt.ok) {
      return actionError(INVALID_COPY, { ...(input.success ? {} : fieldErrors(input.error, "exit")), ...(exitedAt.ok ? {} : { exitedAt: FIELD_COPY.exitedAt }) });
    }
    const { db } = session;
    const close = (at: string | null) => db.rpc("close_planned_trade", {
      p_trade_id: input.data.tradeId, p_exit: input.data.exit, p_exited_at: at, p_fees: input.data.fees,
    });
    const { data, error } = await replayResolvedTime(
      await close(exitedAt.value), exitedAt, "ALREADY_CLOSED", async () => (await recordedTimes(db, input.data.tradeId))?.exitedAt ?? null, close,
    );
    if (error) return rpcFailure(error);
    const result = z.object({ outcome: z.enum(["WIN", "LOSS", "BREAKEVEN"]), netPnl: z.string(), realizedR: z.string() }).parse(data);
    revalidateTrade(input.data.tradeId, ["/edge", "/accounts"]);
    return actionSuccess("Trade closed. Write your review while it is fresh.", { outcome: result.outcome, netPnl: result.netPnl, realizedR: result.realizedR });
  } catch (error) {
    return unexpected(error);
  }
}

const dispositionInput = z.object({ tradeId: uuid, status: z.enum(["SKIPPED", "CANCELLED"]), reason });

export async function setDisposition(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = dispositionInput.safeParse({ tradeId: formText(form, "tradeId"), status: formText(form, "status"), reason: formText(form, "reason") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "reason"));
    const { error } = await session.db.rpc("set_planned_disposition", { p_trade_id: input.data.tradeId, p_status: input.data.status, p_reason: input.data.reason });
    if (error) return rpcFailure(error);
    revalidateTrade(input.data.tradeId);
    return actionSuccess(input.data.status === "SKIPPED" ? "Trade skipped. The plan and its reason stay in the history." : "Plan cancelled. The plan and its reason stay in the history.");
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Live-first trades (§3.5, §8.2).
// ---------------------------------------------------------------------------------------------------------
type LiveField = "instrumentId" | "symbol" | "direction" | "entryModel" | "entryPrice" | "enteredAt" | "quantity" | "initialStop" | "riskAmount";

/**
 * The live-trade JSON input of the present fields; empty fields are left out (unknown). `resolvedTime` is true when
 * the entry time is "now", resolved on the server.
 */
function liveInput(
  form: FormData, allowed: readonly LiveField[],
): { ok: true; input: Record<string, string>; resolvedTime: boolean } | { ok: false; fieldErrors: Record<string, string> } {
  const input: Record<string, string> = {};
  const errors: Record<string, string> = {};
  let resolvedTime = false;
  for (const key of allowed) {
    const raw = formOptional(form, key);
    if (raw === undefined) continue;
    switch (key) {
      case "instrumentId":
        if (uuid.safeParse(raw.toLowerCase()).success) input.instrumentId = raw.toLowerCase();
        else errors.instrumentId = FIELD_COPY.instrumentId;
        break;
      case "symbol": {
        const symbol = raw.toUpperCase();
        if (SYMBOL.test(symbol)) input.symbol = symbol;
        else errors.symbol = FIELD_COPY.symbol;
        break;
      }
      case "direction":
        if (raw === "LONG" || raw === "SHORT") input.direction = raw;
        else errors.direction = FIELD_COPY.direction;
        break;
      case "entryModel":
        if (raw === "OB_FIRST_TOUCH" || raw === "OTE" || raw === "OTHER") input.entryModel = raw;
        else errors.entryModel = FIELD_COPY.entryModel;
        break;
      case "enteredAt": {
        const instant = instantField(raw, "unknown");
        if (instant.ok && instant.value !== null) {
          input.enteredAt = instant.value;
          resolvedTime = instant.resolved;
        } else {
          errors.enteredAt = FIELD_COPY.enteredAt;
        }
        break;
      }
      case "riskAmount":
        if (FEES.test(raw) && new D(raw).gt(0)) input.riskAmount = raw;
        else errors.riskAmount = FIELD_COPY.riskAmount;
        break;
      default:
        if (positiveDecimal.safeParse(raw).success) input[key] = raw;
        else errors[key] = FIELD_COPY[key];
    }
  }
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, input, resolvedTime };
}

const LIVE_FIELDS: readonly LiveField[] = ["instrumentId", "symbol", "direction", "entryModel", "entryPrice", "enteredAt", "quantity", "initialStop", "riskAmount"];
const LIVE_SQL_FIELDS = ["instrumentId", "symbol", "direction", "entryModel", "entryPrice", "enteredAt", "quantity", "initialStop", "riskAmount"];
/**
 * The request key already recorded a live trade with other details. Reloading would issue a new key and record a
 * second position that counts toward today's trade and risk limits, so the copy sends the trader to the recorded one.
 */
const LIVE_TRADE_CONFLICT_COPY = "This form already recorded a live trade with other details. Open it from Today instead of recording it again.";

export interface LiveTradeResult {
  tradeId: string;
}

export async function recordLiveTrade(_prev: ActionState<LiveTradeResult>, form: FormData): Promise<ActionState<LiveTradeResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const ids = z.object({ accountId: uuid, requestKey: uuid }).safeParse({ accountId: formText(form, "accountId"), requestKey: formText(form, "requestKey") });
    const fields = liveInput(form, LIVE_FIELDS);
    const errors: Record<string, string> = { ...(ids.success ? {} : fieldErrors(ids.error, "accountId")), ...(fields.ok ? {} : fields.fieldErrors) };
    if (fields.ok && !fields.input.direction) errors.direction = FIELD_COPY.direction;
    if (fields.ok && !fields.input.instrumentId && !fields.input.symbol) errors.instrumentId = "Choose an instrument or enter the symbol.";
    if (!ids.success || !fields.ok || Object.keys(errors).length) return actionError(INVALID_COPY, errors);
    const blocked = await writableAccount(session, ids.data.accountId);
    if (blocked) return blocked;
    // A chosen instrument names the symbol itself; "Other symbol" applies only without one.
    const { symbol, ...withInstrument } = fields.input;
    const input = fields.input.instrumentId ? withInstrument : { ...withInstrument, symbol };
    const { db, user } = session;
    const record = (values: Record<string, string>) => db.rpc("record_live_trade", { p_account_id: ids.data.accountId, p_input: values, p_request_key: ids.data.requestKey });
    const { data, error } = await replayResolvedTime(
      await record(input), { resolved: fields.resolvedTime }, "IDEMPOTENCY_CONFLICT", () => recordedLiveEntryTime(db, user.id, ids.data.requestKey),
      enteredAt => record({ ...input, enteredAt }),
    );
    if (error) return rpcFailure(error, { IDEMPOTENCY_CONFLICT: LIVE_TRADE_CONFLICT_COPY }, LIVE_SQL_FIELDS);
    const tradeId = uuid.parse(data);
    await setContextCookie(LAST_ACCOUNT_COOKIE, ids.data.accountId);
    revalidateTrade(tradeId, ["/accounts"]);
    return actionSuccess("Live trade recorded. Add notes and screenshots while it runs.", { tradeId });
  } catch (error) {
    return unexpected(error);
  }
}

export async function completeLiveEntry(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const ids = z.object({ tradeId: uuid, requestKey: uuid }).safeParse({ tradeId: formText(form, "tradeId"), requestKey: formText(form, "requestKey") });
    const fields = liveInput(form, ["instrumentId", "entryModel", "entryPrice", "enteredAt", "quantity", "initialStop", "riskAmount"]);
    if (!ids.success || !fields.ok) return actionError(INVALID_COPY, { ...(ids.success ? {} : fieldErrors(ids.error, "tradeId")), ...(fields.ok ? {} : fields.fieldErrors) });
    if (!Object.keys(fields.input).length) return actionError("Add at least one missing entry detail.");
    const { error } = await session.db.rpc("complete_live_entry", { p_trade_id: ids.data.tradeId, p_input: fields.input, p_request_key: ids.data.requestKey });
    if (error) return rpcFailure(error, { ALREADY_CLOSED: "Entry details of a closed trade can't change." }, LIVE_SQL_FIELDS);
    revalidateTrade(ids.data.tradeId, ["/accounts"]);
    return actionSuccess("Entry details added. Recorded details can't be changed later.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function closeLiveTrade(_prev: ActionState<CloseResult>, form: FormData): Promise<ActionState<CloseResult>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const tradeId = uuid.safeParse(formText(form, "tradeId"));
    const exitPrice = optionalPositive.safeParse(formOptional(form, "exitPrice"));
    const exitedAt = instantField(formText(form, "exitedAt"), "now");
    const fees = formOptional(form, "fees");
    const netPnl = formOptional(form, "netPnl");
    const errors: Record<string, string> = {};
    if (!tradeId.success) errors.tradeId = FIELD_COPY.tradeId;
    if (!exitPrice.success) errors.exitPrice = FIELD_COPY.exitPrice;
    if (!exitedAt.ok) errors.exitedAt = FIELD_COPY.exitedAt;
    if (fees !== undefined && !FEES.test(fees)) errors.fees = FIELD_COPY.fees;
    if (netPnl !== undefined && !SIGNED_MONEY.test(netPnl)) errors.netPnl = FIELD_COPY.netPnl;
    if (!tradeId.success || !exitPrice.success || !exitedAt.ok || Object.keys(errors).length) return actionError(INVALID_COPY, errors);
    const { db } = session;
    const close = (at: string | null) => db.rpc("close_live_trade", {
      p_trade_id: tradeId.data,
      p_input: { ...(exitPrice.data ? { exitPrice: exitPrice.data } : {}), exitedAt: at, ...(fees !== undefined ? { fees } : {}), ...(netPnl !== undefined ? { netPnl } : {}) },
    });
    const { error } = await replayResolvedTime(
      await close(exitedAt.value), exitedAt, "ALREADY_CLOSED", async () => (await recordedTimes(db, tradeId.data))?.exitedAt ?? null, close,
    );
    if (error) return rpcFailure(error, {}, ["exitPrice", "exitedAt", "fees", "netPnl"]);
    const closed = await db.from("trade_ledger").select("outcome,net_pnl,realized_r").eq("id", tradeId.data).maybeSingle();
    const result = closed.data ? z.object({ outcome: z.enum(["WIN", "LOSS", "BREAKEVEN"]), net_pnl: z.string(), realized_r: z.string().nullable() }).safeParse(closed.data) : null;
    revalidateTrade(tradeId.data, ["/edge", "/accounts"]);
    return actionSuccess("Trade closed. Write your review while it is fresh.", result?.success
      ? { outcome: result.data.outcome, netPnl: result.data.net_pnl, realizedR: result.data.realized_r }
      : undefined);
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Tags and review (§3.8, §2.2).
// ---------------------------------------------------------------------------------------------------------
const GRADES = ["A+", "A", "B", "C", "INVALID"] as const;
const LIQUIDITY = ["ARL_HIGH", "ARL_LOW", "PDH", "PDL", "PWH", "PWL", "KZ_HIGH", "KZ_LOW", "EQUAL_HIGHS", "EQUAL_LOWS", "OTHER"] as const;
const tagsInput = z.object({
  tradeId: uuid, grade: z.enum(GRADES).nullable(), liquidity: z.enum(LIQUIDITY).nullable(), mss: z.enum(["M15", "M5", "M3"]).nullable(),
  tags: z.array(z.string().regex(TAG)).max(12).refine(tags => new Set(tags).size === tags.length),
});

export async function setTags(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const tags = [...new Set(formList(form, "tags").flatMap(value => value.split(",")).map(tag => tag.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
    const input = tagsInput.safeParse({
      tradeId: formText(form, "tradeId"), grade: formOptional(form, "grade") ?? null, liquidity: formOptional(form, "liquidity") ?? null,
      mss: formOptional(form, "mss") ?? null, tags,
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tags"));
    const { error } = await session.db.rpc("set_trade_tags", {
      p_trade_id: input.data.tradeId, p_grade: input.data.grade, p_liquidity: input.data.liquidity, p_mss: input.data.mss, p_tags: input.data.tags,
    });
    if (error) return rpcFailure(error);
    revalidateTrade(input.data.tradeId, ["/edge"]);
    return actionSuccess("Tags saved.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function completeReview(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = z.object({ tradeId: uuid, requestKey: uuid.optional() }).safeParse({ tradeId: formText(form, "tradeId"), requestKey: formOptional(form, "requestKey") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tradeId"));
    const { error } = await session.db.rpc("complete_trade_review", { p_trade_id: input.data.tradeId, p_request_key: input.data.requestKey ?? null });
    if (error) return rpcFailure(error);
    revalidateTrade(input.data.tradeId);
    return actionSuccess("Marked reviewed.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function reopenReview(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = z.object({ tradeId: uuid, reason: z.string().trim().max(2000).optional(), requestKey: uuid.optional() })
      .safeParse({ tradeId: formText(form, "tradeId"), reason: formOptional(form, "reason"), requestKey: formOptional(form, "requestKey") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "tradeId"));
    const { error } = await session.db.rpc("reopen_trade_review", { p_trade_id: input.data.tradeId, p_reason: input.data.reason ?? null, p_request_key: input.data.requestKey ?? null });
    if (error) return rpcFailure(error);
    revalidateTrade(input.data.tradeId);
    return actionSuccess("Review reopened.");
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Evidence (§2.5, §3.7, §7.5): soft, audited remove and relabel in every state.
// ---------------------------------------------------------------------------------------------------------
export async function removeEvidence(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = z.object({ evidenceId: uuid, kind: z.enum(["V2", "LEGACY"]) }).safeParse({ evidenceId: formText(form, "evidenceId")?.toLowerCase(), kind: formText(form, "kind") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "evidenceId"));
    const { db, user } = session;
    let tradeId: string | null = null;
    if (input.data.kind === "V2") {
      const owner = await db.from("trade_evidence").select("trade_id").eq("id", input.data.evidenceId).eq("user_id", user.id).maybeSingle();
      if (owner.error) return actionError(FAILED_COPY);
      tradeId = owner.data ? z.object({ trade_id: z.uuid() }).parse(owner.data).trade_id : null;
    } else {
      const owner = await db.from("setup_screenshots").select("proposal_id").eq("id", input.data.evidenceId).eq("user_id", user.id).maybeSingle();
      if (owner.error) return actionError(FAILED_COPY);
      const proposalId = owner.data ? z.object({ proposal_id: z.uuid() }).parse(owner.data).proposal_id : null;
      if (proposalId) {
        const revision = await db.from("trade_revisions").select("trade_id").eq("proposal_id", proposalId).eq("user_id", user.id).maybeSingle();
        if (revision.error) return actionError(FAILED_COPY);
        tradeId = revision.data ? z.object({ trade_id: z.uuid() }).parse(revision.data).trade_id : null;
      }
    }
    if (!tradeId) return actionError("That screenshot isn't available.");
    const { error } = input.data.kind === "V2"
      ? await db.rpc("remove_trade_evidence", { p_evidence_id: input.data.evidenceId })
      : await db.rpc("remove_setup_screenshot", { p_screenshot_id: input.data.evidenceId });
    if (error) return rpcFailure(error);
    revalidateTrade(tradeId);
    return actionSuccess("Screenshot removed. The timeline keeps a record of it.");
  } catch (error) {
    return unexpected(error);
  }
}

const relabelInput = z.object({
  evidenceId: uuid, label: z.enum(EVIDENCE_LABELS), timeframe: z.enum(EVIDENCE_TIMEFRAMES).nullable(), caption: z.string().trim().max(200).nullable(),
});

export async function relabelEvidence(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = relabelInput.safeParse({
      evidenceId: formText(form, "evidenceId")?.toLowerCase(), label: formText(form, "label"), timeframe: formOptional(form, "timeframe") ?? null,
      caption: formOptional(form, "caption") ?? null,
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "label"));
    const { db, user } = session;
    const owner = await db.from("trade_evidence").select("trade_id").eq("id", input.data.evidenceId).eq("user_id", user.id).maybeSingle();
    if (owner.error) return actionError(FAILED_COPY);
    const tradeId = owner.data ? z.object({ trade_id: z.uuid() }).parse(owner.data).trade_id : null;
    if (!tradeId) return actionError("That screenshot isn't available. Legacy screenshots keep their timeframe label.");
    const { error } = await db.rpc("relabel_trade_evidence", {
      p_evidence_id: input.data.evidenceId, p_label: input.data.label, p_timeframe: input.data.timeframe, p_caption: input.data.caption,
    });
    if (error) return rpcFailure(error, {}, ["label", "timeframe", "caption"]);
    revalidateTrade(tradeId);
    return actionSuccess("Label saved. The screenshot keeps its original timing.");
  } catch (error) {
    return unexpected(error);
  }
}
