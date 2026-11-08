"use server";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isChunkLike } from "@supabase/ssr";
import { ACCOUNT_CONTEXT_COOKIES, keepOwnAccountContext } from "@/lib/account-context";
import { supabaseServer } from "@/lib/supabase/server";
import { publicConfig } from "@/lib/supabase/config";
import {
  INVALID_RECOVERY, isRecentRecovery, RECOVERY_MESSAGE, RECOVERY_SESSION_EXPIRED, RECOVERY_SESSION_REQUIRED, type RecoveryState, recoveryRedirect,
} from "@/lib/password-recovery";
import type { ActionState } from "./actions";

/**
 * Password recovery (docs/PASSWORD_RECOVERY.md, docs/V2_ARCHITECTURE.md §14.11–14.12). A new password is set here only
 * on a session that a recovery link started within the last 15 minutes (its `amr` claim), checked again on submission
 * because the action can be called directly. Any other session, however valid, changes its password in Settings →
 * Security with the current password; links carrying session tokens are never adopted (src/lib/password-recovery.ts).
 */

export async function requestPasswordRecovery(_state: ActionState, form: FormData): Promise<ActionState> {
  const email = z.email().max(254).safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { error: "Enter a valid email address." };
  try {
    const db = await supabaseServer(true);
    await db.auth.resetPasswordForEmail(email.data, { redirectTo: recoveryRedirect((await headers()).get("origin")) });
  } catch { /* Do not disclose recipient eligibility, provider errors or credentials. */ }
  return { success: RECOVERY_MESSAGE };
}

const recoverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("code"), code: z.string().min(1).max(2048) }).strict(),
]);

type Db = Awaited<ReturnType<typeof supabaseServer>>;

/**
 * The browser's session as the auth server verifies it (`getUser`), then, from its verified claims, whether a recovery
 * link started it within the last 15 minutes. "none": no valid session.
 */
async function recoverySession(db: Db): Promise<"recovery" | "other" | "none"> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return "none";
  const verified = await db.auth.getClaims();
  if (verified.error || !verified.data || verified.data.claims.sub !== data.user.id) return "none";
  return isRecentRecovery(verified.data.claims.amr, Math.floor(Date.now() / 1000)) ? "recovery" : "other";
}

export async function completePasswordRecovery(input: unknown): Promise<RecoveryState> {
  const parsed = recoverySchema.safeParse(input);
  if (!parsed.success) return { error: INVALID_RECOVERY };
  try {
    const db = await supabaseServer(true), value = parsed.data;
    if (value.kind === "code") {
      const { data, error } = await db.auth.exchangeCodeForSession(value.code);
      if (error) return { error: INVALID_RECOVERY };
      // The code signed this browser in: a previous person's trading-account context goes, as at sign-in (§9.2).
      await keepOwnAccountContext(db, data.user?.id);
    }
    const session = await recoverySession(db);
    if (session === "recovery") return { success: "Choose your new password." };
    // A code that did not start a recovery session is a link this page cannot use.
    if (session === "none" || value.kind === "code") return { error: INVALID_RECOVERY };
    return { error: RECOVERY_SESSION_REQUIRED, signedIn: true };
  } catch { return { error: "Recovery could not be verified. Please request a new link and try again." }; }
}

export async function updatePassword(_state: ActionState, form: FormData): Promise<ActionState> {
  const password = String(form.get("password") ?? ""), confirmation = String(form.get("confirmation") ?? "");
  if (password.length < 8 || password.length > 256) return { error: "Use a password between 8 and 256 characters." };
  if (password !== confirmation) return { error: "The passwords do not match." };
  try {
    const db = await supabaseServer(true);
    const session = await recoverySession(db);
    if (session === "none") return { error: INVALID_RECOVERY };
    // An ordinary session never sets a password without the current one (Settings → Security re-authenticates).
    if (session === "other") return { error: RECOVERY_SESSION_EXPIRED };
    const result = await db.auth.updateUser({ password });
    if (result.error) {
      if (result.error.code === "same_password") return { error: "Choose a password different from your current password." };
      if (result.error.code === "weak_password") return { error: "Choose a stronger password that meets your account’s password policy." };
      return { error: "The password could not be updated. Your session may have expired; request a new recovery link and try again." };
    }
    // Supabase invalidates refresh sessions; always remove this browser's cookies as well, with the trading-account
    // context of the person who just reset their password.
    try { await db.auth.signOut({ scope: "global" }); } catch { /* Local cleanup still applies. */ }
    const config = publicConfig(), jar = await cookies();
    for (const cookie of jar.getAll()) {
      const auth = config !== null && (isChunkLike(cookie.name, config.cookiePrefix) || isChunkLike(cookie.name, `${config.cookiePrefix}-user`));
      if (auth || ACCOUNT_CONTEXT_COOKIES.includes(cookie.name)) jar.delete(cookie.name);
    }
  } catch { return { error: "The password service is temporarily unavailable. Please try again." }; }
  redirect("/login?reason=password_updated");
}
