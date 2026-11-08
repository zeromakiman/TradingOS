// UX CRITERIA, keyboard and themes (master specification §60 items 1–20; docs/V2_ARCHITECTURE.md §13.4, §13.5): the
// next action of every trade state, the command palette, single-key shortcuts, a visible focus ring, the tab order of
// Plan Trade, Escape on dialogs, the editor of a draft blocked for two reasons (measured and tapped on the phone whatever
// the clock says), the live note from Today on a phone with taps only, core actions outside debug disclosures, the dark
// theme and, last on the phone, the width of every phone screen the run reached. finalCriteria() then judges the
// criteria that need every flow's screens: no raw internals in any visible text (7), the account context shown on every
// screen (11) and the live-note screens fitting the phone without sideways panning (18).
import { accountsOf, passwordGrant, userRpc } from "../fixtures.mjs";
import { scanVisibleText, screenOf, widerThanPhone } from "../rules.mjs";
import { arrive, goto, hidden, layoutWidth, main, press, region, selectByLabel, textOf, until, visible, waitForText } from "../ui.mjs";
import { aboveTheFold, openTrade, pick, tradeState } from "./common.mjs";

/** Next action per state (docs/V2_ARCHITECTURE.md §2.4) on the seeded showcase trades. */
const NEXT_ACTIONS = [
  { trade: "todayBlocked", state: "Blocked", action: { role: "link", name: "Edit draft" } },
  { trade: "staleDraft", state: "Recheck needed", action: { role: "button", name: "Recheck risk" } },
  { trade: "todayWaiting", state: "Locked · waiting for entry", action: { role: "link", name: "Record entry" } },
  { trade: "todayPlannedLive", state: "Live", action: { role: "link", name: "Add to journal" } },
  { trade: "todayClosed", state: "Closed · review pending", action: { role: "link", name: "Write review" } },
  { journal: "/journal?account=all&state=reviewed", state: "Reviewed", action: { role: "button", name: "Reopen review" } },
];

/** The accessible name of the focused element ("" when focus is on the page). */
const focusedName = page => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "";
  const labelled = el.getAttribute("aria-label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null) ?? el.closest("label")?.textContent ?? el.textContent ?? "";
  const group = (el.closest("fieldset")?.querySelector("legend")?.textContent ?? "").replace(/\*/g, "").trim();
  return `${group ? `${group} › ` : ""}${labelled.replace(/\*/g, "").replace(/\s+/g, " ").trim()}`.slice(0, 80);
});

