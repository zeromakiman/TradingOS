// Tests for the pure rules behind seed-v2.mjs and screenshot.mjs (no stack, browser or network needed).
// Run: node --test scripts/local-stack/fixtures/seed-v2-scripts.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { failureSummary, isLoopbackHost, judgePages, loopbackBase, nextEnvRewrittenByDev } from "./screenshot-rules.mjs";
import { buildDataset, session, showcaseDescriptions } from "./v2-dataset.mjs";

const SCREENSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "screenshot.mjs");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DEAD_POOL = Date.parse("2026-10-21T19:00:00Z"); // Wednesday 14:00 UTC−5
const KILL_ZONE = Date.parse("2026-10-21T14:00:00Z"); // Wednesday 09:00 UTC−5

describe("screenshot.mjs --base", () => {
  it("accepts loopback origins and normalises them", () => {
    assert.deepEqual(loopbackBase("http://127.0.0.1:3000"), { base: "http://127.0.0.1:3000" });
    assert.deepEqual(loopbackBase("http://127.0.0.1:3000/"), { base: "http://127.0.0.1:3000" });
    assert.deepEqual(loopbackBase("http://localhost:3001"), { base: "http://localhost:3001" });
    assert.deepEqual(loopbackBase("http://[::1]:3000"), { base: "http://[::1]:3000" });
    assert.deepEqual(loopbackBase("https://127.0.0.2:8443"), { base: "https://127.0.0.2:8443" });
  });

  it("rejects hosted and look-alike origins", () => {
    for (const raw of [
      "https://example.com",
      "https://trading-os-preview.vercel.app",
      "http://127.0.0.1.example.com:3000",
      "http://localhost.example.com",
      "http://0.0.0.0:3000",
      "http://10.0.0.5:3000",
      "http://[::ffff:7f00:1]:3000",
    ]) {
      assert.match(loopbackBase(raw).error ?? "", /must be a loopback URL/, raw);
      assert.equal(loopbackBase(raw).base, undefined, raw);
    }
  });

  it("rejects non-origins, credentials and other schemes", () => {
    assert.match(loopbackBase("http://127.0.0.1:3000/app").error, /must be an origin/);
    assert.match(loopbackBase("http://127.0.0.1:3000/?x=1").error, /must be an origin/);
    assert.match(loopbackBase("http://user:secret@127.0.0.1:3000").error, /must be an origin/);
    assert.match(loopbackBase("ftp://127.0.0.1").error, /http or https/);
    assert.match(loopbackBase("not a url").error, /must be an http URL/);
  });

  it("recognises loopback hostnames only", () => {
    assert.equal(isLoopbackHost("127.255.255.254"), true);
    assert.equal(isLoopbackHost("127.256.0.1"), false);
    assert.equal(isLoopbackHost("128.0.0.1"), false);
    assert.equal(isLoopbackHost("::1"), false); // URL#hostname brackets IPv6: "[::1]"
  });

  it("exits before starting a browser when --base is not loopback", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-test-"));
    try {
      const run = spawnSync(process.execPath, [SCREENSHOT, "--user=nobody@example.test", `--out=${out}`, "--base=https://example.com", "today"], { encoding: "utf8", timeout: 30_000 });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /--base must be a loopback URL/);
      assert.doesNotMatch(run.stdout, /Signed in|Browser/);
      assert.deepEqual(fs.readdirSync(out), []);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses --start-app with another origin than the app it starts", () => {
    const run = spawnSync(process.execPath, [SCREENSHOT, "--start-app", "--user=nobody@example.test", "--out=unused", "--base=http://localhost:3000", "today"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--start-app runs the app on http:\/\/127\.0\.0\.1:3000/);
  });
});

