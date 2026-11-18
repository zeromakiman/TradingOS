import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ links: [] as { href: unknown; prefetch: unknown }[], pending: false }));
vi.mock("next/link", () => ({ default: ({ href, prefetch, children, ...props }: ComponentProps<"a"> & { prefetch?: boolean | null }) => {
  m.links.push({ href, prefetch });
  return createElement("a", { href, ...props }, children);
}, useLinkStatus: () => ({ pending: m.pending }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import AppLink from "@/components/ui/app-link";
import { AppShell, type AppShellProps } from "@/components/shell/app-shell";
import { NavPending } from "@/components/shell/nav-pending";
import { TableLink } from "@/components/ui/table";

beforeEach(() => { m.links = []; m.pending = false; });

it("does not prefetch viewport shell destinations or financial table rows", () => {
  const props: AppShellProps = {
    user: { email: "trader@example.com" }, accounts: [], context: { mode: "all" },
    clock: { nowIso: "2026-10-23T14:00:00Z" }, paletteIndex: { accounts: [], liveTrades: [], recentTrades: [] },
    developerMode: false, theme: "system", children: createElement(TableLink, { href: "/trades/example" }, "Trade"),
  };
  renderToStaticMarkup(createElement(AppShell, props));
  expect(m.links.length).toBeGreaterThan(10);
  expect(m.links.some(link => link.href === "/journal")).toBe(true);
  expect(m.links.some(link => link.href === "/trades/example")).toBe(true);
  expect(m.links.every(link => link.prefetch === false)).toBe(true);
});

it("preserves explicit opt-in except on account-changing links", () => {
  renderToStaticMarkup(createElement(AppLink, { href: "/accounts/example/manage", prefetch: true }, "Manage"));
  renderToStaticMarkup(createElement(AppLink, { href: "/today?account=example", prefetch: true }, "Account"));
  expect(m.links.map(link => link.prefetch)).toEqual([true, false]);
});

// Without prefetch or a route skeleton, a primary navigation waits for the server: the clicked link says so.
it("gives primary navigation links a fixed-size hint that shows only while their navigation is pending", () => {
  const props: AppShellProps = {
    user: { email: "trader@example.com" }, accounts: [], context: { mode: "all" },
    clock: { nowIso: "2026-10-23T14:00:00Z" }, paletteIndex: { accounts: [], liveTrades: [], recentTrades: [] },
    developerMode: false, theme: "system", children: "Today core",
  };
  const shell = renderToStaticMarkup(createElement(AppShell, props));
  // Sidebar: six destinations; mobile tab bar: Today, Journal, Accounts.
  expect(shell.match(/class="nav-pending"/g)).toHaveLength(9);
  expect(shell).not.toContain("data-pending");
  m.pending = true;
  expect(renderToStaticMarkup(createElement(NavPending))).toBe('<span aria-hidden="true" class="nav-pending" data-pending=""></span>');
});
