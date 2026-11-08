// AI with the LOCAL mock provider (master specification §64; docs/V2_ARCHITECTURE.md §8.3, §11): Analyze Setup,
// Challenge My Bias, the timeline-aware Review Trade, Weekly Review, Recent Trades and Monthly Review against
// scripts/local-stack/mock-openai.mjs (zero network, zero cost), the concise default card, the full-analysis sheet,
// friendly sources, the AI budget summary, paid AI as a secondary option on a blocked draft, and one failure scenario
// (.local/mock-openai-scenarios.json, restored right after) whose accounting is reported honestly.
import fs from "node:fs";
import path from "node:path";
import { LOCAL } from "../../lib.mjs";
import { clockSpan, deadPoolExpectation, fullAnalysisGaps, scanVisibleText } from "../rules.mjs";
import { choosePeriod, goto, hidden, press, region, textOf, until, visible, waitForText } from "../ui.mjs";
import { mockCalls, openTrade, tradeState, waitForState } from "./common.mjs";

const SCENARIO_FILE = path.join(LOCAL, "mock-openai-scenarios.json");
const DEAD_POOL_SENTENCE = "Trading is not permitted during Dead Pool";

/**
 * The structure of a result card or of its full-analysis sheet: its headings (the first one is the title) and the
 * text of every item (the paragraph of each list item; source chips excluded), whitespace collapsed.
 */
