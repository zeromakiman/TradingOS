import { describe, expect, it } from "vitest";
import {
  ALL_CONTEXT,
  type ContextSyncEffects,
  type ContextSyncEvent,
  type ContextSyncState,
  contextSelection,
  contextValue,
  initialContextSync,
  paramContext,
  parseContextParam,
  reduceContextSync,
} from "@/components/shell/context-sync";
import type { ShellAccount } from "@/components/shell/types";

// The header's trading-account context always names the context of the page on screen (master spec 60.11, V2 §9.2).
// The layout (and the header) is not rendered again on a client-side navigation, and the proxy stores `?account=` only
// for page loads (it cannot tell the router's prefetches from navigations), so the shell follows the URL, stores the
// context of a client-side navigation itself, and learns from other tabs what they stored.

const FTMO = "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const PERSONAL = "2b1c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
const ARCHIVED = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const accounts: ShellAccount[] = [
  { id: FTMO, name: "FTMO 100K", currency: "USD", status: "ACTIVE", type: "EVALUATION" },
  { id: PERSONAL, name: "Personal EUR", currency: "EUR", status: "ACTIVE", type: "PERSONAL" },
  { id: ARCHIVED, name: "Old demo", currency: "USD", status: "ARCHIVED", type: "DEMO" },
];

/** Runs events in order and collects every effect. */
function run(start: ContextSyncState, events: ContextSyncEvent[]) {
  let state = start;
  const effects: ContextSyncEffects[] = [];
  for (const event of events) {
    const next = reduceContextSync(state, event);
    state = next.state;
    effects.push(next.effects);
  }
  return { state, effects };
}

const navigated = (param: string | null, unstored?: boolean): ContextSyncEvent => ({ type: "navigated", param, accounts, ...(unstored ? { unstored } : {}) });
const rendered = (value: string, param: string | null = null): ContextSyncEvent => ({ type: "rendered", rendered: value, param, accounts });

describe("context values", () => {
  it("parses ?account= the way the proxy does, and nothing else", () => {
    expect(parseContextParam("all")).toBe("all");
    expect(parseContextParam(` ${FTMO.toUpperCase()} `)).toBe(FTMO);
    for (const invalid of ["first", "", "ALL ACCOUNTS", `${FTMO}x`, null, undefined]) expect(parseContextParam(invalid)).toBeNull();
  });

  it("resolves the URL's context like the server: an active account, else All Accounts (never a fallback account)", () => {
    expect(paramContext(FTMO, accounts)).toBe(FTMO);
    expect(paramContext(ARCHIVED, accounts)).toBe(ALL_CONTEXT);
    expect(paramContext("20000000-0000-4000-8000-0000000000ff", accounts)).toBe(ALL_CONTEXT);
    expect(paramContext(ALL_CONTEXT, accounts)).toBe(ALL_CONTEXT);
  });

  it("converts between the shell's selection and the stored value", () => {
    expect(contextValue({ mode: "all" })).toBe("all");
    expect(contextValue({ mode: "account", accountId: FTMO.toUpperCase() })).toBe(FTMO);
    expect(contextSelection("all")).toEqual({ mode: "all" });
    expect(contextSelection(FTMO)).toEqual({ mode: "account", accountId: FTMO });
  });
});

