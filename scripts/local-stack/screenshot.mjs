#!/usr/bin/env node
// Full-page screenshots of the running app as a SYNTHETIC user, for browser acceptance (docs/V2_ARCHITECTURE.md §16.2).
// Signs in through the real /login page with playwright-core (from .local/tools) and an installed Edge or Chrome,
// captures one PNG per path, prints browser console errors and failed requests, writes a JSON report, and
// exits non-zero when a page answers HTTP >= 400 (>= 500 only with --allow-4xx), cannot be loaded, or sign-in fails.
//
// Usage: node scripts/local-stack/screenshot.mjs --user=<email> --out=<dir> [--start-app] [--base=http://127.0.0.1:3000]
//        [--viewport=1440x1000|393x852] [--theme=light|dark] [--allow-4xx] [--browser=edge|chrome] [--timezone=UTC]
//        [--headed] <path ...>
//   --start-app  starts `npx pnpm@11.19.0 dev` for this run exactly like browser-smoke.mjs (local Supabase variables,
//                AI_ENABLED=false, the no-openai-network preload), stops it afterwards and restores the tracked files
//                `next dev` rewrites (next-env.d.ts). Without it the app must already run on --base.
//   --base       loopback origins only (127.0.0.1, localhost, [::1]): the script signs in with local passwords.
//   --allow-4xx  a page answering 4xx (e.g. a screen that does not exist yet) is reported but does not fail the run.
//   Paths are app paths with or without the leading slash (/today, journal, "trades/<id>?tab=x"); Git Bash rewrites
//   arguments that start with "/" into Windows paths, so there either omit the slash or set MSYS_NO_PATHCONV=1.
//   For users seeded by seed-v2.mjs, `@name` stands for one of the user's showcase ids: a path that starts with a trade
//   name opens that trade (@todayBlocked -> /trades/<id>, @todayBlocked/edit), one that starts with an account key opens
//   that account (@ftmo/manage -> /accounts/<id>/manage), and anywhere else the id is substituted
//   (journal?account=@personal). In PowerShell quote such arguments ("@todayBlocked"): a bare @ splats a variable.
//   /login, /forgot-password and /update-password are captured signed out. The password comes from SCREENSHOT_PASSWORD,
//   .local/seed-v2-users.json (seed-v2.mjs) or .local/integration-users.json (provision-users.mjs); it is never accepted
//   on the command line. Files: <out>/<path-slug>.<width>x<height>.<theme>.png.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { restoreTrackedFiles, snapshotTrackedFiles, startApp, stopApp } from "./control.mjs";
import { failureSummary, judgePages, loopbackBase, nextEnvRewrittenByDev } from "./fixtures/screenshot-rules.mjs";
import { APP_URL, GATEWAY_URL, LOCAL, PATHS, PORTS, REPO, ensureTools, fail, httpStatus, log, portOpen, readStack, runMain } from "./lib.mjs";

const BROWSERS = {
  edge: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  chrome: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
};
const PUBLIC_PAGES = new Set(["/login", "/forgot-password", "/update-password"]);
const NAV_TIMEOUT = 180_000; // the first request to each dev route compiles it
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = name => process.argv.includes(`--${name}`);

