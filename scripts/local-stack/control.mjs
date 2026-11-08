// Orchestration for the local stack: binaries, cluster, bootstrap, migrations and services.
// Used by start.mjs, stop.mjs, reset.mjs and status.mjs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_URL, GATEWAY_URL, HOST, LOCAL, PATHS, PG_DIST, PORTS, REPO, download, ensureDirs, ensureStack, ensureTools, extractZip,
  httpStatus, imageName, killTree, log, logFile, managedPid, pgCtl, pgTool, portOpen, postgresRunning, postgrestDist, postgrestExe, psql,
  readStack, spawnDetached, sqlValue, stopManaged, tail, waitFor,
} from "./lib.mjs";

const md5 = text => createHash("md5").update(text).digest("hex");

// ---------------------------------------------------------------------------------------------
// Binaries
// ---------------------------------------------------------------------------------------------
export async function ensurePostgresBinaries() {
  if (fs.existsSync(pgTool("postgres")) && fs.existsSync(pgTool("psql")) && fs.existsSync(pgTool("pg_ctl"))) return;
  const zip = path.join(PATHS.downloads, path.basename(new URL(PG_DIST.url).pathname));
  await download(PG_DIST.url, zip, PG_DIST.sha256);
  log(`Extracting PostgreSQL ${PG_DIST.version} binaries to ${path.relative(REPO, PATHS.pgRoot)}`);
  extractZip(zip, PATHS.pgRoot, PG_DIST.members);
  // EDB binaries need the Visual C++ runtime. If it is not installed system-wide, use the copy
  // shipped inside the same archive (pgAdmin's Python folder).
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  if (!fs.existsSync(path.join(system32, "vcruntime140.dll")) && !fs.existsSync(path.join(PATHS.pgBin, "vcruntime140.dll"))) {
    const temp = path.join(LOCAL, "tmp", "vcruntime");
    extractZip(zip, temp, ["pgsql/pgAdmin 4/python/vcruntime140.dll", "pgsql/pgAdmin 4/python/vcruntime140_1.dll"]);
    for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll"]) {
      const source = path.join(temp, "pgsql", "pgAdmin 4", "python", dll);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(PATHS.pgBin, dll));
    }
    fs.rmSync(temp, { recursive: true, force: true });
    log("Copied the Visual C++ runtime DLLs next to the PostgreSQL binaries (install the VC++ 2015-2022 redistributable if PostgreSQL still fails to start).");
  }
  if (!fs.existsSync(pgTool("postgres"))) throw new Error("PostgreSQL binaries were not extracted as expected.");
}

export async function ensurePostgrestBinary() {
  const dist = postgrestDist();
  const marker = path.join(PATHS.postgrestDir, "VERSION");
  const installed = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null;
  if (installed === dist.version && fs.existsSync(postgrestExe())) return dist.version;
  const zip = path.join(PATHS.downloads, path.basename(new URL(dist.url).pathname));
  if (!dist.sha256) log(`PostgREST ${dist.version} has no pinned checksum in lib.mjs; it will be downloaded unverified.`);
  await download(dist.url, zip, dist.sha256);
  fs.rmSync(postgrestExe(), { force: true });
  extractZip(zip, PATHS.postgrestDir);
  if (!fs.existsSync(postgrestExe())) throw new Error("postgrest.exe was not found in the PostgREST archive.");
  fs.writeFileSync(marker, `${dist.version}\n`);
  log(`Installed PostgREST ${dist.version}`);
  return dist.version;
}

// ---------------------------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------------------------
export function clusterExists() { return fs.existsSync(path.join(PATHS.pgData, "PG_VERSION")); }

export function initCluster(stack) {
  const pwfile = path.join(LOCAL, `pwfile-${process.pid}.tmp`);
  fs.writeFileSync(pwfile, `${stack.postgres.superuserPassword}\n`, { mode: 0o600 });
  try {
    log(`Initializing PostgreSQL cluster in ${path.relative(REPO, PATHS.pgData)}`);
    const fd = fs.openSync(logFile("initdb"), "a");
    let r;
    try {
      // Builtin C.UTF-8 provider (PostgreSQL 17): Unicode-aware, identical on every machine.
      r = spawnSync(pgTool("initdb"), [
        "-D", PATHS.pgData, "-U", "postgres", `--pwfile=${pwfile}`, "--auth=scram-sha-256", "--encoding=UTF8",
        "--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8", "--no-instructions",
      ], { stdio: ["ignore", fd, fd], windowsHide: true });
    } finally { fs.closeSync(fd); }
    if (r.status !== 0) throw new Error(`initdb failed (exit ${r.status}). See ${logFile("initdb")}:\n${tail(logFile("initdb"), 20)}`);
  } finally { fs.rmSync(pwfile, { force: true }); }
  // Loopback-only server with UTC like hosted Supabase. Appended settings override the defaults.
  fs.appendFileSync(path.join(PATHS.pgData, "postgresql.conf"), [
    "", "# --- trading-os local stack ---",
    "listen_addresses = '127.0.0.1'", `port = ${PORTS.postgres}`, "unix_socket_directories = ''",
    "max_connections = 100", "timezone = 'UTC'", "log_timezone = 'UTC'", "password_encryption = 'scram-sha-256'",
    "log_min_messages = warning", "log_line_prefix = '%m [%p] %q%u@%d '", "",
  ].join("\n"));
}

