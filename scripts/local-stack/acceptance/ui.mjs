// Page helpers of the acceptance flows: accessible-name selectors, waiting for server results, real Ctrl+V paste and
// drag-and-drop of image bytes, and reading what a screen shows. Controls are found through roles, accessible names
// and visible text only, never CSS classes or test ids.

/** Network failures of the browser itself (not answers of the app) that a second attempt can get past. */
const TRANSIENT_NETWORK = /net::ERR_(NETWORK_IO_SUSPENDED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_REFUSED|EMPTY_RESPONSE|INTERNET_DISCONNECTED)\b/;

/**
 * Observers the harness registers per page (FlowRun.open): `arrived` once a navigation settled (goto, arrive),
 * `beforeTap` right before every touch, `tapMissed` when a touch landed on another element. The harness scans the
 * screen (visible text, context selector, phone width) and keeps evidence through them; a failing observer never
 * breaks the flow.
 */
const observers = new WeakMap();

/** Registers the observers of one page (replacing earlier ones). */
export function observe(page, observer) {
  observers.set(page, observer);
}

async function notify(page, event) {
  const handler = observers.get(page)?.[event];
  if (handler) await Promise.resolve().then(handler).catch(() => {});
}

/**
 * Navigates like page.goto, retrying twice (after 3 s) when the browser itself failed to reach the server (the
 * operating system suspending network I/O, a reset connection). Each retry is reported as a "network" note; an HTTP
 * error status is an answer of the app and is returned, never retried.
 */
export async function navigate(page, appPath, options = { waitUntil: "load" }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.goto(appPath, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = TRANSIENT_NETWORK.exec(message)?.[0];
      if (!transient || attempt > 2) throw error;
      const screen = String(appPath).split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
      inputNotes.push({ kind: "network", screen, text: `opening ${screen} failed in the browser (${transient}); retried (attempt ${attempt + 1})` });
      await page.waitForTimeout(3_000);
    }
  }
}

/** Loads an app path and waits until the network settles; returns the HTTP status of the navigation. */
export async function goto(page, appPath) {
  const response = await navigate(page, appPath);
  await settle(page);
  await notify(page, "arrived");
  return response?.status() ?? null;
}

/**
 * Waits for a navigation the page started itself (a link, a redirect after a server action, a shortcut) like
 * page.waitForURL, then lets the network settle so the screen it arrived at is scanned like every loaded page.
 */
export async function arrive(page, url, options = {}) {
  await page.waitForURL(url, options);
  await settle(page);
  await notify(page, "arrived");
}

