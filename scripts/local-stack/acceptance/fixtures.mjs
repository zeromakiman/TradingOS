// Fixtures of the browser acceptance runner: fresh SYNTHETIC users (empty, or seeded with seed-v2.mjs), the local
// gateway's auth/REST API as such a user, superuser SQL against the local PostgreSQL, synthetic chart screenshots and a
// small ZIP reader for the "Export my data" archive. Local stack only: every address is @example.test, every key comes
// from .local/stack.json, and nothing here can reach a hosted project or an AI provider.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { renderChart } from "../fixtures/v2-charts.mjs";
import { GATEWAY_URL, LOCAL, REPO, sleep, sqlValue } from "../lib.mjs";
import { acceptanceEmail, strategyClock } from "./rules.mjs";

const SEED_SCRIPT = path.join(REPO, "scripts", "local-stack", "seed-v2.mjs");
const SEED_USERS_FILE = path.join(LOCAL, "seed-v2-users.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC = /@example\.test$/;

// ---------------------------------------------------------------------------------------------------------------
// Local gateway API (auth + PostgREST RPC)
// ---------------------------------------------------------------------------------------------------------------
async function gatewayJson(method, url, headers, body) {
  const response = await fetch(`${GATEWAY_URL}${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, ok: response.ok, data };
}

/** Password grant against the local gateway; returns {ok, status, token, error}. Never logs the password. */
export async function passwordGrant(stack, email, password) {
  const result = await gatewayJson("POST", "/auth/v1/token?grant_type=password", { apikey: stack.publishableKey }, { email, password });
  return { ok: result.ok && Boolean(result.data?.access_token), status: result.status, token: result.data?.access_token ?? null, error: result.ok ? null : (result.data?.error_code ?? result.data?.msg ?? result.data?.error ?? String(result.status)) };
}

/** Calls a PostgREST RPC as the signed-in user (RLS applies). Returns {ok, status, data, message}. */
export async function userRpc(stack, token, name, params) {
  const result = await gatewayJson("POST", `/rest/v1/rpc/${name}`, { apikey: stack.publishableKey, authorization: `Bearer ${token}` }, params);
  return { ok: result.ok, status: result.status, data: result.data, message: result.ok ? null : (result.data?.message ?? JSON.stringify(result.data)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------
function readSeededUser(email) {
  try {
    const parsed = JSON.parse(fs.readFileSync(SEED_USERS_FILE, "utf8"));
    return parsed.project === GATEWAY_URL ? (parsed.users?.find(user => user.email === email) ?? null) : null;
  } catch {
    return null;
  }
}

function runNode(script, args, logFile) {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [script, ...args], { cwd: REPO, stdio: ["ignore", log, log], windowsHide: true });
    child.once("error", error => {
      fs.closeSync(log);
      reject(error);
    });
    child.once("exit", code => {
      fs.closeSync(log);
      resolve(code ?? 1);
    });
  });
}

/**
 * Fresh synthetic users for one run, created on demand and cached by key: `empty(key)` creates a confirmed user without
 * data through the gateway admin API; `seeded(key)` runs seed-v2.mjs for a new address (three trading accounts, ~90
 * days of history and today's showcase trades). Addresses are acc-<run>-<key>@example.test, so a run never depends on
 * a user that existed before it. Passwords stay in <out>/users.private.json (git-ignored .local) and are never printed.
 */
export class UserPool {
  constructor({ stack, runId, out, log }) {
    this.stack = stack;
    this.runId = runId;
    this.out = out;
    this.log = log;
    this.users = new Map();
    this.pending = new Map();
  }

  list() {
    return [...this.users.values()].map(({ key, id, email, seeded, seedSeconds }) => ({ key, id, email, seeded, ...(seedSeconds ? { seedSeconds } : {}) }));
  }

  remember(user) {
    this.users.set(user.key, user);
    const file = path.join(this.out, "users.private.json");
    const rows = [...this.users.values()].map(({ key, id, email, password, seeded }) => ({ key, id, email, password, seeded }));
    fs.writeFileSync(file, `${JSON.stringify({ note: "LOCAL synthetic users of one acceptance run. Never use elsewhere.", users: rows }, null, 2)}\n`, { mode: 0o600 });
    return user;
  }

  once(key, create) {
    if (this.users.has(key)) return Promise.resolve(this.users.get(key));
    if (!this.pending.has(key)) this.pending.set(key, create().finally(() => this.pending.delete(key)));
    return this.pending.get(key);
  }

  empty(key) {
    return this.once(key, async () => {
      const email = acceptanceEmail(this.runId, key);
      if (!SYNTHETIC.test(email)) throw new Error(`Refusing a non-synthetic address ${email}`);
      const password = `Acc!${randomBytes(18).toString("base64url")}`;
      const result = await gatewayJson("POST", "/auth/v1/admin/users", { apikey: this.stack.secretKey, authorization: `Bearer ${this.stack.secretKey}` }, { email, password, email_confirm: true, user_metadata: { purpose: "Trading OS V2 browser acceptance (local stack)" } });
      if (!result.ok || !UUID.test(result.data?.id ?? "")) throw new Error(`Creating ${email} failed: HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
      this.log(`created empty synthetic user ${email}`);
      return this.remember({ key, id: result.data.id, email, password, seeded: false, showcase: null });
    });
  }

  seeded(key) {
    return this.once(key, async () => {
      const email = acceptanceEmail(this.runId, key);
      if (!SYNTHETIC.test(email)) throw new Error(`Refusing a non-synthetic address ${email}`);
      // seed-v2.mjs refuses to start close to 12:00 or 24:00 UTC−5 (today would change meaning mid-seed); wait it out.
      for (let waited = 0; strategyClock(Date.now()).minutesToSeedBoundary < 8; waited += 1) {
        if (waited === 0) this.log(`waiting for the 12:00/24:00 UTC−5 boundary to pass before seeding ${email}`);
        if (waited > 20) throw new Error("A strategy-session boundary is too close to seed users; run again in a few minutes.");
        await sleep(30_000);
      }
      const logFile = path.join(this.out, `seed-${key}.log`);
      const started = Date.now();
      this.log(`seeding ${email} with seed-v2.mjs (log: ${path.relative(REPO, logFile)})`);
      const code = await runNode(SEED_SCRIPT, [`--users=${email}`], logFile);
      const seeded = readSeededUser(email);
      if (code !== 0 || !seeded?.password || !seeded.showcase) {
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-3).join(" | ") : "";
        throw new Error(`seed-v2.mjs failed for ${email} (exit ${code}): ${tail}`);
      }
      const seedSeconds = Math.round((Date.now() - started) / 1000);
      this.log(`seeded ${email} in ${seedSeconds}s`);
      return this.remember({ key, id: seeded.id, email, password: seeded.password, seeded: true, showcase: seeded.showcase, seedSeconds });
    });
  }
}

