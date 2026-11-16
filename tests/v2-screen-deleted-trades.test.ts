import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Deleted trades (0020): the storage cleanup notice appears only while queued files are still waiting to be removed.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => ({}) }));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
import { DeletedTradesScreen } from "@/components/journal/deleted-trades-screen";

const render = (pendingCleanup: number) =>
  renderToStaticMarkup(createElement(DeletedTradesScreen, { view: { contextLabel: "All Accounts", trades: [], truncated: false, pendingCleanup } }));

describe("Deleted trades storage cleanup notice", () => {
  it("offers Retry cleanup while files are still waiting to be removed", () => {
    const html = render(2);
    expect(html).toContain("Some screenshot files are still being removed");
    expect(html).toContain("Retry cleanup");
  });

  it("shows nothing about storage once every file is removed", () => {
    const html = render(0);
    expect(html).not.toContain("still being removed");
    expect(html).not.toContain("Retry cleanup");
  });
});
