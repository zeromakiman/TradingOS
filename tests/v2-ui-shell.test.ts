import { DropdownMenu as RadixMenu, Dialog as RadixDialog } from "radix-ui";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/today" as string | null, search: "" }));
// The real module stays underneath, so redirect() and unstable_rethrow() behave as in the app.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
}));

import { redirect } from "next/navigation";
import { nextBoundary } from "@/domain/session";
import { AccountMenuItems } from "@/components/shell/account-selector";
import { accountFields, callShellAction, persistChoice, switchAccountContext, themeFields, timeDisplayFields } from "@/components/shell/actions";
import { AppShell, type AppShellProps } from "@/components/shell/app-shell";
import { CommandPaletteBody } from "@/components/shell/command-palette";
import { fuzzyScore, rankByQuery } from "@/components/shell/fuzzy";
import { MobileTabBar } from "@/components/shell/mobile-tab-bar";
import { activeNavKey, contextLabel, withAccountParam } from "@/components/shell/navigation";
import { clearPaletteHistory, readPaletteHistory, recentItemIds, rememberPaletteItem } from "@/components/shell/palette-history";
import { buildPaletteItems, paletteSections } from "@/components/shell/palette-items";
import { browserTimeZone, readCookie, SHORTCUTS_COOKIE, singleKeyShortcutsEnabled } from "@/components/shell/preferences";
import { clockOffset, formatMinutes, minutesUntil, SESSION_LABELS } from "@/components/shell/session-labels";
import { ShellProviders } from "@/components/shell/shell-providers";
import { SingleKeyShortcutsSwitch } from "@/components/shell/shortcut-help";
import { isTypingTarget, type ShortcutKeyEvent, shortcutFor } from "@/components/shell/shortcuts";
import { StrategyClock } from "@/components/shell/strategy-clock";
import { TimeDisplayProvider, useTimeFormat } from "@/components/shell/time-display";
import { TimeDisplaySwitcher } from "@/components/shell/time-display-switcher";
import type {
  PaletteIndex,
  PaletteTrade,
  SelectAccountAction,
  SetThemeAction,
  SetTimeDisplayAction,
  ShellAccount,
  ShellAction,
  SignOutAction,
  TimeDisplay,
} from "@/components/shell/types";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const accounts: ShellAccount[] = [
  { id: "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f", name: "FTMO 100K", currency: "USD", status: "ACTIVE", type: "EVALUATION" },
  { id: "2b1c4d5e-6f70-4812-9a3b-4c5d6e7f8091", name: "Personal EUR", currency: "EUR", status: "ACTIVE", type: "PERSONAL" },
  { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "Old demo", currency: "USD", status: "ARCHIVED", type: "DEMO" },
];

const trade = (id: string, overrides: Partial<PaletteTrade> = {}): PaletteTrade => ({
  id,
  symbol: "EURUSD",
  direction: "LONG",
  accountName: "FTMO 100K",
  dateLabel: "Oct 14",
  stateLabel: "Closed · review pending",
  tags: ["breakout"],
  resultLabel: "+1.20R",
  ...overrides,
});

const paletteIndex: PaletteIndex = {
  accounts,
  liveTrades: [trade("aaaaaaaa-0000-4000-8000-000000000001", { symbol: "GBPUSD", direction: "SHORT", stateLabel: "Live", resultLabel: null, tags: ["london", "breakout"] })],
  recentTrades: [trade("aaaaaaaa-0000-4000-8000-000000000001", { symbol: "GBPUSD", stateLabel: "Live" }), trade("bbbbbbbb-0000-4000-8000-000000000002"), trade("cccccccc-0000-4000-8000-000000000003", { accountName: "Personal EUR", tags: [] })],
};

const shellProps = (overrides: Partial<AppShellProps> = {}): AppShellProps => ({
  user: { email: "trader@example.com" },
  accounts,
  context: { mode: "all" },
  clock: { nowIso: "2026-10-14T14:42:00Z" },
  paletteIndex,
  developerMode: false,
  theme: "system",
  children: createElement("h1", null, "Today"),
  ...overrides,
});