export async function startPostgres(stack) {
  if (!postgresRunning()) {
    if (await portOpen(PORTS.postgres)) throw new Error(`Port ${PORTS.postgres} is already in use by another process.`);
    log(`Starting PostgreSQL on ${HOST}:${PORTS.postgres}`);
    const r = pgCtl(["start", "-D", PATHS.pgData, "-l", logFile("postgres"), "-w", "-t", "60"]);
    if (r.status !== 0) throw new Error(`pg_ctl start failed (exit ${r.status}).\n${tail(logFile("postgres"), 30)}\n${tail(logFile("pg_ctl"), 10)}`);
  }
  await waitFor(() => sqlValue(stack, "select 1", { db: "template1" }) === "1", 30000, 500, "PostgreSQL to accept connections");
}
export function stopPostgres() {
  if (!postgresRunning()) return false;
  log("Stopping PostgreSQL");
  const r = pgCtl(["stop", "-D", PATHS.pgData, "-m", "fast", "-w", "-t", "60"]);
  if (r.status !== 0) throw new Error(`pg_ctl stop failed (exit ${r.status}). See ${logFile("pg_ctl")}`);
  return true;
}

export function ensureDatabase(stack) {
  const db = stack.postgres.database;
  if (sqlValue(stack, `select count(*) from pg_database where datname = '${db}'`, { db: "template1" }) === "0") {
    log(`Creating database ${db}`);
    psql(stack, ["-c", `create database ${db}`], { db: "template1" });
  }
}

// ---------------------------------------------------------------------------------------------
// Bootstrap + migrations (EDB psql, ON_ERROR_STOP=1, one transaction per file)
// ---------------------------------------------------------------------------------------------
const sqlPath = file => file.replaceAll("\\", "/").replaceAll("'", "''");

export function applyBootstrap(stack) {
  const sql = fs.readFileSync(PATHS.bootstrapSql, "utf8");
  const checksum = md5(sql);
  const hasMeta = sqlValue(stack, "select to_regclass('local_stack.meta') is not null") === "t";
  if (hasMeta) {
    const recorded = sqlValue(stack, "select value from local_stack.meta where key = 'bootstrap_md5'");
    if (recorded === checksum) return false;
    log("WARNING: bootstrap.sql changed since this database was created. Run `node scripts/local-stack/reset.mjs` to rebuild it.");
    return false;
  }
  log("Applying Supabase compatibility bootstrap");
  psql(stack, ["--single-transaction", "-v", `authenticator_password=${stack.postgres.authenticatorPassword}`, "-f", PATHS.bootstrapSql]);
  psql(stack, ["-c", `insert into local_stack.meta(key, value) values ('bootstrap_md5', '${checksum}') on conflict (key) do update set value = excluded.value, updated_at = now()`]);
  return true;
}

export function migrationFiles() {
  return fs.readdirSync(PATHS.migrations).filter(f => /^\d+_[A-Za-z0-9_]+\.sql$/.test(f)).sort()
    .map(file => ({ file, version: file.split("_")[0], name: file.slice(file.indexOf("_") + 1, -4), full: path.join(PATHS.migrations, file) }));
}
export function appliedMigrations(stack) {
  const out = sqlValue(stack, "select coalesce(string_agg(version || ':' || md5(array_to_string(statements, '')), ',' order by version), '') from supabase_migrations.schema_migrations");
  return new Map(out ? out.split(",").map(entry => entry.split(":")) : []);
}
/**
 * Applies pending migrations in lexical order; returns the list applied. `through` (e.g. "0014")
 * stops after that version, so an older schema can be populated before newer migrations run.
 */
