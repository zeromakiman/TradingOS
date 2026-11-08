"use client";
import { LoaderCircle, RotateCcw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { completePasswordRecovery } from "@/app/password-actions";
import { INVALID_RECOVERY, type RecoveryState, recoveryInput, UNSUPPORTED_RECOVERY_LINK } from "@/lib/password-recovery";
import { AuthHeading } from "./settings/auth-frame";
import { BackToSignIn, NewPasswordForm } from "./settings/auth-forms";
import { buttonClasses } from "./ui/button";
import { Callout } from "./ui/callout";
import { FormAlert } from "./ui/form-alert";

const linkClass = "font-medium text-accent underline-offset-2 hover:underline";

/**
 * /update-password (docs/V2_ARCHITECTURE.md §14.11–14.12). On load it reads only the recognized recovery parameters (a
 * PKCE code), removes every code, token and provider error detail from the address bar before anything else happens,
 * and asks the server to verify the recovery session. Only a session that a recovery link started in the last 15
 * minutes gets the new-password form. A link carrying session tokens is refused without contacting the server (it is
 * never adopted), and a person who is simply signed in is sent to Settings → Security, which asks for the current
 * password.
 */
export function PasswordRecovery() {
  const started = useRef(false), [state, setState] = useState<RecoveryState | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const input = recoveryInput(window.location.search, window.location.hash);
    // Remove codes, tokens and provider error details from the address bar before anything else happens.
    window.history.replaceState(window.history.state, "", "/update-password");
    if (input.kind === "invalid") {
      setState({ error: input.tokenLink ? UNSUPPORTED_RECOVERY_LINK : INVALID_RECOVERY });
      return;
    }
    // The Next.js router only follows history changes once its own effect has run, after this one: it learns the clean
    // address (a null state marks the call as not its own) before the check, whose cookies render the page again.
    // Otherwise it would write back the address it knows, one-time code included, and a reload would reuse a spent code.
    window.setTimeout(() => {
      window.history.replaceState(null, "", "/update-password");
      completePasswordRecovery(input).then(setState).catch(() => setState({ error: "Recovery could not be verified. Request a new link and try again." }));
    }, 0);
  }, []);
  return <RecoveryView state={state} />;
}

/** What /update-password shows for the result of the check (null: still checking). */
export function RecoveryView({ state }: { state: RecoveryState | null }) {
  if (state?.signedIn) return <SignedInWithoutRecovery message={state.error ?? ""} />;
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
          <Link href="/forgot-password" className={linkClass}>
            Request a new recovery link
          </Link>
        </p>
      )}
      <BackToSignIn />
    </>
  );
}

/** A signed-in visitor without a recent recovery link: the password changes in Settings, with the current password. */
function SignedInWithoutRecovery({ message }: { message: string }) {
  return (
    <>
      <AuthHeading title="Change your password in Settings" description="You're signed in, so Trading OS asks for your current password first." />
      <div className="flex flex-col gap-4">
        <Callout tone="info" role="status">
          {message}
        </Callout>
        <Link href="/settings#security" className={buttonClasses({ size: "lg", className: "w-full" })}>
          <ShieldCheck aria-hidden="true" />
          Open Settings → Security
        </Link>
      </div>
      <p className="t-meta mt-5 text-center">
        Forgot your current password?{" "}
        <Link href="/forgot-password" className={linkClass}>
          Request a recovery link
        </Link>
      </p>
    </>
  );
}
