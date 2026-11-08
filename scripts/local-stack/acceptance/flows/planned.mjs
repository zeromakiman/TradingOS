// PLANNED workflow (master specification §64; docs/V2_ARCHITECTURE.md §8.1): create a trading account from first-run
// onboarding, plan a trade, read the exact BLOCKED reason, correct it in a new revision of the same draft, add
// screenshots (Ctrl+V and a drop on the desktop; the picker and the camera button on a phone), lock, prove the locked
// plan is immutable (in the UI and against the database's own RPCs), record the entry, journal a live note with a
// screenshot without leaving the trade, close, write a lesson after close and review.
// Locks use the real clock: during Dead Pool (12:00–18:00 UTC−5) the Risk Engine refuses them. Every Dead Pool answer of
// the app is checked against the strategy clock first (a block outside Dead Pool, or an approval or lock inside it,
// fails); a refusal the clock explains is recorded as clock-limited, and the steps after the lock continue on the
// locked plan of a freshly seeded user.
import { randomUUID } from "node:crypto";
import { sqlValue } from "../../lib.mjs";
import { passwordGrant, userRpc } from "../fixtures.mjs";
import { clockSpan, deadPoolExpectation, screenOf } from "../rules.mjs";
import {
  addJournalEntry, arrive, dropImage, fill, goto, hidden, main, pasteImage, pickImage, press, region, selectByLabel, settle, textOf, timelineBands, tradeIdOf, until, visible,
  waitForText,
} from "../ui.mjs";
import { aboveTheFold, chartFor, evidenceCount, mockCalls, openPlanTrade, openTrade, pick, tradeState, waitForState } from "./common.mjs";

