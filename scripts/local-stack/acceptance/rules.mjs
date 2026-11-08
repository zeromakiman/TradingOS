// Pure rules of the browser acceptance runner (scripts/local-stack/acceptance/run.mjs), no I/O: command-line options,
// the fixed UTC−5 strategy clock and what it demands of the Risk Engine (Dead Pool), the visible-text scan for raw
// internals, the objective UX acceptance criteria of the master specification (§60), how missed phone taps fail a step,
// the run's verdict and the result summary. Kept apart so they can be tested without a browser
// (tests/v2-acceptance-runner.test.ts).

/** Flows in the order they run (master specification §64 lists, plus the §60 UX criteria). */
export const FLOWS = Object.freeze(["planned", "live-first", "analytics", "accounts", "ai", "settings", "ux"]);

export const FLOW_TITLES = Object.freeze({
  planned: "Planned workflow",
  "live-first": "Live-first workflow",
  analytics: "Analytics drill-down",
  accounts: "Trading accounts",
  ai: "AI (local mock provider)",
  settings: "Settings, export and erasure",
  ux: "UX criteria, keyboard and themes",
});

/** The two acceptance sizes of docs/V2_ARCHITECTURE.md §16.2. */
export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ name: "desktop", width: 1440, height: 1000, mobile: false }),
  mobile: Object.freeze({ name: "mobile", width: 393, height: 852, mobile: true }),
});

export const DEFAULT_BASE = "http://127.0.0.1:3000";

export class OptionError extends Error {}

const USAGE = `Usage: node scripts/local-stack/acceptance/run.mjs [--flows=${FLOWS.join(",")}] [--viewport=desktop|mobile|both]
       [--out=<dir>] [--base=${DEFAULT_BASE}] [--browser=edge|chrome] [--headed] [--publish-screens]`;

/**
 * Parses the command line (without the node and script arguments). Throws OptionError with a usage hint for unknown
 * options, flows or viewports. `out` stays null when not given (the runner then uses .local/acceptance/<run-id>).
 */
export function parseOptions(argv) {
  const options = { flows: [...FLOWS], viewports: ["desktop", "mobile"], out: null, base: DEFAULT_BASE, browser: null, headed: false, publish: false, help: false };
  for (const raw of argv) {
    // A lone "--" (as `pnpm run acceptance -- …` forwards it) only ends the package manager's own options.
    if (raw === "--") continue;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!match) throw new OptionError(`Unexpected argument "${raw}".\n${USAGE}`);
    const [, name, value] = match;
    const needValue = () => {
      if (value === undefined || value === "") throw new OptionError(`--${name} needs a value.\n${USAGE}`);
      return value;
    };
    switch (name) {
      case "flows": {
        const flows = needValue().split(",").map(flow => flow.trim()).filter(Boolean);
        const unknown = flows.filter(flow => !FLOWS.includes(flow));
        if (unknown.length) throw new OptionError(`Unknown flow ${unknown.join(", ")}. Flows: ${FLOWS.join(", ")}.`);
        // Always in the canonical order, without duplicates.
        options.flows = FLOWS.filter(flow => flows.includes(flow));
        break;
      }
      case "viewport": {
        const viewport = needValue();
        if (viewport === "both") options.viewports = ["desktop", "mobile"];
        else if (viewport in VIEWPORTS) options.viewports = [viewport];
        else throw new OptionError(`--viewport must be desktop, mobile or both, got "${viewport}".`);
        break;
      }
      case "out":
        options.out = needValue();
        break;
      case "base":
        options.base = needValue();
        break;
      case "browser": {
        const browser = needValue();
        if (browser !== "edge" && browser !== "chrome") throw new OptionError(`--browser must be edge or chrome, got "${browser}".`);
        options.browser = browser;
        break;
      }
      case "headed":
        options.headed = true;
        break;
      case "publish-screens":
        options.publish = true;
        break;
      case "help":
        options.help = true;
        break;
      default:
        throw new OptionError(`Unknown option --${name}.\n${USAGE}`);
    }
  }
  return options;
}

export const usage = () => USAGE;

