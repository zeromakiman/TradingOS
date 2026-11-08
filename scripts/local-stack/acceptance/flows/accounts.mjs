// ACCOUNTS (master specification §64; docs/V2_ARCHITECTURE.md §9, §14.7–14.9): All Accounts as an aggregation context,
// an individual account dashboard, switching context with the header selector (always visible), account-scoped
// filters, multi-currency aggregation that never adds currencies, creating an account and archiving one (archived
// accounts are no longer offered for new trades, and the server refuses them).
import { randomUUID } from "node:crypto";
import { sqlValue } from "../../lib.mjs";
import { accountsOf, passwordGrant, userRpc } from "../fixtures.mjs";
import { arrive, fill, goto, main, press, region, selectByLabel, textOf, until, visible, waitForText } from "../ui.mjs";
import { showBreakdown } from "./common.mjs";

const NEW_ACCOUNT = "Acceptance GBP 10K";
const MONEY = /[+−-]?[$€£][\d,]+\.\d{2}/g;

/** Names of the active accounts as listed: table rows on desktop, one card per account on phones. */
function activeAccountNames(page, mobile) {
  if (mobile) {
    return page.getByRole("list", { name: "Active trading accounts" }).evaluate(list => [...list.querySelectorAll(":scope > li")].map(item => (item.querySelector("a")?.textContent ?? "").trim()));
  }
  return page.getByRole("table", { name: "Active trading accounts" }).evaluate(table => [...table.querySelectorAll("tbody tr")].map(row => (row.cells[0]?.querySelector("a")?.textContent ?? "").trim()));
}

/** Total lines (per currency, then combined R): the table footer on desktop, the Totals card on phones. */
function totalLines(page, mobile) {
  if (mobile) return page.getByRole("region", { name: "Totals" }).evaluate(card => [...card.children].map(child => (child.textContent ?? "").replace(/\s+/g, " ").trim()));
  return page.getByRole("table", { name: "Active trading accounts" }).evaluate(table => [...table.querySelectorAll("tfoot tr, tbody tr")].map(row => (row.textContent ?? "").replace(/\s+/g, " ").trim()).filter(text => /^(Total|All active accounts)/.test(text)));
}

/** Header context selector ("Trading Account: All Accounts"). */
const selector = page => page.getByRole("button", { name: /^Trading Account:/ }).first();
const selectorText = async page => ((await selector(page).getAttribute("aria-label")) ?? (await textOf(selector(page)))).replace(/\s+/g, " ").trim();

