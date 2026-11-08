import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BudgetSnapshot, budgetPresentation } from "@/ai/budget";

// Settings (docs/V2_ARCHITECTURE.md §14.11, §10.4, §10.5, §11.2, §8.6, §13.9): server-rendered with fixture data and
// mocked loaders and actions. Checks the required copy, honest states, empty states, the order of accounts, and that no
// raw id or backend code reaches the default (non-Technical-details) UI.

const m = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  preferences: vi.fn(),
  schema: vi.fn(),
  system: vi.fn(),
  budget: vi.fn(),
  connections: vi.fn(),
  mockEnabled: vi.fn(),
  failure: vi.fn(),
  action: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/settings", () => ({ changePassword: m.action }));
vi.mock("@/app/actions/erasure", () => ({ deleteTradingOsAccount: m.action }));
vi.mock("@/app/actions/context", () => ({ setTheme: m.action, setTimeDisplay: m.action, setDeveloperMode: m.action }));
vi.mock("@/app/ai-settings-actions", () => ({ saveAiActivation: m.action, saveAiBudget: m.action }));
vi.mock("@/app/actions/connections", () => ({ createMockConnection: m.action, disconnectConnection: m.action, runMockSync: m.action }));
vi.mock("@/lib/operational-log", () => ({ operationalFailure: m.failure }));
vi.mock("@/lib/account-context", () => ({ currentSession: m.session, getAccountContext: m.context, getPreferences: m.preferences }));
vi.mock("@/lib/schema-gate", () => ({ getSchemaStatus: m.schema }));
vi.mock("@/lib/ai-budget", () => ({ aiSystemAvailability: m.system, loadAiBudget: m.budget }));
vi.mock("@/lib/sync-service", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/sync-service")>();
  return { ...actual, listConnections: m.connections, isMockSyncEnabled: m.mockEnabled, platformOptions: (env?: Record<string, string>) => actual.platformOptions(env ?? { TRADING_OS_ENABLE_MOCK_SYNC: m.mockEnabled() ? "true" : "" }) };
});

import { loadSettingsPage, type SettingsPageData } from "@/components/settings/settings-data";
import { accountMeta, connectionView, orderAccounts, screenshotSummary, SETTINGS_SECTIONS } from "@/components/settings/settings-model";
import { SettingsPage } from "@/components/settings/settings-page";
import SettingsLoading from "@/app/(app)/settings/loading";
import Page from "@/app/(app)/settings/page";

const USER = "10000000-0000-4000-8000-000000000001";
const FTMO = "20000000-0000-4000-8000-000000000001";
const PERSONAL = "20000000-0000-4000-8000-000000000002";
const OLD = "20000000-0000-4000-8000-000000000003";
const CONNECTION = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-10-23T14:05:00.000Z";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Backend spellings (`ANALYZE_SETUP`, `TRADE_BLOCKED`, `PROVIDER_NOT_AVAILABLE`). */
const ENUM = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

