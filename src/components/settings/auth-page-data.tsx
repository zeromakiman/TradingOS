import "server-only";
import { CircleCheck, LogOut, TimerReset } from "lucide-react";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_COOKIE, type ThemePreference } from "@/lib/account-context";
import type { CalloutTone } from "../ui/callout";

/** Server helpers of the public sign-in pages (docs/V2_ARCHITECTURE.md §14.12). */

export interface SignInNotice {
  tone: CalloutTone;
  icon: ReactNode;
  title: string;
  body?: string;
}

/** `/login?reason=…` notices, set only by Trading OS redirects; any other value shows nothing. */
export const SIGN_IN_NOTICES: Readonly<Record<string, SignInNotice>> = Object.freeze({
  session: { tone: "warning", icon: <TimerReset aria-hidden="true" />, title: "Your session ended", body: "Sign in again to continue." },
  signed_out: { tone: "info", icon: <LogOut aria-hidden="true" />, title: "You're signed out" },
  password_updated: { tone: "positive", icon: <CircleCheck aria-hidden="true" />, title: "Password updated", body: "Sign in with your new password." },
  account_deleted: {
    tone: "positive",
    icon: <CircleCheck aria-hidden="true" />,
    title: "Your Trading OS account was deleted",
    body: "Your login and every record in it were permanently removed.",
  },
});

export function signInNotice(reason: string | string[] | undefined): SignInNotice | null {
  return typeof reason === "string" && Object.hasOwn(SIGN_IN_NOTICES, reason) ? SIGN_IN_NOTICES[reason] : null;
}

/** The theme stored by Settings → General (cookie `tos_theme`); signed-out pages honour it too. */
export async function storedTheme(): Promise<ThemePreference> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : "system";
}