describe("screenshot.mjs page verdict", () => {
  const page = (path, status) => ({ path, status });

  it("passes when every page answers 2xx", () => {
    const verdict = judgePages([page("/today", 200), page("/journal", 200)]);
    assert.equal(verdict.failing.length, 0);
    assert.equal(verdict.notOk.length, 0);
  });

  it("fails a requested page that answers 4xx unless --allow-4xx", () => {
    const pages = [page("/today", 200), page("/trades/abc", 404), page("/accounts/x/manage", 403)];
    const strict = judgePages(pages);
    assert.deepEqual(strict.failing.map(p => p.path), ["/trades/abc", "/accounts/x/manage"]);
    assert.equal(failureSummary(strict, pages.length), "2 of 3 page(s) failed: 2 answered HTTP 4xx (pass --allow-4xx when a missing page is expected)");

    const lenient = judgePages(pages, { allow4xx: true });
    assert.equal(lenient.failing.length, 0);
    assert.deepEqual(lenient.notOk.map(p => p.path), ["/trades/abc", "/accounts/x/manage"]);
  });

  it("always fails server errors and pages that could not be loaded", () => {
    const pages = [page("/today", 500), page("/journal", null), page("/edge", 404)];
    const verdict = judgePages(pages, { allow4xx: true });
    assert.deepEqual(verdict.failing.map(p => p.path), ["/today", "/journal"]);
    assert.equal(failureSummary(verdict, pages.length, { allow4xx: true }), "2 of 3 page(s) failed: 1 answered HTTP >= 500, 1 could not be loaded");
    assert.equal(failureSummary(judgePages(pages), pages.length), "3 of 3 page(s) failed: 1 answered HTTP 4xx, 1 answered HTTP >= 500, 1 could not be loaded (pass --allow-4xx when a missing page is expected)");
  });
});

describe("next-env.d.ts check", () => {
  it("tells the committed form from the one next dev writes", () => {
    assert.equal(nextEnvRewrittenByDev('import "./.next/types/routes.d.ts";\nimport "./.next/types/root-params.d.ts";\n'), false);
    assert.equal(nextEnvRewrittenByDev('import "./.next/dev/types/routes.d.ts";\nimport "./.next/dev/types/root-params.d.ts";\n'), true);
  });
});

describe("seed-v2 showcase descriptions", () => {
  it("names the same twenty trades in the same order either way", () => {
    const names = Object.keys(showcaseDescriptions({ deadPool: false }));
    assert.equal(names.length, 20);
    assert.deepEqual(Object.keys(showcaseDescriptions({ deadPool: true })), names);
  });

  it("describes the waiting plan and ready draft of a Dead Pool seed as seeded", () => {
    const dataset = buildDataset({ variant: 0, userId: USER_ID, nowMs: DEAD_POOL });
    assert.equal(session(DEAD_POOL), "DEAD_POOL");
    assert.equal(dataset.plan.deadPool, true);
    // The waiting plan is locked this morning through SQL (no RPC step, so no Analyze Setup runs on it).
    assert.equal(dataset.plan.waiting.viaSql, true);
    assert.ok(dataset.history.some(call => call.fn === "seed_lock" && JSON.stringify(call.args).includes(dataset.plan.waiting.tradeId)));
    const text = showcaseDescriptions(dataset.plan);
    assert.doesNotMatch(text.todayWaiting, /Analyze Setup/);
    assert.match(text.todayWaiting, /locked this morning, no AI analysis/);
    assert.match(text.todayReady, /Analyze Setup and Challenge My Bias/);
    assert.match(text.todayReady, /Recheck needed/);
    assert.doesNotMatch(text.todayReady, /Ready to lock/);
  });

  it("describes the waiting plan and ready draft of a seed outside Dead Pool as seeded", () => {
    const dataset = buildDataset({ variant: 0, userId: USER_ID, nowMs: KILL_ZONE });
    assert.equal(dataset.plan.deadPool, false);
    assert.equal(dataset.plan.waiting.viaSql, false);
    assert.ok(!dataset.history.some(call => call.fn === "seed_lock" && JSON.stringify(call.args).includes(dataset.plan.waiting.tradeId)));
    const text = showcaseDescriptions(dataset.plan);
    assert.match(text.todayWaiting, /Analyze Setup completed/);
    assert.match(text.todayReady, /Challenge My Bias; Ready to lock$/);
    assert.doesNotMatch(text.todayReady, /Analyze Setup|Recheck/);
  });
});
