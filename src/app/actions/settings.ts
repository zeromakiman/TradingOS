"use server";
import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { unstable_rethrow } from "next/navigation";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { publicConfig } from "@/lib/supabase/config";
import { supabaseServer } from "@/lib/supabase/server";
import { type ActionState, actionError, actionSuccess, FAILED_COPY, formText } from "./state";

/**
 * Settings → Security (docs/V2_ARCHITECTURE.md §14.11): change the password only after the current password is
 * re-entered and verified for the signed-in user with a separate, non-persisting client (never the cookie session).
 * The new password is set on that freshly signed-in session (a recent sign-in satisfies the auth server's
 * re-authentication rule). The auth server then ends every other session of the user — including this browser's — so
 * the browser adopts the fresh session and signs out any session that is still left. Fields: `currentPassword`,
 * `newPassword`, `confirmation`. AI preferences keep their existing actions (src/app/ai-settings-actions.ts).
 */

const UNAVAILABLE = "The sign-in service is temporarily unavailable. Nothing was changed. Please try again.";
const MAX_PASSWORD = 256;

function outage(error: { status?: number } & Parameters<typeof isAuthRetryableFetchError>[0]): boolean {
  return isAuthRetryableFetchError(error) || error.status === 429 || (error.status ?? 0) >= 500;
}

export async function changePassword(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const current = formText(form, "currentPassword") ?? "";
    const next = formText(form, "newPassword") ?? "";
    const confirmation = formText(form, "confirmation") ?? "";
    const errors: Record<string, string> = {};
    if (!current || current.length > 1024) errors.currentPassword = "Enter your current password.";
    if (next.length < 8 || next.length > MAX_PASSWORD) errors.newPassword = "Use a new password between 8 and 256 characters.";
    else if (next === current) errors.newPassword = "Choose a password different from your current password.";
    if (!errors.newPassword && confirmation !== next) errors.confirmation = "The new passwords do not match.";
    if (Object.keys(errors).length) return actionError("Check the highlighted fields.", errors);
    const email = session.user.email;
    const config = publicConfig();
    if (!email || !config) return actionError(FAILED_COPY);

    const verifier = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const signIn = await verifier.auth.signInWithPassword({ email, password: current });
    if (signIn.error) {
      if (outage(signIn.error)) {
        operationalFailure("auth_unavailable", 503);
        return actionError(UNAVAILABLE);
      }
      return actionError("Your current password is incorrect.", { currentPassword: "Your current password is incorrect." });
    }
    let fresh: { access_token: string; refresh_token: string } | null = null;
    try {
      // The password must be the signed-in user's own.
      if (signIn.data.user?.id !== session.user.id) return actionError("Your current password is incorrect.", { currentPassword: "Your current password is incorrect." });
      const update = await verifier.auth.updateUser({ password: next });
      if (update.error) {
        if (update.error.code === "same_password") return actionError("Choose a password different from your current password.", { newPassword: "Choose a password different from your current password." });
        if (update.error.code === "weak_password") return actionError("Choose a stronger password that meets your account's password policy.", { newPassword: "Choose a stronger password that meets your account's password policy." });
        if (outage(update.error)) {
          operationalFailure("auth_unavailable", 503);
          return actionError(UNAVAILABLE);
        }
        operationalFailure("request_failed");
        return actionError("The password could not be changed. Nothing was changed. Please try again.");
      }
      const verified = signIn.data.session;
      if (verified) fresh = { access_token: verified.access_token, refresh_token: verified.refresh_token };
    } finally {
      // The verification session is ended unless this browser adopts it below.
      if (!fresh) await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);
    }
    // Changing the password ended this browser's previous session with every other one: continue on the fresh session,
    // then make sure no other session survives (older auth servers keep them).
    const browser = await supabaseServer(true);
    const adopted = fresh ? await browser.auth.setSession(fresh).catch(() => ({ error: new Error("session adoption failed") })) : { error: new Error("no session") };
    if (adopted.error) {
      if (fresh) await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);
      return actionSuccess("Password changed. Sign in again with your new password.");
    }
    const others = await browser.auth.signOut({ scope: "others" }).catch(() => ({ error: new Error("sign-out failed") }));
    return actionSuccess(others.error ? "Password changed. Sign out on your other devices to apply it there." : "Password changed. Other devices were signed out.");
  } catch (error) {
    unstable_rethrow(error);
    operationalFailure("request_failed");
    return actionError(FAILED_COPY);
  }
}
