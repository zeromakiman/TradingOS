"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LEAVE_DESCRIPTION, LEAVE_TITLE } from "./copy";

/**
 * Keeps unsaved trade forms from being lost by accident: closing or reloading the tab asks the browser's own question,
 * and following a link inside the app (navigation, the P and L shortcuts, Cancel) asks first in a dialog. Back and
 * swipe-back can't be asked about; the forms keep their entries in the tab for those (`use-autosave.ts`). `release`
 * turns the guard off before the form navigates on purpose (after a save); `onDiscard` runs when the trader confirms
 * "Discard and leave", so the kept entries go too.
 */

/** True when the link leaves this page (another path or query); hash links and new tabs are left alone. */
export function leavesPage(href: string, current: string): boolean {
  const next = new URL(href, current);
  const here = new URL(current);
  return next.origin !== here.origin || next.pathname !== here.pathname || next.search !== here.search;
}

export function useLeaveGuard(active: boolean, onDiscard?: () => void) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const released = useRef(false);

  useEffect(() => {
    if (!active) return;
    released.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (released.current) return;
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (released.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      if (!leavesPage(link.href, window.location.href)) return;
      event.preventDefault();
      event.stopPropagation();
      setDestination(link.href);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [active]);

  const release = useCallback(() => {
    released.current = true;
  }, []);

  const leave = () => {
    if (!destination) return;
    released.current = true;
    onDiscard?.();
    const url = new URL(destination);
    setDestination(null);
    if (url.origin === window.location.origin) router.push(`${url.pathname}${url.search}${url.hash}`);
    else window.location.assign(url.href);
  };

  const dialog = (
    <ConfirmDialog
      open={destination !== null}
      onOpenChange={open => {
        if (!open) setDestination(null);
      }}
      title={LEAVE_TITLE}
      description={LEAVE_DESCRIPTION}
      cancelLabel="Keep editing"
      confirmLabel="Discard and leave"
      tone="danger"
      onConfirm={leave}
    />
  );
  return { dialog, release };
}