/**
 * Creates a trading account for a user through the same RPC the app's form calls (create_trading_account), for flows
 * whose subject is not account creation. Returns the account id.
 */
export async function createAccountViaApi(stack, user, input) {
  const grant = await passwordGrant(stack, user.email, user.password);
  if (!grant.ok) throw new Error(`Sign-in for ${user.email} failed: ${grant.error}`);
  const result = await userRpc(stack, grant.token, "create_trading_account", { p_request_key: randomUUID(), p_input: input });
  if (!result.ok || !UUID.test(String(result.data))) throw new Error(`create_trading_account failed: ${result.message}`);
  return result.data;
}

// ---------------------------------------------------------------------------------------------------------------
// Superuser SQL (local PostgreSQL only; ids are validated before they reach SQL text)
// ---------------------------------------------------------------------------------------------------------------
const uuidLiteral = id => {
  if (!UUID.test(String(id))) throw new Error(`Not a uuid: ${id}`);
  return `'${String(id).toLowerCase()}'::uuid`;
};

/** Tables in schema public with a user_id column (catalog-driven, like the erasure itself). */
export function tenantTables(stack) {
  const out = sqlValue(stack, "select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped where n.nspname = 'public' and c.relkind in ('r', 'p')");
  return out ? out.split(",") : [];
}

