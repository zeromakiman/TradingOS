#!/usr/bin/env node
// End-to-end V1 UI smoke test against the LOCAL stack with synthetic users and data only.
// Starts `npx pnpm@11.19.0 dev` (unless --reuse-app and it is already running), drives installed
// Edge/Chrome headless through playwright-core from .local/tools, saves full-page screenshots to
// .local/screenshots/v1-*.png plus v1-smoke-report.json, checks cross-user screenshot isolation and
// UI password recovery (throwaway user), then stops the app it started and restores tracked files
// `next dev` rewrites (next-env.d.ts).
// Prerequisites: start.mjs, provision-users.mjs, env.mjs.
// Usage: node scripts/local-stack/browser-smoke.mjs [--browser=edge|chrome] [--reuse-app] [--headed]
//        [--record-values] [--desktop=1440x900] [--mobile=390x844]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { restoreTrackedFiles, snapshotTrackedFiles, startApp, stopApp } from "./control.mjs";
import { APP_URL, GATEWAY_URL, LOCAL, PATHS, PORTS, ensureTools, fail, httpStatus, log, makePng, portOpen, readStack, runMain } from "./lib.mjs";

const BROWSERS = {
  edge: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  chrome: "C:/Program Files/Google/Chrome/Application/chrome.exe",
};
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = name => process.argv.includes(`--${name}`);
const SHOTS = PATHS.screenshots;
const NAV_TIMEOUT = 180_000; // the first request to each dev route compiles it
const ACTION_TIMEOUT = 90_000;
const size = (value, fallback) => { const m = /^(\d+)x(\d+)$/.exec(value ?? ""); return m ? { width: Number(m[1]), height: Number(m[2]) } : fallback; };
const DESKTOP = size(arg("desktop"), { width: 1440, height: 900 }), MOBILE = size(arg("mobile"), { width: 390, height: 844 });

/** Fixed UTC-5 strategy clock (same formula as src/domain/session.ts). */
function strategyClock(date = new Date()) {
  const shifted = new Date(date.getTime() - 300 * 60_000), minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const session = minute >= 1080 || minute < 60 ? "ASIA" : minute < 120 ? "JUDAS" : minute < 720 ? "ACTIVE_KILL_ZONE" : "DEAD_POOL";
  return { day: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16), session };
}

/** Synthetic 640x360 "chart": dark background, grid and a rising candle sequence. */
function syntheticChart() {
  const candles = Array.from({ length: 24 }, (_, i) => ({ x: 20 + i * 25, open: 250 - i * 6 + (i % 3) * 8, close: 240 - i * 6 - (i % 2) * 10 }));
  return makePng(640, 360, [17, 24, 39], (x, y) => {
    if (x % 80 === 0 || y % 60 === 0) return [40, 52, 72];
    for (const c of candles) {
      const top = Math.min(c.open, c.close), bottom = Math.max(c.open, c.close);
      if (x === c.x + 6 && y >= top - 12 && y <= bottom + 12) return [148, 163, 184];
      if (x >= c.x && x <= c.x + 12 && y >= top && y <= bottom) return c.close < c.open ? [34, 197, 94] : [239, 68, 68];
    }
    return null;
  });
}

