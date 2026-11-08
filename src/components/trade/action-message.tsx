"use client";

import type { ActionState } from "@/app/actions/state";
import { FormAlert } from "@/components/ui/form-alert";
import { type ToastTone, useOptionalToast } from "@/components/ui/toast";

/**
 * Feedback of the trade page's forms. Errors stay next to the form (announced and focused, linked to the fields);
 * successes that change the page (the trade moves to its next state) are announced with a toast, because the form
 * that was submitted usually disappears with the refresh.
 */

export function ActionMessage<T>({ state, attempt, showSuccess = false, className }: { state: ActionState<T>; attempt: number; showSuccess?: boolean; className?: string }) {
  if (state.status === "error") {
    return (
      <FormAlert key={attempt} tone="error" className={className}>
        {state.message}
      </FormAlert>
    );
  }
  if (showSuccess && state.status === "success" && state.message) {
    return (
      <FormAlert key={attempt} tone="success" focusOnMount={false} className={className}>
        {state.message}
      </FormAlert>
    );
  }
  return null;
}

/** `notify(message, tone)`: a toast inside the app shell; a no-op outside it (tests, previews). */
export function useNotify() {
  const toast = useOptionalToast();
  return (title: string | undefined, tone: ToastTone = "positive") => {
    if (title) toast?.toast({ title, tone });
  };
}