function stripDetails(html: string): string {
  let out = "";
  let depth = 0;
  let start = 0;
  for (const match of html.matchAll(/<details\b[^>]*>|<\/details>/g)) {
    const index = match.index ?? 0;
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        out += /<summary\b[^>]*>[\s\S]*?<\/summary>/.exec(html.slice(start, index))?.[0] ?? "";
        start = index + match[0].length;
      }
    } else {
      if (depth === 0) {
        out += html.slice(start, index);
        start = index;
      }
      depth += 1;
    }
  }
  return depth === 0 ? out + html.slice(start) : out;
}
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (html: string) => decode(stripDetails(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const account = (id: string, name: string, currency: string, type: "EVALUATION" | "PERSONAL" | "DEMO", status: "ACTIVE" | "ARCHIVED" = "ACTIVE") => ({ id, name, currency, type, status });

function budget(enabled: boolean, available: boolean, overrides: Partial<BudgetSnapshot> = {}) {
  const snapshot: BudgetSnapshot = { enabled, budgetCents: 500, usedMicros: 130_000, heldMicros: 0, uncertain: false, period: "2026-10-01", resetAt: "2026-11-01T05:00:00Z", ...overrides };
  return {
    snapshot,
    presentation: budgetPresentation(snapshot, available),
    system: available ? { status: "ENABLED" as const, message: "AI analysis is available" } : { status: "DISABLED" as const, message: "AI analysis is currently disabled" },
    events: [],
    error: null,
  };
}

function fixture(overrides: Partial<SettingsPageData> = {}): SettingsPageData {
  const ftmo = account(FTMO, "FTMO 100K", "USD", "EVALUATION");
  const personal = account(PERSONAL, "Personal 12K", "EUR", "PERSONAL");
  return {
    user: { id: USER, email: "qa.settings@example.test" },
    preferences: { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false },
    nowIso: NOW,
    selectedAccountId: null,
    active: [ftmo, personal],
    archived: [],
    ai: { unavailableReason: null, accounts: [{ account: ftmo, budget: budget(true, true) }, { account: personal, budget: budget(false, true) }] },
    connections: {
      rows: [
        { account: ftmo, snapshot: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null } },
        { account: personal, snapshot: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null } },
      ],
      error: null,
    },
    platforms: [
      { provider: "CTRADER", name: "cTrader", available: false, note: "Read-only sync planned for V2.1" },
      { provider: "MT5", name: "MetaTrader 5", available: false, note: "Bridge planned for V2.2" },
    ],
    mockSync: null,
    export: { tables: { core: ["accounts"], trades: ["trades"], ai: ["ai_usage_records"], "evidence-manifest": ["trade_evidence"] }, screenshots: { total: 155, removed: 1 } },
    schemaVersion: "2.0",
    ...overrides,
  };
}

const render = (data: SettingsPageData) => renderToStaticMarkup(createElement(SettingsPage, { data }));

function expectNoInternals(html: string) {
  const visible = visibleText(html);
  expect(visible).not.toMatch(UUID);
  expect(visible).not.toMatch(ENUM);
  expect(stripDetails(html)).not.toMatch(ENUM);
}

