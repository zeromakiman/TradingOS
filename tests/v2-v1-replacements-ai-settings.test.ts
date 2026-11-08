import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type BudgetSnapshot, budgetPresentation } from "@/ai/budget";

// V2 replacement of the V1 component tests in tests/ai-settings.test.ts ("Opus Settings AI section"; the V1
// AiSettings component is deleted, its server actions are still used and still tested there). Settings → AI now
// renders AiAccountControls per trading account. Its consent step lives in a dialog, which Radix renders only while
// open; the dialog primitives are replaced by pass-through elements so the server HTML shows the consent step as it
// appears once opened. Budget amounts and status chips are covered in tests/v2-screen-settings.test.ts and
// tests/v2-ui-ai-components.test.ts. The Settings page itself is rendered at the end (every action it can post to is
// mocked) for the V1 promise that a trader can always turn AI off, even while an earlier request's cost is uncertain.

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/ai-settings-actions", () => ({ saveAiActivation: vi.fn(), saveAiBudget: vi.fn() }));
vi.mock("@/app/actions/settings", () => ({ changePassword: vi.fn() }));
vi.mock("@/app/actions/erasure", () => ({ deleteTradingOsAccount: vi.fn() }));
vi.mock("@/app/actions/context", () => ({ setTheme: vi.fn(), setTimeDisplay: vi.fn(), setDeveloperMode: vi.fn() }));
vi.mock("@/app/actions/connections", () => ({ createMockConnection: vi.fn(), disconnectConnection: vi.fn(), runMockSync: vi.fn() }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", { "data-dialog": "root" }, children),
  DialogTrigger: ({ children }: { children: ReactNode }) => children,
  DialogClose: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ title, description, children }: { title: string; description?: string; children: ReactNode }) =>
    createElement("div", { role: "dialog", "data-dialog": "content" }, createElement("h2", null, title), description ? createElement("p", null, description) : null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", { "data-dialog": "footer" }, children),
}));

import { AiAccountControls, type AiAccountControlsProps } from "@/components/settings/ai-account-controls";
import type { SettingsPageData } from "@/components/settings/settings-data";
import { SettingsPage } from "@/components/settings/settings-page";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function render(props: Partial<AiAccountControlsProps> = {}) {
  return renderToStaticMarkup(createElement(AiAccountControls, { accountId: ACCOUNT, accountName: "FTMO 100K", enabled: false, budgetCents: 500, enableBlockedReason: null, ...props }));
}

/** The opening tag of the first element matching `pattern` (attributes only). */
const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? "";
/** The `<button>` element whose visible text is `label` (a screen-reader-only " for <account>" suffix allowed). */
const button = (html: string, label: string) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(element => [label, `${label} for FTMO 100K`].includes(visibleText(element))) ?? "";

