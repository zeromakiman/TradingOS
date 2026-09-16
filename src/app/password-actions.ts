"use server";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isChunkLike } from "@supabase/ssr";
import { supabaseServer } from "@/lib/supabase/server";
import { publicConfig } from "@/lib/supabase/config";
import { INVALID_RECOVERY, RECOVERY_MESSAGE, recoveryRedirect } from "@/lib/password-recovery";
import type { ActionState } from "./actions";

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
  z.object({ kind: z.literal("tokens"), access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(2048) }).strict()
]);

export async function completePasswordRecovery(input: unknown): Promise<ActionState> {
  const parsed = recoverySchema.safeParse(input);
  if (!parsed.success) return { error: INVALID_RECOVERY };
  try {
    const db = await supabaseServer(true), value = parsed.data;
    if (value.kind === "code") {
      const { error } = await db.auth.exchangeCodeForSession(value.code);
      if (error) return { error: INVALID_RECOVERY };
    } else if (value.kind === "tokens") {
      const { error } = await db.auth.setSession({ access_token: value.access_token, refresh_token: value.refresh_token });
      if (error) return { error: INVALID_RECOVERY };
    }
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) return { error: INVALID_RECOVERY };
    return { success: "Choose your new password." };
  } catch { return { error: "Recovery could not be verified. Please request a new link and try again." }; }
}

export async function updatePassword(_state: ActionState, form: FormData): Promise<ActionState> {
  const password = String(form.get("password") ?? ""), confirmation = String(form.get("confirmation") ?? "");
  if (password.length < 8 || password.length > 256) return { error: "Use a password between 8 and 256 characters." };
  if (password !== confirmation) return { error: "The passwords do not match." };
  try {
    const db = await supabaseServer(true);
    const { data, error } = await db.auth.getUser();
    if (error || !data.user) return { error: INVALID_RECOVERY };
    const result = await db.auth.updateUser({ password });
    if (result.error) {
      if (result.error.code === "same_password") return { error: "Choose a password different from your current password." };
      if (result.error.code === "weak_password") return { error: "Choose a stronger password that meets your account’s password policy." };
      return { error: "The password could not be updated. Your session may have expired; request a new recovery link and try again." };
    }
    // Supabase invalidates refresh sessions; always remove this browser's cookies as well.
    try { await db.auth.signOut({ scope: "global" }); } catch { /* Local cleanup still applies. */ }
    const config = publicConfig(), jar = await cookies();
    if (config) for (const cookie of jar.getAll()) if (isChunkLike(cookie.name, config.cookiePrefix) || isChunkLike(cookie.name, `${config.cookiePrefix}-user`)) jar.delete(cookie.name);
  } catch { return { error: "The password service is temporarily unavailable. Please try again." }; }
  redirect("/login?reason=password_updated");
}
