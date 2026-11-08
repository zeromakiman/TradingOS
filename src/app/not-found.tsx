import { Activity, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { publicConfig } from "@/lib/supabase/config";

export const metadata: Metadata = { title: "Page not found · Trading OS", robots: { index: false, follow: false } };

/** Whether this browser holds a Trading OS sign-in (its auth cookie); the session itself is checked by every page. */
async function hasSignIn(): Promise<boolean> {
  const config = publicConfig();
  if (!config) return false;
  return (await cookies()).getAll().some(cookie => cookie.name.startsWith(config.cookiePrefix));
}

/**
 * Unmatched addresses (docs/V2_ARCHITECTURE.md §13.7). They render outside the app shell, so this page carries the
 * brand and the ways back itself, in the design system and the stored theme (root layout): Today and the Journal for
 * a signed-in browser, sign-in otherwise. Unknown trades and accounts inside the app use the shell's own not-found.
 */
export default async function NotFound() {
  const signedIn = await hasSignIn();
  return (
    <div className="flex min-h-dvh flex-col items-center gap-6 bg-bg px-4 pt-10 pb-12 text-text sm:justify-center sm:py-12">
      <Link href={signedIn ? "/today" : "/login"} className="flex w-full max-w-[28rem] items-center gap-2.5 font-bold text-base text-text tracking-tight no-underline">
        <span aria-hidden="true" className="brand-mark">
          <Activity />
        </span>
        Trading OS
      </Link>
      <main id="main-content" className="flex w-full max-w-[28rem] flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-raised sm:p-7">
        <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-surface-sunken text-text-2 ring-1 ring-border">
          <SearchX className="size-5" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-semibold text-text text-xl leading-7 tracking-tight">This page doesn&apos;t exist.</h1>
          <p className="t-meta">
            {signedIn
              ? "The address may be mistyped, or the page has moved. Your trades, accounts and reviews are where you left them. Nothing was changed."
              : "The address may be mistyped, or the page has moved. Sign in to open your workspace."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 max-sm:[&>a]:flex-1">
          {signedIn ? (
            <>
              <Link href="/today" className={buttonClasses({ variant: "primary" })}>
                Go to Today
              </Link>
              <Link href="/journal" className={buttonClasses({ variant: "secondary" })}>
                Open the Journal
              </Link>
            </>
          ) : (
            <Link href="/login" className={buttonClasses({ variant: "primary" })}>
              Sign in
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
