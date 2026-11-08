import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Account-name chips outside Today (docs/V2_ARCHITECTURE.md §14.4, §9.2): account names run up to 100 characters (the
// create form, the profile rename and the database all allow them), and a chip is `white-space: nowrap` (`.badge`,
// `.btn`). Without room to shrink, one long name made the trade page and Plan Trade wider than a 393 px phone, which
// pushed the fixed tab bar off the screen. Today's own names: tests/v2-screen-today.test.ts.
//
// The trade header is rendered from its real component; its facts, hint, result and actions come from the trade model,
// which tests/v2-screen-trade*.test.ts cover, so they are stubbed here and only the account chip is checked.
//
// A name can also have no space at all: where a name is printed whole (page titles, the risk check's caption, Settings'
// account list) it must break inside the word, or the line is as wide as the name. Those elements are rendered from
// their real components and their classes are checked against the stylesheet the project's own Tailwind builds.

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async importOriginal => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/app/actions/accounts", () => ({ confirmAccountValuesUnchanged: vi.fn() }));
vi.mock("@/app/actions/settings", () => ({ changePassword: vi.fn() }));
vi.mock("@/app/actions/erasure", () => ({ deleteTradingOsAccount: vi.fn() }));
vi.mock("@/app/actions/context", () => ({ setTheme: vi.fn(), setTimeDisplay: vi.fn(), setDeveloperMode: vi.fn() }));
vi.mock("@/app/ai-settings-actions", () => ({ saveAiActivation: vi.fn(), saveAiBudget: vi.fn() }));
vi.mock("@/app/actions/connections", () => ({ createMockConnection: vi.fn(), disconnectConnection: vi.fn(), runMockSync: vi.fn() }));
vi.mock("@/components/trade/trade-actions", () => ({ TradeHeaderActions: () => null }));
vi.mock("@/components/trade/model", async importOriginal => ({
  ...(await importOriginal<typeof import("@/components/trade/model")>()),
  headerFacts: () => [],
  blockingNow: () => null,
  nextStepHint: () => null,
  resultSummary: () => null,
  skipSlotNote: () => "",
  pageState: (detail: { state: unknown }) => detail.state,
  headerActions: () => ({}),
  originBadge: () => ({ label: "Live-first", tooltip: null }),
}));

import { type BudgetSnapshot, budgetPresentation } from "@/ai/budget";
import type { SettingsPageData } from "@/components/settings/settings-data";
import { SettingsPage } from "@/components/settings/settings-page";
import { AccountChip } from "@/components/trade/forms/form-parts";
import { RiskPreview } from "@/components/trade/forms/risk-preview";
import type { FormAccount } from "@/components/trade/forms/types";
import { TradeHeader } from "@/components/trade/trade-header";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterChips } from "@/components/ui/filter-chips";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import type { TradeDetail } from "@/lib/trades-data";