describe("Settings page", () => {
  it("renders every section, in order, with one h1 and anchors the navigation links to", () => {
    const html = render(fixture());
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const positions = SETTINGS_SECTIONS.map(section => html.indexOf(`<section id="${section.id}"`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const section of SETTINGS_SECTIONS) expect(html).toContain(`href="#${section.id}"`);
    expect(visibleText(html)).toContain("General AI Connections Data Security Danger zone Developer");
    expectNoInternals(html);
  });

  it("offers theme and the three time displays, explaining that strategy time stays authoritative", () => {
    const text = visibleText(render(fixture()));
    for (const label of ["Light", "Dark", "System", "Strategy time (UTC−5)", "Local time", "UTC"]) expect(text).toContain(label);
    expect(text).toContain("Trading days, sessions and daily limits always use fixed UTC−5");
    // The server's time renders in strategy time (14:05 UTC → 09:05 UTC−5).
    expect(text).toContain("Now 09:05.");
  });

  it("shows each account's AI budget, the opt-in with consent and the monthly limit, without internals", () => {
    const html = render(fixture());
    const text = visibleText(html);
    expect(text).toContain("AI usage this month · €0.13 of €5.00 · €4.87 left · resets Nov 1");
    expect(text).toContain("Turn off AI for FTMO 100K");
    expect(text).toContain("Turn on AI… for Personal 12K");
    expect(text).toContain("Off until you turn it on. Nothing is sent before then.");
    expect(html).toContain('name="budget"');
    expect(text).toContain("€1.00 to €100.00");
    expect(text).toContain("Raising a limit never turns AI on");
    expect(text).not.toContain("AI is off for this deployment");
    expectNoInternals(html);
  });

  it("explains honestly when the deployment can't run AI and disables turning it on", () => {
    const data = fixture({ ai: { ...fixture().ai, unavailableReason: "No AI request can run, and AI can't be turned on for an account. Monthly limits can still be set." } });
    const html = render(data);
    expect(visibleText(html)).toContain("AI is off for this deployment");
    expect(visibleText(html)).toContain("AI can't be turned on while it is off for this deployment.");
    const turnOn = /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*Turn on AI…/.exec(html)?.[0] ?? "";
    expect(turnOn).toMatch(/\bdisabled=""/);
    expect(turnOn).toMatch(/aria-describedby="[^"]+"/);
  });

  it("pauses turning AI on while an earlier request's cost needs review", () => {
    const personal = account(PERSONAL, "Personal 12K", "EUR", "PERSONAL");
    const data = fixture({ ai: { unavailableReason: null, accounts: [{ account: personal, budget: budget(false, true, { uncertain: true }) }] }, active: [personal] });
    const text = visibleText(render(data));
    expect(text).toContain("Paused — needs review");
    expect(text).toContain("Paused until the cost of an earlier request is reviewed.");
  });

  it("lists the account selected in the header first (the AI fix route)", () => {
    const html = render(fixture({ selectedAccountId: PERSONAL }));
    expect(html.indexOf('aria-label="AI · Personal 12K"')).toBeLessThan(html.indexOf('aria-label="AI · FTMO 100K"'));
  });

  it("keeps archived accounts' AI history in a collapsed group", () => {
    const old = account(OLD, "Demo 2025", "USD", "DEMO", "ARCHIVED");
    const base = fixture();
    const html = render({ ...base, archived: [old], ai: { ...base.ai, accounts: [...base.ai.accounts, { account: old, budget: budget(false, true) }] } });
    expect(visibleText(html)).toContain("Archived accounts · 1");
    expect(html).toMatch(/<details\b[^>]*>[\s\S]*Demo 2025[\s\S]*<\/details>/);
  });

  it("lets an archived account with AI on turn it off, and offers nothing else (§11.2, V1: disabling stays available)", () => {
    const old = account(OLD, "Demo 2025", "USD", "DEMO", "ARCHIVED");
    const base = fixture();
    const archivedGroup = (enabled: boolean) => {
      const html = render({ ...base, archived: [old], ai: { ...base.ai, accounts: [...base.ai.accounts, { account: old, budget: budget(enabled, true) }] } });
      const start = html.indexOf("Archived accounts · 1");
      return start < 0 ? "" : html.slice(start, html.indexOf("</details>", start));
    };
    const on = archivedGroup(true);
    expect(visibleText(on)).toContain("Turn off AI for Demo 2025");
    expect(on).toContain(`name="accountId" value="${OLD}"`);
    expect(on).toContain('name="enabled" value="false"');
    expect(visibleText(on)).not.toContain("Turn on AI");
    expect(visibleText(on)).not.toContain("Save limit");
    expect(visibleText(on)).toContain("AI can be turned off here; restore an account to turn AI on or change its limit.");
    const off = archivedGroup(false);
    expect(off).toContain("Demo 2025");
    expect(off).not.toContain("<form");
    expect(visibleText(off)).not.toContain("Turn off AI");
  });

  it("states connections honestly: manual today, cTrader and MetaTrader 5 planned with read-only scope", () => {
    const text = visibleText(render(fixture()));
    expect(text).toContain("Trades are recorded manually in this version.");
    expect(text).toContain("Read-only sync planned for V2.1");
    expect(text).toContain("Bridge planned for V2.2");
    expect(text).toContain("Read-only: account, positions, deals, balances. Trading OS never requests trading permission.");
    expect(text).toContain("FTMO 100K Evaluation · USD Manual Manage FTMO 100K");
    expect(text).not.toMatch(/\bConnected\b|\bSynced\b/);
  });

  it("keeps touch targets at 44px and platform pills at their own width on phones", () => {
    const html = render(fixture());
    const manage = [...html.matchAll(/<a\b[^>]*href="\/accounts\/[^"]+\/manage"[^>]*>/g)].map(match => match[0]);
    expect(manage).toHaveLength(2);
    for (const link of manage) expect(link).toMatch(/\bmin-h-10\b[^"]*\bpointer-coarse:min-h-11\b/);
    // Stacked rows (below 640px) start-align their children, so "In use" / "Planned" never stretch into full-width bars.
    const platformRows = [...html.matchAll(/<li\b[^>]*class="([^"]*)"[^>]*>(?:(?!<\/li>)[\s\S])*?(?:In use|Planned)/g)].map(match => match[1]);
    expect(platformRows).toHaveLength(3);
    for (const row of platformRows) expect(row.split(" ")).toEqual(expect.arrayContaining(["flex-col", "items-start"]));
  });

  it("shows a sync failure in words, with what needs attention", () => {
    const base = fixture();
    const html = render({
      ...base,
      connections: {
        error: null,
        rows: [{
          account: base.active[0],
          snapshot: {
            mode: "ERROR",
            connection: { provider: "MOCK", label: "Sample feed", accountRef: "••••1234", executionCount: 3, unmatchedCount: 2, warningCount: 1 },
            lastSyncedAt: "2026-10-22T19:05:00Z",
            message: "The platform reported times that are in the future or out of order.",
          },
        }],
      },
    });
    const text = visibleText(html);
    expect(text).toContain("Sync failed");
    expect(text).toContain("Mock platform · Sample feed · ••••1234 · The platform reported times that are in the future or out of order.");
    expect(text).toContain("2 platform executions need a trade.");
    expect(text).toContain("1 platform change was not applied.");
    expectNoInternals(html);
  });

  it("reports unreadable connections without failing the page", () => {
    const html = render(fixture({ connections: { rows: [], error: "Connection status is unavailable right now. Trades you record manually are not affected." } }));
    expect(visibleText(html)).toContain("Connections unavailable");
    expect(visibleText(html)).toContain("Platforms");
  });

  it("offers the export with screenshot counts and says exporting changes nothing", () => {
    const text = visibleText(render(fixture()));
    expect(text).toContain("Download my data (.zip)");
    expect(text).toContain("Include screenshots");
    expect(text).toContain("155 screenshots, including 1 removed from its trade.");
    expect(text).toContain("exporting changes nothing");
  });

  it("asks for the current password to change it", () => {
    const html = render(fixture());
    expect(visibleText(html)).toContain("Signed in as qa.settings@example.test");
    for (const name of ["currentPassword", "newPassword", "confirmation"]) expect(html).toContain(`name="${name}"`);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toMatch(/autocomplete="new-password"/i);
    expect(visibleText(html)).toContain("Change password");
  });

  it("explains exactly what deletion removes, that it is irreversible, and suggests the export first", () => {
    const text = visibleText(render(fixture()));
    expect(text).toContain("Delete Trading OS account");
    for (const item of [
      "Trading accounts, account values, risk plans and instruments", "Trades, drafts, plans, fills and results", "Journal entries, screenshots, tags and reviews",
      "AI history and usage records", "Settings and preferences", "Your login: email and password",
    ]) expect(text).toContain(item);
    expect(text).toContain("This can't be undone.");
    expect(text).toContain("Download my data");
    expect(text).toContain("Delete Trading OS account…");
  });

  it("keeps ids in Technical details only and shows the mock sync only when the deployment enables it", () => {
    const html = render(fixture());
    expect(html).toMatch(/<details\b[^>]*class="[^"]*technical-details[^"]*"[^>]*>[\s\S]*10000000-0000-4000-8000-000000000001/);
    expect(visibleText(html)).toContain("Show technical details expanded");
    expect(visibleText(html)).not.toContain("Mock platform sync");

    const base = fixture();
    const withMock = render({
      ...base,
      mockSync: {
        error: null,
        rows: [
          { ...base.connections.rows[0], mockConnectionId: null, otherConnection: false },
          {
            account: base.active[1], mockConnectionId: CONNECTION, otherConnection: false,
            snapshot: { mode: "SYNCED", connection: { provider: "MOCK", label: "Mock platform", accountRef: null, executionCount: 4, unmatchedCount: 0, warningCount: 0 }, lastSyncedAt: "2026-10-22T19:05:00Z", message: null },
          },
        ],
      },
    });
    const text = visibleText(withMock);
    expect(text).toContain("Mock platform sync");
    expect(text).toContain("never contacts a real platform");
    expect(text).toContain("Connect mock platform to FTMO 100K");
    expect(text).toContain("Synced · Last synced Oct 22, 14:05 UTC−5.");
    expect(text).toContain("Simulate sync for Personal 12K");
    expectNoInternals(withMock);
  });

  it("explains the next step when there is no trading account yet", () => {
    const html = render(fixture({ active: [], archived: [], ai: { unavailableReason: null, accounts: [] }, connections: { rows: [], error: null } }));
    const text = visibleText(html);
    expect(text).toContain("No trading accounts yet");
    expect(text).toContain("AI consent and monthly limits belong to a trading account.");
    expect(html).toContain('href="/accounts/new"');
    expect(text).toContain("Download my data (.zip)");
    expect(text).toContain("Delete Trading OS account");
  });

  it("points to restoring when every trading account is archived", () => {
    const old = account(OLD, "Demo 2025", "USD", "DEMO", "ARCHIVED");
    const text = visibleText(render(fixture({ active: [], archived: [old], ai: { unavailableReason: null, accounts: [{ account: old, budget: budget(false, true) }] }, connections: { rows: [], error: null } })));
    expect(text).toContain("No active trading accounts");
    expect(text).toContain("Restore an archived account or create a new one.");
    expect(text).toContain("Archived accounts · 1");
  });

  it("renders in developer mode with technical details open", () => {
    const html = render(fixture({ preferences: { theme: "dark", timeDisplay: { mode: "utc" }, developerMode: true, sidebarCollapsed: false } }));
    expect(html).toMatch(/<details\b[^>]*open=""[^>]*class="[^"]*technical-details|<details\b[^>]*class="[^"]*technical-details[^"]*"[^>]*open=""/);
    expect(html).toMatch(/role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/);
  });
});

describe("Settings view models", () => {
  it("names connection states in words and never claims a sync that did not happen", () => {
    const display = { mode: "strategy" } as const;
    const connection = { provider: "CTRADER" as const, label: "Main", accountRef: null, executionCount: 0, unmatchedCount: 0, warningCount: 0 };
    expect(connectionView({ mode: "MANUAL", connection: null, lastSyncedAt: null, message: null }, display)).toMatchObject({ label: "Manual", tone: "neutral", detail: null });
    expect(connectionView({ mode: "PENDING", connection, lastSyncedAt: null, message: null }, display)).toMatchObject({ label: "Connected", detail: "Not synced yet." });
    expect(connectionView({ mode: "SYNCING", connection, lastSyncedAt: null, message: null }, display)).toMatchObject({ label: "Syncing", tone: "info" });
    expect(connectionView({ mode: "SYNCED", connection, lastSyncedAt: "2026-10-22T19:05:00Z", message: null }, { mode: "utc" }))
      .toMatchObject({ label: "Synced", tone: "positive", detail: "Last synced Oct 22, 19:05 UTC.", source: "cTrader · Main" });
    expect(connectionView({ mode: "ERROR", connection, lastSyncedAt: null, message: null }, display))
      .toMatchObject({ label: "Sync failed", tone: "negative", detail: "The last sync did not finish. Imported trades are kept." });
  });

  it("orders accounts with the selected one first and describes them", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderAccounts(list, "c").map(item => item.id)).toEqual(["c", "a", "b"]);
    expect(orderAccounts(list, null).map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(orderAccounts(list, "missing").map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(accountMeta({ type: "EVALUATION", currency: "USD" })).toBe("Evaluation · USD");
  });

  it("describes the screenshot export", () => {
    expect(screenshotSummary(null)).toBe("Every screenshot is checked against the fingerprint recorded when it was saved.");
    expect(screenshotSummary({ total: 0, removed: 0 })).toBe("You have no screenshots yet.");
    expect(screenshotSummary({ total: 1, removed: 0 })).toBe("1 screenshot. Each is checked against the fingerprint recorded when it was saved.");
    expect(screenshotSummary({ total: 12, removed: 3 })).toBe("12 screenshots, including 3 removed from their trades. Each is checked against the fingerprint recorded when it was saved.");
  });
});

describe("Settings loader", () => {
  const ftmo = { id: FTMO, name: "FTMO 100K", currency: "USD", type: "EVALUATION", platform: "MANUAL", broker: null, status: "ACTIVE", startingBalance: "100000", createdAt: "2026-01-01T00:00:00Z", profile: "PROFILE" };
  const old = { ...ftmo, id: OLD, name: "Demo 2025", type: "DEMO", status: "ARCHIVED" };
  const counts: Record<string, number> = { trade_evidence: 150, setup_screenshots: 5, trade_evidence_removals: 2, setup_screenshot_removals: 0 };
  const db = {
    from: (table: string) => ({
      select: (_columns: string, options: { count: string; head: boolean }) => {
        expect(options).toEqual({ count: "exact", head: true });
        return Promise.resolve(table in counts ? { count: counts[table], error: null } : { count: null, error: { message: "no" } });
      },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    m.session.mockResolvedValue({ db, user: { id: USER, email: "qa.settings@example.test" } });
    m.context.mockResolvedValue({ accounts: [ftmo, old], active: [ftmo], archived: [old], selected: { mode: "account", account: ftmo } });
    m.preferences.mockResolvedValue({ theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false });
    m.schema.mockResolvedValue({ ready: true, version: "2.0" });
    m.system.mockReturnValue({ status: "DISABLED", message: "AI analysis is currently disabled", deepEnabled: false });
    m.budget.mockImplementation(async (id: string) => ({ ...budget(id === FTMO, false), reservationMicros: 60_000 }));
    m.connections.mockResolvedValue([]);
    m.mockEnabled.mockReturnValue(false);
  });

  it("reads budgets for every account, the counts of exported screenshots and the export's table list", async () => {
    const data = await loadSettingsPage();
    expect(m.budget.mock.calls.map(call => call[0])).toEqual([FTMO, OLD]);
    expect(data.selectedAccountId).toBe(FTMO);
    expect(data.active.map(item => item.id)).toEqual([FTMO]);
    expect(data.archived.map(item => item.id)).toEqual([OLD]);
    expect(data.ai.unavailableReason).toMatch(/can't be turned on/);
    expect(data.export.screenshots).toEqual({ total: 155, removed: 2 });
    expect(data.export.tables.core).toContain("accounts");
    expect(data.export.tables["evidence-manifest"]).toEqual(["trade_evidence", "trade_evidence_labels", "trade_evidence_removals", "setup_screenshots", "setup_screenshot_removals"]);
    expect(data.connections).toEqual({ rows: [{ account: expect.objectContaining({ id: FTMO }), snapshot: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null } }], error: null });
    expect(data.platforms.map(platform => platform.provider)).toEqual(["CTRADER", "MT5"]);
    expect(data.mockSync).toBeNull();
    expect(data.schemaVersion).toBe("2.0");
  });

  it("degrades a section on its own when its data can't be read", async () => {
    m.connections.mockRejectedValue(new Error("down"));
    delete counts.trade_evidence;
    try {
      const data = await loadSettingsPage();
      expect(data.connections).toEqual({ rows: [], error: "Connection status is unavailable right now. Trades you record manually are not affected." });
      expect(data.export.screenshots).toBeNull();
      expect(m.failure).toHaveBeenCalledWith("data_read_failed");
    } finally {
      counts.trade_evidence = 150;
    }
  });

  it("lists the developer mock sync only when the deployment enables it, never next to another provider", async () => {
    m.mockEnabled.mockReturnValue(true);
    m.system.mockReturnValue({ status: "ENABLED", message: "AI analysis is available", deepEnabled: false });
    m.connections.mockResolvedValue([{
      id: CONNECTION, accountId: FTMO, provider: "MOCK", label: "Mock platform", externalAccountRef: null, createdAt: NOW, currency: "USD", status: "SYNCED",
      statusMessage: "Synced 2 positions.", statusAt: NOW, syncedThrough: NOW, lastSyncedAt: NOW, warningCount: 0, lastWarningAt: null, executionCount: 2, unmatchedCount: 0,
    }]);
    const data = await loadSettingsPage();
    expect(data.ai.unavailableReason).toBeNull();
    expect(data.platforms.map(platform => platform.provider)).toEqual(["CTRADER", "MT5"]);
    expect(data.mockSync?.rows).toEqual([expect.objectContaining({ mockConnectionId: CONNECTION, otherConnection: false })]);
    expect(data.connections.rows[0].snapshot.mode).toBe("SYNCED");
  });

  it("shows a skeleton shaped like the page while loading", () => {
    const html = renderToStaticMarkup(createElement(SettingsLoading));
    expect(html).toContain('role="status"');
    expect(visibleText(html)).toBe("Loading settings");
  });

  it("renders the route from the loader", async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Settings");
    expect(visibleText(html)).toContain("AI is off for this deployment");
    expectNoInternals(html);
  });
});
