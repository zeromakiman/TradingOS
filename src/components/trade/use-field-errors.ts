"use client";

import { useState } from "react";
import type { ActionState } from "@/app/actions/state";

/**
 * Field errors of a trade-page form that clear while the person fixes them: an error stays until its field is edited,
 * and every new result (`attempt`) shows its own errors again. `map` turns the action's field names into the form's.
 */
export function useFieldErrors<T>(state: ActionState<T>, attempt: number, map: (field: string) => string | null = field => field) {
  const [edited, setEdited] = useState<{ attempt: number; fields: ReadonlySet<string> }>({ attempt, fields: new Set() });
  const editedNow = edited.attempt === attempt ? edited.fields : new Set<string>();
  const errors: Record<string, string> = {};
  if (state.status === "error") {
    for (const [field, message] of Object.entries(state.fieldErrors ?? {})) {
      const key = map(field);
      if (key !== null && !editedNow.has(key) && !(key in errors)) errors[key] = message;
    }
  }
  return {
    errorOf: (field: string): string | undefined => errors[field],
    /** Hides the error of `field` until the next result. */
    touch: (field: string) => setEdited(previous => ({ attempt, fields: new Set([...(previous.attempt === attempt ? previous.fields : []), field]) })),
  };
}