describe("header context after navigations (item 16)", () => {
  it("shows the URL's account at once after a client-side navigation and stores it with the account action", () => {
    // Today in All Accounts → "Open FTMO" (/today?account=FTMO), a client-side navigation.
    const { state, effects } = run(initialContextSync(ALL_CONTEXT), [navigated(FTMO)]);
    expect(state.page).toBe(FTMO);
    expect(effects[0]).toEqual({ persist: FTMO });
    // The action succeeded, and its re-render names the URL's account: nothing more to store or announce.
    const after = run(state, [{ type: "stored", value: FTMO }, rendered(FTMO, FTMO)]);
    expect(after.state).toEqual({ stored: FTMO, page: FTMO, stale: false });
    expect(after.effects).toEqual([{ announce: FTMO }, {}]);
  });

  it("follows the stored context on pages without ?account=", () => {
    const { state, effects } = run(initialContextSync(FTMO), [navigated(FTMO), { type: "stored", value: FTMO }, navigated(null)]);
    expect(state).toEqual({ stored: FTMO, page: FTMO, stale: false });
    expect(effects[2]).toEqual({});
  });

  it("does not store a context that is already stored", () => {
    expect(run(initialContextSync(FTMO), [navigated(FTMO)]).effects).toEqual([{}]);
  });

  it("lets the server refuse an archived or foreign account: the page shows All Accounts, the action decides", () => {
    const { state, effects } = run(initialContextSync(FTMO), [navigated(ARCHIVED)]);
    expect(state.page).toBe(ALL_CONTEXT);
    expect(effects[0]).toEqual({ persist: ARCHIVED });
    // The refused action renders again (All Accounts with the notice); the stored context stays.
    expect(run(state, [rendered(ALL_CONTEXT, ARCHIVED)]).state).toEqual({ stored: FTMO, page: ALL_CONTEXT, stale: false });
  });

  it("stores the context of a page first rendered after a client-side navigation, even when it looks stored", () => {
    // Entering the app at /today?account=FTMO from the sign-in page: the proxy rendered it but did not store it.
    expect(run(initialContextSync(FTMO), [navigated(FTMO, true)]).effects).toEqual([{ persist: FTMO }]);
  });
});

describe("header selector on a page whose URL names a context (item 18)", () => {
  it("follows the option's link and stores the new context, so header, page and cookie agree", () => {
    // /review/history?account=all, then FTMO is chosen: the option links to /review/history?account=FTMO.
    const { state, effects } = run(initialContextSync(ALL_CONTEXT), [navigated(ALL_CONTEXT), navigated(FTMO)]);
    expect(state.page).toBe(FTMO);
    expect(effects).toEqual([{}, { persist: FTMO }]);
  });

  it("takes the stored context from a server action's re-render, which renders from the cookie", () => {
    // A page whose URL says FTMO re-renders after an action while another tab stored Personal: the page now shows
    // Personal, and so does the header; the stored value is learnt and announced.
    const { state, effects } = run(initialContextSync(FTMO), [rendered(PERSONAL, FTMO)]);
    expect(state).toEqual({ stored: PERSONAL, page: PERSONAL, stale: false });
    expect(effects).toEqual([{ announce: PERSONAL }]);
  });

  it("learns the stored context when the selector's action re-renders a page without ?account=", () => {
    const { state, effects } = run(initialContextSync(ALL_CONTEXT), [rendered(PERSONAL)]);
    expect(state).toEqual({ stored: PERSONAL, page: PERSONAL, stale: false });
    expect(effects).toEqual([{ announce: PERSONAL }]);
  });
});

describe("other tabs (Ctrl/middle-click, two windows)", () => {
  it("keeps showing the context its page was rendered with until the person comes back, then renders again", () => {
    // A new tab opened with ?account=Personal stored it (page load) and announced it.
    const { state, effects } = run(initialContextSync(FTMO), [{ type: "remote", value: PERSONAL }]);
    expect(state).toEqual({ stored: PERSONAL, page: FTMO, stale: true });
    expect(effects).toEqual([{}]);
    const back = run(state, [{ type: "resumed" }, rendered(PERSONAL)]);
    expect(back.effects[0]).toEqual({ refresh: true });
    expect(back.state).toEqual({ stored: PERSONAL, page: PERSONAL, stale: false });
  });

  it("names the newly stored context after its next navigation, and renders again to drop cached pages", () => {
    const { state, effects } = run(initialContextSync(FTMO), [{ type: "remote", value: PERSONAL }, navigated(null)]);
    expect(state.page).toBe(PERSONAL);
    expect(effects[1]).toEqual({ refresh: true });
    expect(state.stale).toBe(false);
  });

  it("ignores an announcement of what it already knows, and a return without changes", () => {
    expect(run(initialContextSync(FTMO), [{ type: "remote", value: FTMO }, { type: "resumed" }]).effects).toEqual([{}, {}]);
  });
});

describe("prefetches", () => {
  it("never reach the shell: only committed navigations, renders and other tabs change what it knows", () => {
    // A hovered link to another account is fetched by the router without any of these events; a reload then renders
    // from the unchanged cookie (the proxy stores only page loads), which is what the shell still knows.
    const state = initialContextSync(FTMO);
    expect(run(state, [rendered(FTMO)]).state).toEqual(state);
  });
});
