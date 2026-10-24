import { Activity, BookOpenCheck, Scale, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { ThemePreference } from "../shell/types";

/**
 * Frame of the public sign-in pages (/login, /forgot-password, /update-password; docs/V2_ARCHITECTURE.md §14.12): the
 * product statement beside the form on wide screens, the form alone under the brand on phones. Copy stays truthful:
 * access is invitation-only and Trading OS never executes trades at a broker. The stored theme choice applies here as
 * well (`system` follows the device).
 */

const PRINCIPLES = [
  { icon: BookOpenCheck, title: "Plan before you trade", text: "Your written strategy, thesis and screenshots, recorded before entry." },
  { icon: Scale, title: "Risk checked by rules, not mood", text: "A deterministic risk check runs before any plan is locked." },
  { icon: ShieldCheck, title: "History you can trust", text: "Locked plans and journal entries are time-stamped and never rewritten." },
] as const;

export const NO_EXECUTION_COPY = "Trading OS records plans, decisions and results. It never connects to a broker to place or change trades.";

function Brand() {
  return (
    <p className="flex items-center gap-2.5 text-base font-bold tracking-tight text-text">
      <span aria-hidden="true" className="brand-mark">
        <Activity />
      </span>
      Trading OS
    </p>
  );
}

export function AuthFrame({ theme, children }: { theme: ThemePreference; children: ReactNode }) {
  return (
    <div data-theme={theme === "system" ? undefined : theme} className="grid min-h-dvh bg-bg text-text lg:grid-cols-2">
      <aside className="hidden border-r border-border bg-surface lg:flex">
        <div className="ml-auto flex w-full max-w-xl flex-col justify-between gap-12 px-12 py-12 xl:px-16">
          <Brand />
          <div className="flex max-w-md flex-col gap-8">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium text-accent">Private trading workstation</p>
              <p className="text-3xl font-semibold leading-tight tracking-tight text-text">Decide deliberately. Keep an honest record of every trade.</p>
              <p className="text-2">One place for your strategy, your risk limits and the decisions you made before, during and after each trade.</p>
            </div>
            <ul className="flex flex-col gap-4">
              {PRINCIPLES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-start gap-3">
                  <span aria-hidden="true" className="grid size-8 flex-none place-items-center rounded-[8px] border border-border bg-bg text-accent">
                    <Icon className="size-4" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold text-text">{title}</span>
                    <span className="t-meta">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="t-caption max-w-md">{NO_EXECUTION_COPY}</p>
        </div>
      </aside>
      <main id="main-content" className="flex flex-col items-center gap-6 px-4 pt-8 pb-10 sm:justify-center sm:px-8 sm:py-12">
        <div className="w-full max-w-[25rem] lg:hidden">
          <Brand />
        </div>
        <div className="w-full max-w-[25rem] rounded-card border border-border bg-surface p-5 shadow-raised sm:p-7">{children}</div>
        <p className="t-caption w-full max-w-[25rem] lg:hidden">{NO_EXECUTION_COPY}</p>
      </main>
    </div>
  );
}

/** Title block of an auth card: the page's only `h1`. */
export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold leading-7 tracking-tight text-text">{title}</h1>
      {description && <p className="t-meta">{description}</p>}
    </div>
  );
}
