#!/usr/bin/env node
// Seeds a rich, deterministic, SYNTHETIC Trading OS V2 dataset into the LOCAL Supabase-compatible stack, for browser
// acceptance (docs/V2_ARCHITECTURE.md §16.2). Never contacts a hosted project or an AI provider.
//
// Usage: node scripts/local-stack/seed-v2.mjs [--users=a@example.test,b@example.test] [--reset-users]
//   --users        synthetic users to seed (reserved domains only); default v2.trader.a@example.test,v2.trader.b@example.test
//   --reset-users  a requested user that already has data gets a fresh user (local+r2@…, +r3, …) instead; nothing is
//                  ever deleted. Without it, the seed refuses to touch any user that already has data.
//
// For every user: three trading accounts (FTMO 100K USD evaluation on MT5, Personal 12K EUR on cTrader with DE40/FRA40,
// Demo 100K USD), ~90 days of history (≈70 closed trades: planned OB/OTE wins, losses and break-evens with oversized
// fills, skipped/cancelled plans, discarded and revised drafts, live-first trades with and without a risk basis),
// journal entries in every timing band including a back-dated entry, generated chart screenshots, tags, external
// losses, risk-plan changes, today's live/waiting/blocked/ready trades, and AI history (completed and failed).
//
// How records are written:
//   * NOW, through the V2 RPCs as the user (JWT from the password grant) and the service-only evidence/AI RPCs with the
//     local secret key: today's drafts, locks, fills/closes logged now, journal notes, tags, reviews, evidence
//     registration, instruments, profile, risk changes, account values, external loss, AI requests (start ->
//     authorize -> reserve -> dispatch -> settle -> finish; usage is synthetic, no provider is called).
//   * HISTORY (every record whose time is in the past) through superuser psql, in one transaction, with the pg_temp
//     helpers in fixtures/seed-v2-history.sql. Each helper inserts what the named RPC inserts, with its validation and
//     the Risk Engine evaluated at that past moment (Dead Pool, slots, caps, stale equity all apply). Insert-only:
//     no update, no delete, no trigger disabled. The RPCs cannot backdate their clock_timestamp() records.
// AI facts, contracts and output validation come from the application's own modules (src/ai, src/domain), loaded
// with Node's TypeScript support, so stored history is exactly what the app would have written.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { renderChart } from "./fixtures/v2-charts.mjs";
import { analyzeOutput, challengeOutput, hindsightRaw, invalidAnalysisRaw, timelineReviewOutput, weeklyOutput } from "./fixtures/v2-copy.mjs";
import {
  DATASET_VERSION, buildDataset, dayStart, historyShowcase, iso, session, showcaseDescriptions, strategyDay, uuidFor,
} from "./fixtures/v2-dataset.mjs";
import { GATEWAY_URL, LOCAL, PATHS, REPO, fail, httpStatus, log, psql, readStack, runMain, sqlValue } from "./lib.mjs";
import { seedAiPricing } from "./seed-ai-pricing.mjs";

