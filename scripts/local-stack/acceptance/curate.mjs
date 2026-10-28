// Curated documentation screenshots of an acceptance run: the flows capture candidates into <run>/curated/; this module
// keeps every image under the size budget (lossless first, then a 256-colour palette, then downscaling) and, with
// --publish-screens, copies a fixed selection into docs/v2-screens/ with a README index, only from a passing run of
// every flow at both viewports that captured the whole selection.
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../lib.mjs";
import { sharp } from "./fixtures.mjs";
import { FLOW_TITLES, isFullRun, VIEWPORTS } from "./rules.mjs";

export const DOCS_DIR = path.join(REPO, "docs", "v2-screens");
export const MAX_BYTES = 480 * 1024;

/** The published selection by area, in reading order (name = <key>-<viewport>[-dark]). */
export const PUBLISHED_GROUPS = Object.freeze([
  Object.freeze({ title: "Today", names: Object.freeze(["today-desktop", "today-mobile", "mobile-today-live-note-mobile"]) }),
  Object.freeze({
    title: "Planned trade",
    names: Object.freeze(["plan-trade-blocked-desktop", "trade-draft-blocked-desktop", "trade-planned-live-desktop", "trade-planned-live-mobile", "trade-closed-timeline-desktop"]),
  }),
  Object.freeze({ title: "Live-first trade", names: Object.freeze(["record-live-trade-mobile", "trade-live-first-desktop", "mobile-live-first-timeline-mobile"]) }),
  Object.freeze({ title: "Journal, EDGE and evidence", names: Object.freeze(["journal-desktop", "journal-mobile", "edge-desktop", "edge-calendar-day-desktop", "evidence-viewer-desktop"]) }),
  Object.freeze({ title: "Trading accounts", names: Object.freeze(["accounts-desktop", "account-dashboard-desktop", "account-manage-risk-policy-desktop"]) }),
  Object.freeze({
    title: "Review and AI (local mock provider)",
    names: Object.freeze(["review-weekly-concise-desktop", "ai-analyze-setup-concise-desktop", "ai-review-trade-concise-desktop", "ai-review-trade-full-desktop", "ai-failure-accounting-desktop"]),
  }),
  Object.freeze({ title: "Settings and keyboard", names: Object.freeze(["settings-desktop", "command-palette-desktop"]) }),
  Object.freeze({ title: "Dark theme", names: Object.freeze(["today-desktop-dark", "trade-live-mobile-dark", "edge-desktop-dark"]) }),
]);

/** Every published name, in reading order. */
export const PUBLISHED = Object.freeze(PUBLISHED_GROUPS.flatMap(group => group.names));

/** Re-encodes a PNG until it fits `max` bytes: maximum lossless compression, then palette, then 85% steps of width. */
export async function fitPng(input, max = MAX_BYTES) {
  if (input.length <= max) return { data: input, method: "original" };
  const lib = sharp();
  let data = await lib(input).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (data.length <= max) return { data, method: "lossless" };
  data = await lib(input).png({ compressionLevel: 9, palette: true, quality: 90, dither: 0.8 }).toBuffer();
  if (data.length <= max) return { data, method: "palette" };
  const { width } = await lib(input).metadata();
  for (let scale = 0.85; scale > 0.4; scale *= 0.85) {
    data = await lib(input).resize({ width: Math.round(width * scale) }).png({ compressionLevel: 9, palette: true, quality: 90, dither: 0.8 }).toBuffer();
    if (data.length <= max) return { data, method: `palette, ${Math.round(scale * 100)}% width` };
  }
  return { data, method: "palette, smallest" };
}

const viewportLabel = viewport => `${viewport === "mobile" ? "Phone" : "Desktop"} ${VIEWPORTS[viewport].width}×${VIEWPORTS[viewport].height}`;

/** One line per flow and viewport of the run: "Planned workflow: desktop PASS 17/17, mobile PASS 17/17". */
function matrixLines(results) {
  return (results.flows ?? []).map(flow => {
    const cells = (results.viewports ?? []).map(viewport => {
      const cell = results.matrix?.[flow]?.[viewport];
      if (!cell || cell.status === "not-run") return `${viewport} not run`;
      const extra = [cell.failed ? `${cell.failed} failed` : null, cell.clock ? `${cell.clock} clock-limited` : null, cell.skipped ? `${cell.skipped} skipped` : null].filter(Boolean);
      return `${viewport} ${cell.status.toUpperCase()} ${cell.passed}/${cell.total}${extra.length ? ` (${extra.join(", ")})` : ""}`;
    });
    return `- ${FLOW_TITLES[flow] ?? flow}: ${cells.join(", ")}`;
  });
}

