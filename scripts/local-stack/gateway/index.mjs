// Local Supabase-compatible HTTP gateway (loopback only, synthetic data only).
//   /rest/v1/*    -> PostgREST (apikey -> role JWT translation like the Supabase API gateway)
//   /auth/v1/*    -> GoTrue emulation (auth.mjs)
//   /storage/v1/* -> Storage emulation (storage.mjs)
// Started in the background by scripts/local-stack/start.mjs; logs to .local/logs/gateway.log.
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { APP_URL, GATEWAY_URL, HOST, PATHS, PORTS, readStack, safeEqual } from "../lib.mjs";
import { createAuth } from "./auth.mjs";
import { HttpError, header, sendJson } from "./http.mjs";
import { looksLikeJwt, nowSeconds, signJwt, verifyJwt } from "./jwt.mjs";
import { createRestProxy } from "./rest.mjs";
import { createStorage } from "./storage.mjs";

const stack = readStack();
if (!stack) { console.error("Missing .local/stack.json. Run: node scripts/local-stack/start.mjs"); process.exit(1); }
const logger = message => console.log(`${new Date().toISOString()} ${message}`);

// pg is installed in the isolated .local/tools package (never in the repository's package.json).
const { Pool } = createRequire(path.join(PATHS.tools, "package.json"))("pg");
const pool = new Pool({
  host: HOST, port: PORTS.postgres, database: stack.postgres.database, user: stack.postgres.superuser,
  password: stack.postgres.superuserPassword, max: 10, idleTimeoutMillis: 30_000, application_name: "local-stack-gateway",
});
pool.on("error", error => logger(`[db] idle client error: ${error.message}`));
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* connection already broken */ }
    throw error;
  } finally { client.release(); }
}

// Long-lived role tokens, the equivalent of Supabase's legacy anon/service_role JWT keys.
const issuedAt = nowSeconds(), tenYears = 10 * 365 * 24 * 3600;
const anonJwt = signJwt({ iss: "supabase-local", role: "anon", iat: issuedAt, exp: issuedAt + tenYears }, stack.jwtSecret);
const serviceJwt = signJwt({ iss: "supabase-local", role: "service_role", iat: issuedAt, exp: issuedAt + tenYears }, stack.jwtSecret);

/**
 * Key translation as in the Supabase CLI's Kong configuration:
 *  - An Authorization header that is not "Bearer sb_..." (i.e. a user/role JWT) passes through.
 *  - Otherwise the apikey decides: publishable -> anon JWT, secret -> service_role JWT.
 * keyRole is null when the apikey is missing or unknown (REST/auth then answer 401).
 */
function credentials(req, url) {
  const apikey = header(req, "apikey") ?? url.searchParams.get("apikey");
  let keyRole = null;
  if (apikey && safeEqual(apikey, stack.publishableKey)) keyRole = "anon";
  else if (apikey && safeEqual(apikey, stack.secretKey)) keyRole = "service_role";
  else if (apikey && looksLikeJwt(apikey)) {
    try { const claims = verifyJwt(apikey, stack.jwtSecret); if (claims.role === "anon" || claims.role === "service_role") keyRole = claims.role; } catch { /* invalid legacy key */ }
  }
  const authorization = header(req, "authorization");
  let bearer = null;
  if (authorization && !/^bearer\s+sb_/i.test(authorization)) bearer = authorization.replace(/^bearer\s+/i, "").trim();
  else if (keyRole) bearer = keyRole === "anon" ? anonJwt : serviceJwt;
  return { apikey, keyRole, bearer };
}

const proxyRest = createRestProxy({ host: HOST, port: PORTS.postgrest });
const handleAuth = createAuth({ pool, tx, stack, gatewayUrl: GATEWAY_URL, siteUrl: stack.siteUrl ?? APP_URL, mailFile: PATHS.mail, logger });
const handleStorage = createStorage({ pool, tx, stack, storageRoot: PATHS.storage, logger });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-upsert, x-metadata, cache-control, x-supabase-api-version",
  "Access-Control-Expose-Headers": "Content-Range, Content-Location, Location, Preference-Applied, X-Total-Count, Link, X-Supabase-Api-Version",
  "Access-Control-Max-Age": "3600",
};

async function health(res) {
  let postgres = false, postgrest = false;
  try { await pool.query("select 1"); postgres = true; } catch { /* down */ }
  try { postgrest = (await fetch(`http://${HOST}:${PORTS.postgrestAdmin}/ready`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* down */ }
  sendJson(res, postgres && postgrest ? 200 : 503, { status: postgres && postgrest ? "ok" : "degraded", postgres, postgrest, gateway: true });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  // Client aborts surface as stream errors; without listeners they would crash the process.
  req.on("error", () => {});
  res.on("error", () => {});
  let url;
  try { url = new URL(req.url ?? "/", GATEWAY_URL); } catch { return sendJson(res, 400, { message: "Bad request" }); }
  // Never log query strings: they can carry recovery or signed-URL tokens.
  res.on("finish", () => logger(`${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - started}ms`));
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  try {
    if (req.method === "OPTIONS") { res.writeHead(200, { "Content-Length": 0 }); return res.end(); }
    const p = url.pathname;
    if (p === "/" || p === "/health") return await health(res);
    const creds = credentials(req, url);
    if (p === "/rest/v1" || p.startsWith("/rest/v1/")) {
      if (!creds.apikey) throw new HttpError(401, { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });
      if (!creds.keyRole) throw new HttpError(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
      return proxyRest(req, res, url, creds);
    }
    if (p.startsWith("/auth/v1/")) return await handleAuth(req, res, url, creds);
    if (p.startsWith("/storage/v1/")) return await handleStorage(req, res, url, creds);
    if (/^\/(functions|realtime|graphql|pg)\/v1\b/.test(p)) throw new HttpError(501, { message: "This Supabase service is not emulated by the local stack" });
    throw new HttpError(404, { message: "no Route matched with those values" });
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) return sendJson(res, error.status, error.body, error.headers);
    logger(`[error] ${req.method} ${url.pathname}: ${error?.stack ?? error}`);
    sendJson(res, 500, { message: "Internal gateway error", code: "unexpected_failure" });
  }
});
server.keepAliveTimeout = 65_000;
// A development gateway should keep serving after an unexpected error; it is logged instead.
process.on("uncaughtException", error => logger(`[fatal] uncaught exception: ${error?.stack ?? error}`));
process.on("unhandledRejection", error => logger(`[fatal] unhandled rejection: ${error?.stack ?? error}`));
server.listen(PORTS.gateway, HOST, () => logger(`Local Supabase gateway listening on ${GATEWAY_URL} (PostgREST ${HOST}:${PORTS.postgrest}, Postgres ${HOST}:${PORTS.postgres})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); pool.end().finally(() => process.exit(0)); });