const TRANSFORM_FLAG = "--experimental-transform-types";
const DEFAULT_USERS = ["v2.trader.a@example.test", "v2.trader.b@example.test"];
const USERS_FILE = path.join(LOCAL, "seed-v2-users.json");
const HELPERS_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "seed-v2-history.sql");
const BUCKET = "trade-evidence";
const SRC = path.join(REPO, "src");
const MIN = 60_000;
const SYNTHETIC_EMAIL = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*(?:example\.(?:test|com|org|net)|[a-z0-9-]+\.(?:test|invalid|localhost))$/i;
const MIME = { png: "image/png", webp: "image/webp", jpeg: "image/jpeg" };

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = name => process.argv.includes(`--${name}`);
const sha256 = value => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// Application modules (pure TypeScript under src/, resolved like the app's "@/..." alias)
// ---------------------------------------------------------------------------------------------------------------
function installSourceHooks() {
  const candidates = base => [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  const inSource = url => url?.startsWith("file:") && fileURLToPath(url).startsWith(SRC + path.sep);
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D%3B", shortCircuit: true };
      let base = null;
      if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
      else if (/^\.\.?\//.test(specifier) && inSource(context.parentURL)) base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      const hit = base ? candidates(base).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) : null;
      return hit ? { url: pathToFileURL(hit).href, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (inSource(url) && url.endsWith(".json")) return { format: "module", source: `export default ${fs.readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
      return next(url, context);
    },
  });
}

async function loadApp() {
  installSourceHooks();
  const load = file => import(pathToFileURL(path.join(SRC, file)).href);
  const [operations, contracts, pricing, analyzeContext, biasContext, timelineContext, weeklyContext, analyzeContract, biasContract, timelineContract, weeklyContract, citations, riskReport, ledger, weeklyPeriod, analytics] = await Promise.all([
    load("ai/operations.ts"), load("ai/operation-contract.ts"), load("ai/pricing.ts"), load("ai/analyze-setup-context.ts"), load("ai/bias-challenge-context.ts"),
    load("ai/trade-timeline-review-context.ts"), load("ai/weekly-review-context.ts"), load("ai/analyze-setup-contract.ts"), load("ai/bias-challenge-contract.ts"),
    load("ai/trade-timeline-review-contract.ts"), load("ai/weekly-review-contract.ts"), load("ai/citation-sources.ts"), load("domain/risk-report.ts"),
    load("domain/ledger.ts"), load("ai/weekly-period.ts"), load("domain/analytics.ts"),
  ]);
  return { operations, contracts, pricing, analyzeContext, biasContext, timelineContext, weeklyContext, analyzeContract, biasContract, timelineContract, weeklyContract, citations, riskReport, ledger, weeklyPeriod, analytics };
}

// ---------------------------------------------------------------------------------------------------------------
// Local gateway: REST RPCs, auth, storage
// ---------------------------------------------------------------------------------------------------------------
function gateway(stack) {
  async function request(method, url, { headers = {}, body } = {}) {
    const response = await fetch(`${GATEWAY_URL}${url}`, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, ok: response.ok, data };
  }
  const json = (key, token) => ({ apikey: key, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
  async function rpc(name, params, token) {
    const result = await request("POST", `/rest/v1/rpc/${name}`, { headers: json(token ? stack.publishableKey : stack.secretKey, token), body: JSON.stringify(params) });
    if (!result.ok) {
      const error = new Error(`${name}: ${typeof result.data === "object" && result.data ? result.data.message ?? JSON.stringify(result.data) : result.data}`);
      error.rpcMessage = result.data?.message ?? "";
      throw error;
    }
    return result.data;
  }
  return {
    request,
    asUser: token => (name, params) => rpc(name, params, token),
    asService: (name, params) => rpc(name, params, null),
    async signIn(email, password) {
      const result = await request("POST", "/auth/v1/token?grant_type=password", { headers: json(stack.publishableKey), body: JSON.stringify({ email, password }) });
      if (!result.ok || !result.data?.access_token) fail(`Password sign-in failed for ${email}: ${result.data?.msg ?? result.status}`);
      return result.data.access_token;
    },
    async upload(objectPath, bytes, mime) {
      const result = await request("POST", `/storage/v1/object/${BUCKET}/${objectPath}`, { headers: { apikey: stack.secretKey, "content-type": mime, "x-upsert": "false" }, body: bytes });
      if (result.ok) return;
      // As in the upload route: an existing object with identical bytes is a replay (e.g. a retried seed of a user
      // whose history transaction was rolled back); anything else is an error.
      if (String(result.data?.statusCode) === "409" && sha256(await this.download(objectPath)) === sha256(bytes)) return;
      throw new Error(`Storage upload ${objectPath}: ${JSON.stringify(result.data)}`);
    },
    async download(objectPath) {
      const response = await fetch(`${GATEWAY_URL}/storage/v1/object/authenticated/${BUCKET}/${objectPath}`, { headers: { apikey: stack.secretKey } });
      if (!response.ok) throw new Error(`Storage download ${objectPath}: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    userDb: token => createClient(GATEWAY_URL, stack.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { authorization: `Bearer ${token}` } },
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------
function readUsersFile() {
  try { const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); return parsed.project === GATEWAY_URL ? parsed : null; } catch { return null; }
}
function knownPassword(email) {
  const seeded = readUsersFile()?.users?.find(u => u.email === email)?.password;
  if (seeded) return seeded;
  try {
    const integration = JSON.parse(fs.readFileSync(PATHS.users, "utf8"));
    return integration.project === GATEWAY_URL ? integration.users?.find(u => u.email === email)?.password ?? null : null;
  } catch { return null; }
}
function rememberUser(entry) {
  const current = readUsersFile() ?? { project: GATEWAY_URL, users: [] };
  const users = [...current.users.filter(u => u.email !== entry.email), entry];
  fs.writeFileSync(USERS_FILE, `${JSON.stringify({ project: GATEWAY_URL, note: "LOCAL synthetic users created by scripts/local-stack/seed-v2.mjs. Never use elsewhere.", users }, null, 2)}\n`, { mode: 0o600 });
}

/** Decides, before anything is written, which user each requested email maps to. */
async function resolveUsers(stack, admin, emails, reset) {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) fail(`Unable to list users: ${error.message}`);
  const byEmail = new Map(data.users.map(u => [u.email, u]));
  const hasData = id => sqlValue(stack, `select count(*) from public.accounts where user_id = '${id}'`) !== "0";
  const plans = [];
  for (const email of emails) {
    let target = email;
    const existing = byEmail.get(email);
    if (existing && hasData(existing.id)) {
      if (!reset) fail(`${email} already has Trading OS data. Nothing was changed. Re-run with --reset-users to seed a fresh user instead (nothing is deleted).`);
      const [local, domain] = email.split("@");
      const base = local.replace(/\+r\d+$/, "");
      for (let n = 2; ; n++) {
        const candidate = `${base}+r${n}@${domain}`;
        const user = byEmail.get(candidate);
        if (!user || !hasData(user.id)) { target = candidate; break; }
      }
    }
    plans.push({ requested: email, email: target, existing: byEmail.get(target) ?? null });
  }
  return plans;
}

async function ensureUser(admin, net, plan) {
  if (plan.existing) {
    const known = knownPassword(plan.email);
    if (known) {
      try { await net.signIn(plan.email, known); return { id: plan.existing.id, email: plan.email, password: known, created: false }; } catch { /* reset below */ }
    }
    const password = `Tos!${randomBytes(18).toString("base64url")}`;
    const { error } = await admin.auth.admin.updateUserById(plan.existing.id, { password, email_confirm: true });
    if (error) fail(`Unable to reset the password of ${plan.email}: ${error.message}`);
    return { id: plan.existing.id, email: plan.email, password, created: false };
  }
  const password = `Tos!${randomBytes(18).toString("base64url")}`;
  const { data, error } = await admin.auth.admin.createUser({ email: plan.email, password, email_confirm: true, user_metadata: { purpose: "Trading OS V2 synthetic dataset (local stack)" } });
  if (error || !data.user) fail(`Unable to create ${plan.email}: ${error?.message ?? "no user returned"}`);
  return { id: data.user.id, email: plan.email, password, created: true };
}

// ---------------------------------------------------------------------------------------------------------------
// History SQL
// ---------------------------------------------------------------------------------------------------------------
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function sqlArg(arg, evidenceRecords) {
  switch (arg.t) {
    case "uuid": return arg.v === null ? "null::uuid" : `${quote(arg.v)}::uuid`;
    case "text": return arg.v === null || arg.v === undefined ? "null::text" : quote(arg.v);
    case "jsonb": return `${quote(JSON.stringify(arg.v))}::jsonb`;
    case "ts": return `${quote(iso(arg.v))}::timestamptz`;
    case "numeric": return arg.v === null ? "null::numeric" : `${quote(arg.v)}::numeric`;
    case "bool": return arg.v ? "true" : "false";
    case "textarray": return `array[${arg.v.map(quote).join(",")}]::text[]`;
    case "evidence": {
      const record = evidenceRecords.get(arg.v);
      if (!record) throw new Error(`No rendered evidence ${arg.v}`);
      return `${quote(JSON.stringify(record))}::jsonb`;
    }
    default: throw new Error(`Unknown SQL argument type ${arg.t}`);
  }
}
function runHistory(stack, dataset, evidenceRecords, userId) {
  const lines = ["set client_min_messages = warning;", fs.readFileSync(HELPERS_SQL, "utf8")];
  for (const step of dataset.history) lines.push(`select pg_temp.${step.fn}(${step.args.map(a => sqlArg(a, evidenceRecords)).join(", ")});`);
  fs.mkdirSync(path.join(LOCAL, "tmp"), { recursive: true });
  const file = path.join(LOCAL, "tmp", `seed-v2-${userId.slice(0, 8)}.sql`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  try {
    psql(stack, ["--single-transaction", "-At", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-f", file]);
  } catch (error) {
    throw new Error(`History SQL failed and was rolled back (kept for inspection: ${path.relative(REPO, file)}):\n${error.message.split("\n").slice(0, 6).join("\n")}`);
  }
  fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------------------------
async function renderEvidence(sharp, specs) {
  const rendered = new Map();
  for (const spec of specs) {
    const bytes = await renderChart(sharp, spec.chart, spec.format);
    const meta = await sharp(bytes).metadata();
    rendered.set(spec.id, { bytes, sha256: sha256(bytes), byteSize: bytes.length, width: meta.width, height: meta.height, mimeType: MIME[spec.format] });
  }
  return rendered;
}
const evidenceRecord = (spec, image, tradeId, extra = {}) => ({
  id: spec.id, tradeId, label: spec.label, timeframe: spec.timeframe, caption: spec.caption, originalFilename: spec.filename,
  mimeType: image.mimeType, byteSize: image.byteSize, sha256: image.sha256, width: image.width, height: image.height, captureMethod: spec.captureMethod, ...extra,
});

// ---------------------------------------------------------------------------------------------------------------
// Seeding one user
// ---------------------------------------------------------------------------------------------------------------
async function seedUser(ctx, user, variant) {
  const { stack, net, app, sharp } = ctx;
  const nowMs = Date.now();
  const dataset = buildDataset({ variant, userId: user.id, nowMs });
  const { accounts, plan, marks } = dataset;
  log(`  dataset ${DATASET_VERSION}/${variant}: ${dataset.history.length} history steps, ${dataset.evidence.length} screenshots; strategy day ${dataset.day} (${session(nowMs).replace(/_/g, " ").toLowerCase()}${plan.deadPool ? ", locks refused until 18:00 UTC−5" : ""}${plan.compressed ? ", early-morning times compressed" : ""})`);

  // 1. Screenshots: render all, upload those of history now (their trades have deterministic ids).
  const images = await renderEvidence(sharp, dataset.evidence);
  const sqlEvidence = dataset.evidence.filter(spec => spec.via === "SQL");
  for (const spec of sqlEvidence) await net.upload(`${user.id}/${spec.tradeId}/${spec.id}`, images.get(spec.id).bytes, images.get(spec.id).mimeType);
  const records = new Map(sqlEvidence.map(spec => [spec.id, evidenceRecord(spec, images.get(spec.id), spec.tradeId)]));
  log(`  rendered ${images.size} chart screenshots; uploaded ${sqlEvidence.length} history screenshots to ${BUCKET}`);

  // 2. History (one transaction).
  runHistory(stack, dataset, records, user.id);
  log(`  history written (${dataset.history.length} steps, one transaction)`);

  // 3. Now: RPCs as the user and the service-only evidence/AI RPCs.
  const token = await net.signIn(user.email, user.password);
  const rpc = net.asUser(token);
  const db = net.userDb(token);
  const key = (...parts) => uuidFor(DATASET_VERSION, user.id, "now", ...parts);
  const register = async (spec, tradeId, extra = {}) => {
    const image = images.get(spec.id);
    await net.upload(`${user.id}/${tradeId}/${spec.id}`, image.bytes, image.mimeType);
    await net.asService("register_trade_evidence", { p_user_id: user.id, p_record: evidenceRecord(spec, image, tradeId, extra) });
    return { id: spec.id, role: spec.timeframe ?? spec.label, sha256: image.sha256, mime_type: image.mimeType, byte_size: image.byteSize, bytes: image.bytes };
  };
  const expected = async accountId => {
    const [risk, observation] = await Promise.all([
      db.from("risk_plan_versions").select("id,effective_day,created_at").eq("account_id", accountId).lte("effective_day", strategyDay(Date.now())).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).single(),
      db.from("account_observations").select("id").eq("account_id", accountId).order("recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1).single(),
    ]);
    if (risk.error || observation.error) throw new Error("Unable to read the account context");
    return { p_expected_risk_id: risk.data.id, p_expected_observation_id: observation.data.id };
  };
  const balanceOf = account => sqlValue(stack, `select round(p.starting_balance
      + coalesce((select sum(o.net_pnl) from public.trade_outcomes o where o.account_id = a.id), 0)
      + coalesce((select sum(c.net_pnl) from public.trade_unplanned_closes c where c.account_id = a.id), 0)
      - coalesce((select sum(x.amount) from public.external_loss_entries x where x.account_id = a.id
                   and not exists (select 1 from public.external_loss_removals r where r.entry_id = x.id)), 0), 2)
    from public.accounts a join lateral (select starting_balance from public.account_profiles where account_id = a.id order by id desc limit 1) p on true
    where a.id = '${account.id}'`);
  const ledger = async tradeId => {
    const { data, error } = await db.from("trade_ledger").select(app.ledger.LEDGER_COLUMNS.join(",")).eq("id", tradeId).single();
    if (error) throw new Error(`Ledger row ${tradeId}: ${error.message}`);
    return app.ledger.ledgerRow.parse(data);
  };
  const ai = aiRunner({ ...ctx, user, db, images });
  const notes = [];

  // 3a. Accounts: profile revision, new contract versions, AI preferences (with consent).
  await rpc("update_account_profile", { p_account_id: accounts.personal.id, p_input: plan.profileUpdate.input });
  const instrumentIds = [];
  for (const instrument of plan.instruments) instrumentIds.push(await rpc("create_instrument_version", { p_account_id: accounts[instrument.account].id, p_input: instrument.input }));
  const [de40v2] = instrumentIds;
  await rpc("set_account_ai_preferences", { p_account_id: accounts.ftmo.id, p_enabled: true, p_budget_cents: 500, p_confirm: true });
  await rpc("set_account_ai_preferences", { p_account_id: accounts.ftmo.id, p_enabled: null, p_budget_cents: 1000, p_confirm: false });
  await rpc("set_account_ai_preferences", { p_account_id: accounts.personal.id, p_enabled: true, p_budget_cents: 300, p_confirm: true });

  // 3b. FTMO: today's planned trade closed now (exit earlier today), its review notes, tags and exit screenshot.
  {
    const closed = plan.ftmoClosed;
    const quantity = (await ledger(closed.tradeId)).quantity;
    const [whole, fraction = ""] = quantity.split(".");
    const units = Number(whole) * 10 ** fraction.length + Number(fraction || "0");
    const feeCents = Math.round((units * closed.feeCentsPerLot) / 10 ** fraction.length);
    await rpc("close_planned_trade", { p_trade_id: closed.tradeId, p_exit: closed.exit, p_exited_at: closed.exitedAt, p_fees: `${Math.floor(feeCents / 100)}.${String(feeCents % 100).padStart(2, "0")}` });
    await rpc("add_journal_entry", { p_trade_id: closed.tradeId, p_kind: "LESSON", p_body: closed.lesson, p_details: {}, p_request_key: key("ftmo-closed-lesson") });
    await rpc("set_trade_tags", { p_trade_id: closed.tradeId, p_grade: closed.tags.grade, p_liquidity: closed.tags.liquidity, p_mss: closed.tags.mss, p_tags: closed.tags.tags });
    await register(closed.evidence, closed.tradeId);
    marks.todayClosed = closed.tradeId;
  }
  // Account values now, then the risk policy: an immediate tightening and a loosening scheduled for tomorrow.
  for (const account of Object.values(accounts)) {
    const balance = balanceOf(account);
    await rpc("record_account_values", { p_account_id: account.id, p_balance: balance, p_equity: balance });
  }
  for (const change of plan.riskChanges) {
    await rpc("create_risk_policy_version", { p_account_id: accounts.ftmo.id, p_config: change.config, p_immediate: change.immediate, p_reason: change.reason });
  }
  await rpc("save_daily_context", { p_account_id: accounts.ftmo.id, p_narrative: plan.dailyContext });

  // 3c. FTMO waiting plan: draft + screenshot + Analyze Setup, then the lock (real clock), unless Dead Pool.
  let waitingTradeId = plan.waiting.tradeId;
  if (!plan.waiting.viaSql) {
    const created = await rpc("create_planned_trade", { p_account_id: accounts.ftmo.id, p_proposal: plan.waiting.proposal, p_request_key: plan.waiting.requestKey, ...(await expected(accounts.ftmo.id)) });
    waitingTradeId = created.tradeId;
    if (created.result?.decision !== "APPROVED") notes.push(`waiting plan draft was ${created.result?.decision}: ${(created.result?.issues ?? []).map(i => i.code).join(", ")}`);
    const selected = [];
    for (const spec of plan.waiting.evidence) selected.push(await register(spec, waitingTradeId));
    await ai.preTrade({ operation: "ANALYZE_SETUP", tradeId: waitingTradeId, proposalId: created.proposalId, accountId: accounts.ftmo.id, evidence: selected, outcome: "COMPLETED" });
    const locked = await rpc("lock_trade", { p_trade_id: waitingTradeId, p_expected_revision: 1 });
    if (!locked.planId) notes.push(`waiting plan was not locked: ${(locked.result?.issues ?? []).filter(i => i.severity === "BLOCK").map(i => i.code).join(", ")}`);
  }

  // 3d. FTMO blocked draft (risk above the new maximum): Analyze rev 1, a challenge cancelled by the revision, a failed
  // analysis of rev 2 (output rejected by the contract).
  {
    const created = await rpc("create_planned_trade", { p_account_id: accounts.ftmo.id, p_proposal: plan.blocked.proposal, p_request_key: plan.blocked.requestKey, ...(await expected(accounts.ftmo.id)) });
    await ai.preTrade({ operation: "ANALYZE_SETUP", tradeId: created.tradeId, proposalId: created.proposalId, accountId: accounts.ftmo.id, evidence: [], outcome: "COMPLETED", blocked: true });
    let revised = null;
    await ai.preTrade({
      operation: "CHALLENGE_BIAS", tradeId: created.tradeId, proposalId: created.proposalId, accountId: accounts.ftmo.id, evidence: [], outcome: "CANCELLED",
      beforeDispatch: async () => {
        revised = await rpc("revise_trade_draft", { p_trade_id: created.tradeId, p_proposal: plan.blocked.revision.proposal, p_request_key: plan.blocked.revision.requestKey, p_expected_revision: 1, ...(await expected(accounts.ftmo.id)) });
      },
    });
    await ai.preTrade({ operation: "ANALYZE_SETUP", tradeId: created.tradeId, proposalId: revised.proposalId, accountId: accounts.ftmo.id, evidence: [], outcome: "INVALID" });
    marks.todayBlocked = created.tradeId;
  }

  // 3e. FTMO ready-to-lock draft with two screenshots and a completed Challenge My Bias (the last FTMO usage change).
  {
    let tradeId = plan.ready.tradeId, proposalId = plan.ready.proposalId;
    if (!plan.ready.viaSql) {
      const created = await rpc("create_planned_trade", { p_account_id: accounts.ftmo.id, p_proposal: plan.ready.proposal, p_request_key: plan.ready.requestKey, ...(await expected(accounts.ftmo.id)) });
      tradeId = created.tradeId;
      proposalId = created.proposalId;
      if (created.result?.decision !== "APPROVED") notes.push(`ready draft was ${created.result?.decision}: ${(created.result?.issues ?? []).filter(i => i.severity === "BLOCK").map(i => i.code).join(", ")}`);
    }
    const selected = [];
    for (const spec of plan.ready.evidence) {
      const image = images.get(spec.id);
      selected.push(plan.ready.viaSql
        ? { id: spec.id, role: spec.timeframe ?? spec.label, sha256: image.sha256, mime_type: image.mimeType, byte_size: image.byteSize, bytes: image.bytes }
        : await register(spec, tradeId));
    }
    // During Dead Pool the waiting plan was locked this morning (SQL), before any analysis could run on it; the
    // completed Analyze Setup then belongs to this draft, which keeps the same AI history either way.
    if (plan.waiting.viaSql) await ai.preTrade({ operation: "ANALYZE_SETUP", tradeId, proposalId, accountId: accounts.ftmo.id, evidence: selected, outcome: "COMPLETED" });
    await ai.preTrade({ operation: "CHALLENGE_BIAS", tradeId, proposalId, accountId: accounts.ftmo.id, evidence: selected, outcome: "COMPLETED" });
    marks.todayReady = tradeId;
  }
  marks.todayWaiting = waitingTradeId;

  // 3f. Personal: live-first DE40 trade on the new contract version, notes and a management screenshot.
  {
    const live = plan.personalLive;
    const tradeId = await rpc("record_live_trade", { p_account_id: accounts.personal.id, p_input: { ...live.input, instrumentId: de40v2 }, p_request_key: live.requestKey });
    for (const [i, [kind, body, details]] of live.notes.entries()) {
      await rpc("add_journal_entry", { p_trade_id: tradeId, p_kind: kind, p_body: body, p_details: details, p_request_key: key("personal-live", i) });
    }
    await register(live.evidence, tradeId);
    marks.todayPersonalLive = tradeId;
  }

  // 3g. Demo: a note on the live planned trade, a live-first trade logged after it closed, an external loss, and a
  // duplicated draft (copying the source's pre-entry screenshots) that the daily trade limit blocks.
  {
    await rpc("add_journal_entry", { p_trade_id: plan.demoLive.tradeId, p_kind: "STOP_CHANGE", p_body: plan.demoLive.note, p_details: { price: plan.demoLive.stop }, p_request_key: key("demo-live-stop") });
    await register(plan.demoLive.evidence, plan.demoLive.tradeId);
    marks.todayPlannedLive = plan.demoLive.tradeId;
    const closedId = await rpc("record_live_trade", { p_account_id: accounts.demo.id, p_input: plan.demoClosed.input, p_request_key: plan.demoClosed.requestKey });
    await rpc("close_live_trade", { p_trade_id: closedId, p_input: plan.demoClosed.close });
    await rpc("add_journal_entry", { p_trade_id: closedId, p_kind: "LESSON", p_body: plan.demoClosed.lesson, p_details: {}, p_request_key: key("demo-closed-lesson") });
    marks.todayLiveFirstClosed = closedId;
    await rpc("add_external_loss", { p_account_id: accounts.demo.id, p_amount: plan.externalLoss.amount, p_note: plan.externalLoss.note, p_request_key: key("demo-external-loss") });
    if (marks.duplicateSource) {
      const copy = await rpc("duplicate_trade_draft", { p_trade_id: marks.duplicateSource, p_request_key: key("demo-duplicate"), ...(await expected(accounts.demo.id)) });
      // §7.4: only evidence that was Before entry in the source may be copied (stored pre-entry, recorded before the fill).
      const sourceEntry = (await ledger(marks.duplicateSource)).entered_at;
      const { data: sources } = await db.from("trade_evidence").select("id,storage_path,label,timeframe,caption,original_filename,mime_type,byte_size,sha256,width,height,phase,recorded_at")
        .eq("trade_id", marks.duplicateSource).eq("phase", "PRE_ENTRY").order("recorded_at");
      const copyable = (sources ?? []).filter(source => !sourceEntry || Date.parse(source.recorded_at) < Date.parse(sourceEntry));
      for (const [i, source] of copyable.entries()) {
        const bytes = await net.download(source.storage_path);
        const copyId = key("demo-duplicate-evidence", i);
        await net.upload(`${user.id}/${copy.tradeId}/${copyId}`, bytes, source.mime_type);
        await net.asService("register_trade_evidence", { p_user_id: user.id, p_record: {
          id: copyId, tradeId: copy.tradeId, label: source.label, timeframe: source.timeframe, caption: source.caption, originalFilename: source.original_filename,
          mimeType: source.mime_type, byteSize: source.byte_size, sha256: source.sha256, width: source.width, height: source.height, captureMethod: "DUPLICATE", copiedFrom: source.id,
        } });
      }
      marks.todayDuplicate = copy.tradeId;
    }
  }

  // 3h. History touched today: a stale draft discarded, reviews completed/reopened, tags, relabel and removal.
  await rpc("discard_trade_draft", { p_trade_id: marks.oldDraft, p_reason: "Setup is three days old; the range it was based on has been taken.", p_request_key: key("discard-old-draft") });
  const unreviewed = [...marks.closedUnreviewed].reverse();
  for (const tradeId of unreviewed.slice(0, 2)) await rpc("complete_trade_review", { p_trade_id: tradeId, p_request_key: key("complete-review", tradeId) });
  if (unreviewed[2]) await rpc("set_trade_tags", { p_trade_id: unreviewed[2], p_grade: "B", p_liquidity: "PDH", p_mss: "M5", p_tags: ["late-entry", "review-later"] });
  const reopened = marks.reviewed.find(id => !unreviewed.slice(0, 2).includes(id));
  if (reopened) {
    await rpc("reopen_trade_review", { p_trade_id: reopened, p_reason: "Re-checking the entry timing after the weekly review.", p_request_key: key("reopen-review") });
    marks.reopenedReview = reopened;
  }
  const historyEvidence = dataset.evidence.filter(spec => spec.via === "SQL");
  const relabel = historyEvidence.find(spec => spec.label === "PRE_ENTRY" && spec.accountKey === "ftmo");
  if (relabel) {
    await rpc("relabel_trade_evidence", { p_evidence_id: relabel.id, p_label: "ENTRY", p_timeframe: "M3", p_caption: "Entry: first touch of the OB (relabelled)" });
    marks.evidenceRelabelled = relabel.tradeId;
  }
  const removed = historyEvidence.find(spec => spec.label === "EXIT" && spec.accountKey === "demo");
  if (removed) {
    await rpc("remove_trade_evidence", { p_evidence_id: removed.id });
    marks.evidenceRemoved = removed.tradeId;
  }
  if (marks.reviewed[0]) await rpc("add_journal_entry", { p_trade_id: marks.reviewed[0], p_kind: "LESSON", p_body: "Weekly review: the same sweep pattern appears in three of this week's trades.", p_details: {}, p_request_key: key("late-lesson") });

  // 3i. AI history: timeline reviews (planned completed, live-first completed, hindsight-rejected failure) and weekly reviews.
  if (marks.timelineReviewPlanned) await ai.timeline({ tradeId: marks.timelineReviewPlanned, outcome: "COMPLETED" });
  if (marks.timelineReviewLive) await ai.timeline({ tradeId: marks.timelineReviewLive, outcome: "COMPLETED" });
  if (marks.hindsightTrade) await ai.timeline({ tradeId: marks.hindsightTrade, outcome: "HINDSIGHT" });
  await ai.weekly({ accountId: accounts.ftmo.id, weekStart: marks.weeks.lastWeek, outcome: "COMPLETED" });
  await ai.weekly({ accountId: accounts.ftmo.id, weekStart: marks.weeks.weekBefore, outcome: "REFUSED" });

  for (const note of notes) log(`  NOTE ${note}`);
  return { dataset, notes, showcase: showcaseOf(accounts, marks, plan) };
}

/** Every showcase trade name, in showcase order (the descriptions depend on the run; see showcaseDescriptions). */
const SHOWCASE_NAMES = Object.freeze(Object.keys(showcaseDescriptions({ deadPool: false })));

/**
 * Trades and accounts that each show one state or feature, by name, for screenshots and browser acceptance
 * (screenshot.mjs resolves `@name` paths with it), with what each trade shows in THIS user's data (it depends on
 * whether the user was seeded during Dead Pool). Names whose trade this dataset does not contain are left out.
 */
function showcaseOf(accounts, marks, plan) {
  const trades = { ...marks, todayLiveFirst: marks.todayPersonalLive, ...historyShowcase(marks) };
  const descriptions = showcaseDescriptions({ deadPool: plan.deadPool });
  const present = SHOWCASE_NAMES.filter(name => typeof trades[name] === "string");
  return {
    trades: Object.fromEntries(present.map(name => [name, trades[name]])),
    accounts: Object.fromEntries(Object.entries(accounts).map(([key, account]) => [key, account.id])),
    descriptions: Object.fromEntries(present.map(name => [name, descriptions[name]])),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// AI requests: the app's own facts/contracts, the real start/authorize/finish and reserve/dispatch/settle RPCs,
// synthetic usage, fixture interpretations validated by the app's validators. No provider is ever called.
// ---------------------------------------------------------------------------------------------------------------
function aiRunner({ net, app, aiPricing, user, db, images }) {
  const service = net.asService;
  let counter = 0;
  const usageFor = (operation, kind) => {
    const n = ++counter;
    const input = Math.min(operation.maxInputTokens - 500, 6_000 + ((n * 1_973) % 7_000));
    const output = kind === "REFUSED" ? 42 : Math.min(operation.maxOutputTokens - 200, 900 + ((n * 677) % 1_800));
    return { input_tokens: input, input_tokens_details: { cached_tokens: n % 3 === 0 ? 1_024 : 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: Math.floor(output / 4) }, total_tokens: input + output };
  };
  const config = operation => ({ model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens, imageDetail: operation.imageDetail, deepEnabled: false });

  /**
   * One request through the real ledger. outcome: COMPLETED (interpretation), INVALID / HINDSIGHT (raw output rejected
   * by the validator, usage settled), REFUSED (provider refusal, usage settled), CANCELLED (authorization fails at
   * dispatch after `beforeDispatch`, reservation cancelled).
   */
  async function run({ operationId, accountId, start, authorize, finish, facts, evidence, outcome, interpretation, raw, errorCode, beforeDispatch }) {
    const operation = app.operations.operationFor(operationId);
    const requestId = crypto.randomUUID();
    const started = await service(start.name, {
      p_id: requestId, p_user_id: user.id, ...start.params, p_facts: facts, p_hash: sha256(JSON.stringify(facts)), p_operation: operation,
      p_contract: app.contracts.operationContract(operation, facts),
    });
    if (started !== true) throw new Error(`${start.name} did not start a new request`);
    const authorized = () => service(authorize, { p_id: requestId, p_user_id: user.id });
    await authorized();
    // Priced once before any user was touched, never on this call's clock (seed-ai-pricing.mjs).
    const pricing = aiPricing.pricingFor(operation.id);
    const amount = app.pricing.reservationMicros(pricing, operation);
    const providerImages = evidence.map(item => ({ sourceId: `evidence:${item.id}`, role: item.role, dataUrl: `data:${item.mime_type};base64,${item.bytes.toString("base64")}` }));
    const hash = sha256(JSON.stringify({ operation, config: config(operation), context: facts, images: providerImages, prior: [] }));
    const reservationId = crypto.randomUUID();
    await service("reserve_account_ai_request", {
      p_id: reservationId, p_user_id: user.id, p_account_id: accountId, p_operation_id: requestId, p_stage: "A", p_request_hash: hash, p_model: operation.model,
      p_pricing: { ...pricing, operation }, p_reserved_micros: amount, p_operation: operation.id, p_provider: operation.provider,
    });
    if (outcome === "CANCELLED") {
      await beforeDispatch();
      let refused = false;
      try { await authorized(); } catch { refused = true; }
      if (!refused) throw new Error("Authorization unexpectedly succeeded after the draft changed");
      await service("settle_account_ai_request", { p_id: reservationId, p_user_id: user.id, p_record: { disposition: "CANCELLED", chargedMicros: 0, errorCode: "NOT_DISPATCHED" } });
      await service(finish, { p_id: requestId, p_user_id: user.id, p_status: "FAILED", p_interpretation: null, p_error: errorCode, p_raw: null, p_reservation_id: reservationId });
      return;
    }
    await authorized();
    await service("dispatch_account_ai_request", { p_id: reservationId, p_user_id: user.id, p_request_hash: hash });
    const usage = usageFor(operation, outcome);
    const priced = app.pricing.priceUsage(usage, pricing);
    if (priced.chargedMicros > amount) throw new Error("Synthetic usage exceeds the reservation");
    await service("settle_account_ai_request", { p_id: reservationId, p_user_id: user.id, p_record: {
      disposition: "SETTLED", chargedMicros: priced.chargedMicros, usage, responseModel: pricing.responseModels?.[1] ?? operation.model,
      responseId: `resp_local_seed_${sha256(requestId).slice(0, 24)}`, errorCode: outcome === "REFUSED" ? "REFUSED" : null, ...priced,
    } });
    if (outcome === "COMPLETED") {
      await service(finish, { p_id: requestId, p_user_id: user.id, p_status: "COMPLETED", p_interpretation: interpretation, p_error: null, p_raw: interpretation, p_reservation_id: reservationId });
    } else {
      await service(finish, { p_id: requestId, p_user_id: user.id, p_status: "FAILED", p_interpretation: null, p_error: errorCode, p_raw: raw ?? null, p_reservation_id: reservationId });
    }
  }

  /** Asserts that the app's validator rejects a failure fixture (with `code`, when given), keeping fixtures honest. */
  const rejected = (validate, code) => {
    try {
      validate();
    } catch (error) {
      if (code && error.code !== code) throw new Error(`Fixture output was rejected with ${error.code ?? error.message}, expected ${code}`);
      return;
    }
    throw new Error(`Fixture output was expected to be rejected${code ? ` (${code})` : ""}`);
  };

  return {
    /** Analyze Setup / Challenge My Bias on the latest revision of an open draft (loadSetup + context builders). */
    async preTrade({ operation, tradeId, proposalId, accountId, evidence, outcome, blocked = false, beforeDispatch }) {
      const proposal = await db.from("setup_proposals").select("*").eq("id", proposalId).eq("user_id", user.id).single();
      if (proposal.error) throw new Error(`Proposal ${proposalId}: ${proposal.error.message}`);
      const [strategy, instrument, risks] = await Promise.all([
        db.from("strategy_versions").select("id,version,rules,written_rules").eq("id", proposal.data.strategy_version_id).single(),
        db.from("instrument_versions").select("id,symbol").eq("id", proposal.data.instrument_version_id).single(),
        db.from("setup_risk_checks").select("id,risk:risk_evaluations(id,result,recorded_at)").eq("proposal_id", proposalId).order("id", { ascending: false }),
      ]);
      const risk = risks.data[0].risk;
      const result = app.riskReport.storedRiskSchema.parse(risk.result);
      const riskVersion = (await db.from("risk_plan_versions").select("version").eq("id", result.riskPlanVersionId).single()).data.version;
      const source = { proposal: proposal.data, strategy: strategy.data, instrument: instrument.data, risk: { id: risk.id, result, recorded_at: risk.recorded_at }, riskVersion };
      const reviewEvidence = evidence.map(({ id, role, sha256: hash, mime_type, byte_size }) => ({ id, role, sha256: hash, mime_type, byte_size }));
      const facts = operation === "ANALYZE_SETUP" ? app.analyzeContext.analyzeSetupContext(source, reviewEvidence) : app.biasContext.biasChallengeContext(source, reviewEvidence);
      const allowed = app.citations.operationAllowedSources(operation, facts);
      const evidenceRefs = evidence.map(item => `evidence:${item.id}`);
      let interpretation = null, raw = null, errorCode = null;
      if (outcome === "COMPLETED") {
        interpretation = operation === "ANALYZE_SETUP"
          ? app.analyzeContract.validateAnalyzeSetup(analyzeOutput({ evidenceRefs, blocked }), allowed, evidence.length > 0)
          : app.biasContract.validateBiasChallenge(challengeOutput({ evidenceRefs }), allowed);
      } else if (outcome === "INVALID") {
        raw = invalidAnalysisRaw();
        rejected(() => app.analyzeContract.validateAnalyzeSetup(raw, allowed, evidence.length > 0));
        errorCode = operation === "ANALYZE_SETUP" ? "INVALID_ANALYSIS_OUTPUT" : "INVALID_CHALLENGE_OUTPUT";
      } else {
        errorCode = "PROPOSAL_OR_EVIDENCE_CHANGED";
      }
      await run({
        operationId: operation, accountId, start: { name: "start_bias_challenge", params: { p_proposal_id: proposalId } }, authorize: "authorize_bias_challenge",
        finish: "finish_bias_challenge", facts, evidence, outcome, interpretation, raw, errorCode, beforeDispatch,
      });
      return tradeId;
    },

    /** Timeline-aware review of a closed trade (port of loadTimelineReviewSource + the app's context builder). */
    async timeline({ tradeId, outcome }) {
      const trade = await (async () => {
        const { data, error } = await db.from("trade_ledger").select(app.ledger.LEDGER_COLUMNS.join(",")).eq("id", tradeId).single();
        if (error) throw new Error(`Ledger row ${tradeId}: ${error.message}`);
        return app.ledger.ledgerRow.parse(data);
      })();
      const one = q => q.then(r => { if (r.error) throw new Error(r.error.message); return r.data; });
      const planned = trade.origin === "PLANNED";
      const [revisions, plan, strategies, risk, events, journal, positions, close, tagSet, evidenceRows, removals, labels] = await Promise.all([
        one(db.from("trade_revisions").select("proposal_id,revision,created_at").eq("trade_id", trade.id).eq("user_id", user.id).order("revision")),
        trade.plan_id ? one(db.from("trade_plans").select("id,proposal,risk_result,nominal_risk::text,locked_at,trading_day").eq("id", trade.plan_id).eq("user_id", user.id).maybeSingle()) : null,
        one(db.from("strategy_versions").select("id,version,rules,created_at").eq("account_id", trade.account_id).eq("user_id", user.id).order("created_at").order("id")),
        trade.plan_id && trade.risk_plan_version_id
          ? one(db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,default_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("id", trade.risk_plan_version_id).eq("user_id", user.id).maybeSingle())
          : null,
        trade.plan_id ? one(db.from("trade_events").select("id,event_type,payload,occurred_at,recorded_at").eq("plan_id", trade.plan_id).eq("user_id", user.id).order("sequence")) : [],
        one(db.from("trade_journal_entries").select("id,kind,body,details,phase,recorded_at").eq("trade_id", trade.id).eq("user_id", user.id).order("recorded_at").order("id")),
        planned ? [] : one(db.from("trade_position_facts").select("id,recorded_at,source,symbol,direction,entry_model,entry_price::text,entered_at,quantity::text,initial_stop::text,risk_amount::text").eq("trade_id", trade.id).eq("user_id", user.id).order("recorded_at").order("id")),
        planned ? null : one(db.from("trade_unplanned_closes").select("risk_basis_source").eq("trade_id", trade.id).eq("user_id", user.id).maybeSingle()),
        trade.tag_source === "V2" ? one(db.from("trade_tag_sets").select("recorded_at").eq("trade_id", trade.id).eq("user_id", user.id).order("id", { ascending: false }).limit(1).maybeSingle()) : null,
        one(db.from("trade_evidence").select("id,label,timeframe,phase,recorded_at,sha256,mime_type,byte_size").eq("trade_id", trade.id).eq("user_id", user.id).order("recorded_at").order("id")),
        one(db.from("trade_evidence_removals").select("evidence_id").eq("trade_id", trade.id).eq("user_id", user.id)),
        one(db.from("trade_evidence_labels").select("id,evidence_id,label,timeframe").eq("trade_id", trade.id).eq("user_id", user.id).order("id")),
      ]);
      const proposalIds = revisions.map(row => row.proposal_id);
      const [proposals, checks] = await Promise.all([
        proposalIds.length ? one(db.from("setup_proposals").select("id,proposal").in("id", proposalIds).eq("user_id", user.id)) : [],
        proposalIds.length ? one(db.from("setup_risk_checks").select("id,proposal_id,risk:risk_evaluations(id,result,recorded_at)").in("proposal_id", proposalIds).eq("user_id", user.id).order("id")) : [],
      ]);
      const latest = new Map();
      for (const check of checks) {
        const seen = latest.get(check.proposal_id);
        latest.set(check.proposal_id, { latest: !seen || check.id > seen.latest.id ? check : seen.latest, count: (seen?.count ?? 0) + 1 });
      }
      const strategy = trade.strategy_version_id ? strategies.find(row => row.id === trade.strategy_version_id) : strategies.filter(row => row.created_at <= trade.created_at).at(-1) ?? strategies[0];
      const removed = new Set(removals.map(row => row.evidence_id));
      const relabels = new Map(labels.map(row => [row.evidence_id, row]));
      const selected = evidenceRows.filter(row => !removed.has(row.id)).slice(0, 4).map(row => {
        const effective = relabels.get(row.id) ?? row;
        return { id: row.id, label: effective.label, timeframe: effective.timeframe, storedPhase: row.phase, recordedAt: row.recorded_at, sha256: row.sha256, mimeType: row.mime_type, byteSize: row.byte_size };
      });
      const facts = app.timelineContext.tradeTimelineReviewContext({
        trade,
        plan: plan ? { id: plan.id, lockedAt: plan.locked_at, tradingDay: plan.trading_day, proposal: plan.proposal, nominalRisk: plan.nominal_risk, riskResult: plan.risk_result } : null,
        strategy: { id: strategy.id, version: strategy.version, rules: strategy.rules },
        riskVersion: risk,
        revisions: revisions.map(row => ({ proposalId: row.proposal_id, revision: row.revision, createdAt: row.created_at, proposal: proposals.find(p => p.id === row.proposal_id)?.proposal ?? null })),
        riskChecks: [...latest.values()].map(({ latest: check, count }) => ({ id: check.risk.id, proposalId: check.proposal_id, recordedAt: check.risk.recorded_at, result: check.risk.result, checks: count })),
        legacyEvents: events.map(row => ({ id: row.id, eventType: row.event_type, payload: row.payload, occurredAt: row.occurred_at, recordedAt: row.recorded_at })),
        journal: journal.map(row => ({ id: row.id, kind: row.kind, body: row.body, details: row.details, phase: row.phase, recordedAt: row.recorded_at })),
        positionFacts: positions.map(row => ({ id: row.id, recordedAt: row.recorded_at, source: row.source, symbol: row.symbol, direction: row.direction, entryModel: row.entry_model, entryPrice: row.entry_price, enteredAt: row.entered_at, quantity: row.quantity, initialStop: row.initial_stop, riskAmount: row.risk_amount })),
        riskBasisSource: close?.risk_basis_source ?? null,
        tags: { setupGrade: trade.setup_grade, liquidityContext: trade.liquidity_context, mssTimeframe: trade.mss_timeframe, tags: trade.tags, source: trade.tag_source, recordedAt: tagSet?.recorded_at ?? null },
        evidence: selected,
      });
      const evidence = selected.map(item => {
        const image = images.get(item.id);
        return { id: item.id, role: item.timeframe ?? item.label, sha256: item.sha256, mime_type: item.mimeType, byte_size: item.byteSize, bytes: image?.bytes ?? Buffer.alloc(0) };
      });
      let interpretation = null, raw = null, errorCode = null;
      if (outcome === "COMPLETED") {
        interpretation = app.timelineContract.validateTradeTimelineReview(timelineReviewOutput(facts), facts);
      } else {
        raw = hindsightRaw(facts);
        rejected(() => app.timelineContract.validateTradeTimelineReview(raw, facts), "HINDSIGHT_CITATION");
        errorCode = "HINDSIGHT_CITATION";
      }
      await run({
        operationId: "REVIEW_TRADE_TIMELINE", accountId: trade.account_id, start: { name: "start_trade_timeline_review", params: { p_trade_id: trade.id } },
        authorize: "authorize_trade_timeline_review", finish: "finish_trade_timeline_review", facts, evidence, outcome: outcome === "COMPLETED" ? "COMPLETED" : "INVALID", interpretation, raw, errorCode,
      });
    },

    /** Weekly review of one completed Monday week (port of loadWeeklyFacts + weeklyReviewContext). */
    async weekly({ accountId, weekStart, outcome }) {
      const period = app.weeklyPeriod.weeklyPeriod(weekStart);
      const one = q => q.then(r => { if (r.error) throw new Error(r.error.message); return r.data; });
      const trades = (await one(db.from("journal_analytics").select("*").eq("account_id", accountId).eq("status", "CLOSED").gte("exited_at", period.start).lt("exited_at", period.endExclusive).order("exited_at").order("id").limit(41)))
        .map(row => app.analytics.journalRow.parse(row));
      if (!trades.length) { log(`  weekly review skipped: no closed planned trades in the week of ${weekStart}`); return; }
      const ids = trades.map(t => t.id);
      const [plans, strategies, risks, events] = await Promise.all([
        one(db.from("trade_plans").select("id,account_id,strategy_version_id,risk_plan_version_id,instrument_version_id,proposal,risk_result,nominal_risk::text,locked_at,trading_day,setup_status,instrument:instrument_versions(symbol),strategy:strategy_versions(version),risk:risk_plan_versions(version)").eq("account_id", accountId).eq("user_id", user.id).in("id", ids)),
        one(db.from("strategy_versions").select("id,version,rules,written_rules").eq("account_id", accountId).eq("user_id", user.id).in("id", [...new Set(trades.map(t => t.strategy_version_id))])),
        one(db.from("risk_plan_versions").select("id,version,effective_day,max_risk_percent::text,max_daily_trades,min_rr::text,rr_policy,news_policy,daily_risk_cap::text,daily_loss_cap::text").eq("account_id", accountId).eq("user_id", user.id).in("id", [...new Set(trades.map(t => t.risk_plan_version_id))])),
        one(db.from("trade_events").select("id,plan_id,event_type,payload,occurred_at,recorded_at").eq("account_id", accountId).eq("user_id", user.id).in("plan_id", ids).gte("occurred_at", period.start).lt("occurred_at", period.endExclusive).gte("recorded_at", period.start).lt("recorded_at", period.endExclusive).order("sequence").limit(201)),
      ]);
      const facts = app.weeklyContext.weeklyReviewContext(accountId, weekStart, trades.map(trade => ({
        plan: { ...plans.find(p => p.id === trade.id), risk_result: app.riskReport.storedRiskSchema.parse(plans.find(p => p.id === trade.id).risk_result) },
        trade, strategy: strategies.find(s => s.id === trade.strategy_version_id), risk: risks.find(r => r.id === trade.risk_plan_version_id),
        events: events.filter(e => e.plan_id === trade.id).map(({ plan_id: _plan, ...event }) => event),
      })), new Date().toISOString());
      const interpretation = outcome === "COMPLETED"
        ? app.weeklyContract.validateWeeklyReview(weeklyOutput(facts), app.citations.operationAllowedSources("WEEKLY_REVIEW", facts))
        : null;
      await run({
        operationId: "WEEKLY_REVIEW", accountId, start: { name: "start_weekly_ai_review", params: { p_account_id: accountId, p_week_start: period.startDate } },
        authorize: "authorize_weekly_ai_review", finish: "finish_weekly_ai_review", facts, evidence: [], outcome, interpretation, raw: null, errorCode: outcome === "REFUSED" ? "REFUSED" : null,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------------------------
function summary(stack, userId) {
  const rows = sql => psql(stack, ["-At", "-F", "\t", "-c", sql]).trim().split(/\r?\n/).filter(Boolean).map(line => line.split("\t"));
  const accounts = rows(`select coalesce(p.display_name, a.name), a.currency, p.account_type, p.platform,
      (select count(*) from public.trade_ledger l where l.account_id = a.id and l.lifecycle in ('CLOSED','REVIEWED')),
      (select coalesce(trim_scale(sum(l.net_pnl::numeric))::text, '0') from public.trade_ledger l where l.account_id = a.id and l.net_pnl is not null),
      (select count(*) from public.risk_plan_versions r where r.account_id = a.id)
    from public.accounts a join lateral (select * from public.account_profiles where account_id = a.id order by id desc limit 1) p on true
    where a.user_id = '${userId}' order by a.created_at`);
  const lifecycles = rows(`select l.lifecycle, count(*) from public.trade_ledger l join public.trades t on t.id = l.id where t.user_id = '${userId}' group by 1 order by 2 desc`);
  const origins = rows(`select origin, count(*) from public.trades where user_id = '${userId}' group by 1 order by 1`);
  const counts = rows(`select
      (select count(*) from public.trade_evidence e where e.user_id = '${userId}' and not exists (select 1 from public.trade_evidence_removals r where r.evidence_id = e.id)),
      (select count(*) from public.trade_evidence_removals where user_id = '${userId}'),
      (select count(*) from public.trade_journal_entries where user_id = '${userId}'),
      (select string_agg(phase || ' ' || n, ', ' order by phase) from (select phase, count(*) n from public.trade_journal_entries where user_id = '${userId}' group by 1) x),
      (select count(*) from public.trade_ledger l join public.trades t on t.id = l.id where t.user_id = '${userId}' and l.lifecycle in ('CLOSED','REVIEWED') and l.realized_r is null),
      (select count(*) from public.trade_ledger l join public.trades t on t.id = l.id where t.user_id = '${userId}' and l.oversize)`)[0];
  const ai = rows(`select op, status, count(*) from (
      select c.operation->>'id' op, coalesce(r.status, 'IN_PROGRESS') status from public.bias_challenges c left join public.bias_challenge_results r on r.challenge_id = c.id where c.user_id = '${userId}'
      union all select 'REVIEW_TRADE_TIMELINE', coalesce(r.status, 'IN_PROGRESS') from public.trade_timeline_reviews v left join public.trade_timeline_review_results r on r.review_id = v.id where v.user_id = '${userId}'
      union all select 'WEEKLY_REVIEW', coalesce(r.status, 'IN_PROGRESS') from public.weekly_ai_reviews w left join public.weekly_ai_review_results r on r.review_id = w.id where w.user_id = '${userId}') x
    group by 1, 2 order by 1, 2`);
  return { accounts, lifecycles, origins, counts, ai };
}

function printSummary(email, s, showcase) {
  log(`  ${email}`);
  const missing = SHOWCASE_NAMES.filter(name => !showcase.trades[name]);
  log(`    showcase: ${Object.keys(showcase.trades).length} of ${SHOWCASE_NAMES.length} trades${missing.length ? ` (none for ${missing.join(", ")})` : ""}`);
  for (const [name, currency, type, platform, closed, net, risks] of s.accounts) log(`    account  ${name} · ${currency} · ${type}/${platform} · ${closed} closed trades · net ${net} ${currency} · ${risks} risk-plan versions`);
  log(`    trades by lifecycle: ${s.lifecycles.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  log(`    trades by origin:    ${s.origins.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const [evidence, removedEvidence, journal, phases, rNull, oversize] = s.counts;
  log(`    evidence: ${evidence} active screenshots (${removedEvidence} removed) · journal: ${journal} entries (${phases}) · closed without R: ${rNull} · oversized fills: ${oversize}`);
  log(`    AI history: ${s.ai.map(([op, status, n]) => `${op} ${status} ${n}`).join(", ")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------
async function main() {
  const stack = readStack();
  if (!stack) fail("Missing .local/stack.json. Start the stack first: node scripts/local-stack/start.mjs");
  if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`The local gateway is not healthy at ${GATEWAY_URL}. Run node scripts/local-stack/start.mjs first.`);
  let schema = "";
  try { schema = sqlValue(stack, "select public.trading_os_schema()"); } catch { /* reported below */ }
  if (schema !== "2.0") fail("The local database is not on schema 2.0 (migrations 0015–0019). Run node scripts/local-stack/start.mjs to apply them.");
  const emails = (arg("users") ?? DEFAULT_USERS.join(",")).split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) fail("--users needs at least one email address");
  for (const email of emails) if (!SYNTHETIC_EMAIL.test(email)) fail(`${email} is not a synthetic address. Use a reserved domain such as example.test.`);
  if (new Set(emails).size !== emails.length) fail("--users lists an address twice");

  // Session boundaries: a Dead Pool start or a new strategy day during the run would change what "today" means.
  const now = Date.now();
  const minutesToBoundary = [12 * 60, 24 * 60].map(m => (dayStart(strategyDay(now)) + m * MIN - now) / MIN).filter(m => m > 0);
  const budget = 3 + emails.length * 4;
  if (Math.min(...minutesToBoundary) < budget) {
    fail(`A session boundary (Dead Pool at 12:00 or the new strategy day at 00:00 UTC−5) is less than ${budget} minutes away. Retry after it; nothing was changed.`);
  }

  const admin = createClient(GATEWAY_URL, stack.secretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const net = gateway(stack);
  const plans = await resolveUsers(stack, admin, emails, flag("reset-users"));
  const app = await loadApp();
  // The seeded AI history is priced here, before any user is touched: a pricing problem stops the seed with nothing
  // changed, and a lapsed review window is reported instead of failing partway through a user (seed-ai-pricing.mjs).
  const aiPricing = seedAiPricing(app);
  for (const note of aiPricing.notes) log(note);
  const sharp = createRequire(path.join(REPO, "package.json"))("sharp");
  log(`Seeding ${plans.length} synthetic user(s) on ${GATEWAY_URL} (dataset ${DATASET_VERSION}; local stack only, no AI provider)`);
  const results = [];
  for (const [index, plan] of plans.entries()) {
    const user = await ensureUser(admin, net, plan);
    rememberUser({ id: user.id, email: user.email, password: user.password, seededAt: null, datasetVersion: DATASET_VERSION, variant: index });
    log(`${plan.email !== plan.requested ? `${plan.requested} already has data; seeding fresh user ${plan.email}` : `Seeding ${plan.email}`} (${user.created ? "created" : "existing, no data"})`);
    const started = Date.now();
    const outcome = await seedUser({ stack, net, app, aiPricing, sharp }, user, index);
    rememberUser({
      id: user.id, email: user.email, password: user.password, seededAt: new Date().toISOString(), datasetVersion: DATASET_VERSION, variant: index,
      notes: outcome.notes, showcase: outcome.showcase,
    });
    results.push({ email: user.email, id: user.id, summary: summary(stack, user.id), showcase: outcome.showcase, seconds: Math.round((Date.now() - started) / 1000) });
    log(`  done in ${results.at(-1).seconds}s`);
  }
  log("Summary");
  for (const result of results) printSummary(result.email, result.summary, result.showcase);
  log(`Showcase trades (screenshot.mjs paths such as @todayBlocked or @ftmo/manage resolve to the user's own ids):`);
  // Descriptions follow each user's own data; users seeded on both sides of 18:00 UTC−5 are listed separately.
  for (const name of SHOWCASE_NAMES) {
    const seen = new Set(results.map(result => result.showcase.descriptions[name]).filter(Boolean));
    if (seen.size === 1) log(`  @${name.padEnd(21)} ${[...seen][0]}`);
    else for (const result of results) if (result.showcase.descriptions[name]) log(`  @${name.padEnd(21)} ${result.showcase.descriptions[name]} (${result.email})`);
  }
  log("  @ftmo, @personal, @demo     the user's trading accounts (/accounts/<id>)");
  log(`Credentials and ids (git-ignored): ${path.relative(REPO, USERS_FILE)}. Screenshots: node scripts/local-stack/screenshot.mjs --start-app --user=${results[0]?.email ?? DEFAULT_USERS[0]} --out=.local/screenshots/v2 today @todayBlocked`);
}

if (!process.execArgv.includes(TRANSFORM_FLAG)) {
  // The application's TypeScript modules (src/ai, src/domain) need Node's type transform; re-run with it.
  const child = spawnSync(process.execPath, [TRANSFORM_FLAG, "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", windowsHide: true });
  process.exitCode = child.status ?? 1;
} else {
  await runMain(main);
}