/** Run ids sort by time and stay unique: 20261024-190512-4f2a (UTC). */
export function runIdFor(date, suffix) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${String(suffix).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6)}`;
}

/** A synthetic address at the reserved example.test domain for one user of one run. */
export function acceptanceEmail(runId, key) {
  const local = `acc-${runId}-${key}`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  return `${local}@example.test`;
}

// ---------------------------------------------------------------------------------------------------------------
// Strategy clock (fixed UTC−5, no daylight saving; docs/V2_ARCHITECTURE.md §6.5 DEAD_POOL, §14.1 sessions)
// ---------------------------------------------------------------------------------------------------------------
const OFFSET_MS = 5 * 60 * 60 * 1000;
export const SESSIONS = Object.freeze([
  Object.freeze({ name: "Asia", from: 0, to: 60 }),
  Object.freeze({ name: "Judas", from: 60, to: 120 }),
  Object.freeze({ name: "Kill zone", from: 120, to: 720 }),
  Object.freeze({ name: "Dead Pool", from: 720, to: 1080 }),
  Object.freeze({ name: "Asia", from: 1080, to: 1440 }),
]);

/**
 * The strategy clock at `nowMs`: strategy day, UTC−5 time, session, whether locks are refused (Dead Pool 12:00–18:00),
 * minutes until locks are possible again, and minutes until the next 12:00 / 24:00 boundary (seed-v2.mjs refuses to
 * seed close to one).
 */
export function strategyClock(nowMs) {
  const shifted = new Date(nowMs - OFFSET_MS);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60;
  const session = SESSIONS.find(s => minutes >= s.from && minutes < s.to)?.name ?? "Asia";
  const deadPool = session === "Dead Pool";
  const boundaries = [720, 1440].map(boundary => boundary - minutes).filter(distance => distance > 0);
  return {
    day: shifted.toISOString().slice(0, 10),
    time: `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`,
    session,
    deadPool,
    minutesUntilLocksAllowed: deadPool ? Math.ceil(1080 - minutes) : 0,
    minutesToSeedBoundary: Math.min(...boundaries),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_POOL = Object.freeze({ from: 720, to: 1080 });

/**
 * What the Risk Engine must have answered about Dead Pool for a check made somewhere between `fromMs` and `toMs` (the
 * moments the runner knows bracket it), judged by the strategy clock and not by what the app shows: "blocked" when the
 * whole window, widened by `slackMinutes` on both sides, lies inside 12:00–18:00 UTC−5; "open" when it lies wholly
 * outside; "either" when 12:00 or 18:00 UTC−5 falls inside it.
 */
export function deadPoolExpectation(fromMs, toMs = fromMs, slackMinutes = 1) {
  const start = Math.min(fromMs, toMs) - slackMinutes * 60_000;
  const end = Math.max(fromMs, toMs) + slackMinutes * 60_000;
  // 00:00 UTC−5 of the strategy day that contains `start`, as an absolute time.
  const shifted = start - OFFSET_MS;
  const firstDay = shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) + OFFSET_MS;
  for (let day = firstDay; day <= end; day += DAY_MS) {
    for (const minute of [DEAD_POOL.from, DEAD_POOL.to]) {
      const boundary = day + minute * 60_000;
      if (boundary >= start && boundary <= end) return "either";
    }
  }
  return strategyClock(start).deadPool ? "blocked" : "open";
}

/** "18:02 UTC−5" or "17:59–18:01 UTC−5": the strategy-clock times of a window, for evidence. */
export function clockSpan(fromMs, toMs = fromMs) {
  const from = strategyClock(Math.min(fromMs, toMs)).time;
  const to = strategyClock(Math.max(fromMs, toMs)).time;
  return `${from === to ? from : `${from}–${to}`} UTC−5`;
}

// ---------------------------------------------------------------------------------------------------------------
// Visible-text scan (docs/V2_ARCHITECTURE.md §0.9, §15; master specification §60 item 7)
// ---------------------------------------------------------------------------------------------------------------
/** Rule codes that contain no underscore (every other code is caught as a SNAKE_CASE token). */
const BARE_RULE_CODES = ["DUPLICATE"];

export const SCAN_PATTERNS = Object.freeze([
  Object.freeze({ kind: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi }),
  Object.freeze({ kind: "hash", pattern: /\b[0-9a-f]{40,}\b/gi }),
  Object.freeze({ kind: "provider-id", pattern: /\b(?:resp|msg|chatcmpl|run|req)_[A-Za-z0-9]{6,}\b/g }),
  Object.freeze({ kind: "rule-code", pattern: new RegExp(`\\b(?:${BARE_RULE_CODES.join("|")})\\b`, "g") }),
  Object.freeze({ kind: "enum", pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g }),
  Object.freeze({ kind: "raw-json", pattern: /[{[]\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:/g }),
  Object.freeze({ kind: "prompt", pattern: /\b(?:system prompt|developer message|you are an? (?:ai|assistant|expert|trading)\b)/gi }),
]);

/**
 * Finds raw internals in the visible text of a page: UUIDs, hashes, provider ids, rule codes and backend enums
 * (SNAKE_CASE tokens), raw JSON and prompt text. Returns [{kind, match, context}] (context: up to 40 characters on each
 * side, whitespace collapsed), at most `limit` hits.
 */
export function scanVisibleText(text, limit = 20) {
  const hits = [];
  const source = String(text ?? "");
  for (const { kind, pattern } of SCAN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const found of source.matchAll(pattern)) {
      if (hits.length >= limit) return hits;
      const start = Math.max(0, found.index - 40);
      const end = Math.min(source.length, found.index + found[0].length + 40);
      hits.push({ kind, match: found[0], context: source.slice(start, end).replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

/** A path without ids, so a scan of /trades/<id> is reported once per screen: /trades/:id/edit. */
export function screenOf(pathname) {
  return String(pathname).split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id") || "/";
}

/**
 * Phone scans of screens laid out wider than the device (more than 1 px of overflow), one per screen and theme with
 * the largest overflow, ordered by screen.
 */
export function widerThanPhone(scans) {
  const worst = new Map();
  for (const scan of scans ?? []) {
    if (scan.viewport !== "mobile" || !(scan.overflowPx > 1)) continue;
    const key = `${scan.screen}|${scan.theme}`;
    if (!worst.has(key) || worst.get(key).overflowPx < scan.overflowPx) worst.set(key, scan);
  }
  return [...worst.values()].sort((a, b) => a.screen.localeCompare(b.screen) || String(a.theme).localeCompare(String(b.theme)));
}

// ---------------------------------------------------------------------------------------------------------------
// AI results: the concise card against its full analysis (docs/V2_ARCHITECTURE.md §11.1)
// ---------------------------------------------------------------------------------------------------------------
/**
 * Compares a concise card with its full analysis: the sheet carries the card's title, starts each item the card shows
 * with that item's text (the card shows first sentences, cut with "…" when long), and holds something the card does
 * not show (another section, another item, a longer item or the AI's stated limitations). Returns what is missing.
 */
export function fullAnalysisGaps(card, sheet) {
  const gaps = [];
  if (card.headings[0] && sheet.headings[0] !== card.headings[0]) gaps.push(`sheet titled "${sheet.headings[0] ?? ""}" instead of "${card.headings[0]}"`);
  const shortened = card.items.filter(item => !sheet.items.some(full => full.startsWith(item.replace(/…$/, "").trimEnd())));
  if (shortened.length) gaps.push(`items of the card missing from the sheet: ${shortened.slice(0, 2).map(item => `"${item.slice(0, 60)}"`).join(", ")}`);
  const extraSections = sheet.headings.slice(1).filter(heading => !card.headings.includes(heading));
  const extraItems = sheet.items.filter(full => !card.items.includes(full));
  if (!extraSections.length && !extraItems.length) gaps.push("the sheet shows nothing the card does not");
  return gaps;
}

// ---------------------------------------------------------------------------------------------------------------
// Objective UX acceptance criteria (master specification §60, items 1–20)
// ---------------------------------------------------------------------------------------------------------------
export const UX_CRITERIA = Object.freeze([
  { id: 1, text: "A trader can identify the next action on a trade within a few seconds." },
  { id: 2, text: "Adding a live note does not require leaving the trade." },
  { id: 3, text: "A screenshot can be pasted directly with Ctrl+V." },
  { id: 4, text: "Drag/drop evidence works." },
  { id: 5, text: "An unlocked draft can be edited without recreating it." },
  { id: 6, text: "BLOCKED reasons are visible in primary UI." },
  { id: 7, text: "Raw UUIDs/provider IDs/raw prompts do not appear in default UI." },
  { id: 8, text: "A live-first trade can be recorded with minimal mandatory fields." },
  { id: 9, text: "A post-trade note cannot masquerade as pre-entry evidence." },
  { id: 10, text: "Paid AI is not the default next action on a blocked draft." },
  { id: 11, text: "The selected Trading Account is always obvious." },
  { id: 12, text: "All Accounts is an aggregation context, not a fake account." },
  { id: 13, text: "Desktop core trading flow does not depend on hidden debug accordions." },
  { id: 14, text: "A user can move: All Accounts → Account → Day/statistic → Trade → Evidence." },
  { id: 15, text: "A normal trader does not need developer knowledge to create/record a trade, journal, close and review." },
  { id: 16, text: "No core workflow requires reading huge AI output by default." },
  { id: 17, text: "No manual input duplicates information Trading OS already knows." },
  { id: 18, text: "Mobile live-note workflow is usable without desktop-only interactions." },
  { id: 19, text: "Locked plan immutability remains intact." },
  { id: 20, text: "Historical records remain interpreted under their original strategy/risk versions." },
].map(Object.freeze));

/**
 * Verdict per criterion from evidence records [{criterion, ok, message, flow, viewport, step}]:
 * "fail" when any record failed, "pass" when at least one passed and none failed, "not-run" without evidence.
 */
export function judgeCriteria(records) {
  return UX_CRITERIA.map(criterion => {
    const evidence = records.filter(record => record.criterion === criterion.id);
    const failed = evidence.filter(record => !record.ok);
    const verdict = evidence.length === 0 ? "not-run" : failed.length > 0 ? "fail" : "pass";
    return { id: criterion.id, text: criterion.text, verdict, evidence };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------
/** Step statuses: pass, fail, skipped (a prerequisite failed or the flow did not apply) and clock (refused by the real
 * strategy clock, for example a lock during Dead Pool: the expected deterministic behaviour, not a failure). */
export const STEP_STATUSES = Object.freeze(["pass", "fail", "skipped", "clock"]);

/**
 * Folds the input notes of a step (ui.mjs takeInputNotes) into its record. A "tap" note, a touch that landed on another
 * element because the screen was wider than the phone, fails the step with the note as its error: a phone user could
 * not hit that control where the page drew it (the runner pressed it with a synthetic click only so the rest of the
 * step could still be judged). Other notes, such as a navigation retried after a browser network failure, stay
 * informational. Returns the tap notes.
 */
export function foldInputNotes(record, notes) {
  const taps = [];
  for (const note of notes ?? []) {
    if (note.kind === "tap") {
      taps.push(note);
      record.evidence.push({ ok: false, message: `phone tap missed its control: ${note.text}` });
    } else {
      record.evidence.push({ ok: true, info: true, message: note.text });
    }
  }
  if (taps.length) {
    const missed = taps.map(note => note.text).join("; ");
    record.error = record.status === "fail" && record.error ? `${record.error}; ${missed}` : missed;
    record.status = "fail";
  }
  return taps;
}

/** Status of one flow at one viewport: fail if any step failed, pass when every step passed or was clock-limited. */
export function flowStatus(steps) {
  if (steps.length === 0) return "not-run";
  if (steps.some(step => step.status === "fail")) return "fail";
  if (steps.every(step => step.status === "skipped")) return "skipped";
  return "pass";
}

/** Matrix {flow: {viewport: {status, passed, failed, skipped, clock, total}}} over the steps of a run. */
export function passMatrix(steps, flows, viewports) {
  const matrix = {};
  for (const flow of flows) {
    matrix[flow] = {};
    for (const viewport of viewports) {
      const own = steps.filter(step => step.flow === flow && step.viewport === viewport);
      const count = status => own.filter(step => step.status === status).length;
      matrix[flow][viewport] = { status: flowStatus(own), passed: count("pass"), failed: count("fail"), skipped: count("skipped"), clock: count("clock"), total: own.length };
    }
  }
  return matrix;
}

/** A run of every flow at both viewports: only such a run must produce evidence for every §60 criterion. */
export function isFullRun(flows, viewports) {
  return FLOWS.every(flow => (flows ?? []).includes(flow)) && Object.keys(VIEWPORTS).every(viewport => (viewports ?? []).includes(viewport));
}

const listOf = ids => `criteri${ids.length === 1 ? "on" : "a"} ${ids.join(", ")}`;

/**
 * The verdict of a run and why: "interrupted" when it was stopped before every flow ran; otherwise "fail" when a step
 * failed, a §60 criterion failed (including the ones judged over every screen, which no single step owns) or, in a full
 * run, a criterion never ran; "pass" only without any of these. `criteria` are judgeCriteria() verdicts.
 */
export function runVerdict({ steps = [], criteria = [], flows = [], viewports = [], interrupted = false }) {
  const reasons = [];
  const failedSteps = steps.filter(step => step.status === "fail").length;
  if (failedSteps) reasons.push(`${failedSteps} step${failedSteps === 1 ? "" : "s"} failed`);
  const failedCriteria = criteria.filter(criterion => criterion.verdict === "fail").map(criterion => criterion.id);
  if (failedCriteria.length) reasons.push(`${listOf(failedCriteria)} failed`);
  if (isFullRun(flows, viewports)) {
    const notRun = criteria.filter(criterion => criterion.verdict === "not-run").map(criterion => criterion.id);
    if (notRun.length) reasons.push(`${listOf(notRun)} never ran`);
  }
  if (interrupted) return { verdict: "interrupted", reasons: ["interrupted before every flow ran", ...reasons] };
  return { verdict: reasons.length ? "fail" : "pass", reasons };
}

const cell = entry => {
  if (!entry || entry.status === "not-run") return "not run";
  const extra = [entry.failed ? `${entry.failed} failed` : null, entry.skipped ? `${entry.skipped} skipped` : null, entry.clock ? `${entry.clock} clock-limited` : null].filter(Boolean);
  return `${entry.status.toUpperCase()} ${entry.passed}/${entry.total}${extra.length ? ` (${extra.join(", ")})` : ""}`;
};
const escapeCell = text => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The human summary (summary.md) of a results object as written to results.json. */
export function renderSummary(results) {
  const lines = [];
  const viewports = results.viewports ?? [];
  const flows = results.flows ?? [];
  const matrix = passMatrix(results.steps ?? [], flows, viewports);
  lines.push(`# Browser acceptance ${results.runId}`, "");
  lines.push(`- App: ${results.base} · browser: ${results.browser?.name ?? "?"} ${results.browser?.version ?? ""}`.trimEnd());
  lines.push(`- Started ${results.startedAt}${results.finishedAt ? ` · finished ${results.finishedAt}` : " · still running"}`);
  if (results.clock?.start) {
    const end = results.clock.end ? ` → ${results.clock.end.time} ${results.clock.end.session}` : "";
    lines.push(`- Strategy clock (UTC−5): ${results.clock.start.day} ${results.clock.start.time} ${results.clock.start.session}${end}`);
  }
  const reasons = results.verdictReasons ?? [];
  lines.push(`- Verdict: **${(results.verdict ?? "running").toUpperCase()}**${reasons.length ? ` (${reasons.join("; ")})` : ""}`, "");
  lines.push("## Pass matrix", "", `| Flow | ${viewports.map(v => `${v} (${VIEWPORTS[v]?.width}×${VIEWPORTS[v]?.height})`).join(" | ")} |`, `|---|${viewports.map(() => "---").join("|")}|`);
  for (const flow of flows) lines.push(`| ${FLOW_TITLES[flow] ?? flow} | ${viewports.map(v => cell(matrix[flow]?.[v])).join(" | ")} |`);
  lines.push("");
  const criteria = results.uxCriteria ?? [];
  if (criteria.length) {
    lines.push("## UX acceptance criteria (master specification §60)", "", "| # | Criterion | Verdict | Evidence |", "|---|---|---|---|");
    for (const criterion of criteria) {
      const evidence = criterion.evidence.slice(0, 4).map(e => `${e.ok ? "" : "FAILED: "}${e.message} [${e.flow}/${e.viewport}]`).join("; ");
      const more = criterion.evidence.length > 4 ? ` (+${criterion.evidence.length - 4} more)` : "";
      lines.push(`| ${criterion.id} | ${escapeCell(criterion.text)} | ${criterion.verdict.toUpperCase()} | ${escapeCell(evidence + more)} |`);
    }
    lines.push("");
  }
  const failures = (results.steps ?? []).filter(step => step.status === "fail");
  const failedCriteria = criteria.filter(criterion => criterion.verdict === "fail");
  const missingCriteria = isFullRun(flows, viewports) ? criteria.filter(criterion => criterion.verdict === "not-run") : [];
  lines.push("## Failures", "");
  if (!failures.length && !failedCriteria.length && !missingCriteria.length) lines.push("None.", "");
  for (const step of failures) {
    lines.push(`- **${step.flow} · ${step.viewport} · ${step.id}** ${step.title}: ${step.error ?? "failed"}`);
    for (const shot of step.screenshots ?? []) lines.push(`  - screenshot: ${shot}`);
  }
  for (const criterion of failedCriteria) {
    const failed = criterion.evidence.filter(record => !record.ok);
    lines.push(`- **Criterion ${criterion.id}** ${criterion.text} FAILED: ${failed.slice(0, 3).map(record => `${record.message} [${record.flow}/${record.viewport}]`).join("; ")}`);
  }
  for (const criterion of missingCriteria) lines.push(`- **Criterion ${criterion.id}** ${criterion.text} never ran in this full run`);
  if (failures.length || failedCriteria.length || missingCriteria.length) lines.push("");
  const clockLimited = (results.steps ?? []).filter(step => step.status === "clock");
  if (clockLimited.length) {
    lines.push("## Limited by the real strategy clock", "");
    for (const step of clockLimited) lines.push(`- ${step.flow} · ${step.viewport} · ${step.id}: ${step.clockNote ?? step.title}`);
    lines.push("");
  }
  lines.push("## Steps", "");
  for (const flow of flows) {
    for (const viewport of viewports) {
      const own = (results.steps ?? []).filter(step => step.flow === flow && step.viewport === viewport);
      if (!own.length) continue;
      lines.push(`### ${FLOW_TITLES[flow] ?? flow} · ${viewport}`, "");
      for (const step of own) {
        const facts = (step.evidence ?? []).filter(e => e.ok !== false).slice(0, 3).map(e => e.message).join("; ");
        lines.push(`- ${step.status.toUpperCase()} \`${step.id}\` ${step.title} (${(step.ms / 1000).toFixed(1)} s)${facts ? `: ${facts}` : ""}${step.status === "fail" && step.error ? ` — ${step.error}` : ""}`);
      }
      lines.push("");
    }
  }
  const scans = results.scans ?? [];
  const withHits = scans.filter(scan => scan.hits.length > 0);
  lines.push("## Visible-text scan", "", `${results.scanCount ?? scans.length} scans of ${new Set(scans.map(scan => `${scan.screen}|${scan.viewport}|${scan.theme}`)).size} distinct screens (per viewport and theme); ${withHits.length} with raw internals.`, "");
  for (const scan of withHits.slice(0, 30)) lines.push(`- ${scan.screen} (${scan.viewport}): ${scan.hits.slice(0, 3).map(hit => `${hit.kind} "${hit.match}" in "…${hit.context}…"`).join("; ")}`);
  if (withHits.length) lines.push("");
  const wide = widerThanPhone(scans);
  const missedTaps = (results.warnings ?? []).filter(warning => warning.kind === "tap");
  if (scans.some(scan => scan.viewport === "mobile")) {
    lines.push(`## Phone width (${VIEWPORTS.mobile.width} px)`, "", wide.length ? `${wide.length} screen(s) wider than the phone (the page pans sideways):` : "Every phone screen scanned fits the device width.", "");
    for (const scan of wide) lines.push(`- ${scan.screen} (${scan.theme}): +${scan.overflowPx} px; widest element ${escapeCell(scan.widest ?? "unknown")}`);
    if (wide.length) lines.push("");
    if (missedTaps.length) {
      lines.push("Taps that missed their control because the page was wider than the phone at that moment (each fails its step):", "");
      for (const warning of missedTaps) lines.push(`- [${warning.flow}] ${escapeCell(warning.text)}`);
      lines.push("");
    }
  }
  const warnings = results.warnings ?? [];
  lines.push("## Warnings (browser console, failed requests, dev overlay)", "", warnings.length ? `${warnings.length} recorded; first ${Math.min(warnings.length, 25)}:` : "None.", "");
  for (const warning of warnings.slice(0, 25)) lines.push(`- [${warning.flow}/${warning.viewport}] ${warning.kind}: ${escapeCell(warning.text).slice(0, 220)} (${warning.screen ?? ""})`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}
