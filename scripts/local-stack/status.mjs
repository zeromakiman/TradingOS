#!/usr/bin/env node
// Reports the state of every local-stack component. Usage: node scripts/local-stack/status.mjs [--json]
import fs from "node:fs";
import { APP_IMAGE, appliedMigrations, clusterExists, migrationFiles } from "./control.mjs";
import {
  APP_URL, GATEWAY_URL, HOST, PATHS, PORTS, httpStatus, managedPid, pgTool, portOpen, postgresRunning, readStack, sqlValue,
} from "./lib.mjs";

const stack = readStack();
const report = { stackConfig: Boolean(stack), components: {}, migrations: null, users: null, envLocal: null, anonExposedTables: null };

const pgUp = postgresRunning();
report.components.postgres = { installed: fs.existsSync(pgTool("postgres")), cluster: clusterExists(), running: pgUp, port: PORTS.postgres, portOpen: await portOpen(PORTS.postgres) };
const postgrestPid = managedPid("postgrest", "postgrest.exe");
report.components.postgrest = { pid: postgrestPid, ready: (await httpStatus(`http://${HOST}:${PORTS.postgrestAdmin}/ready`)) === 200, port: PORTS.postgrest, portOpen: await portOpen(PORTS.postgrest) };
const gatewayPid = managedPid("gateway", "node.exe");
report.components.gateway = { pid: gatewayPid, healthy: (await httpStatus(`${GATEWAY_URL}/health`)) === 200, url: GATEWAY_URL, portOpen: await portOpen(PORTS.gateway) };
report.components.app = { pid: managedPid("app", APP_IMAGE), url: APP_URL, portOpen: await portOpen(PORTS.app) };

if (pgUp && stack) {
  try {
    const applied = appliedMigrations(stack), files = migrationFiles();
    report.migrations = { applied: applied.size, files: files.length, pending: files.filter(f => !applied.has(f.version)).map(f => f.file) };
    // Mirrors Supabase defaults; repository migrations must revoke anon access table by table.
    const exposed = sqlValue(stack, `select coalesce(string_agg(distinct table_name, ', ' order by table_name), '')
      from information_schema.role_table_grants where grantee in ('anon', 'PUBLIC') and table_schema = 'public'`);
    report.anonExposedTables = exposed ? exposed.split(", ") : [];
  } catch (error) { report.migrations = { error: error.message.split("\n")[0] }; }
}
try {
  const users = JSON.parse(fs.readFileSync(PATHS.users, "utf8"));
  report.users = { project: users.project, emails: users.users.map(u => u.email) };
} catch { report.users = null; }
try {
  const env = fs.readFileSync(PATHS.envLocal, "utf8");
  const value = name => new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? null;
  report.envLocal = {
    pointsToGateway: value("NEXT_PUBLIC_SUPABASE_URL") === GATEWAY_URL,
    keysMatchStack: Boolean(stack) && value("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") === stack.publishableKey && value("SUPABASE_SECRET_KEY") === stack.secretKey,
    aiEnabled: value("AI_ENABLED"),
  };
} catch { report.envLocal = null; }

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const c = report.components, mark = ok => (ok ? "UP  " : "DOWN");
  console.log(`PostgreSQL   ${mark(c.postgres.running)} ${HOST}:${c.postgres.port}${c.postgres.installed ? "" : " (binaries not installed)"}${c.postgres.cluster ? "" : " (no cluster)"}${!c.postgres.running && c.postgres.portOpen ? " (port used by another process)" : ""}`);
  console.log(`PostgREST    ${mark(c.postgrest.ready)} http://${HOST}:${c.postgrest.port}${c.postgrest.pid ? ` pid ${c.postgrest.pid}` : ""}${!c.postgrest.pid && c.postgrest.portOpen ? " (port used by an unmanaged process)" : ""}`);
  console.log(`Gateway      ${mark(c.gateway.healthy)} ${c.gateway.url}${c.gateway.pid ? ` pid ${c.gateway.pid}` : ""}${!c.gateway.pid && c.gateway.portOpen ? " (port used by an unmanaged process)" : ""}`);
  console.log(`App (Next)   ${mark(c.app.portOpen)} ${c.app.url}${c.app.pid ? ` pid ${c.app.pid} (started by browser-smoke)` : c.app.portOpen ? " (not managed by local-stack)" : ""}`);
  if (report.migrations?.error) console.log(`Migrations   ? ${report.migrations.error}`);
  else if (report.migrations) console.log(`Migrations   ${report.migrations.applied}/${report.migrations.files} applied${report.migrations.pending.length ? `; pending: ${report.migrations.pending.join(", ")}` : ""}`);
  if (report.anonExposedTables) console.log(`Anon grants  ${report.anonExposedTables.length ? `WARNING anon/PUBLIC can access: ${report.anonExposedTables.join(", ")}` : "no public table is granted to anon"}`);
  console.log(`Users file   ${report.users ? `${report.users.emails.join(", ")} (${report.users.project})` : "missing (run provision-users.mjs)"}`);
  console.log(`.env.local   ${report.envLocal ? `${report.envLocal.pointsToGateway ? "points to the local gateway" : "NOT pointing to the local gateway"}; keys ${report.envLocal.keysMatchStack ? "match" : "do NOT match"} stack.json; AI_ENABLED=${report.envLocal.aiEnabled}` : "missing (run env.mjs)"}`);
  const anyUp = c.postgres.running || c.postgrest.ready || c.gateway.healthy || c.app.portOpen;
  console.log(anyUp ? "Stack status: running (fully or partially)" : "Stack status: stopped");
}
