// ANALYTICS (master specification §64; docs/V2_ARCHITECTURE.md §14.5, §14.6, §13.6): Journal, EDGE, charts with their
// table views, the performance calendar, statistic → trades, day → trades, trade → evidence/timeline, and the full
// drill-down All Accounts → Account → Day → Trade → Evidence on a freshly seeded user with ~90 days of history.
import { arrive, goto, hidden, main, press, region, textOf, timelineBands, tradeIdOf, until, visible } from "../ui.mjs";
import { openTrade, riskPlanEntries, showBreakdown } from "./common.mjs";

export default async function analytics(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Freshly seeded synthetic user with three accounts and ~90 days of history", async s => {
    const seeded = await env.users.seeded("history");
    s.info(`signed in as ${seeded.email} (seeded for this run)`);
    await run.open(seeded);
    return seeded;
  });
  if (!user) return;
  const page = run.page;

  await run.step("journal", "Journal: trades grouped by day, search and filters, row opens the trade", async s => {
    await goto(page, "/journal?account=all");
    const rows = main(page).getByRole("link").filter({ hasText: /Planned|Live-first|Imported/ });
    await rows.first().waitFor({ state: "visible", timeout: 30_000 });
    s.check((await rows.count()) > 10, "the Journal lists the user's trades", `${await rows.count()} rows on the first page`);
    const groups = await main(page).getByRole("region").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.querySelector("h3")?.textContent ?? "").filter(Boolean));
    s.check(groups.some(name => /Today|Yesterday|\b[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+/.test(name)), "rows are grouped by trade day", groups.slice(0, 3).join(" · "));
    await s.shot("journal");
    await run.curate("journal", "Journal: every trade grouped by trade day, with origin, state, R and P&L");
    const search = page.getByRole("searchbox", { name: /Search trades/ });
    await search.fill("DE40");
    await search.press("Enter");
    const filtered = await until(async () => {
      const names = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
      return names.length > 0 && names.every(name => name.includes("DE40")) ? names : null;
    }, { timeout: 20_000 });
    s.check(filtered, "searching 'DE40' leaves only DE40 trades", `${filtered?.length ?? 0} rows`);
    await goto(page, "/journal?account=all&origin=live-first");
    await rows.first().waitFor({ state: "visible", timeout: 30_000 });
    const origins = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
    s.check(origins.length > 0 && origins.every(name => name.includes("Live-first")), "the origin filter keeps live-first trades only", `${origins.length} rows`);
    const first = rows.first();
    const name = (await first.textContent())?.replace(/\s+/g, " ").trim().slice(0, 60);
    await press(first, { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    s.check(/No pre-trade plan was recorded before execution/.test(await textOf(main(page))), "the row opens that live-first trade", name);
  });

  await run.step("edge", "EDGE: headline statistics, money per currency, sample caveat and every chart with a table view", async s => {
    await goto(page, "/edge?account=all");
    const results = region(page, "Results");
    const text = await textOf(results);
    for (const label of ["Net R", "Expectancy", "Win rate", "Profit factor", "Max R drawdown", "Closed trades"]) s.check(text.includes(label), `headline shows ${label}`);
    const money = await results.locator("p").evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()).filter(line => /^[+−-]?[$€£]/.test(line) || /\b(USD|EUR)\b ·/.test(line)));
    s.check(money.length >= 2, "net P&L is listed once per currency", money.join(" | "));
    s.check(money.every(line => !(/\$/.test(line) && /€/.test(line))), "no money line mixes currencies");
    s.check(/R is per-trade risk units, not money/.test(text), "R aggregation is labelled 'R is per-trade risk units, not money'");
    s.check(/sample|more data is needed/i.test(text), "the sample-size caveat is shown");
    const figures = await main(page).getByRole("figure").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.querySelector("h2, h3")?.textContent ?? ""));
    for (const chart of ["Cumulative R", "R drawdown", "Daily net R", "R distribution", "Performance calendar"]) s.check(figures.some(name => name.startsWith(chart)), `chart "${chart}" is present`);
    const cumulative = page.getByRole("figure", { name: "Cumulative R" });
    await press(cumulative.getByRole("button", { name: "Table" }), { tap });
    s.check(await visible(cumulative.getByRole("table"), 10_000), "Cumulative R switches to its table view");
    await press(cumulative.getByRole("button", { name: "Chart" }), { tap });
    await s.shot("edge", { full: false });
    await run.curate("edge", "EDGE: headline statistics with sample caveat, money per currency and charts");
    s.evidence(12, "EDGE in All Accounts aggregates R across accounts (labelled) and lists money per currency, never summed");
  }, { criteria: [12] });

  await run.step("statistic-to-trades", "A statistic opens the trades behind it (Net R by model → OTE)", async s => {
    await goto(page, "/edge?account=all");
    const figure = await showBreakdown(page, "Net R by model");
    const link = figure.getByRole("link", { name: /^OTE: Net R/ });
    s.check(await visible(link), "the model breakdown links each group to its trades");
    const label = await link.getAttribute("aria-label") ?? (await textOf(link));
    await press(link, { tap });
    await arrive(page, url => url.pathname === "/journal" && url.searchParams.get("model") === "OTE");
    const rows = main(page).getByRole("link").filter({ hasText: /Planned|Live-first|Imported/ });
    await rows.first().waitFor();
    const names = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
    s.check(names.length > 0 && names.every(name => /Model: OTE/.test(name)), "the Journal shows only OTE trades", `${names.length} rows for "${label}"`);
    s.evidence(14, `statistic → trades: "${label.slice(0, 50)}" opened ${names.length} OTE trades in the Journal`);
  }, { criteria: [14] });

  const dayTrade = await run.step("calendar-day", "Calendar: a day opens its trades; a trade opens from there", async s => {
    await goto(page, "/edge?account=all");
    const calendar = page.getByRole("region", { name: "Performance calendar" });
    const days = calendar.getByRole("button", { name: /Show trades\.$/ });
    s.check((await days.count()) > 0, "days with closed trades are buttons", `${await days.count()} days this month`);
    const day = days.last();
    const label = (await day.getAttribute("aria-label")) ?? (await textOf(day));
    await press(day, { tap });
    const sheet = page.getByRole("dialog");
    await sheet.first().waitFor({ state: "visible" });
    const list = sheet.getByRole("list", { name: /^Trades closed on/ });
    s.check(await visible(list), "a sheet lists the trades closed that day", label.slice(0, 80));
    await s.shot("calendar-day-sheet");
    await run.curate("edge-calendar-day", "EDGE calendar: a day opens the trades closed on it");
    // Each row has a screenshot link ("3 screenshots of EURUSD · Long", opens the viewer) and the trade link.
    const tradeLink = list.getByRole("link", { name: /^(?!\d+ screenshots? of )/ }).first();
    await press(tradeLink, { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    s.check(await visible(region(page, "Result")), "the trade opens with its result");
    s.evidence(14, `day → trades: "${label.split(":")[0]}" listed its trades and opened one`);
    return tradeIdOf(page.url());
  }, { criteria: [14] });

  await run.step("trade-evidence", "Trade → evidence and timeline: open a screenshot in the viewer, close it with Escape", async s => {
    const tradeId = dayTrade ?? user.showcase.trades.todayClosed;
    await openTrade(page, tradeId);
    const bands = await timelineBands(page);
    s.check(Object.keys(bands).length > 0, "the trade shows its timeline bands", Object.keys(bands).join(" · "));
    let tile = region(page, "Evidence").getByRole("button", { name: /^Open .+, recorded/ });
    if (!(await tile.count())) {
      await openTrade(page, user.showcase.trades.todayClosed);
      tile = region(page, "Evidence").getByRole("button", { name: /^Open .+, recorded/ });
    }
    s.check((await tile.count()) > 0, "the Evidence gallery has screenshots to open");
    const name = await tile.first().getAttribute("aria-label");
    await press(tile.first(), { tap });
    const viewer = page.getByRole("dialog");
    await viewer.first().waitFor({ state: "visible" });
    const image = viewer.getByRole("img").first();
    const loaded = await until(() => image.evaluate(img => img.complete && img.naturalWidth > 0), { timeout: 20_000 });
    s.check(loaded, "the viewer shows the full image", name);
    s.check(await visible(viewer.getByRole("complementary", { name: "Screenshot details" })), "the viewer shows label, timing and time");
    await s.shot("evidence-viewer");
    if (!run.mobile) await run.curate("evidence-viewer", "Evidence viewer: full screenshot with label, timing band and recorded time");
    await page.keyboard.press("Escape");
    s.check(await hidden(viewer), "Escape closes the viewer");
  });

  await run.step("drill-down", "All Accounts → Account → Day → Trade → Evidence", async s => {
    await goto(page, "/accounts?account=all");
    const selector = page.getByRole("button", { name: /^Trading Account:/ }).first();
    s.check(/All Accounts/.test((await selector.getAttribute("aria-label")) ?? (await textOf(selector))), "the context is All Accounts");
    const accountId = user.showcase.accounts.ftmo;
    await press(main(page).getByRole("link", { name: "FTMO 100K", exact: true }).first(), { tap });
    await arrive(page, url => url.pathname === `/accounts/${accountId}`);
    await page.getByRole("heading", { level: 1, name: "FTMO 100K" }).waitFor();
    const calendar = region(page, "Calendar");
    const day = calendar.getByRole("link", { name: /closed trade/ }).last();
    s.check(await visible(day), "the account calendar links days with closed trades");
    const dayLabel = ((await day.getAttribute("aria-label")) ?? (await textOf(day))).split(":")[0];
    await press(day, { tap });
    await arrive(page, url => url.pathname === "/journal" && url.searchParams.has("closedFrom"));
    const rows = main(page).getByRole("link").filter({ hasText: /Planned|Live-first|Imported/ });
    await rows.first().waitFor();
    const names = await rows.evaluateAll(links => links.map(link => (link.textContent ?? "").replace(/\s+/g, " ")));
    // The day link carries ?account=<id>: the Journal now runs in that account's context (rows omit the account name).
    const scope = await textOf(main(page).getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]"));
    const context = (await selector.getAttribute("aria-label")) ?? (await textOf(selector));
    s.check(names.length > 0, "the day's Journal lists the trades closed that day", `${names.length} on ${dayLabel}`);
    s.check(/FTMO 100K/.test(scope) && /FTMO 100K/.test(context), "the Journal is scoped to that account and the header says so", `${scope} · ${context}`);
    await press(rows.first(), { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const tile = region(page, "Evidence").getByRole("button", { name: /^Open .+, recorded/ });
    if (await tile.count()) {
      await press(tile.first(), { tap });
      const viewer = page.getByRole("dialog");
      s.check(await visible(viewer), "the trade's screenshot opens in the viewer");
      await page.keyboard.press("Escape");
    } else {
      const evidence = await textOf(region(page, "Evidence"));
      s.check(/0 of 24 screenshots|No screenshots/i.test(evidence), "the trade states it has no screenshots", evidence.slice(0, 80));
    }
    s.evidence(14, `All Accounts → FTMO 100K → ${dayLabel} → trade → evidence, by clicking only`);
  }, { criteria: [14] });

  await run.step("historical-versions", "Historical trades keep the risk plan version they were locked under", async s => {
    const accountId = user.showcase.accounts.ftmo;
    await goto(page, `/accounts/${accountId}`);
    const versions = await riskPlanEntries(page);
    const active = /Risk Plan (V\d+\.\d+)/.exec(versions.find(entry => /\bActive\b/.test(entry)) ?? "")?.[1];
    s.check(active, "the account dashboard names the active risk plan version", versions.map(entry => entry.slice(0, 40)).join("; "));
    await goto(page, "/edge?account=all");
    const figure = await showBreakdown(page, "Net R by risk plan version");
    const legacy = figure.getByRole("link", { name: /^V1\.0 · FTMO 100K/ });
    s.check(await visible(legacy), "EDGE groups closed trades by the risk plan version they used");
    await press(legacy, { tap });
    await arrive(page, url => url.pathname === "/journal" && url.searchParams.has("riskPlan"));
    const row = main(page).getByRole("link").filter({ hasText: /Planned/ }).first();
    await row.waitFor();
    await press(row, { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const plan = await textOf(region(page, "Plan"));
    s.check(/Risk Plan V1\.0/.test(plan), "the historical trade shows Risk Plan V1.0 and ICT V1.0", /Locked[^·]*·[^·]*·[^·]*/.exec(plan)?.[0]);
    s.check(active !== "V1.0", "while the account's active version is newer", `active ${active}`);
    s.evidence(20, `a trade locked under Risk Plan V1.0 still shows V1.0 while FTMO 100K's active plan is ${active}`);
  }, { criteria: [20] });
}
