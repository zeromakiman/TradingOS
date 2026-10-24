"use client";
import { LoaderCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ActionState } from "@/app/actions";
import { completePasswordRecovery } from "@/app/password-actions";
import { recoveryInput } from "@/lib/password-recovery";
import { AuthHeading } from "./settings/auth-frame";
import { BackToSignIn, NewPasswordForm } from "./settings/auth-forms";
import { buttonClasses } from "./ui/button";
import { FormAlert } from "./ui/form-alert";

/**
 * /update-password (docs/V2_ARCHITECTURE.md §14.12). On load it reads only the recognized recovery parameters (a PKCE
 * code or recovery tokens), removes every code, token and provider error detail from the address bar before anything
 * else happens, and asks the server to verify the recovery session. Only a verified session gets the new-password form.
 */
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
  return (
    <>
      <AuthHeading
        title="Set a new password"
        description={state?.success ? "Choose a new password for your Trading OS login. After saving, sign in with it." : "Recovery links work once, in the browser where you requested them."}
      />
      {!state && (
        <p role="status" className="flex items-center gap-2 text-2">
          <LoaderCircle aria-hidden="true" className="spin size-4" />
          Checking your recovery link…
        </p>
      )}
      {state?.error && (
        <div className="flex flex-col gap-4">
          <FormAlert tone="error" title="This link can't be used">
            {state.error}
          </FormAlert>
          <Link href="/forgot-password" className={buttonClasses({ size: "lg", className: "w-full" })}>
            <RotateCcw aria-hidden="true" />
            Request a new recovery link
          </Link>
        </div>
      )}
      {state?.success && <NewPasswordForm />}
      {state?.success && (
        <p className="t-meta mt-5 text-center">
          Link expired?{" "}
          <Link href="/forgot-password" className="font-medium text-accent underline-offset-2 hover:underline">
            Request a new recovery link
          </Link>
        </p>
      )}
      <BackToSignIn />
    </>
  );
}
