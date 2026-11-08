"use client";

import { unstable_rethrow } from "next/navigation";
import { useState, useTransition } from "react";
import { type ActionState, INVALID_COPY, idleState } from "@/app/actions/state";
import { TRADE_COPY } from "./copy";

/**
 * Runs a §12.2 server action of the trade page from a submit or click handler (never the form `action` prop, so a
 * refused submission keeps every typed value). Client checks run first and never reach the server; a thrown error,
 * such as a dropped connection, becomes an error state with human copy; Next.js control flow is rethrown. The action's
 * own revalidation refreshes the page on success.
 */

export type TradeServerAction<T> = (prev: ActionState<T>, form: FormData) => Promise<ActionState<T>>;
export type TradeSuccess<T> = Extract<ActionState<T>, { status: "success" }>;

/** Calls an action outside `useActionState` and turns a thrown error into an error state. */
export async function callTradeAction<T>(action: TradeServerAction<T>, form: FormData): Promise<ActionState<T>> {
  try {
    return await action(idleState, form);
  } catch (error) {
    unstable_rethrow(error);
    return { status: "error", message: TRADE_COPY.connectionLost };
  }
}

export function useTradeAction<T = undefined>(action: TradeServerAction<T>, onSuccess?: (state: TradeSuccess<T>) => void) {
  const [state, setState] = useState<ActionState<T>>(idleState);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  /** Sends the form, or shows `clientErrors` (field → message) without sending anything. */
  const run = (form: FormData, clientErrors: Readonly<Record<string, string>> = {}) => {
    if (Object.keys(clientErrors).length) {
      setState({ status: "error", message: INVALID_COPY, fieldErrors: { ...clientErrors } });
      setAttempt(value => value + 1);
      return;
    }
    startTransition(async () => {
      const result = await callTradeAction(action, form);
      startTransition(() => {
        setState(result);
        setAttempt(value => value + 1);
        if (result.status === "success") onSuccess?.(result);
      });
    });
  };

  /** Shows a result the action returned elsewhere (a confirmation dialog sent it), like one of `run`. */
  const show = (result: ActionState<T>) => {
    setState(result);
    setAttempt(value => value + 1);
  };

  /** `attempt` changes with every result: key feedback with it so each refusal is announced and focused again. */
  return { state, pending, run, show, attempt, reset: () => setState(idleState) };
}

/** FormData from plain values (empty strings are left out, so optional fields stay unknown). */
export function formOf(values: Readonly<Record<string, string | null | undefined>>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") form.set(key, value);
  return form;
}
