import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ links: [] as { href: unknown; prefetch: unknown }[] }));
vi.mock("next/link", () => ({ default: ({ href, prefetch, children, ...props }: ComponentProps<"a"> & { prefetch?: boolean | null }) => {
  m.links.push({ href, prefetch });
  return createElement("a", { href, ...props }, children);
} }));
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import AppLink from "@/components/ui/app-link";
import { AppShell, type AppShellProps } from "@/components/shell/app-shell";
import { TableLink } from "@/components/ui/table";

beforeEach(() => { m.links = []; });

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
