/**
 * Server action results (docs/V2_ARCHITECTURE.md §12.2). Every V2 action has the signature
 * `(prev: ActionState<T>, form: FormData) => Promise<ActionState<T>>`, works with React `useActionState` and plain
 * `<form action>`, and returns human copy only: SQL errors carry a stable code prefix (`'DRAFT_CHANGED: …'`) that is
 * mapped to the sentences below, never shown raw. This module has no server-only imports, so client components
 * import `ActionState` and `idleState` from it.
 */

export type ActionState<T = undefined> =
  | { status: "idle" }
  | { status: "success"; message?: string; data?: T }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

/** Initial state for `useActionState`. */
export const idleState: { readonly status: "idle" } = Object.freeze({ status: "idle" });

export function actionSuccess<T>(message?: string, data?: T): ActionState<T> {
  return data === undefined ? { status: "success", ...(message ? { message } : {}) } : { status: "success", ...(message ? { message } : {}), data };
}

export function actionError<T = never>(message: string, fieldErrors?: Record<string, string>): ActionState<T> {
  return fieldErrors && Object.keys(fieldErrors).length ? { status: "error", message, fieldErrors } : { status: "error", message };
}

export const FAILED_COPY = "The request failed. Nothing was changed. Please try again.";
export const INVALID_COPY = "Some values need attention. Check the highlighted fields.";
export const SESSION_COPY = "Your session has ended. Sign in again to continue.";

/** Human copy of every stable SQL error code the V2 RPCs raise (0015–0017) and of the V1 messages they wrap. */
export const SQL_ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  AUTH_REQUIRED: SESSION_COPY,
  ACCOUNT_NOT_FOUND: "That trading account isn't available.",
  ACCOUNT_INCOMPLETE: "This trading account needs account values, a risk plan and an instrument before a plan can be checked.",
  TRADE_NOT_FOUND: "That trade isn't available.",
  PLAN_REQUIRED: "This trade has no locked plan yet.",
  INVALID_INPUT: "Some values were not accepted. Check the form and try again.",
  // The key already saved a record: a blind resubmission after a reload (new key) would save a second one.
  IDEMPOTENCY_CONFLICT: "This form was already submitted and saved with different values. Reload the page to see what was saved before submitting again.",
  DRAFT_CHANGED: "This draft changed since you opened it. Reload to see the latest revision.",
  DRAFT_NOT_EDITABLE: "Only drafts can be changed this way. Reload to see the trade's current state.",
  CONTEXT_CHANGED: "Your account values or risk plan changed since this page loaded. Reload and check again.",
  NO_PLAN_TO_DUPLICATE: "Only trades with a draft or a locked plan can be duplicated.",
  ENTRY_ALREADY_RECORDED: "The entry is already recorded. Recorded fills can't be changed.",
  PLAN_DISPOSED: "This plan was skipped or cancelled.",
  INVALID_TIME: "Check the time: it can't be in the future and must follow the plan lock or the entry.",
  OFF_INCREMENT: "Prices and size must match the instrument's tick size and size step.",
  ENTRY_BEYOND_STOP: "The actual entry must stay on the valid side of the planned stop.",
  ALREADY_CLOSED: "This trade is already closed with different values.",
  ENTRY_REQUIRED: "Record the entry before closing the trade.",
  MULTI_LEG: "This position has partial closes or additions recorded in V1, so it can't be closed with one exit here.",
  ALREADY_EXECUTED: "This plan was executed. Close the trade instead of skipping it.",
  STRATEGY_UNSUPPORTED: "This draft uses a strategy version the risk engine doesn't support.",
  ALREADY_DISPOSED: "This plan is already skipped or cancelled.",
  NOT_CLOSED: "Only closed trades can be marked reviewed.",
  NOT_REVIEWED: "Only reviewed trades can be reopened.",
  ORIGIN_MISMATCH: "This action isn't available for this trade.",
  ENTRY_DETAILS_IMMUTABLE: "Recorded entry details can't be changed. Only missing details can be added.",
  PNL_IS_CALCULATED: "Net P&L is calculated from the recorded prices and size. Leave it empty.",
  PNL_REQUIRED: "Enter the net P&L: it can't be calculated from the recorded entry details.",
  EVIDENCE_NOT_FOUND: "That screenshot isn't available.",
  EVIDENCE_REMOVED: "Removed screenshots can't be relabelled.",
  EVIDENCE_LIMIT: "A trade supports 24 active screenshots. Remove one before adding another.",
  EXTERNAL_LOSS_NOT_FOUND: "That external loss isn't available.",
  REASON_REQUIRED: "An immediate change needs a reason of at least 5 characters.",
  STRATEGY_TEMPLATE_UNAVAILABLE: "Trading accounts can't be created until the database update is complete.",
});

