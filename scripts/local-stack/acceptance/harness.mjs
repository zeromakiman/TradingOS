// Browser harness of the acceptance runner: launches an installed Edge/Chrome through playwright-core (.local/tools),
// opens signed-in sessions per viewport and theme, runs named steps that record pass/fail with their evidence and
// screenshots, scans every screen it reaches (after each navigation, before each phone tap, at each screenshot and at
// the end of each step) for raw internals, the context selector and phone width, and writes results.json + summary.md
// after every step (a run that is interrupted keeps what it found).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PATHS, REPO, ensureTools } from "../lib.mjs";
import { foldInputNotes, judgeCriteria, passMatrix, renderSummary, scanVisibleText, screenOf, VIEWPORTS } from "./rules.mjs";
import { navigate, observe, takeInputNotes } from "./ui.mjs";

const BROWSERS = {
  edge: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  chrome: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
};
export const ACTION_TIMEOUT = 45_000;
const NAVIGATION_TIMEOUT = 180_000; // the first request to a dev route compiles it

/** Installed Edge (preferred) or Chrome; LOCAL_STACK_BROWSER_PATH overrides. */
export function browserPath(name) {
  if (process.env.LOCAL_STACK_BROWSER_PATH) return process.env.LOCAL_STACK_BROWSER_PATH;
  for (const candidate of (name ? [name] : ["edge", "chrome"]).flatMap(n => BROWSERS[n] ?? [])) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`No installed ${name ?? "Edge or Chrome"} browser was found. Set LOCAL_STACK_BROWSER_PATH to its executable.`);
}

export async function launchBrowser({ browser, headed }) {
  ensureTools();
  const { chromium } = createRequire(path.join(PATHS.tools, "package.json"))("playwright-core");
  const executablePath = browserPath(browser);
  const instance = await chromium.launch({ executablePath, headless: !headed, args: ["--no-first-run", "--no-default-browser-check"] });
  return { instance, info: { name: path.basename(executablePath, ".exe"), version: instance.version(), executablePath } };
}

// ---------------------------------------------------------------------------------------------------------------
// Recorder: results.json + summary.md
// ---------------------------------------------------------------------------------------------------------------
export class Recorder {
  constructor({ runId, out, base, flows, viewports, browser, clock }) {
    this.out = out;
    this.results = {
      runId, base, startedAt: new Date().toISOString(), finishedAt: null, verdict: "running", verdictReasons: [], flows, viewports, browser,
      clock: { start: clock, end: null }, users: [], matrix: {}, steps: [], criteria: [], uxCriteria: [], scans: [], warnings: [], notes: [],
    };
    this.scanKeys = new Set();
  }

  note(text) {
    this.results.notes.push(text);
  }

  addStep(step) {
    this.results.steps.push(step);
    this.write();
  }

  criterion(record) {
    this.results.criteria.push(record);
  }

  warn(record) {
    // Repeated identical warnings (for example the same console error on every page) are kept once per screen.
    const key = `${record.kind}|${record.screen}|${record.text}`;
    if (this.results.warnings.some(w => `${w.kind}|${w.screen}|${w.text}` === key)) return;
    this.results.warnings.push(record);
  }

  addScan(scan) {
    this.results.scanCount = (this.results.scanCount ?? 0) + 1;
    // One record per screen, viewport and theme for each distinct finding (raw internals, missing context selector,
    // wider than the phone), so a later scan that finds something new is never folded into an earlier clean one.
    const key = `${scan.screen}|${scan.viewport}|${scan.theme}|${scan.hits.map(hit => hit.match).join(",")}|${scan.selector ? "selector" : "no-selector"}|${scan.overflowPx > 1 ? "wide" : ""}`;
    if (this.scanKeys.has(key)) return;
    this.scanKeys.add(key);
    this.results.scans.push(scan);
  }

  finish(verdict, clock, reasons = []) {
    this.results.finishedAt = new Date().toISOString();
    this.results.verdict = verdict;
    this.results.verdictReasons = reasons;
    this.results.clock.end = clock;
    this.write();
  }

