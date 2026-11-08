// Shared steps of the acceptance flows: opening Plan Trade / Record Live Trade the way each viewport offers them,
// reading a trade's state, the evidence a trade page shows, and what the local mock AI provider answered.
import fs from "node:fs";
import path from "node:path";
import { LOCAL } from "../../lib.mjs";
import { chartPng } from "../fixtures.mjs";
import { arrive, choose, goto, press, screenshotCount, selectByLabel, tradeHeader, until, visible } from "../ui.mjs";

const MOCK_LOG = path.join(LOCAL, "logs", "mock-openai.log");

/**
 * Lines of the local mock provider's log (scripts/local-stack/mock-openai.mjs) for one json_schema written since
 * `since` (ISO timestamps sort as text): proof that a request reached the mock, and with which scenario and status.
 */
export function mockCalls(schema, since) {
  try {
    return fs.readFileSync(MOCK_LOG, "utf8").split(/\r?\n/).filter(line => line.slice(0, 24) >= since && line.includes(`schema=${schema} `));
  } catch {
    return [];
  }
}

/** State labels of docs/V2_ARCHITECTURE.md §2.3, longest first so "Closed · review pending" wins over "Closed". */
export const STATE_LABELS = [
  "Locked · waiting for entry", "Closed · review pending", "Recheck needed", "Ready to lock", "Reviewed", "Blocked", "Live", "Draft",
  "Skipped", "Cancelled", "Discarded",
];

/** The state pill shown in the trade header, or null. */
export async function tradeState(page) {
  const { text } = await tradeHeader(page);
  return STATE_LABELS.find(label => text.includes(label)) ?? null;
}

/** Waits until the trade header shows one of `labels`; returns the label or null. */
export async function waitForState(page, labels, timeout = 60_000) {
  return until(async () => {
    const state = await tradeState(page);
    return state && labels.includes(state) ? state : null;
  }, { timeout });
}

/** Opens Plan Trade: header link on desktop, the tab bar's "New trade" sheet on phones. */
export async function openPlanTrade(run) {
  return openNewTrade(run, "Plan Trade", /\/trades\/new$/);
}

/** Opens Record Live Trade the same way. */
export async function openRecordLive(run) {
  return openNewTrade(run, "Record Live Trade", /\/trades\/live\/new$/);
}

async function openNewTrade(run, title, url) {
  const page = run.page;
  if (run.mobile) {
    const bar = page.getByRole("navigation", { name: "Primary" });
    await press(bar.getByRole("button", { name: "New trade" }), { tap: true });
    const sheet = page.getByRole("dialog", { name: "New trade" });
    await sheet.waitFor({ state: "visible" });
    await press(sheet.getByRole("link", { name: new RegExp(`^${title}`) }), { tap: true });
  } else {
    await press(page.getByRole("banner").getByRole("link", { name: title, exact: true }));
  }
  await arrive(page, url);
}

/** Opens a trade by id and waits for its heading. */
export async function openTrade(page, tradeId, hash = "") {
  const status = await goto(page, `/trades/${tradeId}${hash}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "visible", timeout: 120_000 });
  return status;
}

/** Number of screenshots the Evidence section reports ("2 of 24 screenshots"), or null. */
export const evidenceCount = screenshotCount;

/** Synthetic chart bytes for one capture of a flow (distinct fingerprint per name). */
export function chartFor(run, name, kind = "SETUP", extra = {}) {
  return chartPng({ seed: `${run.env.runId}/${run.flow}/${run.viewport}/${name}`, kind, account: `Acceptance ${run.viewport}`, ...extra });
}

/** Chooses a radio of a fieldset by label, tapping on phones. */
export function pick(run, scope, name) {
  return choose(scope, "radio", name, { tap: run.mobile });
}

/** True when the control is visible inside the first viewport of the page (scrolled to the top: no scrolling needed). */
export async function aboveTheFold(page, locator) {
  await page.evaluate(() => window.scrollTo(0, 0));
  if (!(await visible(locator, 5_000))) return false;
  const box = await locator.first().boundingBox();
  const size = page.viewportSize();
  return Boolean(box && size && box.y >= 0 && box.y + Math.min(box.height, 40) <= size.height);
}

/** Entries of the visible "Risk plan versions" (a table on wide screens, one card per version on phones), as text. */
export async function riskPlanEntries(page) {
  const view = page.getByRole("table", { name: "Risk plan versions" }).or(page.getByRole("list", { name: "Risk plan versions" })).filter({ visible: true }).first();
  return view.evaluate(element => (element.tagName === "TABLE" ? [...element.querySelectorAll("tbody tr")] : [...element.querySelectorAll(":scope > li")])
    .map(item => (item.innerText ?? "").replace(/\s+/g, " ").trim()));
}

/** EDGE breakdowns: phones show one at a time, picked in "Breakdown shown"; wide screens show them all. */
export async function showBreakdown(page, title) {
  const picker = page.getByRole("combobox", { name: "Breakdown shown" });
  if (await visible(picker, 2_000)) await selectByLabel(picker, title);
  return page.getByRole("figure", { name: title });
}
