import { Activity, Link2Off } from "lucide-react";
import Link from "next/link";
import { storedTheme } from "@/components/settings/auth-page-data";
import { LEGACY_LINK_DESCRIPTION, LEGACY_LINK_TITLE } from "@/components/trade/forms/copy";
import { buttonClasses } from "@/components/ui/button";

/**
 * `/journal/[id]` for a V1 plan that doesn't exist, isn't the signed-in user's, or isn't a plan id at all
 * (docs/V2_ARCHITECTURE.md §1.2, §13.7). The legacy route sits outside the app shell, so instead of the framework's bare
 * 404 it shows a card in the design system, in the stored theme, with the ways back into the app. It never says whether
 * the plan exists for someone else. Same card as the legacy `/analyze/[id]` link.
 */
export default async function LegacyPlanNotFound() {
  const theme = await storedTheme();
  return (
    <div data-theme={theme === "system" ? undefined : theme} className="flex min-h-dvh flex-col items-center gap-6 bg-bg px-4 pt-10 pb-12 text-text sm:justify-center sm:py-12">
      <p className="flex w-full max-w-[28rem] items-center gap-2.5 font-bold text-base text-text tracking-tight">
        <span aria-hidden="true" className="brand-mark">
          <Activity />
        </span>
        Trading OS
      </p>
      <main id="main-content" className="flex w-full max-w-[28rem] flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-raised sm:p-7">
        <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-surface-sunken text-text-2 ring-1 ring-border">
          <Link2Off className="size-5" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-semibold text-text text-xl leading-7 tracking-tight">{LEGACY_LINK_TITLE}</h1>
          <p className="t-meta">{LEGACY_LINK_DESCRIPTION}</p>
        </div>
        <div className="flex flex-wrap gap-2 max-sm:[&>a]:flex-1">
          <Link href="/today" className={buttonClasses({ variant: "primary" })}>
            Go to Today
          </Link>
          <Link href="/journal" className={buttonClasses({ variant: "secondary" })}>
            Open the Journal
          </Link>
        </div>
      </main>
    </div>
  );
}