export default async function ux(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Freshly seeded synthetic user (shared with the analytics flow)", async s => {
    const seeded = await env.users.seeded("history");
    s.info(`signed in as ${seeded.email}`);
    await run.open(seeded);
    return seeded;
  });
  if (!user) return;
  const page = run.page;
  const trades = user.showcase.trades;

  await run.step("next-actions", "Every trade state shows its next action in the first viewport", async s => {
    const seen = [];
    for (const { trade, journal, state, action } of NEXT_ACTIONS) {
      if (journal) {
        // No showcase name for a reviewed trade: open the newest one from the Journal's Reviewed filter.
        await goto(page, journal);
        await press(main(page).getByRole("link").filter({ hasText: /Reviewed/ }).first(), { tap });
        await arrive(page, url => /^\/trades\/[0-9a-f-]{36}$/.test(url.pathname));
        await page.getByRole("heading", { level: 1 }).first().waitFor();
      } else if (trades[trade]) {
        await openTrade(page, trades[trade]);
      } else {
        continue;
      }
      const shown = await tradeState(page);
      if (shown !== state) {
        s.info(`${trade ?? journal} is ${shown} (expected ${state}); its next action was not judged`);
        continue;
      }
      const control = page.getByRole(action.role, { name: action.name, exact: true }).first();
      s.check(await aboveTheFold(page, control), `${state}: "${action.name}" is visible without scrolling`);
      seen.push(`${state} → ${action.name}`);
    }
    s.check(seen.length >= 4, "the next action was judged in at least four states", seen.join("; "));
    s.evidence(1, `next action above the fold at ${run.vp.width}×${run.vp.height}: ${seen.join("; ")}`);
  }, { criteria: [1] });

  await run.step("core-actions-visible", "Core trade actions never sit inside a collapsed debug disclosure", async s => {
    const hidden = [];
    for (const trade of ["todayBlocked", "todayWaiting", "todayPlannedLive", "todayClosed"]) {
      if (!trades[trade]) continue;
      await openTrade(page, trades[trade]);
      const inside = await main(page).evaluate(root => [...root.querySelectorAll("details:not([open]) a, details:not([open]) button")]
        .map(el => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(name => /^(Edit draft|Lock plan|Record entry|Close trade|Add to journal|Mark reviewed|Save draft|Recheck risk|Write review)$/.test(name)));
      hidden.push(...inside.map(name => `${trade}: ${name}`));
    }
    s.check(hidden.length === 0, "no core action is inside a closed disclosure", hidden.join(", ") || "Technical details hold only ids, versions and raw reports");
    s.evidence(13, "on draft, locked, live and closed trades every core action is a visible control; Technical details stay collapsed and optional");
  }, { criteria: [13] });

  await run.step("command-palette", "Command palette: Ctrl+K (and /) opens it, Enter navigates, Escape closes", async s => {
    await goto(page, "/today?account=all");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Search and commands" });
    s.check(await visible(palette, 5_000), "Ctrl+K opens 'Search and commands'");
    const box = palette.getByRole("combobox", { name: "Search trades, accounts and commands" });
    s.check(await box.evaluate(el => el === document.activeElement), "the search field has focus");
    await s.shot("command-palette");
    if (!run.mobile) await run.curate("command-palette", "Command palette (Ctrl+K): actions, navigation, accounts and trades");
    await box.fill("Journal");
    const option = palette.getByRole("option").first();
    s.check(/Journal/.test(await textOf(option)), "typing filters the options", await textOf(option));
    await page.keyboard.press("Enter");
    await arrive(page, url => url.pathname === "/journal", { timeout: 30_000 });
    s.check(true, "Enter opens the Journal");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("/");
    s.check(await visible(palette, 5_000), "'/' opens it too");
    await page.keyboard.press("Escape");
    s.check(await hidden(palette), "Escape closes it");
  });

  await run.step("shortcuts", "Single-key shortcuts: ? shows help, P opens Plan Trade, L opens Record Live Trade", async s => {
    await goto(page, "/today?account=all");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Shift+Slash");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    s.check(await visible(help, 5_000), "'?' opens the keyboard shortcuts");
    await page.keyboard.press("Escape");
    s.check(await hidden(help), "Escape closes it");
    await page.keyboard.press("p");
    await arrive(page, url => url.pathname === "/trades/new", { timeout: 30_000 });
    s.check(true, "P opens Plan Trade");
    await goto(page, "/today");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("l");
    await arrive(page, url => url.pathname === "/trades/live/new", { timeout: 30_000 });
    s.check(true, "L opens Record Live Trade");
  });

  await run.step("focus-visible", "Keyboard focus is always visible (skip link, then a 2px ring)", async s => {
    await goto(page, "/today");
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    s.check(await skip.evaluate(el => el === document.activeElement), "the first Tab reaches 'Skip to main content'");
    s.check(await visible(skip, 2_000), "and the skip link becomes visible");
    const rings = [];
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== "none" ? Number.parseFloat(style.outlineWidth) : 0;
        return { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40), outline, shadow: style.boxShadow !== "none" };
      });
      if (ring) rings.push(ring);
    }
    const weak = rings.filter(ring => ring.outline < 2 && !ring.shadow);
    s.check(rings.length >= 4 && weak.length === 0, "every focused control draws a ring of at least 2px", rings.map(ring => `${ring.name}: ${ring.outline}px${ring.shadow ? " + shadow" : ""}`).join("; "));
    const h1 = await page.getByRole("heading", { level: 1 }).count();
    s.check(h1 === 1, "the page has exactly one h1", `${h1}`);
  });

  if (!run.mobile) {
    await run.step("tab-order", "Tab order through Plan Trade follows the form", async s => {
      await goto(page, "/trades/new?account=all");
      const form = page.getByRole("form", { name: "Plan trade" });
      const account = form.getByRole("combobox", { name: "Trading account" });
      // With several accounts the instrument list waits for an account; choose one, then walk the form from it.
      await selectByLabel(account, /^FTMO 100K/);
      // The contract confirmation appears once an instrument is chosen.
      await selectByLabel(form.getByRole("combobox", { name: "Instrument" }), "EURUSD");
      await account.focus();
      const order = [await focusedName(page)];
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Tab");
        const name = await focusedName(page);
        if (order.at(-1) !== name) order.push(name);
        if (/^Save draft/.test(name)) break;
      }
      const expected = [/^Trading account/, /^Instrument/, /Direction › /, /Model › /, /^Entry/, /^Stop loss/, /^Target/, /Risk per trade › /, /^Thesis/, /Economic news › /, /Contract values match my broker/, /My setup contradicts a strategy rule/, /Choose files/, /^Save draft/];
      s.info(`tab stops: ${order.join(" → ")}`);
      const positions = expected.map(pattern => order.findIndex(name => pattern.test(name)));
      const missing = expected.filter((_, i) => positions[i] < 0).map(String);
      const ordered = positions.every((position, i) => i === 0 || position > positions[i - 1]);
      s.check(missing.length === 0, "Tab reaches every field of the plan", missing.join(", ") || `${order.length} stops`);
      s.check(ordered, "in the visual order of the form", order.join(" → "));
    });
  }

  await run.step("escape-dialogs", "Escape closes dialogs and menus and returns focus", async s => {
    await openTrade(page, trades.todayBlocked);
    const discard = page.getByRole("button", { name: "Discard…" }).first();
    await press(discard, { tap });
    const dialog = page.getByRole("alertdialog", { name: "Discard this draft?" });
    s.check(await visible(dialog, 5_000), "Discard… opens its confirmation");
    await page.keyboard.press("Escape");
    s.check(await hidden(dialog), "Escape closes the confirmation without discarding");
    // Focus comes back once the dialog has finished closing (a frame or two after it is hidden), so it is polled; the
    // time it took is recorded, so a slow return shows in the evidence instead of passing silently.
    const closedAt = Date.now();
    const returned = await until(() => discard.evaluate(el => el === document.activeElement), { timeout: 3_000, interval: 50 });
    s.check(returned, "focus returns to the Discard… button", `${returned ? "after" : "not within"} ${Date.now() - closedAt} ms`);
    s.check((await tradeState(page)) === "Blocked", "the draft is unchanged");
    const selector = page.getByRole("button", { name: /^Trading Account:/ }).first();
    await press(selector, { tap });
    const menu = page.getByRole("menu");
    s.check(await visible(menu, 5_000), "the account selector opens its menu");
    await page.keyboard.press("Escape");
    s.check(await hidden(menu), "Escape closes the menu");
    // The close of a trade is recorded once (spec §57): submitting the form only opens its confirmation, which starts
    // on "Keep editing" (a second Enter records nothing), and going back records nothing and returns focus to the field
    // the trader was in. The seeded live trade stays live for the flows after this one.
    if (trades.todayPlannedLive) {
      await openTrade(page, trades.todayPlannedLive);
      const form = page.getByRole("form", { name: "Close trade" });
      const price = form.getByRole("textbox", { name: /exit price/i }).first();
      const entry = /Entry\s+([0-9]+(?:\.[0-9]+)?)/.exec(await textOf(region(page, "Plan")))?.[1] ?? "";
      await price.fill(entry);
      if (tap) await press(form.getByRole("button", { name: "Close trade" }), { tap });
      else await price.press("Enter");
      const confirm = page.getByRole("alertdialog", { name: "Close this trade?" });
      s.check(await visible(confirm, 10_000), tap ? "Close trade opens the confirmation" : "Enter in the exit price opens the close confirmation");
      const keepEditing = confirm.getByRole("button", { name: "Keep editing" });
      if (tap) await press(keepEditing, { tap });
      else {
        s.check(await until(() => keepEditing.evaluate(el => el === document.activeElement), { timeout: 3_000, interval: 50 }), "focus starts on Keep editing, so Enter alone records nothing");
        await page.keyboard.press("Escape");
      }
      s.check(await hidden(confirm), tap ? "Keep editing closes the confirmation" : "Escape closes the confirmation");
      if (!tap) s.check(await until(() => price.evaluate(el => el === document.activeElement), { timeout: 3_000, interval: 50 }), "focus returns to the exit price field");
      s.check((await price.inputValue()) === entry, "the exit price typed is kept", entry);
      s.check((await tradeState(page)) === "Live", "the trade is still live: nothing was recorded");
    }
  });

  // The seeded blocked draft has two blocking reasons at any time of day (more text in the editor's sticky verdict bar
  // than the planned flow's own draft outside Dead Pool), so its editor is measured, and tapped on the phone, every run.
  await run.step("edit-blocked-draft", `Edit draft of a draft blocked for two reasons: both are listed and the editor ${run.mobile ? "takes taps and fits the phone" : "fits the screen"}`, async s => {
    await goto(page, `/trades/${trades.todayBlocked}/edit`);
    const form = page.getByRole("form", { name: "Edit draft" });
    await form.waitFor({ state: "visible" });
    s.check(/Revision \d+ → \d+/.test(await textOf(main(page))), "the editor of the existing draft announces its next revision");
    const reasons = page.getByRole("region", { name: "Risk check preview" }).getByRole("list", { name: "Blocking reasons" }).first();
    await reasons.waitFor({ state: "visible", timeout: 20_000 });
    const listed = await reasons.evaluate(list => [...list.querySelectorAll(":scope > li")].map(item => (item.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 70)));
    s.check(listed.length >= 2, "the preview lists every blocking reason", listed.join(" | "));
    // Measured as it opened (a new risk can resolve a reason and shorten the verdict bar again).
    const width = await layoutWidth(page);
    // Changing the risk is a tap on a phone; nothing is saved (the runner leaves the page without saving).
    await pick(run, form.getByRole("group", { name: "Risk per trade" }), "0.25%");
    s.check(width <= run.vp.width + 1, `the editor fits the ${run.vp.width} px screen as it opens (no sideways panning)`, `${width} px wide with ${listed.length} blocking reasons`);
    s.evidence(5, `${run.mobile ? "phone" : "desktop"}: the editor of a draft blocked for ${listed.length} reasons opens with its next revision, takes a ${run.mobile ? "tap" : "click"} on a risk preset and fits ${run.vp.width} px`);
    await s.shot("edit-blocked-draft");
  }, { criteria: [5] });

  if (run.mobile) {
    await run.step("mobile-live-note", "Phone: add a live note from Today with taps only (no hover)", async s => {
      await goto(page, "/today?account=all");
      const live = region(page, /^Live trades/);
      s.check(await visible(live), "Today lists the live trades first");
      const button = live.getByRole("button", { name: /^Add note: / }).first();
      const name = (await button.getAttribute("aria-label")) ?? "";
      const box = await button.boundingBox();
      s.check(box && box.width >= 40 && box.height >= 40, "the Add note control is visible without hover and at least 40px", box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "not visible");
      await press(button, { tap: true });
      const form = page.getByRole("form", { name: "Add to trade journal" }).filter({ visible: true }).first();
      await form.waitFor({ state: "visible" });
      const field = form.getByRole("textbox", { name: "Journal entry" });
      await press(field, { tap: true });
      await field.fill("Phone note: price is respecting the order block; holding.");
      await press(form.getByRole("button", { name: /Add to journal|Add note|Add/ }), { tap: true });
      // The composer first shows the note as a pending "Saving" record; only the server's answer confirms it.
      const saved = await waitForText(form, /Added to the journal\./, 45_000);
      s.check(saved, "the server confirms the note ('Added to the journal.')", name);
      const settled = await until(async () => {
        const text = await textOf(live);
        return text.includes("respecting the order block") && !/Saving ·/.test(text) ? text : null;
      }, { timeout: 30_000 });
      s.check(settled, "the card shows the saved note as its latest journal item, nothing left pending");
      s.check(new URL(page.url()).pathname === "/today", "without leaving Today");
      await s.shot("mobile-live-note");
      await run.curate("mobile-today-live-note", "Phone: Today's live trade card with the inline note composer (taps only)");
      s.evidence(18, `${name}: opened with a tap, typed and saved with a tap at 393×852 (touch, no hover)`);
      s.evidence(2, "a live note added from Today's live card without opening the trade");
    }, { criteria: [18, 2] });
  }

  await run.step("today", "Today answers the trading questions at a glance", async s => {
    await goto(page, "/today?account=all");
    const text = await textOf(main(page));
    for (const part of ["Sessions today", "Trading status", "Trades left", "Risk left", "Realized losses", "Live trades", "Plans waiting"]) s.check(text.includes(part), `Today shows ${part}`);
    await s.shot("today", { full: true });
    await run.curate("today", "Today: session ribbon, trading status per account, live trades, plans waiting, closed today", { full: true });
  });

  await run.step("dark-theme", "Dark theme on key screens", async s => {
    await run.open(user, { theme: "dark" });
    const p = run.page;
    const screens = [
      { path: "/today?account=all", key: "today" },
      { path: `/trades/${trades.todayPlannedLive}`, key: "trade-live" },
      { path: "/edge?account=all", key: "edge" },
    ];
    for (const screen of screens) {
      await goto(p, screen.path);
      const facts = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, background: getComputedStyle(document.body).backgroundColor }));
      s.check(facts.theme === "dark" && /rgb\(13, 16, 21\)/.test(facts.background), `${screenOf(screen.path)} renders the dark tokens`, `${facts.theme} · ${facts.background}`);
      await s.shot(`dark-${screen.key}`);
      await run.curate(screen.key, `Dark theme: ${screenOf(screen.path).replace("/:id", "")}`);
    }
    await run.open(user);
  });

  await run.step("raw-internals", "Visible text of this flow's screens has no UUIDs, provider ids, rule codes, enums or prompts", async s => {
    const own = env.recorder.results.scans.filter(scan => scan.viewport === run.viewport && scan.flow === "ux");
    const hits = own.filter(scan => scan.hits.length > 0);
    s.check(own.length > 0 && hits.length === 0, "no raw internals on the screens visited here", hits.map(scan => `${scan.screen}: ${scan.hits[0].match}`).join("; ") || `${own.length} screens scanned`);
    const sample = await textOf(main(page));
    s.check(scanVisibleText(sample).length === 0, "including the current screen");
  });

  if (run.mobile) {
    // Account names run up to 100 characters (the create form, the profile rename and the database all allow them), the
    // seeded ones are short. For this step two of the user's accounts carry 100-character names (renamed the way the
    // profile form does it), one of them without a single space (nothing to wrap at but the name itself), so Today, a
    // live trade, Plan Trade, the account's dashboard and Manage pages, Review, the Journal's and EDGE's account filter
    // chips and Settings are measured with them; their scans count in "phone-width" below. The seeded names are put back
    // afterwards, whatever happened.
    await run.step("long-account-names", `Phone: Today, a live trade, Plan Trade, the account pages, Review, AI history, the Journal's and EDGE's account filter and Settings fit ${run.vp.width} px with 100-character account names`, async s => {
      const p = run.page;
      const { ftmo, personal } = user.showcase.accounts;
      const long = {
        [ftmo]: "FTMO Challenge Phase 2 · 200K Swing (Aggressive) · EURUSD and GBPUSD focus · London and NY sessions.",
        // No spaces at all; the personal account holds the seeded live trade, so its trade page is measured with it too.
        [personal]: "Personal_IC_Markets_12K_cTrader_DE40_and_NAS100_index_scalps_no_news_trading_Mon_to_Fri_only_v2vwxyz",
      };
      s.check(Object.values(long).every(name => name.length === 100), "both names are 100 characters long, the longest an account name can be");
      const seededNames = Object.fromEntries(accountsOf(env.stack, user.id).filter(account => account.id in long).map(account => [account.id, account.name]));
      const grant = await passwordGrant(env.stack, user.email, user.password);
      s.check(grant.ok, "the synthetic user signs in to the local gateway", grant.error ?? undefined);
      const rename = names => Promise.all(Object.entries(names).map(([id, displayName]) => userRpc(env.stack, grant.token, "update_account_profile", { p_account_id: id, p_input: { displayName } })));
      const renamed = await rename(long);
      try {
        s.check(renamed.every(result => result.ok), "two accounts renamed through update_account_profile", renamed.map(result => result.message).filter(Boolean).join("; ") || undefined);
        /** No sideways panning, and the tab bar (Today · Journal · New trade · Accounts · More) stays on the screen. */
        const fitsPhone = async screen => {
          const width = await layoutWidth(p);
          s.check(width <= run.vp.width + 1, `${screen} fits ${run.vp.width} px`, `${width} px wide`);
          const bar = await p.getByRole("navigation", { name: "Primary" }).first().boundingBox();
          const onScreen = bar && bar.x >= 0 && bar.x + bar.width <= run.vp.width + 1 && bar.y + bar.height <= run.vp.height + 1;
          s.check(onScreen, `${screen}: the tab bar is on the screen`, bar ? `${Math.round(bar.width)}×${Math.round(bar.height)} at ${Math.round(bar.x)},${Math.round(bar.y)}` : "no tab bar");
        };
        await goto(p, "/today?account=all");
        await fitsPhone("Today (All Accounts)");
        const today = await textOf(main(p));
        s.check(Object.values(long).every(name => today.includes(name)), "Today keeps both names whole in its text (they are cut only on the screen)");
        await s.shot("long-account-names-today");
        const live = trades.todayLiveFirst ?? trades.todayPlannedLive;
        if (live) {
          await openTrade(p, live);
          await fitsPhone("the live trade");
          const chip = p.getByRole("link", { name: /^Trading account / }).first();
          const box = await chip.boundingBox();
          s.check(box && box.x + box.width <= run.vp.width + 1, "the trade header's account chip stays inside the screen", box ? `right edge ${Math.round(box.x + box.width)} px` : "no chip");
          await s.shot("long-account-names-trade");
        }
        // Every other screen that prints a whole name: Plan Trade (form chip, risk check caption), the account's own Today
        // (page header, status heading), its dashboard and Manage titles, and Settings' account list.
        for (const [screen, path] of [
          ["Plan Trade", `/trades/new?account=${ftmo}`],
          ["Plan Trade (name without spaces)", `/trades/new?account=${personal}`],
          ["Today (one account, name without spaces)", `/today?account=${personal}`],
          ["the account dashboard (name without spaces)", `/accounts/${personal}`],
          ["Manage account (name without spaces)", `/accounts/${personal}/manage`],
          ["Review (one account, name without spaces)", `/review?account=${personal}`],
          ["AI history (one account, name without spaces)", `/review/history?account=${personal}`],
          // All Accounts narrowed by a link to one account: the filter row's "Account: <name>" chip wraps inside itself.
          ["the Journal's account filter chip (name without spaces)", `/journal?account=all&accountFilter=${personal}`],
          ["EDGE's account filter chip (name without spaces)", `/edge?account=all&accountFilter=${personal}`],
          ["Settings", "/settings"],
        ]) {
          await goto(p, path);
          await fitsPhone(screen);
          if (path.startsWith("/trades/new")) {
            // The chip beside "‹ Today" shrinks for the name; the way back keeps its one line.
            const back = await main(p).getByRole("link", { name: "Today", exact: true }).first().boundingBox();
            s.check(back && back.height <= 48, `${screen}: "‹ Today" stays on one line beside the account chip`, back ? `${Math.round(back.width)}×${Math.round(back.height)}` : "no link");
          }
        }
        await s.shot("long-account-names-settings");
        s.evidence(18, `Today, the live trade, Plan Trade, the account pages, Review, AI history, the Journal's and EDGE's account filter chips and Settings fit ${run.vp.width} px with two 100-character account names, one without spaces; the tab bar stays on the screen`);
      } finally {
        // Back to All Accounts (the account links above stored a single account as the context), then the seeded names.
        await goto(p, "/today?account=all").catch(() => null);
        const restored = await rename(seededNames).catch(error => [{ ok: false, message: String(error) }]);
        if (!restored.every(result => result.ok)) s.info("the seeded account names could not be put back", restored.map(result => result.message).join("; "));
      }
    }, { criteria: [18] });

    // Last of the phone pass: every phone screen measured so far in this run (after each navigation, before each tap,
    // at each screenshot and step end, by every flow) must fit the device; one that pans sideways fails here by name.
    await run.step("phone-width", `Every phone screen the run reached fits ${run.vp.width} px (no sideways panning)`, async s => {
      const scans = env.recorder.results.scans.filter(scan => scan.viewport === "mobile");
      const screens = new Set(scans.map(scan => `${scan.screen}|${scan.theme}`));
      const wide = widerThanPhone(scans);
      s.check(scans.length > 0, "the run measured phone screens", `${screens.size} screens and themes`);
      s.check(
        wide.length === 0,
        `no phone screen is wider than ${run.vp.width} px`,
        wide.map(scan => `${scan.screen}${scan.theme === "dark" ? " (dark)" : ""} +${scan.overflowPx} px, widest ${scan.widest ?? "unknown"}`).join("; ") || `${screens.size} screens and themes measured`,
      );
    });
  }
}

