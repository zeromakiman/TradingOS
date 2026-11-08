// LIVE-FIRST workflow (master specification §64; docs/V2_ARCHITECTURE.md §8.2, §5.3): record a position that is
// already open with the minimal fields, see that no pre-trade plan exists, journal a timestamped note, a screenshot and
// a management decision while live, close with the net P&L the platform reports (price math is impossible without a
// size), explain the trade after close, and check that the explanation is labelled After close and never Before entry.
import { createAccountViaApi } from "../fixtures.mjs";
import { addJournalEntry, arrive, composer, dropImage, fill, goto, main, pickImage, press, region, selectByLabel, textOf, timelineBands, tradeIdOf, until, visible, waitForText } from "../ui.mjs";
import { aboveTheFold, chartFor, evidenceCount, openRecordLive, openTrade, pick, tradeState, waitForState } from "./common.mjs";

const ACCOUNT = "Acceptance Live 25K";
const NO_PLAN_BANNER = "No pre-trade plan was recorded before execution.";
const AFTER_CLOSE_NOTE = "After close: I took profit early because the New York open was minutes away.";
/** Caption of a tags form without unsaved changes (tags-form.tsx). */
const SAVED_TAGS_CAPTION = "Saved tags filter the Journal and EDGE.";

export default async function liveFirst(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Fresh synthetic user with one trading account", async s => {
    const created = await env.users.empty(`live-${run.viewport}`);
    const accountId = await createAccountViaApi(env.stack, created, { name: ACCOUNT, currency: "USD", accountType: "PERSONAL", platform: "MANUAL", balance: "25000", equity: "25000" });
    s.info(`${created.email} with ${ACCOUNT} (created through create_trading_account as the user)`);
    run.state.accountId = accountId;
    await run.open(created);
    return created;
  });
  if (!user) return;
  const page = run.page;

  const tradeId = await run.step("record", "Record Live Trade with the minimal fields (account, instrument, direction, entry price)", async s => {
    await goto(page, "/today");
    await openRecordLive(run);
    const form = page.getByRole("form", { name: "Record live trade" });
    await form.waitFor({ state: "visible" });
    await selectByLabel(form.getByRole("combobox", { name: "Trading account" }), new RegExp(`^${ACCOUNT}`));
    const instrument = form.getByRole("combobox", { name: "Instrument" });
    await until(async () => !(await instrument.isDisabled()), { timeout: 10_000 });
    await selectByLabel(instrument, "EURUSD");
    await pick(run, form.getByRole("group", { name: /Direction/ }), "Short");
    await fill(form.getByRole("textbox", { name: "Entry price" }), "1.10250");
    const required = await form.evaluate(el => [...el.querySelectorAll("[required], [aria-required='true']")].map(field => field.getAttribute("aria-label") ?? field.labels?.[0]?.textContent?.trim() ?? field.name).filter(Boolean));
    s.info(`fields marked required: ${required.join(", ") || "none beyond the account, instrument and direction"}`);
    await s.shot("record-live-form");
    if (run.mobile) await run.curate("record-live-trade", "Record Live Trade on a phone: the minimal live-first form", { full: true });
    await press(form.getByRole("button", { name: "Start live journal" }), { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null, { timeout: 90_000 });
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const state = await waitForState(page, ["Live"], 60_000);
    s.check(state === "Live", "the trade opens Live", state);
    const focused = await until(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("placeholder") ?? ""), { timeout: 10_000 });
    s.check(/journal/i.test(focused ?? ""), "the journal composer is focused for the first note", focused);
    s.evidence(8, "recorded with account, instrument, direction and entry price only (size, stop, risk and model optional)");
    return tradeIdOf(page.url());
  }, { requires: ["user"], criteria: [8] });
  if (!tradeId) return;

  await run.step("no-plan", "The trade says no pre-trade plan was recorded", async s => {
    const header = await textOf(main(page));
    s.check(header.includes(NO_PLAN_BANNER), "the banner says the exact required sentence", NO_PLAN_BANNER);
    s.check(/No pre-trade plan recorded/.test(await textOf(region(page, "Execution"))), "Execution says 'No pre-trade plan recorded' instead of planned values");
    s.check(/Live-first/.test(header), "the origin badge says Live-first");
    s.check(!(await visible(page.getByRole("list", { name: "Trade progress" }), 1_000)), "no planned-trade stepper is shown");
    s.check(!(await visible(page.getByRole("button", { name: /Analyze setup|Challenge my bias/ }), 1_000)), "no pre-trade AI tools are offered on a live-first trade");
    s.check(await aboveTheFold(page, page.getByRole("link", { name: "Add to journal" }).first()), "'Add to journal' is the visible next action of a live trade");
    await s.shot("live-first-open");
    if (!run.mobile) await run.curate("trade-live-first", "Live-first trade: no pre-trade plan banner, live journal and close form");
  }, { requires: ["record"] });

  await run.step("note", "Add a timestamped note while live", async s => {
    const before = page.url();
    const { announced } = await addJournalEntry(page, { kind: "Note", body: "Short from the London high sweep; watching the M5 fair value gap.", tap });
    s.check(announced, "the note is added", announced);
    const live = (await timelineBands(page))["While live"] ?? [];
    const item = live.find(entry => /London high sweep/.test(entry));
    s.check(item, "the note is in the While live band");
    s.check(/\b\d{1,2}:\d{2}\b/.test(item ?? ""), "it shows the time it was recorded", item);
    s.check(page.url() === before, "the page did not change");
    s.evidence(2, "live-first note added in place on the trade page");
    if (run.mobile) s.evidence(18, "phone viewport with touch: the note was typed and submitted with taps only (no hover)");
    await s.shot("note");
  }, { requires: ["record"], criteria: run.mobile ? [2, 18] : [2] });

  await run.step("screenshot", run.mobile ? "Take a photo of the chart with the phone camera button of the journal composer" : "Drop a live screenshot onto the journal composer", async s => {
    const form = composer(page);
    const count = (await evidenceCount(page)) ?? 0;
    const image = await chartFor(run, "live-first-shot", "MANAGE", { direction: "SHORT", entry: 110_250, stop: 110_450, target: 109_650 });
    if (run.mobile) {
      // Phones get "Take photo" (the camera input) next to "Attach screenshots"; the picker answers with the image.
      const picked = await pickImage(page, form.getByRole("button", { name: "Take photo" }), image, "live-first-photo.png", { tap });
      s.check(picked.handled && !picked.multiple, "'Take photo' opens the camera picker for one image");
    } else {
      const accepted = await dropImage(form, image, "live-first-drop.png");
      s.check(accepted, "the composer accepted the dropped image");
    }
    await until(async () => (await form.locator("img").count()) > 0, { timeout: 10_000 });
    await fill(form.getByRole("textbox", { name: "Journal entry" }), "M5 holding below the gap.");
    await press(form.getByRole("button", { name: "Add to journal" }), { tap });
    const done = await waitForText(form, /1 screenshot saved/i, 60_000);
    s.check(done, "the screenshot is saved with the entry", done);
    const saved = await until(async () => ((await evidenceCount(page)) ?? 0) > count, { timeout: 30_000 });
    s.check(saved && (await evidenceCount(page)) === count + 1, "Evidence counts exactly one new screenshot (captured once)", `${count} → ${await evidenceCount(page)}`);
    const live = ((await timelineBands(page))["While live"] ?? []).join(" | ");
    s.check(/screenshot added/i.test(live), "the screenshot is in the While live band");
    if (run.mobile) s.evidence(18, "phone: a chart photo was added to the live journal with the composer's 'Take photo' button and a tap on 'Add to journal'");
    else s.evidence(4, "a file dropped onto the live journal composer was saved as While live evidence");
  }, { requires: ["record"], criteria: run.mobile ? [18] : [4] });

  await run.step("decision", "Record a management decision", async s => {
    const { announced } = await addJournalEntry(page, { kind: "Decision", body: "Decision: hold; the stop stays above the sweep high.", tap });
    s.check(announced, "the decision is added", announced);
    const live = ((await timelineBands(page))["While live"] ?? []).join(" | ");
    s.check(/Decision/.test(live) && /stop stays above the sweep high/.test(live), "the decision is listed While live with its kind");
  }, { requires: ["record"] });

  await run.step("close", "Close with the net P&L the platform reports (no size recorded, so P&L can't be calculated)", async s => {
    const form = page.getByRole("form", { name: "Close trade" });
    await form.waitFor({ state: "visible" });
    const text = await textOf(form);
    s.check(/P&L can't be calculated/.test(text), "the form explains why it asks for the net P&L", text.slice(0, 140));
    await pick(run, form.getByRole("group", { name: "Result" }), "Profit");
    await fill(form.getByRole("textbox", { name: /Net profit/ }), "42.50");
    await fill(form.getByRole("textbox", { name: /exit price/i }), "1.10050");
    await press(form.getByRole("button", { name: "Close trade" }), { tap });
    // The close can't be changed later (spec §57): the button opens a confirmation with the reported result first.
    const confirm = page.getByRole("alertdialog", { name: "Close this trade?" });
    s.check(await visible(confirm, 15_000), "Close trade opens the confirmation");
    const summary = (await textOf(confirm)).replace(/\s+/g, " ");
    s.check(/Win/.test(summary) && /\+\$42\.50/.test(summary) && /1\.10050/.test(summary), "the confirmation shows the reported +$42.50 (Win) and the exit before anything is recorded", summary.slice(0, 220));
    await press(confirm.getByRole("button", { name: "Close trade" }), { tap });
    const state = await waitForState(page, ["Closed · review pending"], 60_000);
    s.check(state === "Closed · review pending", "the trade is closed", state);
    const result = await textOf(region(page, "Result"));
    s.check(/\+\$42\.50/.test(result), "the result shows the reported +$42.50", result.slice(0, 160));
    s.info(`result: ${result.slice(0, 200)}`);
  }, { requires: ["record"] });

  await run.step("after-close-note", "Explain the trade after close", async s => {
    const { announced } = await addJournalEntry(page, { kind: "Note", body: AFTER_CLOSE_NOTE, tap });
    s.check(announced, "the explanation is added", announced);
  }, { requires: ["close"] });

  await run.step("not-pre-entry", "The post-trade note is labelled After close and never appears as Before entry evidence", async s => {
    // A fresh load from the server: what is stored, not what the page kept from adding the note.
    await goto(page, new URL(page.url()).pathname);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const bands = await timelineBands(page);
    const after = (bands["After close"] ?? []).join(" | ");
    s.check(after.includes(AFTER_CLOSE_NOTE.slice(0, 40)), "the explanation is in the After close band");
    s.check(!("Before entry" in bands), "a live-first trade has no Before entry band at all", Object.keys(bands).join(", "));
    s.check(!((bands["While live"] ?? []).join(" ").includes(AFTER_CLOSE_NOTE.slice(0, 40))), "it is not listed While live either");
    const evidence = await textOf(region(page, "Evidence"));
    s.check(!/Before entry/.test(evidence), "Evidence has no Before entry group", evidence.slice(0, 120));
    s.evidence(9, "live-first: the after-close note is only under After close; no Before entry band or evidence exists");
  }, { requires: ["after-close-note"], criteria: [9] });

  await run.step("timeline", "Review the timeline and mark the trade reviewed with a grade picked but not saved", async s => {
    const bands = await timelineBands(page);
    s.check(Object.keys(bands).join(",") === "While live,After close", "the bands read While live → After close", Object.keys(bands).join(", "));
    s.check(/Trade opened/.test((bands["While live"] ?? [])[0] ?? ""), "While live starts with the entry");
    s.check(/Trade closed/.test((bands["After close"] ?? [])[0] ?? ""), "After close starts with the close");
    // Unsaved tags are never dropped: with a grade picked and not saved, Mark reviewed says it saves the tags first.
    const review = region(page, "Review");
    const tags = review.getByRole("form", { name: "Tags" });
    await pick(run, tags.getByRole("group", { name: "Setup grade" }), "B");
    await press(review.getByRole("button", { name: "Save tags and mark reviewed", exact: true }), { tap });
    const state = await waitForState(page, ["Reviewed"], 60_000);
    s.check(state === "Reviewed", "the trade is Reviewed", state);
    // The form reads saved and takes changes again. A disabled Save tags alone would also pass for a form the review left
    // locked (Save tags is disabled while locked too), so the saved caption, an enabled grade and an editable tag field
    // are required as well.
    const settled = await until(async () => !(await tags.getByRole("button", { name: "Save tags", exact: true }).isEnabled())
      && (await tags.getByText(SAVED_TAGS_CAPTION, { exact: true }).isVisible())
      && (await tags.getByRole("radio", { name: "A", exact: true }).isEnabled())
      && (await tags.getByRole("textbox", { name: "Custom tags" }).isEditable()), { timeout: 15_000 });
    s.check(settled, "after the review the tags form reads saved and takes changes again");
    // Stored, not only kept on this page: a fresh load from the server still shows B as the setup grade.
    await openTrade(page, tradeId);
    const stored = region(page, "Review").getByRole("form", { name: "Tags" });
    const kept = await until(() => stored.getByRole("radio", { name: "B", exact: true }).isChecked(), { timeout: 15_000 });
    s.check(kept && (await tradeState(page)) === "Reviewed", "the grade picked before Mark reviewed was saved with the review (still B after a reload)");
    s.evidence(15, "live-first trade recorded, journaled, closed and reviewed through labelled controls only");
    await s.shot("timeline", { full: true });
    if (run.mobile) {
      // The documentation image: the journal's timeline on one phone screen, from the While live band down.
      await region(page, "Journal").locator("h3").filter({ hasText: /^While live/ }).first().evaluate(heading => {
        heading.scrollIntoView({ block: "start" });
        window.scrollBy(0, -72);
      }).catch(() => {});
      await run.curate("mobile-live-first-timeline", "Phone: live-first trade timeline (While live · After close)");
    }
  }, { requires: ["close"], criteria: [15] });
}
