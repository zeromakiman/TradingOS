"use client";

import { KeyRound } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { changePassword } from "@/app/actions/settings";
import { idleState } from "@/app/actions/state";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { FormAlert } from "../ui/form-alert";
import { submitWithoutReset, useResultKey } from "./form-submit";
import { PasswordInput } from "./password-input";

const FIELDS = ["currentPassword", "newPassword", "confirmation"] as const;
const fieldId = (field: (typeof FIELDS)[number]) => `settings-${field}`;

/**
 * Settings → Security → Change password (docs/V2_ARCHITECTURE.md §14.11). The current password is required and is
 * verified on the server with a separate sign-in, and the server signs out the other devices.
 */
export function ChangePasswordForm({ email }: { email: string }) {
  const [state, dispatch, pending] = useActionState(changePassword, idleState);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  // A message that only repeats a field's own error is not shown twice: focus moves to that field instead.
  const summary = state.status === "error" && !Object.values(fieldErrors).includes(state.message) ? state.message : null;
  // Every result mounts a fresh alert, so a second failure with the same summary is announced and focused again.
  const resultKey = useResultKey(state);

  useEffect(() => {
    if (state.status === "success") {
      setCurrent("");
      setNext("");
      setConfirmation("");
      return;
    }
    if (state.status !== "error") return;
    // Without a separate summary (which takes focus itself), the first field in error receives focus, on every result.
    const errors = state.fieldErrors ?? {};
    const first = FIELDS.find(field => errors[field]);
    if (first && Object.values(errors).includes(state.message)) document.getElementById(fieldId(first))?.focus();
  }, [state]);

  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex max-w-md flex-col gap-4" aria-busy={pending} noValidate>
      {/* Lets password managers file the new password under the right login. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field id={fieldId("currentPassword")} label="Current password" required error={fieldErrors.currentPassword}>
        <PasswordInput name="currentPassword" autoComplete="current-password" maxLength={1024} required value={current} onChange={event => setCurrent(event.target.value)} />
      </Field>
      <Field id={fieldId("newPassword")} label="New password" required hint="At least 8 characters." error={fieldErrors.newPassword}>
        <PasswordInput name="newPassword" autoComplete="new-password" minLength={8} maxLength={256} required value={next} onChange={event => setNext(event.target.value)} />
      </Field>
      <Field id={fieldId("confirmation")} label="Confirm new password" required error={fieldErrors.confirmation}>
        <PasswordInput
          name="confirmation"
          autoComplete="new-password"
          minLength={8}
          maxLength={256}
          required
          value={confirmation}
          onChange={event => setConfirmation(event.target.value)}
        />
      </Field>
      {summary && (
        <FormAlert key={resultKey} tone="error">
          {summary}
        </FormAlert>
      )}
      {/* A field's own error is announced on every result too, even when focus is already in that field. */}
      {state.status === "error" && !summary && (
        <p key={resultKey} role="alert" className="sr-only">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <FormAlert key={resultKey} tone="success">
          {state.message ?? "Password changed."}
        </FormAlert>
      )}
      <div>
        <Button type="submit" variant="secondary" icon={<KeyRound aria-hidden="true" />} loading={pending} loadingText="Changing password…">
          Change password
        </Button>
      </div>
    </form>
  );
}
