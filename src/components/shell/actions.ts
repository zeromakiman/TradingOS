import { type ActionOutcome, IDLE_RESULT, settleAction } from "../ui/action-result";
import type { ShellAction, SignOutAction, ThemePreference, TimeDisplayMode } from "./types";

/**
 * Calling the §12.2 context actions (src/app/actions/context.ts) from the shell. Pure apart from
 * the action itself, so the failure handling is testable without a browser.
 */

/** An action the shell calls: a context action (`ShellAction`) or the sign-out action, which may return nothing. */
export type CallableAction = ShellAction | SignOutAction;

/** FormData fields of an action call; undefined fields are left out. */
export type ActionFields = Record<string, string | undefined>;

/** Field of `SelectAccountAction`: "all" or a trading account id. */
export const accountFields = (value: string): ActionFields => ({ account: value });

/** Field of `SetThemeAction`. */
export const themeFields = (theme: ThemePreference): ActionFields => ({ theme });

/** Fields of `SetTimeDisplayAction`; `zone` is the browser's IANA zone when known. */
export const timeDisplayFields = (mode: TimeDisplayMode, zone: string | undefined): ActionFields => ({ mode, zone });

export function actionForm(fields: ActionFields): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(name, value);
  }
  return form;
}

/** Calls an action with the idle state and a FormData of `fields`, and classifies the result (see `settleAction`). */
export function callShellAction(action: CallableAction, fields: ActionFields = {}): Promise<ActionOutcome> {
  return settleAction(() => action(IDLE_RESULT, actionForm(fields)));
}

export type FailureHandlers = {
  /** Undoes an optimistic change. */
  revert?: () => void;
  /** Tells the person; `message` is the action's own message, null when it gave none or could not be reached. */
  notify?: (message: string | null) => void;
};

/** Persists a choice with an action. A failure is reverted, then reported. Resolves true when the action succeeded. */
export async function persistChoice(action: CallableAction, fields: ActionFields, { revert, notify }: FailureHandlers = {}): Promise<boolean> {
  const outcome = await callShellAction(action, fields);
  if (outcome.ok) return true;
  revert?.();
  notify?.(outcome.message);
  return false;
}

/**
 * Switches the trading-account context with the action, which re-renders the page in place.
 * When the action fails, the option's `?account=` link is followed instead: the proxy validates
 * and stores that choice, and the page explains an account that is not available.
 */
export async function switchAccountContext(action: ShellAction, value: string, href: string, navigate: (href: string) => void): Promise<void> {
  const outcome = await callShellAction(action, accountFields(value));
  if (!outcome.ok) navigate(href);
}
