import { type FormEvent, startTransition, useState } from "react";

/**
 * Submit handler for a `useActionState` form whose fields are controlled. React resets a form after a form action
 * finishes, which would wipe what the person typed when the server reports an error; submitting through this handler
 * dispatches the same FormData in a transition without that reset. The form keeps `action={dispatch}` as well, so it
 * still works before hydration (progressive enhancement).
 */
export function submitWithoutReset(dispatch: (form: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  };
}

export interface ResultKeyState<T> {
  result: T;
  key: number;
}

/** The next key: unchanged for the same result object, one higher for every new one. */
export function nextResultKey<T>(tracked: ResultKeyState<T>, result: T): ResultKeyState<T> {
  return Object.is(tracked.result, result) ? tracked : { result, key: tracked.key + 1 };
}

/**
 * A number that changes with every new `useActionState` result, for the `key` of the alert that shows it. Every
 * submission returns a new state object, so the same error twice still mounts a fresh alert, which is announced and
 * takes focus again (docs/V2_ARCHITECTURE.md §13.5). Without it the alert would stay in place silently while focus,
 * dropped by the submit button that disables itself while pending, ends on the page body.
 */
export function useResultKey<T>(result: T): number {
  const [tracked, setTracked] = useState<ResultKeyState<T>>(() => ({ result, key: 0 }));
  const next = nextResultKey(tracked, result);
  if (next !== tracked) setTracked(next);
  return next.key;
}
