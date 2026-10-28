#!/usr/bin/env node
// Scripted browser acceptance of Trading OS V2 (master specification §60 and §64; docs/V2_ARCHITECTURE.md §16.2).
// Drives the RUNNING app (default http://127.0.0.1:3000, loopback only) with an installed Edge/Chrome through
// playwright-core (.local/tools), as fresh SYNTHETIC users it creates for this run (empty ones for onboarding,
// seed-v2.mjs ones where history is needed), at 1440×1000 and 393×852. Every step asserts behaviour through roles,
// labels and visible text and records pass/fail with its evidence and screenshots.
//
// Usage: node scripts/local-stack/acceptance/run.mjs [--flows=planned,live-first,analytics,accounts,ai,settings,ux]
//        [--viewport=desktop|mobile|both] [--out=<dir>] [--base=http://127.0.0.1:3000] [--browser=edge|chrome] [--headed]
//        [--publish-screens]
//   Output: .local/acceptance/<run-id>/ (or --out): results.json, summary.md, screens/<viewport>/<flow>/*.png,
//   curated/*.png, downloads, seed logs and users.private.json (synthetic credentials; git-ignored).
//   --publish-screens copies the curated screenshots into docs/v2-screens/ with a README index, but only after a
//   passing run of every flow at both viewports that captured the whole selection (otherwise docs/ stays untouched).
//   The AI flow uses the dev server's LOCAL mock provider only (scripts/local-stack/mock-openai.mjs); it writes one failure
//   scenario into .local/mock-openai-scenarios.json for a few seconds and restores the file afterwards.
// Exit code 0 when the verdict is pass: no step failed (steps refused by the real strategy clock, such as a lock during
// Dead Pool, are checked against the clock, reported separately and do not fail the run), no §60 criterion failed and,
// in a full run, every criterion has evidence; 1 otherwise.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loopbackBase } from "../fixtures/screenshot-rules.mjs";
import { GATEWAY_URL, LOCAL, REPO, fail, httpStatus, readStack, runMain } from "../lib.mjs";
import { publishCurated } from "./curate.mjs";
import { UserPool } from "./fixtures.mjs";
import accountsFlow from "./flows/accounts.mjs";
import aiFlow from "./flows/ai.mjs";
import analyticsFlow from "./flows/analytics.mjs";
import liveFirstFlow from "./flows/live-first.mjs";
import plannedFlow from "./flows/planned.mjs";
import settingsFlow from "./flows/settings.mjs";
import uxFlow, { finalCriteria } from "./flows/ux.mjs";
import { FlowRun, launchBrowser, Recorder } from "./harness.mjs";
import { FLOW_TITLES, judgeCriteria, OptionError, parseOptions, runIdFor, runVerdict, strategyClock, usage } from "./rules.mjs";

const FLOW_BODIES = { planned: plannedFlow, "live-first": liveFirstFlow, analytics: analyticsFlow, accounts: accountsFlow, ai: aiFlow, settings: settingsFlow, ux: uxFlow };

function log(message) {
  console.log(`[acceptance] ${message}`);
}

await runMain(async () => {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof OptionError) fail(error.message);
    throw error;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const checked = loopbackBase(options.base);
  if (checked.error) fail(checked.error);
  const base = checked.base;
  const stack = readStack();
  if (!stack) fail("Missing .local/stack.json. Start the local stack first: node scripts/local-stack/start.mjs");
  if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`The local gateway is not healthy at ${GATEWAY_URL}. Start the stack first.`);
  if ((await httpStatus(`${base}/login`, { timeoutMs: 120_000 })) !== 200) fail(`The app does not answer at ${base}/login. Start the dev server (with the mock AI provider) first.`);

  const runId = runIdFor(new Date(), randomBytes(3).toString("hex"));
  const out = path.resolve(options.out ?? path.join(LOCAL, "acceptance", runId));
  fs.mkdirSync(out, { recursive: true });
  const clock = strategyClock(Date.now());
  log(`run ${runId}: flows ${options.flows.join(", ")} at ${options.viewports.join(" + ")}; strategy clock ${clock.day} ${clock.time} UTC−5 (${clock.session})`);
  log(`output ${path.relative(REPO, out) || out}`);

  const { instance: browser, info } = await launchBrowser(options);
  const recorder = new Recorder({ runId, out, base, flows: options.flows, viewports: options.viewports, browser: { name: info.name, version: info.version }, clock });
  if (clock.deadPool) recorder.note(`Started during Dead Pool (${clock.time} UTC−5): the Risk Engine refuses new locks until 18:00 UTC−5, so lock-dependent steps of new drafts are recorded as clock-limited and continue on a seeded locked plan.`);
  const users = new UserPool({ stack, runId, out, log });
  const env = { base, out, stack, browser, recorder, users, log, runId, curated: [] };
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    log("Interrupted: finishing the current step, then writing results");
  };
  process.once("SIGINT", onInterrupt);
  try {
    for (const viewport of options.viewports) {
      for (const flow of options.flows) {
        if (interrupted) break;
        log(`--- ${FLOW_TITLES[flow]} · ${viewport} ---`);
        const run = new FlowRun(env, flow, viewport);
        try {
          await FLOW_BODIES[flow](run);
        } catch (error) {
          // A flow body that throws outside a step (a bug in the runner or an unreachable app) is still recorded.
          await run.step("flow-error", "Flow finished without an unexpected error", s => s.check(false, "unexpected error", error instanceof Error ? error.message : String(error)));
        } finally {
          await run.close();
          recorder.results.users = users.list();
          recorder.write();
        }
      }
    }
    finalCriteria(env);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await browser.close().catch(() => {});
  }

  const failed = recorder.results.steps.filter(step => step.status === "fail");
  recorder.results.users = users.list();
  const { verdict, reasons } = runVerdict({
    steps: recorder.results.steps, criteria: judgeCriteria(recorder.results.criteria), flows: options.flows, viewports: options.viewports, interrupted,
  });
  recorder.finish(verdict, strategyClock(Date.now()), reasons);
  const curated = await publishCurated(env, { publish: options.publish });
  const published = curated.published ? ` and published to ${path.relative(REPO, curated.published)}` : "";
  log(`curated screenshots: ${curated.count} in ${path.relative(REPO, curated.dir)}${published}`);
  if (options.publish && !curated.published) log(`not published to docs/v2-screens: ${curated.refused.join("; ")}`);
  const matrix = recorder.results.matrix;
  for (const flow of options.flows) log(`${FLOW_TITLES[flow].padEnd(34)} ${options.viewports.map(v => `${v}: ${matrix[flow][v].status.toUpperCase()} ${matrix[flow][v].passed}/${matrix[flow][v].total}`).join("   ")}`);
  for (const step of failed) log(`FAILED ${step.flow}/${step.viewport} ${step.id}: ${step.error}`);
  for (const criterion of recorder.results.uxCriteria.filter(item => item.verdict === "fail")) log(`FAILED criterion ${criterion.id}: ${criterion.text}`);
  log(`results: ${path.relative(REPO, path.join(out, "results.json"))} · summary: ${path.relative(REPO, path.join(out, "summary.md"))}`);
  if (verdict !== "pass") fail(`Verdict ${verdict.toUpperCase()}: ${reasons.join("; ")}`);
  log("Verdict PASS: every step passed and every §60 criterion with evidence held");
});
