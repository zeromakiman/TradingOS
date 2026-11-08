import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined),
    getAll: () => [...jar.cookies].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/supabase/config", () => ({ publicConfig: () => ({ url: "https://example.supabase.co", key: "public", cookiePrefix: "sb-example-auth-token" }) }));
// The gallery waits for a request (dynamic rendering) and renders the shell, which reads the router; neither exists
// here. notFound() and redirect() stay real.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/dev/ui",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
}));

import UiGalleryPage from "@/app/dev/ui/page";
import NotFound from "@/app/not-found";
import RootLayout, { generateViewport } from "@/app/layout";

// The root layout paints the stored theme on <html> for every page, public sign-in pages included (V2 §13.1): an
// explicit light or dark choice applies from the first byte; without one, the stylesheet follows the device.
// Unmatched addresses get a styled page in the design system instead of the framework's bare 404 (§13.7).

beforeEach(() => {
  jar.cookies.clear();
});

const layout = async () => renderToStaticMarkup((await RootLayout({ children: createElement("main", null, "Page") })) as ReactElement);

describe("root layout theme", () => {
  it.each([
    ["light", "light", "light", "#f5f6f8"],
    ["dark", "dark", "dark", "#0d1015"],
  ])("renders an explicit %s choice on <html> with matching browser chrome", async (stored, attribute, scheme, color) => {
    jar.cookies.set("tos_theme", stored);
    expect(await layout()).toBe(`<html lang="en" data-theme="${attribute}"><head></head><body><main>Page</main></body></html>`);
    expect(await generateViewport()).toMatchObject({ colorScheme: scheme, themeColor: color, width: "device-width", viewportFit: "cover" });
  });

  it.each([[undefined], ["system"], ["sepia"]])("follows the device without an explicit choice (%s)", async (stored) => {
    if (stored) jar.cookies.set("tos_theme", stored);
    expect(await layout()).toContain('<html lang="en" data-theme="system">');
    expect(await generateViewport()).toMatchObject({
      colorScheme: "light dark",
      themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
        { media: "(prefers-color-scheme: dark)", color: "#0d1015" },
      ],
    });
  });
});

describe("root not-found page", () => {
  const page = async () => renderToStaticMarkup((await NotFound()) as ReactElement);

  it("offers the way back into the workspace to a signed-in browser", async () => {
    jar.cookies.set("sb-example-auth-token", "session");
    const markup = await page();
    expect(markup).toContain("<h1");
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain('<main id="main-content"');
    expect(markup).toContain("This page doesn&#x27;t exist.");
    expect(markup).toMatch(/href="\/today">Go to Today<\/a>/);
    expect(markup).toMatch(/href="\/journal">Open the Journal<\/a>/);
    expect(markup).not.toContain("Sign in");
  });

  it("offers sign-in to a signed-out browser, without pretending a workspace is open", async () => {
    const markup = await page();
    expect(markup).toMatch(/href="\/login">Sign in<\/a>/);
    expect(markup).not.toContain("Go to Today");
    expect(markup).toContain("Sign in to open your workspace.");
  });
});

describe("developer UI gallery (/dev/ui, debug isolation)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const digestOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : String(error);
    }
    return null;
  };
  const open = () => UiGalleryPage({ searchParams: Promise.resolve({}) });

  it("answers 404 in a production build, whatever the environment says", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRADING_OS_DEV_PAGES", "true");
    expect(await digestOf(open)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("renders the gallery in development, in the stored theme so its switches match the painted page", async () => {
    vi.stubEnv("NODE_ENV", "development");
    jar.cookies.set("tos_theme", "dark");
    const markup = renderToStaticMarkup((await open()) as ReactElement);
    expect(markup).toContain("<h1");
    expect(markup).toContain('<input type="radio" name="gallery-theme-settings" checked="" value="dark"/>');
    expect(markup).toContain('<input type="radio" name="gallery-theme-settings" value="system"/>');
  });
});