  write() {
    const r = this.results;
    r.uxCriteria = judgeCriteria(r.criteria);
    r.matrix = passMatrix(r.steps, r.flows, r.viewports);
    fs.writeFileSync(path.join(this.out, "results.json"), `${JSON.stringify(r, null, 2)}\n`);
    fs.writeFileSync(path.join(this.out, "summary.md"), renderSummary(r));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------
/** Signs in through the real /login page and waits until the app left it. */
export async function signIn(page, user) {
  const email = page.locator('input[type="email"], input[name="email"]').first();
  await navigate(page, "/login");
  // The dev server may still be compiling /login after a code change elsewhere: one more load before giving up.
  if (!(await email.waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false))) {
    await navigate(page, "/login");
    await email.waitFor({ state: "visible", timeout: 90_000 });
  }
  await email.fill(user.email);
  await page.locator('input[type="password"]').first().fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  // Either the app leaves /login, or the page announces why it did not (a refused sign-in answers within seconds).
  const refused = page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).first();
  const outcome = await Promise.race([
    page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: NAVIGATION_TIMEOUT }).then(() => "signed-in"),
    refused.waitFor({ state: "visible", timeout: NAVIGATION_TIMEOUT }).then(() => "refused"),
  ]).catch(() => "timeout");
  if (outcome === "signed-in") return;
  const alert = await refused.innerText({ timeout: 1_000 }).catch(() => "");
  throw new Error(`Sign-in did not leave /login${alert ? `: ${alert.trim()}` : ""}`);
}

/**
 * A browser context for one viewport and theme (the app's tos_theme cookie plus the browser colour scheme), optionally
 * signed in. Console errors, page errors, failed same-origin requests and Next dev-overlay issues become warnings.
 */