/** Exact INVALID_TIME details (stable V1 and 0015 sentences) and their copy. */
const TIME_COPY: readonly [RegExp, string][] = [
  [/Entry must be after plan lock/i, "The entry time must be after the plan was locked and not in the future."],
  [/Exit must be after entry/i, "The exit time must be after the entry and not in the future."],
  [/entry time must not be later than when the trade was recorded/i, "The entry time can't be later than when the trade was recorded."],
  [/exit time must not be in the future/i, "The exit time can't be in the future."],
  [/exit time must not be before the entry time/i, "The exit time can't be before the entry time."],
];

/** V1 and storage messages raised without a code prefix. */
const UNPREFIXED: readonly [RegExp, string][] = [
  [/^Authentication required/, SESSION_COPY],
  [/^Account not found/, SQL_ERROR_COPY.ACCOUNT_NOT_FOUND],
  [/^Screenshot not found/, SQL_ERROR_COPY.EVIDENCE_NOT_FOUND],
  [/^Proposal not found/, "That draft isn't available."],
];

/** PostgREST / PostgreSQL codes of a function the database does not have (an older schema). */
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);
export const SCHEMA_ERROR_COPY = "Database update required — this deployment expects Trading OS database version 2.0. No changes were made.";

export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
}

/** The stable code prefix of a database error message (`DRAFT_CHANGED` of `'DRAFT_CHANGED: …'`), or null. */
export function errorCode(error: RpcErrorLike | null | undefined): string | null {
  return /^([A-Z][A-Z0-9_]+):/.exec(error?.message ?? "")?.[1] ?? null;
}

/**
 * Human copy for a database error. `overrides` replaces the copy of specific codes for one action (for example
 * DRAFT_NOT_EDITABLE on discard). Unknown errors return the generic failure copy; raw text never reaches the user.
 */
export function rpcErrorCopy(error: RpcErrorLike | null | undefined, overrides: Readonly<Record<string, string>> = {}): string {
  if (!error) return FAILED_COPY;
  if (error.code && MISSING_FUNCTION.has(error.code)) return SCHEMA_ERROR_COPY;
  const message = error.message ?? "";
  const code = errorCode(error);
  if (code !== null) {
    if (Object.hasOwn(overrides, code)) return overrides[code];
    if (code === "INVALID_TIME") return TIME_COPY.find(([pattern]) => pattern.test(message))?.[1] ?? SQL_ERROR_COPY.INVALID_TIME;
    if (Object.hasOwn(SQL_ERROR_COPY, code)) return SQL_ERROR_COPY[code];
    return FAILED_COPY;
  }
  return UNPREFIXED.find(([pattern]) => pattern.test(message))?.[1] ?? FAILED_COPY;
}

/**
 * Field named by an `INVALID_INPUT: <field> must …` detail, when it is one of the form's fields; lets the form
 * highlight the field the database rejected.
 */
export function invalidField(error: RpcErrorLike | null | undefined, fields: readonly string[]): string | null {
  if (errorCode(error) !== "INVALID_INPUT") return null;
  const detail = (error?.message ?? "").replace(/^INVALID_INPUT:\s*/, "");
  const match = /^([A-Za-z]+)\b/.exec(detail)?.[1];
  return match !== undefined && fields.includes(match) ? match : null;
}

/** A form value as a string (`undefined` for files or absent fields). */
export function formText(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Trimmed text, `undefined` when empty. */
export function formOptional(form: FormData, key: string): string | undefined {
  const value = formText(form, key)?.trim();
  return value ? value : undefined;
}

/** Checkbox semantics: "on", "true", "1" and "yes" are checked. */
export function formFlag(form: FormData, key: string): boolean {
  const value = formText(form, key)?.trim().toLowerCase();
  return value === "on" || value === "true" || value === "1" || value === "yes";
}

/** Every string value of a repeated field. */
export function formList(form: FormData, key: string): string[] {
  return form.getAll(key).filter((value): value is string => typeof value === "string");
}