describe("Settings → AI: turning AI on for an account", () => {
  it("is a separate, explicit step with an unchecked, required consent before anything can be sent", () => {
    const html = render();
    const text = visibleText(html);
    // The control on the page only opens the consent step; it does not turn anything on.
    expect(button(html, "Turn on AI…")).toMatch(/type="button"/);
    expect(text).toContain("Off until you turn it on. Nothing is sent before then.");
    // The consent step: advisory copy, exactly what a request may send, and when nothing is sent.
    expect(text).toContain("Turn on AI for FTMO 100K?");
    expect(text).toContain("AI is advisory. It never decides whether you can trade: the Risk Engine does.");
    for (const item of ["The screenshots you select for that request", "Your trade plan, thesis, journal notes and tags", "Your strategy rules and the Risk Engine's results"]) {
      expect(text).toContain(item);
    }
    expect(text).toContain("Nothing is sent when you open a page.");
    expect(text).toContain("the limit never rises on its own");
    const consent = tag(html, /<input\b[^>]*name="confirm"[^>]*>/);
    expect(consent).toContain('type="checkbox"');
    expect(consent).toContain('required=""');
    expect(consent).not.toContain("checked");
    // The step can't be confirmed until consent is given.
    const confirm = button(html, "Turn on AI");
    expect(confirm).toMatch(/type="submit"/);
    expect(confirm).toMatch(/\bdisabled=""/);
    expect(html).toContain('name="enabled" value="true"');
    expect(html).toContain(`name="accountId" value="${ACCOUNT}"`);
  });

  it("offers only turning it off once AI is on, never a second opt-in", () => {
    const html = render({ enabled: true });
    const text = visibleText(html);
    expect(button(html, "Turn off AI")).toMatch(/type="submit"/);
    expect(html).toContain('name="enabled" value="false"');
    expect(text).toContain("Stops new requests.");
    expect(text).not.toContain("Turn on AI");
    expect(html).not.toContain('name="confirm"');
    expect(html).not.toContain('role="dialog"');
  });

  // V1 "uncertainty is unavailable even when unused capacity remains" also rendered AI on with uncertain accounting
  // and required the off control. Settings passes the reason to every paused or unavailable account, AI on or off
  // (settings-page.tsx `enableBlockedReason`); it may only ever stop turning AI ON.
  it.each([
    ["an earlier request's cost needs review", "Paused until the cost of an earlier request is reviewed. AI can't be turned on until then."],
    ["the deployment can't run AI", "AI can't be turned on while it is off for this deployment."],
  ])("still lets the trader turn AI off while %s", (_, reason) => {
    const html = render({ enabled: true, enableBlockedReason: reason });
    const off = button(html, "Turn off AI");
    expect(off).toMatch(/type="submit"/);
    expect(off).not.toMatch(/\bdisabled=""/);
    expect(off).not.toMatch(/aria-disabled="true"/);
    // The form that button submits turns AI off for this account, and only that.
    const form = /<form\b[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain(off);
    expect(form).toContain('name="enabled" value="false"');
    expect(form).toContain(`name="accountId" value="${ACCOUNT}"`);
    expect(form).not.toMatch(/\baria-busy="true"/);
    expect(html).not.toContain('name="enabled" value="true"');
    expect(visibleText(html)).not.toContain("Turn on AI");
  });

  it("can't be turned on while AI is unavailable, says why, and keeps the monthly limit editable", () => {
    const reason = "AI can't be turned on while it is off for this deployment.";
    const html = render({ enableBlockedReason: reason });
    const trigger = tag(html, /<button\b[^>]*>(?=(?:(?!<\/button>)[\s\S])*Turn on AI…)/);
    expect(trigger).toMatch(/\bdisabled=""/);
    const described = /aria-describedby="([^"]+)"/.exec(trigger)?.[1] ?? "";
    expect(described).not.toBe("");
    expect(visibleText(tag(html, new RegExp(`<p\\b[^>]*id="${described}"[^>]*>[^<]*`)))).toBe(reason);
    // The limit form stays usable: lowering or raising a limit never needs AI to be available.
    const budget = tag(html, /<input\b[^>]*name="budget"[^>]*>/);
    expect(budget).not.toMatch(/\bdisabled=""/);
    expect(budget).toContain('value="5.00"');
    expect(button(html, "Save limit")).not.toMatch(/\bdisabled=""/);
    expect(visibleText(html)).toContain("€1.00 to €100.00");
  });

  it("shows the account's limit exactly, from whole cents", () => {
    expect(tag(render({ budgetCents: 1005 }), /<input\b[^>]*name="budget"[^>]*>/)).toContain('value="10.05"');
    expect(tag(render({ budgetCents: 100 }), /<input\b[^>]*name="budget"[^>]*>/)).toContain('value="1.00"');
  });
});

describe("Settings → AI page: an account with AI on whose earlier request's cost needs review", () => {
  const ftmo = { id: ACCOUNT, name: "FTMO 100K", currency: "USD", type: "EVALUATION" as const, status: "ACTIVE" as const };

  function page(enabled: boolean): SettingsPageData {
    const snapshot: BudgetSnapshot = { enabled, budgetCents: 500, usedMicros: 130_000, heldMicros: 792_000, uncertain: true, period: "2026-10-01", resetAt: "2026-11-01T05:00:00Z" };
    return {
      user: { id: "10000000-0000-4000-8000-000000000001", email: "qa.settings@example.test" },
      preferences: { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false },
      nowIso: "2026-10-23T14:05:00.000Z",
      selectedAccountId: null,
      active: [ftmo],
      archived: [],
      ai: {
        unavailableReason: null,
        accounts: [{ account: ftmo, budget: { snapshot, presentation: budgetPresentation(snapshot, true), system: { status: "ENABLED", message: "AI analysis is available" }, events: [], error: null } }],
      },
      connections: { rows: [{ account: ftmo, snapshot: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null } }], error: null },
      platforms: [],
      mockSync: null,
      export: { tables: { core: ["accounts"], trades: ["trades"], ai: ["ai_usage_records"], "evidence-manifest": ["trade_evidence"] }, screenshots: { total: 0, removed: 0 } },
      schemaVersion: "2.0",
    };
  }
  /** The account's AI card on the page. */
  const card = (html: string) => /<article\b[^>]*aria-label="AI · FTMO 100K"[^>]*>[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";

  it("says AI is paused for review and keeps 'Turn off AI' usable, never a way to turn it on", () => {
    const html = card(renderToStaticMarkup(createElement(SettingsPage, { data: page(true) })));
    expect(html).not.toBe("");
    expect(visibleText(html)).toContain("Paused — needs review");
    const off = button(html, "Turn off AI");
    expect(off).toMatch(/type="submit"/);
    expect(off).not.toMatch(/\bdisabled=""/);
    expect(html).toContain('name="enabled" value="false"');
    expect(html).not.toContain('name="enabled" value="true"');
  });

  it("with AI off, the same pause blocks turning it on and says why", () => {
    const html = card(renderToStaticMarkup(createElement(SettingsPage, { data: page(false) })));
    expect(visibleText(html)).toContain("Paused — needs review");
    expect(visibleText(html)).toContain("Paused until the cost of an earlier request is reviewed. AI can't be turned on until then.");
    expect(tag(html, /<button\b[^>]*>(?=(?:(?!<\/button>)[\s\S])*Turn on AI…)/)).toMatch(/\bdisabled=""/);
    expect(button(html, "Turn off AI")).toBe("");
  });
});