/** Waits briefly for network quiet (server actions, RSC refreshes); never fails. */
export async function settle(page, timeout = 15_000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

/** Visible text of a locator with whitespace collapsed ("" when it is not there within `timeout`). */
export async function textOf(locator, timeout = 10_000) {
  const text = await locator.first().innerText({ timeout }).catch(() => "");
  return text.replace(/\s+/g, " ").trim();
}

/** Waits until a locator is visible; returns true/false instead of throwing. */
export async function visible(locator, timeout = 10_000) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until a locator is hidden or gone (a closing dialog, sheet or menu may still be drawn for a moment); returns
 * true/false instead of throwing. For "never shown" use !visible(locator, timeout), which waits for it to appear.
 */
export async function hidden(locator, timeout = 5_000) {
  try {
    await locator.first().waitFor({ state: "hidden", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Polls until `predicate()` is truthy (returns its value) or the timeout passes (returns null). */
export async function until(predicate, { timeout = 30_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Waits until the text of `locator` matches `pattern`; returns the text or null. */
export async function waitForText(locator, pattern, timeout = 30_000) {
  return until(async () => {
    const text = await textOf(locator);
    return pattern.test(text) ? text : null;
  }, { timeout });
}

/**
 * Problems the helpers met ({kind, screen, text}: "tap", a touch that landed on another element; "network", a
 * navigation retried after a browser network failure), drained into the current step's record and the run's warnings
 * by the harness (takeInputNotes). A "tap" note fails its step (rules.mjs foldInputNotes); a "network" note does not.
 */
const inputNotes = [];

/** Returns and clears the input notes collected since the last call. */
export function takeInputNotes() {
  return inputNotes.splice(0, inputNotes.length);
}

/**
 * Clicks (or taps, on touch viewports when `tap` is set) a control. A tap is a real touch at the control's centre; the
 * screen is scanned right before it (phone width included). When the page is wider than the phone, the browser pans
 * the visible area inside the wider layout and touches land beside the control (another element "intercepts" them):
 * the miss is recorded as a "tap" note, which fails the step, and the control is then activated with a synthetic click
 * only so the rest of the step can still be judged.
 */
export async function press(locator, { tap = false } = {}) {
  const target = locator.first();
  // Centre the control first: sticky bars (the phone tab bar, a form's save bar, the top bar) cover the edges.
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => {});
  if (!tap) {
    await target.click();
    return;
  }
  // A control that is still rendering gets the full action timeout; a touch that keeps missing it does not.
  await target.waitFor({ state: "visible" });
  const page = target.page();
  await notify(page, "beforeTap");
  try {
    await target.tap({ timeout: 15_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/intercepts pointer events/.test(message)) throw error;
    const facts = await target.evaluate(element => ({
      name: (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      layout: document.documentElement.scrollWidth,
      visible: Math.round(window.visualViewport?.width ?? window.innerWidth),
      path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id"),
    }));
    inputNotes.push({
      kind: "tap",
      screen: facts.path,
      text: `a tap on "${facts.name}" (${facts.path}) landed on another element: the page is ${facts.layout} px wide on a ${facts.visible} px screen, so the browser pans and touches miss`,
    });
    await notify(page, "tapMissed");
    await target.dispatchEvent("click");
  }
}

/** Checks a native radio or checkbox through its label (radios of chips and segmented controls are visually hidden). */
export async function choose(scope, role, name, { tap = false } = {}) {
  const input = scope.getByRole(role, { name, exact: typeof name === "string" }).first();
  const label = input.locator("xpath=ancestor::label[1]");
  if (await label.count()) await press(label, { tap });
  else await input.check({ force: true });
  if (!(await input.isChecked())) throw new Error(`${role} "${name}" did not become checked`);
}

/** Selects an option of a native select by its visible label (string or RegExp). */
export async function selectByLabel(select, label) {
  const options = await select.locator("option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: (node.textContent ?? "").trim(), disabled: node.disabled })));
  const match = options.find(option => !option.disabled && (label instanceof RegExp ? label.test(option.label) : option.label === label));
  if (!match) throw new Error(`No option ${label} in ${JSON.stringify(options.map(o => o.label))}`);
  await select.selectOption(match.value);
  return match.label;
}

/**
 * Chooses a period of a review page's picker (a select that navigates to its option's ?param=value): the first option
 * whose label matches `label`. Waits for the navigation unless that option is already selected. Returns the label.
 */
export async function choosePeriod(page, select, label, param) {
  await select.waitFor({ state: "visible" });
  const current = await select.inputValue();
  const options = await select.locator("option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: (node.textContent ?? "").trim(), disabled: node.disabled })));
  const match = options.find(option => !option.disabled && label.test(option.label));
  if (!match) throw new Error(`No option ${label} in ${JSON.stringify(options.map(o => o.label))}`);
  if (match.value !== current) {
    await select.selectOption(match.value);
    await arrive(page, url => url.searchParams.get(param) === match.value, { timeout: 60_000 });
  }
  return match.label;
}

/** Fills a text field and leaves it (so controlled inputs commit their value). */
export async function fill(locator, value) {
  const field = locator.first();
  await field.fill("");
  await field.fill(value);
}

/**
 * Pastes image bytes the way a user does: a real Ctrl+V key press on the focused element, answered with a `paste`
 * ClipboardEvent whose clipboardData carries the PNG as a File — what the browser dispatches after reading an image
 * from the clipboard. The operating-system clipboard is never touched (a headless browser on Windows could otherwise
 * overwrite the user's clipboard). Returns {handled, target} (handled: a listener consumed the paste).
 */
export async function pasteImage(page, bytes, fileName = "acceptance-paste.png") {
  await page.evaluate(({ base64, name }) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
    window.__acceptancePaste = null;
    const onKey = event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "v") return;
      document.removeEventListener("keydown", onKey, true);
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], name, { type: "image/png" }));
      const target = document.activeElement ?? document.body;
      const paste = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true, composed: true });
      target.dispatchEvent(paste);
      window.__acceptancePaste = { handled: paste.defaultPrevented, target: `${target.tagName.toLowerCase()}${target.getAttribute("aria-label") ? `[${target.getAttribute("aria-label")}]` : ""}` };
    };
    document.addEventListener("keydown", onKey, true);
  }, { base64: Buffer.from(bytes).toString("base64"), name: fileName });
  await page.keyboard.press("Control+V");
  return (await until(() => page.evaluate(() => window.__acceptancePaste), { timeout: 5_000 })) ?? { handled: false, target: null };
}

/**
 * Drops image bytes onto an element like a file dragged from the desktop: dragenter, dragover and drop events that
 * share one DataTransfer holding the PNG as a File. Returns whether the drop was accepted (default prevented).
 */
export async function dropImage(locator, bytes, fileName = "acceptance-drop.png") {
  const handle = await locator.first().elementHandle();
  if (!handle) throw new Error("Drop target not found");
  return handle.evaluate((element, { base64, name }) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: "image/png" }));
    const rect = element.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 40) };
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at }));
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer, ...at });
    element.dispatchEvent(drop);
    return drop.defaultPrevented;
  }, { base64: Buffer.from(bytes).toString("base64"), name: fileName });
}

/**
 * Width of the page's layout in CSS pixels. A phone browser widens its layout viewport to fit wider content
 * (innerWidth grows with it), so a result above the device width means the screen pans sideways.
 */