export function applyMigrations(stack, { through } = {}) {
  const applied = appliedMigrations(stack), done = [];
  fs.mkdirSync(path.join(LOCAL, "tmp"), { recursive: true });
  const held = [];
  for (const m of migrationFiles()) {
    if (through && Number(m.version) > Number(through)) { if (!applied.has(m.version)) held.push(m.file); continue; }
    const source = fs.readFileSync(m.full, "utf8");
    if (applied.has(m.version)) {
      if (applied.get(m.version) !== md5(source)) log(`WARNING: ${m.file} differs from the applied version (applied migrations are never re-run).`);
      continue;
    }
    // The migration and its ledger row commit together. pg_read_file stores the exact file text
    // (the server reads it locally; the superuser may read absolute paths).
    const wrapper = path.join(LOCAL, "tmp", `apply-${m.version}.sql`);
    fs.writeFileSync(wrapper, [
      "\\set ON_ERROR_STOP on", "begin;", `\\i '${sqlPath(m.full)}'`,
      `insert into supabase_migrations.schema_migrations(version, statements, name) values ('${m.version}', array[pg_read_file('${sqlPath(m.full)}')], '${m.name}');`,
      "commit;", "",
    ].join("\n"));
    log(`Applying migration ${m.file}`);
    try { psql(stack, ["-f", wrapper]); } catch (error) {
      throw new Error(`Migration ${m.file} failed and was rolled back:\n${error.message}`);
    } finally { fs.rmSync(wrapper, { force: true }); }
    done.push(m.file);
  }
  if (held.length) log(`Holding back ${held.length} migration(s) after ${through}: ${held.join(", ")} (run start.mjs without --through to apply them)`);
  if (done.length) psql(stack, ["-c", "notify pgrst, 'reload schema'"]);
  return done;
}

// ---------------------------------------------------------------------------------------------
// PostgREST + gateway
// ---------------------------------------------------------------------------------------------
export function writePostgrestConfig(stack) {
  fs.mkdirSync(PATHS.postgrestDir, { recursive: true });
  const uri = `postgres://authenticator:${encodeURIComponent(stack.postgres.authenticatorPassword)}@${HOST}:${PORTS.postgres}/${stack.postgres.database}`;
  fs.writeFileSync(PATHS.postgrestConf, [
    "# Generated by scripts/local-stack (LOCAL ONLY). Mirrors Supabase's PostgREST settings where relevant.",
    `db-uri = "${uri}"`,
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    'db-extra-search-path = "public, extensions"',
    "db-max-rows = 1000",
    "db-pool = 10",
    "db-pool-acquisition-timeout = 10",
    "db-channel-enabled = true",
    'db-channel = "pgrst"',
    `jwt-secret = "${stack.jwtSecret}"`,
    "jwt-secret-is-base64 = false",
    `server-host = "${HOST}"`,
    `server-port = ${PORTS.postgrest}`,
    `admin-server-port = ${PORTS.postgrestAdmin}`,
    'log-level = "warn"',
    "",
  ].join("\n"), { mode: 0o600 });
}
const postgrestReady = async () => (await httpStatus(`http://${HOST}:${PORTS.postgrestAdmin}/ready`)) === 200;

export async function startPostgrest(stack, { restart = false } = {}) {
  writePostgrestConfig(stack);
  const running = managedPid("postgrest", "postgrest.exe");
  if (running && !restart && await postgrestReady()) return running;
  if (running) await stopManaged("postgrest", "postgrest.exe");
  for (const port of [PORTS.postgrest, PORTS.postgrestAdmin]) if (await portOpen(port)) throw new Error(`Port ${port} is already in use by another process.`);
  // libpq and its dependencies come from the PostgreSQL bin folder.
  const env = { ...process.env, PATH: `${PATHS.pgBin}${path.delimiter}${process.env.PATH ?? ""}` };
  const pid = spawnDetached("postgrest", postgrestExe(), [PATHS.postgrestConf], { env });
  log(`Started PostgREST (pid ${pid}) on ${HOST}:${PORTS.postgrest}`);
  try { await waitFor(postgrestReady, 45000, 300, "PostgREST readiness"); } catch (error) {
    throw new Error(`${error.message}\n${tail(logFile("postgrest"), 30)}`);
  }
  return pid;
}

const gatewayReady = async () => (await httpStatus(`${GATEWAY_URL}/health`)) === 200;
export async function startGateway({ restart = false } = {}) {
  const running = managedPid("gateway", "node.exe");
  if (running && !restart && await gatewayReady()) return running;
  if (running) await stopManaged("gateway", "node.exe");
  if (await portOpen(PORTS.gateway)) throw new Error(`Port ${PORTS.gateway} is already in use by another process.`);
  const pid = spawnDetached("gateway", process.execPath, [PATHS.gateway]);
  log(`Started gateway (pid ${pid}) on ${GATEWAY_URL}`);
  try { await waitFor(gatewayReady, 30000, 300, "gateway readiness"); } catch (error) {
    throw new Error(`${error.message}\n${tail(logFile("gateway"), 30)}`);
  }
  return pid;
}

