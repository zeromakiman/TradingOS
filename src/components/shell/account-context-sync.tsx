"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, type ReactNode, startTransition, useCallback, useContext, useEffect, useRef, useState } from "react";
import { accountFields, callShellAction } from "./actions";
import {
  type ContextSyncEvent,
  type ContextSyncState,
  type ContextValue,
  contextSelection,
  contextValue,
  initialContextSync,
  parseContextParam,
  reduceContextSync,
} from "./context-sync";
import type { AccountContextSelection, SelectAccountAction, ShellAccount } from "./types";

/** Tabs of this browser tell each other the context they stored (src/components/shell/context-sync.ts). */
export const CONTEXT_CHANNEL = "tos.account-context";

const SelectionContext = createContext<AccountContextSelection | null>(null);

/** The context of the page on screen, which the header shows; `fallback` outside the shell (tests, isolated views). */
export function useAccountContextSelection(fallback: AccountContextSelection): AccountContextSelection {
  return useContext(SelectionContext) ?? fallback;
}

type Router = ReturnType<typeof useRouter>;

/** Whether this document was loaded (or reloaded) at the current address, rather than reached by the router. */
function loadedAtCurrentAddress(): boolean {
  const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!entry) return true;
  const strip = (href: string) => href.split("#")[0];
  return strip(entry.name) === strip(window.location.href);
}

/** The first shell of this document sees its page load; a later one (after leaving and re-entering the app) does not. */
let documentShellMounted = false;

export type AccountContextSyncProps = {
  accounts: ShellAccount[];
  /** The context the layout was rendered with. */
  context: AccountContextSelection;
  /** Stores a context (cookie `tos_account`); without it the shell only follows the URL. */
  selectAccountAction?: SelectAccountAction;
  children: ReactNode;
};

/**
 * Keeps the header's context equal to the context of the page on screen, in every tab, and stores the context of a
 * client-side navigation to `?account=` (the proxy only stores it for page loads, so prefetches never switch it).
 */
export function AccountContextSync({ accounts, context, selectAccountAction, children }: AccountContextSyncProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const query = search?.toString() ?? "";
  const param = parseContextParam(search?.get("account"));
  const rendered = contextValue(context);
  const [state, setState] = useState<ContextSyncState>(() => initialContextSync(rendered));
  const live = useRef<{ state: ContextSyncState; accounts: ShellAccount[]; param: ContextValue | null; router: Router; action?: SelectAccountAction }>({
    state, accounts, param, router, action: selectAccountAction,
  });
  const channel = useRef<BroadcastChannel | null>(null);

  // Listeners and effects read the latest props.
  useEffect(() => {
    live.current = { ...live.current, accounts, param, router, action: selectAccountAction };
  });

  const dispatch = useCallback((event: ContextSyncEvent) => {
    const { state: next, effects } = reduceContextSync(live.current.state, event);
    live.current.state = next;
    setState(next);
    if (effects.announce) channel.current?.postMessage({ value: effects.announce });
    if (effects.refresh) startTransition(() => live.current.router.refresh());
    const value = effects.persist;
    const action = live.current.action;
    if (value === undefined || !action) return;
    startTransition(async () => {
      const outcome = await callShellAction(action, accountFields(value));
      // A refused context (archived or not the person's) renders again: the page shows All Accounts and the notice.
      if (outcome.ok) dispatch({ type: "stored", value });
      else live.current.router.refresh();
    });
  }, []);

  // Other tabs' stored contexts.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const opened = new BroadcastChannel(CONTEXT_CHANNEL);
    opened.onmessage = (event: MessageEvent<{ value?: unknown }>) => {
      const value = typeof event.data?.value === "string" ? parseContextParam(event.data.value) : null;
      if (value !== null) dispatch({ type: "remote", value });
    };
    channel.current = opened;
    return () => {
      opened.close();
      if (channel.current === opened) channel.current = null;
    };
  }, [dispatch]);

  // The page this shell first rendered: a page load stored its context (the proxy), a page reached by the router did not.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const pageLoad = !documentShellMounted && loadedAtCurrentAddress();
    documentShellMounted = true;
    const start = (stored: boolean) => {
      const { param: current, accounts: known, state: now } = live.current;
      if (current !== null && !stored) dispatch({ type: "navigated", param: current, accounts: known, unstored: true });
      else channel.current?.postMessage({ value: now.stored });
    };
    const doc = document as Document & { prerendering?: boolean };
    // A prerendered page was never stored by the proxy (speculative load): it counts once the person opens it.
    if (doc.prerendering) {
      document.addEventListener("prerenderingchange", () => start(false), { once: true });
      return;
    }
    start(pageLoad);
  }, [dispatch]);

  // Client-side navigations (the first location is the page this shell was rendered with).
  const location = `${pathname}?${query}`;
  const seenLocation = useRef(location);
  useEffect(() => {
    if (seenLocation.current === location) return;
    seenLocation.current = location;
    dispatch({ type: "navigated", param: live.current.param, accounts: live.current.accounts });
  }, [location, dispatch]);

  // The layout rendered again (refresh or server action).
  const seenRendered = useRef(rendered);
  useEffect(() => {
    if (seenRendered.current === rendered) return;
    seenRendered.current = rendered;
    dispatch({ type: "rendered", rendered, param: live.current.param, accounts: live.current.accounts });
  }, [rendered, dispatch]);

  // Coming back to the tab; a page restored from the browser's back-forward cache may belong to an older context.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible") dispatch({ type: "resumed" });
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) startTransition(() => live.current.router.refresh());
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", restored);
    };
  }, [dispatch]);

  return <SelectionContext.Provider value={contextSelection(state.page)}>{children}</SelectionContext.Provider>;
}
