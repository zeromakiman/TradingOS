"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { clearPaletteHistory } from "./palette-history";

/**
 * Sign-in page reasons that end a person's presence in this browser: they signed out (the shell's menus, the "Database
 * update required" page's sign-out form, or any other path through the `logout` action) or deleted their Trading OS
 * account. A session that merely ended (`?reason=session`) keeps that person's unsaved entries for when they sign in
 * again; the forms never restore another person's entries anyway (src/components/trade/forms/autosave.ts).
 */
const SIGNED_OUT_REASONS: ReadonlySet<string> = new Set(["signed_out", "account_deleted"]);

/** Whether an address is the sign-in page that an explicit sign-out or an account deletion lands on. */
export function isSignOutLanding(pathname: string | null | undefined, reason: string | null | undefined): boolean {
  return pathname === "/login" && typeof reason === "string" && SIGNED_OUT_REASONS.has(reason);
}

/**
 * Forgets what belonged to the person who left: the unsaved Plan Trade, Record Live Trade and Edit Draft entries kept in
 * this tab, and the command palette's recent entries. The trade forms' module is loaded only here, so the sign-in page
 * does not carry their code.
 */
export async function forgetSignedOutPerson(): Promise<void> {
  clearPaletteHistory();
  const { clearFormAutosaves } = await import("../trade/forms/autosave");
  clearFormAutosaves();
}

/**
 * Mounted once by the root layout, so it also sees sign-outs that do not go through the shell's menus (which clear the
 * same entries before their request): on the sign-in page a sign-out lands on, this tab keeps nothing of the previous
 * person, whichever way they signed out (master spec: a shared browser never shows one person's drafts to the next).
 */
export function SignOutCleanup() {
  const landing = isSignOutLanding(usePathname(), useSearchParams()?.get("reason"));
  useEffect(() => {
    if (landing) forgetSignedOutPerson().catch(() => undefined);
  }, [landing]);
  return null;
}
