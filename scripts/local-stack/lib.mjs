// Shared helpers for the local Supabase-compatible stack (development/test only).
// Node built-ins only. Everything this stack creates lives under the git-ignored .local/ folder.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const LOCAL = path.join(REPO, ".local");
export const HOST = "127.0.0.1";
export const PORTS = Object.freeze({ gateway: 54321, postgres: 54322, postgrest: 54330, postgrestAdmin: 54331, app: 3000 });
export const GATEWAY_URL = `http://${HOST}:${PORTS.gateway}`;
export const APP_URL = `http://${HOST}:${PORTS.app}`;

export const PATHS = Object.freeze({
  downloads: path.join(LOCAL, "downloads"),
  pgRoot: path.join(LOCAL, "pg"),
  pgBin: path.join(LOCAL, "pg", "pgsql", "bin"),
  pgData: path.join(LOCAL, "pgdata"),
  postgrestDir: path.join(LOCAL, "postgrest"),
  postgrestConf: path.join(LOCAL, "postgrest", "postgrest.conf"),
  logs: path.join(LOCAL, "logs"),
  pids: path.join(LOCAL, "pids"),
  storage: path.join(LOCAL, "storage"),
  tools: path.join(LOCAL, "tools"),
  screenshots: path.join(LOCAL, "screenshots"),
  stack: path.join(LOCAL, "stack.json"),
  users: path.join(LOCAL, "integration-users.json"),
  mail: path.join(LOCAL, "logs", "auth-mail.jsonl"),
  envLocal: path.join(REPO, ".env.local"),
  migrations: path.join(REPO, "supabase", "migrations"),
  bootstrapSql: path.join(HERE, "bootstrap.sql"),
  gateway: path.join(HERE, "gateway", "index.mjs"),
});

// Pinned third-party binaries. Checksums were recorded when this tooling was written; a mismatch aborts.
export const PG_DIST = Object.freeze({
  version: "17.6-1", // Matches the PostgreSQL 17.6 major/minor used by the hosted project.
  url: "https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip",
  sha256: "d378882abd001a186735acd6f6ba716bca6ccd192e800412d4fd15ed25376b3e",
  // Only server/client binaries are extracted; pgAdmin, docs, headers and StackBuilder are skipped.
  members: ["pgsql/bin", "pgsql/lib", "pgsql/share"],
});
// PostgREST v13.0.8 is the latest v13 release. LOCAL_STACK_POSTGREST_VERSION selects another release
// (e.g. v14.18 or v16.4); unpinned versions are downloaded without a checksum and reported as such.
export const POSTGREST_SHA256 = Object.freeze({
  "v13.0.8": "11961be9d2a366eaaad22742e720f72e93c39b3a4782e3295ca53471cf56b537",
});
export function postgrestDist() {
  const version = process.env.LOCAL_STACK_POSTGREST_VERSION || "v13.0.8";
  if (!/^v\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`Invalid LOCAL_STACK_POSTGREST_VERSION: ${version}`);
  return {
    version,
    url: `https://github.com/PostgREST/postgrest/releases/download/${version}/postgrest-${version}-windows-x86-64.zip`,
    sha256: POSTGREST_SHA256[version] ?? null,
  };
}

export const exe = name => (process.platform === "win32" ? `${name}.exe` : name);
export const pgTool = name => path.join(PATHS.pgBin, exe(name));
export const postgrestExe = () => path.join(PATHS.postgrestDir, exe("postgrest"));

export function log(message) { console.log(`[local-stack] ${message}`); }
/** Expected, user-facing failure: printed without a stack trace by runMain(). */
export class FatalError extends Error {}
export function fail(message) { throw new FatalError(message); }
/**
 * Runs a CLI entry point. Errors set process.exitCode instead of calling process.exit(): exiting
 * while fetch keep-alive sockets close can trip a libuv assertion on Windows.
 */
