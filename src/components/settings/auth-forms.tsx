"use client";

import { LogIn, Mail } from "lucide-react";
import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { type ActionState, login } from "@/app/actions";
import { requestPasswordRecovery, updatePassword } from "@/app/password-actions";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { FormAlert } from "../ui/form-alert";
import { Input } from "../ui/input";
import { submitWithoutReset, useResultKey } from "./form-submit";
import { PasswordInput } from "./password-input";

/**
 * Forms of the public sign-in pages (docs/V2_ARCHITECTURE.md §14.12). They call the existing actions unchanged, so
 * every security behaviour stays where it is: no account enumeration on recovery, the fixed recovery redirect, and
 * sign-in redirecting only to /today. Typed values survive a server error; passwords are never echoed back.
 */

const INITIAL: ActionState = {};

const linkClass = "font-medium text-accent underline-offset-2 hover:underline";

export function SignInForm() {
  const [state, dispatch, pending] = useActionState(login, INITIAL);
  const [email, setEmail] = useState("");
  const passwordId = useId();
  const resultKey = useResultKey(state);
  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex flex-col gap-4" aria-busy={pending}>
      <Field label="Email">
        <Input name="email" type="email" required autoComplete="username" inputMode="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
      </Field>
      <div className="field">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={passwordId} className="field-label">
            Password
          </label>
          <Link href="/forgot-password" className={`text-[0.8125rem] ${linkClass}`}>
            Forgot password?
          </Link>
        </div>
        <PasswordInput id={passwordId} name="password" required autoComplete="current-password" maxLength={256} />
      </div>
      {state.error && (
        <FormAlert key={resultKey} tone="error">
          {state.error}
        </FormAlert>
      )}
      <Button type="submit" size="lg" className="w-full" icon={<LogIn aria-hidden="true" />} loading={pending} loadingText="Signing in…">
        Sign in
      </Button>
    </form>
  );
}

export function RecoveryRequestForm() {
  const [state, dispatch, pending] = useActionState(requestPasswordRecovery, INITIAL);
  const [email, setEmail] = useState("");
  const resultKey = useResultKey(state);
  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex flex-col gap-4" aria-busy={pending}>
      <Field label="Email">
        <Input name="email" type="email" required maxLength={254} autoComplete="email" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} />
      </Field>
      {state.error && (
        <FormAlert key={resultKey} tone="error">
          {state.error}
        </FormAlert>
      )}
      {state.success && (
        <FormAlert key={resultKey} tone="success" title="Check your email">
          {state.success}
        </FormAlert>
      )}
      <Button type="submit" size="lg" className="w-full" icon={<Mail aria-hidden="true" />} loading={pending} loadingText="Requesting email…">
        {state.success ? "Send another link" : "Send recovery link"}
      </Button>
    </form>
  );
}

/** New password + confirmation for /update-password, after the recovery session was verified; success opens sign-in. */
export function NewPasswordForm() {
  const [state, dispatch, pending] = useActionState(updatePassword, INITIAL);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const resultKey = useResultKey(state);
  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex flex-col gap-4" aria-busy={pending}>
      <Field label="New password" hint="At least 8 characters.">
        <PasswordInput name="password" autoComplete="new-password" minLength={8} maxLength={256} required value={password} onChange={event => setPassword(event.target.value)} />
      </Field>
      <Field label="Confirm new password">
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
      {state.error && (
        <FormAlert key={resultKey} tone="error">
          {state.error}
        </FormAlert>
      )}
      <Button type="submit" size="lg" className="w-full" loading={pending} loadingText="Updating password…">
        Update password
      </Button>
    </form>
  );
}

export function BackToSignIn() {
  return (
    <p className="t-meta mt-5 text-center">
      <Link href="/login" className={linkClass}>
        Back to sign in
      </Link>
    </p>
  );
}
