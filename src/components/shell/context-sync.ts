import type { AccountContextSelection, ShellAccount } from "./types";

/**
 * Keeps the header's trading-account context equal to the context of the page on screen (docs/V2_ARCHITECTURE.md
 * §9.2; master spec 60.11 "the selected Trading Account is always obvious"). Pure: the shell's AccountContextSync
 * component feeds it events and carries out the effects it returns.
 *
 * Why the shell has to know: the layout, and with it the header, is not rendered again on a client-side navigation.
 * - A URL with `?account=` renders its page for that context (the proxy mirrors the value into the request). The proxy
 *   only stores it for a page load, because it cannot tell the router's prefetches from navigations; for a client-side
 *   navigation the shell stores it afterwards with the account selector's action (`persist`).
 * - A URL without it renders from the stored cookie, which another tab may have changed. Tabs tell each other what they
 *   stored (`announce`), so each one knows the cookie; a tab whose page belongs to an older context refreshes when the
 *   person comes back to it or navigates (`refresh`), which also drops router-cached pages of the old context.
 */

/** A context as the cookie and `?account=` hold it: "all" or a trading account id (lowercase). */
export type ContextValue = string;
export const ALL_CONTEXT: ContextValue = "all";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function contextValue(selection: AccountContextSelection): ContextValue {
  return selection.mode === "all" ? ALL_CONTEXT : selection.accountId.toLowerCase();
}

export function contextSelection(value: ContextValue): AccountContextSelection {
  return value === ALL_CONTEXT ? { mode: "all" } : { mode: "account", accountId: value };
}

/** `?account=` as the proxy reads it: "all" or an account id (any case); null for anything else. */
export function parseContextParam(raw: string | null | undefined): ContextValue | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value === ALL_CONTEXT || UUID.test(value) ? value : null;
}

/**
 * The context a page renders for `?account=` (the server's §9.2 resolution): one of the person's active accounts, else
 * All Accounts (an archived, foreign or unknown id shows All Accounts with a notice).
 */
export function paramContext(param: ContextValue, accounts: readonly Pick<ShellAccount, "id" | "status">[]): ContextValue {
  if (param === ALL_CONTEXT) return ALL_CONTEXT;
  return accounts.some(account => account.id.toLowerCase() === param && account.status === "ACTIVE") ? param : ALL_CONTEXT;
}

export interface ContextSyncState {
  /** Last known value of the stored context (cookie `tos_account`). */
  stored: ContextValue;
  /** Context the page on screen was rendered with; the header shows it. */
  page: ContextValue;
  /** Another tab stored a context after this tab's pages were rendered: refresh at the next chance. */
  stale: boolean;
}

type Accounts = readonly Pick<ShellAccount, "id" | "status">[];

export type ContextSyncEvent =
  /**
   * A page reached by the router committed; `param` is its URL's `?account=` (parsed), or null. `unstored`: the shell
   * cannot know whether that context was stored yet (it first rendered here after a client-side navigation or a
   * prerender), so it stores it in any case.
   */
  | { type: "navigated"; param: ContextValue | null; accounts: Accounts; unstored?: boolean }
  /** The layout was rendered again (refresh, server action) with this context. */
  | { type: "rendered"; rendered: ContextValue; param: ContextValue | null; accounts: Accounts }
  /** This tab stored the context (the account action succeeded). */
  | { type: "stored"; value: ContextValue }
  /** Another tab stored the context. */
  | { type: "remote"; value: ContextValue }
  /** The person came back to this tab (it became visible or got focus). */
  | { type: "resumed" };

export interface ContextSyncEffects {
  /** Store this context with the account action (a client-side navigation to `?account=`). */
  persist?: ContextValue;
  /** Tell other tabs that this context is now stored. */
  announce?: ContextValue;
  /** Render the page and the layout again (and drop router-cached pages of an older context). */
  refresh?: true;
}

export function initialContextSync(rendered: ContextValue): ContextSyncState {
  return { stored: rendered, page: rendered, stale: false };
}

export function reduceContextSync(state: ContextSyncState, event: ContextSyncEvent): { state: ContextSyncState; effects: ContextSyncEffects } {
  switch (event.type) {
    case "navigated": {
      // The new page rendered for the URL's context, or from the cookie this tab knows.
      const page = event.param === null ? state.stored : paramContext(event.param, event.accounts);
      const effects: ContextSyncEffects = {};
      if (event.param !== null && (event.unstored || event.param !== state.stored)) effects.persist = event.param;
      if (state.stale) effects.refresh = true;
      return { state: { ...state, page, stale: false }, effects };
    }
    case "rendered": {
      // A layout rendered without `?account=`, or for a context other than the URL's (a server action renders from the
      // cookie), shows the stored context. Either way the page on screen is current, and the refresh or server action
      // that rendered it dropped the router's cached pages.
      const fromCookie = event.param === null || event.rendered !== paramContext(event.param, event.accounts);
      const stored = fromCookie ? event.rendered : state.stored;
      return { state: { stored, page: event.rendered, stale: false }, effects: stored !== state.stored ? { announce: stored } : {} };
    }
    case "stored":
      return { state: { ...state, stored: event.value }, effects: { announce: event.value } };
    case "remote":
      if (event.value === state.stored) return { state, effects: {} };
      return { state: { ...state, stored: event.value, stale: true }, effects: {} };
    case "resumed":
      return state.stale ? { state: { ...state, stale: false }, effects: { refresh: true } } : { state, effects: {} };
  }
}