const ACCOUNT = "20000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const LONG = "FTMO Challenge Phase 2 · 200K Swing (Aggressive) · EURUSD and GBPUSD focus · London and NY sessions.";
/** As long as a name can be, with nothing to wrap at. */
const NO_SPACES = "Personal_IC_Markets_12K_cTrader_DE40_and_NAS100_index_scalps_no_news_trading_Mon_to_Fri_only_v2vwxyz";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The opening-tag attributes of every element whose whole text is `name`. */
function nameBoxes(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<(\\w+)((?:\\s[^>]*)?)>${escapeRegExp(name)}</\\1>`, "g"))].map(match => match[2]);
}

function header(name: string): string {
  const detail = {
    tradeId: TRADE, href: `/trades/${TRADE}`, title: "EURUSD · Long", origin: "LIVE_FIRST", draft: null,
    state: { lifecycle: "LIVE", label: "Live", tone: "live" },
    account: { id: ACCOUNT, name, currency: "USD", status: "ACTIVE" },
  } as unknown as TradeDetail;
  return renderToStaticMarkup(createElement(TradeHeader, {
    detail, now: "2026-10-23T14:00:00Z", display: { mode: "strategy" }, lock: null, keys: { discard: "k1", reopen: "k2" } as never, duplicateNotes: [],
  }));
}

describe("100-character account names in the trade header and the trade forms", () => {
  it("keeps the trade header's account chip, and its currency, inside a phone-wide header", () => {
    expect(LONG.length).toBe(100);
    const html = header(LONG);
    const link = new RegExp(`<a ([^>]*aria-label="Trading account ${escapeRegExp(LONG)} \\(USD\\)"[^>]*)>([\\s\\S]*?)</a>`).exec(html);
    expect(link).not.toBeNull();
    const [, attributes, inner] = link ?? ["", "", ""];
    expect(attributes).toContain(`href="/accounts/${ACCOUNT}`);
    // The link and the badge may shrink to the header's width (flex items never get narrower than their content
    // without min-w-0), the name is cut with an ellipsis and keeps its whole text in the tooltip, the currency stays.
    expect(attributes).toMatch(/class="[^"]*\bmax-w-full\b[^"]*"/);
    expect(attributes).toMatch(/class="[^"]*\bmin-w-0\b[^"]*"/);
    expect(inner).toMatch(/^<span class="badge [^"]*\bmax-w-full\b[^"]*\bmin-w-0\b/);
    expect(nameBoxes(inner, LONG)).toEqual([` class="truncate" title="${LONG}"`]);
    expect(inner).toMatch(/<span class="flex-none [^"]*">USD<\/span>/);
  });

  it("lets the account chip of Plan Trade and Record Live Trade shrink beside the back link, keeping its currency", () => {
    // On a phone the chip shares one line with "‹ Today": without min-w-0 it could not get narrower than that line.
    const html = renderToStaticMarkup(AccountChip({ name: LONG, currency: "USD" }));
    expect(html).toMatch(/^<span class="[^"]*\bmax-w-full\b[^"]*\bmin-w-0\b/);
    expect(nameBoxes(html, LONG)).toEqual([` class="truncate" title="${LONG}"`]);
    expect(html).toMatch(/<span class="flex-none [^"]*">USD<\/span>/);
  });
});

