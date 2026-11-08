#!/usr/bin/env node
// Starts (idempotently) the LOCAL Supabase-compatible stack:
//   downloads binaries if missing -> initdb if missing -> PostgreSQL -> bootstrap + pending
//   migrations -> PostgREST -> gateway. Re-running only applies new migrations and restarts
//   PostgREST when the schema changed.
// Usage: node scripts/local-stack/start.mjs [--restart] [--through=0014]
//   --restart       also restarts PostgREST and the gateway (e.g. after editing gateway code)
//   --through=NNNN  apply migrations only up to that version (create older-schema fixtures, then
//                   run start.mjs again without it to apply the newer migrations on top)
import path from "node:path";
import { startStack } from "./control.mjs";
import { APP_URL, GATEWAY_URL, HOST, PATHS, PORTS, REPO, log, requireWindows, runMain } from "./lib.mjs";

await runMain(async () => {
  requireWindows();
  const through = process.argv.find(a => a.startsWith("--through="))?.slice("--through=".length);
  const { postgrestVersion } = await startStack({ restart: process.argv.includes("--restart"), through });
  const rel = p => path.relative(REPO, p);
  log("Local stack is running (synthetic data only; nothing here talks to a hosted project):");
  log(`  Supabase URL (gateway):  ${GATEWAY_URL}`);
  log(`  PostgreSQL 17:           ${HOST}:${PORTS.postgres} (user postgres; password in ${rel(PATHS.stack)})`);
  log(`  PostgREST ${postgrestVersion}:      http://${HOST}:${PORTS.postgrest} (admin :${PORTS.postgrestAdmin})`);
  log(`  Logs / pids:             ${rel(PATHS.logs)} / ${rel(PATHS.pids)}`);
  log("Next steps:");
  log("  node scripts/local-stack/provision-users.mjs   # synthetic users -> .local/integration-users.json");
  log("  node scripts/local-stack/env.mjs               # writes .env.local for the app");
  log(`  npx pnpm@11.19.0 dev                            # app on ${APP_URL}`);
});