const render = (props: AppShellProps) => renderToStaticMarkup(createElement(AppShell, props));

/** Renders a component whose props include required children. */
const view = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));

/** Text a person can see or hear: text nodes plus accessible-name attributes. */
const visibleText = (markup: string) => [markup.replace(/<[^>]+>/g, " "), ...[...markup.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((match) => match[1])].join(" ");

beforeEach(() => {
  navigation.pathname = "/today";
  navigation.search = "";
});

describe("AppShell", () => {
  it("renders landmarks, the skip link and every primary navigation destination", () => {
    const markup = render(shellProps());
    expect(markup).toContain('<a class="skip-link" href="#main-content">Skip to main content</a>');
    expect(markup).toContain('<main id="main-content" tabindex="-1" class="app-content">');
    expect(markup).toContain('<header class="app-topbar">');
    expect(markup).toContain('<nav aria-label="Primary">');
    for (const [label, href] of [
      ["Today", "/today"],
      ["Journal", "/journal"],
      ["Accounts", "/accounts"],
      ["EDGE", "/edge"],
      ["Review", "/review"],
      ["Settings", "/settings"],
    ]) {
      expect(markup).toMatch(new RegExp(`<a class="nav-link"[^>]*href="${href}"[^>]*>.*?<span class="sidebar-label">${label}</span>`));
    }
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });

  it("marks the active section, with trade pages under Journal", () => {
    navigation.pathname = "/trades/bbbbbbbb-0000-4000-8000-000000000002";
    const markup = render(shellProps());
    expect(markup).toMatch(/<a class="nav-link" aria-current="page" href="\/journal">/);
    expect(markup).not.toMatch(/<a class="nav-link" aria-current="page" href="\/today">/);
  });

  it("shows All Accounts in the selector for the aggregate context", () => {
    const markup = render(shellProps({ context: { mode: "all" } }));
    expect(markup).toContain('<span class="account-trigger-value">All Accounts</span>');
    expect(markup).toContain("Trading Account:");
    expect(markup).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*class="account-trigger"/);
  });

  it("shows the account name for an account context and never its id", () => {
    const markup = render(shellProps({ context: { mode: "account", accountId: accounts[0].id } }));
    expect(markup).toContain('<span class="account-trigger-value">FTMO 100K</span>');
    expect(visibleText(markup)).not.toMatch(UUID);
    expect(contextLabel(accounts, { mode: "account", accountId: "unknown" })).toBe("All Accounts");
  });

  it("offers both primary actions on every page", () => {
    const markup = render(shellProps());
    expect(markup).toMatch(/<a id="shell-action-plan" class="btn btn-primary"[^>]*href="\/trades\/new">.*?Plan Trade<\/a>/);
    expect(markup).toMatch(/<a id="shell-action-live" class="btn btn-secondary"[^>]*aria-label="Record Live Trade" href="\/trades\/live\/new">/);
    expect(markup).toContain("Search trades, accounts and commands");
  });

  it("renders the mobile tab bar with the new-trade sheet trigger and More", () => {
    const markup = render(shellProps());
    expect(markup).toContain('<nav class="mobile-tabbar" aria-label="Primary">');
    expect(markup).toContain('<span class="sr-only">New trade</span>');
    expect(markup).toMatch(/<button[^>]*class="tabbar-item"[^>]*>.*?<span>More<\/span><\/button>/);
  });

  it("keeps raw ids out of visible text, includes the clock and a toast region, and shows a notice", () => {
    const markup = render(shellProps({ notice: "That trading account isn't available. Showing All Accounts." }));
    expect(visibleText(markup)).not.toMatch(UUID);
    expect(markup).toContain('<span class="strategy-clock-time">09:42</span>');
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).toMatch(/role="status"[^>]*>.*That trading account isn(&#x27;|')t available/);
  });

  it("starts collapsed when the layout passes the stored sidebar preference", () => {
    expect(render(shellProps({ sidebarCollapsed: true }))).toContain('data-sidebar="collapsed"');
    expect(render(shellProps())).toContain('data-sidebar="expanded"');
  });
});

describe("MobileTabBar", () => {
  it("highlights More for EDGE, Review and Settings", () => {
    navigation.pathname = "/review/weekly";
    const markup = view(ShellProviders, {
      developerMode: false,
      timeDisplay: { mode: "strategy" },
      sidebarCollapsed: false,
      children: createElement(MobileTabBar, { email: "trader@example.com", theme: "light", timeDisplay: { mode: "strategy" } }),
    });
    expect(markup).toMatch(/aria-current="page"[^>]*>.*?<span>More<\/span>/);
  });
});

describe("Strategy clock", () => {
  it("renders strategy time, session and next boundary from the server time", () => {
    const markup = renderToStaticMarkup(createElement(StrategyClock, { nowIso: "2026-10-14T14:42:00Z" }));
    expect(markup).toContain('aria-label="Strategy clock 09:42 UTC−5, Kill zone. Next: Dead Pool at 12:00, in 2h 18m."');
    expect(markup).toContain('data-session="ACTIVE_KILL_ZONE"');
    expect(markup).not.toContain("ACTIVE_KILL_ZONE<");
  });

  it.each([
    ["2026-10-14T16:59:30Z", "11:59 UTC−5, Kill zone", "Dead Pool at 12:00, in 1m"],
    ["2026-10-14T17:00:00Z", "12:00 UTC−5, Dead Pool", "Asia at 18:00, in 6h"],
    ["2026-10-14T22:59:00Z", "17:59 UTC−5, Dead Pool", "Asia at 18:00, in 1m"],
    ["2026-10-15T05:30:00Z", "00:30 UTC−5, Asia", "Judas at 01:00, in 30m"],
    ["2026-10-15T06:00:00Z", "01:00 UTC−5, Judas", "Kill zone at 02:00, in 1h"],
  ] as const)("at %s the clock reads %s and next %s", (now, current, next) => {
    const markup = renderToStaticMarkup(createElement(StrategyClock, { nowIso: now }));
    expect(markup).toContain(`aria-label="Strategy clock ${current}. Next: ${next}."`);
    // The boundary is the domain's exact nextBoundary, the same source as Today's session ribbon.
    const boundary = nextBoundary(now);
    expect(next).toBe(`${SESSION_LABELS[boundary.session]} at ${boundary.time}, in ${formatMinutes(minutesUntil(Date.parse(boundary.at), Date.parse(now)))}`);
  });

  it("formats durations and labels sessions in trader words", () => {
    expect(formatMinutes(138)).toBe("2h 18m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(5)).toBe("5m");
    expect(Object.values(SESSION_LABELS)).toEqual(["Asia", "Judas", "Kill zone", "Dead Pool"]);
  });

  it("shows the countdown to the next boundary on wide screens", () => {
    const markup = renderToStaticMarkup(createElement(StrategyClock, { nowIso: "2026-10-15T05:30:00Z" }));
    expect(markup).toContain('<span class="strategy-clock-time">00:30</span>');
    expect(markup).toContain('data-session="ASIA">Asia</span>');
    expect(markup).toContain("· Judas in 30m");
  });

  it("follows the server clock but treats a browser just after the render time as page-load delay", () => {
    const server = Date.parse("2026-10-14T14:42:00Z");
    expect(clockOffset(server, server)).toBe(0);
    expect(clockOffset(server, server + 3_000)).toBe(0);
    expect(clockOffset(server, server + 60_000)).toBe(0);
    // A browser running behind, or far ahead, is skewed: the server time wins.
    expect(clockOffset(server, server - 5_000)).toBe(5_000);
    expect(clockOffset(server, server + 10 * 60_000)).toBe(-10 * 60_000);
  });
});

describe("Time display", () => {
  function Probe({ instant }: { instant: string }) {
    const format = useTimeFormat();
    return createElement("p", null, `${format.dateTime(instant)} ${format.zone(instant)} · ${format.day(instant)} · ${format.time(instant)}`);
  }
  const probe = (display: TimeDisplay) => view(TimeDisplayProvider, { value: display, children: createElement(Probe, { instant: "2026-10-14T03:15:00Z" }) });

  it("formats instants in the provided display: strategy UTC−5, UTC or a local zone", () => {
    expect(renderToStaticMarkup(createElement(Probe, { instant: "2026-10-14T03:15:00Z" }))).toBe("<p>Oct 13, 22:15 UTC−5 · Oct 13 · 22:15</p>");
    expect(probe({ mode: "utc" })).toBe("<p>Oct 14, 03:15 UTC · Oct 14 · 03:15</p>");
    expect(probe({ mode: "local", zone: "Asia/Tokyo" })).toBe("<p>Oct 14, 12:15 GMT+9 · Oct 14 · 12:15</p>");
  });

  it("captures the browser zone for Local time", () => {
    const zone = browserTimeZone();
    expect(typeof zone).toBe("string");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
  });

  it("renders the time display switch, disabled until a server action can persist it", () => {
    const disabled = renderToStaticMarkup(createElement(TimeDisplaySwitcher, { mode: "utc" }));
    expect(disabled).toContain('<fieldset class="choice-group" disabled="">');
    expect(disabled).toContain('<input type="radio" name="time-display" checked="" value="utc"/>');
    expect(disabled).toContain("Strategy time (UTC−5)");
    const saved: SetTimeDisplayAction = async () => ({ status: "success" });
    const enabled = renderToStaticMarkup(createElement(TimeDisplaySwitcher, { mode: "strategy", setTimeDisplayAction: saved }));
    expect(enabled).not.toContain("disabled");
  });
});

describe("Context actions", () => {
  /** The §12.2 `ActionState<T>` exactly as src/app/actions/state.ts defines it. */
  type SpecActionState<T = undefined> = { status: "idle" } | { status: "success"; message?: string; data?: T } | { status: "error"; message: string; fieldErrors?: Record<string, string> };

  /** The error Next.js throws for redirect(); an action that redirects rejects with it on the client. */
  const redirectError = (): unknown => {
    try {
      redirect("/login?reason=signed_out");
    } catch (error) {
      return error;
    }
  };
  const unreachable: ShellAction = () => Promise.reject(new TypeError("Failed to fetch"));

  it("accepts actions in the §12.2 shape, and the V1 logout action for sign-out", () => {
    const setAccountContext = async (_prev: SpecActionState, form: FormData): Promise<SpecActionState> => (form.get("account") ? { status: "success" } : { status: "error", message: "Choose a trading account." });
    const withData = async (_prev: SpecActionState<{ theme: string }>, form: FormData): Promise<SpecActionState<{ theme: string }>> => ({ status: "success", data: { theme: String(form.get("theme")) } });
    const logout = async (): Promise<never> => {
      throw redirectError();
    };
    const select: SelectAccountAction = setAccountContext;
    const theme: SetThemeAction = withData;
    const time: SetTimeDisplayAction = setAccountContext;
    const signOut: SignOutAction = logout;
    expect([select, theme, time, signOut].every((action) => typeof action === "function")).toBe(true);
  });

  it("calls an action with the idle state and a FormData of the documented fields", async () => {
    const calls: { prev: unknown; fields: [string, FormDataEntryValue][] }[] = [];
    const record: ShellAction = async (prev, form) => {
      calls.push({ prev, fields: [...form.entries()] });
      return { status: "success" };
    };
    await expect(callShellAction(record, accountFields("all"))).resolves.toEqual({ ok: true });
    await callShellAction(record, accountFields(accounts[0].id));
    await callShellAction(record, themeFields("dark"));
    await callShellAction(record, timeDisplayFields("local", "Europe/Berlin"));
    await callShellAction(record, timeDisplayFields("utc", undefined));
    await callShellAction(record);
    expect(calls).toEqual([
      { prev: { status: "idle" }, fields: [["account", "all"]] },
      { prev: { status: "idle" }, fields: [["account", accounts[0].id]] },
      { prev: { status: "idle" }, fields: [["theme", "dark"]] },
      { prev: { status: "idle" }, fields: [["mode", "local"], ["zone", "Europe/Berlin"]] },
      { prev: { status: "idle" }, fields: [["mode", "utc"]] },
      { prev: { status: "idle" }, fields: [] },
    ]);
  });

  it("treats an error state like a thrown error: the choice is reverted, then reported with the action's message", async () => {
    const log: string[] = [];
    const handlers = { revert: () => log.push("revert"), notify: (message: string | null) => log.push(`notify: ${message ?? "no message"}`) };
    const saved: ShellAction = async () => ({ status: "success" });
    const refused: ShellAction = async () => ({ status: "error", message: "Database update required. No changes were made." });
    await expect(persistChoice(saved, themeFields("dark"), handlers)).resolves.toBe(true);
    expect(log).toEqual([]);
    await expect(persistChoice(refused, timeDisplayFields("utc", undefined), handlers)).resolves.toBe(false);
    await expect(persistChoice(unreachable, timeDisplayFields("utc", undefined), handlers)).resolves.toBe(false);
    expect(log).toEqual(["revert", "notify: Database update required. No changes were made.", "revert", "notify: no message"]);
  });

  it("switches the account context in place, and follows the ?account= link when the action fails", async () => {
    const pushed: string[] = [];
    const navigate = (href: string) => pushed.push(href);
    const href = `/journal?model=OTE&account=${accounts[1].id}`;
    await switchAccountContext(async () => ({ status: "success" }), accounts[1].id, href, navigate);
    expect(pushed).toEqual([]);
    await switchAccountContext(async () => ({ status: "error", message: "That trading account isn't available." }), accounts[1].id, href, navigate);
    await switchAccountContext(unreachable, accounts[1].id, href, navigate);
    expect(pushed).toEqual([href, href]);
  });

  it("leaves a redirect (for example to sign in again) to Next.js instead of treating it as a failure", async () => {
    const error = redirectError();
    const redirecting: ShellAction = () => Promise.reject(error);
    const pushed: string[] = [];
    const log: string[] = [];
    await expect(switchAccountContext(redirecting, "all", "/today?account=all", (href) => pushed.push(href))).rejects.toBe(error);
    await expect(persistChoice(redirecting, themeFields("light"), { revert: () => log.push("revert"), notify: () => log.push("notify") })).rejects.toBe(error);
    expect(pushed).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("Command palette index", () => {
  it("contains actions, navigation, accounts, live and recent trades and tags without raw ids in labels", () => {
    const items = buildPaletteItems(paletteIndex, { mode: "all" }, "/journal?model=OTE");
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("action:plan")?.href).toBe("/trades/new");
    expect(byId.get("action:live")?.href).toBe("/trades/live/new");
    expect(items.filter((item) => item.title === "Add external loss").map((item) => item.subtitle)).toEqual(["FTMO 100K", "Personal EUR"]);
    expect(items.filter((item) => item.title === "Update account values")).toHaveLength(2);
    expect(items.filter((item) => item.group === "navigation").map((item) => item.title)).toEqual(["Today", "Journal", "EDGE", "Accounts", "Review", "Weekly review", "Monthly review", "Settings"]);
    expect(byId.get("account:all")).toMatchObject({ title: "All Accounts", accountValue: "all", href: "/journal?model=OTE&account=all" });
    expect(items.filter((item) => item.group === "accounts")).toHaveLength(4);
    expect(byId.get(`account:${accounts[0].id}`)).toMatchObject({ accountValue: accounts[0].id, href: `/journal?model=OTE&account=${accounts[0].id}` });
    // An archived account is never a context switch (§9.2): it opens its dashboard.
    const archived = byId.get(`account:${accounts[2].id}`);
    expect(archived).toMatchObject({ title: "Old demo", href: `/accounts/${accounts[2].id}`, subtitle: "USD · Demo · Archived · view history" });
    expect(archived?.accountValue).toBeUndefined();
    const live = items.filter((item) => item.group === "live");
    expect(live).toEqual([expect.objectContaining({ title: "GBPUSD · Short", href: "/trades/aaaaaaaa-0000-4000-8000-000000000001" })]);
    expect(items.filter((item) => item.group === "trades")).toHaveLength(2);
    // The live GBPUSD trade is also among the recent trades; it counts once.
    expect(items.filter((item) => item.group === "tags").map((item) => [item.title, item.subtitle, item.href])).toEqual([
      ["Tag: breakout", "2 trades · open in Journal", "/journal?tag=breakout"],
      ["Tag: london", "1 trade · open in Journal", "/journal?tag=london"],
    ]);
    for (const item of items) expect(`${item.title} ${item.subtitle ?? ""}`).not.toMatch(UUID);
  });

  it("limits account actions to the selected account", () => {
    const items = buildPaletteItems(paletteIndex, { mode: "account", accountId: accounts[1].id });
    expect(items.filter((item) => item.title === "Add external loss").map((item) => item.href)).toEqual([`/accounts/${accounts[1].id}/manage?tab=external-losses`]);
  });

  it("puts recently used items first and fuzzy-matches queries", () => {
    const items = buildPaletteItems(paletteIndex, { mode: "all" });
    const initial = paletteSections(items, "", ["nav:edge", "missing"]);
    expect(initial[0]).toEqual({ group: "recent", items: [expect.objectContaining({ id: "nav:edge" })] });
    expect(initial.find((section) => section.group === "navigation")?.items.some((item) => item.id === "nav:edge")).toBe(false);
    const results = paletteSections(items, "eur ftmo");
    expect(results.find((section) => section.group === "trades")?.items[0]).toMatchObject({ title: "EURUSD · Long", subtitle: expect.stringContaining("FTMO 100K") });
    expect(results.flatMap((section) => section.items).some((item) => item.subtitle?.includes("Personal EUR"))).toBe(false);
    expect(paletteSections(items, "zzzz")).toEqual([]);
    expect(paletteSections(items, "eurusd")[0].group).toBe("trades");
    expect(paletteSections(items, "weekly")[0]).toMatchObject({ group: "navigation", items: [expect.objectContaining({ title: "Weekly review" })] });
  });
});

describe("Command palette", () => {
  const palette = () =>
    renderToStaticMarkup(
      createElement(
        RadixDialog.Root,
        { open: true },
        createElement(CommandPaletteBody, { index: paletteIndex, context: { mode: "all" }, userEmail: "trader@example.com", onClose: () => undefined }),
      ),
    );

  it("can be closed by touch: a visible Cancel button closes the full-screen palette", () => {
    expect(palette()).toMatch(/<button class="btn btn-ghost btn-sm palette-cancel" type="button"[^>]*>Cancel<\/button>/);
  });

  it("switches context with links to the current page that keep its filters", () => {
    navigation.pathname = "/journal";
    navigation.search = "model=OTE&result=win";
    const markup = palette();
    expect(markup).toContain('href="/journal?model=OTE&amp;result=win&amp;account=all"');
    expect(markup).toContain(`href="/journal?model=OTE&amp;result=win&amp;account=${accounts[0].id}"`);
  });
});

describe("Account selector", () => {
  const menu = (context: AppShellProps["context"]) =>
    renderToStaticMarkup(createElement(RadixMenu.Root, { open: true }, createElement(RadixMenu.Content, null, createElement(AccountMenuItems, { accounts, context }))));

  it("offers All Accounts and active accounts as links to the current page with its filters kept", () => {
    navigation.pathname = "/edge";
    navigation.search = "model=OTE&account=all";
    const markup = menu({ mode: "all" });
    expect(markup).toContain('href="/edge?model=OTE&amp;account=all"');
    expect(markup).toContain(`href="/edge?model=OTE&amp;account=${accounts[1].id}"`);
    // Archived accounts open their dashboard instead of becoming the context.
    expect(markup).toContain(`href="/accounts/${accounts[2].id}"`);
    expect(markup).not.toContain(`account=${accounts[2].id}`);
  });
});

describe("Palette history", () => {
  /** In-memory stand-in for the browser's localStorage. */
  class MemoryStorage {
    private readonly entries = new Map<string, string>();
    get length() {
      return this.entries.size;
    }
    key(index: number) {
      return [...this.entries.keys()][index] ?? null;
    }
    getItem(key: string) {
      return this.entries.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.entries.set(key, value);
    }
    removeItem(key: string) {
      this.entries.delete(key);
    }
    dump() {
      return JSON.stringify([...this.entries]);
    }
  }
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => vi.unstubAllGlobals());

  const tradeId = "aaaaaaaa-0000-4000-8000-000000000001";

  it("remembers entries per user as hashes, never as tag text, record ids or the email", () => {
    rememberPaletteItem("trader@example.com", "tag:revenge trade");
    rememberPaletteItem("trader@example.com", `trade:${tradeId}`);
    rememberPaletteItem("trader@example.com", "tag:revenge trade");
    expect(storage.dump()).not.toMatch(/revenge|trader@example\.com/);
    expect(storage.dump()).not.toMatch(UUID);
    const history = readPaletteHistory(" Trader@Example.com ");
    expect(recentItemIds(["nav:edge", `trade:${tradeId}`, "tag:revenge trade"], history)).toEqual(["tag:revenge trade", `trade:${tradeId}`]);
    expect(readPaletteHistory("someone.else@example.com")).toEqual([]);
  });

  it("forgets every user's history at sign-out and leaves other storage alone", () => {
    rememberPaletteItem("a@example.com", "nav:edge");
    rememberPaletteItem("b@example.com", "nav:today");
    storage.setItem("tos.palette.recent", JSON.stringify(["trade:legacy"]));
    storage.setItem("unrelated", "kept");
    clearPaletteHistory();
    expect(readPaletteHistory("a@example.com")).toEqual([]);
    expect(readPaletteHistory("b@example.com")).toEqual([]);
    expect(storage.length).toBe(1);
    expect(storage.getItem("unrelated")).toBe("kept");
  });
});

describe("fuzzy matching", () => {
  it("matches substrings and in-order subsequences, preferring word starts", () => {
    expect(fuzzyScore("eu", "EURUSD · Long")).not.toBeNull();
    expect(fuzzyScore("eusd", "EURUSD")).not.toBeNull();
    expect(fuzzyScore("dsu", "EURUSD")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("Revue", "Review")).toBeNull();
    expect(fuzzyScore("cafe", "Café notes")).not.toBeNull();
    const ranked = rankByQuery(["Weekly review", "Review", "Recent trades review"], "rev", (text) => text);
    expect(ranked[0]).toBe("Review");
  });
});

describe("keyboard shortcuts", () => {
  const press = (key: string, target: unknown = { tagName: "BODY" }, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({ key, ctrlKey: false, metaKey: false, altKey: false, target, ...modifiers });

  it("maps single keys and Ctrl/⌘+K", () => {
    expect(shortcutFor(press("p"), { dialogOpen: false })).toBe("plan");
    expect(shortcutFor(press("L"), { dialogOpen: false })).toBe("live");
    expect(shortcutFor(press("j"), { dialogOpen: false })).toBe("journal");
    expect(shortcutFor(press("?"), { dialogOpen: false })).toBe("help");
    expect(shortcutFor(press("/"), { dialogOpen: false })).toBe("palette");
    expect(shortcutFor(press("k", { tagName: "INPUT", type: "text" }, { ctrlKey: true }), { dialogOpen: false })).toBe("palette");
    expect(shortcutFor(press("K", { tagName: "BODY" }, { metaKey: true }), { dialogOpen: true })).toBe("palette");
    expect(shortcutFor(press("x"), { dialogOpen: false })).toBeNull();
  });

  it("ignores single keys while typing, inside dialogs and with modifiers", () => {
    for (const target of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }, { tagName: "INPUT" }]) {
      expect(isTypingTarget(target)).toBe(true);
      expect(shortcutFor(press("p", target), { dialogOpen: false })).toBeNull();
    }
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(shortcutFor(press("p"), { dialogOpen: true })).toBeNull();
    expect(shortcutFor(press("p", undefined, { ctrlKey: true }), { dialogOpen: false })).toBeNull();
    expect(shortcutFor(press("p", undefined, { altKey: true }), { dialogOpen: false })).toBeNull();
    expect(shortcutFor(press("p", undefined, { defaultPrevented: true }), { dialogOpen: false })).toBeNull();
  });

  it("lets the person turn single-key shortcuts off and keeps Ctrl/⌘+K (WCAG 2.1.4)", () => {
    for (const key of ["p", "P", "l", "j", "?", "/"]) expect(shortcutFor(press(key), { dialogOpen: false, singleKeys: false })).toBeNull();
    expect(shortcutFor(press("k", undefined, { ctrlKey: true }), { dialogOpen: false, singleKeys: false })).toBe("palette");
    expect(shortcutFor(press("K", undefined, { metaKey: true }), { dialogOpen: false, singleKeys: false })).toBe("palette");
    expect(shortcutFor(press("p"), { dialogOpen: false, singleKeys: true })).toBe("plan");
  });

  it("stores the choice in cookie tos_shortcuts, on unless it says off", () => {
    expect(SHORTCUTS_COOKIE).toBe("tos_shortcuts");
    expect(singleKeyShortcutsEnabled(undefined)).toBe(true);
    expect(singleKeyShortcutsEnabled("on")).toBe(true);
    expect(singleKeyShortcutsEnabled("off")).toBe(false);
    expect(readCookie("tos_theme=dark; tos_shortcuts=off; tos_sidebar=collapsed", SHORTCUTS_COOKIE)).toBe("off");
    expect(readCookie("tos_theme=dark; xtos_shortcuts=off", SHORTCUTS_COOKIE)).toBeUndefined();
    expect(readCookie("", SHORTCUTS_COOKIE)).toBeUndefined();
  });

  it("shows the stored choice in the switch the Keyboard shortcuts dialog and Settings use", () => {
    const switchFor = (singleKeyShortcuts: boolean) => render(shellProps({ singleKeyShortcuts, children: createElement(SingleKeyShortcutsSwitch) }));
    const isOn = /<input(?=[^>]*role="switch")(?=[^>]*checked="")[^>]*>/;
    const on = switchFor(true);
    expect(on).toMatch(isOn);
    expect(on).toContain("Single-key shortcuts");
    expect(on).toContain("Ctrl+K always opens search");
    expect(switchFor(false)).toMatch(/<input(?=[^>]*role="switch")[^>]*>/);
    expect(switchFor(false)).not.toMatch(isOn);
    // On by default.
    expect(render(shellProps({ children: createElement(SingleKeyShortcutsSwitch) }))).toMatch(isOn);
  });
});

describe("navigation helpers", () => {
  it("resolves the active section and keeps other query parameters when switching context", () => {
    expect(activeNavKey("/trades/abc/edit")).toBe("journal");
    expect(activeNavKey("/review/weekly")).toBe("review");
    expect(activeNavKey("/edge")).toBe("edge");
    expect(activeNavKey("/todayish")).toBeNull();
    expect(activeNavKey(null)).toBeNull();
    expect(withAccountParam("/journal?model=OTE&account=old", "all")).toBe("/journal?model=OTE&account=all");
  });
});
