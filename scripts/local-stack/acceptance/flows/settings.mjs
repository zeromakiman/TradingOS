// SETTINGS (master specification §64; docs/V2_ARCHITECTURE.md §14.9, §14.11, §8.6, §10.4, §10.5): risk preferences
// (a new risk-plan version), trading-account management (profile, account values, external losses), the Connections UX
// with the mock platform sync, "Export my data" (the archive is downloaded and inspected: complete, and nothing of any
// other user), and "Delete Trading OS account" on a synthetic user with the full re-authentication flow, then proof from
// the local PostgreSQL (superuser) that none of its rows, objects or its login remain while another user is intact.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sqlValue } from "../../lib.mjs";
import { identityFootprint, passwordGrant, readZip, rowCountsFor, storageFilesFor } from "../fixtures.mjs";
import { signIn } from "../harness.mjs";
import { arrive, fill, goto, main, press, region, textOf, until, visible, waitForText } from "../ui.mjs";
import { riskPlanEntries } from "./common.mjs";

const sum = counts => Object.values(counts).reduce((total, n) => total + n, 0);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export default async function settings(run) {
  const { env } = run;
  const tap = run.mobile;
  const user = await run.step("user", "Freshly seeded synthetic user for settings and export", async s => {
    const seeded = await env.users.seeded(`settings-${run.viewport}`);
    s.info(`signed in as ${seeded.email} (seeded for this run)`);
    await run.open(seeded);
    return seeded;
  });
  if (!user) return;
  const page = run.page;
  const accounts = user.showcase.accounts;

  await run.step("general", "General: theme and time display", async s => {
    await goto(page, "/settings?account=all");
    const general = region(page, "General");
    await press(general.getByRole("radio", { name: "Dark" }).locator("xpath=ancestor::label[1]"), { tap });
    const dark = await until(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"), { timeout: 10_000 });
    s.check(dark, "choosing Dark switches the whole app to the dark theme");
    await press(general.getByRole("radio", { name: "Light" }).locator("xpath=ancestor::label[1]"), { tap });
    const light = await until(() => page.evaluate(() => document.documentElement.dataset.theme === "light"), { timeout: 10_000 });
    s.check(light, "and Light switches it back");
    const time = await textOf(general.getByRole("group", { name: "Time display" }));
    s.check(/Strategy time \(UTC−5\)/.test(time) && /Local time/.test(time) && /UTC/.test(time), "time display offers strategy time, local time and UTC", time.slice(0, 100));
    s.check(!/gross realized loss/i.test(await textOf(main(page))), "Settings has no manual 'gross realized losses' input (losses are computed)");
    s.evidence(17, "daily losses are computed from trades plus explicit external losses; Settings asks for no daily-loss total");
    await s.shot("settings-general");
    await run.curate("settings", "Settings: general, AI budgets per account, connections, data, security, danger zone, developer", { full: !run.mobile });
  }, { criteria: [17] });

  await run.step("ai-consent", "AI per account: turning it on needs explicit consent; turning it off is one click", async s => {
    await goto(page, "/settings?account=all#ai");
    const budget = () => textOf(page.getByRole("region", { name: "AI budget · Demo 100K" }).first());
    s.check(/\bOff\b/.test(await budget()), "Demo 100K starts with AI off", (await budget()).slice(0, 80));
    await press(page.getByRole("button", { name: "Turn on AI… for Demo 100K" }), { tap });
    const dialog = page.getByRole("dialog", { name: "Turn on AI for Demo 100K?" });
    await dialog.waitFor({ state: "visible" });
    const submit = dialog.getByRole("button", { name: "Turn on AI", exact: true });
    s.check(await submit.isDisabled(), "'Turn on AI' stays disabled until the consent box is ticked");
    s.check(/Nothing is sent when you open a page/.test(await textOf(dialog)), "the dialog lists what is shared and that nothing is sent on page load");
    await s.shot("ai-consent");
    await press(dialog.getByRole("checkbox", { name: /I understand and consent/ }).locator("xpath=ancestor::label[1]"), { tap });
    await press(submit, { tap });
    await dialog.waitFor({ state: "detached", timeout: 30_000 });
    s.check(await until(async () => /\bOn\b/.test(await budget()), { timeout: 20_000 }), "the budget chip says On", (await budget()).slice(0, 80));
    await press(page.getByRole("button", { name: "Turn off AI for Demo 100K" }), { tap });
    s.check(await until(async () => /\bOff\b/.test(await budget()), { timeout: 20_000 }), "one click turns it off again", (await budget()).slice(0, 80));
  });

  await run.step("risk-preferences", "Risk preferences: create a risk plan version that starts on the next trading day", async s => {
    await goto(page, `/accounts/${accounts.demo}/manage?tab=risk-policy`);
    const form = page.getByRole("form", { name: "Create a risk plan version" });
    await form.waitFor({ state: "visible" });
    await fill(form.getByRole("textbox", { name: /^Default risk per trade/ }), "0.50");
    await fill(form.getByRole("textbox", { name: /^Maximum risk per trade/ }), "0.75");
    await fill(form.getByRole("textbox", { name: /^Trades per day/ }), "3");
    await fill(form.getByRole("textbox", { name: /^Minimum RR/ }), "3");
    await fill(form.getByRole("textbox", { name: /^Daily loss limit/ }), "1500");
    await press(form.getByRole("radio", { name: /Next trading day/ }).locator("xpath=ancestor::label[1]"), { tap });
    await press(form.getByRole("button", { name: "Create version" }), { tap });
    const done = await waitForText(main(page), /Starts tomorrow/, 60_000);
    s.check(done, "the new version is listed as 'Starts tomorrow'");
    const versions = await riskPlanEntries(page);
    const scheduled = versions.find(entry => /Starts tomorrow/.test(entry)) ?? "";
    s.check(/0\.50% default · 0\.75% maximum/.test(scheduled), "with its default and maximum risk", scheduled.slice(0, 160));
    const copy = await textOf(main(page));
    s.check(/keeps? the version (?:it was|they were) evaluated with/.test(copy) && /history is never rewritten/.test(copy), "the page explains that plans, checks and trades keep the version they were evaluated with", /[^.]*history is never rewritten\./.exec(copy)?.[0]);
    await s.shot("risk-policy");
    await run.curate("account-manage-risk-policy", "Manage account: risk policy versions (scheduled version starts tomorrow)", { full: !run.mobile });
  });

  await run.step("account-management", "Trading account management: profile, account values, external losses", async s => {
    await goto(page, `/accounts/${accounts.demo}/manage`);
    const profile = page.getByRole("form", { name: "Account profile" });
    await fill(profile.getByRole("textbox", { name: /Broker or prop firm/ }), "Acceptance Broker");
    await press(profile.getByRole("button", { name: "Save profile" }), { tap });
    s.check(await waitForText(main(page), /Profile saved\. Earlier versions stay in the history\./, 30_000), "the profile is saved as a new version");
    await goto(page, `/accounts/${accounts.demo}/manage?tab=account-values`);
    const confirm = page.getByRole("button", { name: "Confirm unchanged" });
    if (await visible(confirm, 5_000)) {
      await press(confirm, { tap });
      s.check(await waitForText(main(page), /confirmed|Recorded today|Balance confirmed today/i, 30_000), "today's values are confirmed with one click");
    } else {
      s.info("account values were already confirmed today");
    }
    await goto(page, `/accounts/${accounts.demo}/manage?tab=external-losses`);
    const add = page.getByRole("form", { name: "Add external loss" });
    s.check(/Losses from trades not recorded in Trading OS today/.test(await textOf(main(page))), "the helper copy explains what an external loss is");
    await fill(add.getByRole("textbox", { name: /^Amount/ }), "25.00");
    await fill(add.getByRole("textbox", { name: /^Note/ }), "Acceptance: loss on another platform");
    await press(add.getByRole("button", { name: /Add external loss/ }), { tap });
    const listed = await waitForText(main(page), /Acceptance: loss on another platform/, 30_000);
    s.check(listed, "the external loss is listed for today");
    await press(page.getByRole("button", { name: /^Remove the external loss of \$25\.00/ }).first(), { tap });
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ state: "visible" });
    await press(dialog.getByRole("button", { name: /Remove/ }).last(), { tap });
    await dialog.waitFor({ state: "detached", timeout: 30_000 });
    s.check(await waitForText(main(page), /[Rr]emoved/, 30_000), "removing it is recorded (audited, not deleted)");
    await s.shot("external-losses");
  });

  await run.step("connections", "Connections UX: manual today, planned providers, and the mock platform sync", async s => {
    await goto(page, "/settings?account=all#connections");
    const connections = region(page, "Connections");
    const text = await textOf(connections);
    s.check(/Read-only sync planned for V2\.1/.test(text) && /Bridge planned for V2\.2/.test(text), "cTrader and MetaTrader 5 are shown as planned, not connected");
    s.check(/Trading OS never requests trading permission/.test(text), "the permission scope copy promises read-only access");
    const developer = region(page, "Developer");
    s.check(/Mock platform sync/.test(await textOf(developer)), "the deployment enables the mock platform sync (developer only)");
    const connect = developer.getByRole("button", { name: "Connect mock platform to Demo 100K" });
    await until(async () => (await connect.isEnabled()), { timeout: 15_000 });
    await press(connect, { tap });
    // The row switches from "Connect" to the connection's commands once it is connected.
    const sync = developer.getByRole("button", { name: "Simulate sync for Demo 100K" });
    s.check(await visible(sync, 30_000), "the mock platform connects (Simulate sync and Disconnect replace Connect)");
    s.check(/Demo 100K\s*Connected/.test(await textOf(developer)), "the row says Connected", /Demo 100K[^A-Z]*Connected[^.]*\./.exec(await textOf(developer))?.[0]);
    await press(sync, { tap });
    const synced = await waitForText(developer, /Sync complete: \d+ imported/, 60_000);
    s.check(synced, "a simulated sync reports what it imported, linked or holds for confirmation", /Sync complete:[^.]*\./.exec(synced ?? "")?.[0]);
    await s.shot("mock-sync");
    await goto(page, `/journal?account=${accounts.demo}&origin=imported`);
    const importedCount = await main(page).getByRole("link").filter({ hasText: /Imported/ }).count();
    s.check(importedCount > 0, "imported trades appear in the Journal with the Imported badge", `${importedCount} imported`);
    await goto(page, "/settings?account=all#developer");
    await press(region(page, "Developer").getByRole("button", { name: "Disconnect Demo 100K" }), { tap });
    // The row switches back to "Connect mock platform" once the connection is closed.
    s.check(await visible(region(page, "Developer").getByRole("button", { name: "Connect mock platform to Demo 100K" }), 30_000), "the mock platform disconnects");
    await goto(page, `/journal?account=${accounts.demo}&origin=imported`);
    const kept = await main(page).getByRole("link").filter({ hasText: /Imported/ }).count();
    s.check(kept === importedCount, "imported trades and their history are kept after disconnecting", `${kept} imported trades`);
  });

  await run.step("export", "Export my data: download the archive and inspect it (complete, and only this user's data)", async s => {
    await goto(page, "/settings?account=all#data");
    const data = region(page, "Your data");
    const include = data.getByRole("checkbox", { name: "Include screenshots" });
    if (!(await include.isChecked())) await press(include.locator("xpath=ancestor::label[1]"), { tap });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 240_000 }), press(data.getByRole("button", { name: "Download my data (.zip)" }), { tap })]);
    const dir = path.join(env.out, "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `export-${run.viewport}.zip`);
    await download.saveAs(file);
    const zip = readZip(fs.readFileSync(file));
    const names = Object.keys(zip);
    const root = names[0]?.split("/")[0];
    s.check(names.some(name => name.endsWith("/README.txt")), "the archive has a README", `${download.suggestedFilename()} · ${names.length} files`);
    const parts = Object.fromEntries(["core", "trades", "ai", "evidence-manifest"].map(part => [part, JSON.parse(zip[`${root}/${part}.json`].toString("utf8"))]));
    for (const [part, document] of Object.entries(parts)) s.check(document.user?.id === user.id, `${part}.json belongs to this user`);
    s.check(parts.core.user.email === user.email, "core.json carries the login email of this user only");
    const db = rowCountsFor(env.stack, user.id);
    const mismatches = [];
    let foreignRows = 0;
    let rows = 0;
    for (const document of Object.values(parts)) {
      for (const [table, list] of Object.entries(document.tables)) {
        rows += list.length;
        foreignRows += list.filter(row => "user_id" in row && row.user_id !== user.id).length;
        if (table in db && db[table] !== list.length) mismatches.push(`${table}: ${list.length} exported vs ${db[table]} stored`);
      }
    }
    s.check(foreignRows === 0, "every exported row with a user_id is this user's", `${rows} rows`);
    s.check(mismatches.length === 0, "every table holds exactly the rows stored for this user", mismatches.slice(0, 5).join("; ") || `${Object.keys(db).length} tables compared`);
    const others = sqlValue(env.stack, `select coalesce(string_agg(id::text, ','), '') from auth.users where id <> '${user.id}'`).split(",").filter(Boolean);
    const text = names.filter(name => /\.(json|csv|txt)$/.test(name)).map(name => zip[name].toString("utf8")).join("\n");
    const ids = new Set(text.match(UUID) ?? []);
    const leaked = others.filter(id => ids.has(id));
    s.check(leaked.length === 0, "no id of any of the other users appears anywhere in the archive", `${others.length} other users checked`);
    s.check(!/@example\.test/.test(text.replaceAll(user.email, "")), "no other user's email appears in it");
    const csvRows = zip[`${root}/trades.csv`].toString("utf8").trim().split(/\r?\n/).length - 1;
    s.check(csvRows === db.trades, "trades.csv has one row per trade", `${csvRows} rows, ${db.trades} trades`);
    const manifest = parts["evidence-manifest"].manifest ?? [];
    const images = names.filter(name => name.startsWith(`${root}/screenshots/`) && !name.endsWith(".json"));
    const bad = images.filter(name => {
      const id = path.basename(name).split(".")[0];
      const item = manifest.find(entry => entry.id === id);
      return !item || createHash("sha256").update(zip[name]).digest("hex") !== item.sha256;
    });
    s.check(images.length > 0 && images.length === manifest.length && bad.length === 0, "every screenshot is included and matches its recorded SHA-256", `${images.length} images, ${manifest.length} manifest items, ${bad.length} mismatches`);
    s.info(`archive ${path.relative(env.out, file).replace(/\\/g, "/")} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    await s.shot("export-done");
  });

  await run.step("delete-account", "Delete Trading OS account on a synthetic user: re-authentication, then nothing of it remains", async s => {
    const victim = await env.users.seeded(`erase-${run.viewport}`);
    const before = rowCountsFor(env.stack, victim.id);
    const footprint = identityFootprint(env.stack, victim.id);
    s.check(sum(before) > 100 && footprint.authUsers === 1 && footprint.objects > 0, "the synthetic user to delete has data, a login and stored screenshots", `${sum(before)} rows, ${footprint.objects} objects`);
    const witness = rowCountsFor(env.stack, user.id);
    const receipts = Number(sqlValue(env.stack, "select count(*) from private.erasure_receipts"));
    await run.open(victim);
    const p = run.page;
    // One of the user's own trading accounts becomes the browser's context first, through the header selector: its
    // action stores the account in both context cookies (tos_account and tos_last_account, src/app/actions/context.ts).
    // Deleting the account must take those ids out of the browser with the login (src/app/actions/erasure.ts).
    const ftmo = victim.showcase.accounts.ftmo;
    const CONTEXT_COOKIES = ["tos_account", "tos_last_account"];
    const contextCookies = async () => Object.fromEntries((await p.context().cookies()).filter(c => CONTEXT_COOKIES.includes(c.name)).map(c => [c.name, c.value]));
    const listed = cookies => Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join(", ") || "no context cookie";
    const holdsAccount = cookies => CONTEXT_COOKIES.every(name => cookies[name] === ftmo);
    // Settings without ?account=: there a choice in the selector calls that action (with ?account= it follows its link),
    // and the stored context stays that account until the deletion.
    await goto(p, "/settings#danger");
    const selector = p.getByRole("button", { name: /^Trading Account:/ }).first();
    await press(selector, { tap });
    const menu = p.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await press(menu.getByRole("menuitemradio", { name: /FTMO 100K/ }), { tap });
    const chosen = await until(async () => holdsAccount(await contextCookies()), { timeout: 20_000 });
    s.check(chosen, "choosing one of the user's accounts in the header stores it in both context cookies", listed(await contextCookies()));
    const danger = region(p, "Danger zone");
    s.check(/This can't be undone/.test(await textOf(danger)), "the danger zone says it can't be undone and lists what is deleted");
    await press(danger.getByRole("button", { name: "Delete Trading OS account…" }), { tap });
    const dialog = p.getByRole("dialog", { name: "Delete your Trading OS account?" });
    await dialog.waitFor({ state: "visible" });
    const submit = dialog.getByRole("button", { name: "Delete everything permanently" });
    s.check(await submit.isDisabled(), "the delete button stays disabled until DELETE and the password are entered");
    await fill(dialog.getByRole("textbox", { name: /Type DELETE to confirm/ }), "DELETE");
    await fill(dialog.getByLabel("Current password"), "not-the-password");
    // Everything of the user right before the attempt (opening Settings may itself have written something).
    const attempt = { rows: rowCountsFor(env.stack, victim.id), identity: identityFootprint(env.stack, victim.id), files: storageFilesFor(victim.id) };
    await press(submit, { tap });
    // The server's own answer (ERASURE_COPY.passwordRejected in an alert), not the dialog's "Current password" label.
    const refused = await waitForText(dialog.getByRole("alert"), /That password is not correct\. Nothing was deleted\./, 60_000);
    s.check(refused, "a wrong password is refused with 'That password is not correct. Nothing was deleted.'", refused ?? ((await textOf(dialog.getByRole("alert"), 1_000)) || "no answer from the server"));
    // The form is idle again (not busy, the delete button enabled) before the database is compared.
    const idle = await until(async () => (await dialog.locator("form").getAttribute("aria-busy")) !== "true" && (await submit.isEnabled({ timeout: 1_000 })), { timeout: 30_000 });
    s.check(idle && (await visible(dialog, 1_000)), "the dialog stays open and idle after the refusal");
    const refusedState = { rows: rowCountsFor(env.stack, victim.id), identity: identityFootprint(env.stack, victim.id), files: storageFilesFor(victim.id) };
    const touched = Object.keys({ ...attempt.rows, ...refusedState.rows }).filter(table => attempt.rows[table] !== refusedState.rows[table]);
    s.check(
      touched.length === 0,
      "every table holds exactly the user's rows of before the refused attempt",
      touched.map(table => `${table}: ${attempt.rows[table]} → ${refusedState.rows[table]}`).join(", ") || `${Object.keys(refusedState.rows).length} tables, ${sum(refusedState.rows)} rows unchanged`,
    );
    s.check(
      JSON.stringify(refusedState.identity) === JSON.stringify(attempt.identity) && refusedState.files === attempt.files,
      "its login, storage objects and stored files are untouched",
      `auth user ${refusedState.identity.authUsers}, ${refusedState.identity.objects} objects, ${refusedState.files} files`,
    );
    await s.shot("delete-dialog");
    await fill(dialog.getByLabel("Current password"), victim.password);
    // Immediately before the deletion (after the refused attempt, which must not touch them): both cookies name the account.
    const held = await contextCookies();
    s.check(holdsAccount(held), "right before the deletion both context cookies hold the user's account id", listed(held));
    await press(submit, { tap });
    await arrive(p, url => url.pathname === "/login", { timeout: 180_000 });
    s.check(/reason=account_deleted/.test(p.url()), "the browser lands on the sign-in page with the deletion notice", new URL(p.url()).search);
    const remaining = await contextCookies();
    const removed = Object.keys(held).filter(name => !(name in remaining));
    s.check(
      Object.keys(remaining).length === 0 && CONTEXT_COOKIES.every(name => removed.includes(name)),
      "the deletion removed both of the user's trading-account context cookies from the browser",
      `removed: ${removed.join(", ") || "none"}; left: ${Object.keys(remaining).length ? listed(remaining) : "none"}`,
    );
    await s.shot("deleted-login");
    const grant = await passwordGrant(env.stack, victim.email, victim.password);
    s.check(!grant.ok, "the deleted login can no longer sign in (password grant)", grant.error);
    let uiSignIn = "signed in";
    try {
      await signIn(p, victim);
    } catch (error) {
      uiSignIn = error instanceof Error ? error.message : String(error);
    }
    s.check(/did not leave \/login/.test(uiSignIn), "signing in through the page fails too", uiSignIn.slice(0, 120));
    const after = rowCountsFor(env.stack, victim.id);
    const left = Object.entries(after).filter(([, n]) => n > 0);
    s.check(left.length === 0, "no public table holds a row of the deleted user", left.map(([table, n]) => `${table}: ${n}`).join(", ") || `${Object.keys(after).length} tables checked`);
    const gone = identityFootprint(env.stack, victim.id);
    s.check(gone.authUsers === 0, "its auth user is deleted");
    s.check(gone.objects === 0 && storageFilesFor(victim.id) === 0, "its screenshots are gone from Storage (rows and bytes)");
    s.check(Number(sqlValue(env.stack, "select count(*) from private.erasure_receipts")) === receipts + 1, "one de-identified erasure receipt was written");
    const intact = rowCountsFor(env.stack, user.id);
    const changed = Object.keys(witness).filter(table => witness[table] !== intact[table]);
    s.check(changed.length === 0, "another user's data is intact", `${sum(intact)} rows of ${user.email} unchanged`);
    await run.open(user);
  });
}
