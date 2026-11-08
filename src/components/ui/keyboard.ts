import type { KeyboardEvent } from "react";

/**
 * Ctrl/⌘+Enter submits the surrounding form (§13.4), for the journal composer and other
 * forms: `<Textarea onKeyDown={submitOnModifierEnter} />`. Uses `requestSubmit`, so form
 * validation and React form actions run exactly as for the submit button.
 */
export function submitOnModifierEnter(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
  const form = event.currentTarget.closest("form");
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}