/**
 * Criteria judged over every flow's screens once all flows ran: 7 (no raw internals in any scanned visible text),
 * 11 (the account context selector is visible on every app screen) and 18 (Today and the trade page fit the phone).
 */
export function finalCriteria(env) {
  const { recorder } = env;
  const scans = recorder.results.scans;
  if (!scans.length) return;
  const record = (criterion, ok, message) => recorder.criterion({ criterion, ok, flow: "all", viewport: "all", step: null, message });
  const hits = scans.filter(scan => scan.hits.length > 0);
  record(7, hits.length === 0, hits.length === 0
    ? `${recorder.results.scanCount} scans of ${new Set(scans.map(scan => scan.screen)).size} screens (both viewports, light and dark): no UUID, hash, provider id, rule code, enum, raw JSON or prompt text`
    : `raw internals on ${hits.length} screens: ${hits.slice(0, 5).map(scan => `${scan.screen} (${scan.viewport}) "${scan.hits[0].match}"`).join("; ")}`);
  const app = scans.filter(scan => !/^\/(login|forgot-password|update-password)/.test(scan.screen));
  const missing = app.filter(scan => !scan.selector);
  record(11, missing.length === 0, missing.length === 0
    ? `the header's Trading Account selector was visible on all ${new Set(app.map(scan => `${scan.screen}|${scan.viewport}`)).size} app screens scanned (desktop and phone)`
    : `no account selector on: ${[...new Set(missing.map(scan => `${scan.screen} (${scan.viewport})`))].slice(0, 6).join(", ")}`);
  // Criterion 18 is about the live-note workflow: Today's live cards and the trade page with its journal composer must
  // fit the phone (a wider layout makes the screen pan sideways under the thumb). Every other phone screen that is
  // wider than the device is listed under "Phone width" in the summary.
  const liveNote = scans.filter(scan => scan.viewport === "mobile" && (scan.screen === "/today" || scan.screen === "/trades/:id"));
  if (liveNote.length) {
    const wide = liveNote.filter(scan => scan.overflowPx > 1);
    record(18, wide.length === 0, wide.length === 0
      ? `Today and the trade page fit 393 px in all ${liveNote.length} phone scans (no sideways panning while adding notes)`
      : `the live-note screens are wider than 393 px: ${[...new Set(wide.map(scan => `${scan.screen} (+${scan.overflowPx}px, ${scan.widest ?? "?"})`))].slice(0, 4).join("; ")}`);
  }
  recorder.write();
}