await runMain(async () => {
  const stack = readStack();
  if (!stack) fail("Missing .local/stack.json. Run start.mjs first.");
  if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`Gateway not healthy at ${GATEWAY_URL}. Run start.mjs first.`);
  let users;
  try { users = JSON.parse(fs.readFileSync(PATHS.users, "utf8")); } catch { fail("Missing .local/integration-users.json. Run provision-users.mjs first."); }
  if (users.project !== GATEWAY_URL) fail(".local/integration-users.json does not belong to the local gateway.");
  const [owner, other] = users.users;
  const browserName = arg("browser") ?? (fs.existsSync(BROWSERS.edge) ? "edge" : "chrome");
  const executablePath = process.env.LOCAL_STACK_BROWSER_PATH ?? BROWSERS[browserName];
  if (!executablePath || !fs.existsSync(executablePath)) fail(`Browser not found: ${executablePath ?? browserName}`);
  ensureTools();
  const { chromium } = createRequire(path.join(PATHS.tools, "package.json"))("playwright-core");
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const old of fs.readdirSync(SHOTS)) if (/^v1-.*\.(png|json)$/.test(old)) fs.rmSync(path.join(SHOTS, old));

  const clock = strategyClock();
  const report = {
    startedAt: new Date().toISOString(), app: APP_URL, gateway: GATEWAY_URL, browser: { name: browserName, executablePath }, viewports: { desktop: DESKTOP, mobile: MOBILE },
    strategyClock: clock, owner: owner.email, other: other.email, steps: [], screenshots: [], failureScreenshots: [], consoleErrors: [], devOverlayIssues: [], failures: [],
  };
  let activePage = null; // page captured when a step fails
  const step = async (name, fn, { critical = false } = {}) => {
    const t = Date.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) });
      log(`OK   ${name}${detail ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      report.steps.push({ name, ok: false, ms: Date.now() - t, error: message });
      report.failures.push(`${name}: ${message}`);
      log(`FAIL ${name} - ${message}`);
      if (activePage) {
        const file = path.join(SHOTS, `v1-failure-${report.steps.length}.png`);
        await activePage.screenshot({ path: file, fullPage: true }).catch(() => {});
        if (fs.existsSync(file)) report.failureScreenshots.push(path.relative(LOCAL, file).replaceAll("\\", "/"));
      }
      if (critical) throw error;
      return null;
    }
  };

  // ------------------------------------------------------------------------------------------
  // App lifecycle (tracked files rewritten by `next dev` are restored afterwards)
  // ------------------------------------------------------------------------------------------
  const snapshot = snapshotTrackedFiles();
  let startedApp = false, browser;
  try {
    if (await portOpen(PORTS.app)) {
      if (!flag("reuse-app")) fail(`Port ${PORTS.app} is already in use. Stop that server or pass --reuse-app.`);
      log(`Reusing the app already running on ${APP_URL}`);
    } else {
      await startApp(stack);
      startedApp = true;
    }
    browser = await chromium.launch({ executablePath, headless: !flag("headed"), args: ["--no-first-run", "--no-default-browser-check"] });
    report.browser.version = browser.version();
    log(`Browser: ${browserName} ${browser.version()} (headless=${!flag("headed")}); strategy clock ${clock.day} ${clock.time} UTC-5 (${clock.session})`);

    const newPage = async (label, viewport, mobile = false) => {
      const context = await browser.newContext({ baseURL: APP_URL, viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "en-US", timezoneId: "UTC" });
      context.setDefaultNavigationTimeout(NAV_TIMEOUT);
      context.setDefaultTimeout(ACTION_TIMEOUT);
      const page = await context.newPage();
      page.on("dialog", dialog => dialog.accept().catch(() => {})); // beforeunload guards from dirty forms
      page.on("console", msg => { if (msg.type() === "error") report.consoleErrors.push({ context: label, url: page.url(), source: msg.location()?.url || undefined, text: msg.text().slice(0, 300) }); });
      page.on("pageerror", error => report.consoleErrors.push({ context: label, url: page.url(), text: `pageerror: ${error.message.slice(0, 300)}` }));
      return { context, page };
    };
    const shot = async (page, name) => {
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      // `next dev` draws its indicator/issue badge in <nextjs-portal>. Record any reported issues,
      // then hide it so screenshots show the application UI only.
      const devIssues = await page.evaluate(() => {
        const text = document.querySelector("nextjs-portal")?.shadowRoot?.textContent ?? "";
        return /\d+\s+Issues?/.exec(text)?.[0] ?? null;
      }).catch(() => null);
      if (devIssues) report.devOverlayIssues.push({ page: page.url(), issues: devIssues });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
      // Full-page captures keep position:fixed elements (the mobile tab bar) where they sat in the
      // original viewport. Growing the viewport to the document height first renders them at the
      // true bottom of the page instead of over the middle of the content.
      const viewport = page.viewportSize();
      const grow = viewport.width < 600;
      if (grow) {
        const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
        await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 12000) });
      }
      const file = path.join(SHOTS, `v1-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      if (grow) await page.setViewportSize(viewport);
      report.screenshots.push(path.relative(LOCAL, file).replaceAll("\\", "/"));
    };
    const signIn = async (page, user) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(user.email);
      await page.getByLabel("Password").fill(user.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/today/, { timeout: NAV_TIMEOUT });
    };
    const heading = (page, text) => page.getByRole("heading", { name: text }).first().waitFor();

    // ----------------------------------------------------------------------------------------
    // Desktop 1440x900: owner end to end
    // ----------------------------------------------------------------------------------------
    const desktop = await newPage("desktop", DESKTOP);
    const d = desktop.page;
    activePage = d;
    let accountId, proposalId, screenshotId, riskDecision = null, riskIssues = [], locked = false;

    await step("Desktop: login page renders", async () => { await d.goto("/login"); await heading(d, "Welcome back."); await shot(d, "desktop-login"); }, { critical: true });
    await step("Desktop: owner signs in with email/password", async () => { await signIn(d, owner); return d.url(); }, { critical: true });
    await step("Desktop: demo trading account exists (created if none)", async () => {
      // Wait for the streamed page: either the account-creation form or an account workspace.
      const setup = d.getByRole("heading", { name: "Create your demo account" });
      await setup.or(d.getByRole("link", { name: /New trade/ }).first()).first().waitFor();
      if (await setup.isVisible()) {
        await d.getByLabel("Account name").fill("Local smoke demo (synthetic)");
        await d.getByLabel("Current balance (USD)").fill("10000.00");
        await d.getByLabel("Current equity (USD)").fill("10000.00");
        await d.getByRole("button", { name: "Create demo account" }).click();
        await d.waitForURL(/\/today\?account=/, { timeout: NAV_TIMEOUT });
        accountId = new URL(d.url()).searchParams.get("account");
        return `created account ${accountId}`;
      }
      const href = await d.getByRole("link", { name: /New trade/ }).first().getAttribute("href");
      accountId = new URL(href, APP_URL).searchParams.get("account");
      return `existing account ${accountId}`;
    }, { critical: true });
    await step("Desktop: Today page", async () => {
      await d.goto(`/today?account=${accountId}`);
      await d.locator(".page-heading h1").first().waitFor();
      await shot(d, "desktop-today");
      return (await d.locator(".status-banner, [class*=status]").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) || undefined;
    });
    await step("Desktop: account values recorded if required (Settings)", async () => {
      const stale = await d.getByText("Update today’s account values in Settings").first().isVisible().catch(() => false);
      await d.goto(`/settings?account=${accountId}`);
      await heading(d, "Rules stay under your control.");
      let result = "current observation is from today; no new values required";
      if (stale || flag("record-values")) {
        const panel = d.locator("section.panel", { has: d.getByRole("heading", { name: "Record account values" }) });
        await panel.getByLabel("Current equity (USD)").fill("10000.00");
        await panel.getByLabel("Current balance (USD)").fill("10000.00");
        await panel.getByLabel("Today’s gross realized losses (USD)").fill("0");
        await panel.getByRole("button", { name: "Record new observation" }).click();
        await panel.getByText("A new account observation was recorded.").waitFor();
        result = "recorded a new observation (equity/balance 10000.00, gross loss 0)";
      }
      await shot(d, "desktop-settings");
      return result;
    });
    await step("Desktop: Analyze proposal + risk check (EURUSD LONG 1.10000/1.09800/1.10600, 0.5%)", async () => {
      await d.goto(`/analyze?account=${accountId}`);
      await heading(d, "Build a deliberate trade.");
      await d.getByLabel("Instrument").selectOption({ label: "EURUSD · USD" });
      await d.getByLabel("Direction").selectOption("LONG");
      await d.getByLabel("Execution model").selectOption("OB_FIRST_TOUCH");
      await d.getByLabel("Entry price").fill("1.10000");
      await d.getByLabel("Stop loss").fill("1.09800");
      await d.getByLabel("Target price").fill("1.10600");
      await d.getByLabel("Requested risk (%)").fill("0.5");
      await d.getByLabel("Pre-trade reasoning").fill("Local smoke test (synthetic data): EURUSD long from a first-touch order block after a sell-side liquidity sweep. Invalidation below 1.09800; target 1.10600 (3R).");
      await d.getByLabel("I confirm these contract values match my demo broker.").check();
      await d.getByRole("button", { name: "Run risk check" }).click();
      await d.getByText("SAVED · SERVER-VERIFIED").waitFor();
      const decision = (await d.locator(".decision h3").innerText()).trim();
      const issues = await d.locator(".issue-list .issue").allInnerTexts();
      riskDecision = decision;
      riskIssues = issues.map(t => t.trim());
      await shot(d, "desktop-analyze");
      return { decision, issues: issues.map(s => s.trim()) };
    }, { critical: true });
    await step("Desktop: save proposal for screenshots", async () => {
      await d.getByRole("button", { name: "Save proposal & add screenshots" }).click();
      await d.waitForURL(/\/analyze\/[0-9a-f-]{36}/, { timeout: NAV_TIMEOUT });
      proposalId = d.url().split("/analyze/")[1].split(/[?#]/)[0];
      await heading(d, "Chart evidence");
      return `proposal ${proposalId}`;
    }, { critical: true });
    await step("Desktop: upload generated PNG through /api/setups/[id]/screenshots", async () => {
      const png = syntheticChart();
      await d.getByLabel("Chart timeframe").selectOption("M5");
      await d.locator('input[type="file"][name="file"]').setInputFiles({ name: "eurusd-m5-synthetic.png", mimeType: "image/png", buffer: png });
      const upload = d.waitForResponse(r => r.url().includes(`/api/setups/${proposalId}/screenshots`) && r.request().method() === "POST");
      await d.getByRole("button", { name: "Upload screenshot" }).click();
      const response = await upload;
      if (response.status() !== 201) throw new Error(`upload returned ${response.status()}: ${await response.text()}`);
      screenshotId = (await response.json()).id;
      const img = d.locator(`img[src="/api/screenshots/${screenshotId}"]`);
      await img.waitFor();
      await d.waitForFunction(id => { const el = document.querySelector(`img[src="/api/screenshots/${id}"]`); return el?.complete && el.naturalWidth > 0; }, screenshotId, { timeout: 30000 });
      return `screenshot ${screenshotId} (${png.length} bytes) rendered from private storage`;
    });
    await step("Desktop: recheck risk on the saved proposal", async () => {
      await d.getByRole("button", { name: "Recheck risk" }).click();
      const status = d.locator('p.notice[role="status"]').filter({ hasText: /Risk check saved|Trade blocked|No plan was locked/ });
      await status.first().waitFor();
      return (await status.first().innerText()).trim();
    });
    await step("Desktop: lock decision", async () => {
      if (clock.session === "DEAD_POOL") return `not attempted: Dead Pool (12:00-18:00 UTC-5) at ${clock.time} UTC-5; risk decision ${riskDecision}; reasons: ${riskIssues.join(" | ")}`;
      if (riskDecision !== "RISK APPROVED") return `not attempted: risk decision ${riskDecision}; reasons: ${riskIssues.join(" | ")}`;
      await d.getByRole("button", { name: "Recheck & lock plan" }).click();
      const status = d.locator('p.notice[role="status"]').filter({ hasText: /Plan locked|Trade blocked|No plan was locked/ });
      await status.first().waitFor();
      const text = (await status.first().innerText()).trim();
      locked = text.startsWith("Plan locked");
      if (locked) await d.getByText("PLAN LOCKED").first().waitFor();
      return text;
    });
    await step("Desktop: setup review page", async () => { await d.reload(); await heading(d, "Chart evidence"); await shot(d, "desktop-setup"); });
    await step("Desktop: Journal", async () => {
      await d.goto(`/journal?account=${accountId}`);
      await heading(d, "Your decision record.");
      const count = (await d.locator(".panel-heading h2").first().innerText()).trim();
      await shot(d, "desktop-journal");
      return count;
    });
    await step("Desktop: EDGE", async () => {
      await d.goto(`/edge?account=${accountId}`);
      await heading(d, "Measure the record.");
      await shot(d, "desktop-edge");
    });
    await step("Owner can fetch own screenshot via /api/screenshots/[id]", async () => {
      if (!screenshotId) throw new Error("no screenshot was uploaded");
      const r = await desktop.context.request.get(`/api/screenshots/${screenshotId}`);
      if (r.status() !== 200 || r.headers()["content-type"] !== "image/png") throw new Error(`status ${r.status()} ${r.headers()["content-type"]}`);
      return `200 image/png, ${(await r.body()).length} bytes, cache-control "${r.headers()["cache-control"]}"`;
    });

    // ----------------------------------------------------------------------------------------
    // Mobile 390x844: same pages for layout review
    // ----------------------------------------------------------------------------------------
    const mobile = await newPage("mobile", MOBILE, true);
    const m = mobile.page;
    activePage = m;
    await step("Mobile: login page + sign in", async () => { await m.goto("/login"); await heading(m, "Welcome back."); await shot(m, "mobile-login"); await signIn(m, owner); });
    for (const [name, url, title] of [
      ["today", `/today?account=${accountId}`, null], ["analyze", `/analyze?account=${accountId}`, "Build a deliberate trade."],
      ["setup", proposalId ? `/analyze/${proposalId}` : null, "Chart evidence"], ["journal", `/journal?account=${accountId}`, "Your decision record."],
      ["edge", `/edge?account=${accountId}`, "Measure the record."], ["settings", `/settings?account=${accountId}`, "Rules stay under your control."],
    ]) {
      await step(`Mobile: ${name}`, async () => {
        if (!url) throw new Error("prerequisite step failed");
        await m.goto(url);
        if (title) await heading(m, title); else await m.locator(".page-heading h1").first().waitFor();
        await shot(m, `mobile-${name}`);
      });
    }

    // ----------------------------------------------------------------------------------------
    // Isolation: second synthetic user and anonymous requests
    // ----------------------------------------------------------------------------------------
    const intruder = await newPage("other-user", DESKTOP);
    activePage = intruder.page;
    await step("Second user cannot read the owner's screenshot (app route)", async () => {
      if (!screenshotId) throw new Error("no screenshot was uploaded");
      await signIn(intruder.page, other);
      const r = await intruder.context.request.get(`/api/screenshots/${screenshotId}`);
      const body = await r.text();
      if (![403, 404].includes(r.status())) throw new Error(`expected 403/404, got ${r.status()}: ${body.slice(0, 120)}`);
      return `${r.status()} ${body.slice(0, 120)}`;
    });
    await step("Second user cannot open the owner's proposal page", async () => {
      if (!proposalId) throw new Error("no proposal");
      const response = await intruder.page.goto(`/analyze/${proposalId}`);
      // notFound() runs after the root loading.tsx boundary has streamed, so Next answers 200 with
      // its not-found UI (same in production). Assert on content: not-found shown, no owner data.
      await intruder.page.getByText("This page could not be found.").waitFor();
      if (await intruder.page.getByText("Local smoke test (synthetic data)").count()) throw new Error("owner proposal content leaked");
      await shot(intruder.page, "desktop-other-user-proposal-404");
      return `HTTP ${response.status()} with the not-found page; no owner data rendered`;
    });
    await step("Second user cannot download the object directly from Storage (RLS)", async () => {
      const token = async user => {
        const r = await fetch(`${GATEWAY_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: stack.publishableKey, "content-type": "application/json" }, body: JSON.stringify({ email: user.email, password: user.password }) });
        return (await r.json()).access_token;
      };
      const ownerToken = await token(owner), otherToken = await token(other);
      const rows = await (await fetch(`${GATEWAY_URL}/rest/v1/setup_screenshots?id=eq.${screenshotId}&select=storage_path`, { headers: { apikey: stack.publishableKey, authorization: `Bearer ${ownerToken}` } })).json();
      const objectPath = rows[0]?.storage_path;
      if (!objectPath) throw new Error("owner could not read the screenshot row");
      const url = `${GATEWAY_URL}/storage/v1/object/authenticated/setup-screenshots/${objectPath}`;
      const own = await fetch(url, { headers: { apikey: stack.publishableKey, authorization: `Bearer ${ownerToken}` } });
      const foreign = await fetch(url, { headers: { apikey: stack.publishableKey, authorization: `Bearer ${otherToken}` } });
      const anonymous = await fetch(url, { headers: { apikey: stack.publishableKey } });
      const foreignBody = await foreign.text();
      for (const t of [ownerToken, otherToken]) await fetch(`${GATEWAY_URL}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: stack.publishableKey, authorization: `Bearer ${t}` } });
      if (own.status !== 200 || foreign.status < 400 || anonymous.status < 400) throw new Error(`owner ${own.status}, other ${foreign.status}, anon ${anonymous.status}`);
      return `owner ${own.status}; other user ${foreign.status} ${foreignBody}; anonymous ${anonymous.status}`;
    });
    // ----------------------------------------------------------------------------------------
    // Password recovery through the UI (throwaway synthetic user, deleted afterwards)
    // ----------------------------------------------------------------------------------------
    const adminHeaders = { apikey: stack.secretKey, "content-type": "application/json" };
    let recovery = null, recoveryUserId = null;
    await step("Password recovery: forgot-password -> local mailbox link -> update-password -> sign in", async () => {
      const email = `recovery-${Date.now().toString(36)}@example.test`;
      const created = await (await fetch(`${GATEWAY_URL}/auth/v1/admin/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ email, password: `Tos!${crypto.randomUUID()}`, email_confirm: true }) })).json();
      if (!created.id) throw new Error(`could not create the throwaway user: ${JSON.stringify(created)}`);
      recoveryUserId = created.id;
      recovery = await newPage("recovery", DESKTOP);
      activePage = recovery.page;
      const p = recovery.page;
      await p.goto("/forgot-password");
      await p.getByLabel("Email").fill(email);
      await p.getByRole("button", { name: "Send recovery email" }).click();
      await p.getByText("If an account can receive recovery email").waitFor();
      await shot(p, "desktop-forgot-password");
      const mailbox = await (await fetch(`${GATEWAY_URL}/auth/v1/__local/mailbox?email=${encodeURIComponent(email)}`, { headers: adminHeaders })).json();
      const link = mailbox.messages?.at(-1)?.link;
      if (!link) throw new Error("no recovery link in the local mailbox");
      await p.goto(link); // gateway /verify -> 303 -> /update-password?code=... (PKCE verifier in this browser's cookies)
      await p.getByLabel("New password", { exact: true }).waitFor(); // shown once the server action exchanged the code
      const newPassword = `Tos!${crypto.randomUUID()}`;
      await p.getByLabel("New password", { exact: true }).fill(newPassword);
      await p.getByLabel("Confirm new password").fill(newPassword);
      await shot(p, "desktop-update-password");
      await p.getByRole("button", { name: "Update password" }).click();
      await p.waitForURL(/\/login\?reason=password_updated/, { timeout: NAV_TIMEOUT });
      await p.getByText("Password updated. Sign in with your new password.").waitFor();
      await signIn(p, { email, password: newPassword });
      return `recovered ${email} and signed in with the new password`;
    });
    if (recovery) await recovery.context.close().catch(() => {});
    if (recoveryUserId) await fetch(`${GATEWAY_URL}/auth/v1/admin/users/${recoveryUserId}`, { method: "DELETE", headers: adminHeaders }).catch(() => {});
    activePage = intruder.page;
    await step("Anonymous request to /api/screenshots/[id] is rejected", async () => {
      const r = await fetch(`${APP_URL}/api/screenshots/${screenshotId}`);
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
      return `401 ${(await r.text()).slice(0, 80)}`;
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (startedApp) { await stopApp(); log("Stopped the Next.js dev server"); }
    const restored = startedApp ? restoreTrackedFiles(snapshot) : [];
    if (restored.length) log(`Restored tracked files rewritten by next dev: ${restored.join(", ")}`);
    try { report.openaiNetworkAudit = JSON.parse(fs.readFileSync(path.join(LOCAL, "audit-network.json"), "utf8")); } catch { /* app not started here */ }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(SHOTS, "v1-smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    log(`Report: ${path.join(SHOTS, "v1-smoke-report.json")}`);
  }
  log(`Screenshots (${report.screenshots.length}): ${report.screenshots.join(", ")}`);
  if (report.consoleErrors.length) log(`Browser console errors: ${report.consoleErrors.length} (see report)`);
  if (report.failures.length) fail(`${report.failures.length} smoke step(s) failed:\n  ${report.failures.join("\n  ")}`);
  log(`V1 BROWSER SMOKE PASSED: ${report.steps.length} steps`);
});