export default async function accounts(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Freshly seeded synthetic user (FTMO 100K USD, Personal 12K EUR, Demo 100K USD)", async s => {
    const seeded = await env.users.seeded(`accounts-${run.viewport}`);
    s.info(`signed in as ${seeded.email} (seeded for this run)`);
    await run.open(seeded);
    return seeded;
  });
  if (!user) return;
  const page = run.page;
  const ids = user.showcase.accounts;

  await run.step("all-accounts", "All Accounts is an aggregation context, not an account", async s => {
    await goto(page, "/accounts?account=all");
    s.check(/All Accounts/.test(await selectorText(page)), "the header says 'Trading Account: All Accounts'", await selectorText(page));
    await press(selector(page), { tap });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    const options = await menu.getByRole("menuitemradio").evaluateAll(items => items.map(item => (item.textContent ?? "").replace(/\s+/g, " ").trim()));
    s.check(/All Accounts.*Aggregate of every trading account/.test(options[0] ?? ""), "the selector's first option is All Accounts, described as an aggregate", options[0]);
    s.check(options.length === 4, "followed by the three real accounts", options.join(" | "));
    await page.keyboard.press("Escape");
    const rows = await activeAccountNames(page, run.mobile);
    s.check(rows.length === 3 && !rows.some(name => /All Accounts/.test(name)), "the accounts list shows the three accounts and no 'All Accounts' entry", rows.join(" | "));
    const totals = await totalLines(page, run.mobile);
    s.check(totals.length > 0, "totals are shown per currency and for R", totals.join(" | "));
    for (const line of totals) s.check(!(/\$/.test(line) && /€/.test(line)), `the total "${line.slice(0, 40)}" never adds dollars and euros`);
    s.check(totals.some(line => /R is per-trade risk units, not money/.test(line)), "R is aggregated across accounts with the label 'R is per-trade risk units, not money'");
    const stored = accountsOf(env.stack, user.id).map(account => account.name);
    s.check(!stored.some(name => /^All Accounts$/i.test(name)), "no stored account row represents All Accounts", stored.join(", "));
    await s.shot("accounts");
    await run.curate("accounts", "Accounts: each account in its own currency; totals only within one currency; R per-trade units");
    s.evidence(12, "selector option 'All Accounts · Aggregate of every trading account'; no All Accounts row in the table or database");
  }, { criteria: [12] });

  await run.step("account-dashboard", "An individual account dashboard (Personal 12K, EUR)", async s => {
    await press(main(page).getByRole("link", { name: "Personal 12K", exact: true }).first(), { tap });
    await arrive(page, url => url.pathname === `/accounts/${ids.personal}`);
    await page.getByRole("heading", { level: 1, name: "Personal 12K" }).waitFor();
    // Opening an active account from the list makes it the context, so the header names the account on screen (§9.2).
    const opened = await until(async () => /Personal 12K/.test(await selectorText(page)), { timeout: 20_000 });
    s.check(opened, "opening the account from the list makes it the context: the header names it", await selectorText(page));
    const actions = await main(page).getByRole("link", { name: /^(Plan Trade|Record Live Trade) on Personal 12K$/ }).evaluateAll(links => links.map(link => link.getAttribute("href")));
    s.check(actions.length === 2 && actions.every(href => href?.endsWith(`?account=${ids.personal}`)), "its Plan Trade and Record Live Trade are on this account, once each", actions.join(" | "));
    const values = await textOf(region(page, "Account values"));
    s.check(/€/.test(values) && !/\$/.test(values), "the account's values are in its own currency (EUR)", values.slice(0, 120));
    s.check(/Balance from trades/.test(values) && /Starting balance \+ realized P&L/.test(values), "'Balance from trades' is explained, never called equity");
    for (const name of ["Performance", "Calendar", "Risk plan history"]) s.check(await visible(region(page, name), 5_000), `the dashboard has ${name}`);
    await s.shot("account-dashboard");
    await run.curate("account-dashboard", "Account dashboard: values, results, charts, calendar and risk-plan history of one account", { full: !run.mobile });
  });

  await run.step("switch-context", "Switch the context with the header selector; the selected account stays visible", async s => {
    // From All Accounts: opening Personal 12K's dashboard above already made it the context.
    await goto(page, "/journal?account=all");
    s.check(/All Accounts/.test(await selectorText(page)), "starts in All Accounts", await selectorText(page));
    await press(selector(page), { tap });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await press(menu.getByRole("menuitemradio", { name: /Personal 12K/ }), { tap });
    const switched = await until(async () => /Personal 12K/.test(await selectorText(page)), { timeout: 20_000 });
    s.check(switched, "the header now says 'Trading Account: Personal 12K'", await selectorText(page));
    const subtitle = await waitForText(main(page), /Personal 12K ·/, 20_000);
    s.check(subtitle, "the Journal is scoped to Personal 12K");
    const rows = main(page).getByRole("link").filter({ hasText: /Planned|Live-first|Imported/ });
    await rows.first().waitFor();
    const names = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
    s.check(names.length > 0 && names.every(name => !/FTMO 100K|Demo 100K/.test(name)), "no trade of another account is listed", `${names.length} rows`);
    for (const path of ["/today", "/edge", "/review", "/settings"]) {
      await goto(page, path);
      s.check(/Personal 12K/.test(await selectorText(page)), `the selected account is shown on ${path}`, await selectorText(page));
    }
    await goto(page, "/today?account=all");
    s.check(/All Accounts/.test(await selectorText(page)), "?account=all switches back to All Accounts");
    s.evidence(11, "header selector shows the context on Journal, Today, EDGE, Review and Settings after switching to Personal 12K");
  }, { criteria: [11] });

  await run.step("account-filters", "Account-specific filters: EDGE and Journal scoped to one account", async s => {
    await goto(page, `/edge?account=${ids.personal}`);
    const results = await textOf(region(page, "Results"));
    const money = results.match(MONEY) ?? [];
    s.check(money.length > 0 && money.every(value => value.includes("€")), "Personal 12K's EDGE shows euro amounts only", money.slice(0, 4).join(" "));
    s.check(!(await visible(page.getByRole("figure", { name: "Account contribution" }), 1_500)), "the account-contribution chart is only offered in All Accounts");
    await goto(page, `/journal?account=${ids.ftmo}&origin=planned`);
    const rows = main(page).getByRole("link").filter({ hasText: /Planned|Live-first|Imported/ });
    await rows.first().waitFor();
    const names = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
    s.check(names.every(name => /Planned/.test(name) && !/Personal 12K|Demo 100K/.test(name)), "FTMO's planned trades only", `${names.length} rows`);
    await goto(page, "/edge?account=all");
    const contribution = await showBreakdown(page, "Account contribution");
    s.check(await visible(contribution), "All Accounts shows each account's contribution");
    const pnl = (await textOf(region(page, "Results"))).match(/[+−-]?[$€][\d,]+\.\d{2} (USD|EUR) · \d+ trades?/g) ?? [];
    s.check(pnl.length === 2, "All Accounts lists net P&L once per currency (USD and EUR), never one converted total", pnl.join(" | "));
    await goto(page, "/today?account=all");
    const status = await textOf(region(page, "Trading status · All Accounts"));
    const losses = /Realized losses today ([^A-Z]+)/.exec(status)?.[1] ?? "";
    s.check(!/\$[^·]*€|€[^·]*\$/.test(losses), "Today's realized losses keep euros and dollars apart", losses.trim());
    s.evidence(12, `All Accounts money stays per currency: ${pnl.join(" | ")}`);
  }, { criteria: [12] });

  const created = await run.step("create", "Create a trading account (GBP)", async s => {
    await goto(page, "/accounts?account=all");
    await press(main(page).getByRole("link", { name: "New account" }), { tap });
    await arrive(page, url => url.pathname === "/accounts/new");
    const form = page.getByRole("form", { name: "Create trading account" });
    await fill(form.getByRole("textbox", { name: "Account name" }), NEW_ACCOUNT);
    await selectByLabel(form.getByRole("combobox", { name: "Account type" }), "Personal");
    await selectByLabel(form.getByRole("combobox", { name: "Currency" }), /^GBP/);
    await fill(form.getByRole("textbox", { name: "Current balance" }), "10000");
    await press(form.getByRole("button", { name: "Create trading account" }), { tap });
    await arrive(page, url => /^\/accounts\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 90_000 });
    const id = new URL(page.url()).pathname.split("/").pop();
    const stored = accountsOf(env.stack, user.id).find(account => account.id === id);
    s.check(stored?.name === NEW_ACCOUNT, "the account is created and the browser moves to its dashboard", stored?.name);
    return id;
  });

  await run.step("new-account-dashboard", "The new account's dashboard opens in its currency and the account is listed", async s => {
    await page.getByRole("heading", { level: 1, name: NEW_ACCOUNT }).waitFor();
    s.check(/GBP/.test(await textOf(main(page))), "the new account's dashboard opens in GBP");
    const context = await until(async () => new RegExp(NEW_ACCOUNT).test(await selectorText(page)), { timeout: 20_000 });
    s.check(context, "and as the context: the header names the new account", await selectorText(page));
    // No closed trade yet: one explanation in place of the charts, and the page offers each way to start once.
    const starts = await main(page).getByRole("link", { name: /^(Plan Trade|Record Live Trade)\b/i }).evaluateAll(links => links.map(link => `${link.getAttribute("aria-label")} -> ${link.getAttribute("href")}`));
    s.check(starts.length === 2 && starts.every(start => start.endsWith(`?account=${created}`)), "Plan Trade and Record Live Trade appear once each in the page, on the new account", starts.join(" | "));
    await goto(page, "/accounts?account=all");
    const listed = await activeAccountNames(page, run.mobile);
    s.check(listed.includes(NEW_ACCOUNT), "it is listed with the active accounts", listed.join(" | "));
  }, { requires: ["create"] });

  const archived = await run.step("archive", "Archive the new account; history stays", async s => {
    await goto(page, `/accounts/${created}/manage`);
    const archive = region(page, "Archive");
    s.check(/Archiving hides the account from new trades; history stays\./.test(await textOf(archive)), "the copy says archiving hides it from new trades and keeps history");
    await press(archive.getByRole("button", { name: "Archive account…" }), { tap });
    const dialog = page.getByRole("alertdialog", { name: `Archive ${NEW_ACCOUNT}?` });
    await dialog.waitFor({ state: "visible" });
    await s.shot("archive-dialog");
    await press(dialog.getByRole("button", { name: "Archive account" }), { tap });
    await dialog.waitFor({ state: "detached", timeout: 60_000 });
    const restored = await waitForText(main(page), /Restore account…/, 30_000);
    s.check(restored, "the account is archived (Restore is offered)");
    await goto(page, "/accounts?account=all");
    const active = await activeAccountNames(page, run.mobile);
    s.check(!active.includes(NEW_ACCOUNT), "it left the active accounts", active.join(" | "));
    s.check(/Archived/.test(await textOf(main(page))), "it is listed in the Archived group");
    return created;
  }, { requires: ["create"] });

  await run.step("archived-no-new-trades", "Forms no longer offer an archived account for new trades", async s => {
    await goto(page, "/trades/new?account=all");
    const planAccounts = await page.getByRole("form", { name: "Plan trade" }).getByRole("combobox", { name: "Trading account" }).innerText();
    s.check(!planAccounts.includes(NEW_ACCOUNT), "Plan Trade does not offer the archived account", planAccounts.replace(/\s+/g, " "));
    await goto(page, "/trades/live/new");
    const liveAccounts = await page.getByRole("form", { name: "Record live trade" }).getByRole("combobox", { name: "Trading account" }).innerText();
    s.check(!liveAccounts.includes(NEW_ACCOUNT), "Record Live Trade does not offer it", liveAccounts.replace(/\s+/g, " "));
    await goto(page, `/today?account=${archived}`);
    const notice = await textOf(main(page));
    s.check(/isn't available\. Showing All Accounts\./.test(notice) && /All Accounts/.test(await selectorText(page)), "selecting it as the context falls back to All Accounts with a notice", notice.slice(0, 120));
  }, { requires: ["archive"] });

  await run.step("archived-server-guard", "The server refuses new trades on an archived account (not only the forms)", async s => {
    // The database is the authority: direct RPCs as the signed-in user must refuse a trade on an archived account, for
    // that reason (the archived-account guard runs before any input validation).
    const grant = await passwordGrant(env.stack, user.email, user.password);
    s.check(grant.ok, "the user's own session (password grant on the local gateway)", grant.error ?? "signed in");
    const before = accountsOf(env.stack, user.id).find(account => account.id === archived);
    s.check(before?.status === "ARCHIVED", "the account is stored as archived", before?.status);
    const live = await userRpc(env.stack, grant.token, "record_live_trade", { p_account_id: archived, p_input: { symbol: "EURUSD", direction: "LONG" }, p_request_key: randomUUID() });
    s.check(!live.ok && /^ACCOUNT_ARCHIVED:/.test(live.message ?? ""), "record_live_trade refuses it: ACCOUNT_ARCHIVED", live.ok ? `accepted: created trade ${live.data} on the archived account` : live.message);
    const planned = await userRpc(env.stack, grant.token, "create_planned_trade", { p_account_id: archived, p_proposal: {}, p_request_key: randomUUID(), p_expected_risk_id: null, p_expected_observation_id: null });
    s.check(!planned.ok && /^ACCOUNT_ARCHIVED:/.test(planned.message ?? ""), "create_planned_trade refuses it: ACCOUNT_ARCHIVED", planned.ok ? `accepted: ${JSON.stringify(planned.data).slice(0, 120)}` : planned.message);
    s.check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(archived), "the archived account id is a uuid", archived);
    const trades = Number(sqlValue(env.stack, `select count(*) from public.trades where account_id = '${archived}'::uuid`));
    s.check(trades === 0, "no trade exists on the archived account", `${trades} trades`);
  }, { requires: ["archive"] });
}