describe("100-character account names without spaces where a name is printed whole", () => {
  /** src/app/globals.css built for `classes` by the project's Tailwind, as the dev server and `next build` build it. */
  async function stylesheetFor(classes: readonly string[]): Promise<string> {
    const [{ compile }, { readFileSync }, { dirname, resolve }, { fileURLToPath }] = await Promise.all([
      import("tailwindcss"), import("node:fs"), import("node:path"), import("node:url"),
    ]);
    const root = new URL("../", import.meta.url);
    const load = async (file: string) => ({ path: file, base: dirname(file), content: readFileSync(file, "utf8") });
    const globals = fileURLToPath(new URL("src/app/globals.css", root));
    const compiler = await compile(readFileSync(globals, "utf8"), {
      base: dirname(globals),
      loadStylesheet: (id, base) => load(id === "tailwindcss" ? fileURLToPath(new URL("node_modules/tailwindcss/index.css", root)) : resolve(base, id)),
    });
    return compiler.build([...classes]);
  }
  /** The classes of the element that holds `text` directly (its opening tag right before it). */
  function classesOf(html: string, text: string): string[] {
    const match = new RegExp(`<\\w+\\s[^>]*class="([^"]*)"[^>]*>${escapeRegExp(text)}`).exec(html);
    return match ? match[1].split(/\s+/) : [];
  }
  /** The built stylesheet's rules: the declarations of the first rule whose whole selector is `selector`. */
  async function stylesheetRules(): Promise<(selector: string) => string> {
    const css = (await stylesheetFor([])).replace(/\s+/g, " ");
    return selector => {
      const start = css.search(new RegExp(`(?:^|[};]) ?${escapeRegExp(selector)} \\{`));
      const open = css.indexOf("{", start + 1);
      return start < 0 ? "" : css.slice(open + 1, css.indexOf("}", open));
    };
  }
  /** `wrap-anywhere` builds `overflow-wrap: anywhere`: a word wider than its line breaks, and (unlike `break-word`) it
   * no longer sets the element's smallest width, so a flex item or an inline-flex link can shrink below the name. */
  async function expectWrapAnywhere(classes: readonly string[]) {
    expect(classes).toContain("wrap-anywhere");
    expect(await stylesheetFor(classes)).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;/);
  }

  it("breaks a page title, and the eyebrow link above it, inside the name instead of widening the page", async () => {
    expect(NO_SPACES.length).toBe(100);
    expect(NO_SPACES).not.toMatch(/\s/);
    // The account dashboard's title is the name; Manage's eyebrow links back to it by name and its title repeats it.
    const html = renderToStaticMarkup(createElement(PageHeader, {
      eyebrow: createElement("a", { href: `/accounts/${ACCOUNT}`, className: "inline-flex min-h-10 items-center gap-1" }, NO_SPACES),
      title: `Manage ${NO_SPACES}`,
      description: "Personal · cTrader · EUR",
    }));
    expect(html).toContain(`<h1 class="page-header-title">Manage ${NO_SPACES}</h1>`);
    // overflow-wrap is inherited: the title block's eyebrow, title and description all break a word that cannot fit.
    const block = /^<header class="page-header"><div class="([^"]*)">/.exec(html);
    const classes = (block?.[1] ?? "").replaceAll("&amp;", "&").split(/\s+/);
    expect(classes).toContain("min-w-0");
    await expectWrapAnywhere(classes);
    // `anywhere` lets the link shrink, never an icon beside its text (the way back's chevron keeps its size).
    expect(classes).toContain("[&_svg]:shrink-0");
    expect(await stylesheetFor(["[&_svg]:shrink-0"])).toMatch(/flex-shrink:\s*0/);
  });

  it("breaks an overlong word in section and card headers without changing any element's smallest width", async () => {
    // Review's section description and its history card name the account. `break-words` (unlike `anywhere`) keeps every
    // element's min-content, so nothing in a crowded header row shrinks or breaks a word it would not have before.
    const section = renderToStaticMarkup(createElement(SectionHeader, { title: "Weekly review", description: `Reviews of ${NO_SPACES}` }));
    const sectionBlock = /^<div class="section-header"><div class="([^"]*)">/.exec(section);
    const card = renderToStaticMarkup(createElement(CardHeader, null, createElement(CardTitle, null, NO_SPACES), createElement(CardDescription, null, `Every AI analysis of ${NO_SPACES}`)));
    const titleClasses = classesOf(card, NO_SPACES);
    const descriptionClasses = classesOf(card, `Every AI analysis of ${NO_SPACES}`);
    for (const classes of [(sectionBlock?.[1] ?? "").split(/\s+/), titleClasses, descriptionClasses]) {
      expect(classes).toContain("break-words");
      expect(classes).not.toContain("wrap-anywhere");
    }
    expect(await stylesheetFor(["break-words"])).toMatch(/\.break-words\s*\{\s*overflow-wrap:\s*break-word;/);
  });

  it("breaks the name at the start of Plan Trade's risk check caption", async () => {
    const account = {
      id: ACCOUNT, name: NO_SPACES, currency: "EUR", description: "Personal · IC Markets", instruments: [], riskPlan: null, risk: null, todaysPlans: [],
      riskPlanId: null, observationId: null, balance: null, equity: null, observationDay: null, strategyVersion: null, usage: null,
    } as unknown as FormAccount;
    const html = renderToStaticMarkup(createElement(RiskPreview, { preview: { kind: "no-account" }, account, now: "2026-10-23T14:00:00Z" }));
    await expectWrapAnywhere(classesOf(html, NO_SPACES));
  });

  it("wraps a filter chip's label (the Journal's and EDGE's account filter) inside the chip instead of widening the page", async () => {
    // `?account=all&accountFilter=<id>` shows "Account: <name>" as a removable chip on the Journal and EDGE; with a
    // 100-character name without spaces it made a 393 px phone 320 px wider. Every chip (src/components/ui/filter-chips,
    // the Journal's and EDGE's filter rows, the custom tags) is a `.chip` whose label is its first `<span>`.
    const label = `Account: ${NO_SPACES}`;
    const html = renderToStaticMarkup(createElement(FilterChips, { chips: [{ key: "account", label, removeHref: "/journal?account=all" }] }));
    expect(html).toContain(`<li class="chip"><span>${label}</span><a class="chip-remove"`);
    const rule = await stylesheetRules();
    // The chip keeps to its row's width, and its label can break anywhere (min-width 0: a flex item never gets narrower
    // than its content otherwise); the remove button keeps its size.
    expect(rule(".chip")).toMatch(/max-width: 100%;/);
    expect(rule(".chip > span")).toMatch(/min-width: 0;/);
    expect(rule(".chip > span")).toMatch(/overflow-wrap: anywhere;/);
    expect(rule(".chip-remove")).toMatch(/flex: none;/);
  });

  it("keeps the header selector's label on one line beside a long account name", async () => {
    // From 1280 px "Trading Account:" shows beside the name; a long name truncates, and the label no longer breaks into
    // "Trading / Account:".
    const rule = await stylesheetRules();
    expect(rule(".account-trigger-label")).toMatch(/flex: none;/);
    expect(rule(".account-trigger-label")).toMatch(/white-space: nowrap;/);
    expect(rule(".account-trigger-value")).toMatch(/text-overflow: ellipsis;/);
  });

  it("wraps the name in Settings' AI cards and list of trading accounts instead of widening the page", async () => {
    const owner = { id: ACCOUNT, name: NO_SPACES, currency: "EUR", type: "PERSONAL", status: "ACTIVE" };
    const old = { id: TRADE, name: `${NO_SPACES.slice(0, 96)}_old`, currency: "USD", type: "DEMO", status: "ARCHIVED" };
    const snapshot: BudgetSnapshot = { enabled: true, budgetCents: 500, usedMicros: 130_000, heldMicros: 0, uncertain: false, period: "2026-10-01", resetAt: "2026-11-01T05:00:00Z" };
    const budget = {
      snapshot, presentation: budgetPresentation(snapshot, true), system: { status: "ENABLED", message: "AI analysis is available" }, events: [], error: null,
    };
    const data = {
      user: { id: "10000000-0000-4000-8000-000000000001", email: "chips@example.test" },
      preferences: { theme: "system", timeDisplay: { mode: "strategy" }, developerMode: false, sidebarCollapsed: false },
      nowIso: "2026-10-23T14:05:00.000Z", selectedAccountId: null, active: [owner], archived: [old],
      ai: { unavailableReason: null, accounts: [{ account: owner, budget }, { account: old, budget }] },
      connections: { rows: [{ account: owner, snapshot: { mode: "MANUAL", connection: null, lastSyncedAt: null, message: null } }], error: null },
      platforms: [], mockSync: null,
      export: { tables: { core: ["accounts"], trades: ["trades"], ai: ["ai_usage_records"], "evidence-manifest": ["trade_evidence"] }, screenshots: { total: 0, removed: 0 } },
      schemaVersion: "2.0",
    } as unknown as SettingsPageData;
    const html = renderToStaticMarkup(createElement(SettingsPage, { data }));
    // Connections: a flex item never gets narrower than its content without min-w-0, then the word breaks.
    const connection = new RegExp(`<span class="([^"]*)">${escapeRegExp(NO_SPACES)}</span>`).exec(html);
    const classes = (connection?.[1] ?? "").split(/\s+/);
    expect(classes).toContain("min-w-0");
    await expectWrapAnywhere(classes);
    // AI: the account's card, and the list of archived accounts' budgets, break the names they print (overflow-wrap
    // is inherited by the budget summary inside).
    const card = new RegExp(`<article class="([^"]*)" aria-label="AI · ${escapeRegExp(NO_SPACES)}">((?:(?!</article>)[\\s\\S])*)</article>`).exec(html);
    expect(card?.[2]).toContain(`>${NO_SPACES}</p>`);
    await expectWrapAnywhere((card?.[1] ?? "").split(/\s+/));
    // The list is the innermost div around the archived account's compact budget line.
    // The list holds one column per archived account (its budget line and, while AI is on, Turn off AI); the list
    // breaks the names, and each account's column inherits it.
    const beforeOld = html.slice(0, html.indexOf(`>${old.name}<`));
    const [archivedList, entry] = [...beforeOld.matchAll(/<div class="([^"]*)">/g)].slice(-2);
    expect(entry?.[1]).toBe("flex flex-col gap-2");
    await expectWrapAnywhere((archivedList?.[1] ?? "").split(/\s+/));
  });
});
