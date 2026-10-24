"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useReviewTransition } from "./pending";

/**
 * Links that change the Review page's URL state (sample size, history filter and pages, previous / next period, the
 * account chooser) navigate inside the page transition, so the current view stays visible, dimmed, until the next one
 * is ready (§13.7). Modified clicks (new tab, new window) keep the browser's behaviour, and the links work without
 * JavaScript.
 */

/** A plain primary-button click with no modifier, not yet handled: the only click the page takes over. */
export function plainClick(event: MouseEvent<Element>): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export type TransitionLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onClick"> & { href: string };

export function TransitionLink({ href, children, ...props }: TransitionLinkProps) {
  const router = useRouter();
  const { start } = useReviewTransition();
  return (
    <Link
      href={href}
      scroll={false}
      onClick={event => {
        if (!plainClick(event)) return;
        event.preventDefault();
        start(() => router.push(href, { scroll: false }));
      }}
      {...props}
    >
      {children}
    </Link>
  );
}

/**
 * The same for links rendered by shared components (the Pagination primitive): plain clicks on same-origin links inside
 * it are taken over before the link's own handler runs, which then leaves them alone. The page scrolls to the top
 * once the next view arrives, like any page change.
 */
export function TransitionScope({ children, className }: { children: ReactNode; className?: string }) {
  const router = useRouter();
  const { start } = useReviewTransition();
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!plainClick(event) || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || !event.currentTarget.contains(anchor)) return;
    if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    start(() => router.push(`${url.pathname}${url.search}${url.hash}`));
  };
  return (
    <div className={className} onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}