// ---------------------------------------------------------------------------------------------
// Full start
// ---------------------------------------------------------------------------------------------
export async function startStack({ restart = false, through } = {}) {
  if (through !== undefined && !/^\d+$/.test(through)) throw new Error(`--through expects a migration version such as 0014, got "${through}"`);
  ensureDirs();
  if (!readStack() && clusterExists()) {
    throw new Error(".local/stack.json is missing but .local/pgdata exists, so the database password is unknown. Run `node scripts/local-stack/reset.mjs --hard`.");
  }
  const stack = ensureStack();
  ensureTools();
  await ensurePostgresBinaries();
  const postgrestVersion = await ensurePostgrestBinary();
  if (!clusterExists()) initCluster(stack);
  await startPostgres(stack);
  ensureDatabase(stack);
  const bootstrapped = applyBootstrap(stack);
  const applied = applyMigrations(stack, { through });
  if (applied.length) log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
  else log("Migrations are up to date");
  // A schema change (or first start) restarts PostgREST so its schema cache is rebuilt immediately.
  await startPostgrest(stack, { restart: restart || bootstrapped || applied.length > 0 });
  await startGateway({ restart });
  return { stack, postgrestVersion, applied };
}

export async function stopServices() {
  const stopped = [];
  if (await stopApp()) stopped.push("app");
  for (const [name, image] of [["gateway", "node.exe"], ["postgrest", "postgrest.exe"]]) {
    if (await stopManaged(name, image)) stopped.push(name);
  }
  return stopped;
}

// ---------------------------------------------------------------------------------------------
// Next.js dev server (used by browser-smoke.mjs)
// ---------------------------------------------------------------------------------------------
// `next dev` may rewrite these tracked files (e.g. next-env.d.ts points at .next/dev/types).
// They are snapshotted before the app starts and restored byte-for-byte after it stops.
const TRACKED_BY_NEXT = ["next-env.d.ts", "tsconfig.json"];
export function snapshotTrackedFiles() {
  return Object.fromEntries(TRACKED_BY_NEXT.map(f => [f, fs.existsSync(path.join(REPO, f)) ? fs.readFileSync(path.join(REPO, f)) : null]));
}
export function restoreTrackedFiles(snapshot) {
  const restored = [];
  for (const [file, bytes] of Object.entries(snapshot ?? {})) {
    if (bytes === null) continue;
    const full = path.join(REPO, file);
    if (!fs.existsSync(full) || !fs.readFileSync(full).equals(bytes)) { fs.writeFileSync(full, bytes); restored.push(file); }
  }
  return restored;
}
/** PID listening on 127.0.0.1:<port> (Windows netstat), used when a process tree outlives taskkill. */
export function listeningPid(port) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[3] === "LISTENING" && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
  }
  return null;
}
/**
 * Starts "npx pnpm@11.19.0 dev" detached. Supabase/AI variables are passed explicitly so the app
 * can only reach the local gateway even if the parent shell exports other values, and the repo's
 * no-openai-network preload blocks any OpenAI request.
 */
export async function startApp(stack) {
  if (await portOpen(PORTS.app)) throw new Error(`Port ${PORTS.app} is already in use; stop that server first (or use --reuse-app).`);
  const guard = pathToFileURL(path.join(REPO, "scripts", "no-openai-network.mjs")).href;
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: GATEWAY_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishableKey, SUPABASE_SECRET_KEY: stack.secretKey,
    AI_ENABLED: "false", OPENAI_API_KEY: "", NEXT_TELEMETRY_DISABLED: "1", BROWSER: "none",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${guard}`.trim(),
  };
  const pid = spawnDetached("app", "npx pnpm@11.19.0 dev", [], { env, shell: true });
  log(`Started the Next.js dev server (pid ${pid}); waiting for ${APP_URL}/login (first compile can take a while)`);
  try {
    await waitFor(async () => (await httpStatus(`${APP_URL}/login`, { timeoutMs: 180000 })) === 200, 300000, 2000, "the Next.js dev server");
  } catch (error) {
    throw new Error(`${error.message}\n${tail(logFile("app"), 40)}`);
  }
  return pid;
}
// The recorded app pid is the cmd.exe shell that runs "npx pnpm@11.19.0 dev".
export const APP_IMAGE = process.platform === "win32" ? "cmd.exe" : undefined;
export async function stopApp() {
  const pid = managedPid("app", APP_IMAGE);
  if (pid) killTree(pid);
  fs.rmSync(path.join(PATHS.pids, "app.pid"), { force: true });
  if (!pid) return false;
  // Fallback: a Node dev-server child that escaped the process tree still owns the port.
  await waitFor(async () => !(await portOpen(PORTS.app)), 10000, 300).catch(() => {});
  const orphan = listeningPid(PORTS.app);
  if (orphan && imageName(orphan) === "node.exe") {
    killTree(orphan);
    await waitFor(async () => !(await portOpen(PORTS.app)), 10000, 300).catch(() => {});
  }
  return true;
}
