"use client";

import { useLinkStatus } from "next/link";

/**
 * Click feedback inside a primary navigation link. Today, Journal and Accounts render their data in the first paint
 * (no route skeleton) and links are not prefetched, so a navigation waits for the server while the current page stays
 * on screen. This fixed-size dot fades in (after a short delay, so fast navigations never flash) until it completes.
 */
export function NavPending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className="nav-pending" data-pending={pending ? "" : undefined} />;
}
