"use client";

import type { ActionState } from "@/app/actions/state";
import { FormAlert } from "@/components/ui/form-alert";

/** The result of the last submission: errors are announced and focused, successes are announced politely. */
export function ActionFeedback<T>({ state, className }: { state: ActionState<T>; className?: string }) {
  if (state.status === "error") {
    return (
      <FormAlert tone="error" className={className}>
        {state.message}
      </FormAlert>
    );
  }
  if (state.status === "success" && state.message) {
    return (
      <FormAlert tone="success" className={className}>
        {state.message}
      </FormAlert>
    );
  }
  return null;
}