function parseViewport(value) {
  const match = /^(\d{3,4})x(\d{3,5})$/.exec(value ?? "1440x1000");
  if (!match) fail(`--viewport must look like 1440x1000 or 393x852, got "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The showcase ids seed-v2.mjs saved for this user ({trades, accounts}), or null. */
function showcaseFor(email) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(LOCAL, "seed-v2-users.json"), "utf8"));
    return data.project === GATEWAY_URL ? (data.users?.find(u => u.email === email)?.showcase ?? null) : null;
  } catch {
    return null;
  }
}

/** Resolves `@name` tokens (see the usage above) into an app path with a leading slash. */
function resolvePath(raw, showcase, email) {
  const trades = showcase?.trades ?? {};
  const accounts = showcase?.accounts ?? {};
  const unknown = [];
  const url = raw.replace(/@([A-Za-z][A-Za-z0-9]*)/g, (token, name) => {
    const id = trades[name] ?? accounts[name];
    if (!id) unknown.push(name);
    return id ?? token;
  });
  if (unknown.length) {
    const known = [...Object.keys(trades), ...Object.keys(accounts)];
    fail(`${raw}: ${email} has no showcase id named ${unknown.join(", ")}. ${known.length ? `Known: ${known.join(", ")}.` : "Seed the user with seed-v2.mjs first."}`);
  }
  const lead = /^@([A-Za-z][A-Za-z0-9]*)/.exec(raw)?.[1];
  if (lead) return `/${accounts[lead] ? "accounts" : "trades"}/${url}`;
  return url.startsWith("/") ? url : `/${url}`;
}

/** `/trades/abc?tab=x` -> `trades-abc-tab-x`; `@todayBlocked/edit` -> `todayblocked-edit`; `/` -> `root`. */
function slugOf(pagePath) {
  const slug = pagePath.replace(/^[/@]+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (slug || "root").slice(0, 80);
}

function passwordFor(email) {
  if (process.env.SCREENSHOT_PASSWORD) return process.env.SCREENSHOT_PASSWORD;
  for (const file of [path.join(LOCAL, "seed-v2-users.json"), PATHS.users]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const match = data.project === GATEWAY_URL ? data.users?.find(u => u.email === email) : null;
      if (match?.password) return match.password;
    } catch { /* not present */ }
  }
  return fail(`No password known for ${email}. Seed it (node scripts/local-stack/seed-v2.mjs) or set SCREENSHOT_PASSWORD.`);
}

function browserPath(name) {
  if (process.env.LOCAL_STACK_BROWSER_PATH) return process.env.LOCAL_STACK_BROWSER_PATH;
  const names = name ? [name] : ["edge", "chrome"];
  for (const candidate of names.flatMap(n => BROWSERS[n] ?? [])) if (fs.existsSync(candidate)) return candidate;
  return fail(`No installed ${name ?? "Edge or Chrome"} browser was found. Set LOCAL_STACK_BROWSER_PATH to its executable.`);
}

await runMain(async () => {
  const email = arg("user");
  const outArg = arg("out");
  const rawPages = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if (!email || !outArg || !rawPages.length) {
    fail("Usage: node scripts/local-stack/screenshot.mjs --user=<email> --out=<dir> [--start-app] [--base=URL] [--viewport=1440x1000|393x852] [--theme=light|dark] [--allow-4xx] <path ...>");
  }
  const mangled = rawPages.find(p => /^\/?[A-Za-z]:[\\/]/.test(p));
  if (mangled) fail(`"${mangled}" looks like a path rewritten by Git Bash. Omit the leading slash (today) or set MSYS_NO_PATHCONV=1.`);
  // Sign-in types a stored local password into the page, so only loopback origins (the local stack) are accepted.
  const checked = loopbackBase(arg("base") ?? APP_URL);
  if (checked.error) fail(checked.error);
  const { base } = checked;
  const ownApp = flag("start-app");
  if (ownApp && base !== APP_URL) fail(`--start-app runs the app on ${APP_URL}; leave out --base or pass --base=${APP_URL}.`);
  const allow4xx = flag("allow-4xx");
  const showcase = rawPages.some(p => p.includes("@")) ? showcaseFor(email) : null;
  // label: what the caller asked for (it names the file); url: the app path that is opened.
  const pages = rawPages.map(raw => ({ label: raw.startsWith("@") || raw.startsWith("/") ? raw : `/${raw}`, url: resolvePath(raw, showcase, email) }));
  const viewport = parseViewport(arg("viewport"));
  const theme = arg("theme") ?? "light";
  if (theme !== "light" && theme !== "dark") fail('--theme must be "light" or "dark"');
  const mobile = viewport.width < 768;
  const out = path.resolve(outArg);
  const reportFile = path.join(out, `screenshot-report.${viewport.width}x${viewport.height}.${theme}.json`);
  const password = passwordFor(email);
  const stack = ownApp ? readStack() : null;
  if (ownApp) {
    if (!stack) fail("Missing .local/stack.json. Start the stack first: node scripts/local-stack/start.mjs");
    if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`The local gateway is not healthy at ${GATEWAY_URL}. Run node scripts/local-stack/start.mjs first.`);
    if (await portOpen(PORTS.app)) {
      fail(`Port ${PORTS.app} is already in use, so --start-app cannot start the app. Leave out --start-app to capture from the running app, or stop it first (stop.mjs stops one started by this script or browser-smoke.mjs).`);
    }
  } else {
    try {
      const probe = await fetch(`${base}/login`, { redirect: "manual", signal: AbortSignal.timeout(NAV_TIMEOUT) });
      await probe.arrayBuffer();
    } catch {
      fail(`The app is not reachable at ${base}. Pass --start-app to start it for this run.`);
    }
  }
  ensureTools();
  const { chromium } = createRequire(path.join(PATHS.tools, "package.json"))("playwright-core");
  const executablePath = browserPath(arg("browser"));
  fs.mkdirSync(out, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(), base, startedApp: ownApp, allow4xx, user: email, viewport, theme, mobile, browser: executablePath,
    pages: [], consoleErrors: [], failedRequests: [], errors: [],
  };
  let browser = null;
  const newContext = async () => {
    const context = await browser.newContext({
      baseURL: base, viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "en-US",
      timezoneId: arg("timezone") ?? "UTC", colorScheme: theme, reducedMotion: "reduce",
    });
    // The app's own theme preference (cookie tos_theme); colorScheme covers pages that follow the system theme.
    await context.addCookies([{ name: "tos_theme", value: theme, url: base, sameSite: "Lax" }]);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    context.setDefaultTimeout(60_000);
    const page = await context.newPage();
    page.on("console", message => {
      if (message.type() !== "error") return;
      const source = message.location()?.url?.replace(base, "") || undefined;
      report.consoleErrors.push({ page: page.url(), text: message.text().slice(0, 2000), ...(source ? { source } : {}) });
    });
    page.on("pageerror", error => report.consoleErrors.push({ page: page.url(), text: `pageerror: ${error.message.slice(0, 2000)}` }));
    page.on("requestfailed", request => report.failedRequests.push({ page: page.url(), url: request.url().replace(base, ""), failure: request.failure()?.errorText ?? "failed" }));
    // Page navigations are reported per page; this lists failing subresources and fetches (server actions, images, …).
    page.on("response", response => {
      if (response.status() >= 400 && response.url().startsWith(base) && !response.request().isNavigationRequest()) {
        report.failedRequests.push({ page: page.url(), url: response.url().replace(base, ""), status: response.status() });
      }
    });
    return { context, page };
  };

  const capture = async (page, { label, url: pagePath }) => {
    const started = Date.now();
    const entry = { path: pagePath, ...(label !== pagePath ? { label } : {}), file: null, status: null, finalUrl: null, ms: 0 };
    try {
      const response = await page.goto(pagePath, { waitUntil: "load" });
      entry.status = response?.status() ?? null;
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      entry.finalUrl = page.url().replace(base, "");
      // `next dev` draws its indicator in <nextjs-portal>: record reported issues, then hide it from the capture.
      entry.devOverlay = await page.evaluate(() => /\d+\s+Issues?/.exec(document.querySelector("nextjs-portal")?.shadowRoot?.textContent ?? "")?.[0] ?? null).catch(() => null);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
      entry.documentTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null).catch(() => null);
      // Fixed elements (mobile tab bar) stay where they were in the viewport during full-page captures; growing the
      // viewport to the document height first renders them at the true bottom of the page.
      const grow = mobile;
      if (grow) {
        const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
        await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 16_000) });
      }
      const file = path.join(out, `${slugOf(label)}.${viewport.width}x${viewport.height}.${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      if (grow) await page.setViewportSize(viewport);
      entry.file = path.relative(process.cwd(), file);
    } catch (error) {
      entry.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
      report.errors.push(`${label}: ${entry.error}`);
    }
    entry.ms = Date.now() - started;
    report.pages.push(entry);
    log(`${entry.status ?? "ERR"} ${label !== pagePath ? `${label} (${pagePath})` : pagePath}${entry.finalUrl && entry.finalUrl !== pagePath ? ` -> ${entry.finalUrl}` : ""}${entry.file ? ` -> ${entry.file}` : ""}${entry.error ? ` (${entry.error})` : ""}`);
  };

  const captureAll = async () => {
    browser = await chromium.launch({ executablePath, headless: !flag("headed"), args: ["--no-first-run", "--no-default-browser-check"] });
    report.browserVersion = browser.version();
    const publicPages = pages.filter(p => PUBLIC_PAGES.has(p.url.split("?")[0]));
    const privatePages = pages.filter(p => !PUBLIC_PAGES.has(p.url.split("?")[0]));
    if (publicPages.length) {
      const { context, page } = await newContext();
      for (const pagePath of publicPages) await capture(page, pagePath);
      await context.close();
    }
    if (privatePages.length) {
      const { context, page } = await newContext();
      await page.goto("/login");
      await page.locator('input[type="email"], input[name="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.getByRole("button", { name: /sign in/i }).first().click();
      try {
        await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: NAV_TIMEOUT });
      } catch {
        const alert = await page.locator('[role="alert"], .notice.danger').first().innerText().catch(() => "");
        throw new Error(`Sign-in did not leave /login${alert ? `: ${alert.trim()}` : ""}`);
      }
      log(`Signed in as ${email} (${page.url().replace(base, "")})`);
      for (const pagePath of privatePages) await capture(page, pagePath);
      await context.close();
    }
  };

  // With --start-app: `next dev` rewrites tracked files (next-env.d.ts), so they are snapshotted before it starts and
  // restored after it stops - also when the run fails or is interrupted with Ctrl+C.
  const snapshot = ownApp ? snapshotTrackedFiles() : null;
  let stopping = null;
  const stopOwnApp = () => {
    stopping ??= (async () => {
      const stopped = await stopApp().catch(() => false);
      const restored = restoreTrackedFiles(snapshot);
      log(`${stopped ? "Stopped the Next.js dev server" : "The Next.js dev server was not running"}${restored.length ? `; restored ${restored.join(", ")} (rewritten by next dev)` : ""}`);
    })();
    return stopping;
  };
  const onInterrupt = () => {
    log("Interrupted");
    stopOwnApp().finally(() => process.exit(130));
  };
  let verdict = judgePages([], { allow4xx });
  if (ownApp) process.once("SIGINT", onInterrupt);
  try {
    if (ownApp) await startApp(stack);
    try {
      await captureAll();
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
    } finally {
      if (browser) await browser.close().catch(() => {});
      verdict = judgePages(report.pages, { allow4xx });
      report.notOk = verdict.notOk.map(p => ({ path: p.path, ...(p.label ? { label: p.label } : {}), status: p.status, failsRun: verdict.failing.includes(p) }));
      report.finishedAt = new Date().toISOString();
      fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    if (ownApp) {
      process.removeListener("SIGINT", onInterrupt);
      await stopOwnApp();
    }
  }

  if (report.consoleErrors.length) {
    log(`Browser console errors (${report.consoleErrors.length}):`);
    for (const e of report.consoleErrors.slice(0, 40)) log(`  ${e.page.replace(base, "")}: ${e.text.split("\n")[0]}${e.source ? ` [${e.source}]` : ""}`);
  }
  if (report.failedRequests.length) {
    log(`Failed requests (${report.failedRequests.length}):`);
    for (const r of report.failedRequests.slice(0, 40)) log(`  ${r.status ?? r.failure} ${r.url} (on ${r.page.replace(base, "")})`);
  }
  if (verdict.notOk.length) {
    log(`Pages that did not answer 2xx (${verdict.notOk.length} of ${report.pages.length}):`);
    for (const p of verdict.notOk) {
      const allowed = !verdict.failing.includes(p) && p.status !== null && p.status >= 400;
      log(`  ${p.status ?? "ERR"} ${p.label ? `${p.label} (${p.path})` : p.path}${allowed ? " - allowed by --allow-4xx" : ""}`);
    }
  }
  try {
    if (nextEnvRewrittenByDev(fs.readFileSync(path.join(REPO, "next-env.d.ts"), "utf8"))) {
      log("Note: the tracked next-env.d.ts points at .next/dev/types because `next dev` rewrote it; restore it before committing (git checkout -- next-env.d.ts).");
    }
  } catch { /* no next-env.d.ts */ }
  log(`Report: ${path.relative(process.cwd(), reportFile)}`);
  if (report.errors.length || verdict.failing.length) {
    const pagesPart = verdict.failing.length ? failureSummary(verdict, report.pages.length, { allow4xx }) : "";
    fail([pagesPart, ...report.errors].filter(Boolean).join("; "));
  }
  log(`Captured ${report.pages.length} page(s) into ${path.relative(process.cwd(), out) || "."}`);
});