export async function openSession(env, { user, viewport, theme = "light", flow, developer = false }) {
  const vp = VIEWPORTS[viewport];
  const context = await env.browser.newContext({
    baseURL: env.base, viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile,
    locale: "en-US", timezoneId: "UTC", colorScheme: theme, reducedMotion: "reduce", acceptDownloads: true,
  });
  const cookies = [{ name: "tos_theme", value: theme, url: env.base, sameSite: "Lax" }];
  if (developer) cookies.push({ name: "tos_dev", value: "1", url: env.base, sameSite: "Lax" });
  await context.addCookies(cookies);
  context.setDefaultTimeout(ACTION_TIMEOUT);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  const page = await context.newPage();
  const where = () => ({ flow, viewport, screen: screenOf(new URL(page.url()).pathname) });
  page.on("console", message => {
    if (message.type() === "error") env.recorder.warn({ ...where(), kind: "console", text: message.text().slice(0, 1_000) });
  });
  // React's hydration errors carry the mismatching markup after a long preamble: keep enough of it to find the cause.
  page.on("pageerror", error => env.recorder.warn({ ...where(), kind: "pageerror", text: error.message.slice(0, 2_500) }));
  page.on("response", response => {
    if (response.status() >= 400 && response.url().startsWith(env.base)) {
      env.recorder.warn({ ...where(), kind: `http ${response.status()}`, text: `${response.request().method()} ${response.url().replace(env.base, "").split("?")[0]}` });
    }
  });
  // The runner leaves pages on purpose: a form's "leave this page?" question (beforeunload) is answered with leave.
  // The app asks everything else in its own dialogs, so a native alert, confirm or prompt is reported and dismissed.
  page.on("dialog", dialog => {
    if (dialog.type() !== "beforeunload") env.recorder.warn({ ...where(), kind: "native dialog", text: `${dialog.type()}: ${dialog.message().slice(0, 200)}` });
    (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  if (user) {
    try {
      await signIn(page, user);
    } catch (error) {
      // Keep what the browser showed instead of the sign-in form, then report the failure.
      const dir = path.join(env.out, "screens", viewport, flow ?? "session");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `signin-failure-${Date.now()}.png`);
      await page.screenshot({ path: file, scale: "css" }).catch(() => {});
      await context.close().catch(() => {});
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(`${reason} (screenshot ${path.relative(env.out, file).replace(/\\/g, "/")})`);
    }
  }
  return { context, page, theme, close: () => context.close().catch(() => {}) };
}

/**
 * Waits (at most `timeout`) until every image drawn inside the viewport has finished loading or failed, so a capture
 * shows the screenshot thumbnails instead of their placeholders. Never fails: a slow image is captured as it is.
 */
export async function imagesInView(page, timeout = 8_000) {
  await page.waitForFunction(() => [...document.images].filter(img => {
    const rect = img.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && getComputedStyle(img).visibility !== "hidden";
  }).every(img => img.complete), undefined, { timeout, polling: 200 }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------
export class CheckFailed extends Error {}
class SkipStep extends Error {}

/** What a step body receives: the page, assertions that record evidence, screenshots and the clock escape. */
class StepApi {
  constructor(run, record) {
    this.run = run;
    this.record = record;
    this.criterionMessages = new Map();
  }

  get page() {
    return this.run.page;
  }

  /** Records an assertion; a false condition fails the step with `message`. */
  check(condition, message, detail) {
    this.record.evidence.push({ ok: Boolean(condition), message, ...(detail === undefined ? {} : { detail }) });
    if (!condition) throw new CheckFailed(detail === undefined ? message : `${message} (${typeof detail === "string" ? detail : JSON.stringify(detail)})`);
  }

  info(message, detail) {
    this.record.evidence.push({ ok: true, info: true, message, ...(detail === undefined ? {} : { detail }) });
  }

  /** The sentence recorded for one of the step's criteria instead of the step title. */
  evidence(criterion, message) {
    this.criterionMessages.set(criterion, message);
  }

  /**
   * The real strategy clock refused this action (for example a lock during Dead Pool): expected, not a failure. Flows
   * call it only after checking the refusal against the strategy clock itself (rules.mjs deadPoolExpectation), so a
   * Risk Engine that blocks outside 12:00–18:00 UTC−5 fails instead.
   */
  clock(note) {
    this.record.status = "clock";
    this.record.clockNote = note;
    this.info(note);
  }

  skip(note) {
    this.record.status = "skipped";
    this.record.skipNote = note;
    throw new SkipStep(note);
  }

  /** Viewport screenshot (or full page) into screens/<viewport>/<flow>/; returns the path relative to the run dir. */
  async shot(name, { full = false } = {}) {
    return this.run.screenshot(name, { full, record: this.record });
  }
}

/** One flow at one viewport: its session, named steps and shared state. */
export class FlowRun {
  constructor(env, flow, viewport) {
    this.env = env;
    this.flow = flow;
    this.viewport = viewport;
    this.vp = VIEWPORTS[viewport];
    this.mobile = this.vp.mobile;
    this.session = null;
    /** Steps whose body ran to the end and whose checks held; their only possible failure is a missed phone tap. */
    this.completed = new Set();
    this.passed = new Set();
    this.failed = new Set();
    this.state = {};
    this.shots = 0;
    /** The record of the step that is running (missed taps attach their screenshot to it). */
    this.current = null;
  }

  get page() {
    if (!this.session) throw new Error("No browser session is open for this flow");
    return this.session.page;
  }

  get theme() {
    return this.session?.theme ?? "light";
  }

  log(message) {
    this.env.log(`[${this.flow}/${this.viewport}] ${message}`);
  }

  /**
   * Opens (or replaces) the flow's browser session, signed in as `user` when given. Every screen the page then reaches
   * is scanned once its navigation settled and again right before each phone tap; a missed tap is photographed.
   */
  async open(user, options = {}) {
    await this.close();
    this.session = await openSession(this.env, { user, viewport: this.viewport, flow: this.flow, ...options });
    observe(this.session.page, {
      arrived: () => this.scan(),
      beforeTap: () => this.scan(),
      tapMissed: () => this.screenshot(`${this.current?.id ?? "step"}-tap-missed`, { record: this.current }),
    });
    return this.session.page;
  }

  async close() {
    if (this.session) await this.session.close();
    this.session = null;
  }

  /**
   * Captures the page into `file`. A full-page capture first grows the viewport to the document height, so fixed parts
   * of the shell (sidebar, top bar, phone tab bar) are drawn once at their true place instead of wherever the page was
   * scrolled; the viewport is restored afterwards. `quiet` also hides transient toasts (documentation images); `top`
   * scrolls to the top first. Images in view (screenshot thumbnails load lazily) get a few seconds to arrive.
   */
  async capture(file, { full, scale, quiet = false, top = false }) {
    const page = this.session.page;
    // Hidden only for the capture (the dev indicator, and toasts in documentation images); removed right after, so
    // the page under test keeps announcing results.
    const style = await page.addStyleTag({ content: `nextjs-portal { display: none !important; }${quiet ? ' [aria-label="Notifications"] { display: none !important; }' : ""}` }).catch(() => null);
    // A focused skip link would be drawn over the page; leave focus where it is otherwise.
    await page.evaluate(scrollTop => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches('a[href="#main-content"]')) active.blur();
      if (scrollTop) window.scrollTo(0, 0);
    }, top).catch(() => {});
    let grown = false;
    try {
      if (full) {
        const height = await page.evaluate(() => {
          window.scrollTo(0, 0);
          return Math.ceil(document.documentElement.scrollHeight);
        });
        await page.setViewportSize({ width: this.vp.width, height: Math.min(Math.max(height, this.vp.height), 12_000) });
        grown = true;
        await page.waitForTimeout(150);
      }
      await imagesInView(page);
      await page.screenshot({ path: file, scale, animations: "disabled" });
    } finally {
      if (grown) await page.setViewportSize({ width: this.vp.width, height: this.vp.height });
      await style?.evaluate(element => element.remove()).catch(() => {});
    }
  }

  async screenshot(name, { full = false, record = null } = {}) {
    if (!this.session) return null;
    this.shots += 1;
    const dir = path.join(this.env.out, "screens", this.viewport, this.flow);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(this.shots).padStart(2, "0")}-${name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}${this.theme === "dark" ? ".dark" : ""}.png`);
    await this.capture(file, { full, scale: "css" });
    const relative = path.relative(this.env.out, file).replace(/\\/g, "/");
    if (record) record.screenshots.push(relative);
    await this.scan().catch(() => {});
    return relative;
  }

  /**
   * A documentation screenshot (docs/v2-screens candidates): device pixels, viewport (optionally scrolled to the
   * `top`) or full page, kept in <run>/curated/<key>-<viewport>[-dark].png and listed in env.curated with its title.
   */
  async curate(key, title, { full = false, top = false } = {}) {
    if (!this.session) return null;
    const page = this.session.page;
    const name = `${key}-${this.viewport}${this.theme === "dark" ? "-dark" : ""}`;
    const dir = path.join(this.env.out, "curated");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    // Long phone pages captured whole stay at CSS pixels (a 2× capture would not fit the size budget); short ones keep
    // the phone's 2× pixels like every viewport capture.
    const height = full ? await page.evaluate(() => document.documentElement.scrollHeight).catch(() => Number.POSITIVE_INFINITY) : 0;
    const scale = this.mobile && height > 1_800 ? "css" : "device";
    await this.capture(file, { full, top, scale, quiet: true });
    const entry = { name, key, title, viewport: this.viewport, theme: this.theme, flow: this.flow, full, screen: screenOf(new URL(page.url()).pathname), file: path.relative(this.env.out, file).replace(/\\/g, "/") };
    this.env.curated = [...(this.env.curated ?? []).filter(item => item.name !== name), entry];
    return entry.file;
  }

  /** Scans the visible text of the current screen for raw internals and checks the context selector is shown. */
  async scan() {
    if (!this.session) return;
    const page = this.session.page;
    let pathname;
    try {
      pathname = new URL(page.url()).pathname;
    } catch {
      return;
    }
    if (!pathname || pathname === "blank") return;
    const facts = await page.evaluate(deviceWidth => {
      const portal = document.querySelector("nextjs-portal");
      const text = document.body ? document.body.innerText : "";
      const selector = [...document.querySelectorAll("button")].find(b => /^Trading Account:/.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
      // A phone browser widens its layout viewport to fit wider content (innerWidth grows with it), so the overflow is
      // measured against the device width. The culprit is the most deeply nested element reaching furthest right;
      // fixed bars (the phone tab bar) only stretch to whatever width the layout got, so they are never named.
      const layout = Math.max(document.documentElement.scrollWidth, window.innerWidth);
      let widest = null;
      if (layout > deviceWidth + 1) {
        const fixed = new Map();
        const isFixed = element => {
          if (!element || element === document.body) return false;
          if (!fixed.has(element)) fixed.set(element, getComputedStyle(element).position === "fixed" || isFixed(element.parentElement));
          return fixed.get(element);
        };
        let best = null;
        for (const element of document.body.querySelectorAll("*")) {
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || isFixed(element)) continue;
          const right = box.right + window.scrollX;
          let depth = 0;
          for (let node = element.parentElement; node; node = node.parentElement) depth += 1;
          if (!best || right > best.right + 0.5 || (right > best.right - 0.5 && depth > best.depth)) best = { element, right, depth };
        }
        if (best) {
          const { element, right } = best;
          widest = `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/).slice(0, 4).join(".")} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}" (right edge ${Math.round(right)} px)`;
        }
      }
      return {
        text: portal ? text.replace(portal.innerText ?? "", "") : text,
        selector: selector ? (selector.textContent ?? "").replace(/\s+/g, " ").trim() : null,
        overflow: layout - deviceWidth,
        widest,
        devIssues: /\d+\s+Issues?/.exec(portal?.shadowRoot?.textContent ?? "")?.[0] ?? null,
      };
    }, this.vp.width).catch(() => null);
    if (!facts) return;
    const hits = scanVisibleText(facts.text);
    const overflowPx = Math.max(0, facts.overflow);
    const scan = { screen: screenOf(pathname), viewport: this.viewport, theme: this.theme, flow: this.flow, hits, selector: facts.selector, overflowPx, ...(overflowPx > 1 && facts.widest ? { widest: facts.widest } : {}) };
    this.env.recorder.addScan(scan);
    if (facts.devIssues) this.env.recorder.warn({ flow: this.flow, viewport: this.viewport, screen: scan.screen, kind: "dev overlay", text: facts.devIssues });
  }

  /**
   * Runs one named step. `requires` lists step ids of this flow whose body must have completed with its checks held
   * (otherwise the step is recorded as skipped; a step failed only by a missed phone tap still lets the flow go on);
   * `criteria` lists the §60 UX criteria the step evidences (a passed step records them as met, a failed one as
   * failed). A phone tap that missed its control fails the step (rules.mjs foldInputNotes). Returns the body's value,
   * or undefined when the step neither passed nor was clock-limited.
   */
  async step(id, title, body, { requires = [], criteria = [] } = {}) {
    const record = { flow: this.flow, viewport: this.viewport, id, title, status: "pass", ms: 0, evidence: [], screenshots: [], startedAt: new Date().toISOString() };
    const missing = requires.filter(required => !this.completed.has(required));
    if (missing.length) {
      record.status = "skipped";
      record.skipNote = `requires ${missing.join(", ")}`;
      this.env.recorder.addStep(record);
      this.log(`SKIP ${id} (${record.skipNote})`);
      return undefined;
    }
    const api = new StepApi(this, record);
    const started = Date.now();
    let value;
    this.current = record;
    try {
      value = await body(api);
    } catch (error) {
      if (error instanceof SkipStep) {
        record.status = "skipped";
      } else {
        record.status = "fail";
        record.error = (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 3).join(" ").slice(0, 600);
        await this.screenshot(`${id}-failure`, { record }).catch(() => {});
      }
    } finally {
      this.current = null;
    }
    record.ms = Date.now() - started;
    // What the body itself concluded, before missed taps are folded in.
    const concluded = record.status;
    const notes = takeInputNotes();
    for (const note of notes) this.env.recorder.warn({ flow: this.flow, viewport: this.viewport, screen: note.screen, kind: note.kind, text: note.text });
    foldInputNotes(record, notes);
    await this.scan().catch(() => {});
    if (concluded === "pass") this.completed.add(id);
    if (record.status === "pass") this.passed.add(id);
    if (record.status === "fail") this.failed.add(id);
    for (const criterion of criteria) {
      if (record.status === "pass" || record.status === "fail") {
        this.env.recorder.criterion({
          criterion, ok: record.status === "pass", flow: this.flow, viewport: this.viewport, step: id,
          message: record.status === "pass" ? (api.criterionMessages.get(criterion) ?? title) : `${title}: ${record.error}`,
        });
      }
    }
    this.env.recorder.addStep(record);
    this.log(`${record.status.toUpperCase()} ${id}${record.error ? ` - ${record.error}` : ""}${record.clockNote ? ` - ${record.clockNote}` : ""}`);
    return concluded === "pass" || concluded === "clock" ? value : undefined;
  }

  /** Records a §60 criterion verdict that is not tied to a single step (for example a scan over every screen). */
  criterion(id, ok, message) {
    this.env.recorder.criterion({ criterion: id, ok, flow: this.flow, viewport: this.viewport, step: null, message });
  }
}

export const repoRelative = file => path.relative(REPO, file).replace(/\\/g, "/");