export async function runMain(main) {
  try { await main(); } catch (error) {
    console.error(`[local-stack] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (!(error instanceof FatalError) && error instanceof Error && process.env.LOCAL_STACK_DEBUG) console.error(error.stack);
    process.exitCode = 1;
  }
}
export function ensureDirs() {
  for (const dir of [LOCAL, PATHS.downloads, PATHS.logs, PATHS.pids, PATHS.storage, PATHS.screenshots]) fs.mkdirSync(dir, { recursive: true });
}
export function requireWindows() {
  if (process.platform !== "win32") fail("This local stack downloads Windows x64 binaries (EDB PostgreSQL, PostgREST). Run it on Windows.");
}

// ---------------------------------------------------------------------------------------------
// Local secrets/configuration (.local/stack.json, never committed). Generated once and reused so
// .env.local stays valid across restarts and resets.
// ---------------------------------------------------------------------------------------------
export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");
export function readStack() {
  try { return JSON.parse(fs.readFileSync(PATHS.stack, "utf8")); } catch { return null; }
}
export function ensureStack() {
  const existing = readStack();
  if (existing) return existing;
  ensureDirs();
  const stack = {
    note: "LOCAL DEVELOPMENT ONLY. Synthetic credentials for the loopback Supabase-compatible stack. Never use elsewhere.",
    createdAt: new Date().toISOString(),
    ports: PORTS,
    gatewayUrl: GATEWAY_URL,
    siteUrl: APP_URL,
    postgres: { host: HOST, port: PORTS.postgres, database: "postgres", superuser: "postgres", superuserPassword: token(24), authenticatorPassword: token(24) },
    jwtSecret: token(48), // HS256, 64 base64url characters
    publishableKey: `sb_publishable_local_${token(24)}`,
    secretKey: `sb_secret_local_${token(24)}`,
  };
  fs.writeFileSync(PATHS.stack, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600 });
  return stack;
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------------
// Downloads and archives
// ---------------------------------------------------------------------------------------------
export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
export async function download(url, dest, expectedSha256) {
  if (fs.existsSync(dest)) {
    const actual = sha256File(dest);
    if (!expectedSha256 || actual === expectedSha256) return actual;
    log(`Cached ${path.basename(dest)} has an unexpected checksum; downloading again.`);
    fs.rmSync(dest);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0, nextReport = 0.1;
  const source = Readable.fromWeb(response.body);
  source.on("data", chunk => {
    received += chunk.length;
    if (total && received / total >= nextReport) { log(`  ${Math.floor((received / total) * 100)}% of ${(total / 1048576).toFixed(0)} MB`); nextReport += 0.1; }
  });
  const partial = `${dest}.part`;
  await pipeline(source, fs.createWriteStream(partial));
  const actual = sha256File(partial);
  if (expectedSha256 && actual !== expectedSha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(dest)}: expected ${expectedSha256}, got ${actual}`);
  }
  fs.renameSync(partial, dest);
  log(`Downloaded ${path.basename(dest)} (sha256 ${actual})`);
  return actual;
}
// Windows 10+ ships bsdtar as System32\tar.exe, which extracts ZIP archives quickly (and selectively).
export function extractZip(zip, dest, members = []) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (fs.existsSync(tar)) {
    const r = spawnSync(tar, ["-xf", zip, "-C", dest, ...members], { windowsHide: true, encoding: "utf8" });
    if (r.status === 0) return;
    log(`tar.exe extraction failed (${(r.stderr || "").trim()}); falling back to Expand-Archive.`);
  }
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:LS_ZIP -DestinationPath $env:LS_DEST -Force"],
  { windowsHide: true, encoding: "utf8", env: { ...process.env, LS_ZIP: zip, LS_DEST: dest } });
  if (ps.status !== 0) throw new Error(`Unable to extract ${zip}: ${(ps.stderr || ps.stdout || "").trim()}`);
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL client tooling (EDB binaries). Connections always use loopback TCP with a password.
// ---------------------------------------------------------------------------------------------
export function pgEnv(stack, user = "postgres") {
  const password = user === "authenticator" ? stack.postgres.authenticatorPassword : stack.postgres.superuserPassword;
  return { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8", PGAPPNAME: "trading-os-local-stack", PGCONNECT_TIMEOUT: "10", PGTZ: "UTC" };
}
export function connectionArgs(stack, { db = stack.postgres.database, user = "postgres" } = {}) {
  return ["-h", HOST, "-p", String(PORTS.postgres), "-U", user, "-d", db];
}
/** Runs psql and returns stdout; throws with psql's stderr on failure. */
export function psql(stack, args, { db, user = "postgres" } = {}) {
  const r = spawnSync(pgTool("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...connectionArgs(stack, { db, user }), ...args], {
    env: pgEnv(stack, user), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `psql exited with ${r.status}`).trim());
  return r.stdout;
}
/** Returns a single scalar value (tuples-only, unaligned). */
export function sqlValue(stack, sql, options = {}) {
  return psql(stack, ["-At", "-c", sql], options).trim();
}
export function pgCtl(args, logName = "pg_ctl.log") {
  // stdio goes to a file, never to a pipe: the postmaster inherits pg_ctl's handles on Windows and
  // an inherited pipe would keep this process waiting until PostgreSQL exits.
  const fd = fs.openSync(path.join(PATHS.logs, logName), "a");
  try {
    return spawnSync(pgTool("pg_ctl"), args, { stdio: ["ignore", fd, fd], windowsHide: true });
  } finally { fs.closeSync(fd); }
}
export function postgresRunning() {
  if (!fs.existsSync(pgTool("pg_ctl")) || !fs.existsSync(path.join(PATHS.pgData, "PG_VERSION"))) return false;
  return pgCtl(["status", "-D", PATHS.pgData], "pg_ctl-status.log").status === 0;
}

// ---------------------------------------------------------------------------------------------
// Background processes (PostgREST, gateway, Next dev server): detached, hidden, logged, pid files.
// ---------------------------------------------------------------------------------------------
export const pidFile = name => path.join(PATHS.pids, `${name}.pid`);
export const logFile = name => path.join(PATHS.logs, `${name}.log`);
export function readPid(name) {
  try { const pid = Number(fs.readFileSync(pidFile(name), "utf8").trim()); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; }
}
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
/** Image name of a live process (e.g. "node.exe"), used to avoid acting on a recycled PID. */
export function imageName(pid) {
  if (process.platform !== "win32") return null;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  const match = /^"([^"]+)","(\d+)"/m.exec(r.stdout || "");
  return match && Number(match[2]) === pid ? match[1].toLowerCase() : null;
}
export function managedPid(name, expectedImage) {
  const pid = readPid(name);
  if (!pid || !isAlive(pid)) return null;
  const image = imageName(pid);
  if (expectedImage && image && image !== expectedImage) return null; // PID reused by an unrelated process
  return pid;
}
export function killTree(pid) {
  if (process.platform === "win32") {
    return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  return { status: 0 };
}
export function spawnDetached(name, command, args, { cwd = REPO, env = process.env, shell = false } = {}) {
  ensureDirs();
  const fd = fs.openSync(logFile(name), "a");
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} starting ${name} =====\n`);
  try {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, shell });
    child.unref();
    if (!child.pid) throw new Error(`Failed to start ${name}`);
    fs.writeFileSync(pidFile(name), String(child.pid));
    return child.pid;
  } finally { fs.closeSync(fd); }
}
export async function stopManaged(name, expectedImage) {
  const pid = managedPid(name, expectedImage);
  if (pid) {
    killTree(pid);
    await waitFor(() => !isAlive(pid), 15000, 200).catch(() => {});
  }
  fs.rmSync(pidFile(name), { force: true });
  return pid;
}

// ---------------------------------------------------------------------------------------------
// Waiting and probing
// ---------------------------------------------------------------------------------------------
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(check, timeoutMs, intervalMs = 250, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
export function portOpen(port, host = HOST, timeoutMs = 750) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
export async function httpStatus(url, { timeoutMs = 3000, headers } = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await response.arrayBuffer().catch(() => {});
    return response.status;
  } catch { return 0; }
}
export function tail(file, lines = 40) {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n"); } catch { return ""; }
}

// ---------------------------------------------------------------------------------------------
// Isolated tools package (.local/tools): pg (gateway) and playwright-core (browser smoke).
// The repository package.json and lockfile are never touched.
// ---------------------------------------------------------------------------------------------
export const TOOL_DEPENDENCIES = Object.freeze({ pg: "8.23.1", "playwright-core": "1.64.0" });
export function npmCommand() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(cli) ? { command: process.execPath, prefix: [cli], shell: false } : { command: "npm", prefix: [], shell: true };
}
export function ensureTools() {
  fs.mkdirSync(PATHS.tools, { recursive: true });
  const manifest = path.join(PATHS.tools, "package.json");
  const wanted = { name: "trading-os-local-stack-tools", private: true, description: "Isolated local-only tooling for scripts/local-stack. Not part of the application.", dependencies: TOOL_DEPENDENCIES };
  let current = null;
  try { current = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { /* first run */ }
  const satisfied = current && JSON.stringify(current.dependencies) === JSON.stringify(TOOL_DEPENDENCIES)
    && Object.keys(TOOL_DEPENDENCIES).every(dep => fs.existsSync(path.join(PATHS.tools, "node_modules", dep, "package.json")));
  if (satisfied) return;
  fs.writeFileSync(manifest, `${JSON.stringify(wanted, null, 2)}\n`);
  log(`Installing isolated tools in ${path.relative(REPO, PATHS.tools)} (${Object.entries(TOOL_DEPENDENCIES).map(([k, v]) => `${k}@${v}`).join(", ")})`);
  const npm = npmCommand();
  const r = spawnSync(npm.command, [...npm.prefix, "install", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"], {
    cwd: PATHS.tools, stdio: "inherit", windowsHide: true, shell: npm.shell,
  });
  if (r.status !== 0) throw new Error("npm install in .local/tools failed");
}

// ---------------------------------------------------------------------------------------------
// Synthetic test images
// ---------------------------------------------------------------------------------------------
/** Minimal valid 8-bit RGB PNG (decodable by sharp), optionally painted per pixel. */
export function makePng(width, height, rgb = [32, 96, 160], paint) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  // Optional paint(x, y) -> [r, g, b] | null draws on top of the background colour.
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => {
    if (!paint) return row;
    const line = Buffer.from(row);
    for (let x = 0; x < width; x++) { const c = paint(x, y); if (c) line.set(c, 1 + x * 3); }
    return line;
  }));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
