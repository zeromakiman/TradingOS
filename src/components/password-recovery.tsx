"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { completePasswordRecovery, updatePassword } from "@/app/password-actions";
import { recoveryInput } from "@/lib/password-recovery";
import { ActionForm, Field } from "./forms";
import type { ActionState } from "@/app/actions";

export function PasswordRecovery() {
  const started = useRef(false), [state, setState] = useState<ActionState | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const input = recoveryInput(window.location.search, window.location.hash);
    // Remove codes, tokens and provider error details before submitting or navigating.
    window.history.replaceState(window.history.state, "", "/update-password");
    completePasswordRecovery(input).then(setState).catch(() => setState({ error: "Recovery could not be verified. Request a new link and try again." }));
  }, []);
  return <><h1>Set a new password</h1>{!state && <p role="status">Checking your recovery session…</p>}{state?.error && <p className="notice danger" role="alert">{state.error}</p>}{state?.success && <><p>Use at least 8 characters. After saving, sign in with your new password.</p><ActionForm action={updatePassword} label="Update password" pendingLabel="Updating password…"><Field label="New password"><input type="password" name="password" autoComplete="new-password" minLength={8} maxLength={256} required/></Field><Field label="Confirm new password"><input type="password" name="confirmation" autoComplete="new-password" minLength={8} maxLength={256} required/></Field></ActionForm></>}<p><Link href="/forgot-password">Request a new recovery link</Link></p><Link href="/login">Back to sign in</Link></>;
}
