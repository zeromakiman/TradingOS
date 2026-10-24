"use client";

import { unstable_rethrow } from "next/navigation";
import { useState, useTransition } from "react";
import { type ActionState, INVALID_COPY, idleState } from "@/app/actions/state";
import { checkForm, type FieldRule } from "./form-checks";

/**
 * Runs a §12.2 server action from a form's submit handler (not the form `action` prop, so React never resets the
 * fields of a refused submission). A thrown error, such as a dropped connection, becomes an error state with human
 * copy; Next.js control flow (redirects) is rethrown. The action's own revalidation refreshes the page.
 */

export const CONNECTION_COPY = "The change didn't reach Trading OS. Nothing was saved. Check your connection and try again.";

export type AccountAction<T> = (prev: ActionState<T>, form: FormData) => Promise<ActionState<T>>;
export type SuccessState<T> = Extract<ActionState<T>, { status: "success" }>;

export function useAccountAction<T = undefined>(action: AccountAction<T>, onSuccess?: (state: SuccessState<T>) => void) {
  const [state, setState] = useState<ActionState<T>>(idleState);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  /** Sends the form; with `rules`, a form that breaks them is refused here with field messages and never sent. */
  const run = (form: FormData, rules?: Readonly<Record<string, FieldRule>>) => {
    const fieldErrors = rules ? checkForm(form, rules) : {};
    if (Object.keys(fieldErrors).length) {
      setState({ status: "error", message: INVALID_COPY, fieldErrors });
      setAttempt(value => value + 1);
      return;
    }
    startTransition(async () => {
      let result: ActionState<T>;
      try {
        result = await action(idleState, form);
      } catch (error) {
        unstable_rethrow(error);
        result = { status: "error", message: CONNECTION_COPY };
      }
      startTransition(() => {
        setState(result);
        setAttempt(value => value + 1);
        if (result.status === "success") onSuccess?.(result);
      });
    });
  };

  /** `feedbackKey` changes with every result: key the feedback with it so each refusal is announced and focused. */
  return { state, pending, run, feedbackKey: attempt, reset: () => setState(idleState) };
}

/** The field's error message of an error state. */
export function fieldError<T>(state: ActionState<T>, field: string): string | undefined {
  return state.status === "error" ? state.fieldErrors?.[field] : undefined;
}
