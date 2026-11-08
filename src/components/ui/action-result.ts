import { unstable_rethrow } from "next/navigation";

/**
 * Result of a V2 server action (§12.2 `ActionState`, src/app/actions/state.ts), declared
 * structurally: components read only `status` and `message`, so every `ActionState<T>` fits.
 */
export type ActionResult = { status: "idle" } | { status: "success"; message?: string } | { status: "error"; message: string };

/** The `prev` state passed when a component calls an action directly instead of through `useActionState`. */
export const IDLE_RESULT: ActionResult = { status: "idle" };

/** The action's error message, or null when `value` is not an action error state (or its message is blank). */
export function actionErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { status, message } = value as { status?: unknown; message?: unknown };
  if (status !== "error") return null;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

/** True for an action's error state, `{ status: "error", message }`. */
export function isActionError(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "error";
}

/** How an awaited action went. `message` is the action's own (human) text; null when it gave none or could not be reached. */
export type ActionOutcome = { ok: true } | { ok: false; message: string | null };

/**
 * Awaits an action and classifies the result. A returned error state and a thrown error (for
 * example a dropped connection) are both failures. Next.js control flow such as a redirect is
 * rethrown, so the router handles it as it would without this wrapper.
 */
export async function settleAction(run: () => unknown): Promise<ActionOutcome> {
  try {
    const result = await run();
    return isActionError(result) ? { ok: false, message: actionErrorMessage(result) } : { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: null };
  }
}

/** What a confirmation dialog does once its action has run: close, or stay open, optionally with a message. */
export type ConfirmOutcome = { close: true } | { close: false; error: string | null };

/**
 * Runs a confirmed action. `false` keeps the dialog open without a message (the caller shows
 * its own feedback); an error state keeps it open with the action's message; a thrown error
 * keeps it open with `fallback`. Anything else closes it.
 */
export async function runConfirmAction(onConfirm: () => unknown, fallback: string): Promise<ConfirmOutcome> {
  try {
    const result = await onConfirm();
    if (result === false) return { close: false, error: null };
    return isActionError(result) ? { close: false, error: actionErrorMessage(result) ?? fallback } : { close: true };
  } catch (error) {
    unstable_rethrow(error);
    return { close: false, error: fallback };
  }
}
