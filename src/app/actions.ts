"use server";
import { isChunkLike } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { operationalFailure } from "@/lib/operational-log";
import { publicConfig } from "@/lib/supabase/config";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign-in and sign-out, used by the public auth pages and the app shell. Every V2 write lives in src/app/actions/*.
 * The V1 actions this module used to export (account bootstrap, plan check and lock, daily context, plan notes,
 * account observations, risk plans) were removed with the V1 screens: no V2 page used them, and every export of a
 * "use server" module is an endpoint that a POST request can call.
 */

export type ActionState = { error?: string; success?: string };

const SIGN_IN_FAILED = "Sign-in failed. Check your email and password.";
const REQUEST_FAILED = "The request failed. Please try again.";

function field(form: FormData, key: string) {
  return String(form.get(key) ?? "");
}

/**
 * The auth service could not answer: network failure, rate limit or server error. Only these are operational events;
 * wrong credentials (400 `invalid_credentials`), unconfirmed or banned users are ordinary answers to a sign-in attempt.
 */
function authOutage(error: Parameters<typeof isAuthRetryableFetchError>[0] & { status?: number }): boolean {
  return isAuthRetryableFetchError(error) || error.status === 429 || (error.status ?? 0) >= 500;
}

export async function login(_state: ActionState, form: FormData): Promise<ActionState> {
  try {
    const email = z.email().parse(field(form, "email"));
    const password = z.string().min(1).max(256).parse(field(form, "password"));
    const db = await supabaseServer(true);
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      if (authOutage(error)) operationalFailure("auth_unavailable", 503);
      return { error: SIGN_IN_FAILED };
    }
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof z.ZodError) return { error: error.issues.map(issue => issue.message).join(" ") };
    operationalFailure("request_failed");
    return { error: REQUEST_FAILED };
  }
  redirect("/today");
}

export async function logout() {
  const config = publicConfig();
  if (config) {
    try {
      const db = await supabaseServer(true);
      await db.auth.signOut({ scope: "local" });
    } finally {
      const jar = await cookies();
      for (const cookie of jar.getAll()) if (isChunkLike(cookie.name, config.cookiePrefix) || isChunkLike(cookie.name, `${config.cookiePrefix}-user`)) jar.delete(cookie.name);
    }
  }
  revalidatePath("/", "layout");
  redirect("/login?reason=signed_out");
}