function analysisParts(locator) {
  return locator.evaluate(root => ({
    headings: [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map(h => (h.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
    items: [...root.querySelectorAll("li > p")].map(p => (p.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
  }));
}

/** "AI usage this month · €0.13 of €10.00 · €9.86 left" → {used, limit} in integer cents (exact, no floats). */
function budgetOf(text) {
  const match = /AI usage this month · €([\d,]+\.\d{2}) of €([\d,]+\.\d{2})/.exec(text);
  const cents = value => BigInt(value.replace(/[,.]/g, ""));
  return match ? { used: cents(match[1]), limit: cents(match[2]), text: match[0] } : null;
}

/**
 * Clicks a paid AI button and waits for its terminal outcome: the toast ("Setup analysis ready" / "… failed") and the
 * panel's newest history row. Returns {toast, row}. The click is the only thing that sends a request.
 */
async function runAi(s, page, panel, name, timeout = 150_000) {
  const button = panel.getByRole("button", { name }).first();
  s.check(await visible(button, 15_000), "the paid AI button is offered", String(name));
  const label = await textOf(button);
  s.check(/≈ €\d+\.\d{2}/.test(label), `"${label}" shows its typical cost before anything is sent`);
  // A button that cannot run says why in the text it is described by (aria-describedby).
  const reason = await button.evaluate(el => (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" "));
  s.check((await button.getAttribute("aria-disabled")) !== "true", `"${label}" can run`, reason || "no reason shown");
  const history = panel.getByRole("list", { name: /history/i }).first();
  const firstRow = async () => ((await history.count()) ? textOf(history.getByRole("listitem").first()) : "");
  const before = await firstRow();
  const since = new Date().toISOString();
  await press(button);
  const notifications = page.getByRole("region", { name: "Notifications" });
  const toast = await waitForText(notifications, /(ready|failed|Already requested)/i, timeout);
  s.check(toast, "the request reaches a final state and says so", toast?.slice(0, 120));
  const row = await until(async () => {
    const current = await firstRow();
    return current && current !== before ? current : null;
  }, { timeout: 30_000 });
  return { toast, row: row ?? (await firstRow()), since, label };
}

/** The concise card of an AI result inside a panel, by its heading. */
const card = (panel, title) => panel.getByRole("article").filter({ has: panel.page().getByRole("heading", { name: title, exact: true }) }).first();

/**
 * Checks a completed result card: concise by default (bounded text, at most two items per section), friendly source
 * chips without raw ids, and the full analysis in a side sheet that opens on demand, carries every item of the card in
 * full plus what the card leaves out (rules.mjs fullAnalysisGaps), shows no raw ids and closes with Escape.
 */
async function inspectCard(s, run, article, { name, curateKey, where = null }) {
  const page = run.page;
  s.check(await visible(article, 30_000), `the ${name} card is shown`);
  const text = await textOf(article);
  s.check(/Completed/.test(text), "the card says Completed", text.slice(0, 80));
  s.check(/AI interpretation · advisory/.test(text), "the AI part is labelled 'AI interpretation · advisory'");
  s.check(text.length <= 1_800, "the default card is concise", `${text.length} characters visible`);
  const sources = await article.getByRole("list", { name: "Sources" }).evaluateAll(lists => lists.flatMap(list => [...list.querySelectorAll("li")].map(item => (item.textContent ?? "").trim())));
  const raw = sources.filter(source => scanVisibleText(source).length > 0);
  s.check(sources.length > 0 && raw.length === 0, "sources are friendly chips without raw ids", [...new Set(sources)].slice(0, 6).join(" · "));
  s.evidence(16, `${name}: concise card of ${text.length} visible characters; the full analysis opens only on request`);
  if (curateKey) {
    // The card from its first line, just below the sticky top bar.
    await article.evaluate(element => {
      element.scrollIntoView({ block: "start" });
      window.scrollBy(0, -72);
    });
    const preTrade = name === "Analyze Setup" || name === "Challenge My Bias";
    await run.curate(`${curateKey}-concise`, `${where ? `${where} · ` : ""}${name}: concise default card${preTrade ? " led by the Risk Engine line" : ""}, with friendly source chips`);
  }
  // Read before the sheet opens: a modal sheet hides the rest of the page from the accessibility tree.
  const concise = await analysisParts(article);
  await press(article.getByRole("button", { name: "View full analysis" }), { tap: run.mobile });
  const sheet = page.getByRole("dialog").last();
  await sheet.waitFor({ state: "visible" });
  const full = await textOf(sheet);
  const complete = await analysisParts(sheet);
  const gaps = fullAnalysisGaps(concise, complete);
  const added = complete.headings.slice(1).filter(heading => !concise.headings.includes(heading));
  s.check(
    gaps.length === 0,
    "View full analysis opens a side sheet with every item of the card in full plus what the card leaves out",
    gaps.join("; ") || `card: ${concise.headings.length - 1} sections, ${concise.items.length} items; sheet: ${complete.headings.length - 1} sections, ${complete.items.length} items${added.length ? ` (also ${added.slice(0, 4).join(", ")})` : ""}`,
  );
  s.check(scanVisibleText(full).length === 0, "the full analysis shows no raw ids either", scanVisibleText(full).map(hit => hit.match).join(", "));
  if (curateKey) await run.curate(`${curateKey}-full`, `${name}: full analysis side sheet with every section and citation`);
  await page.keyboard.press("Escape");
  s.check(await hidden(sheet), "Escape closes the sheet");
  return { text, sources };
}

export default async function ai(run) {
  const { env } = run;
  const user = await run.step("user", "Freshly seeded synthetic user (AI on for FTMO 100K and Personal 12K)", async s => {
    const seeded = await env.users.seeded(`ai-${run.viewport}`);
    s.info(`signed in as ${seeded.email} (seeded for this run)`);
    await run.open(seeded);
    return seeded;
  });
  if (!user) return;
  const page = run.page;
  const trades = user.showcase.trades;
  const accounts = user.showcase.accounts;
  const budget = {};

  await run.step("budget-summary", "AI budget summary per trading account", async s => {
    await goto(page, "/settings?account=all#ai");
    for (const name of ["FTMO 100K", "Personal 12K", "Demo 100K"]) {
      const summary = page.getByRole("region", { name: `AI budget · ${name}` }).first();
      const text = await textOf(summary);
      const parsed = budgetOf(text);
      s.check(parsed, `${name} shows "AI usage this month · € of € · left · resets"`, text.slice(0, 120));
      s.check(/resets [A-Z][a-z]{2} \d+/.test(text), `${name} says when the budget resets`);
      budget[name] = parsed;
    }
    s.check(/\bOff\b/.test(await textOf(page.getByRole("region", { name: "AI budget · Demo 100K" }).first())), "an account without consent shows the Off chip");
    await s.shot("settings-ai");
  });

  await run.step("blocked-draft", "Paid AI is never the default next action on a blocked draft", async s => {
    const since = new Date().toISOString();
    await openTrade(page, trades.todayBlocked);
    s.check((await tradeState(page)) === "Blocked", "the seeded draft is Blocked");
    // Controls are found by role; only their design-system variant (primary or secondary) is read from them.
    const main = page.getByRole("main");
    const controls = await main.getByRole("button").or(main.getByRole("link")).evaluateAll(nodes => nodes
      .filter(node => node.getClientRects().length > 0)
      .map(node => ({ name: (node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim(), primary: node.classList.contains("btn-primary") })));
    const primary = controls.filter(control => control.primary).map(control => control.name);
    s.check(primary.length > 0 && primary.every(label => !/Analy[sz]e|Challenge|Review this trade|≈ €/.test(label)), "no paid AI control uses the primary style", primary.join(" | "));
    s.check(primary.some(label => /Edit draft/.test(label)), "the primary next action is Edit draft", primary.join(" | "));
    const tools = page.getByRole("region", { name: "AI tools" });
    const anyway = tools.getByRole("button", { name: /^Analyze blocked setup anyway · ≈ €/ });
    s.check(await visible(anyway), "the AI tool reads 'Analyze blocked setup anyway · ≈ €…'");
    s.check(await anyway.evaluate(button => button.classList.contains("btn-secondary")), "and it is a secondary button");
    s.check(!(await visible(tools.getByRole("button", { name: /Challenge my bias/ }), 1_000)), "Challenge my bias is not offered on a blocked draft");
    await page.waitForTimeout(1_500);
    s.check(mockCalls("analyze_setup_v1", since).length === 0 && mockCalls("challenge_bias_v1", since).length === 0, "opening the page sent no AI request");
    s.evidence(10, "blocked draft: primary action 'Edit draft'; AI only as secondary 'Analyze blocked setup anyway · ≈ €0.02'; nothing sent on load");
    await s.shot("blocked-draft-ai");
  }, { criteria: [10] });

  // Before a paid pre-trade tool runs, the draft needs a current deterministic check (§8.3).
  // The moments that bracket the draft's current check (what the strategy clock says it had to answer).
  let checkedFrom = Date.now();
  const ready = await run.step("ready-draft", "Prepare a draft for the pre-trade tools: recheck its risk for free", async s => {
    // "Ready to lock" is only shown for a check of the current session, so the page's own moment counts too.
    checkedFrom = Date.now();
    await openTrade(page, trades.todayReady);
    let state = await tradeState(page);
    if (state === "Recheck needed") {
      checkedFrom = Date.now();
      await press(page.getByRole("button", { name: "Recheck risk" }).first(), { tap: run.mobile });
      state = await waitForState(page, ["Ready to lock", "Blocked"], 60_000);
    }
    const plan = await textOf(region(page, "Plan"));
    const window = [checkedFrom, Date.now()];
    const expected = deadPoolExpectation(...window);
    if (state === "Blocked" && plan.includes(DEAD_POOL_SENTENCE)) {
      s.check(expected !== "open", "the Dead Pool block matches the strategy clock (12:00–18:00 UTC−5)", `checked at ${clockSpan(...window)}`);
      s.clock(`Dead Pool (${clockSpan(...window)}): the free recheck blocks the draft until 18:00 UTC−5, so only 'Analyze blocked setup anyway' can run on it`);
      return "blocked";
    }
    s.check(state === "Ready to lock", "the draft is Ready to lock after a free recheck", state);
    s.check(expected !== "blocked", "the Risk Engine does not approve a draft during Dead Pool (12:00–18:00 UTC−5)", `Ready to lock at ${clockSpan(...window)}`);
    return "ready";
  });

  await run.step("analyze-setup", "Analyze Setup with the mock provider", async s => {
    const id = ready === "ready" ? trades.todayReady : trades.todayBlocked;
    await openTrade(page, id);
    const tools = page.getByRole("region", { name: "AI tools" });
    const name = ready === "ready" ? /^Analyze setup · ≈ €/ : /^Analyze blocked setup anyway · ≈ €/;
    const { toast, row, since } = await runAi(s, page, tools, name);
    s.check(/ready/i.test(toast ?? ""), "the analysis completed", row);
    s.check(mockCalls("analyze_setup_v1", since).some(line => /status=200/.test(line)), "the local mock provider answered (no network, no cost)");
    const article = card(tools, "Setup analysis");
    const text = await textOf(article);
    s.check(/Risk Engine · (Approved|Blocked)/.test(text), "the deterministic Risk Engine line leads the card, separate from the AI interpretation", /Risk Engine · [^·]+/.exec(text)?.[0]);
    await inspectCard(s, run, article, { name: "Analyze Setup", curateKey: run.mobile ? null : "ai-analyze-setup" });
  }, { criteria: [16] });

  await run.step("challenge-bias", "Challenge My Bias with the mock provider", async s => {
    if (ready === undefined) s.skip("no draft could be prepared (ready-draft failed)");
    if (ready === "blocked") {
      const window = [checkedFrom, Date.now()];
      s.check(deadPoolExpectation(...window) !== "open", "the strategy clock still explains the block (Dead Pool, 12:00–18:00 UTC−5)", clockSpan(...window));
      await openTrade(page, trades.todayBlocked);
      s.check(!(await visible(page.getByRole("region", { name: "AI tools" }).getByRole("button", { name: /Challenge my bias/ }), 1_000)), "it is withheld while the draft is blocked");
      s.clock(`Dead Pool (${clockSpan(...window)}): Challenge My Bias needs a draft that passes the current risk check; every draft is blocked until 18:00 UTC−5`);
      return;
    }
    await openTrade(page, trades.todayReady);
    const tools = page.getByRole("region", { name: "AI tools" });
    const { toast, row, since } = await runAi(s, page, tools, /^Challenge my bias · ≈ €/);
    s.check(/ready/i.test(toast ?? ""), "the challenge completed", row);
    s.check(mockCalls("challenge_bias_v1", since).some(line => /status=200/.test(line)), "the local mock provider answered");
    await inspectCard(s, run, card(tools, "Bias challenge"), { name: "Challenge My Bias", curateKey: run.mobile ? null : "ai-challenge-bias" });
  }, { criteria: [16] });

  await run.step("review-trade", "Review Trade (timeline-aware) on a closed trade", async s => {
    await openTrade(page, trades.todayClosed);
    const panel = page.getByRole("region", { name: "AI review" });
    // Select one screenshot for the review (the evidence gallery's "Use … for AI" checkboxes).
    const box = region(page, "Evidence").getByRole("checkbox", { name: /for AI$/ }).first();
    if (await box.count()) {
      const label = box.locator("xpath=ancestor::label[1]");
      if (await label.count()) await press(label, { tap: run.mobile });
      else await box.check({ force: true });
      s.info(`selected for the review: ${await box.getAttribute("aria-label") ?? "one screenshot"}`);
    }
    const { toast, row, since } = await runAi(s, page, panel, /^Review this trade · ≈ €/);
    s.check(/ready/i.test(toast ?? ""), "the review completed", row);
    s.check(mockCalls("review_trade_timeline_v1", since).some(line => /status=200/.test(line)), "the timeline review contract was used (review_trade_timeline_v1)");
    const article = card(panel, "Trade review");
    const { text } = await inspectCard(s, run, article, { name: "Review Trade", curateKey: "ai-review-trade" });
    s.check(/Thesis|Execution|Live management|lesson/i.test(text), "the card summarises the timeline review (thesis, execution vs plan, live management, lesson)");
    s.evidence(16, "Review Trade: concise card; full analysis in a sheet");
  }, { criteria: [16] });

  const periodic = async (s, kind, url, buttonName, schema) => {
    await goto(page, url);
    const panel = page.getByRole("region", { name: kind }).first();
    s.check(await visible(panel), `the ${kind} panel is shown`);
    const scope = await textOf(panel.locator("p").first());
    s.info(`scope: ${scope}`);
    s.check(/Live-first and imported trades are not yet included in periodic AI reviews\./.test(await textOf(panel)), "the panel states which trades are included");
    const { toast, row, since } = await runAi(s, page, panel, buttonName);
    s.check(/ready/i.test(toast ?? ""), `the ${kind} completed`, row);
    s.check(mockCalls(schema, since).some(line => /status=200/.test(line)), `the local mock provider answered (${schema})`);
    const article = panel.getByRole("article").first();
    const text = await textOf(article);
    s.check(/From Trading OS/.test(text) && /Sample/.test(text), "deterministic facts (sample, net R) come from Trading OS, not from the AI", /Sample[^A-Z]*/.exec(text)?.[0]);
    return { article, scope };
  };

  await run.step("weekly", "Weekly Review of a recent week (FTMO 100K)", async s => {
    await goto(page, `/review/weekly?reviewAccount=${accounts.ftmo}`);
    const chosen = await choosePeriod(page, page.getByRole("combobox", { name: "Week" }), /· [12] trades?$/, "week");
    s.info(`week chosen: ${chosen}`);
    const { article } = await periodic(s, "Weekly review", page.url().replace(env.base, ""), /^Review week of .+ · ≈ €/, "weekly_review_v1");
    await inspectCard(s, run, article, { name: "Weekly Review", curateKey: run.mobile ? null : "review-weekly", where: "Review workspace" });
  }, { criteria: [16] });

  await run.step("recent", "Recent Trades analysis of the last 10 trades (FTMO 100K)", async s => {
    const { article } = await periodic(s, "Recent trades analysis", `/review/recent?reviewAccount=${accounts.ftmo}&sample=10`, /^Analyze last 10 trades · ≈ €/, "recent_trades_v1");
    await inspectCard(s, run, article, { name: "Recent Trades", curateKey: null });
  }, { criteria: [16] });

  await run.step("monthly", "Monthly Review (FTMO 100K)", async s => {
    const { article } = await periodic(s, "Monthly review", `/review/monthly?reviewAccount=${accounts.ftmo}`, /^Review .+ · ≈ €/, "monthly_review_v1");
    await inspectCard(s, run, article, { name: "Monthly Review", curateKey: null });
  }, { criteria: [16] });

  await run.step("history-and-budget", "AI history lists every request; the budget summary reflects the usage", async s => {
    await goto(page, `/review/history?reviewAccount=${accounts.ftmo}`);
    const history = await textOf(page.getByRole("main"));
    // Newest first: this run's three periodic requests on FTMO 100K lead the list as compact "Operation · Status · time" rows.
    const rows = [...history.matchAll(/(Analyze Setup|Challenge My Bias|Trade Review|Weekly Review|Recent Trades Analysis|Monthly Review) · (Completed|Failed|In progress) · \d{1,2}:\d{2}/g)].map(match => match[0]);
    const newest = rows.slice(0, 3).map(row => row.replace(/ · \d{1,2}:\d{2}$/, ""));
    s.check(newest.join(" | ") === "Monthly Review · Completed | Recent Trades Analysis · Completed | Weekly Review · Completed", "the Review history lists this run's Monthly, Recent Trades and Weekly reviews first, as compact rows", rows.slice(0, 4).join(" | "));
    s.check(rows.some(row => row.startsWith("Trade Review · Completed")), "trade reviews are listed too");
    s.check(scanVisibleText(history).length === 0, "history rows show no raw ids, codes or JSON by default");
    await goto(page, "/settings?account=all#ai");
    const after = budgetOf(await textOf(page.getByRole("region", { name: "AI budget · FTMO 100K" }).first()));
    s.check(after && budget["FTMO 100K"] && after.used > budget["FTMO 100K"].used, "FTMO 100K's usage this month grew with the settled mock requests", `${budget["FTMO 100K"]?.text} → ${after?.text}`);
    await s.shot("budget-after");
  });

  await run.step("failure-accounting", "A provider failure (mock HTTP 500) is reported with honest accounting", async s => {
    let original = null;
    try {
      original = fs.readFileSync(SCENARIO_FILE, "utf8");
    } catch {
      original = null;
    }
    await goto(page, `/review/weekly?reviewAccount=${accounts.personal}`);
    const chosen = await choosePeriod(page, page.getByRole("combobox", { name: "Week" }), /· [12] trades?$/, "week");
    s.info(`week chosen: ${chosen}`);
    const panel = page.getByRole("region", { name: "Weekly review" }).first();
    const written = `${JSON.stringify({ weekly_review_v1: "http_500" })}\n`;
    let result;
    try {
      fs.writeFileSync(SCENARIO_FILE, written);
      result = await runAi(s, page, panel, /^Review week of .+ · ≈ €/);
    } finally {
      const current = fs.existsSync(SCENARIO_FILE) ? fs.readFileSync(SCENARIO_FILE, "utf8") : null;
      if (current === written) {
        if (original === null) fs.rmSync(SCENARIO_FILE, { force: true });
        else fs.writeFileSync(SCENARIO_FILE, original);
        s.info(`scenario file restored (${original === null ? "removed again; it did not exist before" : "original content written back"})`);
      } else {
        s.info("the scenario file was changed by someone else meanwhile; it was left as found");
      }
    }
    s.check(/failed/i.test(result.toast ?? ""), "the request is reported as failed", result.toast);
    s.check(mockCalls("weekly_review_v1", result.since).some(line => /scenario=http_500/.test(line)), "the mock answered with the http_500 scenario");
    const text = await textOf(panel);
    s.check(/usage could not be confirmed|held for review|stays held/i.test(text), "the failure says the provider's usage could not be confirmed and the reserved amount stays held", text.match(/[^.]*(?:could not be confirmed|held)[^.]*\./i)?.[0]);
    await panel.getByRole("list", { name: /history/i }).first().scrollIntoViewIfNeeded().catch(() => {});
    await s.shot("failure-card");
    await goto(page, "/settings?account=all#ai");
    const summary = await textOf(page.getByRole("region", { name: "AI budget · Personal 12K" }).first());
    s.check(/Paused — needs review/.test(summary), "Personal 12K's budget chip says 'Paused — needs review' until the held amount is resolved", summary.slice(0, 160));
    await s.shot("failure-accounting");
    if (!run.mobile) await run.curate("ai-failure-accounting", "AI failure: held reservation reported honestly; the account's AI pauses for review");
  });
}
