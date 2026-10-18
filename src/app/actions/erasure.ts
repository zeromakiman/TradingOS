"use server";
import { isChunkLike } from "@supabase/ssr";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { ERASURE_COPY, eraseTradingOsAccount, erasureInputError, erasureLog, supabaseErasureServices } from "@/lib/erasure";
import { publicConfig } from "@/lib/supabase/config";
import { requireUser } from "@/lib/supabase/server";

/**
 * Settings → Danger zone → Delete Trading OS account (docs/V2_ARCHITECTURE.md §10.4). The user comes from the
 * verified session only; the form carries just the typed confirmation and the current password.
 */

export interface ErasureActionState {
  error?: string;
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/** Removes this browser's Supabase auth cookies, exactly like the logout action. */
async function clearAuthCookies(): Promise<void> {
  const config = publicConfig();
  if (!config) return;
  const jar = await cookies();
  for (const cookie of jar.getAll()) {
    if (isChunkLike(cookie.name, config.cookiePrefix) || isChunkLike(cookie.name, `${config.cookiePrefix}-user`)) jar.delete(cookie.name);
  }
}

export async function deleteTradingOsAccount(_state: ErasureActionState, form: FormData): Promise<ErasureActionState> {
  try {
    const { db, user } = await requireUser(true);
    const confirmation = text(form, "confirmation");
    const password = text(form, "password");
    const invalid = erasureInputError(confirmation, password);
    if (invalid) return { error: invalid };
    const outcome = await eraseTradingOsAccount(
      { userId: user.id, email: user.email ?? null, confirmation, password },
      supabaseErasureServices(db, user.id),
    );
    if (!outcome.ok) return { error: outcome.error };
  } catch (error) {
    unstable_rethrow(error);
    erasureLog("erasure_failed");
    return { error: ERASURE_COPY.incomplete };
  }
  await clearAuthCookies();
  revalidatePath("/", "layout");
  redirect("/login?reason=account_deleted");
}
