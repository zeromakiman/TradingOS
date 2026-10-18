#!/usr/bin/env node
// Rebuilds the LOCAL stack's data from scratch: drops and recreates the "postgres" database,
// wipes .local/storage, re-applies the bootstrap and every migration, restarts PostgREST and the
// gateway, and (if .local/integration-users.json existed) re-provisions the synthetic users.
// Keys in .local/stack.json are kept, so .env.local stays valid.
// Usage: node scripts/local-stack/reset.mjs [--hard] [--through=0014]
//   --hard          delete and re-initialize the whole PostgreSQL cluster (roles included)
//   --through=NNNN  re-apply migrations only up to that version (see start.mjs)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clusterExists, startPostgres, startStack, stopPostgres, stopServices } from "./control.mjs";
import { HERE, PATHS, ensureStack, log, psql, readStack, requireWindows, runMain } from "./lib.mjs";

await runMain(async () => {
  requireWindows();
  const hard = process.argv.includes("--hard");
  const hadUsers = fs.existsSync(PATHS.users);
  const stopped = await stopServices();
  if (stopped.length) log(`Stopped: ${stopped.join(", ")}`);

  if (hard) {
    stopPostgres();
    log("Deleting the PostgreSQL cluster (.local/pgdata)");
    fs.rmSync(PATHS.pgData, { recursive: true, force: true });
    ensureStack();
  } else if (clusterExists() && readStack()) {
    const stack = readStack();
    await startPostgres(stack);
    log(`Dropping and recreating database ${stack.postgres.database}`);
    psql(stack, ["-c", `drop database if exists ${stack.postgres.database} with (force)`], { db: "template1" });
    psql(stack, ["-c", `create database ${stack.postgres.database}`], { db: "template1" });
  }

  log("Wiping .local/storage and the local auth mailbox");
  fs.rmSync(PATHS.storage, { recursive: true, force: true });
  fs.mkdirSync(PATHS.storage, { recursive: true });
  fs.rmSync(PATHS.mail, { force: true });
  fs.rmSync(PATHS.users, { force: true });

  await startStack({ restart: true, through: process.argv.find(a => a.startsWith("--through="))?.slice("--through=".length) });
  if (hadUsers) {
    log("Re-provisioning synthetic users");
    const r = spawnSync(process.execPath, [path.join(HERE, "provision-users.mjs")], { stdio: "inherit", windowsHide: true });
    if (r.status !== 0) throw new Error("provision-users.mjs failed");
  } else {
    log("Next: node scripts/local-stack/provision-users.mjs");
  }
  log("Reset complete. Signed-in browser sessions from before the reset are invalid; sign in again.");
});
