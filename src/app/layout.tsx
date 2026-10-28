import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { type ReactNode, Suspense } from "react";
import { SignOutCleanup } from "@/components/shell/sign-out-cleanup";
import { THEME_COOKIE, type ThemePreference } from "@/lib/account-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading OS · Private Workstation",
  description: "A private trading-process workstation. Written rules, deterministic risk and immutable history.",
  robots: { index: false, follow: false },
};

/** Page background of each theme (`--bg`, docs/V2_ARCHITECTURE.md §13.1), for the browser's own chrome. */
const PAGE_COLOR = { light: "#f5f6f8", dark: "#0d1015" } as const;

/**
 * The theme stored by Settings → General and the shell (cookie `tos_theme`, set by setTheme in
 * src/app/actions/context.ts). Only an explicit light or dark choice is honoured; anything else follows the device.
 */
async function storedTheme(): Promise<ThemePreference> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : "system";
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await storedTheme();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    colorScheme: theme === "system" ? "light dark" : theme,
    themeColor:
      theme === "system"
        ? [
            { media: "(prefers-color-scheme: light)", color: PAGE_COLOR.light },
            { media: "(prefers-color-scheme: dark)", color: PAGE_COLOR.dark },
          ]
        : PAGE_COLOR[theme],
  };
}

/**
 * Root layout (§13.1): `<html data-theme>` carries the stored choice on every page, public sign-in pages included, so
 * an explicit light or dark theme is painted from the first byte without a flash. "system" (no explicit choice) lets
 * the stylesheet follow `prefers-color-scheme`. The shell's ThemeSync applies a new choice at once on the client.
 * SignOutCleanup forgets the previous person's unsaved entries in this tab once a sign-out lands on the sign-in page.
 */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme={await storedTheme()}>
      <body>
        {children}
        <Suspense fallback={null}>
          <SignOutCleanup />
        </Suspense>
      </body>
    </html>
  );
}
