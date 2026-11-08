"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, createContext, type ReactNode, type TransitionStartFunction, useContext, useTransition } from "react";
import { Refetching } from "@/components/ui/skeleton";

/**
 * Filter changes navigate inside a transition: the previous results stay visible, dimmed, until the new ones arrive
 * (§13.7, "refetch keeps the previous render dimmed").
 */

type EdgeTransitionValue = { pending: boolean; start: TransitionStartFunction };

const EdgeTransitionContext = createContext<EdgeTransitionValue | null>(null);

export function EdgeTransition({ children }: { children: ReactNode }) {
  const [pending, start] = useTransition();
  return <EdgeTransitionContext.Provider value={{ pending, start }}>{children}</EdgeTransitionContext.Provider>;
}

/** The page transition; outside the provider a local one. */
export function useEdgeTransition(): EdgeTransitionValue {
  const shared = useContext(EdgeTransitionContext);
  const [pending, start] = useTransition();
  return shared ?? { pending, start };
}

/** Results that dim while a filter change loads. */
export function EdgePendingRegion({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useEdgeTransition();
  return (
    <Refetching pending={pending} className={className}>
      {children}
    </Refetching>
  );
}

export type PendingLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & {
  href: string;
  /** The transition to navigate in; the page's by default (every result dims). */
  start?: TransitionStartFunction;
};

/**
 * A link to another EDGE state (reset filters, remove a filter, another calendar month) whose client navigation runs
 * in a transition, so the results it replaces stay visible, dimmed and `aria-busy`, until the new ones arrive. A plain
 * link otherwise: the URL is real, and opening it in a new tab or window works as usual (Next calls `onNavigate` only
 * for client navigations).
 */
export function PendingLink({ href, start, scroll = false, ...props }: PendingLinkProps) {
  const router = useRouter();
  const page = useEdgeTransition();
  const run = start ?? page.start;
  return (
    <Link
      href={href}
      scroll={scroll}
      {...props}
      onNavigate={event => {
        event.preventDefault();
        run(() => router.push(href, { scroll }));
      }}
    />
  );
}