/** The docs/v2-screens/README.md index of the published images (grouped by area, each shown inline). */
export function screensReadme(chosen, results) {
  const clock = results.clock?.start;
  const lines = [
    "# Trading OS V2 screens",
    "",
    `Curated from the scripted browser acceptance run \`${results.runId}\` (${String(results.startedAt ?? "").slice(0, 10)}, strategy clock ${clock ? `${clock.time} UTC−5, ${clock.session}` : "unknown"}; verdict ${String(results.verdict ?? "unknown").toUpperCase()}),`,
    "captured from the local Supabase-compatible stack with the dev server's local mock AI provider. Every account, trade,",
    "screenshot and AI result shown belongs to synthetic users the run created at the reserved domain `example.test`",
    "(seeded with `scripts/local-stack/seed-v2.mjs`); charts inside the screenshots are stamped \"Synthetic chart\".",
    "",
    "Pass matrix of that run:",
    "",
    ...matrixLines(results),
    "",
    "Regenerate (stack and dev server running, see `scripts/local-stack/README.md` → Browser acceptance):",
    "",
    "```sh",
    "node scripts/local-stack/acceptance/run.mjs --publish-screens",
    "```",
    "",
    "Only a run whose verdict is PASS, covering every flow at both viewports and capturing every image below, replaces",
    "this folder; any other run leaves it untouched.",
    "",
  ];
  for (const group of PUBLISHED_GROUPS) {
    const items = group.names.map(name => chosen.find(item => item.name === name)).filter(Boolean);
    if (!items.length) continue;
    lines.push(`## ${group.title}`, "");
    for (const item of items) {
      lines.push(`**${item.title}** · ${viewportLabel(item.viewport)} · ${item.theme === "dark" ? "dark" : "light"} theme${item.full ? " · whole page" : ""}`, "");
      lines.push(`![${item.title.replace(/[[\]]/g, "")}](${item.name}.png)`, "");
    }
  }
  lines.push(`${chosen.length} images, each under ${Math.round(MAX_BYTES / 1024)} KB (PNG). The run's full evidence (every step's screenshots, results.json and summary.md) stays in the git-ignored \`.local/acceptance/<run-id>/\`.`, "");
  return lines.join("\n");
}

/**
 * Whether a run may replace docs/v2-screens/: only a finished run whose verdict is pass, that ran every flow at both
 * viewports and captured every published image. Anything else (a failed, interrupted or partial run, or a missing
 * image) would publish screens of a state that did not pass acceptance, or wipe images it never retook. Returns the
 * reasons it may not.
 */
export function publishRefusal(results, capturedNames) {
  const reasons = [];
  if (results.verdict !== "pass") reasons.push(`the run's verdict is ${String(results.verdict ?? "unknown").toUpperCase()}, not PASS`);
  if (!isFullRun(results.flows, results.viewports)) reasons.push("the run did not cover every flow at both viewports");
  const missing = PUBLISHED.filter(name => !capturedNames.includes(name));
  if (missing.length) reasons.push(`not captured: ${missing.join(", ")}`);
  return reasons;
}

/**
 * Fits every curated candidate of the run into the size budget (in place) and writes curated/index.json. When
 * `publish` is set and publishRefusal() finds nothing against it, replaces the PNGs in docs/v2-screens/ with the
 * published selection plus README.md; otherwise docs/v2-screens/ is left exactly as it was and the reasons are noted.
 */
export async function publishCurated(env, { publish }) {
  const dir = path.join(env.out, "curated");
  fs.mkdirSync(dir, { recursive: true });
  const candidates = env.curated ?? [];
  for (const item of candidates) {
    const file = path.join(env.out, item.file);
    if (!fs.existsSync(file)) continue;
    const { data, method } = await fitPng(fs.readFileSync(file));
    fs.writeFileSync(file, data);
    const meta = await sharp()(data).metadata();
    Object.assign(item, { bytes: data.length, width: meta.width, height: meta.height, encoding: method });
  }
  fs.writeFileSync(path.join(dir, "index.json"), `${JSON.stringify(candidates, null, 2)}\n`);
  if (!publish) return { count: candidates.length, dir, published: null, refused: [] };
  const captured = candidates.filter(item => fs.existsSync(path.join(env.out, item.file))).map(item => item.name);
  const refused = publishRefusal(env.recorder.results, captured);
  if (refused.length) {
    env.recorder.note(`docs/v2-screens/ was not updated: ${refused.join("; ")}`);
    env.recorder.write();
    return { count: candidates.length, dir, published: null, refused };
  }
  const chosen = PUBLISHED.map(name => candidates.find(item => item.name === name));
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  for (const name of fs.readdirSync(DOCS_DIR)) if (name.endsWith(".png")) fs.rmSync(path.join(DOCS_DIR, name));
  for (const item of chosen) fs.copyFileSync(path.join(env.out, item.file), path.join(DOCS_DIR, `${item.name}.png`));
  fs.writeFileSync(path.join(DOCS_DIR, "README.md"), screensReadme(chosen, env.recorder.results));
  env.recorder.note(`docs/v2-screens/ now holds the ${chosen.length} published images of this run`);
  env.recorder.write();
  return { count: candidates.length, dir, published: DOCS_DIR, refused: [] };
}