const ACCOUNT = { name: "Acceptance 50K", balance: "50000" };
const THESIS = "London swept the Asia low; an M5 shift with displacement left a bullish order block. Invalidation: an M5 close below 1.09800.";
const RISK_SENTENCE = "Requested risk 1.00% exceeds your configured maximum of 0.50%.";
const DEAD_POOL_SENTENCE = "Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function planned(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Fresh synthetic user without any data", async s => {
    const created = await env.users.empty(`planned-${run.viewport}`);
    s.info(`signed in as ${created.email} (created for this run)`);
    await run.open(created);
    return created;
  });
  if (!user) return;
  const page = run.page;
  // The user whose plan the immutability steps work on (the seeded user's when the new draft could not be locked).
  run.state.owner = user;

  await run.step("onboarding", "Create a Trading Account from first-run onboarding", async s => {
    await goto(page, "/today");
    const card = region(page, "Create your first trading account");
    s.check(await visible(card), "Today offers 'Create your first trading account' to a user without accounts");
    const form = card.getByRole("form", { name: "Create trading account" });
    await fill(form.getByRole("textbox", { name: "Account name" }), ACCOUNT.name);
    await selectByLabel(form.getByRole("combobox", { name: "Account type" }), "Evaluation");
    await selectByLabel(form.getByRole("combobox", { name: "Currency" }), /^USD/);
    await fill(form.getByRole("textbox", { name: "Broker or prop firm (optional)" }), "Acceptance Prop");
    await fill(form.getByRole("textbox", { name: "Current balance" }), ACCOUNT.balance);
    await s.shot("onboarding-form");
    await press(form.getByRole("button", { name: "Create trading account" }), { tap });
    const status = await waitForText(main(page), new RegExp(`${ACCOUNT.name}[\\s\\S]*(You can trade|Trading blocked|Trades left)`), 60_000);
    s.check(status, "Today shows the new account's trading status", status?.slice(0, 160));
    s.check(await hidden(region(page, "Create your first trading account")), "the onboarding card is gone once an account exists");
    await s.shot("today-with-account");
  });

  await run.step("plan-blocked", "Plan Trade: select risk above the maximum and read the deterministic preview", async s => {
    await openPlanTrade(run);
    const form = page.getByRole("form", { name: "Plan trade" });
    await form.waitFor({ state: "visible" });
    const account = form.getByRole("combobox", { name: "Trading account" });
    const selected = await account.evaluate(select => select.selectedOptions[0]?.textContent?.trim() ?? "");
    s.check(selected.startsWith(ACCOUNT.name), "the form names the trading account explicitly", selected);
    s.check(!/all accounts/i.test(await account.innerText()), "All Accounts is not offered as an account to plan in");
    s.evidence(17, `account and currency are pre-filled from the only account (${selected}); the contract and risk plan come from it`);
    await selectByLabel(form.getByRole("combobox", { name: "Instrument" }), "EURUSD");
    await pick(run, form, "Long");
    await pick(run, form, "OB first touch");
    await fill(form.getByRole("textbox", { name: "Entry" }), "1.10000");
    await fill(form.getByRole("textbox", { name: "Stop loss" }), "1.09800");
    await fill(form.getByRole("textbox", { name: "Target" }), "1.10700");
    const risk = form.getByRole("group", { name: "Risk per trade" });
    s.info(`risk presets offered: ${(await risk.innerText()).replace(/\s+/g, " ").trim()}`);
    await pick(run, risk, "Custom");
    await fill(form.getByRole("textbox", { name: "Custom risk" }), "1");
    await fill(form.getByRole("textbox", { name: "Thesis" }), THESIS);
    await pick(run, form, "Checked · clear");
    const contract = form.getByRole("checkbox", { name: "Contract values match my broker" });
    if (!(await contract.isChecked())) await press(contract.locator("xpath=ancestor::label[1]"), { tap });
    const preview = page.getByRole("region", { name: "Risk check preview" });
    const verdict = await waitForText(preview, /Blocked/, 20_000);
    s.check(verdict, "the live deterministic preview says Blocked before anything is saved");
    s.check(verdict.includes(RISK_SENTENCE), "the preview states the exact reason", RISK_SENTENCE);
    s.info(`preview: ${verdict.slice(0, 220)}`);
  }, { requires: ["onboarding"], criteria: [17] });

  const shots = page.getByRole("region", { name: "Screenshots" });
  const staged = () => shots.locator("img").count();
  if (!run.mobile) {
    await run.step("paste-screenshot", "Paste a chart screenshot with Ctrl+V into the plan", async s => {
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      const result = await pasteImage(page, await chartFor(run, "plan-paste", "SETUP"), "plan-paste.png");
      s.check(result.handled, "the page took the pasted image (paste event consumed)", result.target);
      s.check(await until(async () => (await staged()) >= 1, { timeout: 10_000 }), "the pasted image is staged with a preview in Screenshots");
      s.evidence(3, "Ctrl+V on Plan Trade staged the pasted PNG (preview shown) and it was saved with the draft");
    }, { requires: ["plan-blocked"], criteria: [3] });

    await run.step("drop-screenshot", "Drag and drop a second screenshot onto the plan", async s => {
      const zone = shots.getByText(/drop images here/i);
      const before = await staged();
      const accepted = await dropImage(zone, await chartFor(run, "plan-drop", "HTF", { timeframe: "H4" }), "plan-drop.png");
      s.check(accepted, "the drop zone accepted the dropped file");
      s.check(await until(async () => (await staged()) > before, { timeout: 10_000 }), "the dropped image is staged next to the pasted one");
      await s.shot("plan-form-blocked", { full: true });
      await run.curate("plan-trade-blocked", "Plan Trade: live risk preview blocked with the exact reason, two staged screenshots", { full: false });
      s.evidence(4, "a DataTransfer drop onto Plan Trade staged the image, saved with the draft");
    }, { requires: ["plan-blocked"], criteria: [4] });
  } else {
    // A phone has neither Ctrl+V nor a drag source: it adds screenshots through the system picker and the camera.
    await run.step("choose-screenshot", "Add a chart screenshot to the plan with 'Choose files' (the phone's picker)", async s => {
      const before = await staged();
      const picked = await pickImage(page, shots.getByRole("button", { name: "Choose files" }), await chartFor(run, "plan-pick", "SETUP"), "plan-pick.png", { tap });
      s.check(picked.handled && picked.multiple, "'Choose files' opens the system picker for several images");
      s.check(await until(async () => (await staged()) > before, { timeout: 10_000 }), "the chosen image is staged with a preview in Screenshots");
    }, { requires: ["plan-blocked"] });

    await run.step("photo-screenshot", "Take a photo of the chart for the plan with 'Take photo' (the phone's camera)", async s => {
      const before = await staged();
      const camera = shots.getByRole("button", { name: "Take photo" });
      s.check(await visible(camera, 5_000), "a touch screen offers 'Take photo' next to 'Choose files'");
      const picked = await pickImage(page, camera, await chartFor(run, "plan-photo", "HTF", { timeframe: "H4" }), "plan-photo.png", { tap });
      s.check(picked.handled && !picked.multiple, "'Take photo' opens the camera picker for one image");
      s.check(await until(async () => (await staged()) > before, { timeout: 10_000 }), "the photo is staged next to the chosen image");
      await s.shot("plan-form-blocked", { full: true });
      await run.curate("plan-trade-blocked", "Plan Trade on a phone: live risk preview blocked with the exact reason, two staged screenshots", { full: false });
    }, { requires: ["plan-blocked"] });
  }

  const tradeId = await run.step("save-blocked", "Save the draft: the free server check blocks it and the reason is in the primary UI", async s => {
    await press(page.getByRole("button", { name: "Save draft" }), { tap });
    await arrive(page, url => tradeIdOf(url.href) !== null && !url.pathname.endsWith("/edit"), { timeout: 90_000 });
    const id = tradeIdOf(page.url());
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const state = await waitForState(page, ["Blocked", "Draft"], 60_000);
    s.check(state === "Blocked", "the trade opens as Blocked", state);
    const plan = region(page, "Plan");
    const reason = await waitForText(plan, new RegExp(RISK_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 20_000);
    s.check(reason, "the Plan section shows the exact blocking sentence without opening anything", RISK_SENTENCE);
    const nextAction = page.getByRole("link", { name: "Edit draft" }).first();
    s.check(await aboveTheFold(page, nextAction), "the next action 'Edit draft' is visible without scrolling");
    s.evidence(1, "Blocked draft: 'Edit draft' is the next action, visible in the first viewport");
    s.evidence(6, `exact reason in the Plan section: "${RISK_SENTENCE}"`);
    const count = await until(async () => ((await evidenceCount(page)) ?? 0) >= 2 ? evidenceCount(page) : null, { timeout: 30_000 });
    s.check(count === 2, "both staged screenshots were saved with the draft", `${count} of 24`);
    const evidence = await textOf(region(page, "Evidence"));
    s.check(/Before entry/.test(evidence), "they are pre-entry evidence (Before entry)");
    // A new account starts with AI off (consent first). Criterion 10 is judged by the AI flow, where AI is on.
    const tools = page.getByRole("region", { name: "AI tools" });
    const paid = await tools.getByRole("button", { name: /≈ €/ }).count();
    s.check(/AI is off for this trading account/.test(await textOf(tools)) && paid === 0, "AI starts off for a new account: the AI panel offers no paid tool, only the way to Settings → AI", (await textOf(tools)).slice(0, 160));
    await s.shot("draft-blocked");
    await run.curate("trade-draft-blocked", "Trade workspace: blocked draft with the exact reason and Edit draft as the next action");
    return id;
  }, { requires: ["plan-blocked"], criteria: [1, 6] });
  if (!tradeId) return;
  run.state.tradeId = tradeId;

  await run.step("edit-draft", "Edit the draft: lower the risk and save revision 2 of the same trade", async s => {
    await press(page.getByRole("link", { name: "Edit draft" }).first(), { tap });
    await arrive(page, url => url.pathname === `/trades/${tradeId}/edit`);
    const form = page.getByRole("form", { name: "Edit draft" });
    await form.waitFor({ state: "visible" });
    s.check(/Revision 1 → 2/.test(await textOf(main(page))), "the editor announces 'Revision 1 → 2'");
    await pick(run, form.getByRole("group", { name: "Risk per trade" }), "0.50%");
    const preview = page.getByRole("region", { name: "Risk check preview" });
    const updated = await until(async () => {
      const text = await textOf(preview);
      return text.includes(RISK_SENTENCE) ? null : text;
    }, { timeout: 15_000 });
    s.check(updated, "the preview no longer reports the risk reason after selecting 0.50%");
    // Wide screens save from the preview card ("Save revision 2"), phones from the action bar under the form.
    const save = page.getByRole("button", { name: /^Save revision( 2)?$/ });
    s.info(`save control: "${await textOf(save)}"`);
    // Revision 2 is checked by the server between this moment and the next step's reading (the Dead Pool window).
    run.state.revisionSavedAt = Date.now();
    await press(save, { tap });
    await arrive(page, url => url.pathname === `/trades/${tradeId}`, { timeout: 90_000 });
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    const header = await textOf(main(page));
    s.check(/Revision 2/.test(header), "the same trade now shows revision 2", tradeIdOf(page.url()));
    s.evidence(5, "edited the blocked draft in place: same trade id, revision 1 → 2, history keeps revision 1");
  }, { requires: ["save-blocked"], criteria: [5] });

  await run.step("ready", "Revision 2 passes the deterministic check: Ready to lock", async s => {
    const state = await waitForState(page, ["Ready to lock", "Blocked", "Recheck needed", "Draft"], 60_000);
    const plan = await textOf(region(page, "Plan"));
    // The strategy clock decides what the Risk Engine had to answer for revision 2, whatever the page shows.
    const checked = [run.state.revisionSavedAt ?? Date.now(), Date.now()];
    const expected = deadPoolExpectation(...checked);
    if (state === "Blocked" && plan.includes(DEAD_POOL_SENTENCE) && !plan.includes(RISK_SENTENCE)) {
      s.check(true, "the risk reason is resolved; the only remaining block is Dead Pool", DEAD_POOL_SENTENCE);
      s.check(expected !== "open", "the Dead Pool block matches the strategy clock (12:00–18:00 UTC−5)", `revision 2 checked at ${clockSpan(...checked)}`);
      s.clock(`Dead Pool: the Risk Engine blocks every lock until 18:00 UTC−5 ("${DEAD_POOL_SENTENCE}"; checked at ${clockSpan(...checked)})`);
      await s.shot("revision2-dead-pool");
      return;
    }
    if (state === "Recheck needed" && expected === "either") {
      // The session changed between the save and this reading, so the approval is no longer current.
      s.clock(`the strategy session changed (12:00 or 18:00 UTC−5) while revision 2 was checked (${clockSpan(...checked)}): it needs a recheck`);
      return;
    }
    s.check(state === "Ready to lock", "revision 2 is Ready to lock", state);
    s.check(expected !== "blocked", "the Risk Engine does not approve a plan during Dead Pool (12:00–18:00 UTC−5)", `Ready to lock, checked at ${clockSpan(...checked)}`);
    const lock = page.getByRole("button", { name: "Lock plan" }).first();
    s.check(await aboveTheFold(page, lock), "'Lock plan' is the visible next action");
    s.evidence(1, "Ready to lock: 'Lock plan' is the next action in the header");
    await s.shot("ready-to-lock");
  }, { requires: ["edit-draft"], criteria: [1] });

  await run.step("analyze-ready", "Optional AI before the lock: consent for the account, then Analyze Setup on the ready draft (local mock)", async s => {
    // AI starts off for a new account: Settings → AI asks for explicit consent first.
    await goto(page, "/settings?account=all#ai");
    await press(page.getByRole("button", { name: `Turn on AI… for ${ACCOUNT.name}` }), { tap });
    const dialog = page.getByRole("dialog", { name: `Turn on AI for ${ACCOUNT.name}?` });
    await dialog.waitFor({ state: "visible" });
    await press(dialog.getByRole("checkbox", { name: /I understand and consent/ }).locator("xpath=ancestor::label[1]"), { tap });
    await press(dialog.getByRole("button", { name: "Turn on AI", exact: true }), { tap });
    await dialog.waitFor({ state: "detached", timeout: 30_000 });
    const budget = page.getByRole("region", { name: `AI budget · ${ACCOUNT.name}` }).first();
    s.check(await until(async () => /\bOn\b/.test(await textOf(budget)), { timeout: 20_000 }), "AI is on for the account after explicit consent", (await textOf(budget)).slice(0, 100));
    await openTrade(page, tradeId);
    s.check((await tradeState(page)) === "Ready to lock", "the draft is still Ready to lock");
    const tools = page.getByRole("region", { name: "AI tools" });
    const analyze = tools.getByRole("button", { name: /^Analyze setup · ≈ €\d+\.\d{2}$/ });
    s.check(await visible(analyze, 15_000), "'Analyze setup · ≈ €…' is offered next to the Lock plan action", await textOf(analyze));
    const since = new Date().toISOString();
    await press(analyze, { tap });
    const toast = await waitForText(page.getByRole("region", { name: "Notifications" }), /(ready|failed)/i, 150_000);
    s.check(/ready/i.test(toast ?? ""), "the analysis completes", toast);
    s.check(mockCalls("analyze_setup_v1", since).some(line => /status=200/.test(line)), "the local mock provider answered (no network, no cost)");
    const card = tools.getByRole("article").filter({ has: page.getByRole("heading", { name: "Setup analysis", exact: true }) }).first();
    const text = await textOf(card);
    s.check(/Risk Engine · Approved/.test(text), "the card leads with the deterministic Risk Engine line", /Risk Engine · [^—]+/.exec(text)?.[0]);
    s.check(/AI interpretation · advisory/.test(text), "and marks the AI part as advisory");
    s.check(await aboveTheFold(page, page.getByRole("button", { name: "Lock plan" }).first()), "'Lock plan' stays the next action");
  }, { requires: ["ready"] });

  await run.step("lock", "Lock the plan after the confirmation lists what becomes immutable", async s => {
    if (tradeIdOf(page.url()) !== tradeId) await openTrade(page, tradeId);
    await press(page.getByRole("button", { name: "Lock plan" }).first(), { tap });
    const dialog = page.getByRole("alertdialog", { name: "Lock this plan?" });
    await dialog.waitFor({ state: "visible" });
    const text = await textOf(dialog);
    s.check(/Becomes immutable/.test(text) && /Reserved today/.test(text), "the dialog lists what becomes immutable and what is reserved");
    await s.shot("lock-dialog");
    const pressedAt = Date.now();
    await press(dialog.getByRole("button", { name: "Lock plan" }), { tap });
    // A lock closes the dialog; a refusal keeps it open with the server's reason in an alert.
    const outcome = await Promise.race([
      dialog.waitFor({ state: "detached", timeout: 90_000 }).then(() => "locked"),
      dialog.getByRole("alert").first().waitFor({ state: "visible", timeout: 90_000 }).then(() => "refused"),
    ]).catch(() => "no answer");
    const window = [pressedAt, Date.now()];
    const expected = deadPoolExpectation(...window);
    if (outcome === "refused") {
      const reason = await textOf(dialog.getByRole("alert"));
      await s.shot("lock-refused");
      s.check(/Dead Pool/.test(reason), "the lock is refused only because of Dead Pool", reason.slice(0, 160));
      s.check(expected !== "open", "the Dead Pool refusal matches the strategy clock (12:00–18:00 UTC−5)", `lock pressed at ${clockSpan(...window)}`);
      await page.keyboard.press("Escape");
      s.clock(`Dead Pool began before the lock (${clockSpan(...window)}): the Risk Engine refused it ("${reason.slice(0, 120)}")`);
      return;
    }
    s.check(outcome === "locked", "the confirmation closes once the plan is locked", outcome);
    const state = await waitForState(page, ["Locked · waiting for entry"], 60_000);
    s.check(state === "Locked · waiting for entry", "the plan is locked", state);
    s.check(expected !== "blocked", "the Risk Engine does not allow a lock during Dead Pool (12:00–18:00 UTC−5)", `locked at ${clockSpan(...window)}`);
    s.check(/immutable/.test(await textOf(region(page, "Plan"))), "the plan card says it is immutable");
  }, { requires: ["ready"] });

  // When the new draft could not be locked (Dead Pool): continue on the locked plan of a freshly seeded user.
  let lockedTrade = run.completed.has("lock") ? tradeId : null;
  if (!lockedTrade) {
    lockedTrade = await run.step("seeded-locked-plan", "Continue on a freshly seeded locked plan (the new draft could not be locked)", async s => {
      const seeded = await env.users.seeded(`mutable-${run.viewport}`);
      await run.open(seeded);
      const id = seeded.showcase.trades.todayWaiting;
      s.check(Boolean(id), "the seeded user has a locked plan waiting for entry");
      await openTrade(run.page, id);
      const state = await tradeState(run.page);
      s.check(state === "Locked · waiting for entry", "it is Locked · waiting for entry", state);
      s.info(`continuing on ${seeded.email}'s seeded locked plan (locked before Dead Pool by seed-v2.mjs)`);
      run.state.owner = seeded;
      return id;
    }, { requires: ["user"] });
  }
  if (!lockedTrade) return;
  const p = run.page;

  await run.step("locked-immutable", "A locked plan cannot be edited: not in the app, and not through the database's own RPCs", async s => {
    await openTrade(p, lockedTrade);
    s.check(!(await visible(p.getByRole("link", { name: "Edit draft" }), 1_500)), "no 'Edit draft' control on a locked plan");
    s.check(/Locked plans can't be edited/.test(await textOf(region(p, "Plan"))), "the plan says 'Locked plans can't be edited'");
    const status = await goto(p, `/trades/${lockedTrade}/edit`);
    await settle(p);
    const editor = await visible(p.getByRole("form", { name: "Edit draft" }), 3_000);
    const shown = await textOf(main(p));
    s.check(!editor, "opening the edit page of the locked trade shows no draft editor", `HTTP ${status} → ${screenOf(new URL(p.url()).pathname)}`);
    s.check(/can't be edited/i.test(shown), "it explains that the trade can't be edited", shown.slice(0, 140));
    await s.shot("locked-edit-refused");
    // The database is the authority: the owner's own session calling the draft RPCs directly must be refused, and
    // nothing may be stored (the UI alone proves nothing about what a direct request can do).
    const refusal = await refuseDraftChanges(env.stack, run.state.owner, lockedTrade);
    s.check(refusal.grant.ok, "the trade owner's own session (password grant on the local gateway)", refusal.grant.error ?? "signed in");
    s.check(!refusal.revise.ok && /^DRAFT_NOT_EDITABLE:/.test(refusal.revise.message ?? ""), "revise_trade_draft refuses a new revision of the locked plan: DRAFT_NOT_EDITABLE", refusal.revise.ok ? `accepted: ${JSON.stringify(refusal.revise.data).slice(0, 160)}` : refusal.revise.message);
    s.check(!refusal.discard.ok && /^DRAFT_NOT_EDITABLE:/.test(refusal.discard.message ?? ""), "discard_trade_draft refuses to discard it: DRAFT_NOT_EDITABLE", refusal.discard.ok ? `accepted: ${JSON.stringify(refusal.discard.data).slice(0, 160)}` : refusal.discard.message);
    s.check(refusal.after.revisions === refusal.before.revisions && refusal.after.discarded === 0, "no revision was added and the trade was not discarded", `${refusal.before.revisions} → ${refusal.after.revisions} revisions (latest ${refusal.before.latest}), ${refusal.after.discarded} discard events`);
    s.evidence(19, `locked plan: the edit page shows no editor ("can't be edited"); the owner's own revise_trade_draft and discard_trade_draft calls are refused with DRAFT_NOT_EDITABLE and the trade keeps its ${refusal.after.revisions} revision(s)`);
    await openTrade(p, lockedTrade);
    s.check(await aboveTheFold(p, p.getByRole("link", { name: "Record entry" }).first()), "'Record entry' is the next action of a locked plan");
    s.evidence(1, "Locked: 'Record entry' is the next action");
    await s.shot("locked");
  }, { criteria: [19, 1] });

  await run.step("record-entry", "Record the execution against the locked plan", async s => {
    const form = p.getByRole("form", { name: "Record entry" });
    await form.waitFor({ state: "visible" });
    const entry = await form.getByRole("textbox", { name: "Entry price" }).inputValue();
    const size = await form.getByRole("textbox", { name: /^Size/ }).inputValue();
    s.check(entry !== "" && size !== "", "entry price and size are pre-filled from the locked plan", `${entry} · ${size}`);
    s.evidence(17, `entry form pre-filled with the plan's entry ${entry} and size ${size}`);
    await press(form.getByRole("button", { name: "Record entry" }), { tap });
    const state = await waitForState(p, ["Live"], 60_000);
    s.check(state === "Live", "the trade is Live", state);
    // A table where the section is wide enough; on phones a "Plan vs reality" list (planned → actual).
    const comparison = p.getByRole("table", { name: "Plan vs reality" }).or(region(p, "Execution").getByRole("heading", { name: "Plan vs reality" })).filter({ visible: true });
    s.check(await visible(comparison), "Plan vs reality compares the fill with the plan");
    s.check(await aboveTheFold(p, p.getByRole("link", { name: "Add to journal" }).first()), "'Add to journal' is the next action of a live trade");
    s.evidence(1, "Live: 'Add to journal' is the next action (Close trade is the secondary one)");
  }, { requires: ["locked-immutable"], criteria: [17, 1] });

  await run.step("live-note", `Add a live note with a screenshot (${run.mobile ? "attached with the phone's picker" : "pasted with Ctrl+V"}) without leaving the trade`, async s => {
    const before = p.url();
    const { announced, attached } = await addJournalEntry(p, { kind: "Note", body: "Price holds above the order block; stop and target unchanged.", image: await chartFor(run, "live-note", "MANAGE", { timeframe: "M5" }), tap });
    s.check(attached?.handled, run.mobile ? "'Attach screenshots' opened the system picker and the composer took the image" : "the composer took the pasted screenshot", attached?.target ?? attached?.method);
    s.check(announced, "the composer confirms the entry", announced);
    s.check(p.url() === before, "the page never left the trade", new URL(p.url()).pathname);
    const bands = await timelineBands(p);
    const live = (bands["While live"] ?? []).join(" | ");
    s.check(/Price holds above the order block/.test(live), "the note is in the While live band with its time");
    s.check(/screenshot added/i.test(live), "the screenshot is in the While live band");
    s.evidence(2, "note + screenshot added from the trade page composer; URL unchanged");
    if (run.mobile) s.evidence(18, "phone: the live note was typed and its screenshot attached with taps and the system picker (no hover, no keyboard shortcut), on the trade page");
    else s.evidence(3, "Ctrl+V in the live journal composer attached the screenshot");
    await s.shot("live-journal");
    // On a phone the documentation image starts at the While live band (the new note and its screenshot).
    if (run.mobile) {
      await region(p, "Journal").locator("h3").filter({ hasText: /^While live/ }).first().evaluate(heading => {
        heading.scrollIntoView({ block: "start" });
        window.scrollBy(0, -72);
      }).catch(() => {});
    }
    await run.curate("trade-planned-live", `Trade workspace: planned trade live, journal with a note and a ${run.mobile ? "screenshot from the phone's picker" : "pasted screenshot"}`, { full: !run.mobile });
  }, { requires: ["record-entry"], criteria: run.mobile ? [2, 18] : [2, 3] });

  const closed = await run.step("close", "Close the trade with one exit price, confirmed before it is recorded", async s => {
    const form = p.getByRole("form", { name: "Close trade" });
    await form.waitFor({ state: "visible" });
    const priceField = form.getByRole("textbox", { name: /exit price/i });
    const entryFacts = await textOf(region(p, "Execution"));
    // A clean exit 3 stop distances in favour of the trade, derived from the plan the page shows.
    const exit = await exitPriceFor(p);
    await fill(priceField, exit);
    // The close can't be changed later (spec §57): Enter in the price field, like the button, only opens a confirmation
    // with what will be recorded; nothing is recorded until the trader confirms it there.
    if (tap) await press(form.getByRole("button", { name: "Close trade" }), { tap });
    else await priceField.first().press("Enter");
    const confirm = p.getByRole("alertdialog", { name: "Close this trade?" });
    s.check(await visible(confirm, 15_000), tap ? "Close trade opens the confirmation" : "Enter in the exit price opens the confirmation instead of closing the trade");
    const summary = await textOf(confirm);
    s.check(summary.includes(exit), "the confirmation shows the exit before anything is recorded", summary.slice(0, 220));
    // The page behind the modal is hidden from the accessibility tree, so its header is read from the DOM.
    const header = await p.evaluate(() => {
      const h1 = document.querySelector("h1");
      return (h1?.closest("header") ?? h1?.parentElement?.parentElement ?? h1?.parentElement)?.textContent ?? "";
    });
    s.check(!/Closed/.test(header), "nothing is recorded before the close is confirmed", header.replace(/\s+/g, " ").slice(0, 120));
    await s.shot("close-confirmation");
    await press(confirm.getByRole("button", { name: "Close trade" }), { tap });
    const state = await waitForState(p, ["Closed · review pending"], 60_000);
    s.check(state === "Closed · review pending", "the trade is Closed · review pending", state);
    const result = await textOf(region(p, "Result"));
    s.check(/Realized R/.test(result) && /Net P&L/.test(result), "the Result shows realized R and net P&L", result.slice(0, 160));
    s.info(`exit ${exit}; execution: ${entryFacts.slice(0, 100)}`);
    s.check(await aboveTheFold(p, p.getByRole("link", { name: "Write review" }).first()), "'Write review' is the next action after close");
    s.evidence(1, "Closed: 'Write review' is the next action");
    return { summary, result };
  }, { requires: ["record-entry"], criteria: [1] });

  // Its own step, so a confirmation without the result fails here while the steps after the close still run.
  await run.step("close-preview", "The close confirmation showed the result the close then recorded", async s => {
    const shown = { pnl: closeFigure(closed.summary, "Net P&L"), r: closeFigure(closed.summary, "Realized R") };
    const recorded = { pnl: closeFigure(closed.result, "Net P&L"), r: closeFigure(closed.result, "Realized R") };
    s.check(shown.pnl !== null && shown.r !== null, "the confirmation showed the net P&L and realized R as figures before the close was recorded", closed.summary.slice(0, 260));
    s.check(shown.pnl === recorded.pnl && shown.r === recorded.r, "they are the net P&L and realized R the close recorded",
      `confirmation ${shown.pnl} ${shown.r}; Result ${recorded.pnl} ${recorded.r}`);
  }, { requires: ["close"] });

  await run.step("lesson-after-close", "Write a lesson after close: labelled After close, never Before entry", async s => {
    const { announced } = await addJournalEntry(p, { kind: "Lesson", body: "Lesson: waiting for the M5 shift before entry kept the risk small.", tap });
    s.check(announced, "the lesson is added", announced);
    const bands = await timelineBands(p);
    const after = (bands["After close"] ?? []).join(" | ");
    const before = (bands["Before entry"] ?? []).join(" | ");
    s.check(/waiting for the M5 shift/.test(after), "the lesson is in the After close band");
    s.check(!/waiting for the M5 shift/.test(before), "it is not in the Before entry band");
    s.check(!/waiting for the M5 shift/.test(await textOf(p.getByRole("region", { name: "Thesis" }))), "the plan's pre-entry thesis does not include it");
    s.evidence(9, "a post-close lesson is listed under After close only, never under Before entry or the thesis");
  }, { requires: ["close"], criteria: [9] });

  await run.step("review", "Review the trade: tag it and mark it reviewed", async s => {
    const review = region(p, "Review");
    const tags = review.getByRole("form", { name: "Tags" });
    await pick(run, tags.getByRole("group", { name: "Setup grade" }), "A");
    const save = tags.getByRole("button", { name: "Save tags" });
    await press(save, { tap });
    // Saved tags leave nothing unsaved, so the button is disabled again.
    const saved = await until(async () => !(await save.isEnabled()), { timeout: 30_000 });
    s.check(saved, "the setup grade is saved");
    await press(review.getByRole("button", { name: "Mark reviewed" }), { tap });
    const state = await waitForState(p, ["Reviewed"], 60_000);
    s.check(state === "Reviewed", "the trade is Reviewed", state);
    s.evidence(15, "planned trade created, journaled, closed and reviewed through labelled controls only (developer mode off, no Technical details opened)");
  }, { requires: ["close"], criteria: [15] });

  await run.step("timeline", "Review the timeline: Before entry · While live · After close", async s => {
    await openTrade(p, lockedTrade);
    const bands = await timelineBands(p);
    const names = Object.keys(bands);
    s.check(names.includes("Before entry") && names.includes("While live") && names.includes("After close"), "the journal groups records into the three timing bands", names.join(", "));
    s.check((bands["Before entry"] ?? []).some(item => /Plan locked/.test(item)), "Before entry holds the lock");
    s.check((bands["While live"] ?? []).some(item => /Trade opened/.test(item)), "While live starts with the entry");
    s.check((bands["After close"] ?? []).some(item => /Trade closed/.test(item)), "After close starts with the close");
    s.evidence(13, "the whole planned flow used visible controls only; no Technical details disclosure was opened");
    s.evidence(9, "timeline bands keep post-close records out of Before entry");
    await s.shot("closed-timeline", { full: true });
    await run.curate("trade-closed-timeline", "Trade workspace: reviewed trade with its timeline (Before entry · While live · After close)", { full: true });
  }, { requires: ["close"], criteria: [13, 9] });
}

/**
 * Tries to change a locked plan the way any direct client could: as the owner's own session (a password grant on the
 * local gateway; RLS and the RPCs' own checks apply), revise_trade_draft with the latest proposal at another risk, then
 * discard_trade_draft. Returns both answers and the trade's revisions and discard events before and after (superuser
 * SQL on the local database).
 */
async function refuseDraftChanges(stack, owner, tradeId) {
  if (!UUID.test(String(tradeId))) throw new Error(`Not a trade id: ${tradeId}`);
  const facts = () => {
    const [revisions, latest] = sqlValue(stack, `select count(*) || ',' || coalesce(max(revision), 0) from public.trade_revisions where trade_id = '${tradeId}'::uuid`).split(",").map(Number);
    const discarded = Number(sqlValue(stack, `select count(*) from public.trade_lifecycle_events where trade_id = '${tradeId}'::uuid and event = 'DRAFT_DISCARDED'`));
    return { revisions, latest, discarded };
  };
  const before = facts();
  const stored = sqlValue(stack, `select s.proposal::text from public.trade_revisions r join public.setup_proposals s on s.id = r.proposal_id where r.trade_id = '${tradeId}'::uuid order by r.revision desc limit 1`);
  const proposal = { ...JSON.parse(stored || "{}"), riskPercent: "0.25" };
  const grant = await passwordGrant(stack, owner.email, owner.password);
  const unsent = { ok: false, status: 0, data: null, message: "not sent: the owner could not sign in" };
  const revise = grant.ok
    ? await userRpc(stack, grant.token, "revise_trade_draft", { p_trade_id: tradeId, p_proposal: proposal, p_request_key: randomUUID(), p_expected_revision: before.latest, p_expected_risk_id: null, p_expected_observation_id: null })
    : unsent;
  const discard = grant.ok
    ? await userRpc(stack, grant.token, "discard_trade_draft", { p_trade_id: tradeId, p_reason: "Acceptance: a locked plan must not be discardable", p_request_key: randomUUID() })
    : unsent;
  return { grant, revise, discard, before, after: facts() };
}

/**
 * The figure after `label` in a close's words, as the page formats it: net P&L as signed money (`+$1,530.00`), realized
 * R as a signed R (`+3.06R`). Null when the label is followed by words instead ("Calculated when you confirm") or is
 * missing, so a label alone never counts as the figure.
 */
function closeFigure(text, label) {
  const figure = label === "Net P&L" ? String.raw`[+\-−]?[$€£][0-9][0-9,]*\.[0-9]{2}` : String.raw`[+\-−]?[0-9]+\.[0-9]{2}R`;
  const match = new RegExp(`${label}\\s+(${figure})`).exec(text ?? "");
  return match ? match[1].replace("−", "-") : null;
}

/**
 * An exit price two stop distances in the trade's favour, from the locked plan's entry and stop as the page shows them.
 * Exact integer arithmetic on the decimal strings (tick-aligned because entry and stop are).
 */
async function exitPriceFor(page) {
  const plan = await textOf(region(page, "Plan"));
  const entry = /Entry\s+([0-9]+(?:\.[0-9]+)?)/.exec(plan)?.[1];
  const stop = /Stop\s+([0-9]+(?:\.[0-9]+)?)/.exec(plan)?.[1];
  if (!entry || !stop) throw new Error(`Could not read the plan's entry/stop from: ${plan.slice(0, 160)}`);
  const direction = /Short/.test(await textOf(page.getByRole("heading", { level: 1 }))) ? -1n : 1n;
  const scale = Math.max((entry.split(".")[1] ?? "").length, (stop.split(".")[1] ?? "").length);
  const units = text => {
    const [whole, fraction = ""] = text.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  const distance = units(entry) > units(stop) ? units(entry) - units(stop) : units(stop) - units(entry);
  const exit = (units(entry) + direction * distance * 2n).toString().padStart(scale + 1, "0");
  return scale === 0 ? exit : `${exit.slice(0, -scale)}.${exit.slice(-scale)}`;
}