export function layoutWidth(page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth));
}

/** The trade id of a /trades/<id> URL, or null. */
export function tradeIdOf(url) {
  return /\/trades\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(url)?.[1] ?? null;
}

/** The main landmark of the app shell. */
export const main = page => page.getByRole("main");

/** The header text of a trade workspace: title, state pill, origin badge and the next-action controls. */
export async function tradeHeader(page) {
  const heading = page.getByRole("heading", { level: 1 });
  const title = await textOf(heading);
  // The state pill and actions follow the h1 inside the same header block.
  const block = await heading.first().evaluate(h1 => {
    const header = h1.closest("header") ?? h1.parentElement?.parentElement ?? h1.parentElement;
    return header ? header.innerText.replace(/\s+/g, " ").trim() : "";
  }).catch(() => "");
  return { title, text: block };
}

/** Names of the visible buttons and links inside a locator (for evidence). */
export async function controlNames(locator) {
  return locator.first().evaluate(root => [...root.querySelectorAll("a[href], button")]
    .filter(el => el.offsetParent !== null || el.getClientRects().length > 0)
    .map(el => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)).catch(() => []);
}

/** Region (section with an accessible name) inside main. */
export const region = (page, name) => page.getByRole("main").getByRole("region", { name, exact: typeof name === "string" });

/** The journal composer of a trade page. */
export const composer = page => page.getByRole("form", { name: "Add to trade journal" });

/**
 * Picks image bytes through the system file picker that `trigger` opens (Attach screenshots, Take photo): the
 * filechooser event is answered with the PNG, as a phone's photo library or camera would.
 */
export async function pickImage(page, trigger, bytes, fileName, { tap = false } = {}) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), press(trigger, { tap })]);
  await chooser.setFiles({ name: fileName, mimeType: "image/png", buffer: Buffer.from(bytes) });
  return { handled: true, method: "picker", multiple: chooser.isMultiple() };
}

/**
 * Adds a journal entry through the trade page composer: kind chip, text, optional image, submit. The image is pasted
 * with Ctrl+V on a desktop and attached with "Attach screenshots" (the system picker) on a phone, which has no
 * keyboard shortcut. Returns the status text the composer announced and how the image was attached.
 */
export async function addJournalEntry(page, { kind = "Note", body, image = null, tap = false }) {
  const form = composer(page);
  await form.waitFor({ state: "visible" });
  await choose(form, "radio", kind, { tap });
  const box = form.getByRole("textbox", { name: "Journal entry" });
  await press(box, { tap });
  await box.fill(body);
  let attached = null;
  if (image) {
    attached = tap
      ? await pickImage(page, form.getByRole("button", { name: "Attach screenshots" }), image, "acceptance-live.png", { tap })
      : { method: "paste", ...(await pasteImage(page, image, "acceptance-live.png")) };
    // The composer shows the staged preview.
    await until(async () => (await form.locator("img").count()) > 0, { timeout: 10_000 });
  }
  const screenshotsBefore = image ? await screenshotCount(page) : null;
  await press(form.getByRole("button", { name: "Add to journal" }), { tap });
  // The entry is confirmed first; attached screenshots are uploaded right after it ("1 screenshot saved").
  const done = image ? /Added to the journal\.?\s*1 screenshot saved/i : /Added to the journal/i;
  const announced = await waitForText(form, done, 60_000);
  // The timeline and the gallery refresh from the server once everything is stored: no pending "Saving" record is
  // left and, with a screenshot, the Evidence count has grown.
  const needle = body.slice(0, 40);
  await until(async () => {
    const text = await textOf(region(page, "Journal"));
    if (!text.includes(needle) || /Saving ·|Saving screenshot/.test(text)) return false;
    return screenshotsBefore === null || ((await screenshotCount(page)) ?? 0) > screenshotsBefore;
  }, { timeout: 45_000 });
  return { announced, attached };
}

/** "2 of 24 screenshots" in a trade's Evidence section, or null. */
export async function screenshotCount(page) {
  const match = /(\d+) of 24 screenshots/.exec(await textOf(region(page, "Evidence")));
  return match ? Number(match[1]) : null;
}

/** Timeline bands of the trade journal: {"Before entry": [...items], "While live": [...], "After close": [...]} as text. */
export async function timelineBands(page) {
  const journal = region(page, "Journal");
  return journal.first().evaluate(root => {
    const bands = {};
    for (const heading of root.querySelectorAll("h3")) {
      // "Before entry" + count + visually hidden "records": keep the band name only.
      const name = /^(Before entry|While live|After close)/.exec((heading.textContent ?? "").replace(/\s+/g, " ").trim())?.[1];
      if (!name) continue;
      const list = heading.nextElementSibling;
      bands[name] = list ? [...list.querySelectorAll(":scope > li")].map(li => li.innerText.replace(/\s+/g, " ").trim()) : [];
    }
    return bands;
  });
}
