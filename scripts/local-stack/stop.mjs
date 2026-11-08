#!/usr/bin/env node
// Stops everything the local stack started: the Next dev server (if started by browser-smoke.mjs),
// the gateway, PostgREST and PostgreSQL (pg_ctl stop -m fast). Safe to run repeatedly.
import { stopPostgres, stopServices } from "./control.mjs";
import { log, runMain } from "./lib.mjs";

await runMain(async () => {
  const stopped = await stopServices();
  log(stopped.length ? `Stopped: ${stopped.join(", ")}` : "No gateway/PostgREST/app process was running");
  log(stopPostgres() ? "PostgreSQL stopped" : "PostgreSQL was not running");
});