/** Row count of every tenant table for one user: {table: count}. */
export function rowCountsFor(stack, userId) {
  const tables = tenantTables(stack);
  if (!tables.length) return {};
  const union = tables.map(table => `select '${table}' as t, count(*)::text as n from public."${table.replace(/"/g, '""')}" where user_id = ${uuidLiteral(userId)}`).join(" union all ");
  const out = sqlValue(stack, `select string_agg(t || '=' || n, ',' order by t) from (${union}) counts`);
  return Object.fromEntries((out ? out.split(",") : []).map(pair => {
    const [table, count] = pair.split("=");
    return [table, Number(count)];
  }));
}

/** Whether the auth user row exists, and how many storage objects live under the user's {uid}/ prefix. */
export function identityFootprint(stack, userId) {
  const literal = uuidLiteral(userId);
  const authUsers = Number(sqlValue(stack, `select count(*) from auth.users where id = ${literal}`));
  const objects = Number(sqlValue(stack, `select count(*) from storage.objects where name like '${String(userId).toLowerCase()}/%'`));
  return { authUsers, objects };
}

/** The local Storage emulation keeps bytes in .local/storage/{bucket}/{path}: files left under {uid}/ in any bucket. */
export function storageFilesFor(userId) {
  const root = path.join(LOCAL, "storage");
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  for (const bucket of fs.readdirSync(root)) {
    const dir = path.join(root, bucket, String(userId).toLowerCase());
    if (!fs.existsSync(dir)) continue;
    const walk = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(folder, entry.name));
        else count += 1;
      }
    };
    walk(dir);
  }
  return count;
}

/** Accounts of a user with their latest profile status: [{id, name, status}]. */
export function accountsOf(stack, userId) {
  const out = sqlValue(stack, `select coalesce(json_agg(json_build_object('id', a.id, 'name', coalesce(p.display_name, a.name), 'status', coalesce(p.status, 'ACTIVE')) order by a.created_at), '[]') from public.accounts a left join lateral (select display_name, status from public.account_profiles where account_id = a.id order by id desc limit 1) p on true where a.user_id = ${uuidLiteral(userId)}`);
  return JSON.parse(out || "[]");
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic chart screenshots
// ---------------------------------------------------------------------------------------------------------------
let sharpModule = null;
/** The repository's sharp (an application dependency), loaded once. */
export function sharp() {
  sharpModule ??= createRequire(path.join(REPO, "package.json"))("sharp");
  return sharpModule;
}

/**
 * A synthetic 1280×720 PNG chart (the seed's renderer, stamped "Synthetic chart"), different for every seed so each
 * upload has its own fingerprint. Prices are integer ticks with `scale` decimals (EURUSD 1.10000 → 110000, scale 5).
 */
export function chartPng({ seed, kind = "SETUP", symbol = "EURUSD", timeframe = "M5", account = "Acceptance", direction = "LONG", entry = 110_000, stop = 109_800, target = 110_700, exit = null, scale = 5 }) {
  return renderChart(sharp(), { seed: `acceptance/${seed}`, kind, symbol, timeframe, account, direction, entry, stop, target, exit, scale }, "png");
}

// ---------------------------------------------------------------------------------------------------------------
// ZIP reader (stored and deflated entries; CRC-32 verified)
// ---------------------------------------------------------------------------------------------------------------
/** Reads every entry of a ZIP archive into {name: Buffer}. Throws on a malformed archive or a CRC mismatch. */
export function readZip(buffer) {
  const minimum = buffer.length - 22;
  let end = -1;
  for (let at = minimum; at >= Math.max(0, minimum - 65_535); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a ZIP archive: no end of central directory");
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < entries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Malformed central directory at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Malformed local header of ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for ${name}`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch for ${name}`);
    if (!name.endsWith("/")) files[name] = data;
  }
  return files;
}
